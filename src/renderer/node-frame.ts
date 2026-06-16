import type { WebGPURenderer } from './renderer';
import type { Camera } from '../camera/camera';
import type { Mesh } from '../objects/mesh';
import type { Object3D } from '../core/object3d';
import type { Material } from '../material/material';
import type { UpdateBeforeNode, UpdateAfterNode, UpdateNode } from '../nodes/builder';

/**
 * Update tracking maps for deduplication.
 * Tracks when a node was last updated to prevent redundant updates.
 */
type UpdateMaps = {
    frameId: number;
    renderId: number;
};

/**
 * NodeFrame, unified frame context for all node update callbacks.
 *
 * Properties are set by the renderer/NodeManager before calling update methods.
 * Nodes access whatever context they need from the frame.
 */
export class NodeFrame {
    /**
     * Frame ID, incremented once per top-level render()/compute() call.
     * Used for FRAME-level update deduplication.
     */
    frameId: number = 0;

    /**
     * Render ID — a globally-unique id for the current render() call.
     * Multiple renders can happen per frame (shadows, reflections, VR).
     * Used for RENDER-level update deduplication, so it MUST be unique per render;
     * assign it only via {@link beginRender} (never `renderId++`).
     */
    renderId: number = 0;

    /**
     * Monotonic backing counter for renderId. Never reset, so ids are never reused.
     * Advance it via {@link beginRender} rather than mutating directly.
     */
    renderIdCounter: number = 0;

    /**
     * Begin a render scope: assign a fresh, globally-unique `renderId` and return the
     * previous one. A nested render passes the returned value to {@link endRender} to
     * restore its parent's scope on exit.
     *
     * Using a monotonic counter (rather than `renderId++`) is what keeps ids unique
     * across the save/restore: after a nested render restores the parent id, the next
     * render still gets a brand-new id instead of colliding with the nested one — a
     * collision would wrongly dedup-skip that render's RENDER-scope updates.
     */
    beginRender(): number {
        const previous = this.renderId;
        this.renderId = ++this.renderIdCounter;
        return previous;
    }

    /** End a nested render scope, restoring the parent render's `renderId`. */
    endRender(previousRenderId: number): void {
        this.renderId = previousRenderId;
    }

    // -----------------------------------------------------------------------
    // Render Context (set before each update cycle)
    // -----------------------------------------------------------------------

    /**
     * The current renderer.
     */
    renderer: WebGPURenderer | null = null;

    /**
     * The current camera being rendered from.
     */
    camera: Camera | null = null;

    /**
     * The current object (mesh) being rendered.
     * Set for OBJECT-level updates.
     */
    object: Mesh | null = null;

    /**
     * The current scene/object being rendered.
     */
    scene: Object3D | null = null;

    /**
     * The current material being rendered.
     */
    material: Material | null = null;

    // -----------------------------------------------------------------------
    // GPU Context
    // -----------------------------------------------------------------------

    /**
     * The current GPU command encoder.
     * Used by nodes that need to encode GPU commands (PassNode, etc.)
     */
    encoder: GPUCommandEncoder | null = null;

    /**
     * Render target width in pixels.
     */
    width: number = 0;

    /**
     * Render target height in pixels.
     */
    height: number = 0;

    // -----------------------------------------------------------------------
    // Deduplication Maps
    // -----------------------------------------------------------------------

    /**
     * Used to control Node.update() calls.
     * Maps nodes to their last update frame/render IDs.
     */
    readonly updateMap: WeakMap<UpdateNode, UpdateMaps> = new WeakMap();

    /**
     * Used to control Node.updateBefore() calls.
     */
    readonly updateBeforeMap: WeakMap<UpdateBeforeNode, UpdateMaps> = new WeakMap();

    /**
     * Used to control Node.updateAfter() calls.
     */
    readonly updateAfterMap: WeakMap<UpdateAfterNode, UpdateMaps> = new WeakMap();

    // -----------------------------------------------------------------------
    // Methods
    // -----------------------------------------------------------------------

    private _getMaps<T extends object>(
        map: WeakMap<T, UpdateMaps>,
        node: T,
    ): UpdateMaps {
        let maps = map.get(node);
        if (!maps) {
            maps = { frameId: -1, renderId: -1 };
            map.set(node, maps);
        }
        return maps;
    }

    /**
     * Execute updateBefore for a node, respecting its updateBeforeType.
     */
    updateBeforeNode(node: UpdateBeforeNode): void {
        const updateType = node.updateBeforeType;
        if (updateType === 'none') return;

        const maps = this._getMaps(this.updateBeforeMap, node);

        if (updateType === 'frame') {
            if (maps.frameId !== this.frameId) {
                const prev = maps.frameId;
                maps.frameId = this.frameId;
                if (node.updateBefore(this) === false) {
                    maps.frameId = prev;
                }
            }
        } else if (updateType === 'render') {
            if (maps.renderId !== this.renderId) {
                const prev = maps.renderId;
                maps.renderId = this.renderId;
                if (node.updateBefore(this) === false) {
                    maps.renderId = prev;
                }
            }
        } else if (updateType === 'object') {
            node.updateBefore(this);
        }
    }

    /**
     * Execute update for a node, respecting its updateType.
     */
    updateNode(node: UpdateNode): void {
        const updateType = node.updateType;
        if (updateType === 'none') return;

        const maps = this._getMaps(this.updateMap, node);

        if (updateType === 'frame') {
            if (maps.frameId !== this.frameId) {
                const prev = maps.frameId;
                maps.frameId = this.frameId;
                if (node.update(this) === false) {
                    maps.frameId = prev;
                }
            }
        } else if (updateType === 'render') {
            if (maps.renderId !== this.renderId) {
                const prev = maps.renderId;
                maps.renderId = this.renderId;
                if (node.update(this) === false) {
                    maps.renderId = prev;
                }
            }
        } else if (updateType === 'object') {
            node.update(this);
        }
    }

    /**
     * Execute updateAfter for a node, respecting its updateAfterType.
     */
    updateAfterNode(node: UpdateAfterNode): void {
        const updateType = node.updateAfterType;
        if (updateType === 'none') return;

        const maps = this._getMaps(this.updateAfterMap, node);

        if (updateType === 'frame') {
            if (maps.frameId !== this.frameId) {
                const prev = maps.frameId;
                maps.frameId = this.frameId;
                if (node.updateAfter(this) === false) {
                    maps.frameId = prev;
                }
            }
        } else if (updateType === 'render') {
            if (maps.renderId !== this.renderId) {
                const prev = maps.renderId;
                maps.renderId = this.renderId;
                if (node.updateAfter(this) === false) {
                    maps.renderId = prev;
                }
            }
        } else if (updateType === 'object') {
            node.updateAfter(this);
        }
    }
}

/**
 * Create a new NodeFrame instance.
 */
export function createNodeFrame(): NodeFrame {
    return new NodeFrame();
}
