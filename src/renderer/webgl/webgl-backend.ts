import type { GpuBuffer } from '../../core/gpu-buffer';
import type { RenderTarget } from '../../core/render-target';
import type { ComputeNode } from '../../nodes/lib/core';
import type { TransformFeedbackNode } from '../../nodes/lib/transform-feedback';
import { yieldToMain } from '../../utils/yield-to-main';
import type { CanvasTarget } from '../core/canvas-target';
import type { DeviceBackend } from '../core/device-backend';
import type {
    ComputePassDesc,
    DispatchRecord,
    PassDesc,
    PassEntry,
    TransformFeedbackPassDesc,
    TransformFeedbackRecord,
} from '../core/frame';
import { isFrameOpen } from '../core/frame';
import * as Info from '../core/info';
import type { RenderContext } from '../core/pass-context';
import type { RenderObject } from '../core/render-object';
import type { Renderer } from '../core/renderer';
import type { BackendState } from './backend-state';
import * as Bindings from './bindings';
import * as Buffers from './buffers';
import { createContext } from './context';
import * as FrameBackend from './frame-backend';
import * as Geometries from './geometries';
import * as Prepare from './prepare';
import * as Probe from './probe';
import * as Programs from './programs';
import * as ReadPixels from './read-pixels';
import { createRenderObjectGlCache, type RenderObjectGlCache } from './render-object-gl';
import * as RenderTargets from './render-target';
import * as Samplers from './samplers';
import * as Textures from './textures';
import * as TransformFeedback from './transform-feedback';

export type WebGLBackendOptions = {
    /** The device, not just a target: a WebGL2 context IS this canvas's context, and its `samples`/`depthFormat` become context attributes. */
    target: CanvasTarget;

    /** When true, the drawing buffer has an alpha channel (premultiplied compositing). Default false. */
    alpha?: boolean;

    /** Allocate a depth buffer for the default framebuffer. Default true. */
    depth?: boolean;

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

/** WebGL2's device half. Immediate mode: no command encoder and no swapchain, so a pass encodes as it ends. */
export class WebGLBackend implements DeviceBackend, BackendState {
    readonly name = 'webgl' as const;

    /** A WebGL2 context belongs to one canvas for its lifetime, and this is it. */
    get deviceCanvasTarget(): CanvasTarget {
        return this.target;
    }

    // A backend is constructed before its renderer, so this cannot hold a real value until `init`.
    /** @internal */ renderer: Renderer<DeviceBackend> = null!;

    /** The canvas the GL context lives on, which is also a pass target. */
    readonly target: CanvasTarget;

    // WebGL2 device state — owned directly as fields. Assigned in init().
    // WebGL2 is immediate mode: no command encoder, no swapchain object.

    /** The WebGL2 rendering context in use. Assigned in `init()`. @internal */
    gl: WebGL2RenderingContext | null = null;

    /** Bound `webglcontextlost` listener, registered in init() and removed in dispose(). @internal */
    private _onContextLost: ((e: Event) => void) | null = null;
    /** Bound `webglcontextrestored` listener, registered in init() and removed in dispose(). @internal */
    private _onContextRestored: ((e: Event) => void) | null = null;

    // Device resource caches. The GL handles inside are created lazily on first use, since those need
    // the context that init() acquires, but the caches themselves need nothing and are built here.

    /** GLSL program cache (compile/link, keyed by source). @internal */
    programs: Programs.ProgramCache = Programs.createProgramCache();
    /** Per-geometry GL buffers + VAOs. @internal */
    geometries: Geometries.GeometriesState = Geometries.createGeometriesState();
    /** The only cache `init` has to build, because it stores the renderer's `info` by reference. @internal */
    buffers: Buffers.BufferCache = null!;
    /** Per-uniform-group std140 UBO cache. @internal */
    uniforms: Bindings.BindingsState = Bindings.createBindingsState();
    /** Per-RenderObject GL device payload (linked program). @internal */
    renderObjectGl: RenderObjectGlCache = createRenderObjectGlCache();
    /** Per-GpuTexture GL texture cache (upload + allocation). @internal */
    textures: Textures.TextureCache = Textures.createTextureCache();
    /** Per-GpuSampler GL sampler-object cache. @internal */
    samplers: Samplers.SamplerCache = Samplers.createSamplerCache();
    /** Per-RenderTarget GL framebuffer (FBO) cache. @internal */
    renderTargets: RenderTargets.GlRenderTargetsState = RenderTargets.createGlRenderTargetsState();

    /** Transform-feedback runtime state (per-node program/VAO + I/O buffer cache). @internal */
    private _transformFeedback: TransformFeedback.TransformFeedbackState = TransformFeedback.createTransformFeedbackState();

    /** Inspector shader-probe state (one active patched program + 1×1 readback FBO). @internal */
    private readonly _probe: Probe.ProbeState = Probe.createProbeState();

    /** The primary color/attachment format. Fixed at 'rgba8unorm' for the default framebuffer. @internal */
    readonly format: string = 'rgba8unorm';

    /** Last known drawing-buffer size in physical pixels. @internal */
    private _width = 1;
    /** @internal */
    private _height = 1;

    /** Construction options, captured for init(). @internal */
    readonly _opts: WebGLBackendOptions;

    /** Cached `gl.MAX_TEXTURE_SIZE`, read once at init. Threaded into the storage() lowering's grid-width
     *  pick (bigger buffers tile into a device-sized grid). @internal */
    _maxTextureSize: number | undefined;

    constructor(opts: WebGLBackendOptions) {
        this._opts = opts;
        this.target = opts.target;
    }

    private _frame: FrameBackend.WebGLFrameBackendState = null!;

    /** Acquire the WebGL2 context and set the initial viewport. Async to match the WebGPU contract. */
    // eslint-disable-next-line @typescript-eslint/require-await
    async init(renderer: Renderer<DeviceBackend>): Promise<void> {
        this.renderer = renderer;

        this.buffers = Buffers.createBufferCache(renderer.info);

        const { width, height } = this.target.getDrawingBufferSize();
        this._width = width || 1;
        this._height = height || 1;

        this.gl = createContext(this.target.canvas, {
            alpha: this._opts.alpha ?? false,
            depth: this._opts.depth ?? true,
            stencil: this.target.depthFormat.includes('stencil'),
            antialias: this.target.samples > 1,
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
        // the event's default keeps the context restorable. We flip `_isDeviceLost` (every frame phase
        // no-ops while lost) and fire the same neutral `onDeviceLost` callback the WebGPU path uses.
        const canvas = this.target.canvas;
        this._onContextLost = (e: Event): void => {
            e.preventDefault();
            this.renderer._isDeviceLost = true;
            // `statusMessage` carries the driver's reason (e.g. "Too many active WebGL contexts",
            // "GPU process crashed"). Surface it, since a lost context otherwise masquerades as
            // unrelated FBO/format errors downstream.
            const statusMessage = (e as Event & { statusMessage?: string }).statusMessage || '';
            console.error(`[webgl] WebGL2 context lost. reason: ${statusMessage || '(none given)'}`);
            this.renderer.onDeviceLost?.({
                api: 'WebGL2',
                message: `WebGL2 context lost${statusMessage ? `: ${statusMessage}` : ''}`,
                reason: statusMessage || null,
                originalEvent: e,
            });
        };
        this._onContextRestored = (): void => {
            // The GL context is back, but all GL objects (programs/buffers/textures/FBOs) were
            // invalidated on loss. Full resource re-creation from the neutral caches is a TODO; for now
            // we clear the lost flag and log so a restore is observable rather than silently broken.
            // TODO: rebuild GL device resources here so rendering resumes after a context restore.
            this.renderer._isDeviceLost = false;
            console.warn(
                '[webgl] WebGL2 context restored; GL resources were invalidated and are not yet ' +
                    'automatically re-created. Recreate the renderer to resume rendering.',
            );
        };
        canvas.addEventListener('webglcontextlost', this._onContextLost, false);
        canvas.addEventListener('webglcontextrestored', this._onContextRestored, false);

        this._frame = FrameBackend.createWebGLFrameBackendState(renderer, this);
    }

    beginFrame(): void {
        FrameBackend.beginFrame(this._frame);
    }

    encodePass(desc: PassDesc, records: readonly PassEntry[], count: number): void {
        FrameBackend.encodePass(this._frame, desc, records, count);
    }

    encodeComputePass(_desc: ComputePassDesc, _records: readonly DispatchRecord[], _count: number): never {
        return FrameBackend.encodeComputePass();
    }

    encodeTransformFeedbackPass(
        _desc: TransformFeedbackPassDesc,
        records: readonly TransformFeedbackRecord[],
        count: number,
    ): void {
        if (this.renderer._isDeviceLost || !this.gl) return;
        for (let i = 0; i < count; i++) {
            const record = records[i]!;
            TransformFeedback.runTransformFeedback(
                this.gl,
                this,
                this._transformFeedback,
                record.node,
                record,
                this._opts.precision,
                this.renderer._nodes.nodeFrame,
            );
        }
    }

    submitFrame(): void {
        FrameBackend.submitFrame(this._frame);
    }

    discardFrame(): void {
        FrameBackend.discardFrame(this._frame);
    }

    /** WebGL2 has no async link, so this only moves the stall off the first frame and onto load. */
    async compileObjects(objects: RenderObject[], _context: RenderContext): Promise<void> {
        const opts = { precision: this._opts.precision, maxTextureSize: this._maxTextureSize };
        for (const renderObject of objects) {
            Prepare.prepareRenderObject(this.gl!, this, this.renderer._nodes, renderObject, opts);
            await yieldToMain();
        }
    }

    /**
     * GL-only counts go under `memory.backend` in GL's own vocabulary rather than a WebGPU-shaped field.
     * VAOs and per-RenderObject payloads are absent because WeakMaps cannot be counted.
     */
    readMemoryStats(memory: Info.MemoryInfo): void {
        const buffers = Buffers.getBufferCacheStats(this.buffers);
        const renderTargets = RenderTargets.getGlRenderTargetsStats(this.renderTargets);
        memory.buffers = buffers.bufferCount + buffers.rawCount;
        memory.geometries = Geometries.getGeometriesStats(this.geometries).geometries;
        // count + bytes + per-format breakdown, straight from the cache's running tally.
        Info.readTextureTally(this.textures.tally, memory);
        memory.samplers = Samplers.getSamplerCacheStats(this.samplers).samplerCount;
        // Keyed on source, so it does not compare with WebGPU's pipeline count, which adds fixed-function state.
        memory.backend.programs = Programs.getProgramCacheStats(this.programs).programCount;
        memory.backend.framebuffers = renderTargets.fboCount;
        memory.backend.renderbuffers = renderTargets.renderbufferCount;
    }

    async compileCompute(_nodes: ComputeNode[]): Promise<void> {
        throw new Error('[webgl] compileCompute() needs the webgpu backend; WebGL2 has no compute shaders');
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
        if (this.renderer._isDeviceLost || !this.renderer._initialized || !this.gl) return null;
        return Probe.renderProbe(
            this.gl,
            this._probe,
            {
                geometries: this.geometries,
                buffers: this.buffers,
                uniforms: this.uniforms,
                textures: this.textures,
                samplers: this.samplers,
                frame: this.renderer._nodes.nodeFrame,
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
     * GpuBuffer. WebGPU has no transform feedback — a `compute()` kernel over the same body `Fn` is
     * its equivalent.
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
        if (isFrameOpen(this.renderer._frameState)) {
            // WebGL2 has no encoder, so this runs the instant it is called while the frame's passes
            // encode at each `end()`: the kernel would land between them rather than before them.
            throw new Error(
                '[webgl] transformFeedback() while a frame is open runs out of order; call it before frame() or after submit().',
            );
        }
        if (this.renderer._isDeviceLost) return;
        if (!this.renderer._initialized || !this.gl) {
            throw new Error('[webgl] transformFeedback() called before init(). Await renderer.init() first.');
        }
        TransformFeedback.runTransformFeedback(
            this.gl,
            this,
            this._transformFeedback,
            node,
            opts,
            this._opts.precision,
            this.renderer._nodes.nodeFrame,
        );
    }

    /**
     * The plain GL buffer backing a GpuBuffer within the transform-feedback state, or null if the
     * buffer was never bound by a `transformFeedback()` call. Used by tests (and Phase 3
     * `readBufferAsync`) to read a TF output buffer back. @internal
     */
    getTransformFeedbackGlBuffer(buffer: GpuBuffer): WebGLBuffer | null {
        return TransformFeedback.getGlBufferFor(this.buffers, buffer);
    }

    /**
     * Honest native CPU readback of a GpuBuffer (e.g. a transform-feedback output) into a typed array.
     *
     * The fence is polled across event-loop ticks rather than spun on: a synchronous busy-loop never
     * signals on a single-threaded GL backend. The buffer must have been through `transformFeedback()`,
     * which is what allocates its GL buffer.
     */
    readBufferAsync(buffer: GpuBuffer): Promise<Float32Array | Int32Array | Uint32Array> {
        if (!this.renderer._initialized || !this.gl) {
            return Promise.reject(new Error('[webgl] readBufferAsync() called before init(). Await renderer.init() first.'));
        }
        return TransformFeedback.readBufferAsync(this.gl, this.buffers, buffer);
    }

    /**
     * Rows come back top-to-bottom to match WebGPU byte-for-byte, which means flipping what GL reads.
     * The target must carry an `rgba8unorm` or `rgba8unorm-srgb` colour format.
     */
    /**
     * WebGL2 has no queue to ask, so this fences the command stream and polls across event-loop ticks.
     * A synchronous spin never signals on a single-threaded backend, which `readBufferAsync` found first.
     */
    awaitCompletion(): Promise<void> {
        const gl = this.gl;
        if (!gl) return Promise.resolve();
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (!sync) return Promise.resolve();
        return TransformFeedback.clientWaitAsync(gl, sync, 'frame.done').finally(() => gl.deleteSync(sync));
    }

    readPixels(renderTarget: RenderTarget, attachmentIndex = 0, layer = 0): Promise<Uint8Array> {
        return Promise.resolve(
            ReadPixels.readPixels(this.gl!, this.renderTargets, this.textures, renderTarget, attachmentIndex, layer),
        );
    }

    /**
     * Deliberately does not call `WEBGL_lose_context.loseContext()`: a context is per-canvas, so forcing
     * loss poisons the canvas and the next renderer built on it gets the still-lost context back from
     * `getContext()`. The live context is light and is reclaimed with the canvas.
     */
    dispose(): void {
        // Remove the context-loss listeners first, so tearing down GL resources below never fires the
        // user's onDeviceLost callback.
        const canvas = this.target.canvas;
        if (this._onContextLost) canvas.removeEventListener('webglcontextlost', this._onContextLost, false);
        if (this._onContextRestored) canvas.removeEventListener('webglcontextrestored', this._onContextRestored, false);
        this._onContextLost = null;
        this._onContextRestored = null;

        if (this.gl) {
            Probe.disposeProbeState(this.gl, this._probe);
            Programs.disposePrograms(this.gl, this.programs);
            Textures.disposeTextureCache(this.gl, this.textures);
            Samplers.disposeSamplerCache(this.gl, this.samplers);
            RenderTargets.disposeGlRenderTargets(this.gl, this.renderTargets);
            TransformFeedback.disposeTransformFeedback(this.gl, this._transformFeedback);
            // Every GL buffer this renderer made: vertex, index and uniform-block. Individually they
            // are released when their GpuBuffer is disposed; this is the teardown sweep.
            Buffers.disposeBufferCache(this.gl, this.buffers);
            // Per-geometry VAOs are freed by disposeGeometry when the Geometry goes away.
        }

        this.target.dispose();
    }
}
