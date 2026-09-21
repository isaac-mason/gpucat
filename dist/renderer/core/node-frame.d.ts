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
export declare class NodeFrame {
    /** Incremented once per frame, by `beginFrame`. Deduplicates FRAME-scope updates. */
    frameId: number;
    /**
     * Render ID — a globally-unique id for the current render() call.
     * Multiple renders can happen per frame (shadows, reflections, VR).
     * Used for RENDER-level update deduplication, so it MUST be unique per render;
     * assign it only via {@link beginRender} (never `renderId++`).
     */
    renderId: number;
    /**
     * Monotonic backing counter for renderId. Never reset, so ids are never reused.
     * Advance it via {@link beginRender} rather than mutating directly.
     */
    renderIdCounter: number;
    /**
     * Opens a pass's scope with a fresh id, returning the caller's to restore. The counter is
     * monotonic rather than `renderId++` so a pass that nests inside another cannot, on exit, hand
     * the outer one an id a later pass will reuse and dedup-skip.
     */
    beginRender(): number;
    /** Closes a pass's scope, restoring the one it opened inside. */
    endRender(previousRenderId: number): void;
    /**
     * The current renderer (backend-neutral contract).
     */
    renderer: Renderer<DeviceBackend> | null;
    /**
     * The current camera being rendered from.
     */
    camera: View | null;
    /**
     * The current object (mesh) being rendered.
     * Set for OBJECT-level updates.
     */
    object: Mesh | null;
    /**
     * The current material being rendered.
     */
    material: Material | null;
    /**
     * Render target width in pixels.
     */
    width: number;
    /**
     * Render target height in pixels.
     */
    height: number;
    /**
     * Used to control Node.update() calls.
     * Maps nodes to their last update frame/render IDs.
     */
    readonly updateMap: WeakMap<UpdateNode, UpdateMaps>;
    /**
     * Used to control Node.updateBefore() calls.
     */
    readonly updateBeforeMap: WeakMap<UpdateBeforeNode, UpdateMaps>;
    /**
     * Used to control Node.updateAfter() calls.
     */
    readonly updateAfterMap: WeakMap<UpdateAfterNode, UpdateMaps>;
    private _getMaps;
    /**
     * Execute updateBefore for a node, respecting its updateBeforeType.
     */
    updateBeforeNode(node: UpdateBeforeNode): void;
    /**
     * Execute update for a node, respecting its updateType.
     */
    updateNode(node: UpdateNode): void;
    /**
     * Execute updateAfter for a node, respecting its updateAfterType.
     */
    updateAfterNode(node: UpdateAfterNode): void;
}
/**
 * Create a new NodeFrame instance.
 */
export declare function createNodeFrame(): NodeFrame;
/** What every pass and the pre-warm both point the node frame at before evaluating a graph. */
export declare function aimNodeFrame(renderer: Renderer<DeviceBackend>, camera: View | null, width: number, height: number): void;
export {};
