import { describe, expect, test } from 'vitest';
import {
    attribute,
    compileGlsl,
    compileWgsl,
    createStorageBuffer,
    createStorageTexture,
    d,
    f32,
    GpuSampler,
    index,
    screenUV,
    storage,
    Texture,
    texture,
    Uniform,
    u32,
    uniform,
    vec4,
} from '../src/index';

const vertex = () => vec4(attribute('position', d.vec3f), f32(1));

describe('binding identity', () => {
    test('a high-level Texture and a bare GpuTexture never claim the same textureId', () => {
        // These used to be numbered by two independent counters that both formatted `t<n>`, so the two
        // bindings collided in the emitter's texture table: the second was dropped and BOTH sampled the
        // first texture. Identity now comes from the one GpuTexture counter.
        const wrapped = new Texture(null);
        const bare = createStorageTexture(8, 8, 'rgba8unorm');
        const sampler = new GpuSampler({});

        const a = texture(wrapped).bindingNode;
        const b = texture(bare, sampler).bindingNode;

        expect(a.textureId).not.toBe(b.textureId);
    });

    test('two distinct textures sampled in one shader each get their own binding', () => {
        const wrapped = new Texture(null);
        wrapped.name = 'albedo';
        const bare = createStorageTexture(8, 8, 'rgba8unorm');
        bare.label = 'noise';
        const sampler = new GpuSampler({});

        const fragment = texture(wrapped).sample(screenUV).add(texture(bare, sampler).sample(screenUV));
        const glsl = compileGlsl({ vertex: vertex(), fragment, depth: undefined }).code;

        expect(glsl).toContain('uniform sampler2D u_albedo;');
        expect(glsl).toContain('uniform sampler2D u_noise;');
        // The fragment reads BOTH, rather than the same one twice.
        expect(glsl).toContain('texture(u_albedo,');
        expect(glsl).toContain('texture(u_noise,');
    });
});

describe('binding names', () => {
    test('a texture reads under its label on both backends', () => {
        const tex = createStorageTexture(8, 8, 'rgba8unorm');
        tex.label = 'noise';
        const sampler = new GpuSampler({ minFilter: 'linear', magFilter: 'linear' });
        const fragment = texture(tex, sampler).sample(screenUV);

        expect(compileWgsl({ vertex: vertex(), fragment, depth: undefined }).code).toContain('var noise: texture_2d<f32>;');
        expect(compileGlsl({ vertex: vertex(), fragment, depth: undefined }).code).toContain('uniform sampler2D u_noise;');
    });

    test("a high-level Texture's name reaches the shader through GpuTexture.label", () => {
        const tex = new Texture(null);
        tex.name = 'albedo';
        expect(tex._gpuTexture.label).toBe('albedo');

        const fragment = texture(tex).sample(screenUV);
        expect(compileWgsl({ vertex: vertex(), fragment, depth: undefined }).code).toContain('var albedo: texture_2d<f32>;');
    });

    test('a storage buffer reads under its label, and a named slot under its slot name', () => {
        const buffer = createStorageBuffer(d.array(d.f32), new Float32Array(4), 'particles');
        const byValue = compileWgsl({
            vertex: vertex(),
            fragment: vec4(index(storage(buffer, 'read'), u32(0)), f32(0), f32(0), f32(1)),
            depth: undefined,
        }).code;
        expect(byValue).toContain('var<storage, read> particles:');

        const bySlot = compileWgsl({
            vertex: vertex(),
            fragment: vec4(index(storage('heights', d.array(d.f32), 'read'), u32(0)), f32(0), f32(0), f32(1)),
            depth: undefined,
        }).code;
        expect(bySlot).toContain('var<storage, read> heights:');
    });

    test('samplers read as what distinguishes them — their filter — since several textures share one', () => {
        const tex = createStorageTexture(8, 8, 'rgba8unorm');
        const linear = new GpuSampler({ minFilter: 'linear', magFilter: 'linear' });
        const nearest = new GpuSampler({ minFilter: 'nearest', magFilter: 'nearest' });
        const fragment = texture(tex, linear).sample(screenUV).add(texture(tex, nearest).sample(screenUV));

        const wgsl = compileWgsl({ vertex: vertex(), fragment, depth: undefined }).code;
        expect(wgsl).toContain('var linearSampler: sampler;');
        expect(wgsl).toContain('var nearestSampler: sampler;');
    });

    test('an unlabelled binding still falls back to a numbered name', () => {
        const tex = createStorageTexture(8, 8, 'rgba8unorm');
        const fragment = texture(tex, new GpuSampler({})).sample(screenUV);
        expect(compileWgsl({ vertex: vertex(), fragment, depth: undefined }).code).toMatch(/var t\d+: texture_2d<f32>;/);
    });
});

describe('naming convention', () => {
    // `label` is a HINT the emitter may adapt; it lives on the GPU resource, or on the node itself
    // only where there is no resource (a Var/Let local). Identity fields are emitted verbatim.
    test('every GPU resource carries a label, and a labelled sampler overrides its derived name', () => {
        const tex = createStorageTexture(8, 8, 'rgba8unorm');
        tex.label = 'noise';
        const sampler = new GpuSampler({ minFilter: 'linear', magFilter: 'linear', label: 'atlasSampler' });
        const fragment = texture(tex, sampler).sample(screenUV);

        const wgsl = compileWgsl({ vertex: vertex(), fragment, depth: undefined }).code;
        expect(wgsl).toContain('var atlasSampler: sampler;');
        expect(wgsl).not.toContain('linearSampler');
    });

    test('a uniform node keeps only identity — its spelling comes from the resource label', () => {
        const u = new Uniform(d.f32, 0.5, undefined, 'exposure');
        const fragment = vec4(uniform(u), f32(0), f32(0), f32(1));
        expect(compileWgsl({ vertex: vertex(), fragment, depth: undefined }).code).toContain('exposure: f32,');
    });

    test('an author-named uniform labels its resource, so the two never disagree', () => {
        const node = uniform('tint', d.f32);
        expect(node.uniform.label).toBe('tint');
    });
});
