/**
 * state.ts (webgl) - GL pipeline-state helpers, driven by gpucat material fields.
 *
 * These are the immediate-mode equivalents of a WebGPU pipeline's fixed-function state: depth
 * test/write/compare, face culling, blending, and stencil. WebGPU bakes this into the pipeline
 * object; WebGL2 sets it live on the context before each draw. These read `Material`'s fields
 * directly, and those fields are WebGPU vocabulary (`depthCompare`, `cullMode`, `blend`,
 * `stencilFunc`, `stencilFail`), so there is no second enum set to translate through.
 *
 * `GlState` records what the context holds, field by field, for the context's life, as three.js's `WebGLState`,
 * PlayCanvas's and Babylon's devices keep theirs: a call that would set what is set is skipped. Every state call gpucat
 * makes goes through it (draws, clears, rects, the probe, transform feedback); `resetGlState` puts the context back to
 * GL's defaults and the record with it, for after other code has used the context.
 */
import type { Material } from '../../material/material';
/** What the context holds of each fixed-function state; null where it is not known. */
export type GlState = {
    depthTest: boolean | null;
    cullFace: boolean | null;
    blend: boolean | null;
    stencilTest: boolean | null;
    polygonOffsetFill: boolean | null;
    alphaToCoverage: boolean | null;
    scissorTest: boolean | null;
    rasterizerDiscard: boolean | null;
    depthFunc: number | null;
    depthMask: boolean | null;
    colorMask: boolean | null;
    frontFace: number | null;
    cullFaceMode: number | null;
    blendSrcColor: number | null;
    blendDstColor: number | null;
    blendSrcAlpha: number | null;
    blendDstAlpha: number | null;
    blendOpColor: number | null;
    blendOpAlpha: number | null;
    polygonOffsetFactor: number | null;
    polygonOffsetUnits: number | null;
    stencilWriteMask: number | null;
    front: StencilFace;
    back: StencilFace;
    viewportX: number | null;
    viewportY: number | null;
    viewportWidth: number | null;
    viewportHeight: number | null;
    depthNear: number | null;
    depthFar: number | null;
    scissorX: number | null;
    scissorY: number | null;
    scissorWidth: number | null;
    scissorHeight: number | null;
    clearR: number | null;
    clearG: number | null;
    clearB: number | null;
    clearA: number | null;
    clearDepth: number | null;
    clearStencil: number | null;
};
/** One face's stencil test and ops; null where not known. */
type StencilFace = {
    func: number | null;
    ref: number | null;
    readMask: number | null;
    fail: number | null;
    zFail: number | null;
    zPass: number | null;
};
/** A record knowing nothing: every first call sets its state. */
export declare function createGlState(): GlState;
/** Forgets everything `state` records, in place: for when other code may have changed the context. */
export declare function forgetGlState(state: GlState): void;
/** Map a WebGPU blend factor to the GL blend-factor constant. */
export declare function blendFactor(gl: WebGL2RenderingContext, factor: GPUBlendFactor): number;
type Capability = 'depthTest' | 'cullFace' | 'blend' | 'stencilTest' | 'polygonOffsetFill' | 'alphaToCoverage' | 'scissorTest' | 'rasterizerDiscard';
export declare function setCapability(gl: WebGL2RenderingContext, state: GlState, capability: Capability, on: boolean): void;
export declare function setDepthMask(gl: WebGL2RenderingContext, state: GlState, on: boolean): void;
export declare function setColorMask(gl: WebGL2RenderingContext, state: GlState, on: boolean): void;
export declare function setStencilWriteMask(gl: WebGL2RenderingContext, state: GlState, mask: number): void;
export declare function setFrontFace(gl: WebGL2RenderingContext, state: GlState, face: number): void;
export declare function setViewport(gl: WebGL2RenderingContext, state: GlState, x: number, y: number, width: number, height: number): void;
export declare function setDepthRange(gl: WebGL2RenderingContext, state: GlState, near: number, far: number): void;
export declare function setScissor(gl: WebGL2RenderingContext, state: GlState, x: number, y: number, width: number, height: number): void;
export declare function setClearColor(gl: WebGL2RenderingContext, state: GlState, r: number, g: number, b: number, a: number): void;
export declare function setClearDepth(gl: WebGL2RenderingContext, state: GlState, depth: number): void;
export declare function setClearStencil(gl: WebGL2RenderingContext, state: GlState, value: number): void;
export declare function setDepthFunc(gl: WebGL2RenderingContext, state: GlState, func: number): void;
/**
 * Apply the whole fixed-function GL state for a material in one call: depth, cull, blend, color mask,
 * and (when the framebuffer supports it) stencil. Each state is set only where the context differs.
 *
 * `blend` is the pass's already-resolved blend state (see `core/render-state`), passed in rather than
 * derived here because resolving it needs the pass's MRT context, which is not on the material.
 */
export declare function applyMaterialState(gl: WebGL2RenderingContext, state: GlState, material: Material, hasStencil: boolean, blend: GPUBlendState | undefined): void;
/**
 * Puts the context back to GL's defaults for every state gpucat sets, and the record with it: for after other code has
 * drawn with the context, as three.js's `resetState` does. Reading the context's state back instead would stall it.
 */
export declare function resetGlState(gl: WebGL2RenderingContext, state: GlState, width: number, height: number): void;
export {};
