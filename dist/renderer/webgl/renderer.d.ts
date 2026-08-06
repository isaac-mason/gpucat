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
import type { Object3D } from '../../core/object3d';
import type { RenderTarget } from '../../core/render-target';
import type { InspectorBase } from '../../inspector/inspector-base';
import type { Material } from '../../material/material';
import type { MRTNode } from '../../nodes/nodes';
import { CanvasTarget } from '../core/canvas-target';
import * as NodeManager from '../core/node-manager';
import * as RenderContext from '../core/pass-context';
import type { RenderObject } from '../core/render-object';
import * as RenderLists from '../core/render-list';
import * as RenderObjects from '../core/render-objects';
import type { Renderer } from '../core/renderer-interface';
import type { DeviceLostInfo, RendererState } from '../core/renderer-ops';
import type { GpuBuffer } from '../../core/gpu-buffer';
import type { TransformFeedbackNode } from '../../nodes/lib/transform-feedback';
/**
 * Neutral construction options for the WebGL2 renderer — the backend-agnostic subset only (no
 * WebGPU device/adapter/format inputs). Mirrors the shared options `WebGPURendererOptions` also
 * exposes.
 */
export type WebGLRendererOptions = {
    /**
     * Canvas to render into. If not provided, one will be created. An `OffscreenCanvas` (e.g. a 1x1 in a
     * worker) is accepted for headless/offline rendering, where all output goes to a `RenderTarget`.
     */
    canvas?: HTMLCanvasElement | OffscreenCanvas;
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
export declare class WebGLRenderer implements Renderer, RendererState {
    /** Which graphics backend this renderer drives. Runtime discriminant for feature-detection. */
    readonly backend: "webgl";
    /** @internal */
    _initialized: boolean;
    /** @internal */
    _isDeviceLost: boolean;
    /** @internal */
    _inspector: InspectorBase | null;
    get inspector(): InspectorBase | null;
    set inspector(next: InspectorBase | null);
    /** Install or remove the inspector. Equivalent to assigning `renderer.inspector`. */
    setInspector(next: InspectorBase | null): void;
    /** The canvas dom element for the current canvas target (an `OffscreenCanvas` when headless). */
    get domElement(): HTMLCanvasElement | OffscreenCanvas;
    /** The WebGL2 rendering context in use. Assigned in `init()`. @internal */
    gl: WebGL2RenderingContext | null;
    /** Bound `webglcontextlost` listener, registered in init() and removed in dispose(). @internal */
    private _onContextLost;
    /** Bound `webglcontextrestored` listener, registered in init() and removed in dispose(). @internal */
    private _onContextRestored;
    /** GLSL program cache (compile/link, keyed by source). @internal */
    private readonly _programs;
    /** Per-geometry GL buffers + VAOs. @internal */
    private readonly _geometries;
    /** Per-uniform-group std140 UBO cache. @internal */
    private readonly _uniforms;
    /** Per-RenderObject GL device payload (linked program). @internal */
    private readonly _renderObjectGl;
    /** Per-GpuTexture GL texture cache (upload + allocation). @internal */
    private readonly _textures;
    /** Per-GpuSampler GL sampler-object cache. @internal */
    private readonly _samplers;
    /** Per-RenderTarget GL framebuffer (FBO) cache. @internal */
    private readonly _renderTargets;
    /** Transform-feedback runtime state (per-node program/VAO + I/O buffer cache). @internal */
    private readonly _transformFeedback;
    /** Inspector shader-probe state (one active patched program + 1×1 readback FBO). @internal */
    private readonly _probe;
    /** The primary color/attachment format. Fixed at 'rgba8unorm' for the default framebuffer. @internal */
    readonly format: string;
    /** Last known drawing-buffer size in physical pixels. @internal */
    private _width;
    /** @internal */
    private _height;
    /** Construction options, captured for init(). @internal */
    private readonly _opts;
    /** Cached `gl.MAX_TEXTURE_SIZE`, read once at init. Threaded into the storage() lowering's grid-width
     *  pick (bigger buffers tile into a device-sized grid). @internal */
    private _maxTextureSize;
    /** MSAA sample count (0 or 1 = no MSAA). */
    samples: number;
    /** Whether the default framebuffer carries a stencil aspect. */
    readonly stencil: boolean;
    onDeviceLost: ((info: DeviceLostInfo) => void) | null;
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
    _renderCallDepth: number;
    /** clear color for the final composite pass. defaults to opaque black. */
    clearColor: [number, number, number, number];
    /** when false, render() preserves the framebuffer's existing contents instead of clearing. */
    autoClear: boolean;
    /** When true (and autoClear is true), the stencil buffer is cleared each render. */
    autoClearStencil: boolean;
    /** Value the stencil buffer is cleared to (0-255). Default 0. */
    clearStencilValue: number;
    /** @internal */
    _viewport: Vec4 | null;
    /** @internal */
    _scissor: Vec4 | null;
    /** @internal */
    _scissorTest: boolean;
    /** @internal */
    _viewportMinDepth: number;
    /** @internal */
    _viewportMaxDepth: number;
    /** current MRT configuration. */
    mrt: MRTNode | null;
    /** current render target; null renders to the default framebuffer. */
    renderTarget: RenderTarget | null;
    /** when set, all meshes render with this material instead of their own. */
    overrideMaterial: Material | null;
    /** @internal current canvas target. */
    _canvasTarget: CanvasTarget | null;
    setCanvasTarget(canvasTarget: CanvasTarget | null): this;
    getCanvasTarget(): CanvasTarget | null;
    constructor(opts?: WebGLRendererOptions);
    /**
     * Acquire the WebGL2 context and set the initial viewport. Must be called (and awaited) before the
     * first render(). Async to match the `WebGPURenderer` init contract.
     */
    init(): Promise<this>;
    /** set the device pixel ratio. call before setSize(). */
    setPixelRatio(value: number): void;
    /** resize the canvas to logical pixel dimensions (physical = logical * pixelRatio). */
    setSize(width: number, height: number, updateStyle?: boolean): void;
    setViewport(rect: Vec4): void;
    setViewport(x: number, y: number, width: number, height: number, minDepth?: number, maxDepth?: number): void;
    getViewport(): Vec4;
    setScissor(rect: Vec4): void;
    setScissor(x: number, y: number, width: number, height: number): void;
    getScissor(): Vec4;
    setScissorTest(enable: boolean): void;
    getScissorTest(): boolean;
    /**
     * Manually clear the current framebuffer (color and/or depth and/or stencil) to clearColor,
     * ignoring autoClear and viewport/scissor.
     */
    clear(color?: boolean, depth?: boolean, stencil?: boolean): void;
    /**
     * Finalize a cube render target after all six faces are captured: generate the cube texture's
     * mipmaps so a mipped environment map has its lower levels filled. Mirrors the WebGPU renderer's
     * `finalizeCubeCapture` guards — only when the texture wants mips and the base mip level (0) is
     * active. Called by `CubeCamera.update()`.
     */
    finalizeCubeCapture(renderTarget: RenderTarget, mipLevel: number): void;
    /** Minimal feature query. No optional WebGL2 features are surfaced yet. */
    hasFeature(_feature: string): boolean;
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
    };
    saveRendererState(): {
        renderTarget: RenderTarget | null;
        mrt: MRTNode | null;
        clearColor: [number, number, number, number];
        overrideMaterial: Material | null;
    };
    restoreRendererState(state: ReturnType<WebGLRenderer['saveRendererState']>): void;
    /**
     * Render a scene from a camera's perspective. Mirrors `WebGPURenderer.render()`'s neutral sequence,
     * minus the encoder/submit/error-scope steps (WebGL2 is immediate mode).
     */
    render(scene: Object3D, camera: Camera, passId?: string): void;
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
    renderProbe(ro: RenderObject, patchedFragment: string): Uint8Array | null;
    /** Release the shader-probe GL resources. @internal */
    clearProbe(): void;
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
    transformFeedback(node: TransformFeedbackNode, opts: {
        inputs: Record<string, GpuBuffer>;
        outputs: Record<string, GpuBuffer>;
        count: number;
        instanceCount?: number;
    }): void;
    /**
     * The plain GL buffer backing a GpuBuffer within the transform-feedback state, or null if the
     * buffer was never bound by a `transformFeedback()` call. Used by tests (and Phase 3
     * `readBufferAsync`) to read a TF output buffer back. @internal
     */
    getTransformFeedbackGlBuffer(buffer: GpuBuffer): WebGLBuffer | null;
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
    readBufferAsync(buffer: GpuBuffer): Promise<Float32Array | Int32Array | Uint32Array>;
    /**
     * Read a `RenderTarget`'s color attachment back to a tightly-packed, top-to-bottom RGBA8
     * `Uint8Array` (length `width * height * 4`), matching the WebGPU `readPixels` output byte-for-byte
     * (GL reads bottom-to-top, so the rows are flipped). `attachmentIndex` selects an MRT color
     * attachment; `layer` selects a cube face (0..5).
     *
     * The target must have been rendered (`render()` into it) and use an `rgba8unorm` /
     * `rgba8unorm-srgb` color format. This method is WebGLRenderer-only; it enables headless/offline
     * readback (e.g. icon baking) with no canvas presentation.
     */
    readRenderTargetPixels(renderTarget: RenderTarget, attachmentIndex?: number, layer?: number): Promise<Uint8Array>;
    /**
     * Dispose the renderer: free all GL resources (textures, buffers, programs, FBOs) and detach the
     * context-loss listeners. After calling dispose(), this renderer instance cannot be used again.
     *
     * Deliberately does NOT force `WEBGL_lose_context.loseContext()`: the resources above are already
     * freed, and forcing loss poisons the CANVAS: a context is per-canvas, so a new renderer created
     * on the same canvas (React StrictMode / HMR re-mounts, or any deliberate reuse) would call
     * getContext() and get back the still-lost context. The live context is lightweight and is reclaimed
     * when the canvas is dropped/GC'd. Callers that truly want the context gone can loseContext() the gl.
     */
    dispose(): void;
}
/** Information about a device lost event. Re-exported from the neutral render-loop core. */
export type { DeviceLostInfo };
