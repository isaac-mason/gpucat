import type { InspectorBase } from '../../inspector/inspector-base';
import type { DeviceBackend } from './device-backend';
import type { Frame } from './frame';
import { type AllocationReport, type RendererInfo } from './info';
import * as NodeManager from './node-manager';
import * as RenderContext from './pass-context';
import * as RenderLists from './render-list';
import * as RenderObjects from './render-objects';
import type { DeviceLostInfo, RendererState } from './renderer-ops';
/**
 * What `init` returns: one class over any backend, so the orchestration has a single home and the
 * backends cannot drift apart without failing to satisfy `DeviceBackend`. `B` stays on the type, so
 * `init(webgpu())` reaches `gpu.backend.device` with no cast.
 */
export declare class Renderer<B extends DeviceBackend = DeviceBackend> implements RendererState {
    /**
     * The device layer. **Not public API**: backend-specific operations are free functions that take
     * the renderer (`dispatchTransformFeedback`, `readBuffer`), so a call site names what it needs
     * instead of reaching through here. The package itself and its harnesses still use it.
     * @internal
     */
    readonly backend: B;
    /** @internal */ _initialized: boolean;
    /** @internal */ _isDeviceLost: boolean;
    /** @internal */ _frameState: Frame | null;
    /** @internal */ _renderContexts: RenderContext.RenderContextsState;
    /** @internal */ _computeContext: RenderContext.ComputeContext;
    /** @internal */ _nodes: NodeManager.NodeManagerState;
    /** @internal */ _renderObjects: RenderObjects.RenderObjectsState;
    /** @internal */ _renderLists: RenderLists.RenderListsState;
    /** Per-frame draw and upload stats. Reset at this renderer's own frame boundary, never from outside,
     *  so any number of readers can share it. */
    readonly info: RendererInfo;
    onDeviceLost: ((info: DeviceLostInfo) => void) | null;
    /**
     * Fired with each validation error the device reports (WebGPU), as well as the error being logged. They arrive
     * after the call that caused them and never throw, and a console in a worker is easy to miss, so this is the way
     * to surface them: to a page from a worker, to a test, to an overlay. WebGL reports its failures by throwing.
     */
    onValidationError: ((message: string) => void) | null;
    constructor(backend: B);
    /** `B['name']`, not `RendererBackend`, so a union of concrete renderers discriminates on it. */
    get api(): B['name'];
    private _inspector;
    /** Assigning attaches; assigning `null` detaches and disposes the old one. Order vs `init` is free. */
    get inspector(): InspectorBase | null;
    set inspector(next: InspectorBase | null);
    init(): Promise<this>;
    /**
     * Puts the device back as gpucat leaves it and forgets what it assumed the device holds. Call it after other code
     * has drawn with the same WebGL context (another library, a hand-written pass), before gpucat draws again, as
     * three.js's `resetState` and Babylon's `wipeCaches` are used: gpucat skips setting a state it believes is set, so
     * a change it did not make would otherwise stand. On WebGPU there is nothing to reset.
     */
    resetState(): void;
    dispose(): void;
    /** @internal */
    _beginInfoFrame(): void;
    /** @internal */ _assertInitialized(what: string): void;
}
export type { DeviceLostInfo };
/**
 * Every GPU allocation the renderer holds, largest first: kind, category, format, label and bytes, as copies
 * the caller keeps. Walks every live allocation and allocates a row each, so it is for a debug panel
 * refreshing a few times a second, not a frame loop. `info.memory` has the running totals for free.
 */
export declare function memoryReport(renderer: Renderer): AllocationReport[];
