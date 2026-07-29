import {
    acesToneMapping,
    array,
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    compileGlsl,
    createStorageTexture,
    d,
    f32,
    sRGBTransferOETF,
    Fn,
    glslFn,
    GpuSampler,
    i32,
    If,
    Let,
    Loop,
    modelNormalMatrix,
    modelWorldMatrix,
    mrt,
    type Node,
    screenUV,
    select,
    struct,
    texture,
    Var,
    varying,
    vec3,
    vec3b,
    vec4,
    wgsl,
    wgslFn,
} from '../../src/index';

export type Slots = Parameters<typeof compileGlsl>[0];
export type GlslOpts = Parameters<typeof compileGlsl>[1];

export interface Case {
    name: string;
    build: () => Slots;
    /** Optional GLSL emitter options (e.g. `{ precision: 'mediump' }`) passed to compileGlsl. */
    opts?: GlslOpts;
}

/**
 * The 8 golden GLSL cases, copied verbatim from tst/glsl-golden.test.ts.
 * Each `build()` constructs fresh nodes so a throw is caught per-case.
 */
export const cases: Case[] = [
    {
        name: 'lit mesh',
        build: () => {
            const position = attribute('position', d.vec3f);
            const normal = attribute('normal', d.vec3f);

            const worldPosition = modelWorldMatrix.mul(vec4(position, f32(1)));
            const clipPosition = cameraProjectionMatrix.mul(cameraViewMatrix.mul(worldPosition));
            const vWorldNormal = varying(modelNormalMatrix.mul(normal).normalize(), 'vNormal');

            const lightDir = vec3(0.6, 1.0, 0.8).normalize();
            const lighting = f32(0.15).add(vWorldNormal.dot(lightDir).max(f32(0)));
            const fragment = vec4(vec3(0.4, 0.7, 1.0).mul(lighting), f32(1));

            return { vertex: clipPosition, fragment, depth: undefined };
        },
    },
    {
        name: 'textured',
        build: () => {
            const tex = createStorageTexture(64, 64, 'rgba8unorm');
            const sampler = new GpuSampler({ minFilter: 'linear', magFilter: 'linear' });
            const color = texture(tex, sampler).sample(screenUV);

            return {
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment: color,
                depth: undefined,
            };
        },
    },
    {
        name: 'select ternary',
        build: () => {
            const position = attribute('position', d.vec3f);
            const uv = varying(position.xy, 'vUV');
            const cond = uv.x.greaterThan(f32(0.5));
            const chosen = select(vec3(1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0), cond);
            const fragment = vec4(chosen, f32(1));

            return {
                vertex: vec4(position, f32(1)),
                fragment,
                depth: undefined,
            };
        },
    },
    {
        name: 'control flow (Var/Loop/If)',
        build: () => {
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

            return {
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment,
                depth: undefined,
            };
        },
    },
    {
        name: 'user function',
        build: () => {
            const luminance = Fn(
                (c: Node<d.vec3f>) => c.dot(vec3(0.299, 0.587, 0.114)),
                { name: 'luminance', params: [{ name: 'c', type: d.vec3f }] as const, return: d.f32 },
            );

            const base = vec3(0.8, 0.3, 0.1);
            const l = luminance(base);
            const fragment = vec4(vec3(l, l, l), f32(1));

            return {
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment,
                depth: undefined,
            };
        },
    },
    {
        name: 'struct',
        build: () => {
            const Material = struct('Material', { albedo: d.vec3f, roughness: d.f32 });
            const m = Material.construct({ albedo: vec3(0.9, 0.4, 0.2), roughness: f32(0.3) });
            const fragment = vec4(m.field('albedo').mul(m.field('roughness')), f32(1));

            return {
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment,
                depth: undefined,
            };
        },
    },
    {
        name: 'array',
        build: () => {
            const palette = array([vec3(1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0), vec3(0.0, 0.0, 1.0)]);
            const fragment = vec4(palette.element(i32(1)), f32(1));

            return {
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment,
                depth: undefined,
            };
        },
    },
    {
        // Exercises the newly-mapped bvec path: a vec3<bool> (GLSL bvec3) produced by a componentwise
        // comparison, stored in a Var (forcing a `bvec3` type declaration in the emitted GLSL), then
        // reduced to a scalar bool via `all()` to drive a select. Confirms the bvec3 glslType mapping
        // actually compiles + links under real WebGL2.
        name: 'bvec3 (comparison + all + select)',
        build: () => {
            const position = attribute('position', d.vec3f);
            const uv = varying(position, 'vPos');
            // Build a vec3<bool> (GLSL bvec3) from scalar componentwise comparisons; storing it in a
            // Var forces a `bvec3` type declaration + a `bvec3(...)` constructor in the emitted GLSL.
            const mask = Var(
                'mask',
                vec3b(uv.x.greaterThan(f32(0.5)), uv.y.greaterThan(f32(0.5)), uv.z.greaterThan(f32(0.5))),
            );
            const cond = mask.all();
            const chosen = select(vec3(1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0), cond);
            const fragment = vec4(chosen, f32(1));

            return {
                vertex: vec4(position, f32(1)),
                fragment,
                depth: undefined,
            };
        },
    },
    {
        name: 'MRT',
        build: () => {
            const color = vec4(vec3(0.8, 0.2, 0.1), f32(1));
            const normal = vec4(vec3(0.0, 0.0, 1.0), f32(1));
            const fragment = mrt({ color, normal });

            return {
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment,
                depth: undefined,
            };
        },
    },
    {
        // Regression: sRGBTransferOETF/acesToneMapping internally do a componentwise vector comparison
        // (`color <= vec3(...)` → bvec) feeding a componentwise `select`. GLSL rejects `<=` on vectors
        // and can't ternary on a bvec — these must lower to lessThanEqual(...) + mix(f, t, cond).
        name: 'color-space builtins (vector compare + componentwise select)',
        build: () => ({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: vec4(acesToneMapping(sRGBTransferOETF(vec3(0.5, 0.2, 0.8))), f32(1)),
            depth: undefined,
        }),
    },
    {
        // Proves the WebGL-backend `precision` option: compileGlsl(slots, { precision: 'mediump' })
        // must emit `precision mediump float;` (not the default highp) and still compile + link under
        // real WebGL2. WGSL has no precision qualifier, so this is a GLSL-only concern.
        name: 'precision mediump',
        opts: { precision: 'mediump' },
        build: () => {
            const position = attribute('position', d.vec3f);
            const lighting = f32(0.15).add(varying(position, 'vPos').dot(vec3(0.6, 1.0, 0.8)).max(f32(0)));
            return {
                vertex: vec4(position, f32(1)),
                fragment: vec4(vec3(0.4, 0.7, 1.0).mul(lighting), f32(1)),
                depth: undefined,
            };
        },
    },
    {
        // GLSL escape hatch, standalone glslFn: a raw GLSL helper compiles + links under real WebGL2.
        // glslFn is GLSL-only (no WGSL variant), so this exercises the missing-variant-free GLSL path.
        name: 'glslFn (standalone GLSL helper)',
        build: () => {
            const tint = glslFn(`vec3 tint(vec3 c, float k) { return c * k; }`, {
                name: 'tint',
                output: d.vec3f,
                params: [
                    { name: 'c', type: d.vec3f },
                    { name: 'k', type: d.f32 },
                ] as const,
            });
            const fragment = vec4(tint(vec3(0.8, 0.3, 0.1), f32(0.5)), f32(1));
            return {
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment,
                depth: undefined,
            };
        },
    },
    {
        // Cross-backend wgslFn WITH a `glsl` companion: the same node runs on WebGPU (WGSL source) and
        // WebGL (companion). This case compiles + links the GLSL companion under real WebGL2.
        name: 'wgslFn + glsl companion',
        build: () => {
            const luma = wgslFn(
                `fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }`,
                {
                    output: d.f32,
                    params: [{ name: 'c', type: d.vec3f }] as const,
                    glsl: `float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }`,
                },
            );
            // Also exercise the inline wgsl``.glslSource`` companion path.
            const base = vec3(0.8, 0.3, 0.1);
            const l = luma(base);
            const boosted = wgsl(d.f32)`(${l} * 1.5)`.glslSource`(${l} * 1.5)`;
            const fragment = vec4(base.mul(boosted), f32(1));
            return {
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment,
                depth: undefined,
            };
        },
    },
];
