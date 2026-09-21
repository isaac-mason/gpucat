import type { InspectableRenderer, InspectorBase } from '../../inspector/inspector-base';
import type { DeviceBackend } from './device-backend';
import type { Frame } from './frame';
import { beginInfoFrame, createRendererInfo, type RendererInfo } from './info';
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
export class Renderer<B extends DeviceBackend = DeviceBackend> implements RendererState {
    /**
     * The device layer. **Not public API**: backend-specific operations are free functions that take
     * the renderer (`dispatchTransformFeedback`, `readBuffer`), so a call site names what it needs
     * instead of reaching through here. The package itself and its harnesses still use it.
     * @internal
     */
    readonly backend: B;

    /** @internal */ _initialized = false;
    /** @internal */ _isDeviceLost = false;
    /** @internal */ _frameState: Frame | null = null;
    /** @internal */ _renderContexts = RenderContext.createRenderContextsState();
    /** @internal */ _computeContext = RenderContext.createComputeContext();
    /** @internal */ _nodes = NodeManager.createNodeManagerState();
    /** @internal */ _renderObjects = RenderObjects.createRenderObjectsState();
    /** @internal */ _renderLists = RenderLists.createRenderListsState();

    /** Per-frame draw and upload stats. Reset at this renderer's own frame boundary, never from outside,
     *  so any number of readers can share it. */
    readonly info: RendererInfo = createRendererInfo();

    onDeviceLost: ((info: DeviceLostInfo) => void) | null = null;

    constructor(backend: B) {
        this.backend = backend;
    }

    /** `B['name']`, not `RendererBackend`, so a union of concrete renderers discriminates on it. */
    get api(): B['name'] {
        return this.backend.name;
    }

    private _inspector: InspectorBase | null = null;

    /** Assigning attaches; assigning `null` detaches and disposes the old one. Order vs `init` is free. */
    get inspector(): InspectorBase | null {
        return this._inspector;
    }

    set inspector(next: InspectorBase | null) {
        if (this._inspector === next) return;
        this._inspector?.setRenderer(null);
        this._inspector = next;
        next?.setRenderer(this as unknown as InspectableRenderer);
    }

    async init(): Promise<this> {
        if (this._initialized) return this;
        await this.backend.init(this as Renderer<DeviceBackend>);
        this._initialized = true;
        return this;
    }

    dispose(): void {
        this.backend.dispose();
        // Cleared, not disposed one by one: the backend's teardown invalidates every GPU resource, and
        // each `onDispose` only does bookkeeping in the maps being dropped here.
        this._renderObjects.renderObjects.clear();
        this._renderObjects.cache = new WeakMap();
        this._renderContexts.contexts.clear();
        this._nodes.computeStates.clear();
        this._initialized = false;
        this._isDeviceLost = true;
    }

    /** @internal */
    _beginInfoFrame(): void {
        beginInfoFrame(this.info);
        this.backend.readMemoryStats(this.info.memory);
    }

    /** @internal */ _assertInitialized(what: string): void {
        if (!this._initialized) {
            throw new Error(`[Renderer] ${what}() called before init(). Await init(backend) first.`);
        }
    }
}

export type { DeviceLostInfo };
