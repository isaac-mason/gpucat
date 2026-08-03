import { describe, expect, test } from 'vitest';
import { add, attribute, compile, d, f32, mix, struct, u32, vec4 } from '../src/index';
import { fields, frameGroup, Uniform, uniform } from '../src/nodes/nodes';

/**
 * A shared uniform group (e.g. frameGroup) backs one buffer that is reused across every
 * material referencing the same set of its uniforms; the BindGroup is cached by an
 * order-independent key (sorted node ids). So the group's byte layout must be deterministic
 * for a given set, independent of the per-material graph traversal order in which the
 * uniforms happen to be discovered. If not, the first material to compile a set caches its
 * layout, and a later material with the same set but a different discovery order reuses that
 * block while its own shader was compiled to a different layout, so the packer writes at one
 * offset and the shader reads at another (silent garbage).
 *
 * gpucat orders shared-group members by stable node id at emit time (mirrors three.js
 * NodeBuilder._getBindGroup) so a given set always yields one layout. This guards that.
 */
describe('shared uniform group layout is stable across reference order', () => {
    const EnvTime = struct('EnvTime', { time: d.f32, wallTime: d.f32 });
    const EnvConfig = struct('EnvConfig', { enabled: d.u32, sunEnabled: d.u32, sunIntensity: d.f32 });
    const skySchema = d.sizedArray(d.vec3f, 12);

    // Engine-global nodes: created once and shared by every material (as makecat's environment
    // resources do), so their node ids are stable across compilations.
    const timeN = fields(uniform(new Uniform(EnvTime, { time: 0.6, wallTime: 0 }, frameGroup))) as unknown as {
        time: ReturnType<typeof f32>;
    };
    const cfgN = fields(uniform(new Uniform(EnvConfig, { enabled: 1, sunEnabled: 0, sunIntensity: 1 }, frameGroup))) as unknown as {
        enabled: { toF32: () => ReturnType<typeof f32> };
    };
    const skyN = uniform(new Uniform(skySchema, new Array(12).fill([0.1, 0.4, 0.9]), frameGroup)) as unknown as {
        element: (i: ReturnType<typeof u32>) => ReturnType<typeof f32>;
    };

    // Compile a material reading all three shared uniforms, in a chosen reference order.
    function frameLayout(order: 'cfg-first' | 'sky-first'): Map<number, number> {
        const t = timeN.time;
        const c = cfgN.enabled.toF32();
        const s = mix(skyN.element(u32(0)), skyN.element(u32(1)), f32(0.5)) as never as ReturnType<typeof f32>;
        const frag =
            order === 'cfg-first'
                ? add(add(c as never, t as never) as never, s as never)
                : add(add(s as never, t as never) as never, c as never);

        const r = compile({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: vec4(frag as never, f32(0), f32(0), f32(1)),
            depth: undefined,
        });
        const group = r.uniformGroups.find((g) => g.members.some((m) => (m.schema as { type?: string }).type === 'sized-array'));
        return new Map((group?.members ?? []).map((m) => [m.node.id, m.offset]));
    }

    test('same shared set yields identical member offsets regardless of reference order', () => {
        const a = frameLayout('cfg-first');
        const b = frameLayout('sky-first');

        // Same three shared uniforms, so each (keyed by its stable node id) must land at the same
        // byte offset in both compilations.
        expect([...a.keys()].sort((x, y) => x - y)).toEqual([...b.keys()].sort((x, y) => x - y));
        for (const [id, off] of a) {
            expect(b.get(id), `uniform ${id} must have a stable offset across reference orders`).toBe(off);
        }
    });
});
