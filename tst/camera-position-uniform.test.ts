import { describe, expect, test } from 'vitest';
import { Object3D, PerspectiveCamera, cameraPosition, cameraViewMatrix } from '../src/index';
import type { NodeFrame } from '../src/nodes/lib/uniform';

/**
 * Guards `cameraPosition` against being read off the camera's LOCAL `position`.
 *
 * The two are identical while the camera is unparented, so a naive implementation
 * passes every single-camera scene and only fails once someone parents the camera
 * to a rig, a vehicle or a player node. It then reports the wrong place SILENTLY,
 * while `cameraViewMatrix` — built from `matrixWorldInverse` — keeps working. A
 * shader using both then disagrees with itself, which is near-impossible to spot
 * from the picture.
 *
 * Both uniforms are therefore asserted against the same parented camera: they have
 * to describe the same eye, or neither is trustworthy.
 */

const frameFor = (camera: PerspectiveCamera) => ({ camera }) as unknown as NodeFrame;

/** The eye position implied by a view matrix: the translation of its inverse. */
function eyeFromViewMatrix(m: ArrayLike<number>): [number, number, number] {
    // world-to-camera is [R|t] with R orthonormal, so the camera sits at -Rᵀt
    const [t0, t1, t2] = [m[12]!, m[13]!, m[14]!];
    return [
        -(m[0]! * t0 + m[1]! * t1 + m[2]! * t2),
        -(m[4]! * t0 + m[5]! * t1 + m[6]! * t2),
        -(m[8]! * t0 + m[9]! * t1 + m[10]! * t2),
    ];
}

describe('cameraPosition uniform', () => {
    test('unparented: reports its own position', () => {
        const camera = new PerspectiveCamera(Math.PI / 4, 1, 0.1, 100);
        camera.position[0] = 3;
        camera.position[1] = 4;
        camera.position[2] = 5;
        camera.updateWorldMatrix();

        cameraPosition.update!(frameFor(camera));
        expect(Array.from(cameraPosition.value as ArrayLike<number>)).toEqual([3, 4, 5]);
    });

    test('parented: reports the WORLD position, not the local one', () => {
        const rig = new Object3D();
        rig.position[0] = 100;
        rig.position[1] = 20;
        rig.position[2] = -60;

        const camera = new PerspectiveCamera(Math.PI / 4, 1, 0.1, 100);
        camera.position[0] = 0;
        camera.position[1] = 1.6; // eye height above the rig
        camera.position[2] = 0;
        rig.add(camera);
        rig.updateWorldMatrix(); // cascades to children

        cameraPosition.update!(frameFor(camera));
        const got = Array.from(cameraPosition.value as ArrayLike<number>);

        // the local position would be [0, 1.6, 0] — the bug this test exists for
        expect(got[0]).toBeCloseTo(100, 5);
        expect(got[1]).toBeCloseTo(21.6, 5);
        expect(got[2]).toBeCloseTo(-60, 5);
    });

    test('parented: agrees with the eye implied by cameraViewMatrix', () => {
        const rig = new Object3D();
        rig.position[0] = -12;
        rig.position[1] = 7;
        rig.position[2] = 33;

        const camera = new PerspectiveCamera(Math.PI / 4, 1, 0.1, 100);
        camera.position[0] = 2;
        camera.position[1] = 1.6;
        camera.position[2] = -0.5;
        rig.add(camera);
        rig.updateWorldMatrix();
        camera.updateViewMatrix();

        cameraPosition.update!(frameFor(camera));
        const fromUniform = Array.from(cameraPosition.value as ArrayLike<number>);

        cameraViewMatrix.update!(frameFor(camera));
        const fromView = eyeFromViewMatrix(cameraViewMatrix.value as ArrayLike<number>);

        for (let i = 0; i < 3; i++) expect(fromUniform[i]!).toBeCloseTo(fromView[i]!, 4);
    });
});
