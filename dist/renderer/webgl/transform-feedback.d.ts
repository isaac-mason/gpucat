/**
 * transform-feedback.ts (webgl) - the WebGL2 transform-feedback runtime.
 *
 * Executes the attribute-in / captured-varying-out kernels that `compileTransformFeedback` compiles
 * (see llm/webgl-transform-feedback-plan.md, Phase 2). This is the honest WebGL2 transform-feedback
 * primitive: each kernel is a vertex shader run under `RASTERIZER_DISCARD`, its per-element input
 * attributes are read from the caller's `GpuBuffer`s (bound via a VAO), and its captured varyings are
 * written into the caller's output `GpuBuffer`s (bound via `bindBufferBase(TRANSFORM_FEEDBACK_BUFFER,
 * i, …)` in `SEPARATE_ATTRIBS` order). There is one GL buffer per `GpuBuffer` — no dual buffers, no
 * auto-swap; the caller ping-pongs input/output buffers explicitly.
 *
 * Caching: the compiled GLSL result + the linked program are cached per `TransformFeedbackNode`
 * (WeakMap, invalidated via the node's dispose hook). One `WebGLTransformFeedback` object and one VAO
 * are cached per renderer state. I/O `GpuBuffer`s get a plain `GpuBuffer → WebGLBuffer` cache (also
 * WeakMap), re-uploaded when the buffer's `version` changes.
 *
 * Uniforms/textures: the kernel's UBOs and any `textureLoad` data textures are bound so kernels using
 * `uniform()` / `textureLoad()` work — but only the parts of that path that don't depend on a
 * RenderObject/bind-group are wired here; see the Phase-2 note below.
 */
import type { GpuBuffer } from '../../core/gpu-buffer';
import { type TransformFeedbackGlslResult } from '../../nodes/builder';
import type { TransformFeedbackNode } from '../../nodes/lib/transform-feedback';
import type { ProgramInfo } from './programs';
/** Per-node cached compile + link. */
type TfNodeCache = {
    compiled: TransformFeedbackGlslResult;
    programInfo: ProgramInfo;
    /** VAO keyed by this node's program (attribute layout is fixed by the program's locations). */
    vao: WebGLVertexArrayObject;
};
/** Transform-feedback runtime state. Owned by the renderer, disposed with it. */
export type TransformFeedbackState = {
    /** Per-node compiled + linked resources. Invalidated via the node's dispose hook. */
    nodes: WeakMap<TransformFeedbackNode, TfNodeCache>;
    /** Plain GL buffer per I/O GpuBuffer (re-uploaded on version change). */
    buffers: WeakMap<GpuBuffer, {
        glBuffer: WebGLBuffer;
        version: number;
    }>;
    /** The shared WebGLTransformFeedback object (one is enough — TF is serial). */
    tf: WebGLTransformFeedback | null;
    /** All node programs + VAOs created, for disposal. */
    allPrograms: Set<WebGLProgram>;
    allVaos: Set<WebGLVertexArrayObject>;
    allBuffers: Set<WebGLBuffer>;
};
export declare function createTransformFeedbackState(): TransformFeedbackState;
/** Options for a single transform-feedback dispatch. */
export type TransformFeedbackRunOptions = {
    /** name → GpuBuffer, bound as vertex attribute `a_<name>`. */
    inputs: Record<string, GpuBuffer>;
    /** name → GpuBuffer, bound as the captured-varying target `v_<name>`. */
    outputs: Record<string, GpuBuffer>;
    /** Element invocations → drawArrays(POINTS, 0, count). */
    count: number;
    /** When set, drawArraysInstanced(POINTS, 0, count, instanceCount). */
    instanceCount?: number;
};
/**
 * Execute one transform-feedback dispatch: bind the kernel's input `GpuBuffer`s as attributes, its
 * output `GpuBuffer`s as the captured-varying targets, and run the kernel under `RASTERIZER_DISCARD`.
 */
export declare function runTransformFeedback(gl: WebGL2RenderingContext, state: TransformFeedbackState, node: TransformFeedbackNode, opts: TransformFeedbackRunOptions, precision: 'highp' | 'mediump' | 'lowp' | undefined): void;
/**
 * Get the plain GL buffer backing a GpuBuffer within this transform-feedback state, if one exists.
 * Used by the test harness (and Phase 3 `readBufferAsync`) to read back a TF output buffer. Returns
 * null if the buffer was never bound. @internal
 */
export declare function getGlBufferFor(state: TransformFeedbackState, buffer: GpuBuffer): WebGLBuffer | null;
/**
 * Honest native CPU readback of a GpuBuffer's current GL buffer (e.g. a transform-feedback output).
 *
 * Copies the source buffer into a `STREAM_READ` staging buffer, fences GPU-command completion, polls
 * the fence across event-loop ticks (never a synchronous busy-loop — see `clientWaitAsync`), then
 * `getBufferSubData`s into a typed array whose element type matches the buffer's schema (Float32Array
 * for f32 schemas, Uint32Array for u32, Int32Array for i32). The staging buffer + fence are deleted;
 * bindings are unwound. One GpuBuffer = one GL buffer, so there is no dual-buffer coherence to reason
 * about. See llm/webgl-transform-feedback-plan.md, Phase 3.
 */
export declare function readBufferAsync(gl: WebGL2RenderingContext, state: TransformFeedbackState, buffer: GpuBuffer): Promise<Float32Array | Int32Array | Uint32Array>;
/** Release all GL resources owned by the transform-feedback state (called on renderer dispose). */
export declare function disposeTransformFeedback(gl: WebGL2RenderingContext, state: TransformFeedbackState): void;
export {};
