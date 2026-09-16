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
/**
 * The blend a transparent material gets when it declares no explicit `blend`. Straight (non
 * premultiplied) alpha over, with the destination alpha accumulated rather than replaced.
 */
export declare function defaultBlendState(): GPUBlendState;
/**
 * Translate a `BlendMode` into a blend state.
 *
 * subtractive/multiply are only defined for premultiplied alpha; the non-premultiplied combinations
 * are unsupported and rejected. 'no' and 'material' are not translatable on their own (they are
 * precedence markers resolved by `resolveTargetBlend`) and fall through to the default.
 */
export declare function blendModeState(blendMode: BlendMode): GPUBlendState;
/**
 * The material's own blend, before any MRT target overrides it. `undefined` means "do not blend":
 * an opaque material writes its fragment straight through.
 *
 * `transparent` with no explicit `blend` is the common case and MUST resolve to the default rather
 * than to no-blend, or the material sorts and depth-writes as transparent while drawing opaque.
 */
export declare function materialBlendState(material: Material): GPUBlendState | undefined;
/**
 * The blend that actually applies to one color target. `targetName` is the render target texture's
 * name for an MRT draw, or null when there is no MRT context (the material's own blend wins).
 *
 * Precedence, when an MRT names this target: 'material' inherits the material's blend, 'no' disables
 * blending for that attachment regardless of the material, anything else is the target's own mode.
 */
export declare function resolveTargetBlend(material: Material, mrt: MRTNode | null, targetName: string | null): GPUBlendState | undefined;
/** Stable comparison key for a resolved blend state; 'none' for no-blend. */
export declare function blendStateKey(blend: GPUBlendState | undefined): string;
