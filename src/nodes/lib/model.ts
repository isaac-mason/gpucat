import { mul, f32, vec4f, Node } from './core';
import { attribute } from './attribute';
import { objectGroup, UniformNode } from './uniform';
import * as d from '../schema';
import { cameraViewMatrix, cameraProjectionMatrix } from './camera';

/** Model-to-world transform matrix. */
export const modelWorldMatrix = /*@__PURE__*/ new UniformNode(d.mat4x4f, 'modelWorldMatrix', objectGroup)
    .onObjectUpdate((frame) => frame.object!.matrixWorld);

/** Normal matrix (inverse-transpose of upper-left 3x3 of model matrix). In objectGroup. */
export const modelNormalMatrix = /*@__PURE__*/ new UniformNode(d.mat3x3f, 'modelNormalMatrix', objectGroup)
    .onObjectUpdate((frame) => frame.object!.normalMatrix);

/** helper for vertex shader: compute clip-space position from vertex position attribute and camera matrices. */
export const positionClip: Node<d.Vec4fDesc> = (() => {
    const pos = attribute(d.vec3f, 'position');
    const localPos = vec4f(pos, f32(1.0));

    const worldPos = mul(modelWorldMatrix, localPos);

    const viewPos = mul(cameraViewMatrix, worldPos);
    const clipPos = mul(cameraProjectionMatrix, viewPos) as unknown as Node<d.Vec4fDesc>;

    return clipPos;
})();
