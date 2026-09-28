import type { InspectorBase } from '../../inspector/inspector-base';
import type { Mesh } from '../../objects/mesh';
import type { DrawOptions, DrawRecord } from './frame';
import type { NodeManagerState } from './node-manager';
import * as NodeManager from './node-manager';
import type * as RenderContextModule from './pass-context';
import type { RenderContext } from './pass-context';
import { resolvePassContext } from './pass-desc';
import type * as RenderLists from './render-list';
import type { RenderObject } from './render-object';
import * as RenderObjects from './render-objects';
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
    drawables: readonly Mesh[],
    target: Target,
    camera: View,
): { context: RenderContext; objects: RenderObject[] } {
    const context = resolvePassContext(r._renderContexts, { target, camera });
    return {
        context,
        objects: drawables.map((mesh) => RenderObjects.getRenderObject(r._renderObjects, mesh, mesh.material, camera, context)),
    };
}

/**
 * One recorded draw's render object, compiled and with its `updateBefore` nodes run. `updateBefore` may
 * record and end a nested pass (a render texture the material samples).
 */
export function prepareRecordedDraw(
    r: RendererState,
    entry: DrawRecord,
    camera: View,
    passCtx: RenderContext,
    prepare: (nodes: NodeManagerState, renderObject: RenderObject) => void,
): RenderObject {
    const inspector = r.inspector;
    const renderObject = RenderObjects.getRenderObject(r._renderObjects, entry.mesh, entry.material, camera, passCtx);
    prepare(r._nodes, renderObject);

    if (inspector) inspector.perf.start('updateBefore');
    NodeManager.updateBefore(r._nodes, renderObject);
    if (inspector) inspector.perf.end('updateBefore');
    return renderObject;
}

/** A draw with no instances and no per-draw list resolves, but nothing of it reaches the GPU. */
export function drawsNothing(renderObject: RenderObject, opts: DrawOptions | null): boolean {
    const mesh = renderObject.mesh;
    return (opts?.instances ?? mesh.count) === 0 && (opts?.draws ?? mesh.draws) === undefined;
}
