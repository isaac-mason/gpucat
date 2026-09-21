import { expect, test } from 'vitest';
import { CubeCamera, createCubeCamera } from '../src/camera/cube-camera';
import { createOrthographicCamera, OrthographicCamera } from '../src/camera/orthographic-camera';
import { createPerspectiveCamera, PerspectiveCamera } from '../src/camera/perspective-camera';
import { createCubeRenderTarget } from '../src/core/cube-render-target';
import { createSampler, GpuSampler } from '../src/core/gpu-sampler';
import { createObject3D, Object3D } from '../src/core/object3d';
import { createUniform, Uniform } from '../src/core/uniform';
import { createGeometry, Geometry } from '../src/geometry/geometry';
import { createMaterial, Material } from '../src/material/material';
import { createRaycaster, Raycaster } from '../src/math/raycaster';
import { f32, vec4 } from '../src/nodes/nodes';
import {
    createLine,
    createLineGeometry,
    createLineMaterial,
    createLineSegments,
    createLineSegmentsGeometry,
    Line,
    LineGeometry,
    LineMaterial,
    LineSegments,
    LineSegmentsGeometry,
} from '../src/objects/line';
import { createMesh, Mesh } from '../src/objects/mesh';
import { createScene, Scene } from '../src/scene/scene';
import * as d from '../src/schema/schema';
import { ArrayTexture, createArrayTexture } from '../src/texture/array-texture';
import { CubeTexture, createCubeTexture } from '../src/texture/cube-texture';
import { createDataTexture, DataTexture } from '../src/texture/data-texture';
import { createDepthTexture, DepthTexture } from '../src/texture/depth-texture';
import { createSource, Source } from '../src/texture/source';
import { createTexture, Texture } from '../src/texture/texture';
import { createData3DTexture, Data3DTexture } from '../src/texture/texture-3d';

/** A factory that forwards to its own name instead of the constructor recurses until the stack goes. */
test('every resource factory builds the class it names', () => {
    const geometry = createGeometry();
    const material = createMaterial({ vertex: vec4(f32(0), f32(0), f32(0), f32(1)), fragment: vec4(1, 1, 1, 1) });

    expect(geometry).toBeInstanceOf(Geometry);
    expect(material).toBeInstanceOf(Material);
    expect(createMesh(geometry, material)).toBeInstanceOf(Mesh);
    expect(createObject3D()).toBeInstanceOf(Object3D);
    expect(createScene()).toBeInstanceOf(Scene);
    expect(createUniform(d.f32, 0.5)).toBeInstanceOf(Uniform);
    expect(createSampler()).toBeInstanceOf(GpuSampler);
    expect(createRaycaster()).toBeInstanceOf(Raycaster);
});

test('every camera factory builds the camera it names', () => {
    expect(createPerspectiveCamera()).toBeInstanceOf(PerspectiveCamera);
    expect(createOrthographicCamera()).toBeInstanceOf(OrthographicCamera);
    expect(createCubeCamera(0.1, 100, createCubeRenderTarget(16))).toBeInstanceOf(CubeCamera);
});

test('every texture factory builds the texture it names', () => {
    expect(createTexture(null)).toBeInstanceOf(Texture);
    expect(createDataTexture(new Uint8Array(4), 1, 1)).toBeInstanceOf(DataTexture);
    expect(createArrayTexture(new Uint8Array(8), 1, 1, 2)).toBeInstanceOf(ArrayTexture);
    expect(createData3DTexture(new Uint8Array(8), 1, 1, 2)).toBeInstanceOf(Data3DTexture);
    expect(createCubeTexture([], { size: 4 })).toBeInstanceOf(CubeTexture);
    expect(createDepthTexture(4, 4)).toBeInstanceOf(DepthTexture);
    expect(createSource({ data: new Uint8Array(4), width: 1, height: 1 })).toBeInstanceOf(Source);
});

test('every line factory builds the class it names', () => {
    const points = [0, 0, 0, 1, 0, 0, 1, 1, 0];
    const lineGeometry = createLineGeometry(points);
    const segmentsGeometry = createLineSegmentsGeometry(points);
    const lineMaterial = createLineMaterial();

    expect(lineGeometry).toBeInstanceOf(LineGeometry);
    expect(segmentsGeometry).toBeInstanceOf(LineSegmentsGeometry);
    expect(lineMaterial).toBeInstanceOf(LineMaterial);
    expect(createLine(lineGeometry, lineMaterial)).toBeInstanceOf(Line);
    expect(createLineSegments(segmentsGeometry, lineMaterial)).toBeInstanceOf(LineSegments);
});

/** The factories are the preferred spelling, so they must carry the constructor's arguments through. */
test('createMesh carries its geometry and material', () => {
    const geometry = createGeometry();
    const material = createMaterial({ vertex: vec4(f32(0), f32(0), f32(0), f32(1)), fragment: vec4(1, 0, 0, 1) });
    const mesh = createMesh(geometry, material);

    expect(mesh.geometry).toBe(geometry);
    expect(mesh.material).toBe(material);
});

test('the argument-carrying factories forward every argument', () => {
    const camera = createPerspectiveCamera(1, 2, 3, 4);
    expect([camera.fov, camera.aspect, camera.near, camera.far]).toEqual([1, 2, 3, 4]);

    const ortho = createOrthographicCamera(-2, 2, 3, -3, 1, 50);
    expect([ortho.left, ortho.right, ortho.top, ortho.bottom, ortho.near, ortho.far]).toEqual([-2, 2, 3, -3, 1, 50]);

    const sampler = createSampler({ magFilter: 'nearest', compare: 'less' });
    expect([sampler.magFilter, sampler.compare]).toEqual(['nearest', 'less']);

    const raycaster = createRaycaster([1, 2, 3], [0, 0, 1], 1, 9);
    expect([raycaster.ray.origin, raycaster.ray.direction, raycaster.near, raycaster.far]).toEqual([[1, 2, 3], [0, 0, 1], 1, 9]);

    const volume = createData3DTexture(new Uint8Array(2 * 3 * 4 * 4), 2, 3, 4);
    expect([volume.width, volume.height, volume.depth]).toEqual([2, 3, 4]);

    const depth = createDepthTexture(8, 16, 'depth32float');
    expect([depth.width, depth.height, depth.format]).toEqual([8, 16, 'depth32float']);
});
