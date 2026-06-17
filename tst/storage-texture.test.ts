import { describe, expect, test } from 'vitest';
import {
    Fn,
    compile,
    compileCompute,
    createStorageTexture,
    createStorageTexture3d,
    createStorageTextureArray,
    globalId,
    GpuSampler,
    Material,
    storageTexture,
    textureStore,
    textureLoad,
    texture,
    screenUV,
    attribute,
    vec4,
    f32,
    u32,
    i32,
    vec2u,
    vec3u,
} from '../src/index';
import * as d from '../src/schema/schema';

describe('storage textures — WGSL emission', () => {
    test('2d write: emits texture_storage_2d<rgba8unorm, write> and textureStore statement', () => {
        const tex = createStorageTexture(64, 64); // default rgba8unorm
        const st = storageTexture(tex, 'write');

        const fn = Fn(() => {
            const coord = vec2u(globalId.x, globalId.y);
            textureStore(st, coord, vec4(f32(1), f32(0), f32(0), f32(1)));
        });

        const result = compileCompute(fn.compute({ workgroupSize: [8, 8, 1] }));

        expect(result.code).toContain('var st');
        expect(result.code).toMatch(/var st\d+: texture_storage_2d<rgba8unorm, write>;/);
        expect(result.code).toContain('textureStore(');
        expect(result.storageTextures.length).toBe(1);
        expect(result.storageTextures[0].format).toBe('rgba8unorm');
        expect(result.storageTextures[0].access).toBe('write');
        expect(result.storageTextures[0].dim).toBe('2d');
    });

    test('3d write: emits texture_storage_3d with vec3 coords', () => {
        const tex = createStorageTexture3d(16, 16, 16, 'rgba16float');
        const st = storageTexture(tex, 'write');

        const fn = Fn(() => {
            const coord = vec3u(globalId.x, globalId.y, globalId.z);
            textureStore(st, coord, vec4(f32(0.5), f32(0.5), f32(0.5), f32(1)));
        });

        const result = compileCompute(fn.compute({ workgroupSize: [4, 4, 4] }));
        expect(result.code).toMatch(/var st\d+: texture_storage_3d<rgba16float, write>;/);
        expect(result.storageTextures[0].dim).toBe('3d');
        expect(result.storageTextures[0].format).toBe('rgba16float');
    });

    test('2d-array write: layer arg goes between coords and value', () => {
        const tex = createStorageTextureArray(32, 32, 4, 'rgba8unorm');
        const st = storageTexture(tex, 'write');

        const fn = Fn(() => {
            const coord = vec2u(globalId.x, globalId.y);
            textureStore(st, coord, vec4(f32(1), f32(1), f32(1), f32(1)), i32(2));
        });

        const result = compileCompute(fn.compute({ workgroupSize: [8, 8, 1] }));
        expect(result.code).toMatch(/var st\d+: texture_storage_2d_array<rgba8unorm, write>;/);
        // textureStore(tex, coord, layer, value) — 4 args
        expect(result.code).toMatch(/textureStore\([^,]+,[^,]+,[^,]+,[^)]+\)/);
    });

    test('read_write on a capable format (r32float) emits read_write', () => {
        const tex = createStorageTexture(8, 8, 'r32float');
        const st = storageTexture(tex, 'read_write');

        const fn = Fn(() => {
            const coord = vec2u(globalId.x, globalId.y);
            const prev = textureLoad(st, coord);
            textureStore(st, coord, prev);
        });

        const result = compileCompute(fn.compute({ workgroupSize: [8, 8, 1] }));
        expect(result.code).toMatch(/var st\d+: texture_storage_2d<r32float, read_write>;/);
        expect(result.code).toContain('textureLoad(');
        expect(result.code).toContain('textureStore(');
    });

    test('uint format load returns a vec4u value (r32uint read_write)', () => {
        // r32uint is one of the three core read_write-capable formats; its channel is u32.
        const tex = createStorageTexture(8, 8, 'r32uint');
        const st = storageTexture(tex, 'read_write');

        const fn = Fn(() => {
            const coord = vec2u(globalId.x, globalId.y);
            const v = textureLoad(st, coord);
            textureStore(st, coord, v); // round-trips the loaded vec4u
        });
        const result = compileCompute(fn.compute({ workgroupSize: [8, 8, 1] }));
        expect(result.code).toMatch(/var st\d+: texture_storage_2d<r32uint, read_write>;/);
    });

    test('read_write is rejected for all non-r32 formats; allowed for r32uint/sint/float', () => {
        // The only core read_write-capable storage formats.
        for (const fmt of ['r32uint', 'r32sint', 'r32float'] as const) {
            expect(() => storageTexture(createStorageTexture(8, 8, fmt), 'read_write')).not.toThrow();
        }
        // A representative spread of non-r32 formats must all reject read_write.
        for (const fmt of ['rgba8unorm', 'rgba8uint', 'rgba16float', 'rgba32float', 'rg32float'] as const) {
            expect(() => storageTexture(createStorageTexture(8, 8, fmt), 'read_write')).toThrow(/does not support 'read_write'/);
        }
    });
});

describe('storage textures — validation', () => {
    test('read_write on a non-read_write format throws at storageTexture()', () => {
        const tex = createStorageTexture(8, 8, 'rgba8unorm'); // readWrite: false
        expect(() => storageTexture(tex, 'read_write')).toThrow(/does not support 'read_write'/);
    });

    test('textureStore on a read-access binding throws', () => {
        const tex = createStorageTexture(8, 8, 'r32float');
        const st = storageTexture(tex, 'read');
        expect(() => textureStore(st, vec2u(u32(0), u32(0)), vec4(f32(0), f32(0), f32(0), f32(0)))).toThrow(/'read' storage texture/);
    });

    test('textureLoad on a write-access binding throws', () => {
        const tex = createStorageTexture(8, 8);
        const st = storageTexture(tex, 'write');
        expect(() => textureLoad(st, vec2u(u32(0), u32(0)))).toThrow(/'write' storage texture/);
    });
});

describe('storage textures — resource usage', () => {
    test('createStorageTexture sets STORAGE_BINDING | TEXTURE_BINDING and stores format', () => {
        const tex = createStorageTexture(64, 64, 'rgba16float');
        expect(tex.format).toBe('rgba16float');
        expect(tex.usage & 0x08).toBeTruthy(); // STORAGE_BINDING
        expect(tex.usage & 0x04).toBeTruthy(); // TEXTURE_BINDING
        expect(tex.dimension).toBe('2d');
    });

    test('3d storage texture reports 3d dimension', () => {
        const tex = createStorageTexture3d(8, 8, 8);
        expect(tex.dimension).toBe('3d');
        expect(tex.depthOrArrayLayers).toBe(8);
    });

    test('resizing a storage texture (width + needsUpdate) bumps version for recreation', () => {
        // Storage textures are GPU-resident; resize is width/height change + needsUpdate,
        // which bumps version. updateTexture recreates the GPU texture on version change.
        const tex = createStorageTexture(64, 64);
        const v0 = tex.version;
        tex.width = 128;
        tex.height = 128;
        tex.needsUpdate = true;
        expect(tex.version).toBeGreaterThan(v0);
        expect(tex.width).toBe(128);
    });
});

describe('storage textures — sampling a storage texture in a render pass (dual usage)', () => {
    // Build a minimal fullscreen-quad-style render that samples a storage texture.
    function compileSampled(tex: ReturnType<typeof createStorageTexture>) {
        const sampler = new GpuSampler({ minFilter: 'linear', magFilter: 'linear' });
        const color = texture(tex, sampler).sample(screenUV);
        const material = new Material({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: color,
        });
        return compile({ vertex: material.vertex, fragment: material.fragment, depth: undefined });
    }

    test('emits a SAMPLED texture_2d<f32> binding, not a storage binding', () => {
        const tex = createStorageTexture(64, 64, 'rgba8unorm');
        const result = compileSampled(tex);

        // sampled as a normal float texture + sampler
        expect(result.code).toMatch(/var t\d+: texture_2d<f32>;/);
        expect(result.code).toContain('textureSample(');
        // it must NOT be emitted as a storage texture binding in the render shader
        expect(result.code).not.toContain('texture_storage_');
        // and it lands in the sampled-texture entries, not the storage-texture entries
        expect(result.textures.length).toBe(1);
        expect(result.storageTextures.length).toBe(0);
    });

    test('sampled binding sample type follows the storage format channel (uint -> u32)', () => {
        const tex = createStorageTexture(64, 64, 'rgba8uint');
        const result = compileSampled(tex);
        expect(result.code).toMatch(/var t\d+: texture_2d<u32>;/);
    });

    test('a render sampler does not collide with a compute write of the same texture', () => {
        // Same texture: write in compute, sample in render. Distinct binding kinds,
        // one underlying GpuTexture.
        const tex = createStorageTexture(64, 64, 'rgba8unorm');

        const write = storageTexture(tex, 'write');
        const computeFn = Fn(() => {
            textureStore(write, vec2u(globalId.x, globalId.y), vec4(f32(1), f32(0), f32(0), f32(1)));
        });
        const computeResult = compileCompute(computeFn.compute({ workgroupSize: [8, 8, 1] }));
        expect(computeResult.storageTextures.length).toBe(1);
        expect(computeResult.code).toContain('texture_storage_2d<rgba8unorm, write>');

        const renderResult = compileSampled(tex);
        expect(renderResult.textures.length).toBe(1);
        expect(renderResult.code).not.toContain('texture_storage_');
    });
});
