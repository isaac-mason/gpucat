/**
 * node-frame.ts — Unified frame context for node updates.
 *
 * Three.js aligned: mirrors src/nodes/core/NodeFrame.js
 *
 * NodeFrame is a stateful class that carries all context needed for node updates:
 * - Timing: time, deltaTime, frameId, renderId
 * - Render context: renderer, camera, object, scene, material
 * - GPU context: encoder, width, height
 *
 * The same NodeFrame instance is reused each frame, with context properties
 * updated before each update cycle.
 */

import type { WebGPURenderer } from './renderer';
import type { Camera } from '../camera/camera';
import type { Mesh } from '../objects/mesh';
import type { Scene } from '../scene/scene';
import type { Material } from '../material/material';
import type { UpdateBeforeNode, UpdateAfterNode, UpdateNode } from '../nodes/compile';

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
 * Three.js aligned: mirrors NodeFrame class.
 *
 * Properties are set by the renderer/NodeManager before calling update methods.
 * Nodes access whatever context they need from the frame.
 */
export class NodeFrame {
    // -----------------------------------------------------------------------
    // Timing
    // -----------------------------------------------------------------------

    /**
     * Elapsed time in seconds since renderer start.
     * Updated each frame.
     */
    time: number = 0;

    /**
     * Delta time in seconds since last frame.
     * Updated each frame.
     */
    deltaTime: number = 0;

    /**
     * Frame ID — incremented once per animation frame.
     * Used for FRAME-level update deduplication.
     */
    frameId: number = 0;

    /**
     * Render ID — incremented per render() call.
     * Multiple renders can happen per frame (shadows, reflections, VR).
     * Used for RENDER-level update deduplication.
     */
    renderId: number = 0;

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
     * The current scene being rendered.
     */
    scene: Scene | null = null;

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
    // Internal: for tracking last update time
    // -----------------------------------------------------------------------

    private _lastTime: number | undefined = undefined;

    // -----------------------------------------------------------------------
    // Deduplication Maps (Three.js aligned)
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

    /**
     * Update timing state. Called once per animation frame.
     * Three.js aligned: NodeFrame.update()
     */
    update(): void {
        this.frameId++;

        const now = performance.now();
        if (this._lastTime === undefined) {
            this._lastTime = now;
        }

        this.deltaTime = (now - this._lastTime) / 1000;
        this._lastTime = now;
        this.time += this.deltaTime;
    }

    // -----------------------------------------------------------------------
    // Private: Get or create update maps
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

    // -----------------------------------------------------------------------
    // Update Methods (Three.js aligned)
    // -----------------------------------------------------------------------

    /**
     * Execute updateBefore for a node, respecting its updateBeforeType.
     * Three.js aligned: NodeFrame.updateBeforeNode()
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
     * Three.js aligned: NodeFrame.updateNode()
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
     * Three.js aligned: NodeFrame.updateAfterNode()
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
