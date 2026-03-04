import {
    attribute,
    builtin,
    type BuiltinNode,
    konst,
    mul,
    type Node,
    vec4,
} from './nodes.js';
import * as S from './schema.js';
import { defineStruct, type StructInstance } from './schema.js';

export const CameraStruct = defineStruct('Camera', {
    projectionMatrix: S.mat4x4f(),
    viewMatrix: S.mat4x4f(),
    position: S.vec3f(),
    near: S.f32(),
    far: S.f32(),
});

export type CameraInstance = StructInstance<typeof CameraStruct.schema>;

export function camera(): CameraInstance {
    return CameraStruct.instantiate(builtin('camera', 'Camera'));
}

export const TimeStruct = defineStruct('Time', {
    elapsed: S.f32(),
    delta: S.f32(),
});

export type TimeInstance = StructInstance<typeof TimeStruct.schema>;

export function time(): TimeInstance {
    return TimeStruct.instantiate(builtin('time', 'Time'));
}

export const MeshStruct = defineStruct('Mesh', {
    modelMatrix: S.mat4x4f(),
    normalMatrix: S.mat3x3f(),
});

export type MeshInstance = StructInstance<typeof MeshStruct.schema>;

export function mesh(): MeshInstance {
    return MeshStruct.instantiate(builtin('mesh', 'Mesh'));
}

export const instanceIndex = (): BuiltinNode<'u32'> => builtin('instance_index', 'u32');

export const positionClip: Node<'vec4f'> = (() => {
    const pos = attribute('vec3f', 'position');
    const localPos = vec4(pos, konst('f32', 1.0));

    const m = mesh();
    const worldPos = mul(m.modelMatrix, localPos);

    const cam = camera();
    const viewPos = mul(cam.viewMatrix, worldPos);
    const clipPos = mul(cam.projectionMatrix, viewPos);

    return clipPos as unknown as Node<'vec4f'>;
})();
