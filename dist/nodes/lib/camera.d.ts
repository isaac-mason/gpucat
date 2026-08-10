import * as d from '../../schema/schema';
import { type Node } from './core';
import { UniformNode } from './uniform';
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
export declare function ndcDepthToStorage(ndcZ: Node<d.f32>): Node<d.f32>;
