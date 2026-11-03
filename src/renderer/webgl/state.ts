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

function unknownFace(): StencilFace {
    return { func: null, ref: null, readMask: null, fail: null, zFail: null, zPass: null };
}

/** A record knowing nothing: every first call sets its state. */
export function createGlState(): GlState {
    return {
        depthTest: null,
        cullFace: null,
        blend: null,
        stencilTest: null,
        polygonOffsetFill: null,
        alphaToCoverage: null,
        scissorTest: null,
        rasterizerDiscard: null,
        depthFunc: null,
        depthMask: null,
        colorMask: null,
        frontFace: null,
        cullFaceMode: null,
        blendSrcColor: null,
        blendDstColor: null,
        blendSrcAlpha: null,
        blendDstAlpha: null,
        blendOpColor: null,
        blendOpAlpha: null,
        polygonOffsetFactor: null,
        polygonOffsetUnits: null,
        stencilWriteMask: null,
        front: unknownFace(),
        back: unknownFace(),
        viewportX: null,
        viewportY: null,
        viewportWidth: null,
        viewportHeight: null,
        depthNear: null,
        depthFar: null,
        scissorX: null,
        scissorY: null,
        scissorWidth: null,
        scissorHeight: null,
        clearR: null,
        clearG: null,
        clearB: null,
        clearA: null,
        clearDepth: null,
        clearStencil: null,
    };
}

/** Forgets everything `state` records, in place: for when other code may have changed the context. */
export function forgetGlState(state: GlState): void {
    Object.assign(state, createGlState());
}

// Enum → GL constant maps. Keyed by the WebGPU-vocabulary strings gpucat's Material uses.

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
        case 'always':
            return gl.ALWAYS;
        default: {
            const unhandled: never = compare;
            throw new Error(`[webgl] unhandled '${unhandled}'.`);
        }
    }
}

/** Map a WebGPU blend factor to the GL blend-factor constant. */
export function blendFactor(gl: WebGL2RenderingContext, factor: GPUBlendFactor): number {
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
                `[webgl] blend factor '${factor}' is not supported on WebGL2: gpucat does not ` +
                    `model a blend constant (no setBlendConstant equivalent), so gl.blendColor cannot be set.`,
            );
        // Dual-source blending is a WebGPU feature with no WebGL2 equivalent at all, so these cannot be
        // approximated the way a missing format sometimes can.
        case 'src1':
        case 'one-minus-src1':
        case 'src1-alpha':
        case 'one-minus-src1-alpha':
            throw new Error(`[webgl] blend factor '${factor}' needs dual-source blending, which WebGL2 does not have.`);
        default: {
            const unhandled: never = factor;
            throw new Error(`[webgl] unknown blend factor '${unhandled}'.`);
        }
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
        case 'add':
            return gl.FUNC_ADD;
        default: {
            const unhandled: never = op;
            throw new Error(`[webgl] unhandled '${unhandled}'.`);
        }
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
        case 'keep':
            return gl.KEEP;
        default: {
            const unhandled: never = op;
            throw new Error(`[webgl] unhandled '${unhandled}'.`);
        }
    }
}

// State setters: each sets its state on the context only where it differs from the record.

type Capability =
    | 'depthTest'
    | 'cullFace'
    | 'blend'
    | 'stencilTest'
    | 'polygonOffsetFill'
    | 'alphaToCoverage'
    | 'scissorTest'
    | 'rasterizerDiscard';

function capabilityEnum(gl: WebGL2RenderingContext, capability: Capability): number {
    switch (capability) {
        case 'depthTest':
            return gl.DEPTH_TEST;
        case 'cullFace':
            return gl.CULL_FACE;
        case 'blend':
            return gl.BLEND;
        case 'stencilTest':
            return gl.STENCIL_TEST;
        case 'polygonOffsetFill':
            return gl.POLYGON_OFFSET_FILL;
        case 'alphaToCoverage':
            return gl.SAMPLE_ALPHA_TO_COVERAGE;
        case 'scissorTest':
            return gl.SCISSOR_TEST;
        case 'rasterizerDiscard':
            return gl.RASTERIZER_DISCARD;
    }
}

export function setCapability(gl: WebGL2RenderingContext, state: GlState, capability: Capability, on: boolean): void {
    if (state[capability] === on) return;
    if (on) gl.enable(capabilityEnum(gl, capability));
    else gl.disable(capabilityEnum(gl, capability));
    state[capability] = on;
}

export function setDepthMask(gl: WebGL2RenderingContext, state: GlState, on: boolean): void {
    if (state.depthMask === on) return;
    gl.depthMask(on);
    state.depthMask = on;
}

export function setColorMask(gl: WebGL2RenderingContext, state: GlState, on: boolean): void {
    if (state.colorMask === on) return;
    gl.colorMask(on, on, on, on);
    state.colorMask = on;
}

export function setStencilWriteMask(gl: WebGL2RenderingContext, state: GlState, mask: number): void {
    if (state.stencilWriteMask === mask) return;
    gl.stencilMask(mask);
    state.stencilWriteMask = mask;
}

export function setFrontFace(gl: WebGL2RenderingContext, state: GlState, face: number): void {
    if (state.frontFace === face) return;
    gl.frontFace(face);
    state.frontFace = face;
}

export function setViewport(
    gl: WebGL2RenderingContext,
    state: GlState,
    x: number,
    y: number,
    width: number,
    height: number,
): void {
    if (state.viewportX === x && state.viewportY === y && state.viewportWidth === width && state.viewportHeight === height)
        return;
    gl.viewport(x, y, width, height);
    state.viewportX = x;
    state.viewportY = y;
    state.viewportWidth = width;
    state.viewportHeight = height;
}

export function setDepthRange(gl: WebGL2RenderingContext, state: GlState, near: number, far: number): void {
    if (state.depthNear === near && state.depthFar === far) return;
    gl.depthRange(near, far);
    state.depthNear = near;
    state.depthFar = far;
}

export function setScissor(
    gl: WebGL2RenderingContext,
    state: GlState,
    x: number,
    y: number,
    width: number,
    height: number,
): void {
    if (state.scissorX === x && state.scissorY === y && state.scissorWidth === width && state.scissorHeight === height) return;
    gl.scissor(x, y, width, height);
    state.scissorX = x;
    state.scissorY = y;
    state.scissorWidth = width;
    state.scissorHeight = height;
}

export function setClearColor(gl: WebGL2RenderingContext, state: GlState, r: number, g: number, b: number, a: number): void {
    if (state.clearR === r && state.clearG === g && state.clearB === b && state.clearA === a) return;
    gl.clearColor(r, g, b, a);
    state.clearR = r;
    state.clearG = g;
    state.clearB = b;
    state.clearA = a;
}

export function setClearDepth(gl: WebGL2RenderingContext, state: GlState, depth: number): void {
    if (state.clearDepth === depth) return;
    gl.clearDepth(depth);
    state.clearDepth = depth;
}

export function setClearStencil(gl: WebGL2RenderingContext, state: GlState, value: number): void {
    if (state.clearStencil === value) return;
    gl.clearStencil(value);
    state.clearStencil = value;
}

export function setDepthFunc(gl: WebGL2RenderingContext, state: GlState, func: number): void {
    if (state.depthFunc === func) return;
    gl.depthFunc(func);
    state.depthFunc = func;
}

/**
 * Apply depth test + compare. WebGL2 folds "no test" into disabling `DEPTH_TEST`; when the material
 * has `depthTest=false` we mirror WebGPU by keeping the buffer enabled with `depthFunc=ALWAYS` (so
 * depth still writes if `depthWrite` is on).
 */
function setDepthState(gl: WebGL2RenderingContext, state: GlState, material: Material): void {
    // WebGPU semantics: depthTest=false ⇒ compare 'always' (still writes). Depth is a per-pixel test;
    // the depth *buffer* stays enabled so writes happen. We therefore always enable DEPTH_TEST and
    // drive behaviour purely through depthFunc + depthMask.
    setCapability(gl, state, 'depthTest', true);
    setDepthFunc(gl, state, compareFunc(gl, material.depthTest ? material.depthCompare : 'always'));
    setDepthMask(gl, state, material.depthWrite);
}

/** Apply face culling from `material.cullMode` ('none' | 'front' | 'back'). Front face is CCW. */
function setCullState(gl: WebGL2RenderingContext, state: GlState, material: Material): void {
    const mode = material.cullMode;
    // gpucat's winding is CCW everywhere, culled or not
    setFrontFace(gl, state, gl.CCW);
    if (mode === 'none' || mode === undefined) {
        setCapability(gl, state, 'cullFace', false);
        return;
    }
    setCapability(gl, state, 'cullFace', true);
    const face = mode === 'front' ? gl.FRONT : gl.BACK;
    if (state.cullFaceMode !== face) {
        gl.cullFace(face);
        state.cullFaceMode = face;
    }
}

/**
 * Apply an already-resolved blend state. WHICH blend a material gets is decided by
 * `core/render-state`, shared with the WebGPU pipeline so the two backends cannot disagree about what
 * `transparent` means; this function only translates the result into GL calls. `undefined` is
 * no-blend.
 */
function setBlendState(gl: WebGL2RenderingContext, state: GlState, blend: GPUBlendState | undefined): void {
    if (!blend) {
        setCapability(gl, state, 'blend', false);
        return;
    }
    setCapability(gl, state, 'blend', true);
    const srcColor = blendFactor(gl, blend.color.srcFactor ?? 'one');
    const dstColor = blendFactor(gl, blend.color.dstFactor ?? 'zero');
    const srcAlpha = blendFactor(gl, blend.alpha.srcFactor ?? 'one');
    const dstAlpha = blendFactor(gl, blend.alpha.dstFactor ?? 'zero');
    if (
        state.blendSrcColor !== srcColor ||
        state.blendDstColor !== dstColor ||
        state.blendSrcAlpha !== srcAlpha ||
        state.blendDstAlpha !== dstAlpha
    ) {
        gl.blendFuncSeparate(srcColor, dstColor, srcAlpha, dstAlpha);
        state.blendSrcColor = srcColor;
        state.blendDstColor = dstColor;
        state.blendSrcAlpha = srcAlpha;
        state.blendDstAlpha = dstAlpha;
    }
    const opColor = blendOp(gl, blend.color.operation ?? 'add');
    const opAlpha = blendOp(gl, blend.alpha.operation ?? 'add');
    if (state.blendOpColor !== opColor || state.blendOpAlpha !== opAlpha) {
        gl.blendEquationSeparate(opColor, opAlpha);
        state.blendOpColor = opColor;
        state.blendOpAlpha = opAlpha;
    }
}

/**
 * Apply polygon offset (depth bias) from `material.depthBias` / `material.depthBiasSlopeScale`.
 * WebGL's `gl.polygonOffset(factor, units)` maps to WebGPU's (depthBiasSlopeScale, depthBias): factor
 * scales the fragment's depth slope, units is the constant bias.
 */
function setDepthBiasState(gl: WebGL2RenderingContext, state: GlState, material: Material): void {
    const factor = material.depthBiasSlopeScale;
    const units = material.depthBias;
    const enabled = factor !== 0 || units !== 0;
    setCapability(gl, state, 'polygonOffsetFill', enabled);
    if (enabled && (state.polygonOffsetFactor !== factor || state.polygonOffsetUnits !== units)) {
        gl.polygonOffset(factor, units);
        state.polygonOffsetFactor = factor;
        state.polygonOffsetUnits = units;
    }
}

/** Sets one face's stencil test and ops, each call only where it differs. */
function setStencilFace(
    gl: WebGL2RenderingContext,
    face: StencilFace,
    glFace: number,
    func: number,
    ref: number,
    readMask: number,
    fail: number,
    zFail: number,
    zPass: number,
): void {
    if (face.func !== func || face.ref !== ref || face.readMask !== readMask) {
        gl.stencilFuncSeparate(glFace, func, ref, readMask);
        face.func = func;
        face.ref = ref;
        face.readMask = readMask;
    }
    if (face.fail !== fail || face.zFail !== zFail || face.zPass !== zPass) {
        gl.stencilOpSeparate(glFace, fail, zFail, zPass);
        face.fail = fail;
        face.zFail = zFail;
        face.zPass = zPass;
    }
}

/**
 * Apply stencil test + ops. Only meaningful when the framebuffer has a stencil attachment
 * (`hasStencil`) and the material opts in via `stencilTest`. Otherwise the stencil test is disabled.
 * WebGPU carries a dynamic stencil reference (set via setStencilReference); here it folds into
 * `gl.stencilFunc`.
 */
function setStencilState(gl: WebGL2RenderingContext, state: GlState, material: Material, hasStencil: boolean): void {
    if (!hasStencil || !material.stencilTest) {
        setCapability(gl, state, 'stencilTest', false);
        return;
    }
    setCapability(gl, state, 'stencilTest', true);
    setStencilWriteMask(gl, state, material.stencilWriteMask);
    const func = compareFunc(gl, material.stencilFunc);
    const fail = stencilOp(gl, material.stencilFail);
    const zFail = stencilOp(gl, material.stencilZFail);
    const zPass = stencilOp(gl, material.stencilZPass);
    const ref = material.stencilRef;
    const readMask = material.stencilReadMask;
    setStencilFace(gl, state.front, gl.FRONT, func, ref, readMask, fail, zFail, zPass);
    // the back face takes the front's test and ops unless the material sets its own
    const back = material.stencilBack;
    if (back == null) {
        setStencilFace(gl, state.back, gl.BACK, func, ref, readMask, fail, zFail, zPass);
        return;
    }
    setStencilFace(
        gl,
        state.back,
        gl.BACK,
        back.func === undefined ? func : compareFunc(gl, back.func),
        ref,
        readMask,
        back.fail === undefined ? fail : stencilOp(gl, back.fail),
        back.zFail === undefined ? zFail : stencilOp(gl, back.zFail),
        back.zPass === undefined ? zPass : stencilOp(gl, back.zPass),
    );
}

/**
 * Apply the whole fixed-function GL state for a material in one call: depth, cull, blend, color mask,
 * and (when the framebuffer supports it) stencil. Each state is set only where the context differs.
 *
 * `blend` is the pass's already-resolved blend state (see `core/render-state`), passed in rather than
 * derived here because resolving it needs the pass's MRT context, which is not on the material.
 */
export function applyMaterialState(
    gl: WebGL2RenderingContext,
    state: GlState,
    material: Material,
    hasStencil: boolean,
    blend: GPUBlendState | undefined,
): void {
    // Before any GL call: this is a material the backend cannot honour, not a state it failed to set.
    if (material.depthBiasClamp !== 0) {
        throw new Error(
            '[webgl] depthBiasClamp has no WebGL2 equivalent, so this material would bias differently ' +
                'on the two backends. Leave it at 0, or branch on `renderer.api`.',
        );
    }

    // the render loop draws rasterized; transform feedback is the one path that turns it off, and turns it back
    setCapability(gl, state, 'rasterizerDiscard', false);
    setDepthState(gl, state, material);
    setDepthBiasState(gl, state, material);
    setCullState(gl, state, material);
    setBlendState(gl, state, blend);
    setCapability(gl, state, 'alphaToCoverage', material.alphaToCoverage);
    setColorMask(gl, state, material.colorWrite);
    setStencilState(gl, state, material, hasStencil);
}

/**
 * Puts the context back to GL's defaults for every state gpucat sets, and the record with it: for after other code has
 * drawn with the context, as three.js's `resetState` does. Reading the context's state back instead would stall it.
 */
export function resetGlState(gl: WebGL2RenderingContext, state: GlState, width: number, height: number): void {
    forgetGlState(state);
    setCapability(gl, state, 'depthTest', false);
    setCapability(gl, state, 'cullFace', false);
    setCapability(gl, state, 'blend', false);
    setCapability(gl, state, 'stencilTest', false);
    setCapability(gl, state, 'polygonOffsetFill', false);
    setCapability(gl, state, 'alphaToCoverage', false);
    setCapability(gl, state, 'scissorTest', false);
    setCapability(gl, state, 'rasterizerDiscard', false);
    setDepthFunc(gl, state, gl.LESS);
    setDepthMask(gl, state, true);
    setColorMask(gl, state, true);
    setFrontFace(gl, state, gl.CCW);
    gl.cullFace(gl.BACK);
    state.cullFaceMode = gl.BACK;
    gl.blendFuncSeparate(gl.ONE, gl.ZERO, gl.ONE, gl.ZERO);
    gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
    gl.polygonOffset(0, 0);
    setStencilWriteMask(gl, state, 0xffffffff);
    gl.stencilFunc(gl.ALWAYS, 0, 0xffffffff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    setViewport(gl, state, 0, 0, width, height);
    setDepthRange(gl, state, 0, 1);
    setScissor(gl, state, 0, 0, width, height);
    setClearColor(gl, state, 0, 0, 0, 0);
    setClearDepth(gl, state, 1);
    setClearStencil(gl, state, 0);
    // the rest is GL's default now, which the record learns as each is next set
}
