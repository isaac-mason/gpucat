import type { Material } from '../../material/material';
import type { UpdateAfterNode, UpdateBeforeNode, UpdateNode } from '../../nodes/builder';
import type { Mesh } from '../../objects/mesh';
import type { DeviceBackend } from './device-backend';
import type { Renderer } from './renderer';
import type { View } from './view';

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
    /** Incremented once per frame, by `beginFrame`. Deduplicates FRAME-scope updates. */
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
     * Opens a pass's scope with a fresh id, returning the caller's to restore. The counter is
     * monotonic rather than `renderId++` so a pass that nests inside another cannot, on exit, hand
     * the outer one an id a later pass will reuse and dedup-skip.
     */
    beginRender(): number {
        const previous = this.renderId;
        this.renderId = ++this.renderIdCounter;
        return previous;
    }

    /** Closes a pass's scope, restoring the one it opened inside. */
    endRender(previousRenderId: number): void {
        this.renderId = previousRenderId;
    }

    // Render Context (set before each update cycle)

    /**
     * The current renderer (backend-neutral contract).
     */
    renderer: Renderer<DeviceBackend> | null = null;

    /**
     * The current camera being rendered from.
     */
    camera: View | null = null;

    /**
     * The current object (mesh) being rendered.
     * Set for OBJECT-level updates.
     */
    object: Mesh | null = null;

    /**
     * The current material being rendered.
     */
    material: Material | null = null;

    /**
     * Render target width in pixels.
     */
    width: number = 0;

    /**
     * Render target height in pixels.
     */
    height: number = 0;

    // Deduplication Maps

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

    // Methods

    private _getMaps<T extends object>(map: WeakMap<T, UpdateMaps>, node: T): UpdateMaps {
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

/** What every pass and the pre-warm both point the node frame at before evaluating a graph. */
export function aimNodeFrame(renderer: Renderer<DeviceBackend>, camera: View | null, width: number, height: number): void {
    const frame = renderer._nodes.nodeFrame;
    frame.renderer = renderer;
    frame.camera = camera;
    frame.width = width;
    frame.height = height;
}
