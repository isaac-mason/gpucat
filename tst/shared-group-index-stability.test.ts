import { describe, expect, test } from 'vitest';
import { add, attribute, cameraProjectionMatrix, cameraViewMatrix, compile, d, f32, mul, struct, vec4 } from '../src/index';
import { fields, frameGroup, Uniform, uniform } from '../src/nodes/nodes';

/**
 * A shared uniform group (e.g. frameGroup) backs one buffer whose BindGroup is cached by an
 * order-independent key. A material that uses the camera (renderGroup) discovers the frame
 * uniforms in a different traversal than one that does not, so if member layout followed
 * discovery order the two materials could disagree on the frame struct's byte offsets while
 * sharing one cached block: the packer writes at one offset, a shader reads at another, and the
 * result is silent garbage (this is what blanked the sky).
 *
 * gpucat orders shared-group members by stable node id at emit time, so the frame layout is
 * identical whether or not a material also uses the camera. This guards that.
 *
 * The frame uniforms are created once (engine-global, as makecat's environment resources are)
 * so their node ids are stable across the two compilations being compared.
 */
describe('shared group layout is stable whether or not a material uses the camera', () => {
    const EnvTime = struct('EnvTime', { time: d.f32, wallTime: d.f32 });
    const EnvConfig = struct('EnvConfig', { enabled: d.u32, sunEnabled: d.u32, sunIntensity: d.f32 });

    const timeN = fields(uniform(new Uniform(EnvTime, { time: 0.6, wallTime: 0 }, frameGroup))) as unknown as {
        time: ReturnType<typeof f32>;
    };
    const cfgN = fields(uniform(new Uniform(EnvConfig, { enabled: 1, sunEnabled: 0, sunIntensity: 1 }, frameGroup))) as unknown as {
        enabled: { toF32: () => ReturnType<typeof f32> };
    };

    function frameLayout(useCamera: boolean): Map<number, number> {
        const frag = add(cfgN.enabled.toF32() as never, timeN.time as never) as never as ReturnType<typeof f32>;
        const pos = attribute('position', d.vec3f);
        const vertex = useCamera
            ? (mul(cameraProjectionMatrix, mul(cameraViewMatrix, vec4(pos, f32(1)))) as never)
            : vec4(pos, f32(1));

        const r = compile({
            vertex,
            fragment: vec4(frag, f32(0), f32(0), f32(1)),
            depth: undefined,
        });
        const group = r.uniformGroups.find((g) => g.group.name === 'frame');
        return new Map((group?.members ?? []).map((m) => [m.node.id, m.offset]));
    }

    test('frame member offsets are identical with and without the camera', () => {
        const withCamera = frameLayout(true);
        const withoutCamera = frameLayout(false);

        expect(withCamera.size).toBeGreaterThan(1);
        expect([...withCamera.keys()].sort((x, y) => x - y)).toEqual([...withoutCamera.keys()].sort((x, y) => x - y));
        for (const [id, off] of withCamera) {
            expect(withoutCamera.get(id), `frame uniform ${id} must have a stable offset regardless of camera use`).toBe(off);
        }
    });
});
