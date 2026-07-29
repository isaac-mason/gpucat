import { describe, expect, test } from 'vitest';
import {
    array,
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    compileGlsl,
    createStorageTexture,
    d,
    f32,
    Fn,
    GpuSampler,
    i32,
    If,
    Let,
    Loop,
    modelNormalMatrix,
    modelWorldMatrix,
    mrt,
    screenUV,
    select,
    struct,
    texture,
    Var,
    varying,
    vec3,
    vec4,
} from '../src/index';

/**
 * Golden GLSL regression net for the first GLSL-emitter vertical slice.
 *
 * compileGlsl() consumes the SAME neutral discover() output + node graph as the WGSL compile(), and
 * translates a "lit mesh" material to GLSL ES 3.00. This pins the emitted `.code` plus the primitive
 * structural metadata a backend consumes. A human validates real GL correctness later; the snapshot
 * guards against regressions in the emitter until then.
 *
 * Node ids are module-global and monotonic, so snapshots are stable only while this file's node-
 * creation sequence is unchanged.
 */

/** Extract only primitive, backend-neutral fields from a GLSL CompileResult. */
function renderShape(r: ReturnType<typeof compileGlsl>) {
    return {
        code: r.code,
        vertexEntryPoint: r.vertexEntryPoint,
        fragmentEntryPoint: r.fragmentEntryPoint,
        varyings: r.varyings.map((v) => ({ name: v.name, type: v.type, location: v.location })),
        uniformGroups: r.uniformGroups.map((g) => ({
            groupName: g.groupName,
            groupIndex: g.groupIndex,
            totalBytes: g.totalBytes,
            members: g.members.map((m) => ({ id: m.uniformId, offset: m.offset, size: m.size })),
        })),
        textures: r.textures.map((t) => ({ textureId: t.textureId, type: t.type, group: t.group, binding: t.binding })),
        samplers: r.samplers.map((s) => ({ samplerId: s.samplerId, type: s.type, group: s.group, binding: s.binding })),
        builtins: Array.from(r.builtinsUsed).sort(),
    };
}

describe('golden GLSL — render path', () => {
    test('lit mesh: attributes, camera/model uniforms, varying, vec math', () => {
        const position = attribute('position', d.vec3f);
        const normal = attribute('normal', d.vec3f);

        const worldPosition = modelWorldMatrix.mul(vec4(position, f32(1)));
        const clipPosition = cameraProjectionMatrix.mul(cameraViewMatrix.mul(worldPosition));
        const vWorldNormal = varying(modelNormalMatrix.mul(normal).normalize(), 'vNormal');

        const lightDir = vec3(0.6, 1.0, 0.8).normalize();
        const lighting = f32(0.15).add(vWorldNormal.dot(lightDir).max(f32(0)));
        const fragment = vec4(vec3(0.4, 0.7, 1.0).mul(lighting), f32(1));

        const result = compileGlsl({ vertex: clipPosition, fragment, depth: undefined });
        expect(renderShape(result)).toMatchSnapshot();
    });

    test('textured: combined-sampler uniform + texture() sampling on screenUV', () => {
        const tex = createStorageTexture(64, 64, 'rgba8unorm');
        const sampler = new GpuSampler({ minFilter: 'linear', magFilter: 'linear' });
        const color = texture(tex, sampler).sample(screenUV);

        const result = compileGlsl({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: color,
            depth: undefined,
        });
        expect(renderShape(result)).toMatchSnapshot();
    });

    test('select: fragment ternary from a bool condition', () => {
        const position = attribute('position', d.vec3f);
        const uv = varying(position.xy, 'vUV');
        const cond = uv.x.greaterThan(f32(0.5));
        const chosen = select(vec3(1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0), cond);
        const fragment = vec4(chosen, f32(1));

        const result = compileGlsl({
            vertex: vec4(position, f32(1)),
            fragment,
            depth: undefined,
        });
        // select(f, t, cond) must lower to a GLSL ternary, not mix.
        expect(result.code).toContain('?');
        expect(result.code).not.toContain('select(');
        expect(renderShape(result)).toMatchSnapshot();
    });

    test('control flow: Var + Loop + If accumulate in the fragment', () => {
        // A value-returning user Fn body exercises Var/Let/Loop/If/Assign statements.
        const accumulate = Fn(
            () => {
                const sum = Var('sum', f32(0));
                Loop(8, ({ i }) => {
                    If(i.lessThan(i32(4)), () => {
                        sum.assign(sum.add(i.toF32()));
                    }).Else(() => {
                        sum.assign(sum.add(f32(1)));
                    });
                });
                const scaled = Let('scaled', sum.mul(f32(0.1)));
                return scaled;
            },
            { name: 'accumulate', params: [] as const, return: d.f32 },
        );

        const fragment = vec4(vec3(0.2, 0.4, 0.6).mul(accumulate()), f32(1));

        const result = compileGlsl({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment,
            depth: undefined,
        });
        expect(result.code).toContain('for (int');
        expect(result.code).toContain('if (');
        expect(renderShape(result)).toMatchSnapshot();
    });

    test('user function: define an Fn and call it in the fragment', () => {
        const luminance = Fn(
            (c: ReturnType<typeof vec3>) => c.dot(vec3(0.299, 0.587, 0.114)),
            { name: 'luminance', params: [{ name: 'c', type: d.vec3f }] as const, return: d.f32 },
        );

        const base = vec3(0.8, 0.3, 0.1);
        const l = luminance(base);
        const fragment = vec4(vec3(l, l, l), f32(1));

        const result = compileGlsl({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment,
            depth: undefined,
        });
        // The function definition must appear before main().
        expect(result.code).toContain('float luminance(vec3 c)');
        expect(result.code.indexOf('float luminance(')).toBeLessThan(result.code.indexOf('void main()'));
        expect(renderShape(result)).toMatchSnapshot();
    });

    test('struct construct + field access in the fragment', () => {
        const Material = struct('Material', { albedo: d.vec3f, roughness: d.f32 });
        const m = Material.construct({ albedo: vec3(0.9, 0.4, 0.2), roughness: f32(0.3) });
        const fragment = vec4(m.field('albedo').mul(m.field('roughness')), f32(1));

        const result = compileGlsl({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment,
            depth: undefined,
        });
        // The struct declaration must precede its use and main().
        expect(result.code).toContain('struct Material {');
        expect(result.code).toContain('Material(');
        expect(result.code).toContain('.albedo');
        expect(result.code.indexOf('struct Material {')).toBeLessThan(result.code.indexOf('Material('));
        expect(renderShape(result)).toMatchSnapshot();
    });

    test('array construct used in the fragment', () => {
        const palette = array([vec3(1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0), vec3(0.0, 0.0, 1.0)]);
        const fragment = vec4(palette.element(i32(1)), f32(1));

        const result = compileGlsl({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment,
            depth: undefined,
        });
        // GLSL array constructor: vec3[3](...).
        expect(result.code).toContain('vec3[3](');
        expect(renderShape(result)).toMatchSnapshot();
    });

    test('MRT: two fragment outputs → two layout(location=N) out decls + assignments', () => {
        const color = vec4(vec3(0.8, 0.2, 0.1), f32(1));
        const normal = vec4(vec3(0.0, 0.0, 1.0), f32(1));
        const fragment = mrt({ color, normal });

        const result = compileGlsl({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment,
            depth: undefined,
        });
        // Each MRT output lowers to its own `out vec4` at a distinct location + a main() assignment.
        expect(result.code).toContain('layout(location = 0) out vec4 color;');
        expect(result.code).toContain('layout(location = 1) out vec4 normal;');
        expect(result.code).toContain('color = ');
        expect(result.code).toContain('normal = ');
        // No single fragColor output when MRT is active.
        expect(result.code).not.toContain('out vec4 fragColor');
        expect(renderShape(result)).toMatchSnapshot();
    });
});
