import { describe, expect, test } from 'vitest';
import {
    compileComputeWgsl,
    d,
    f32,
    Fn,
    GpuTexture,
    globalId,
    storageTexture,
    texture,
    textureLoad,
    textureStore,
    vec4f,
    WHOLE_TEXTURE,
} from '../src/index';

const pyramid = () =>
    new GpuTexture(d.textureStorage2d('r32float'), { width: 8, height: 8, mipLevelCount: 4, cpu: false, label: 'pyramid' });

const copyKernel = (source: ReturnType<typeof storageTexture>, target: ReturnType<typeof storageTexture>) =>
    Fn(() => {
        textureStore(target, globalId.xy, vec4f(textureLoad(source, globalId.xy).x, f32(0), f32(0), f32(0)));
    }).compute({ workgroupSize: [1, 1, 1] });

describe('texture views', () => {
    test('a view names its range by value, and the whole texture by the empty key', () => {
        const tex = pyramid();
        expect(tex.view().range.key).toBe(WHOLE_TEXTURE.key);
        expect(tex.view({ baseMipLevel: 2, mipLevelCount: 1 }).range.key).toBe(
            tex.view({ baseMipLevel: 2, mipLevelCount: 1 }).range.key,
        );
        expect(tex.view({ baseMipLevel: 2, mipLevelCount: 1 }).range.key).not.toBe(
            tex.view({ baseMipLevel: 3, mipLevelCount: 1 }).range.key,
        );
        expect(tex.view({ baseMipLevel: 2 }).range.mipLevelCount).toBeUndefined();
    });

    test('two mips of one texture in one shader are two bindings, read and write', () => {
        const tex = pyramid();
        const source = storageTexture(tex.view({ baseMipLevel: 0, mipLevelCount: 1 }), 'read');
        const target = storageTexture(tex.view({ baseMipLevel: 1, mipLevelCount: 1 }), 'write');
        const wgsl = compileComputeWgsl(copyKernel(source, target)).code;
        expect(wgsl).toContain('var pyramid_mip0: texture_storage_2d<r32float, read>;');
        expect(wgsl).toContain('var pyramid_mip1: texture_storage_2d<r32float, write>;');
    });

    test('two nodes binding the same view the same way are one binding', () => {
        const tex = pyramid();
        const a = storageTexture(tex.view({ baseMipLevel: 1, mipLevelCount: 1 }), 'write');
        const b = storageTexture(tex.view({ baseMipLevel: 1, mipLevelCount: 1 }), 'write');
        expect(a.textureId).toBe(b.textureId);
        const kernel = Fn(() => {
            textureStore(a, globalId.xy, vec4f(f32(1), f32(0), f32(0), f32(0)));
            textureStore(b, globalId.xy, vec4f(f32(2), f32(0), f32(0), f32(0)));
        }).compute({ workgroupSize: [1, 1, 1] });
        expect(compileComputeWgsl(kernel).code.match(/texture_storage_2d/g)).toHaveLength(1);
    });

    test('named slots are declared by their slot names', () => {
        const source = storageTexture('source', d.textureStorage2d('r32float'), 'read');
        const destination = storageTexture('destination', d.textureStorage2d('r32float'), 'write');
        const wgsl = compileComputeWgsl(copyKernel(source, destination)).code;
        expect(wgsl).toContain('var source: texture_storage_2d<r32float, read>;');
        expect(wgsl).toContain('var destination: texture_storage_2d<r32float, write>;');
    });

    test('a texture read only by load needs no sampler, and sampling one without a sampler says why', () => {
        const tex = pyramid();
        const chain = texture(tex);
        const loaded = Fn(() => {
            textureStore(
                storageTexture(tex.view({ baseMipLevel: 3, mipLevelCount: 1 }), 'write'),
                globalId.xy,
                chain.load(globalId.xy.toI32(), f32(0).toI32()),
            );
        }).compute({ workgroupSize: [1, 1, 1] });
        expect(compileComputeWgsl(loaded).code).not.toMatch(/: sampler/);

        const sampled = Fn(() => {
            textureStore(
                storageTexture(tex.view({ baseMipLevel: 3, mipLevelCount: 1 }), 'write'),
                globalId.xy,
                chain.level(f32(0)),
            );
        }).compute({ workgroupSize: [1, 1, 1] });
        expect(() => compileComputeWgsl(sampled)).toThrow(/sampled but was bound with no sampler/);
    });
});
