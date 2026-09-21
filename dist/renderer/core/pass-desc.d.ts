import type { CoordinateSystem } from '../../core/coordinate-system';
import type { PassDesc } from './frame';
import { type RenderContext, type RenderContextsState } from './pass-context';
import { type RenderPassParams } from './render-types';
import { type Target } from './target';
import type { View } from './view';
/** A camera's projection is built for one clip convention; a pass in the other rebuilds it. */
export declare function alignCameraToBackend(camera: View | undefined, coordinateSystem: CoordinateSystem): void;
export declare function sizeOf(target: Target): {
    width: number;
    height: number;
};
/** The shared, attachment-shape-keyed half: what every pass of this shape agrees on. */
export declare function resolvePassContext(state: RenderContextsState, desc: PassDesc): RenderContext;
/** Viewport and scissor are physical pixels of the target, so no pixel-ratio scaling applies. */
export declare function resolvePassParams(desc: PassDesc, out: RenderPassParams): RenderPassParams;
