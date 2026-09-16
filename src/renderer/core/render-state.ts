/**
 * render-state.ts (renderer core), the backend-neutral decision of WHAT a material's render state
 * means, as opposed to how a device is told about it.
 *
 * Both backends call this and apply what comes back, so the rule cannot differ between them. Same
 * reasoning as `update-ranges.ts`, `partial-upload.ts` and `buffer-upload.ts`.
 *
 * The split: policy lives here (does this material blend at all, which blend wins when an MRT target
 * names its own, what does a transparent material with no explicit `blend` mean). Device translation
 * stays in the backend, because it is genuinely device-shaped: WebGPU bakes a `GPUBlendState` into a
 * pipeline object, WebGL2 sets `blendFuncSeparate`/`blendEquationSeparate` live and cannot express a
 * per-attachment blend at all. Nothing here may reference a device or a GL constant.
 */

import type { BlendMode } from '../../material/blend-mode';
import type { Material } from '../../material/material';
import type { MRTNode } from '../../nodes/lib/mrt';

/** (srcRGB, dstRGB, srcAlpha, dstAlpha) with 'add' for both operations. */
const add = (srcRGB: GPUBlendFactor, dstRGB: GPUBlendFactor, srcA: GPUBlendFactor, dstA: GPUBlendFactor): GPUBlendState => ({
    color: { srcFactor: srcRGB, dstFactor: dstRGB, operation: 'add' },
    alpha: { srcFactor: srcA, dstFactor: dstA, operation: 'add' },
});

/**
 * The blend a transparent material gets when it declares no explicit `blend`. Straight (non
 * premultiplied) alpha over, with the destination alpha accumulated rather than replaced.
 */
export function defaultBlendState(): GPUBlendState {
    return add('src-alpha', 'one-minus-src-alpha', 'one', 'one-minus-src-alpha');
}

/**
 * Translate a `BlendMode` into a blend state.
 *
 * subtractive/multiply are only defined for premultiplied alpha; the non-premultiplied combinations
 * are unsupported and rejected. 'no' and 'material' are not translatable on their own (they are
 * precedence markers resolved by `resolveTargetBlend`) and fall through to the default.
 */
export function blendModeState(blendMode: BlendMode): GPUBlendState {
    const { blending, premultiplyAlpha: pm } = blendMode;

    if (blending === 'custom') {
        const { blendSrc, blendDst, blendEquation } = blendMode;
        return {
            color: { srcFactor: blendSrc, dstFactor: blendDst, operation: blendEquation },
            alpha: {
                srcFactor: blendMode.blendSrcAlpha ?? blendSrc,
                dstFactor: blendMode.blendDstAlpha ?? blendDst,
                operation: blendMode.blendEquationAlpha ?? blendEquation,
            },
        };
    }

    switch (blending) {
        case 'normal':
            return pm
                ? add('one', 'one-minus-src-alpha', 'one', 'one-minus-src-alpha')
                : add('src-alpha', 'one-minus-src-alpha', 'one', 'one-minus-src-alpha');
        case 'additive':
            return pm ? add('one', 'one', 'one', 'one') : add('src-alpha', 'one', 'one', 'one');
        case 'subtractive':
            if (pm) return add('zero', 'one-minus-src', 'zero', 'one');
            break;
        case 'multiply':
            if (pm) return add('dst', 'one-minus-src-alpha', 'zero', 'one');
            break;
    }

    console.error(`[render-state] ${blending} blending requires premultiplyAlpha=true.`);
    return defaultBlendState();
}

/**
 * The material's own blend, before any MRT target overrides it. `undefined` means "do not blend":
 * an opaque material writes its fragment straight through.
 *
 * `transparent` with no explicit `blend` is the common case and MUST resolve to the default rather
 * than to no-blend, or the material sorts and depth-writes as transparent while drawing opaque.
 */
export function materialBlendState(material: Material): GPUBlendState | undefined {
    if (!material.transparent) return undefined;
    return material.blend ?? defaultBlendState();
}

/**
 * The blend that actually applies to one color target. `targetName` is the render target texture's
 * name for an MRT draw, or null when there is no MRT context (the material's own blend wins).
 *
 * Precedence, when an MRT names this target: 'material' inherits the material's blend, 'no' disables
 * blending for that attachment regardless of the material, anything else is the target's own mode.
 */
export function resolveTargetBlend(
    material: Material,
    mrt: MRTNode | null,
    targetName: string | null,
): GPUBlendState | undefined {
    if (mrt === null || targetName === null) return materialBlendState(material);

    const blendMode = mrt.getBlendMode(targetName);
    if (blendMode.blending === 'material') return materialBlendState(material);
    if (blendMode.blending === 'no') return undefined;
    return blendModeState(blendMode);
}

/** Stable comparison key for a resolved blend state; 'none' for no-blend. */
export function blendStateKey(blend: GPUBlendState | undefined): string {
    return blend ? JSON.stringify(blend) : 'none';
}
