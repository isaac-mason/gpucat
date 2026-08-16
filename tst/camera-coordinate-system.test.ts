import { vec4 } from 'math';
import { describe, expect, test } from 'vitest';
import { CoordinateSystem, OrthographicCamera, PerspectiveCamera } from '../src/index';

/**
 * Guards the clip-space depth convention behind the dual-backend camera:
 *  - WEBGPU maps NDC z to [0,1] (perspectiveZO / orthoZO).
 *  - WEBGL  maps NDC z to [-1,1] (perspectiveNO / orthoNO).
 *
 * A pixel-occlusion test can NOT catch a ZO/NO regression: both conventions preserve depth ORDERING,
 * so a near object still occludes a far one either way (which is exactly why a symmetric lit box
 * passes even with the wrong projection). The observable difference is the projected NDC depth of the
 * near/far planes — asserted directly here. WebGPURenderer/WebGLRenderer stamp their convention onto
 * the camera each frame; this validates the math those pushes drive.
 */

const NEAR = 0.5;
const FAR = 50;

/** Project a view-space point (0, 0, viewZ, 1) through the camera's projection; return its NDC z. */
function ndcZ(cam: PerspectiveCamera | OrthographicCamera, viewZ: number): number {
    const p = vec4.fromValues(0, 0, viewZ, 1);
    vec4.transformMat4(p, p, cam.projectionMatrix);
    return p[2] / p[3];
}

describe('camera coordinate system (clip-space depth)', () => {
    test('default coordinateSystem is WEBGPU (z in [0,1])', () => {
        const cam = new PerspectiveCamera(Math.PI / 4, 1, NEAR, FAR);
        expect(cam.coordinateSystem).toBe(CoordinateSystem.WEBGPU);
        expect(ndcZ(cam, -NEAR)).toBeCloseTo(0, 4);
        expect(ndcZ(cam, -FAR)).toBeCloseTo(1, 4);
    });

    test('perspective: WEBGPU near→0/far→1 (ZO), WEBGL near→-1/far→1 (NO)', () => {
        const cam = new PerspectiveCamera(Math.PI / 4, 1, NEAR, FAR);

        cam.coordinateSystem = CoordinateSystem.WEBGPU;
        cam.updateProjectionMatrix();
        expect(ndcZ(cam, -NEAR)).toBeCloseTo(0, 4);
        expect(ndcZ(cam, -FAR)).toBeCloseTo(1, 4);

        cam.coordinateSystem = CoordinateSystem.WEBGL;
        cam.updateProjectionMatrix();
        expect(ndcZ(cam, -NEAR)).toBeCloseTo(-1, 4);
        expect(ndcZ(cam, -FAR)).toBeCloseTo(1, 4);
    });

    test('orthographic: WEBGPU near→0/far→1 (ZO), WEBGL near→-1/far→1 (NO)', () => {
        const cam = new OrthographicCamera(-1, 1, 1, -1, NEAR, FAR);

        cam.coordinateSystem = CoordinateSystem.WEBGPU;
        cam.updateProjectionMatrix();
        expect(ndcZ(cam, -NEAR)).toBeCloseTo(0, 4);
        expect(ndcZ(cam, -FAR)).toBeCloseTo(1, 4);

        cam.coordinateSystem = CoordinateSystem.WEBGL;
        cam.updateProjectionMatrix();
        expect(ndcZ(cam, -NEAR)).toBeCloseTo(-1, 4);
        expect(ndcZ(cam, -FAR)).toBeCloseTo(1, 4);
    });
});
