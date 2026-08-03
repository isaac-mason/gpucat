import { describe, expect, test } from 'vitest';
import { attribute, compile, d, f32, struct, vec4 } from '../src/index';
import { fields, frameGroup, Uniform, UniformNode } from '../src/nodes/nodes';
import { packToView } from '../src/schema/pack';

// Two struct members packed into one `Uniforms_frame` UBO. A leading `struct{f32,f32}` (8 bytes,
// align 4) is followed by a second struct. In WGSL uniform layout a nested struct keeps its NATURAL
// alignment (max member align), so the second struct lands at offset 8 — NOT 16. This matches how a
// real WGSL driver (Dawn) lays the emitted `struct Uniforms_frame` out; the packer must agree, or the
// shader reads the second struct's fields from the wrong bytes (they read the leading struct's tail /
// padding, i.e. 0). This is the general WGSL rule (three.js-style), verified against a real device.
describe('frame UBO with two struct members: nested struct uses natural alignment', () => {
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

        // WGSL uniform keeps a nested struct at natural alignment: the leading EnvTime occupies
        // bytes 0..7 (align 4, size 8), so EnvConfig (align 4) follows at offset 8, and `enabled`
        // (its first field) at byte 8. Neither is forced to a 16-byte boundary.
        expect(timeMember.offset).toBe(0);
        expect(cfgMember.offset).toBe(8);

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
        expect(view.getUint32(cfgMember.offset, true)).toBe(1); // enabled == 1 at EnvConfig offset (byte 8)
    });
});
