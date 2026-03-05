/**
 * render-frame.ts — RenderFrame and uniform update context types.
 *
 * Mirrors three's NodeFrame.  Carries the renderer plus the current
 * frame's encoder and canvas dimensions — everything a PassNode needs.
 */

import type { WebGPURenderer } from './renderer';
import type { Camera } from '../scene/camera';
import type { Mesh } from '../scene/mesh';

/**
 * The frame context passed to node.updateBefore() / updateAfter().
 * Carries the renderer plus the current frame's encoder and canvas dimensions.
 */
export type RenderFrame = {
    renderer: WebGPURenderer;
    encoder: GPUCommandEncoder;
    width: number;
    height: number;
};

/**
 * Context for UniformNode.onRenderUpdate() callbacks.
 * Called once per render() call for uniforms in renderGroup (camera, time).
 * Mirrors three's frame context for onRenderUpdate.
 */
export type RenderUpdateContext = {
    /** The current camera. */
    camera: Camera;
    /** Elapsed time in seconds since renderer start. */
    elapsed: number;
    /** Delta time in seconds since last frame. */
    delta: number;
};

/**
 * Context for UniformNode.onObjectUpdate() callbacks.
 * Called once per object for uniforms in objectGroup (mesh matrices).
 * Mirrors three's frame context for onObjectUpdate.
 */
export type ObjectUpdateContext = {
    /** The current object (mesh) being rendered. */
    object: Mesh;
};
