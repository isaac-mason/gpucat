import { mul, f32, vec4f, Node } from './core';
import { attribute } from './attribute';
import { objectGroup, UniformNode, Uniform } from './uniform';
import * as d from '../../schema/schema';
import { cameraViewMatrix, cameraProjectionMatrix } from './camera';

/** Model-to-world transform matrix. */
export const modelWorldMatrix = /*@__PURE__*/ new UniformNode(
    new Uniform(d.mat4x4f, undefined, objectGroup),
    'modelWorldMatrix'
).onObjectUpdate((frame) => frame.object!.matrixWorld);

/** Normal matrix (inverse-transpose of upper-left 3x3 of model matrix). In objectGroup. */
export const modelNormalMatrix = /*@__PURE__*/ new UniformNode(
    new Uniform(d.mat3x3f, undefined, objectGroup),
    'modelNormalMatrix'
).onObjectUpdate((frame) => frame.object!.normalMatrix);

/** helper for vertex shader: compute clip-space position from vertex position attribute and camera matrices. */
export const positionClip: Node<d.vec4f> = (() => {
    const pos = attribute('position', d.vec3f);
    const localPos = vec4f(pos, f32(1.0));

    const worldPos = mul(modelWorldMatrix, localPos);

    const viewPos = mul(cameraViewMatrix, worldPos);
    const clipPos = mul(cameraProjectionMatrix, viewPos) as unknown as Node<d.vec4f>;

    return clipPos;
})();
