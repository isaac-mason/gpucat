import {
    ArrayTexture,
    acesToneMapping,
    array,
    arrayTexture,
    atan2,
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    comparisonSampler,
    type compileGlsl,
    compileTransformFeedback,
    createStorageTexture,
    d,
    depthTexture,
    Fn,
    f32,
    fxaa,
    GpuSampler,
    GpuTexture,
    glslFn,
    If,
    i32,
    instanceIndex,
    inverseSqrt,
    Let,
    Loop,
    modelNormalMatrix,
    modelWorldMatrix,
    mrt,
    type Node,
    screenUV,
    select,
    sRGBTransferOETF,
    storage,
    struct,
    texture,
    textureNumLayers,
    textureSampleCompare,
    textureSampleCompareLevel,
    transformFeedback,
    u32,
    uniform,
    Var,
    varying,
    vec2f,
    vec2i,
    vec3,
    vec3b,
    vec3i,
    vec4,
    vec4u,
    vertexIndex,
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
            const wrap = Fn((x: Node<d.f32>) => x.sub(x.mul(f32(0.5)).add(x)), {
                name: 'wrap',
                params: [{ name: 'x', type: d.f32 }] as const,
                return: d.f32,
            });
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
    {
        // Transform-feedback twin of the FXAA bug: a texture sampled ONLY inside a helper Fn body (not
        // directly in the kernel). The combined sampler is registered while the Fn body is emitted, so
        // emitting the sampler declarations before the functions would leave `u_t0` undeclared. Pre-fix
        // this failed to compile (undeclared identifier); the reorder in compileTransformFeedback fixes it.
        name: 'tf gather inside a Fn (sampler registered during fn-body emit)',
        build: () => {
            const data = createStorageTexture(1024, 1, 'rgba32float');
            const sampler = new GpuSampler({});
            const gather = Fn((i: Node<d.i32>) => texture(data, sampler).load(vec2i(i.add(i32(1)), i32(0)), i32(0)), {
                name: 'gather',
                params: [{ name: 'i', type: d.i32 }] as const,
                return: d.vec4f,
            });
            return compileTransformFeedback(
                transformFeedback((io) => ({ pos: io.pos.add(gather(vertexIndex.toI32()).mul(f32(0.5))) }), {
                    inputs: { pos: d.vec4f },
                    outputs: { pos: d.vec4f },
                    name: 'gather-fn',
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
        // Regression: an ARRAY texture lowers to `sampler2DArray`, which (unlike sampler2D/samplerCube)
        // has NO built-in default precision in GLSL ES 3.00. The combined-sampler uniform is declared at
        // global scope — visible to the VERTEX stage too — so without a `precision highp sampler2DArray;`
        // default, the vertex shader fails to compile ("No precision specified"). Exercises the emitter's
        // per-sampler-type precision-default block.
        name: 'array texture (sampler2DArray precision)',
        build: () => {
            const tex = new ArrayTexture(new Uint8Array(64 * 64 * 4 * 2), 64, 64, 2);
            const color = arrayTexture(tex, i32(0)).sample(screenUV);

            return {
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment: color,
                depth: undefined,
            };
        },
    },
    {
        // Regression: WGSL operators/builtins whose GLSL ES 3.00 spelling differs. `%` on FLOATS is the
        // `mod()` builtin (GLSL `%` is integer-only — `float % float` is a compile error); atan2 /
        // inverseSqrt rename to atan / inversesqrt ("no matching function" otherwise). Voxel materials
        // hit float mod (UV/anim wrapping). (The integer bit-count builtins are ES 3.10+ and are rejected
        // with a clear message, not renamed — a separate unit test covers that.)
        name: 'renamed builtins + float mod (GLSL spellings)',
        build: () => {
            const m = f32(5.5).mod(f32(2.0)); // float % → mod()
            const a = atan2(f32(0.5), f32(1.0)); // → atan(y, x)
            const s = inverseSqrt(f32(4.0)); // → inversesqrt
            const acc = m.add(a).add(s);

            return {
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment: vec4(acc, acc, acc, f32(1)),
                depth: undefined,
            };
        },
    },
    {
        // Regression: a texture sampled ONLY inside a user Fn body (FXAA's FxaaSample), reachable from
        // the fragment. The combined sampler is registered while that Fn body is emitted, which runs
        // AFTER the sampler-declaration pass — pre-fix the sampler was undeclared in BOTH stages (the
        // vertex just failed to compile first: "'u_pass2_output' : undeclared identifier"). Compiles +
        // links only when combined samplers are collected after the Fn bodies.
        name: 'fxaa fullscreen (texture sampled inside a Fn)',
        build: () => {
            const tex = createStorageTexture(64, 64, 'rgba8unorm');
            const sampler = new GpuSampler({ minFilter: 'linear', magFilter: 'linear' });
            return {
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment: fxaa(texture(tex, sampler)),
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
            const luminance = Fn((c: Node<d.vec3f>) => c.dot(vec3(0.299, 0.587, 0.114)), {
                name: 'luminance',
                params: [{ name: 'c', type: d.vec3f }] as const,
                return: d.f32,
            });

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
            const mask = Var('mask', vec3b(uv.x.greaterThan(f32(0.5)), uv.y.greaterThan(f32(0.5)), uv.z.greaterThan(f32(0.5))));
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
            const lighting = f32(0.15).add(
                varying(position, 'vPos')
                    .dot(vec3(0.6, 1.0, 0.8))
                    .max(f32(0)),
            );
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
            const luma = wgslFn(`fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }`, {
                output: d.f32,
                params: [{ name: 'c', type: d.vec3f }] as const,
                glsl: `float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }`,
            });
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
            const wrap = Fn((x: Node<d.f32>) => x.sub(x.mul(f32(0.5)).add(x)), {
                name: 'wrap',
                params: [{ name: 'x', type: d.f32 }] as const,
                return: d.f32,
            });
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
            const step = Fn((x: Node<d.f32>) => x.mul(f32(2)).add(f32(1)), {
                name: 'step',
                params: [{ name: 'x', type: d.f32 }] as const,
                return: d.f32,
            });
            const position = attribute('position', d.vec3f);
            // Call the builtin-named Fn in the VERTEX stage (reads the attribute), pass via a varying.
            const s = varying(step(position.x), 'vStep');
            return { vertex: vec4(position, f32(1)), fragment: vec4(vec3(s, s, s), f32(1)), depth: undefined };
        },
    },
    {
        // Mixed-kind binary operands. GLSL ES 3.00 has NO implicit numeric conversion, so `uint + int`
        // and `int * float` are hard compile errors unless one operand is wrapped in a conversion. The
        // emitter must coerce to the common kind (float wins; else the result kind). Pre-fix this failed
        // to compile ("no matching overloaded operator").
        name: 'mixed-kind binary operands (int/uint/float coercion)',
        build: () => {
            const a = u32(5).add(i32(3)); // uint + int → coerce int → uint
            const b = i32(3).mul(f32(2.0)); // int * float → coerce int → float
            return {
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment: vec4(vec3(a.toF32().add(b)), f32(1)),
                depth: undefined,
            };
        },
    },
    {
        // Componentwise select on an INTEGER vector. GLSL ES 3.00's bvec-selector `mix` overload exists
        // only for float genType (the int/uint/bool form is ES 3.20+), so an integer-vector select must
        // expand to a per-component ternary. Pre-fix this emitted `mix(ivec3, ivec3, bvec3)` → no match.
        name: 'integer-vector select (componentwise ternary)',
        build: () => {
            const picked = select(vec3i(4, 5, 6), vec3i(1, 2, 3), vec3b(true, false, true));
            return {
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment: vec4(vec3(picked.toF32()), f32(1)),
                depth: undefined,
            };
        },
    },
    {
        // Vertex-stage texture sample. GLSL ES 3.00's implicit-LOD `texture()` needs screen-space
        // derivatives that exist only in the fragment stage — sampling in the vertex stage must lower to
        // an explicit `textureLod(…, 0.0)`. Sampled inside a varying so the read happens in the vertex
        // stage. Pre-fix this failed to compile ("no matching overloaded function 'texture'").
        name: 'vertex-stage texture sample (implicit LOD → textureLod)',
        build: () => {
            const tex = createStorageTexture(4, 4, 'rgba8unorm');
            const smp = new GpuSampler({});
            const sampledInVertex = varying(texture(tex, smp).sample(vec2f(0.5, 0.5)));
            return { vertex: vec4(sampledInVertex.xyz, f32(1)), fragment: sampledInVertex, depth: undefined };
        },
    },
    {
        // textureNumLayers: a DSL builtin with no prior GLSL case. The array layer count lowers to
        // `uint(textureSize(name, 0).z)` (the z of a 2D-array's dimensions). Must compile + link.
        // (textureGather is intentionally NOT covered — it is a GLSL ES 3.10 builtin absent from WebGL2's
        // ES 3.00, so the emitter rejects it rather than emitting an un-compilable call.)
        name: 'textureNumLayers (array layer count)',
        build: () => {
            const layers = new ArrayTexture(new Uint8Array(4 * 4 * 4 * 2), 4, 4, 2);
            const layerCount = textureNumLayers(arrayTexture(layers, i32(0)).bindingNode);
            return {
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment: vec4(vec3(f32(layerCount)), f32(1)),
                depth: undefined,
            };
        },
    },
    {
        // Plain depth-texture READ (non-comparison sampler). GLSL ES 3.00 reads a depth texture through a
        // regular `sampler2D`, returning depth in .r — distinct from the shadow-compare path. Pre-fix the
        // node-method sampling threw ("plain depth-texture sampling not yet supported").
        name: 'plain depth read (sampler2D .x)',
        build: () => {
            const dtex = new GpuTexture(d.textureDepth2d, { width: 4, height: 4, format: 'depth24plus', usage: 6 });
            const depth = depthTexture(dtex, new GpuSampler({}));
            return {
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment: vec4(vec3(depth.sample(vec2f(0.5, 0.5))), f32(1)),
                depth: undefined,
            };
        },
    },
    {
        // Shadow compare sampling at implicit and explicit LOD. A comparison sampler → `sampler2DShadow`;
        // textureSampleCompare → `texture(shadow, vec3(uv, ref))`, textureSampleCompareLevel →
        // `textureLod(shadow, vec3(uv, ref), lod)`. Must compile + link on real WebGL2.
        name: 'shadow compare (sampler2DShadow, implicit + explicit LOD)',
        build: () => {
            const dtex = new GpuTexture(d.textureDepth2d, { width: 4, height: 4, format: 'depth24plus', usage: 6 });
            const depth = depthTexture(dtex, new GpuSampler({ compare: 'less' }));
            const cmp = comparisonSampler(new GpuSampler({ compare: 'less' }), 'less');
            const a = textureSampleCompare(depth.bindingNode, cmp, vec2f(0.5, 0.5), f32(0.5));
            const b = textureSampleCompareLevel(depth.bindingNode, cmp, vec2f(0.5, 0.5), f32(0.5), i32(0));
            return {
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment: vec4(vec3(a.add(b)), f32(1)),
                depth: undefined,
            };
        },
    },
    {
        // MRT with an INTEGER render target. The GLSL `out` type must come from the member node (uvec4
        // for a uint G-buffer id target), not a hardcoded vec4 — an integer value assigned to an
        // `out vec4` is a type error. Must compile + link.
        name: 'MRT integer target (uvec4 out)',
        build: () => ({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: mrt({
                color: vec4(1.0, 0.0, 0.0, 1.0),
                ids: vec4u(u32(7), u32(0), u32(0), u32(1)),
            }),
            depth: undefined,
        }),
    },
    {
        // CSE across a block boundary: a pure multi-use value first materialized inside an `if` body but
        // ALSO read after it. Pre-fix the emitter declared the CSE local inside the `if` block, so the
        // later read referenced an out-of-scope identifier (link error). The value depends only on the
        // function parameter, so it must hoist to the function-body top.
        name: 'CSE hoisted across block boundary (param-dependent)',
        build: () => {
            const compute = Fn(
                (x: Node<d.f32>) => {
                    const shared = x.mul(f32(3.0)).add(f32(1.0));
                    const acc = Var('acc', f32(0.0));
                    If(x.greaterThan(f32(0.5)), () => {
                        acc.assign(shared.mul(f32(2.0)));
                    });
                    return acc.add(shared);
                },
                { name: 'compute', params: [{ name: 'x', type: d.f32 }] as const, return: d.f32 },
            );
            return {
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment: vec4(vec3(compute(varying(attribute('position', d.vec3f).x, 'vX'))), f32(1)),
                depth: undefined,
            };
        },
    },
    {
        // Guard the fix above does NOT over-hoist: a multi-use value that depends on the LOOP INDEX must
        // stay inside the loop (hoisting it to the function top would reference the `for`-scoped index
        // before it exists). Must compile + link.
        name: 'CSE depending on loop index stays in-loop',
        build: () => {
            const loopy = Fn(
                () => {
                    const sum = Var('sum', f32(0));
                    Loop(4, ({ i }: { i: Node<d.i32> }) => {
                        const t = i.toF32().mul(f32(2.0)).add(f32(1.0));
                        sum.assign(sum.add(t).add(t.mul(f32(0.5))));
                    });
                    return sum;
                },
                { name: 'loopy', params: [] as const, return: d.f32 },
            );
            return {
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment: vec4(vec3(loopy()), f32(1)),
                depth: undefined,
            };
        },
    },
    {
        // Fixed-size ARRAY member in a std140 UBO. The member decl must use GLSL's `<elem> <name>[N]`
        // array syntax — a sized-array descriptor has no scalar glslType, so the prior `glslType(u.type)`
        // path threw. (Struct members already worked via the struct-name path.) Must compile + link.
        name: 'array-member UBO (std140 vec4[N])',
        build: () => {
            const palette = uniform('palette', d.sizedArray(d.vec4f, 3));
            return {
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment: palette.element(i32(1)),
                depth: undefined,
            };
        },
    },
    {
        // Centroid-sampled varying. GLSL ES 3.00 has the `centroid` qualifier; it MUST appear on both the
        // vertex `out` and the fragment `in` or the program fails to link. Exercises the sampling-qualifier
        // path (distinct from flat/perspective).
        name: 'centroid varying (vertex out + fragment in match)',
        build: () => {
            const centroidVarying = varying(attribute('position', d.vec3f)).setInterpolation('smooth', 'centroid');
            return {
                vertex: vec4(centroidVarying, f32(1)),
                fragment: vec4(centroidVarying, f32(1)),
                depth: undefined,
            };
        },
    },
    {
        // Nested-struct storage() read via the Field path (makecat's model/sprite instance shape). A
        // read-only storage buffer of a struct whose members include a matrix and a NESTED struct. The
        // vertex stage reads `worldMatrix` for position and `params.tint` (a struct-typed field, then a
        // sub-field) as a varying: decoding the nested struct into a constructor and selecting a leaf was
        // the `field type 'struct' not supported` case before the fix. Per-instance reads stay in the
        // vertex stage (`gl_InstanceID` is vertex-only), handed to the fragment via a varying. Compile+link.
        name: 'storage nested-struct field read (params.tint via varying)',
        build: () => {
            const Params = struct('IconParamsA', { uvOffset: d.vec2f, uvScale: d.vec2f, tint: d.vec4f });
            const Instance = struct('IconInstanceA', { worldMatrix: d.mat4x4f, params: Params });
            const slotMap = storage('slotMap', d.array(d.u32), 'read');
            const instanceData = storage('instanceData', d.array(Instance), 'read');
            const inst = instanceData.element(slotMap.element(instanceIndex));
            const clip = inst.field('worldMatrix').mul(vec4(attribute('position', d.vec3f), f32(1)));
            return { vertex: clip, fragment: varying(inst.field('params').field('tint'), 'vTintA'), depth: undefined };
        },
    },
    {
        // Whole struct storage element read via the Index path. Materializing a struct element to a var
        // (`storage.element(i).toVar()`) emits the bare element, which decodes to a struct constructor
        // assigned to a GLSL local; fields then read off the local. Pre-fix this emitted a bare StorageNode
        // (`node kind 'StorageNode' not yet supported`). Vertex-stage read, tint handed out as a varying.
        name: 'storage whole-struct element to var',
        build: () => {
            const Params = struct('IconParamsB', { uvOffset: d.vec2f, uvScale: d.vec2f, tint: d.vec4f });
            const Instance = struct('IconInstanceB', { worldMatrix: d.mat4x4f, params: Params });
            const slotMap = storage('slotMap', d.array(d.u32), 'read');
            const instanceData = storage('instanceData', d.array(Instance), 'read');
            const inst = instanceData.element(slotMap.element(instanceIndex)).toVar('inst');
            const clip = inst.field('worldMatrix').mul(vec4(attribute('position', d.vec3f), f32(1)));
            return { vertex: clip, fragment: varying(inst.field('params').field('tint'), 'vTintB'), depth: undefined };
        },
    },
];
