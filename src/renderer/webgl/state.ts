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
export function createGlStateCache(): GlStateCache {
    return {
        depthTest: null,
        depthWrite: null,
        depthCompare: null,
        cullMode: null,
        blendKey: null,
        colorWrite: null,
        stencilKey: null,
        stencilRef: null,
        polygonOffset: null,
        polygonOffsetFactor: null,
        polygonOffsetUnits: null,
        alphaToCoverage: null,
    };
}

// -------------------------------------------------------------------------------------------------
// Enum → GL constant maps. Keyed by the WebGPU-vocabulary strings gpucat's Material uses.
// -------------------------------------------------------------------------------------------------

/** Map a WebGPU compare function to a GL depth/stencil func constant. */
function compareFunc(gl: WebGL2RenderingContext, compare: GPUCompareFunction): number {
    switch (compare) {
        case 'never':
            return gl.NEVER;
        case 'less':
            return gl.LESS;
        case 'equal':
            return gl.EQUAL;
        case 'less-equal':
            return gl.LEQUAL;
        case 'greater':
            return gl.GREATER;
        case 'not-equal':
            return gl.NOTEQUAL;
        case 'greater-equal':
            return gl.GEQUAL;
        default:
            return gl.ALWAYS;
    }
}

/** Map a WebGPU blend factor to the GL blend-factor constant. */
function blendFactor(gl: WebGL2RenderingContext, factor: GPUBlendFactor): number {
    switch (factor) {
        case 'zero':
            return gl.ZERO;
        case 'one':
            return gl.ONE;
        case 'src':
            return gl.SRC_COLOR;
        case 'one-minus-src':
            return gl.ONE_MINUS_SRC_COLOR;
        case 'src-alpha':
            return gl.SRC_ALPHA;
        case 'one-minus-src-alpha':
            return gl.ONE_MINUS_SRC_ALPHA;
        case 'dst':
            return gl.DST_COLOR;
        case 'one-minus-dst':
            return gl.ONE_MINUS_DST_COLOR;
        case 'dst-alpha':
            return gl.DST_ALPHA;
        case 'one-minus-dst-alpha':
            return gl.ONE_MINUS_DST_ALPHA;
        case 'src-alpha-saturated':
            return gl.SRC_ALPHA_SATURATE;
        // 'constant' / 'one-minus-constant' map to GL_CONSTANT_COLOR / GL_ONE_MINUS_CONSTANT_COLOR,
        // which read the blend constant set by gl.blendColor(). gpucat's Material/GPUBlendState models
        // no blend-constant value (WebGPU's setBlendConstant is never called), so there is nothing to
        // feed gl.blendColor — a constant-factor blend would silently blend against (0,0,0,0). Fail
        // loud instead of blending against black.
        case 'constant':
        case 'one-minus-constant':
            throw new Error(
                `[WebGLRenderer] blend factor '${factor}' is not supported on WebGL2: gpucat does not ` +
                    `model a blend constant (no setBlendConstant equivalent), so gl.blendColor cannot be set.`,
            );
        default:
            return gl.ONE;
    }
}

/** Map a WebGPU blend operation to the GL blend-equation constant. */
function blendOp(gl: WebGL2RenderingContext, op: GPUBlendOperation): number {
    switch (op) {
        case 'subtract':
            return gl.FUNC_SUBTRACT;
        case 'reverse-subtract':
            return gl.FUNC_REVERSE_SUBTRACT;
        case 'min':
            return gl.MIN;
        case 'max':
            return gl.MAX;
        default:
            return gl.FUNC_ADD;
    }
}

/** Map a WebGPU stencil operation to the GL stencil-op constant. */
function stencilOp(gl: WebGL2RenderingContext, op: GPUStencilOperation): number {
    switch (op) {
        case 'zero':
            return gl.ZERO;
        case 'replace':
            return gl.REPLACE;
        case 'invert':
            return gl.INVERT;
        case 'increment-clamp':
            return gl.INCR;
        case 'decrement-clamp':
            return gl.DECR;
        case 'increment-wrap':
            return gl.INCR_WRAP;
        case 'decrement-wrap':
            return gl.DECR_WRAP;
        default:
            return gl.KEEP;
    }
}

// -------------------------------------------------------------------------------------------------
// State setters.
// -------------------------------------------------------------------------------------------------

/**
 * Apply depth test + compare. WebGL2 folds "no test" into disabling `DEPTH_TEST`; when the material
 * has `depthTest=false` we mirror WebGPU by keeping the buffer enabled with `depthFunc=ALWAYS` (so
 * depth still writes if `depthWrite` is on).
 */
function setDepthState(gl: WebGL2RenderingContext, cache: GlStateCache, material: Material): void {
    // WebGPU semantics: depthTest=false ⇒ compare 'always' (still writes). Depth is a per-pixel test;
    // the depth *buffer* stays enabled so writes happen. We therefore always enable DEPTH_TEST and
    // drive behaviour purely through depthFunc + depthMask.
    const compare: GPUCompareFunction = material.depthTest ? material.depthCompare : 'always';

    if (cache.depthTest !== true) {
        gl.enable(gl.DEPTH_TEST);
        cache.depthTest = true;
    }
    if (cache.depthCompare !== compare) {
        gl.depthFunc(compareFunc(gl, compare));
        cache.depthCompare = compare;
    }
    if (cache.depthWrite !== material.depthWrite) {
        gl.depthMask(material.depthWrite);
        cache.depthWrite = material.depthWrite;
    }
}

/** Apply face culling from `material.cullMode` ('none' | 'front' | 'back'). Front face is CCW. */
function setCullState(gl: WebGL2RenderingContext, cache: GlStateCache, material: Material): void {
    const mode = material.cullMode;
    if (cache.cullMode === mode) return;
    cache.cullMode = mode;

    if (mode === 'none' || mode === undefined) {
        gl.disable(gl.CULL_FACE);
        return;
    }
    gl.enable(gl.CULL_FACE);
    gl.frontFace(gl.CCW);
    gl.cullFace(mode === 'front' ? gl.FRONT : gl.BACK);
}

/**
 * Apply blending. gpucat blends only when `material.transparent` and a `material.blend` state is set
 * (matching how the WebGPU pipeline attaches a blend state). Otherwise blending is disabled.
 */
function setBlendState(gl: WebGL2RenderingContext, cache: GlStateCache, material: Material): void {
    const blend = material.transparent ? material.blend : undefined;
    const key = blend ? JSON.stringify(blend) : 'none';
    if (cache.blendKey === key) return;
    cache.blendKey = key;

    if (!blend) {
        gl.disable(gl.BLEND);
        return;
    }
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(
        blendFactor(gl, blend.color.srcFactor ?? 'one'),
        blendFactor(gl, blend.color.dstFactor ?? 'zero'),
        blendFactor(gl, blend.alpha.srcFactor ?? 'one'),
        blendFactor(gl, blend.alpha.dstFactor ?? 'zero'),
    );
    gl.blendEquationSeparate(blendOp(gl, blend.color.operation ?? 'add'), blendOp(gl, blend.alpha.operation ?? 'add'));
}

/**
 * Apply polygon offset (depth bias) from `material.depthBias` / `material.depthBiasSlopeScale`.
 * WebGL's `gl.polygonOffset(factor, units)` maps to WebGPU's (depthBiasSlopeScale, depthBias): factor
 * scales the fragment's depth slope, units is the constant bias. `depthBiasClamp` has no WebGL2
 * equivalent (there is no way to clamp the resulting offset) so it is ignored.
 */
function setDepthBiasState(gl: WebGL2RenderingContext, cache: GlStateCache, material: Material): void {
    const factor = material.depthBiasSlopeScale;
    const units = material.depthBias;
    const enabled = factor !== 0 || units !== 0;

    if (cache.polygonOffset !== enabled) {
        if (enabled) gl.enable(gl.POLYGON_OFFSET_FILL);
        else gl.disable(gl.POLYGON_OFFSET_FILL);
        cache.polygonOffset = enabled;
    }
    if (enabled && (cache.polygonOffsetFactor !== factor || cache.polygonOffsetUnits !== units)) {
        gl.polygonOffset(factor, units);
        cache.polygonOffsetFactor = factor;
        cache.polygonOffsetUnits = units;
    }
}

/**
 * Apply alpha-to-coverage from `material.alphaToCoverage`. Only has effect on a multisampled
 * framebuffer; enabling it on a non-MSAA target is a harmless no-op, so it is gated purely on the
 * material flag (mirroring WebGPU's `alphaToCoverageEnabled`).
 */
function setAlphaToCoverageState(gl: WebGL2RenderingContext, cache: GlStateCache, material: Material): void {
    if (cache.alphaToCoverage === material.alphaToCoverage) return;
    cache.alphaToCoverage = material.alphaToCoverage;
    if (material.alphaToCoverage) gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    else gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
}

/** Apply the color write mask from `material.colorWrite`. */
function setColorWriteState(gl: WebGL2RenderingContext, cache: GlStateCache, material: Material): void {
    if (cache.colorWrite === material.colorWrite) return;
    cache.colorWrite = material.colorWrite;
    const w = material.colorWrite;
    gl.colorMask(w, w, w, w);
}

/**
 * Apply stencil test + ops. Only meaningful when the framebuffer has a stencil attachment
 * (`hasStencil`) and the material opts in via `stencilTest`. Otherwise the stencil test is disabled.
 * WebGPU carries a dynamic stencil reference (set via setStencilReference); here it folds into
 * `gl.stencilFunc`.
 */
function setStencilState(gl: WebGL2RenderingContext, cache: GlStateCache, material: Material, hasStencil: boolean): void {
    const enabled = hasStencil && material.stencilTest;
    const key = enabled
        ? [
              material.stencilFunc,
              material.stencilRef,
              material.stencilReadMask,
              material.stencilWriteMask,
              material.stencilFail,
              material.stencilZFail,
              material.stencilZPass,
              material.stencilBack ? JSON.stringify(material.stencilBack) : 'front',
          ].join('|')
        : 'off';

    if (cache.stencilKey === key && cache.stencilRef === material.stencilRef) return;
    cache.stencilKey = key;
    cache.stencilRef = material.stencilRef;

    if (!enabled) {
        gl.disable(gl.STENCIL_TEST);
        return;
    }

    gl.enable(gl.STENCIL_TEST);
    gl.stencilMask(material.stencilWriteMask);

    // Front face.
    gl.stencilFuncSeparate(gl.FRONT, compareFunc(gl, material.stencilFunc), material.stencilRef, material.stencilReadMask);
    gl.stencilOpSeparate(
        gl.FRONT,
        stencilOp(gl, material.stencilFail),
        stencilOp(gl, material.stencilZFail),
        stencilOp(gl, material.stencilZPass),
    );

    // Back face (defaults to front-face ops unless overridden).
    const back = material.stencilBack;
    gl.stencilFuncSeparate(
        gl.BACK,
        compareFunc(gl, back?.func ?? material.stencilFunc),
        material.stencilRef,
        material.stencilReadMask,
    );
    gl.stencilOpSeparate(
        gl.BACK,
        stencilOp(gl, back?.fail ?? material.stencilFail),
        stencilOp(gl, back?.zFail ?? material.stencilZFail),
        stencilOp(gl, back?.zPass ?? material.stencilZPass),
    );
}

/**
 * Apply the whole fixed-function GL state for a material in one call: depth, cull, blend, color mask,
 * and (when the framebuffer supports it) stencil. Redundant sub-states are skipped via `cache`.
 */
export function applyMaterialState(
    gl: WebGL2RenderingContext,
    cache: GlStateCache,
    material: Material,
    hasStencil: boolean,
): void {
    setDepthState(gl, cache, material);
    setDepthBiasState(gl, cache, material);
    setCullState(gl, cache, material);
    setBlendState(gl, cache, material);
    setAlphaToCoverageState(gl, cache, material);
    setColorWriteState(gl, cache, material);
    setStencilState(gl, cache, material, hasStencil);
}
