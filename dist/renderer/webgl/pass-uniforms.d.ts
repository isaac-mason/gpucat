import { type RendererInfo } from '../core/info';
import type { UniformCapture } from './bindings';
import { type GlState } from './state';
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
export declare function createPassUniforms(gl: WebGL2RenderingContext): PassUniforms;
export declare function disposePassUniforms(gl: WebGL2RenderingContext, uniforms: PassUniforms, state: GlState): void;
/** A pass begins: no slots written. */
export declare function beginPassUniforms(uniforms: PassUniforms): void;
/**
 * `capture`'s slot: the one its block already has for its scope in this pass, or one written with its bytes. A pass's
 * draws arrive in recorded order, which groups a scope's draws, so the last slots are searched first.
 */
export declare function placeCapture(uniforms: PassUniforms, capture: UniformCapture): void;
/** Uploads the pass's slots, ahead of its draws, into fresh storage. Nothing when the pass wrote none. */
export declare function uploadPassUniforms(gl: WebGL2RenderingContext, uniforms: PassUniforms, info: RendererInfo): void;
/** Binds `capture`'s slot to its binding point. */
export declare function bindCaptureSlot(gl: WebGL2RenderingContext, uniforms: PassUniforms, state: GlState, capture: UniformCapture): void;
