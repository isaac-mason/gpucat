import type { InspectorBase } from '../../inspector/inspector-base';
import type { Mesh } from '../../objects/mesh';
import type { DrawOptions, DrawRecord, PassEntry, RenderBundle as RenderBundleRef } from './frame';
import type { NodeManagerState } from './node-manager';
import * as NodeManager from './node-manager';
import type * as RenderContextModule from './pass-context';
import type { RenderContext } from './pass-context';
import { resolvePassContext } from './pass-desc';
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
export function handleDeviceLost(r: RendererState, info: DeviceLostInfo): void {
    console.error(`[webgpu] WebGPU Device Lost:\n` + `  Message: ${info.message}\n` + `  Reason: ${info.reason ?? 'unknown'}`);

    r._isDeviceLost = true;
    r.onDeviceLost?.(info);
}

/**
 * The RenderObjects a pre-warm has to build, resolved through the same context a pass resolves, so the
 * program or pipeline warmed here is the one the pass then looks up rather than a second cache entry.
 */
export function compileTargets(
    r: RendererState,
    drawables: Mesh[],
    target: Target,
    camera: View,
): { context: RenderContext; objects: RenderObject[] } {
    const context = resolvePassContext(r._renderContexts, { target, camera });
    return {
        context,
        objects: drawables.map((mesh) => RenderObjects.getRenderObject(r._renderObjects, mesh, mesh.material, camera, context)),
    };
}

/** The recorded-draw counterpart to {@link prepareRenderObjects}: no render list, no scene walk. */
export function prepareRecordedDraws(
    r: RendererState,
    records: readonly PassEntry[],
    count: number,
    camera: View,
    passCtx: RenderContext,
    /** Null unless an inspector is attached; only annotates each object for the draw-calls tab. */
    inspectorLabel: string | null,
    prepare: (nodes: NodeManagerState, renderObject: RenderObject) => boolean,
    out: PreparedRenderObject[],
    outOpts: (DrawOptions | null)[],
    /** Runs of `out`, one per bundle plus the direct draws between them. WebGL has no use for these. */
    outSegments: PreparedSegment[],
): number {
    const inspector = r.inspector;
    let prepared = 0;

    const prepareEntry = (entry: PassEntry): void => {
        const { mesh, material, opts } = entry as DrawRecord;

        const renderObject = RenderObjects.getRenderObject(r._renderObjects, mesh, material, camera, passCtx);
        if (inspectorLabel !== null) renderObject.lastPassLabel = inspectorLabel;

        if (!prepare(r._nodes, renderObject)) return;

        if (inspector) inspector.perf.start('updateBefore');
        NodeManager.updateBefore(r._nodes, renderObject);
        if (inspector) inspector.perf.end('updateBefore');

        outOpts[prepared] = opts;
        out[prepared++] = renderObject;
    };

    // Bundles stay whole as segments so WebGPU can record one device bundle per run; their draws are
    // still prepared here, because a bundle has to be prepared before it can be recorded.
    let segments = 0;
    let runStart = prepared;
    const closeRun = (bundle: PassEntry | null): void => {
        if (prepared === runStart) return;
        outSegments[segments++] = {
            bundle: bundle === null ? null : (bundle as { bundle: RenderBundleRef }).bundle,
            start: runStart,
            count: prepared - runStart,
        };
        runStart = prepared;
    };

    for (let i = 0; i < count; i++) {
        const entry = records[i];
        if (entry.kind !== 'bundle') {
            prepareEntry(entry);
            continue;
        }
        closeRun(null);
        const { records: inner, count: innerCount } = entry.bundle;
        for (let j = 0; j < innerCount; j++) prepareEntry(inner[j] as DrawRecord);
        closeRun(entry);
    }
    closeRun(null);
    outSegments.length = segments;

    return prepared;
}

/** A per-depth list, grown on demand so a steady-state frame reuses one array. */
export function preparedAt<T>(byDepth: T[][], depth: number): T[] {
    let list = byDepth[depth];
    if (list === undefined) {
        list = [];
        byDepth[depth] = list;
    }
    return list;
}
