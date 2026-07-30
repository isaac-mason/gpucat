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
import {
    compileTransformFeedback,
    type TransformFeedbackGlslResult,
} from '../../nodes/builder';
import type { TransformFeedbackNode } from '../../nodes/lib/transform-feedback';
import { attribFormat, glComponentType } from './geometries';
import { createTransformFeedbackProgram } from './programs';
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
            // STATIC_READ for outputs (read back after write), STATIC_DRAW for inputs (fed as attributes).
            gl.bufferData(gl.ARRAY_BUFFER, array, role === 'output' ? gl.STATIC_READ : gl.STATIC_DRAW);
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

    // Uniform-block / texture binding for standalone TF kernels needs bind-group construction (the
    // std140 UBO path and combined-sampler path are RenderObject/BindGroup-driven). That wiring is
    // deferred (Phase 4); reject rather than run a kernel with unbound uniforms/textures (→ garbage).
    if (compiled.uniformGroups.some((g) => g.members.length > 0)) {
        throw new Error(
            '[WebGLRenderer] transform-feedback kernels using uniform() are not supported yet ' +
                '(uniform-block binding for standalone kernels is a later phase).',
        );
    }
    if (compiled.textures.length > 0) {
        throw new Error(
            '[WebGLRenderer] transform-feedback kernels using textureLoad() are not supported yet ' +
                '(data-texture binding for standalone kernels is a later phase).',
        );
    }

    // Validate every declared input/output has a buffer.
    for (const attr of compiled.inputAttributes) {
        // Attribute shader name is `a_<name>`; the run-site key is the bare `<name>`.
        const key = attr.name.startsWith('a_') ? attr.name.slice(2) : attr.name;
        if (!inputs[key]) {
            throw new Error(`[WebGLRenderer] transform-feedback kernel input '${key}' has no bound buffer.`);
        }
    }

    gl.useProgram(programInfo.program);

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
