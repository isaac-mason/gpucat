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
import { typedArrayCtorOf } from '../../schema/schema';
import {
    compileTransformFeedback,
    type TransformFeedbackGlslResult,
} from '../../nodes/builder';
import type { TransformFeedbackNode } from '../../nodes/lib/transform-feedback';
import type { NodeFrame } from '../core/node-frame';
import { attribFormat, glComponentType } from './geometries';
import { createTransformFeedbackProgram } from './programs';
import type { ProgramInfo } from './programs';
import type { GlSamplersState } from './samplers';
import type { GlTexturesState } from './textures';
import { bindStandaloneTextures } from './texture-bindings';
import { updateAndBindStandaloneUniformGroup, type UniformsState } from './uniforms';

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
    buffers: WeakMap<GpuBuffer, { glBuffer: WebGLBuffer; version: number }>;
    /** The shared WebGLTransformFeedback object (one is enough — TF is serial). */
    tf: WebGLTransformFeedback | null;
    /** All node programs + VAOs created, for disposal. */
    allPrograms: Set<WebGLProgram>;
    allVaos: Set<WebGLVertexArrayObject>;
    allBuffers: Set<WebGLBuffer>;
};

export function createTransformFeedbackState(): TransformFeedbackState {
    return {
        nodes: new WeakMap(),
        buffers: new WeakMap(),
        tf: null,
        allPrograms: new Set(),
        allVaos: new Set(),
        allBuffers: new Set(),
    };
}

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
 * Ensure a plain GL buffer exists for an I/O GpuBuffer, uploading (or re-uploading on version change)
 * its CPU array. Output buffers may legitimately have a null array (e.g. allocated by `count`); the
 * caller allocates GL storage sized to the array either way. An input buffer must have data.
 */
function ensureIoBuffer(
    gl: WebGL2RenderingContext,
    state: TransformFeedbackState,
    buffer: GpuBuffer,
    role: 'input' | 'output',
    name: string,
): WebGLBuffer {
    let entry = state.buffers.get(buffer);
    if (!entry) {
        const glBuffer = gl.createBuffer();
        if (!glBuffer) throw new Error('[WebGLRenderer] gl.createBuffer returned null (transform-feedback IO).');
        entry = { glBuffer, version: -1 };
        state.buffers.set(buffer, entry);
        state.allBuffers.add(glBuffer);
        // Invalidate this cache entry when the GpuBuffer is disposed.
        const prevDispose = buffer._onDispose;
        buffer._onDispose = (): void => {
            prevDispose?.();
            const e = state.buffers.get(buffer);
            if (e) {
                gl.deleteBuffer(e.glBuffer);
                state.allBuffers.delete(e.glBuffer);
                state.buffers.delete(buffer);
            }
        };
    }

    if (entry.version !== buffer.version) {
        const array = buffer.array;
        gl.bindBuffer(gl.ARRAY_BUFFER, entry.glBuffer);
        if (array) {
            // Outputs are GPU-written (TF capture) and GPU-consumed (copied to a staging buffer in
            // readBufferAsync, then fed back as attributes) → DYNAMIC_COPY, not *_READ. A READ hint makes
            // the driver keep a readback shadow copy for a getBufferSubData that never comes, discarded on
            // every re-write (perf-warning spam). Inputs are fed straight in as attributes → STATIC_DRAW.
            gl.bufferData(gl.ARRAY_BUFFER, array, role === 'output' ? gl.DYNAMIC_COPY : gl.STATIC_DRAW);
        } else if (role === 'output') {
            throw new Error(
                `[WebGLRenderer] transform-feedback output buffer '${name}' has a null array; ` +
                    `allocate it with { count } or { data } so its size is known.`,
            );
        } else {
            throw new Error(`[WebGLRenderer] transform-feedback input buffer '${name}' has a null array.`);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        entry.version = buffer.version;
    }

    return entry.glBuffer;
}

/** Get (or compile + link + build-VAO-slot for) the per-node cache. */
function getNodeCache(
    gl: WebGL2RenderingContext,
    state: TransformFeedbackState,
    node: TransformFeedbackNode,
    precision: 'highp' | 'mediump' | 'lowp' | undefined,
): TfNodeCache {
    let cache = state.nodes.get(node);
    if (cache) return cache;

    const compiled = compileTransformFeedback(node, precision ? { precision } : {});
    const programInfo = createTransformFeedbackProgram(
        gl,
        compiled.vertexCode,
        compiled.fragmentCode,
        compiled.feedbackVaryings,
        compiled.uniformGroups,
    );

    const vao = gl.createVertexArray();
    if (!vao) throw new Error('[WebGLRenderer] gl.createVertexArray returned null (transform-feedback).');

    cache = { compiled, programInfo, vao };
    state.nodes.set(node, cache);
    state.allPrograms.add(programInfo.program);
    state.allVaos.add(vao);

    // Invalidate on node dispose.
    const prevDispose = node._onDispose;
    node._onDispose = (): void => {
        prevDispose?.();
        const c = state.nodes.get(node);
        if (c) {
            gl.deleteProgram(c.programInfo.program);
            gl.deleteVertexArray(c.vao);
            state.allPrograms.delete(c.programInfo.program);
            state.allVaos.delete(c.vao);
            state.nodes.delete(node);
        }
    };

    return cache;
}

/**
 * Execute one transform-feedback dispatch: bind the kernel's input `GpuBuffer`s as attributes, its
 * output `GpuBuffer`s as the captured-varying targets, and run the kernel under `RASTERIZER_DISCARD`.
 */
export function runTransformFeedback(
    gl: WebGL2RenderingContext,
    state: TransformFeedbackState,
    node: TransformFeedbackNode,
    opts: TransformFeedbackRunOptions,
    precision: 'highp' | 'mediump' | 'lowp' | undefined,
    frame: NodeFrame,
    uniforms: UniformsState,
    textures: GlTexturesState,
    samplers: GlSamplersState,
): void {
    const { inputs, outputs, count, instanceCount } = opts;

    // Alias guard: a buffer used as an output can't also be an input (a TF-bound buffer must not be
    // read as an attribute in the same dispatch). Ping-pong with distinct buffers instead.
    const inputBuffers = new Set(Object.values(inputs));
    for (const outBuf of Object.values(outputs)) {
        if (inputBuffers.has(outBuf)) {
            throw new Error(
                `[WebGLRenderer] transform-feedback output buffer can't also be an input; ` +
                    `use distinct buffers and ping-pong`,
            );
        }
    }

    const cache = getNodeCache(gl, state, node, precision);
    const { compiled, programInfo, vao } = cache;

    // Validate every declared input/output has a buffer.
    for (const attr of compiled.inputAttributes) {
        // Attribute shader name is `a_<name>`; the run-site key is the bare `<name>`.
        const key = attr.name.startsWith('a_') ? attr.name.slice(2) : attr.name;
        if (!inputs[key]) {
            throw new Error(`[WebGLRenderer] transform-feedback kernel input '${key}' has no bound buffer.`);
        }
    }

    gl.useProgram(programInfo.program);

    // Bind the kernel's uniform groups (std140 UBOs) to their resolved binding points. Values come
    // from each uniform() node's `.uniform.value` (sourced exactly like the render path), re-packed
    // every dispatch so per-frame uniforms (e.g. a `dt` timestep) take effect. Groups whose members
    // were all optimized out have no binding point → skipped.
    for (const group of compiled.uniformGroups) {
        if (group.members.length === 0) continue;
        const bindingPoint = programInfo.uboBindingPoints.get(group.groupName);
        if (bindingPoint === undefined) continue;
        updateAndBindStandaloneUniformGroup(gl, uniforms, group, frame, bindingPoint);
    }

    // Bind any DataTextures the kernel samples via textureLoad() (explicit neighbour gather — the user
    // binds the DataTexture on the texture node; no hidden mirror). Runs in the vertex stage under TF.
    if (compiled.textures.length > 0) {
        bindStandaloneTextures(gl, textures, samplers, compiled.textures, compiled.samplers, programInfo);
    }

    // Bind inputs as vertex attributes into the node's VAO (rebuilt each dispatch: the caller may
    // ping-pong a different GpuBuffer per element name each frame, so the attribute→buffer binding
    // is not stable across dispatches).
    gl.bindVertexArray(vao);
    for (const attr of compiled.inputAttributes) {
        const key = attr.name.startsWith('a_') ? attr.name.slice(2) : attr.name;
        const glBuffer = ensureIoBuffer(gl, state, inputs[key]!, 'input', key);
        const fmt = attribFormat(attr.type);
        const compType = glComponentType(gl, fmt.glType);
        const columnBytes = fmt.size * 4;
        for (let slot = 0; slot < fmt.slots; slot++) {
            const location = attr.location + slot;
            const offset = slot * columnBytes;
            gl.bindBuffer(gl.ARRAY_BUFFER, glBuffer);
            gl.enableVertexAttribArray(location);
            if (fmt.glType === 'float') {
                gl.vertexAttribPointer(location, fmt.size, compType, false, fmt.byteSize, offset);
            } else {
                gl.vertexAttribIPointer(location, fmt.size, compType, fmt.byteSize, offset);
            }
            // Own-index kernels advance the attribute per vertex; leave the divisor at 0 (default).
            gl.vertexAttribDivisor(location, 0);
        }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    // Bind outputs to the transform-feedback binding points in feedbackVaryings (SEPARATE_ATTRIBS)
    // order. Each varying is `v_<name>`; the run-site key is the bare `<name>`.
    if (!state.tf) {
        const tf = gl.createTransformFeedback();
        if (!tf) throw new Error('[WebGLRenderer] gl.createTransformFeedback returned null.');
        state.tf = tf;
    }
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, state.tf);
    for (let i = 0; i < compiled.feedbackVaryings.length; i++) {
        const varying = compiled.feedbackVaryings[i]!;
        const key = varying.startsWith('v_') ? varying.slice(2) : varying;
        const outGpuBuffer = outputs[key];
        if (!outGpuBuffer) {
            throw new Error(`[WebGLRenderer] transform-feedback kernel output '${key}' has no bound buffer.`);
        }
        const glOut = ensureIoBuffer(gl, state, outGpuBuffer, 'output', key);
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, i, glOut);
    }

    // Dispatch under RASTERIZER_DISCARD.
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    if (instanceCount !== undefined) {
        gl.drawArraysInstanced(gl.POINTS, 0, count, instanceCount);
    } else {
        gl.drawArrays(gl.POINTS, 0, count);
    }
    gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD);

    // Unbind the TF binding points + object so the output buffers can be read back / reused.
    for (let i = 0; i < compiled.feedbackVaryings.length; i++) {
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, i, null);
    }
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.bindVertexArray(null);
    gl.useProgram(null);
}

/**
 * Get the plain GL buffer backing a GpuBuffer within this transform-feedback state, if one exists.
 * Used by the test harness (and Phase 3 `readBufferAsync`) to read back a TF output buffer. Returns
 * null if the buffer was never bound. @internal
 */
export function getGlBufferFor(state: TransformFeedbackState, buffer: GpuBuffer): WebGLBuffer | null {
    return state.buffers.get(buffer)?.glBuffer ?? null;
}

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
function clientWaitAsync(gl: WebGL2RenderingContext, sync: WebGLSync, maxPolls = 4000): Promise<void> {
    return new Promise((resolve, reject) => {
        let polls = 0;
        const poll = (flags: number): void => {
            const status = gl.clientWaitSync(sync, flags, 0);
            if (status === gl.WAIT_FAILED) {
                reject(new Error('[WebGLRenderer] readBufferAsync: clientWaitSync returned WAIT_FAILED.'));
                return;
            }
            if (status === gl.TIMEOUT_EXPIRED) {
                if (polls >= maxPolls) {
                    reject(
                        new Error(
                            `[WebGLRenderer] readBufferAsync: fence not signalled after ${polls} polls ` +
                                `(TIMEOUT_EXPIRED). The GPU never completed the copy — this is the single-threaded ` +
                                `busy-loop failure mode; readback must yield across event-loop ticks.`,
                        ),
                    );
                    return;
                }
                polls++;
                // Yield a tick so the GL backend can make progress, then re-poll (no flush bit needed now).
                setTimeout(() => poll(0), 0);
                return;
            }
            // CONDITION_SATISFIED or ALREADY_SIGNALED → done.
            resolve();
        };
        poll(gl.SYNC_FLUSH_COMMANDS_BIT);
    });
}

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
export async function readBufferAsync(
    gl: WebGL2RenderingContext,
    state: TransformFeedbackState,
    buffer: GpuBuffer,
): Promise<Float32Array | Int32Array | Uint32Array> {
    const src = state.buffers.get(buffer)?.glBuffer ?? null;
    if (!src) {
        throw new Error(
            '[WebGLRenderer] readBufferAsync: no GL buffer backs this GpuBuffer — it was never used by a ' +
                'transformFeedback() call (nothing to read back).',
        );
    }

    // Result typed array sized to the buffer's element count × components, typed by the schema.
    const ArrayCtor = typedArrayCtorOf(buffer.schema);
    const length = buffer.count * buffer.itemSize;
    const dst = new ArrayCtor(length);
    const byteLength = dst.byteLength;

    // Copy source → a fresh STREAM_READ staging buffer (reading back from a buffer bound to a TF
    // binding point is illegal, and staging keeps the source untouched for continued ping-pong).
    const staging = gl.createBuffer();
    if (!staging) throw new Error('[WebGLRenderer] readBufferAsync: gl.createBuffer returned null (staging).');

    gl.bindBuffer(gl.COPY_READ_BUFFER, src);
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, staging);
    gl.bufferData(gl.COPY_WRITE_BUFFER, byteLength, gl.STREAM_READ);
    gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, 0, 0, byteLength);

    // Fence the copy, flush, then poll to completion across ticks (the load-bearing detail).
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) throw new Error('[WebGLRenderer] readBufferAsync: gl.fenceSync returned null.');
    gl.flush();
    try {
        await clientWaitAsync(gl, sync);
    } finally {
        gl.deleteSync(sync);
    }

    // Pull the staged bytes back into the typed array.
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, staging);
    gl.getBufferSubData(gl.COPY_WRITE_BUFFER, 0, dst);

    // Tear down: staging buffer + all copy bindings.
    gl.deleteBuffer(staging);
    gl.bindBuffer(gl.COPY_READ_BUFFER, null);
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);

    return dst;
}

/** Release all GL resources owned by the transform-feedback state (called on renderer dispose). */
export function disposeTransformFeedback(gl: WebGL2RenderingContext, state: TransformFeedbackState): void {
    for (const program of state.allPrograms) gl.deleteProgram(program);
    for (const vao of state.allVaos) gl.deleteVertexArray(vao);
    for (const buf of state.allBuffers) gl.deleteBuffer(buf);
    if (state.tf) gl.deleteTransformFeedback(state.tf);
    state.allPrograms.clear();
    state.allVaos.clear();
    state.allBuffers.clear();
    state.tf = null;
    state.nodes = new WeakMap();
    state.buffers = new WeakMap();
}
