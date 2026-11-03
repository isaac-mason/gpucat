import * as d from '../../schema/schema';
import { attribute } from './attribute';
import { cameraProjectionMatrix, cameraViewMatrix } from './camera';
import { f32, mul, type Node, vec4f } from './core';
import { objectGroup, Uniform, UniformNode } from './uniform';

/** Model-to-world transform matrix: the drawn object's `matrixWorld`. */
export const modelWorldMatrix = /*@__PURE__*/ objectMatrix(d.mat4x4f, 'modelWorldMatrix', 'matrixWorld');

/** Normal matrix (inverse-transpose of upper-left 3x3 of model matrix): the drawn object's `normalMatrix`. In objectGroup. */
export const modelNormalMatrix = /*@__PURE__*/ objectMatrix(d.mat3x3f, 'modelNormalMatrix', 'normalMatrix');

/** A uniform the renderer fills from the drawn object's matrix `field`. */
function objectMatrix<D extends d.Any>(schema: D, name: string, field: 'matrixWorld' | 'normalMatrix'): UniformNode<D> {
    const node = new UniformNode(new Uniform(schema, undefined, objectGroup), name);
    node.objectMatrix = field;
    return node;
}

/** helper for vertex shader: compute clip-space position from vertex position attribute and camera matrices. */
export const positionClip: Node<d.vec4f> = (() => {
    const pos = attribute('position', d.vec3f);
    const localPos = vec4f(pos, f32(1.0));

    const worldPos = mul(modelWorldMatrix, localPos);

    const viewPos = mul(cameraViewMatrix, worldPos);
    const clipPos = mul(cameraProjectionMatrix, viewPos) as unknown as Node<d.vec4f>;

    return clipPos;
})();
