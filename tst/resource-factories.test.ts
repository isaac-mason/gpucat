import { expect, test } from 'vitest';
import { createObject3D, Object3D } from '../src/core/object3d';
import { createGeometry, Geometry } from '../src/geometry/geometry';
import { createMaterial, Material } from '../src/material/material';
import { f32, vec4 } from '../src/nodes/nodes';
import { createMesh, Mesh } from '../src/objects/mesh';
import { createScene, Scene } from '../src/scene/scene';

/** A factory that forwards to its own name instead of the constructor recurses until the stack goes. */
test('every resource factory builds the class it names', () => {
    const geometry = createGeometry();
    const material = createMaterial({ vertex: vec4(f32(0), f32(0), f32(0), f32(1)), fragment: vec4(1, 1, 1, 1) });

    expect(geometry).toBeInstanceOf(Geometry);
    expect(material).toBeInstanceOf(Material);
    expect(createMesh(geometry, material)).toBeInstanceOf(Mesh);
    expect(createObject3D()).toBeInstanceOf(Object3D);
    expect(createScene()).toBeInstanceOf(Scene);
});

/** The factories are the preferred spelling, so they must carry the constructor's arguments through. */
test('createMesh carries its geometry and material', () => {
    const geometry = createGeometry();
    const material = createMaterial({ vertex: vec4(f32(0), f32(0), f32(0), f32(1)), fragment: vec4(1, 0, 0, 1) });
    const mesh = createMesh(geometry, material);

    expect(mesh.geometry).toBe(geometry);
    expect(mesh.material).toBe(material);
});
