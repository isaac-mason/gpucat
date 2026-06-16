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
export declare class NodeFrame {
    /**
     * Frame ID, incremented once per top-level render()/compute() call.
     * Used for FRAME-level update deduplication.
     */
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
     * Begin a render scope: assign a fresh, globally-unique `renderId` and return the
     * previous one. A nested render passes the returned value to {@link endRender} to
     * restore its parent's scope on exit.
     *
     * Using a monotonic counter (rather than `renderId++`) is what keeps ids unique
     * across the save/restore: after a nested render restores the parent id, the next
     * render still gets a brand-new id instead of colliding with the nested one — a
     * collision would wrongly dedup-skip that render's RENDER-scope updates.
     */
    beginRender(): number;
    /** End a nested render scope, restoring the parent render's `renderId`. */
    endRender(previousRenderId: number): void;
    /**
     * The current renderer.
     */
    renderer: WebGPURenderer | null;
    /**
     * The current camera being rendered from.
     */
    camera: Camera | null;
    /**
     * The current object (mesh) being rendered.
     * Set for OBJECT-level updates.
     */
    object: Mesh | null;
    /**
     * The current scene/object being rendered.
     */
    scene: Object3D | null;
    /**
     * The current material being rendered.
     */
    material: Material | null;
    /**
     * The current GPU command encoder.
     * Used by nodes that need to encode GPU commands (PassNode, etc.)
     */
    encoder: GPUCommandEncoder | null;
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
export {};
