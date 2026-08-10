import * as d from '../../schema/schema';
import { CallNode, type Node } from './core';
import { renderGroup, Uniform, UniformNode } from './uniform';

/** Projection matrix of the scene camera. In renderGroup. */

export const cameraProjectionMatrix = /*@__PURE__*/ new UniformNode(
    new Uniform(d.mat4x4f, undefined, renderGroup),
    'cameraProjectionMatrix',
).onRenderUpdate((frame) => frame.camera!.projectionMatrix);

/** View (world-to-camera) matrix. In renderGroup. */
export const cameraViewMatrix = /*@__PURE__*/ new UniformNode(
    new Uniform(d.mat4x4f, undefined, renderGroup),
    'cameraViewMatrix',
).onRenderUpdate((frame) => frame.camera!.matrixWorldInverse);

/** Camera world-space position. In renderGroup. */
export const cameraPosition = /*@__PURE__*/ new UniformNode(
    new Uniform(d.vec3f, undefined, renderGroup),
    'cameraPosition',
).onRenderUpdate((frame) => frame.camera!.position);

/** Camera near plane distance. In renderGroup. */
export const cameraNear = /*@__PURE__*/ new UniformNode(new Uniform(d.f32, undefined, renderGroup), 'cameraNear').onRenderUpdate(
    (frame) => frame.camera!.near,
);

/** Camera far plane distance. In renderGroup. */
export const cameraFar = /*@__PURE__*/ new UniformNode(new Uniform(d.f32, undefined, renderGroup), 'cameraFar').onRenderUpdate(
    (frame) => frame.camera!.far,
);

/**
 * Remap an NDC depth value (typically `clipPos.z / clipPos.w`) into the [0,1] range a depth texture
 * stores, so shadow-map / depth-buffer comparisons are written ONCE and work on both backends. It is
 * lowered per emitter — the node graph stays identical:
 *   - WebGPU: NDC z is already [0,1] (ZO projection) → passthrough.
 *   - WebGL:  NDC z is [-1,1] (NO projection)        → `z * 0.5 + 0.5`.
 *
 * This keeps the per-backend depth-range convention out of user graphs (the analog of three.js baking
 * the remap into its shadow bias matrix rather than exposing it).
 */
export function ndcDepthToStorage(ndcZ: Node<d.f32>): Node<d.f32> {
    return new CallNode(d.f32, 'ndcDepthToStorage', [ndcZ]);
}
