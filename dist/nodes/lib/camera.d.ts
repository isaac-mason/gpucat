import { UniformNode } from 'gpucat/dist/nodes/lib/uniform';
import * as d from 'gpucat/dist/schema/schema';
/** Projection matrix of the scene camera. In renderGroup. */
export declare const cameraProjectionMatrix: UniformNode<d.mat4x4f>;
/** View (world-to-camera) matrix. In renderGroup. */
export declare const cameraViewMatrix: UniformNode<d.mat4x4f>;
/** Camera world-space position. In renderGroup. */
export declare const cameraPosition: UniformNode<d.vec3f>;
/** Camera near plane distance. In renderGroup. */
export declare const cameraNear: UniformNode<d.f32>;
/** Camera far plane distance. In renderGroup. */
export declare const cameraFar: UniformNode<d.f32>;
