import { mat4, type Vec4, vec4 } from 'math';
import { describe, expect, test } from 'vitest';
import {
    attribute,
    cameraViewProjectionMatrix,
    compileGlsl,
    compileWgsl,
    d,
    f32,
    mul,
    OrthographicCamera,
    PerspectiveCamera,
    viewProjection,
    vec4 as vec4Node,
} from '../src/index';

// world to clip space: `viewProjection(out, view)` on the cpu, `cameraViewProjectionMatrix` in a shader, which is the
// two camera uniforms multiplied and so binds nothing of its own

function placed<C extends PerspectiveCamera | OrthographicCamera>(camera: C): C {
    camera.position[0] = 3;
    camera.position[1] = 4;
    camera.position[2] = 5;
    camera.lookAt([0, 0, 0]);
    camera.updateWorldMatrix();
    camera.updateViewMatrix();
    return camera;
}

/** where a world point lands in clip space, the long way round */
function clipOf(camera: PerspectiveCamera | OrthographicCamera, p: Vec4): Vec4 {
    const view = vec4.transformMat4(vec4.create(), p, camera.matrixWorldInverse);
    return vec4.transformMat4(vec4.create(), view, camera.projectionMatrix);
}

const point: Vec4 = [0.5, -1, 2, 1];

describe('viewProjection', () => {
    test.each([
        ['perspective', () => placed(new PerspectiveCamera(Math.PI / 4, 1.5, 0.1, 100))],
        ['orthographic', () => placed(new OrthographicCamera(-4, 4, 3, -3, 0.1, 50))],
    ])('%s: takes a world point to the same clip position as projection after view', (_, make) => {
        const camera = make();
        const out = mat4.create();
        expect(viewProjection(out, camera)).toBe(out);
        const got = vec4.transformMat4(vec4.create(), point, out);
        const want = clipOf(camera, point);
        for (let i = 0; i < 4; i++) expect(got[i]).toBeCloseTo(want[i]!, 5);
    });

    test('takes any view, not only a camera', () => {
        const view = {
            projectionMatrix: mat4.fromScaling(mat4.create(), [2, 3, 4]),
            matrixWorldInverse: mat4.fromTranslation(mat4.create(), [1, 0, 0]),
        };
        const out = viewProjection(mat4.create(), view as never);
        expect(Array.from(out)).toEqual(Array.from(mat4.multiply(mat4.create(), view.projectionMatrix, view.matrixWorldInverse)));
    });
});

describe('cameraViewProjectionMatrix', () => {
    const shader = () => {
        const world = vec4Node(attribute('position', d.vec3f), f32(1));
        return {
            vertex: mul(cameraViewProjectionMatrix, world),
            fragment: vec4Node(f32(1), f32(0), f32(0), f32(1)),
            depth: undefined,
        };
    };

    test('is the projection times the view, from the two camera uniforms', () => {
        const wgsl = compileWgsl(shader()).code;
        expect(wgsl).toMatch(/cameraProjectionMatrix\w*\s*\*\s*\S*cameraViewMatrix/);
        expect(wgsl).not.toMatch(/cameraViewProjectionMatrix/);
    });

    test('compiles for GLSL too', () => {
        expect(compileGlsl(shader()).code).toMatch(/cameraProjectionMatrix\w*\s*\*\s*\S*cameraViewMatrix/);
    });
});
