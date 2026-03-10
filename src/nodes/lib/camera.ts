import { Uniform, renderGroup, UniformNode } from './uniform';
import * as d from '../schema';


/** Projection matrix of the scene camera. In renderGroup. */

export const cameraProjectionMatrix = /*@__PURE__*/ new UniformNode(new Uniform(d.mat4x4f, undefined, renderGroup), 'cameraProjectionMatrix')
    .onRenderUpdate((frame) => frame.camera!.projectionMatrix);

/** View (world-to-camera) matrix. In renderGroup. */
export const cameraViewMatrix = /*@__PURE__*/ new UniformNode(new Uniform(d.mat4x4f, undefined, renderGroup), 'cameraViewMatrix')
    .onRenderUpdate((frame) => frame.camera!.matrixWorldInverse);

/** Camera world-space position. In renderGroup. */
export const cameraPosition = /*@__PURE__*/ new UniformNode(new Uniform(d.vec3f, undefined, renderGroup), 'cameraPosition')
    .onRenderUpdate((frame) => frame.camera!.position);

/** Camera near plane distance. In renderGroup. */
export const cameraNear = /*@__PURE__*/ new UniformNode(new Uniform(d.f32, undefined, renderGroup), 'cameraNear')
    .onRenderUpdate((frame) => frame.camera!.near);

/** Camera far plane distance. In renderGroup. */
export const cameraFar = /*@__PURE__*/ new UniformNode(new Uniform(d.f32, undefined, renderGroup), 'cameraFar')
    .onRenderUpdate((frame) => frame.camera!.far);
