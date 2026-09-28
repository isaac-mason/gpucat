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
 * Uniforms/textures (Phase 4): the kernel's std140 UBOs and any `textureLoad` data textures are bound
 * before dispatch so kernels using `uniform()` / `textureLoad()` work. Because a standalone kernel has
 * no RenderObject/BindGroup, the binding is driven directly from the compiled result: each uniform
 * group is packed from its `uniform()` nodes' live values and re-packed every dispatch
 * (`updateAndBindStandaloneUniformGroup`), and each texture's `GpuTexture` is bound to its emitter-
 * assigned unit with the combined-sampler uniform set (`bindStandaloneTextures`). The user binds
 * neighbour data as an explicit `DataTexture` referenced by the kernel's `textureLoad` — no hidden mirror.
 */
import type { GpuBuffer } from '../../core/gpu-buffer';
import type { InspectorBase } from '../../inspector/inspector-base';
import { type TransformFeedbackGlslResult } from '../../nodes/builder';
import type { TransformFeedbackNode } from '../../nodes/lib/transform-feedback';
import type { NodeFrame } from '../core/node-frame';
import { type RecordCapture } from './bindings';
import * as Buffers from './buffers';
import type { ProgramInfo } from './programs';
import type { WebGLBackend } from './webgl-backend';
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
    /** The shared WebGLTransformFeedback object (one is enough — TF is serial). */
    tf: WebGLTransformFeedback | null;
    /** All node programs + VAOs created, for disposal. */
    allPrograms: Set<WebGLProgram>;
    allVaos: Set<WebGLVertexArrayObject>;
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
 * Captures one recorded dispatch's uniform groups and texture values into `out`, at the call that
 * recorded it, so it runs with the values set before that call. Values come from each uniform() node's
 * `.uniform.value` (sourced exactly like the render path), re-packed every dispatch so per-dispatch
 * uniforms (e.g. a `dt` timestep, or a step index in a loop) take effect. Groups whose members were all
 * optimized out have no binding point and are skipped.
 */
export declare function captureTransformFeedback(gl: WebGL2RenderingContext, b: WebGLBackend, state: TransformFeedbackState, node: TransformFeedbackNode, precision: 'highp' | 'mediump' | 'lowp' | undefined, frame: NodeFrame, out: RecordCapture): void;
/**
 * Execute one transform-feedback dispatch: bind the kernel's input `GpuBuffer`s as attributes, its
 * output `GpuBuffer`s as the captured-varying targets, and run the kernel under `RASTERIZER_DISCARD`,
 * with the uniforms and textures its record captured.
 */
export declare function runTransformFeedback(gl: WebGL2RenderingContext, b: WebGLBackend, state: TransformFeedbackState, node: TransformFeedbackNode, opts: TransformFeedbackRunOptions, precision: 'highp' | 'mediump' | 'lowp' | undefined, capture: RecordCapture, inspector: InspectorBase | null, 
/** The kernel entry this dispatch belongs to, so the GPU bracket lands on it. */
inspectorName: string): void;
/**
 * Get the plain GL buffer backing a GpuBuffer within this transform-feedback state, if one exists.
 * Used by the test harness (and Phase 3 `readBufferAsync`) to read back a TF output buffer. Returns
 * null if the buffer was never bound. @internal
 */
export declare function getGlBufferFor(buffers: Buffers.BufferCache, buffer: GpuBuffer): WebGLBuffer | null;
/**
 * Poll a fence to completion WITHOUT blocking the thread. Returns a promise that resolves once the GPU
 * has signalled `sync`, rejecting if the wait fails or exceeds `maxPolls` event-loop ticks.
 *
 * The fence MUST be polled across event-loop ticks (`setTimeout(0)`), not in a synchronous busy-loop:
 * on a single-threaded GL backend (SwiftShader/ANGLE, the test platform) the GPU commands only make
 * progress when the loop turns, so a tight `clientWaitSync(sync, 0, 0)` spin on one tick hits
 * `TIMEOUT_EXPIRED` forever and never signals. The first poll passes `SYNC_FLUSH_COMMANDS_BIT` to
 * guarantee the flush; subsequent polls yield a tick, then re-poll. This mirrors the Phase-0.5 probe
 * (`tst/tf-probe/run.mjs`), whose whole point was proving this async shape is the one that works.
 */
export declare function clientWaitAsync(gl: WebGL2RenderingContext, sync: WebGLSync, label?: string, maxPolls?: number): Promise<void>;
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
export declare function readBufferAsync(gl: WebGL2RenderingContext, buffers: Buffers.BufferCache, buffer: GpuBuffer): Promise<Float32Array | Int32Array | Uint32Array>;
/** Release all GL resources owned by the transform-feedback state (called on renderer dispose). */
export declare function disposeTransformFeedback(gl: WebGL2RenderingContext, state: TransformFeedbackState): void;
export {};
