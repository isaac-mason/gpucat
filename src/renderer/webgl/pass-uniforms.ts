import { type RendererInfo, recordBufferWrite } from '../core/info';
import type { UniformCapture } from './bindings';
import { bindUniformBuffer, deleteBuffer, type GlState } from './state';

// A shared uniform block resolved once per render scope (a view's) or per frame holds the same bytes for every draw in
// that scope. A pass writes each scope's bytes once into one buffer, given fresh storage per pass (`bufferData`), and
// each draw binds its scope's range: draws ordered across views rebind rather than upload, and no draw reads storage
// written after it was issued. PlayCanvas's per-view uniform buffers, and the rule `draw-bases.ts` keeps.

export type PassUniforms = {
    stream: WebGLBuffer;
    /** `UNIFORM_BUFFER_OFFSET_ALIGNMENT`: where each slot may start */
    align: number;
    /** the pass's slots as they are uploaded, grown as a pass needs */
    bytes: Uint8Array<ArrayBuffer>;
    written: number;
    /** each slot's buffer key and scope, and where it starts */
    keys: object[];
    scopes: number[];
    offsets: number[];
    slotCount: number;
};

export function createPassUniforms(gl: WebGL2RenderingContext): PassUniforms {
    const stream = gl.createBuffer();
    if (!stream) throw new Error('[webgl] gl.createBuffer returned null (pass uniforms).');
    return {
        stream,
        align: gl.getParameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT) as number,
        bytes: new Uint8Array(4096),
        written: 0,
        keys: [],
        scopes: [],
        offsets: [],
        slotCount: 0,
    };
}

export function disposePassUniforms(gl: WebGL2RenderingContext, uniforms: PassUniforms, state: GlState): void {
    deleteBuffer(gl, state, uniforms.stream);
}

/** A pass begins: no slots written. */
export function beginPassUniforms(uniforms: PassUniforms): void {
    uniforms.written = 0;
    uniforms.slotCount = 0;
    uniforms.keys.length = 0;
}

/**
 * `capture`'s slot: the one its block already has for its scope in this pass, or one written with its bytes. A pass's
 * draws arrive in recorded order, which groups a scope's draws, so the last slots are searched first.
 */
export function placeCapture(uniforms: PassUniforms, capture: UniformCapture): void {
    for (let slot = uniforms.slotCount - 1; slot >= 0; slot--) {
        if (uniforms.keys[slot] === capture.key && uniforms.scopes[slot] === capture.scope) {
            capture.slot = uniforms.offsets[slot]!;
            return;
        }
    }
    const start = Math.ceil(uniforms.written / uniforms.align) * uniforms.align;
    const end = start + capture.bytes.byteLength;
    if (end > uniforms.bytes.byteLength) {
        const grown = new Uint8Array(Math.max(end, uniforms.bytes.byteLength * 2));
        grown.set(uniforms.bytes.subarray(0, uniforms.written));
        uniforms.bytes = grown;
    }
    uniforms.bytes.set(capture.bytes, start);
    uniforms.written = end;
    const slot = uniforms.slotCount++;
    uniforms.keys[slot] = capture.key;
    uniforms.scopes[slot] = capture.scope;
    uniforms.offsets[slot] = start;
    capture.slot = start;
}

/** Uploads the pass's slots, ahead of its draws, into fresh storage. Nothing when the pass wrote none. */
export function uploadPassUniforms(gl: WebGL2RenderingContext, uniforms: PassUniforms, info: RendererInfo): void {
    if (uniforms.written === 0) return;
    gl.bindBuffer(gl.UNIFORM_BUFFER, uniforms.stream);
    gl.bufferData(gl.UNIFORM_BUFFER, uniforms.bytes, gl.STREAM_DRAW, 0, uniforms.written);
    recordBufferWrite(info, uniforms.written, 'uniform', true, 'pass-uniforms');
}

/** Binds `capture`'s slot to its binding point. */
export function bindCaptureSlot(
    gl: WebGL2RenderingContext,
    uniforms: PassUniforms,
    state: GlState,
    capture: UniformCapture,
): void {
    bindUniformBuffer(gl, state, capture.bindingPoint, uniforms.stream, capture.slot, capture.block.totalBytes);
}
