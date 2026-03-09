import { renderGroup } from './uniform';
import { UniformNode } from './uniform';


/** Projection matrix of the scene camera. In renderGroup. */

export const cameraProjectionMatrix = /*@__PURE__*/ new UniformNode('mat4x4f', 'cameraProjectionMatrix', renderGroup)
    .onRenderUpdate((frame) => frame.camera!.projectionMatrix);

/** View (world-to-camera) matrix. In renderGroup. */
export const cameraViewMatrix = /*@__PURE__*/ new UniformNode('mat4x4f', 'cameraViewMatrix', renderGroup)
    .onRenderUpdate((frame) => frame.camera!.matrixWorldInverse);

/** Camera world-space position. In renderGroup. */
export const cameraPosition = /*@__PURE__*/ new UniformNode('vec3f', 'cameraPosition', renderGroup)
    .onRenderUpdate((frame) => frame.camera!.position);

/** Camera near plane distance. In renderGroup. */
export const cameraNear = /*@__PURE__*/ new UniformNode('f32', 'cameraNear', renderGroup)
    .onRenderUpdate((frame) => frame.camera!.near);

/** Camera far plane distance. In renderGroup. */
export const cameraFar = /*@__PURE__*/ new UniformNode('f32', 'cameraFar', renderGroup)
    .onRenderUpdate((frame) => frame.camera!.far);
