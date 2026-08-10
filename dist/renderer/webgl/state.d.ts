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
 * Establish the known GL global-state baseline the fresh per-pass `GlStateCache` assumes, called once
 * at the top of each pass's draw section (before the draw loop). This is the WebGL2 backend's tight
 * analogue of three.js `WebGLState.reset()`: the draw loop rebuilds most state per draw (a fresh cache
 * forces `applyMaterialState` to write every field on the first object, and `applyViewportScissor`
 * re-establishes scissor + depthRange every pass), so the ONLY states that need an explicit baseline
 * are the globals `applyMaterialState` does NOT set on every draw and could therefore inherit from a
 * prior pass, a manual clear, or the transform-feedback path:
 *
 *  - `frontFace(CCW)`      — `setCullState` sets winding only inside the cull-ENABLED branch, so a pass
 *                            of only `cullMode:'none'` materials would keep a stale winding. gpucat is
 *                            uniformly CCW; pin it.
 *  - `stencilMask(0xff)`   — `setStencilState` sets the write mask only inside the stencil-ENABLED
 *                            branch, so a `stencilTest:false` pass would inherit whatever mask a prior
 *                            stencil pass / stencil clear left. 0xff matches the stencil-clear mask.
 *  - `disable(RASTERIZER_DISCARD)` — the render draw loop assumes rasterization is on; transform
 *                            feedback is the only path that enables discard. Insurance so a stray
 *                            enabled discard can't silently blank a render pass.
 *
 * Deliberately does NOT touch depth/cull-enable/blend/colorMask/alphaToCoverage/scissor/depthRange:
 * those are already re-established every pass, so re-setting them here would be redundant and could
 * fight the first draw's material state.
 */
export declare function establishPassBaseline(gl: WebGL2RenderingContext): void;
/**
 * Apply the whole fixed-function GL state for a material in one call: depth, cull, blend, color mask,
 * and (when the framebuffer supports it) stencil. Redundant sub-states are skipped via `cache`.
 */
export declare function applyMaterialState(gl: WebGL2RenderingContext, cache: GlStateCache, material: Material, hasStencil: boolean): void;
