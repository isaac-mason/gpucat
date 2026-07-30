import {
    acesToneMapping,
    array,
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    compileGlsl,
    compileTransformFeedback,
    createStorageTexture,
    d,
    f32,
    sRGBTransferOETF,
    Fn,
    glslFn,
    GpuSampler,
    i32,
    If,
    instanceIndex,
    Let,
    Loop,
    modelNormalMatrix,
    modelWorldMatrix,
    mrt,
    type Node,
    screenUV,
    vec2i,
    vertexIndex,
    select,
    struct,
    texture,
    transformFeedback,
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
 * A transform-feedback compile+link case (Phase 1 gate #2). `build()` produces a
 * TransformFeedbackGlslResult; the harness compiles the vertex+fragment shaders AND links them as a
 * transform-feedback program (transformFeedbackVaryings set before linkProgram), mirroring
 * tst/tf-probe/run.mjs.
 */
export interface TfCase {
    name: string;
    build: () => ReturnType<typeof compileTransformFeedback>;
}

export const tfCases: TfCase[] = [
    {
        // Particles: pos += vel per element. Two vec4 attributes in, one captured varying out.
        name: 'tf particles (pos += vel)',
        build: () =>
            compileTransformFeedback(
                transformFeedback((io) => ({ pos: io.pos.add(io.vel) }), {
                    inputs: { pos: d.vec4f, vel: d.vec4f },
                    outputs: { pos: d.vec4f },
                    name: 'particles',
                }),
            ),
    },
    {
        // Neighbour gather via textureLoad in the vertex stage: read a data texel by element index and
        // fold it into the output. Exercises texelFetch inside a TF kernel + a combined sampler binding.
        name: 'tf neighbour (textureLoad gather)',
        build: () => {
            const data = createStorageTexture(1024, 1, 'rgba32float');
            const sampler = new GpuSampler({});
            return compileTransformFeedback(
                transformFeedback(
                    (io) => {
                        const i = vertexIndex.toI32();
                        const neighbour = texture(data, sampler).load(vec2i(i.add(i32(1)), i32(0)), i32(0));
                        return { pos: io.pos.add(neighbour.mul(f32(0.5))) };
                    },
                    { inputs: { pos: d.vec4f }, outputs: { pos: d.vec4f }, name: 'neighbour' },
                ),
            );
        },
    },
    {
        // Regression for the exact particles-example shape that surfaced bugs 2a + 2b together, through
        // the transform-feedback path: a shared Fn named after a GLSL builtin (`step`) whose return
        // expression hoists CSE locals (an intermediate `next` used 3×) and calls a second Fn (`wrap`)
        // per-component. Pre-fix this failed to compile (undeclared `_vN` + builtin redeclaration).
        name: 'tf step/wrap (builtin-named Fn + return CSE)',
        build: () => {
            const wrap = Fn(
                (x: Node<d.f32>) => x.sub(x.mul(f32(0.5)).add(x)),
                { name: 'wrap', params: [{ name: 'x', type: d.f32 }] as const, return: d.f32 },
            );
            const step = Fn(
                (pos: Node<d.vec4f>, vel: Node<d.vec4f>, dt: Node<d.f32>) => {
                    const next = pos.add(vel.mul(dt));
                    return vec4(wrap(next.x), wrap(next.y), wrap(next.z), pos.w);
                },
                {
                    name: 'step',
                    params: [
                        { name: 'pos', type: d.vec4f },
                        { name: 'vel', type: d.vec4f },
                        { name: 'dt', type: d.f32 },
                    ] as const,
                    return: d.vec4f,
                },
            );
            const dt = f32(0.016);
            return compileTransformFeedback(
                transformFeedback((io) => ({ pos: step(io.pos, io.vel, dt) }), {
                    inputs: { pos: d.vec4f, vel: d.vec4f },
                    outputs: { pos: d.vec4f },
                    name: 'particles-step',
                }),
            );
        },
    },
];

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
        // Regression: an MRT target named `output` is a GLSL ES 3.00 reserved word — the emitter must
        // mangle it (out_output) or the fragment shader fails to compile ("Illegal use of reserved word").
        name: 'mrt reserved output name',
        build: () => {
            const position = attribute('position', d.vec3f);
            const normal = attribute('normal', d.vec3f);
            const vNormal = varying(modelNormalMatrix.mul(normal).normalize(), 'vNormal');
            const lit = vec4(vec3(0.4, 0.7, 1.0).mul(vNormal.dot(vec3(0, 0, 1).normalize()).max(f32(0))), f32(1));
            const fragment = mrt({
                output: lit, // reserved word → must be mangled
                normal: vec4(vNormal, f32(1)),
                diffuse: vec4(0.5, 0.5, 0.5, 1),
            });
            return { vertex: vec4(position, f32(1)), fragment, depth: undefined };
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
    {
        // Bug 1 regression: dpdx/dpdy/fwidth must emit valid GLSL ES 3.00 (dFdx/dFdy/fwidth), not the
        // literal WGSL names. Fragment-only; must compile + link under real WebGL2.
        name: 'derivatives (dpdx/dpdy/fwidth)',
        build: () => {
            const position = attribute('position', d.vec3f);
            const uv = varying(position.xy, 'vUV');
            const edge = uv.x.dpdx().add(uv.y.dpdy()).add(uv.x.fwidth());
            return {
                vertex: vec4(position, f32(1)),
                fragment: vec4(vec3(edge, edge, edge), f32(1)),
                depth: undefined,
            };
        },
    },
    {
        // Bug 2 + Bug 4 regression: a u32 varying (from @builtin(vertex_index)/instance_index) MUST be
        // declared `flat` (integer varyings are un-linkable otherwise), and the builtin index must be
        // uint(gl_VertexID)/uint(gl_InstanceID) to match its u32 type. Compile + link under WebGL2.
        name: 'flat integer varying (u32 vertex/instance index)',
        build: () => {
            const id = varying(vertexIndex.add(instanceIndex), 'vId');
            const f = id.toF32().mul(f32(0.01));
            return {
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment: vec4(vec3(f, f, f), f32(1)),
                depth: undefined,
            };
        },
    },
    {
        // Bug 3 regression: a frag_depth override (Material.depth) alongside a color output must write
        // gl_FragDepth in the fragment main() and still compile + link under real WebGL2.
        name: 'frag_depth override (color + depth)',
        build: () => {
            const position = attribute('position', d.vec3f);
            const depth = f32(0.25).add(varying(position.z, 'vZ').mul(f32(0.5)));
            return {
                vertex: vec4(position, f32(1)),
                fragment: vec4(vec3(0.4, 0.7, 1.0), f32(1)),
                depth,
            };
        },
    },
    {
        // Bug 3 regression: depth-only material (no color output). A fragment stage must still exist and
        // write gl_FragDepth. Compile + link under real WebGL2.
        name: 'frag_depth override (depth-only)',
        build: () => {
            const position = attribute('position', d.vec3f);
            return {
                vertex: vec4(position, f32(1)),
                fragment: undefined,
                depth: f32(0.75),
            };
        },
    },
    {
        // Bug (duplicate attribute decl) regression: ONE named attribute (`uv`) read via FOUR SEPARATE
        // `attribute('uv')` nodes (same name, distinct node ids) — mirrors the MRT example where several
        // varyings each pull `uv`. The GLSL emitter must dedup named attributes BY NAME so `a_uv` is
        // declared exactly ONCE (`layout(location=N) in vec2 a_uv;`); otherwise the vertex shader emits
        // `in a_uv` four times and fails to compile (redefinition).
        name: 'shared named attribute → multiple varyings',
        build: () => {
            const position = attribute('position', d.vec3f);
            // Four distinct attribute('uv') nodes, each feeding its own varying.
            const vA = varying(attribute('uv', d.vec2f).x, 'vA');
            const vB = varying(attribute('uv', d.vec2f).y, 'vB');
            const vC = varying(attribute('uv', d.vec2f).x.add(attribute('uv', d.vec2f).y), 'vC');
            const vD = varying(attribute('uv', d.vec2f).x.mul(f32(2)), 'vD');
            const fragment = vec4(vec3(vA.add(vB), vC, vD), f32(1));
            return { vertex: vec4(position, f32(1)), fragment, depth: undefined };
        },
    },
    {
        // Bug 2a regression (CSE decls lost in Fn return expr): a shared multi-param Fn whose RETURN
        // expression contains (a) an intermediate value used 3× (→ CSE hoists a `_vN` local that must be
        // DECLARED inside the body, not just referenced) and (b) a param used 2×. Mirrors the particles
        // `step`/`wrap` shape. If the return-expr string is generated AFTER flushing the body's code, the
        // `_vN = ...;` decls are dropped and `_vN` is undeclared → won't compile.
        name: 'Fn return-expr CSE decls (intermediate used 3x)',
        build: () => {
            // wrap(x): x - 2*round(x/2) — the sub-expression `round(x/2)` is a plain param use.
            const wrap = Fn(
                (x: Node<d.f32>) => x.sub(x.mul(f32(0.5)).add(x)),
                { name: 'wrap', params: [{ name: 'x', type: d.f32 }] as const, return: d.f32 },
            );
            // next = pos + vel*dt; the return uses `next` 3× (CSE) and the `pos` param twice.
            const advance = Fn(
                (pos: Node<d.vec3f>, vel: Node<d.vec3f>, dt: Node<d.f32>) => {
                    const next = pos.add(vel.mul(dt));
                    return vec3(wrap(next.x).add(pos.x), wrap(next.y).add(pos.y), wrap(next.z));
                },
                {
                    name: 'advance',
                    params: [
                        { name: 'pos', type: d.vec3f },
                        { name: 'vel', type: d.vec3f },
                        { name: 'dt', type: d.f32 },
                    ] as const,
                    return: d.vec3f,
                },
            );
            const position = attribute('position', d.vec3f);
            // Call the Fn in the VERTEX stage (it reads the `position` attribute), then pass the result
            // to the fragment via a varying.
            const moved = advance(position, vec3(0.1, 0.2, 0.3), f32(0.5));
            const vMoved = varying(moved, 'vMoved');
            return { vertex: vec4(position, f32(1)), fragment: vec4(vMoved, f32(1)), depth: undefined };
        },
    },
    {
        // Bug 2b regression: a user Fn named after a GLSL builtin (`step`). GLSL rejects redeclaring a
        // builtin (`vec4 step(...)` → "Name of a built-in function cannot be redeclared"), so the emitter
        // must mangle the name (→ `fn_step`) consistently at the definition AND the call site. Must
        // compile + link under real WebGL2.
        name: 'Fn named after GLSL builtin (step)',
        build: () => {
            const step = Fn(
                (x: Node<d.f32>) => x.mul(f32(2)).add(f32(1)),
                { name: 'step', params: [{ name: 'x', type: d.f32 }] as const, return: d.f32 },
            );
            const position = attribute('position', d.vec3f);
            // Call the builtin-named Fn in the VERTEX stage (reads the attribute), pass via a varying.
            const s = varying(step(position.x), 'vStep');
            return { vertex: vec4(position, f32(1)), fragment: vec4(vec3(s, s, s), f32(1)), depth: undefined };
        },
    },
];
