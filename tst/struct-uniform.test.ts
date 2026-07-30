import { describe, expect, test } from 'vitest';
import { attribute, compile, d, f32, struct, uniform, vec4 } from '../src/index';
import { fields, frameGroup, Uniform, UniformNode } from '../src/nodes/nodes';
import { packToView } from '../src/schema/pack';

// Regression: discover() used to walk types for struct definitions only through storage bindings, so
// a struct reached solely via a uniform was never registered and the WGSL emitter referenced an
// undeclared type (`env: EnvConfig` with no `struct EnvConfig`). Walking uniform types in discover()
// fixes it for every backend. (The GLSL path already worked via its walk-all-nodes augmentation.)
describe('struct-typed uniform declares its struct on the WGSL path', () => {
    test('render: a UBO member of struct type gets its `struct` emitted before it is referenced', () => {
        const EnvConfig = struct('EnvConfig', { intensity: d.f32, tint: d.vec3f });
        const env = uniform('env', EnvConfig);
        const fragment = vec4(env.tint.mul(env.intensity), f32(1));

        const result = compile({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment,
            depth: undefined,
        });

        expect(result.code).toContain('struct EnvConfig');
        expect(result.code).toMatch(/env:\s*EnvConfig/);
        // Declaration must precede the reference.
        expect(result.code.indexOf('struct EnvConfig')).toBeLessThan(result.code.search(/env:\s*EnvConfig/));
    });

    // Matches the makecat.io shape: value-based struct uniforms auto-named `uniform_NNN`, packed into a
    // shared frame UBO (`struct Uniforms_frame { uniform_307: EnvTime, uniform_310: EnvConfig }`). These
    // reach the graph via `uniform(new Uniform(structDef, ...))`, never through a storage binding.
    test('frame UBO with value-based struct uniforms declares every member struct', () => {
        const EnvTime = struct('EnvTime', { elapsed: d.f32, delta: d.f32 });
        const EnvConfig = struct('EnvConfig', { fogColor: d.vec3f, fogDensity: d.f32 });

        const time = fields(new UniformNode(new Uniform(EnvTime, undefined, frameGroup), 'uniform_307') as never) as never as {
            elapsed: ReturnType<typeof f32>;
        };
        const config = fields(
            new UniformNode(new Uniform(EnvConfig, undefined, frameGroup), 'uniform_310') as never,
        ) as never as { fogColor: { mul: (x: unknown) => ReturnType<typeof f32> } };

        const fragment = vec4(config.fogColor.mul(time.elapsed), f32(1));

        const result = compile({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment,
            depth: undefined,
        });

        expect(result.code).toContain('struct EnvTime');
        expect(result.code).toContain('struct EnvConfig');
        expect(result.code).toMatch(/uniform_307:\s*EnvTime/);
        expect(result.code).toMatch(/uniform_310:\s*EnvConfig/);
        // No unresolved type: every referenced struct name is also declared.
        expect(result.code.indexOf('struct EnvTime')).toBeLessThan(result.code.search(/uniform_307:\s*EnvTime/));
    });

    // Render-time pack path (mirrors bindings.ts packAndCompare): allocate block.totalBytes, then
    // packToView every struct member at its emitted m.offset with a real value. A layout/size mismatch
    // between emit (which sizes the buffer via layoutSizeOf) and pack (which writes via compileLayout)
    // would throw `RangeError: Offset is outside the bounds of the DataView` — the makecat symptom.
    test('packing struct uniforms into a frame UBO stays within block.totalBytes', () => {
        const EnvTime = struct('EnvTime', { elapsed: d.f32, delta: d.f32 });
        const EnvConfig = struct('EnvConfig', { fogColor: d.vec3f, fogDensity: d.f32 });

        const time = fields(new UniformNode(new Uniform(EnvTime, undefined, frameGroup), 'uniform_307') as never) as never as {
            elapsed: ReturnType<typeof f32>;
        };
        const config = fields(
            new UniformNode(new Uniform(EnvConfig, undefined, frameGroup), 'uniform_310') as never,
        ) as never as { fogColor: { mul: (x: unknown) => ReturnType<typeof f32> } };

        const result = compile({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: vec4(config.fogColor.mul(time.elapsed), f32(1)),
            depth: undefined,
        });

        const values: Record<string, unknown> = {
            uniform_307: { elapsed: 1.5, delta: 0.016 },
            uniform_310: { fogColor: [0.1, 0.2, 0.3], fogDensity: 0.5 },
        };

        for (const block of result.uniformGroups) {
            const buf = new ArrayBuffer(block.totalBytes);
            const view = new DataView(buf);
            for (const m of block.members) {
                const value = values[m.uniformId];
                if (value === undefined) continue;
                // The write must stay in bounds — this is exactly what packAndCompare does.
                expect(() => packToView(m.schema, view, m.offset, value as never, 'wgsl-uniform')).not.toThrow();
                // And the member's own extent must fit the allocated block.
                expect(m.offset + m.size).toBeLessThanOrEqual(block.totalBytes);
            }
        }
    });
});
