import * as d from '../../schema/schema';
import { type Node } from './core';
import { UniformNode } from './uniform';
/** Model-to-world transform matrix: the drawn object's `matrixWorld`. */
export declare const modelWorldMatrix: UniformNode<d.mat4x4f>;
/** Normal matrix (inverse-transpose of upper-left 3x3 of model matrix): the drawn object's `normalMatrix`. In objectGroup. */
export declare const modelNormalMatrix: UniformNode<d.mat3x3f>;
/** helper for vertex shader: compute clip-space position from vertex position attribute and camera matrices. */
export declare const positionClip: Node<d.vec4f>;
