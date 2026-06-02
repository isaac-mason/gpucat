import type { WebGPURenderer } from 'gpucat/dist/renderer/renderer';
import type { Camera } from 'gpucat/dist/camera/camera';
import type { Mesh } from 'gpucat/dist/objects/mesh';
import type { Object3D } from 'gpucat/dist/core/object3d';
import type { Material } from 'gpucat/dist/material/material';
import type { UpdateBeforeNode, UpdateAfterNode, UpdateNode } from 'gpucat/dist/nodes/builder';
/**
 * Update tracking maps for deduplication.
 * Tracks when a node was last updated to prevent redundant updates.
 */
type UpdateMaps = {
    frameId: number;
    renderId: number;
};
/**
 * NodeFrame — unified frame context for all node update callbacks.
 *
 * Properties are set by the renderer/NodeManager before calling update methods.
 * Nodes access whatever context they need from the frame.
 */
export declare class NodeFrame {
    /**
     * Elapsed time in seconds since renderer start.
     * Updated each frame.
     */
    time: number;
    /**
     * Delta time in seconds since last frame.
     * Updated each frame.
     */
    deltaTime: number;
    /**
     * Frame ID — incremented once per animation frame.
     * Used for FRAME-level update deduplication.
     */
    frameId: number;
    /**
     * Render ID — incremented per render() call.
     * Multiple renders can happen per frame (shadows, reflections, VR).
     * Used for RENDER-level update deduplication.
     */
    renderId: number;
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
    private _lastTime;
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
    /**
     * Update timing state. Called once per animation frame.
     */
    update(): void;
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
