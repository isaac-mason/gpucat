import type { InspectorBase } from '../../inspector/inspector-base';
import type { Mesh } from '../../objects/mesh';
import type { DrawOptions, PassEntry } from './frame';
import type { NodeManagerState } from './node-manager';
import type * as RenderContextModule from './pass-context';
import type { RenderContext } from './pass-context';
import type * as RenderLists from './render-list';
import type { RenderObject } from './render-object';
import * as RenderObjects from './render-objects';
import type { PreparedRenderObject, PreparedSegment } from './render-types';
import type { Target } from './target';
import type { View } from './view';
/** Neutral by construction: `api` names the backend and `reason` is a plain string, so no graphics
 *  type leaks into core. */
export type DeviceLostInfo = {
    /** The API that lost the device (e.g. 'WebGPU'). */
    api: string;
    /** Human-readable message about the loss. */
    message: string;
    /** The reason for the loss, if available. */
    reason: string | null;
    /** The original device-loss event, opaque to core. */
    originalEvent: unknown;
};
/** Each renderer declares these fields under the same names and passes itself in as `r`; its device
 *  handles and caches are extra fields these functions never touch. */
export interface RendererState {
    /** Whether the renderer has been initialized (device/context created). */
    _initialized: boolean;
    /** Whether the device has been lost (rendering disabled). */
    _isDeviceLost: boolean;
    /** Attached inspector, or null. */
    inspector: InspectorBase | null;
    /** User callback fired on device loss. */
    onDeviceLost: ((info: DeviceLostInfo) => void) | null;
    /** Per-pass render context cache. */
    _renderContexts: RenderContextModule.RenderContextsState;
    /** Compute context. */
    _computeContext: RenderContextModule.ComputeContext;
    /** Node manager state (node frame, compute states, ...). */
    _nodes: NodeManagerState;
    /** RenderObject cache. */
    _renderObjects: RenderObjects.RenderObjectsState;
    /** Render list state. */
    _renderLists: RenderLists.RenderListsState;
}
/** Decode + report a device-loss event: log, set the lost flag, fire the user callback. */
export declare function handleDeviceLost(r: RendererState, info: DeviceLostInfo): void;
/**
 * The RenderObjects a pre-warm has to build, resolved through the same context a pass resolves, so the
 * program or pipeline warmed here is the one the pass then looks up rather than a second cache entry.
 */
export declare function compileTargets(r: RendererState, drawables: Mesh[], target: Target, camera: View): {
    context: RenderContext;
    objects: RenderObject[];
};
/** The recorded-draw counterpart to {@link prepareRenderObjects}: no render list, no scene walk. */
export declare function prepareRecordedDraws(r: RendererState, records: readonly PassEntry[], count: number, camera: View, passCtx: RenderContext, 
/** Null unless an inspector is attached; only annotates each object for the draw-calls tab. */
inspectorLabel: string | null, prepare: (nodes: NodeManagerState, renderObject: RenderObject) => boolean, out: PreparedRenderObject[], outOpts: (DrawOptions | null)[], 
/** Runs of `out`, one per bundle plus the direct draws between them. WebGL has no use for these. */
outSegments: PreparedSegment[]): number;
/** A per-depth list, grown on demand so a steady-state frame reuses one array. */
export declare function preparedAt<T>(byDepth: T[][], depth: number): T[];
