/**
 * state.ts (webgl) - GL pipeline-state helpers, driven by gpucat material fields.
 *
 * These are the immediate-mode equivalents of a WebGPU pipeline's fixed-function state: depth
 * test/write/compare, face culling, blending, and stencil. WebGPU bakes this into the pipeline
 * object; WebGL2 sets it live on the context before each draw. The mechanics are ported from the
 * reference renderer's `setDepthTest`/`setDepthMask`/`setCullSide`/`setBlending`, adapted to read
 * gpucat's `Material` fields (which use the WebGPU vocabulary: `depthCompare`, `cullMode`, `blend`,
 * `stencilFunc`, `stencilFail`, …) rather than the reference's own enums.
 *
 * A small `GlStateCache` tracks the last-applied values so redundant `gl.enable`/`gl.depthFunc`/…
 * calls are skipped across the draw loop (the WebGPU path gets this for free from pipeline dedup).
 */
import type { Material } from '../../material/material';
/**
 * Last-applied GL fixed-function state, so the draw loop can skip redundant calls. Reset at the
 * start of each pass (the GL context state is not assumed to carry across passes).
 */
export type GlStateCache = {
    depthTest: boolean | null;
    depthWrite: boolean | null;
    depthCompare: GPUCompareFunction | null;
    cullMode: GPUCullMode | null;
    blendKey: string | null;
    colorWrite: boolean | null;
    stencilKey: string | null;
    stencilRef: number | null;
    /** Whether POLYGON_OFFSET_FILL is enabled + the last (slopeScale, units) applied. */
    polygonOffset: boolean | null;
    polygonOffsetFactor: number | null;
    polygonOffsetUnits: number | null;
    /** Whether SAMPLE_ALPHA_TO_COVERAGE is enabled. */
    alphaToCoverage: boolean | null;
};
/** Create a fresh (all-unknown) GL state cache. */
export declare function createGlStateCache(): GlStateCache;
/**
 * Apply the whole fixed-function GL state for a material in one call: depth, cull, blend, color mask,
 * and (when the framebuffer supports it) stencil. Redundant sub-states are skipped via `cache`.
 */
export declare function applyMaterialState(gl: WebGL2RenderingContext, cache: GlStateCache, material: Material, hasStencil: boolean): void;
