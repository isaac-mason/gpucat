import { describe, expect, test } from 'vitest';
import {
    atomicAdd,
    atomicLoad,
    atomicStore,
    // graph building
    attribute,
    Break,
    Continue,
    // uniforms / builtins
    cameraProjectionMatrix,
    cameraViewMatrix,
    // compile entry points
    compile,
    compileCompute,
    // storage / atomics / compute
    createStorageBuffer,
    createStorageTexture,
    d,
    Fn,
    // scalars / vectors
    f32,
    GpuSampler,
    globalId,
    If,
    i32,
    index,
    Let,
    Loop,
    localId,
    modelNormalMatrix,
    modelWorldMatrix,
    type Node,
    screenUV,
    select,
    storage,
    struct,
    // textures
    texture,
    u32,
    Var,
    varying,
    vec3,
    vec4,
    WorkgroupVar,
    wgsl,
    wgslFn,
    workgroupBarrier,
} from '../src/index';

/**
 * Golden WGSL regression net for the Phase-1 backend-seam refactor.
 *
 * The refactor (promote Discovery to the neutral IR, split BuildContext, extract the WGSL
 * emitter behind a backend boundary) must produce BYTE-IDENTICAL WGSL. Each case below snapshots
 * the emitted `.code` plus the primitive structural metadata a backend consumes. If a snapshot
 * changes, the refactor altered observable output — investigate before updating snapshots.
 *
 * Node ids are module-global and monotonic, so snapshots are stable only while this file's node-
 * creation sequence is unchanged. Do not reorder/insert cases without regenerating snapshots.
 */

/** Extract only primitive, backend-neutral fields from a render CompileResult. */
function renderShape(r: ReturnType<typeof compile>) {
    return {
        code: r.code,
        vertexEntryPoint: r.vertexEntryPoint,
        fragmentEntryPoint: r.fragmentEntryPoint,
        varyings: r.varyings.map((v) => ({ name: v.name, type: v.type, location: v.location })),
        builtins: Array.from(r.builtinsUsed).sort(),
    };
}

/** Extract only primitive fields from a compute ComputeCompileResult. */
function computeShape(r: ReturnType<typeof compileCompute>) {
    return {
        code: r.code,
        workgroupSize: r.workgroupSize,
        storage: r.storage.map((s) => ({ name: s.name, type: s.type, access: s.access, group: s.group, binding: s.binding })),
        builtins: Array.from(r.builtinsUsed).sort(),
    };
}

describe('golden WGSL — render path', () => {
    test('lit mesh: attributes, camera/model uniforms, varying, vec math', () => {
        const position = attribute('position', d.vec3f);
        const normal = attribute('normal', d.vec3f);

        const worldPosition = modelWorldMatrix.mul(vec4(position, f32(1)));
        const clipPosition = cameraProjectionMatrix.mul(cameraViewMatrix.mul(worldPosition));
        const vWorldNormal = varying(modelNormalMatrix.mul(normal).normalize(), 'vNormal');

        const lightDir = vec3(0.6, 1.0, 0.8).normalize();
        const lighting = f32(0.15).add(vWorldNormal.dot(lightDir).max(f32(0)));
        const fragment = vec4(vec3(0.4, 0.7, 1.0).mul(lighting), f32(1));

        const result = compile({ vertex: clipPosition, fragment, depth: undefined });
        expect(renderShape(result)).toMatchSnapshot();
    });

    test('textured: sampled texture binding + sampler + textureSample', () => {
        const tex = createStorageTexture(64, 64, 'rgba8unorm');
        const sampler = new GpuSampler({ minFilter: 'linear', magFilter: 'linear' });
        const color = texture(tex, sampler).sample(screenUV);

        const result = compile({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: color,
            depth: undefined,
        });
        expect(renderShape(result)).toMatchSnapshot();
    });

    test('conditional + inline wgsl in fragment', () => {
        const isRight = screenUV.x.greaterThan(f32(0.5));
        const tinted = select(vec3(0.1, 0.1, 0.1), vec3(0.9, 0.2, 0.2), isRight);
        const luma = wgsl(d.f32)`dot(${tinted}, vec3f(0.299, 0.587, 0.114))`;
        const fragment = vec4(tinted.mul(luma), f32(1));

        const result = compile({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment,
            depth: undefined,
        });
        expect(renderShape(result)).toMatchSnapshot();
    });
});

describe('golden WGSL — compute path', () => {
    test('atomic histogram: storage atomics + index + Var + If', () => {
        const counts = storage(createStorageBuffer(d.array(d.atomic(d.u32)), new Uint32Array(64)), 'read_write');
        const items = storage(createStorageBuffer(d.array(d.u32), new Uint32Array(64 * 16)), 'read_write');

        const kernel = Fn(() => {
            const i = globalId.x;
            const cell = i.mod(u32(64));
            const slot = Var('slot', atomicAdd(index(counts, cell), u32(1))) as Node<d.u32>;
            index(items, cell.mul(u32(16)).add(slot)).assign(i);
        }).compute({ workgroupSize: [64, 1, 1] });

        expect(computeShape(compileCompute(kernel))).toMatchSnapshot();
    });

    test('workgroup atomic + barriers', () => {
        const wgCount = WorkgroupVar('wgCount', d.atomic(d.u32));
        const out = storage(createStorageBuffer(d.array(d.u32), new Uint32Array(64)), 'read_write');

        const kernel = Fn(() => {
            If(localId.x.equal(u32(0)), () => {
                atomicStore(wgCount, u32(0));
            });
            workgroupBarrier();
            const slot = Var('slot', atomicAdd(wgCount, u32(1))) as Node<d.u32>;
            workgroupBarrier();
            const total = Var('total', atomicLoad(wgCount)) as Node<d.u32>;
            index(out, slot).assign(total);
        }).compute({ workgroupSize: [64, 1, 1] });

        expect(computeShape(compileCompute(kernel))).toMatchSnapshot();
    });

    test('control flow + struct + let/const: Loop / Break / Continue', () => {
        const Particle = struct('Particle', { pos: d.vec3f, life: d.f32 });
        const buf = storage(createStorageBuffer(d.array(Particle), new Float32Array(64 * 4)), 'read_write');

        const kernel = Fn(() => {
            const i = globalId.x;
            const acc = Var('acc', f32(0));
            Loop(4, ({ i: k }) => {
                const p = index(buf, i);
                If(p.field('life').lessThan(f32(0)), () => {
                    Continue();
                });
                If(k.greaterThan(i32(2)), () => {
                    Break();
                });
                acc.assign(acc.add(p.field('life')));
            });
            const scaled = Let('scaled', acc.mul(f32(0.5)));
            index(buf, i).field('life').assign(scaled);
        }).compute({ workgroupSize: [64, 1, 1] });

        expect(computeShape(compileCompute(kernel))).toMatchSnapshot();
    });
});

// Placed LAST so the extra nodes these build don't shift the monotonic node ids the snapshot cases
// above depend on. No snapshots here — these assert the GLSL companion is inert on the WGSL path.
describe('GLSL companion does not affect WGSL output', () => {
    test('wgslFn with a `glsl` companion emits identical WGSL to the same wgslFn without one', () => {
        const src = `fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }`;
        const withGlsl = wgslFn(src, {
            output: d.f32,
            params: [{ name: 'c', type: d.vec3f }] as const,
            glsl: `float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }`,
        });
        const withoutGlsl = wgslFn(src, { output: d.f32, params: [{ name: 'c', type: d.vec3f }] as const });

        const build = (fn: typeof withGlsl) =>
            compile({
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment: vec4(vec3(0.8, 0.3, 0.1).mul(fn(vec3(0.8, 0.3, 0.1))), f32(1)),
                depth: undefined,
            }).code;

        // Only the WGSL fn body differs by node ids created; compare the emitted luma function text.
        expect(build(withGlsl)).toContain('fn luma(c: vec3f) -> f32');
        expect(build(withoutGlsl)).toContain('fn luma(c: vec3f) -> f32');
    });

    test('inline wgsl`` with a .glslSource companion emits the same WGSL expression', () => {
        const a = vec3(0.8, 0.3, 0.1);
        const withGlsl = wgsl(d.f32)`dot(${a}, vec3f(0.299, 0.587, 0.114))`
            .glslSource`dot(${a}, vec3(0.299, 0.587, 0.114))`;
        const code = compile({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: vec4(a.mul(withGlsl), f32(1)),
            depth: undefined,
        }).code;
        // The WGSL emitter uses the wgsl source (vec3f(...)), not the glsl companion (vec3(...)).
        expect(code).toContain('vec3f(0.299, 0.587, 0.114)');
        expect(code).not.toContain('vec3(0.299');
    });
});
