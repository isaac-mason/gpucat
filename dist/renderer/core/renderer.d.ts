import type { RenderTarget } from '../../core/render-target';
import type { InspectorBase } from '../../inspector/inspector-base';
import type { Mesh } from '../../objects/mesh';
import type { DeviceBackend } from './device-backend';
import { type Frame } from './frame';
import { type RendererInfo } from './info';
import * as NodeManager from './node-manager';
import * as RenderContext from './pass-context';
import * as RenderLists from './render-list';
import * as RenderObjects from './render-objects';
import { type DeviceLostInfo, type RendererState } from './renderer-ops';
import type { Target } from './target';
import type { View } from './view';
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
    constructor(backend: B);
    /** `B['name']`, not `RendererBackend`, so a union of concrete renderers discriminates on it. */
    get api(): B['name'];
    private _inspector;
    /** Assigning attaches; assigning `null` detaches and disposes the old one. Order vs `init` is free. */
    get inspector(): InspectorBase | null;
    set inspector(next: InspectorBase | null);
    init(): Promise<this>;
    /** The renderer's one reusable frame, reopened. */
    /** Pre-warm the drawables a pass will look up, resolved through the context that pass resolves. */
    compile(drawables: Mesh[], target: Target, camera: View): Promise<void>;
    readPixels(target: RenderTarget, attachmentIndex?: number, layer?: number): Promise<Uint8Array>;
    dispose(): void;
    /** @internal */
    _beginInfoFrame(): void;
    /** @internal */ _assertInitialized(what: string): void;
}
export type { DeviceLostInfo };
