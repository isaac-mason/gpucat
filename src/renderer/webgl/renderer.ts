/**
 * renderer.ts (webgl) - the WebGL2 concrete integrator.
 *
 * Mirrors `WebGPURenderer`'s structure: it owns its device state (the WebGL2 context, the color
 * format, the stored drawing-buffer size) directly as fields, structurally satisfies the neutral
 * `RendererState` (identical field names) so it can call the shared `../core/renderer-ops` utilities,
 * and its methods sequence those neutral utils together with the concrete `webgl/*` free functions
 * (context, render-pass, prepare).
 *
 * WebGL2 is immediate mode: there is no command encoder and no swapchain object — `render()` binds the
 * default framebuffer, sets viewport/scissor, clears, and (in a later step) draws, all directly on the
 * context. Compute is unsupported.
 */

import type { Vec4 } from 'mathcat';
import type { Camera } from '../../camera/camera';
import { CoordinateSystem } from '../../core/coordinate-system';
import type { Object3D } from '../../core/object3d';
import type { CubeRenderTarget } from '../../core/cube-render-target';
import type { RenderTarget } from '../../core/render-target';
import type { InspectorBase } from '../../inspector/inspector-base';
import type { Material } from '../../material/material';
import type { MRTNode } from '../../nodes/nodes';
import { CanvasTarget } from '../core/canvas-target';
import * as NodeManager from '../core/node-manager';
import * as RenderContext from '../core/pass-context';
import type { RenderObject } from '../core/render-object';
import type { RenderPassParams } from '../core/render-types';
import * as RenderLists from '../core/render-list';
import * as RenderObjects from '../core/render-objects';
import type { Renderer } from '../core/renderer-interface';
import * as ops from '../core/renderer-ops';
import type { DeviceLostInfo, RendererState } from '../core/renderer-ops';
import { createContext } from './context';
import * as Geometries from './geometries';
import * as Prepare from './prepare';
import * as Programs from './programs';
import * as Probe from './probe';
import { createRenderObjectGlCache, type RenderObjectGlCache } from './render-object-gl';
import * as RenderPass from './render-pass';
import * as RenderTargets from './render-target';
import * as Samplers from './samplers';
import * as Textures from './textures';
import * as TransformFeedback from './transform-feedback';
import * as Uniforms from './uniforms';
import type { GpuBuffer } from '../../core/gpu-buffer';
import type { TransformFeedbackNode } from '../../nodes/lib/transform-feedback';

/**
 * Neutral construction options for the WebGL2 renderer — the backend-agnostic subset only (no
 * WebGPU device/adapter/format inputs). Mirrors the shared options `WebGPURendererOptions` also
 * exposes.
 */
export type WebGLRendererOptions = {
    /** Canvas element to render into. If not provided, one will be created. */
    canvas?: HTMLCanvasElement;

    /** Device pixel ratio. Applied to the canvas target before the first setSize. */
    pixelRatio?: number;

    /** Enable MSAA antialiasing (maps to the WebGL2 `antialias` context attribute). */
    antialias?: boolean;

    /** Explicit MSAA sample count. 0 or 1 = no MSAA. Takes precedence over `antialias`. */
    samples?: number;

    /** When true, the drawing buffer has an alpha channel (premultiplied compositing). Default false. */
    alpha?: boolean;

    /** Allocate a depth buffer for the default framebuffer. Default true. */
    depth?: boolean;

    /** Allocate a stencil buffer for the default framebuffer. Default false. */
    stencil?: boolean;

    /** GPU power-preference hint forwarded to `getContext('webgl2', …)`. Default: 'default'. */
    powerPreference?: 'default' | 'low-power' | 'high-performance';

    /** Preserve the drawing buffer between frames (allows readback after present). Default: false. */
    preserveDrawingBuffer?: boolean;

    /** Fail context creation if a major performance caveat applies (e.g. software fallback). Default: false. */
    failIfMajorPerformanceCaveat?: boolean;

    /**
     * GLSL shader precision qualifier emitted for the fragment stage (`precision <p> float/int;`).
     * WGSL has no precision qualifier, so this is a GLSL-only (WebGL-backend-only) concern. Default: 'highp'.
     */
    precision?: 'highp' | 'mediump' | 'lowp';
};

/**
 * WebGL2 renderer — the concrete integrator. Owns the WebGL2 context + color format directly as
 * fields, satisfies the neutral `RendererState`, and sequences the shared `core` render-loop utils
 * with the concrete `webgl/*` free functions.
 */
export class WebGLRenderer implements Renderer, RendererState {
    /** Which graphics backend this renderer drives. Runtime discriminant for feature-detection. */
    readonly backend = 'webgl' as const;

    /** @internal */
    _initialized = false;

    /** @internal */
    _isDeviceLost = false;

    /** @internal */
    _inspector: InspectorBase | null = null;

    get inspector(): InspectorBase | null {
        return this._inspector;
    }
    set inspector(next: InspectorBase | null) {
        this.setInspector(next);
    }

    /** Install or remove the inspector. Equivalent to assigning `renderer.inspector`. */
    setInspector(next: InspectorBase | null): void {
        if (this._inspector === next) return;
        this._inspector?.setRenderer(null);
        this._inspector = next;
        next?.setRenderer(this);
    }

    /** The canvas dom element for the current canvas target. */
    get domElement(): HTMLCanvasElement {
        if (!this._canvasTarget) {
            throw new Error('[WebGLRenderer] no canvas target.');
        }
        return this._canvasTarget.domElement;
    }

    // -----------------------------------------------------------------------
    // WebGL2 device state — owned directly as fields. Assigned in init().
    // WebGL2 is immediate mode: no command encoder, no swapchain object.
    // -----------------------------------------------------------------------

    /** The WebGL2 rendering context in use. Assigned in `init()`. @internal */
    gl: WebGL2RenderingContext | null = null;

    /** Bound `webglcontextlost` listener, registered in init() and removed in dispose(). @internal */
    private _onContextLost: ((e: Event) => void) | null = null;
    /** Bound `webglcontextrestored` listener, registered in init() and removed in dispose(). @internal */
    private _onContextRestored: ((e: Event) => void) | null = null;

    // -----------------------------------------------------------------------
    // Device resource caches — created once in the constructor, immutable
    // references thereafter. GL handles inside are created lazily on first use
    // (they need the context, which init() acquires).
    // -----------------------------------------------------------------------

    /** GLSL program cache (compile/link, keyed by source). @internal */
    private readonly _programs: Programs.ProgramCache;
    /** Per-geometry GL buffers + VAOs. @internal */
    private readonly _geometries: Geometries.GeometriesState;
    /** Per-uniform-group std140 UBO cache. @internal */
    private readonly _uniforms: Uniforms.UniformsState;
    /** Per-RenderObject GL device payload (linked program). @internal */
    private readonly _renderObjectGl: RenderObjectGlCache;
    /** Per-GpuTexture GL texture cache (upload + allocation). @internal */
    private readonly _textures: Textures.GlTexturesState;
    /** Per-GpuSampler GL sampler-object cache. @internal */
    private readonly _samplers: Samplers.GlSamplersState;
    /** Per-RenderTarget GL framebuffer (FBO) cache. @internal */
    private readonly _renderTargets: RenderTargets.GlRenderTargetsState;

    /** Transform-feedback runtime state (per-node program/VAO + I/O buffer cache). @internal */
    private readonly _transformFeedback: TransformFeedback.TransformFeedbackState;

    /** Inspector shader-probe state (one active patched program + 1×1 readback FBO). @internal */
    private readonly _probe: Probe.ProbeState = Probe.createProbeState();

    /** The primary color/attachment format. Fixed at 'rgba8unorm' for the default framebuffer. @internal */
    readonly format: string = 'rgba8unorm';

    /** Last known drawing-buffer size in physical pixels. @internal */
    private _width = 1;
    /** @internal */
    private _height = 1;

    /** Construction options, captured for init(). @internal */
    private readonly _opts: WebGLRendererOptions;

    /** Cached `gl.MAX_TEXTURE_SIZE`, read once at init. Threaded into the storage() lowering's grid-width
     *  pick (bigger buffers tile into a device-sized grid). @internal */
    private _maxTextureSize: number | undefined;

    /** MSAA sample count (0 or 1 = no MSAA). */
    samples: number;

    /** Whether the default framebuffer carries a stencil aspect. */
    readonly stencil: boolean;

    onDeviceLost: ((info: DeviceLostInfo) => void) | null = null;

    /** @internal */
    _renderContexts: RenderContext.RenderContextsState;

    /** @internal — unused by WebGL (no compute), kept to satisfy RendererState. */
    _computeContext: RenderContext.ComputeContext;

    /** @internal */
    _nodes: NodeManager.NodeManagerState;

    /** @internal */
    _renderObjects: RenderObjects.RenderObjectsState;

    /** @internal */
    _renderLists: RenderLists.RenderListsState;

    /** @internal */
    _renderCallDepth = 0;

    /** clear color for the final composite pass. defaults to opaque black. */
    clearColor: [number, number, number, number] = [0, 0, 0, 1];

    /** when false, render() preserves the framebuffer's existing contents instead of clearing. */
    autoClear = true;

    /** When true (and autoClear is true), the stencil buffer is cleared each render. */
    autoClearStencil = true;

    /** Value the stencil buffer is cleared to (0-255). Default 0. */
    clearStencilValue = 0;

    /** @internal */
    _viewport: Vec4 | null = null;
    /** @internal */
    _scissor: Vec4 | null = null;
    /** @internal */
    _scissorTest = false;
    /** @internal */
    _viewportMinDepth = 0;
    /** @internal */
    _viewportMaxDepth = 1;

    /** current MRT configuration. */
    mrt: MRTNode | null = null;

    /** current render target; null renders to the default framebuffer. */
    renderTarget: RenderTarget | null = null;

    /** when set, all meshes render with this material instead of their own. */
    overrideMaterial: Material | null = null;

    /** @internal current canvas target. */
    _canvasTarget: CanvasTarget | null = null;

    setCanvasTarget(canvasTarget: CanvasTarget | null): this {
        this._canvasTarget = canvasTarget;
        return this;
    }

    getCanvasTarget(): CanvasTarget | null {
        return this._canvasTarget;
    }

    constructor(opts: WebGLRendererOptions = {}) {
        this._opts = opts;

        let samples = 0;
        if (opts.samples !== undefined) {
            samples = opts.samples <= 1 ? 0 : opts.samples;
        } else if (opts.antialias) {
            samples = 4;
        }
        this.samples = samples;
        this.stencil = opts.stencil ?? false;

        const canvas = opts.canvas ?? document.createElement('canvas');
        if (!opts.canvas) {
            canvas.style.display = 'block';
        }
        this._canvasTarget = new CanvasTarget(canvas, { alphaMode: opts.alpha ? 'premultiplied' : 'opaque' });
        this._canvasTarget.isDefaultCanvasTarget = true;
        if (opts.pixelRatio !== undefined) this._canvasTarget.setPixelRatio(opts.pixelRatio);

        this._renderContexts = RenderContext.createRenderContextsState();
        this._computeContext = RenderContext.createComputeContext();
        this._nodes = NodeManager.createNodeManagerState();
        this._renderLists = RenderLists.createRenderListsState();
        this._renderObjects = RenderObjects.createRenderObjectsState();

        // Device resource caches — GL handles inside are created lazily once init() has the context.
        this._programs = Programs.createProgramCache();
        this._geometries = Geometries.createGeometriesState();
        this._uniforms = Uniforms.createUniformsState();
        this._renderObjectGl = createRenderObjectGlCache();
        this._textures = Textures.createGlTexturesState();
        this._samplers = Samplers.createGlSamplersState();
        this._renderTargets = RenderTargets.createGlRenderTargetsState();
        this._transformFeedback = TransformFeedback.createTransformFeedbackState();
    }

    /**
     * Acquire the WebGL2 context and set the initial viewport. Must be called (and awaited) before the
     * first render(). Async to match the `WebGPURenderer` init contract.
     */
    // eslint-disable-next-line @typescript-eslint/require-await
    async init(): Promise<this> {
        if (this._initialized) return this;

        const { width, height } = this._canvasTarget!.getDrawingBufferSize();
        this._width = width || 1;
        this._height = height || 1;

        this.gl = createContext(this.domElement, {
            alpha: this._opts.alpha ?? false,
            depth: this._opts.depth ?? true,
            stencil: this.stencil,
            antialias: this.samples > 1,
            powerPreference: this._opts.powerPreference ?? 'default',
            preserveDrawingBuffer: this._opts.preserveDrawingBuffer ?? false,
            failIfMajorPerformanceCaveat: this._opts.failIfMajorPerformanceCaveat ?? false,
        });
        this.gl.viewport(0, 0, this._width, this._height);

        // Read MAX_TEXTURE_SIZE once. It caps the storage() read-lowering's texel-grid width so large
        // read-only storage buffers tile into a grid this device can allocate (guaranteed ≥ 2048).
        const maxTex = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
        this._maxTextureSize = typeof maxTex === 'number' && maxTex > 0 ? maxTex : undefined;

        // WebGL's parallel to WebGPU's `device.lost`: the canvas fires `webglcontextlost` when the
        // driver drops the context (GPU reset, tab backgrounding, `WEBGL_lose_context`). Preventing
        // the event's default keeps the context restorable. We flip `_isDeviceLost` (render() early-
        // returns while lost) and fire the same neutral `onDeviceLost` callback the WebGPU path uses.
        const canvas = this.domElement;
        this._onContextLost = (e: Event): void => {
            e.preventDefault();
            this._isDeviceLost = true;
            this.onDeviceLost?.({
                api: 'WebGL2',
                message: 'WebGL2 context lost',
                reason: null,
                originalEvent: e,
            });
        };
        this._onContextRestored = (): void => {
            // The GL context is back, but all GL objects (programs/buffers/textures/FBOs) were
            // invalidated on loss. Full resource re-creation from the neutral caches is a TODO; for now
            // we clear the lost flag and log so a restore is observable rather than silently broken.
            // TODO: rebuild GL device resources here so rendering resumes after a context restore.
            this._isDeviceLost = false;
            console.warn(
                '[WebGLRenderer] WebGL2 context restored; GL resources were invalidated and are not yet ' +
                    'automatically re-created. Recreate the renderer to resume rendering.',
            );
        };
        canvas.addEventListener('webglcontextlost', this._onContextLost, false);
        canvas.addEventListener('webglcontextrestored', this._onContextRestored, false);

        this._initialized = true;
        return this;
    }

    /** set the device pixel ratio. call before setSize(). */
    setPixelRatio(value: number): void {
        ops.setPixelRatio(this, value);
    }

    /** resize the canvas to logical pixel dimensions (physical = logical * pixelRatio). */
    setSize(width: number, height: number, updateStyle = true): void {
        if (!this._canvasTarget) {
            throw new Error('[WebGLRenderer] no canvas target.');
        }
        this._canvasTarget.setSize(width, height, updateStyle);

        if (!this._initialized) return;

        const { width: pw, height: ph } = this._canvasTarget.getDrawingBufferSize();
        this._width = pw || 1;
        this._height = ph || 1;
        if (this.gl) this.gl.viewport(0, 0, this._width, this._height);
    }

    setViewport(rect: Vec4): void;
    setViewport(x: number, y: number, width: number, height: number, minDepth?: number, maxDepth?: number): void;
    setViewport(x: number | Vec4, y = 0, width = 0, height = 0, minDepth = 0, maxDepth = 1): void {
        ops.setViewport(this, x, y, width, height, minDepth, maxDepth);
    }

    getViewport(): Vec4 {
        return ops.getViewport(this);
    }

    setScissor(rect: Vec4): void;
    setScissor(x: number, y: number, width: number, height: number): void;
    setScissor(x: number | Vec4, y = 0, width = 0, height = 0): void {
        ops.setScissor(this, x, y, width, height);
    }

    getScissor(): Vec4 {
        return ops.getScissor(this);
    }

    setScissorTest(enable: boolean): void {
        ops.setScissorTest(this, enable);
    }

    getScissorTest(): boolean {
        return this._scissorTest;
    }

    /**
     * Manually clear the current framebuffer (color and/or depth and/or stencil) to clearColor,
     * ignoring autoClear and viewport/scissor.
     */
    clear(color = true, depth = true, stencil = false): void {
        if (this._isDeviceLost || !this._initialized || !this.gl) return;
        if (!this.renderTarget) {
            if (!this._canvasTarget) return;
            if (this.domElement.width === 0 || this.domElement.height === 0) return;
        }
        const [cr, cg, cb, ca] = this.clearColor;
        RenderPass.clear(
            this.gl,
            {
                geometries: this._geometries,
                uniforms: this._uniforms,
                renderObjectGl: this._renderObjectGl,
                textures: this._textures,
                samplers: this._samplers,
                renderTargets: this._renderTargets,
            },
            {
                renderTarget: this.renderTarget,
                clearColor: { r: cr, g: cg, b: cb, a: ca },
                autoClear: true,
                autoClearStencil: this.autoClearStencil,
                clearStencilValue: this.clearStencilValue,
                swapchainStencil: this.stencil,
                passId: 'clear',
            },
            color,
            depth,
            stencil,
        );
    }

    /**
     * Finalize a cube render target after all six faces are captured: generate the cube texture's
     * mipmaps so a mipped environment map has its lower levels filled. Mirrors the WebGPU renderer's
     * `finalizeCubeCapture` guards — only when the texture wants mips and the base mip level (0) is
     * active. Called by `CubeCamera.update()`.
     */
    finalizeCubeCapture(renderTarget: RenderTarget, mipLevel: number): void {
        if (this._isDeviceLost || !this._initialized || !this.gl) return;
        if (!renderTarget.isCubeRenderTarget) return;
        if (mipLevel !== 0) return;
        const cube = renderTarget as CubeRenderTarget;
        if (!cube.texture.generateMipmaps) return;
        Textures.generateCubeMipmaps(this.gl, this._textures, cube.texture._gpuTexture);
    }

    /** Minimal feature query. No optional WebGL2 features are surfaced yet. */
    hasFeature(_feature: string): boolean {
        return false;
    }

    /**
     * Snapshot of GL device-resource counts for the Inspector's Memory tab. Reads the private GL
     * caches directly (they're not exposed as public fields). Geometry VAOs and per-RenderObject GL
     * payloads live in WeakMaps (not enumerable) so aren't counted; render-object count comes from the
     * neutral `_renderObjects` set (see the Memory tab). Bytes aren't tracked per resource yet, so this
     * is counts-only for now. @internal
     */
    getMemoryStats(): {
        programCount: number;
        uboCount: number;
        textureCount: number;
        samplerCount: number;
        fboCount: number;
        renderbufferCount: number;
    } {
        return {
            ...Programs.getProgramCacheStats(this._programs),
            ...Uniforms.getUniformsStats(this._uniforms),
            ...Textures.getGlTexturesStats(this._textures),
            ...Samplers.getGlSamplersStats(this._samplers),
            ...RenderTargets.getGlRenderTargetsStats(this._renderTargets),
        };
    }

    saveRendererState(): {
        renderTarget: RenderTarget | null;
        mrt: MRTNode | null;
        clearColor: [number, number, number, number];
        overrideMaterial: Material | null;
    } {
        return {
            renderTarget: this.renderTarget,
            mrt: this.mrt,
            clearColor: [...this.clearColor] as [number, number, number, number],
            overrideMaterial: this.overrideMaterial,
        };
    }

    restoreRendererState(state: ReturnType<WebGLRenderer['saveRendererState']>): void {
        this.renderTarget = state.renderTarget;
        this.mrt = state.mrt;
        this.clearColor = state.clearColor;
        this.overrideMaterial = state.overrideMaterial;
    }

    /**
     * Render a scene from a camera's perspective. Mirrors `WebGPURenderer.render()`'s neutral sequence,
     * minus the encoder/submit/error-scope steps (WebGL2 is immediate mode).
     */
    render(scene: Object3D, camera: Camera, passId = 'render'): void {
        if (this._isDeviceLost) return;

        if (!this._initialized || !this.gl) {
            throw new Error('[WebGLRenderer] render() called before init(). Await renderer.init() first.');
        }

        if (!this.renderTarget) {
            if (!this._canvasTarget) {
                throw new Error('[WebGLRenderer] render() requires renderer.renderTarget or a canvas.');
            }
            if (this.domElement.width === 0 || this.domElement.height === 0) return;
        }

        // Stamp this renderer's clip-space convention onto the camera; rebuild the projection if it changed.
        // WebGL uses NDC z in [-1,1], so a camera previously used with WebGPU (z in [0,1]) is rebuilt here.
        if (camera.coordinateSystem !== CoordinateSystem.WEBGL) {
            camera.coordinateSystem = CoordinateSystem.WEBGL;
            camera.updateProjectionMatrix();
        }

        const frame = this._nodes.nodeFrame;
        const inspector = this.inspector;
        // Top-level entry: advance the frame id and open the inspector frame.
        if (this._renderCallDepth === 0) {
            frame.frameId++;
            if (inspector) inspector.begin(frame.frameId);
        }
        this._renderCallDepth++;
        // Each render() gets a fresh, globally-unique renderId. Nested renders restore the parent's.
        const previousRenderId = frame.beginRender();
        if (inspector) inspector.perf.start('render');

        const renderTarget = this.renderTarget;
        const mrt = this.mrt;

        if (mrt && renderTarget) {
            mrt.resolveOutputs((name: string) => renderTarget.getTextureIndex(name));
        }

        const samples = renderTarget?.samples ?? this.samples;
        const primaryColorFormat = renderTarget?.textures[0]?.format ?? this.format;
        const width = renderTarget ? renderTarget.width : this.domElement.width || 1;
        const height = renderTarget ? renderTarget.height : this.domElement.height || 1;
        const [cr, cg, cb, ca] = this.clearColor;

        if (inspector) {
            inspector.beginRenderScene(passId, scene, samples, primaryColorFormat, frame.frameId);
            inspector.beginRender(passId, frame.frameId);
        }

        frame.renderer = this;
        frame.camera = camera;
        frame.scene = scene;
        frame.width = width;
        frame.height = height;

        const passCtx = RenderContext.getRenderContext(this._renderContexts, renderTarget, mrt, 0);
        passCtx.sampleCount = samples;
        passCtx.width = width;
        passCtx.height = height;
        passCtx.camera = camera;
        passCtx.clearColorValue = { r: cr, g: cg, b: cb, a: ca };
        if (!renderTarget) passCtx.stencil = this.stencil;
        ops.resolveViewportScissor(this, passCtx);

        const preparedObjects = ops.prepareRenderObjects(
            this,
            scene,
            camera,
            passCtx,
            passId,
            this.overrideMaterial,
            (nodes, renderObject) =>
                Prepare.prepareRenderObject(
                    this.gl!,
                    nodes,
                    this._programs,
                    this._geometries,
                    this._renderObjectGl,
                    renderObject,
                    { precision: this._opts.precision, maxTextureSize: this._maxTextureSize },
                ),
        );

        const passParams: RenderPassParams = {
            renderTarget,
            clearColor: { r: cr, g: cg, b: cb, a: ca },
            autoClear: this.autoClear,
            autoClearStencil: this.autoClearStencil,
            clearStencilValue: this.clearStencilValue,
            swapchainStencil: this.stencil,
            passId,
        };
        RenderPass.executeRenderPass(
            this.gl,
            {
                geometries: this._geometries,
                uniforms: this._uniforms,
                renderObjectGl: this._renderObjectGl,
                textures: this._textures,
                samplers: this._samplers,
                renderTargets: this._renderTargets,
            },
            this._nodes,
            passCtx,
            preparedObjects,
            passParams,
            inspector,
        );

        // Optional: drain the GL error queue so a mistake surfaces (WebGL has no error scopes).
        const err = this.gl.getError();
        if (err !== this.gl.NO_ERROR) console.error('[WebGLRenderer] render error', err);

        // Close the inspector's render pass. WebGPU emits finishRender inside its render-pass module;
        // WebGL's render() owns the pass lifecycle (immediate mode, no encoder), so it pairs
        // beginRender/finishRender here — guaranteeing balance regardless of executeRenderPass's early
        // returns.
        if (inspector) inspector.finishRender(passId, frame.frameId);

        if (inspector) inspector.perf.end('render');

        this._renderCallDepth--;
        if (this._renderCallDepth > 0) {
            frame.endRender(previousRenderId);
        } else if (inspector) {
            inspector.finish(frame.frameId);
        }
    }

    /**
     * Inspector shader probe: re-render `ro` with a PATCHED fragment shader into a 1×1 FBO and read
     * back the pixel. Drives the Inspector's live-value probe on the WebGL backend — the GL analogue
     * of the WebGPU probe pipeline in inspector.ts. Reuses this renderer's own device caches (programs
     * are compiled fresh from the object's real vertex GLSL + the patched fragment; the object's VAO,
     * std140 UBOs and textures are reused via the shared webgl device functions), so the probe renders
     * the same mesh with the same inputs already valid this frame.
     *
     * Returns the RGBA bytes (0..255) of the single rendered pixel, or null if nothing was drawn or
     * the context isn't ready. Compile/link failures throw (the inspector logs + clears the probe).
     * @internal
     */
    renderProbe(ro: RenderObject, patchedFragment: string): Uint8Array | null {
        if (this._isDeviceLost || !this._initialized || !this.gl) return null;
        return Probe.renderProbe(
            this.gl,
            this._probe,
            {
                geometries: this._geometries,
                uniforms: this._uniforms,
                textures: this._textures,
                samplers: this._samplers,
                frame: this._nodes.nodeFrame,
            },
            ro,
            patchedFragment,
        );
    }

    /** Release the shader-probe GL resources. @internal */
    clearProbe(): void {
        Probe.disposeProbeState(this.gl, this._probe);
    }

    /**
     * Run a transform-feedback kernel (the honest WebGL2 primitive — attribute-in / captured-varying-
     * out). Binds each `inputs[name]` GpuBuffer as vertex attribute `a_<name>`, each `outputs[name]`
     * GpuBuffer as the captured-varying target (`bindBufferBase(TRANSFORM_FEEDBACK_BUFFER, i, …)` in
     * the kernel's declaration order), then runs the kernel under `RASTERIZER_DISCARD` via
     * `drawArrays(POINTS, 0, count)` (or `drawArraysInstanced` when `instanceCount` is set).
     *
     * The caller ping-pongs input/output buffers explicitly across frames; there is one GL buffer per
     * GpuBuffer (no hidden dual-buffering). This method is WebGLRenderer-only — there is no transform
     * feedback on WebGPU (use a `compute()` kernel wrapping the shared body `Fn` there instead).
     *
     * @throws if an output buffer is also used as an input (ping-pong requires distinct buffers).
     */
    transformFeedback(
        node: TransformFeedbackNode,
        opts: {
            inputs: Record<string, GpuBuffer>;
            outputs: Record<string, GpuBuffer>;
            count: number;
            instanceCount?: number;
        },
    ): void {
        if (this._isDeviceLost) return;
        if (!this._initialized || !this.gl) {
            throw new Error('[WebGLRenderer] transformFeedback() called before init(). Await renderer.init() first.');
        }
        TransformFeedback.runTransformFeedback(
            this.gl,
            this._transformFeedback,
            node,
            opts,
            this._opts.precision,
            this._nodes.nodeFrame,
            this._uniforms,
            this._textures,
            this._samplers,
        );
    }

    /**
     * The plain GL buffer backing a GpuBuffer within the transform-feedback state, or null if the
     * buffer was never bound by a `transformFeedback()` call. Used by tests (and Phase 3
     * `readBufferAsync`) to read a TF output buffer back. @internal
     */
    getTransformFeedbackGlBuffer(buffer: GpuBuffer): WebGLBuffer | null {
        return TransformFeedback.getGlBufferFor(this._transformFeedback, buffer);
    }

    /**
     * Honest native CPU readback of a GpuBuffer (e.g. a transform-feedback output) into a typed array.
     *
     * Copies the buffer's current GL buffer into a `STREAM_READ` staging buffer, fences GPU-command
     * completion, polls the fence NON-BLOCKINGLY across event-loop ticks (a synchronous busy-loop
     * never signals on a single-threaded GL backend), then `getBufferSubData`s into a typed array whose
     * element type matches the buffer's schema (Float32Array for f32, Uint32Array for u32, Int32Array
     * for i32). One GpuBuffer = one GL buffer, so there is no dual-buffer coherence to reason about.
     *
     * This method is WebGLRenderer-only. The buffer must have been used by a prior `transformFeedback()`
     * call (that's what allocates its GL buffer); otherwise this throws.
     */
    readBufferAsync(buffer: GpuBuffer): Promise<Float32Array | Int32Array | Uint32Array> {
        if (!this._initialized || !this.gl) {
            return Promise.reject(
                new Error('[WebGLRenderer] readBufferAsync() called before init(). Await renderer.init() first.'),
            );
        }
        return TransformFeedback.readBufferAsync(this.gl, this._transformFeedback, buffer);
    }

    /**
     * Dispose the renderer and force the WebGL2 context loss. After calling dispose(), the renderer
     * cannot be used again.
     */
    dispose(): void {
        // Remove the context-loss listeners before forcing loseContext() below, so our own teardown
        // doesn't fire the user's onDeviceLost callback.
        const canvas = this._canvasTarget?.domElement;
        if (canvas) {
            if (this._onContextLost) canvas.removeEventListener('webglcontextlost', this._onContextLost, false);
            if (this._onContextRestored) canvas.removeEventListener('webglcontextrestored', this._onContextRestored, false);
        }
        this._onContextLost = null;
        this._onContextRestored = null;

        this._renderObjects.renderObjects.clear();
        this._renderObjects.passCaches.clear();
        this._renderContexts.contexts.clear();
        this._nodes.computeStates.clear();

        if (this.gl) {
            Probe.disposeProbeState(this.gl, this._probe);
            Programs.disposePrograms(this.gl, this._programs);
            Uniforms.disposeUniforms(this.gl, this._uniforms);
            Textures.disposeGlTextures(this.gl, this._textures);
            Samplers.disposeGlSamplers(this.gl, this._samplers);
            RenderTargets.disposeGlRenderTargets(this.gl, this._renderTargets);
            TransformFeedback.disposeTransformFeedback(this.gl, this._transformFeedback);
            // Per-geometry GL resources are freed via the geometries WeakMap on GC, or per-geometry
            // disposeGeometry; the context loss below drops the rest.
        }

        this.gl?.getExtension('WEBGL_lose_context')?.loseContext();

        if (this._canvasTarget) this._canvasTarget.dispose();

        this._initialized = false;
        this._isDeviceLost = true;
    }
}

/** Information about a device lost event. Re-exported from the neutral render-loop core. */
export type { DeviceLostInfo };
