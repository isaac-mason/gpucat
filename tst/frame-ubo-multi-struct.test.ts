import { describe, expect, test } from 'vitest';
import { attribute, compile, d, f32, struct, vec4 } from '../src/index';
import { fields, frameGroup, Uniform, UniformNode } from '../src/nodes/nodes';
import { packToView } from '../src/schema/pack';

// Reproduces makecat's frame UBO: two struct members packed into one `Uniforms_frame` UBO.
// `EnvTime` is 8 bytes but a struct in wgsl-uniform layout has size rounded to 16 and align 16, so
// `EnvConfig` must land at offset 16 — and its first field `enabled` at byte 16. If the member offset
// is miscomputed (struct align not rounded to 16), the shader reads `enabled` from the wrong bytes and
// gets 0 (symptom: the sky's `enabledMask` is 0 → black).
describe('frame UBO with two struct members aligns the second struct to 16', () => {
    const EnvTime = struct('EnvTime', { time: d.f32, wallTime: d.f32 });
    const EnvConfig = struct('EnvConfig', {
        enabled: d.u32,
        sunEnabled: d.u32,
        sunIntensity: d.f32,
        moonEnabled: d.u32,
        starsEnabled: d.u32,
        starsDensity: d.f32,
        cloudsEnabled: d.u32,
        cloudsDensity: d.f32,
        cloudsWindX: d.f32,
        cloudsWindY: d.f32,
        cloudsAltitude: d.f32,
        cloudsThickness: d.f32,
    });

    test('EnvConfig member sits at offset 16 and packed `enabled` reads back there', () => {
        const time = fields(new UniformNode(new Uniform(EnvTime, { time: 0.6, wallTime: 0 }, frameGroup), 'uniform_307') as never) as never as {
            time: ReturnType<typeof f32>;
        };
        const config = fields(
            new UniformNode(
                new Uniform(
                    EnvConfig,
                    {
                        enabled: 1,
                        sunEnabled: 1,
                        sunIntensity: 1,
                        moonEnabled: 0,
                        starsEnabled: 0,
                        starsDensity: 0,
                        cloudsEnabled: 0,
                        cloudsDensity: 0,
                        cloudsWindX: 0,
                        cloudsWindY: 0,
                        cloudsAltitude: 0,
                        cloudsThickness: 0,
                    },
                    frameGroup,
                ),
                'uniform_310',
            ) as never,
        ) as never as { enabled: { toF32: () => ReturnType<typeof f32> } };

        // Read `enabled` (u32→f32) exactly like the sky's enabledMask.
        const mask = config.enabled.toF32();
        const result = compile({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: vec4(mask, mask, mask, time.time),
            depth: undefined,
        });

        const frame = result.uniformGroups.find((g) => g.members.some((m) => m.uniformId === 'uniform_310'));
        expect(frame).toBeDefined();
        const cfgMember = frame!.members.find((m) => m.uniformId === 'uniform_310')!;
        const timeMember = frame!.members.find((m) => m.uniformId === 'uniform_307')!;

        // Both struct members are 16-aligned (struct-in-uniform rounds align up to 16), regardless of
        // which order they were discovered in.
        expect(cfgMember.offset % 16).toBe(0);
        expect(timeMember.offset % 16).toBe(0);

        // The emitted `struct Uniforms_frame { ... }` must list members in ascending-offset order so the
        // WGSL driver's layout matches the offsets the packer writes at.
        const structBody = result.code.slice(result.code.indexOf('struct Uniforms_frame'));
        const iCfg = structBody.indexOf('uniform_310');
        const iTime = structBody.indexOf('uniform_307');
        expect(iCfg < iTime).toBe(cfgMember.offset < timeMember.offset);

        // Pack the whole frame UBO the way the renderer does, then confirm `enabled` (u32) reads 1 at
        // the EnvConfig member offset — i.e. the packed byte the WGSL shader will read.
        const buf = new ArrayBuffer(frame!.totalBytes);
        const view = new DataView(buf);
        packToView(timeMember.schema, view, timeMember.offset, { time: 0.6, wallTime: 0 } as never, 'wgsl-uniform');
        packToView(
            cfgMember.schema,
            view,
            cfgMember.offset,
            {
                enabled: 1,
                sunEnabled: 1,
                sunIntensity: 1,
                moonEnabled: 0,
                starsEnabled: 0,
                starsDensity: 0,
                cloudsEnabled: 0,
                cloudsDensity: 0,
                cloudsWindX: 0,
                cloudsWindY: 0,
                cloudsAltitude: 0,
                cloudsThickness: 0,
            } as never,
            'wgsl-uniform',
        );
        expect(view.getUint32(cfgMember.offset, true)).toBe(1); // enabled == 1 at EnvConfig offset
    });
});
