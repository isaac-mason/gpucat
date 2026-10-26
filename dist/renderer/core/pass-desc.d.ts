import type { CoordinateSystem } from '../../core/coordinate-system';
import type { DeviceBackend } from './device-backend';
import type { CameraRecord, PassDesc, PassEntry, Rect, RenderBundle, ScissorRecord, ViewportRecord, ViewportRect } from './frame';
import { type RenderContext, type RenderContextsState, type ScissorValue, type ViewportValue } from './pass-context';
import { type PreparedSegment, type RenderPassParams } from './render-types';
import type { Renderer } from './renderer';
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
/**
 * `viewport` into `out`, physical pixels of a `width` x `height` target; whether one is set, undefined being the whole
 * target. One reaching outside the target throws here, naming the pass: WebGPU refuses it later, naming neither.
 */
export declare function resolveViewport(viewport: ViewportRect | undefined, width: number, height: number, passId: string, out: ViewportValue): boolean;
/** `scissor` clamped into a `width` x `height` target, into `out`; whether it clips anything. */
export declare function resolveScissor(scissor: Rect | undefined, width: number, height: number, out: ScissorValue): boolean;
/**
 * A camera, viewport or scissor record onto the open pass's `params`, for the draws recorded after it. A new camera
 * takes the backend's clip convention and a render scope of its own, so the camera's uniforms and every render-scope
 * node update run again for it.
 */
export declare function applyViewRecord(renderer: Renderer<DeviceBackend>, params: RenderPassParams, entry: CameraRecord | ViewportRecord | ScissorRecord, coordinateSystem: CoordinateSystem): void;
/** Whether a record changes what the draws after it are drawn with, rather than drawing. */
export declare function isViewRecord(entry: PassEntry): entry is CameraRecord | ViewportRecord | ScissorRecord;
/** The run of draws `start` to `start + count` into `out`, with the camera and rects `params` holds while they draw. */
export declare function writeSegment(out: PreparedSegment, bundle: RenderBundle | null, start: number, count: number, params: RenderPassParams): void;
