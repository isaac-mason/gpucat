import type { GpuBuffer } from '../../core/gpu-buffer';
import type { RenderTarget } from '../../core/render-target';
import type { ComputeNode } from '../../nodes/lib/core';
import type { TransformFeedbackNode } from '../../nodes/lib/transform-feedback';
import type { CanvasTarget } from '../core/canvas-target';
import type { DeviceBackend } from '../core/device-backend';
import type { ComputePassDesc, DispatchRecord, PassDesc, PassEntry, TransformFeedbackPassDesc, TransformFeedbackRecord } from '../core/frame';
import * as Info from '../core/info';
import type { RenderContext } from '../core/pass-context';
import type { RenderObject } from '../core/render-object';
import type { Renderer } from '../core/renderer';
import type { BackendState } from './backend-state';
import * as Bindings from './bindings';
import * as Buffers from './buffers';
import * as Geometries from './geometries';
import * as Programs from './programs';
import { type RenderObjectGlCache } from './render-object-gl';
import * as RenderTargets from './render-target';
import * as Samplers from './samplers';
import * as Textures from './textures';
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
export declare class WebGLBackend implements DeviceBackend, BackendState {
    readonly name: "webgl";
    /** A WebGL2 context belongs to one canvas for its lifetime, and this is it. */
    get deviceCanvasTarget(): CanvasTarget;
    /** @internal */ renderer: Renderer<DeviceBackend>;
    /** The canvas the GL context lives on, which is also a pass target. */
    readonly target: CanvasTarget;
    /** The WebGL2 rendering context in use. Assigned in `init()`. @internal */
    gl: WebGL2RenderingContext | null;
    /** Bound `webglcontextlost` listener, registered in init() and removed in dispose(). @internal */
    private _onContextLost;
    /** Bound `webglcontextrestored` listener, registered in init() and removed in dispose(). @internal */
    private _onContextRestored;
    /** GLSL program cache (compile/link, keyed by source). @internal */
    programs: Programs.ProgramCache;
    /** Per-geometry GL buffers + VAOs. @internal */
    geometries: Geometries.GeometriesState;
    /** The only cache `init` has to build, because it stores the renderer's `info` by reference. @internal */
    buffers: Buffers.BufferCache;
    /** Per-uniform-group std140 UBO cache. @internal */
    uniforms: Bindings.BindingsState;
    /** Per-RenderObject GL device payload (linked program). @internal */
    renderObjectGl: RenderObjectGlCache;
    /** Per-GpuTexture GL texture cache (upload + allocation). @internal */
    textures: Textures.TextureCache;
    /** Per-GpuSampler GL sampler-object cache. @internal */
    samplers: Samplers.SamplerCache;
    /** Per-RenderTarget GL framebuffer (FBO) cache. @internal */
    renderTargets: RenderTargets.GlRenderTargetsState;
    /** Transform-feedback runtime state (per-node program/VAO + I/O buffer cache). @internal */
    private _transformFeedback;
    /** Inspector shader-probe state (one active patched program + 1×1 readback FBO). @internal */
    private readonly _probe;
    /** The primary color/attachment format. Fixed at 'rgba8unorm' for the default framebuffer. @internal */
    readonly format: string;
    /** Last known drawing-buffer size in physical pixels. @internal */
    private _width;
    /** @internal */
    private _height;
    /** Construction options, captured for init(). @internal */
    readonly _opts: WebGLBackendOptions;
    /** Cached `gl.MAX_TEXTURE_SIZE`, read once at init. Threaded into the storage() lowering's grid-width
     *  pick (bigger buffers tile into a device-sized grid). @internal */
    _maxTextureSize: number | undefined;
    constructor(opts: WebGLBackendOptions);
    private _frame;
    /** Acquire the WebGL2 context and set the initial viewport. Async to match the WebGPU contract. */
    init(renderer: Renderer<DeviceBackend>): Promise<void>;
    beginFrame(): void;
    encodePass(desc: PassDesc, records: readonly PassEntry[], count: number): void;
    encodeComputePass(_desc: ComputePassDesc, _records: readonly DispatchRecord[], _count: number): never;
    encodeTransformFeedbackPass(_desc: TransformFeedbackPassDesc, records: readonly TransformFeedbackRecord[], count: number): void;
    submitFrame(): void;
    discardFrame(): void;
    /** WebGL2 has no async link, so this only moves the stall off the first frame and onto load. */
    compileObjects(objects: RenderObject[], _context: RenderContext): Promise<void>;
    /**
     * GL-only counts go under `memory.backend` in GL's own vocabulary rather than a WebGPU-shaped field.
     * VAOs and per-RenderObject payloads are absent because WeakMaps cannot be counted.
     */
    readMemoryStats(memory: Info.MemoryInfo): void;
    compileCompute(_nodes: ComputeNode[]): Promise<void>;
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
     * GpuBuffer. WebGPU has no transform feedback — a `compute()` kernel over the same body `Fn` is
     * its equivalent.
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
     * The fence is polled across event-loop ticks rather than spun on: a synchronous busy-loop never
     * signals on a single-threaded GL backend. The buffer must have been through `transformFeedback()`,
     * which is what allocates its GL buffer.
     */
    readBufferAsync(buffer: GpuBuffer): Promise<Float32Array | Int32Array | Uint32Array>;
    /**
     * Rows come back top-to-bottom to match WebGPU byte-for-byte, which means flipping what GL reads.
     * The target must carry an `rgba8unorm` or `rgba8unorm-srgb` colour format.
     */
    /**
     * WebGL2 has no queue to ask, so this fences the command stream and polls across event-loop ticks.
     * A synchronous spin never signals on a single-threaded backend, which `readBufferAsync` found first.
     */
    awaitCompletion(): Promise<void>;
    readPixels(renderTarget: RenderTarget, attachmentIndex?: number, layer?: number): Promise<Uint8Array>;
    /**
     * Deliberately does not call `WEBGL_lose_context.loseContext()`: a context is per-canvas, so forcing
     * loss poisons the canvas and the next renderer built on it gets the still-lost context back from
     * `getContext()`. The live context is light and is reclaimed with the canvas.
     */
    dispose(): void;
}
