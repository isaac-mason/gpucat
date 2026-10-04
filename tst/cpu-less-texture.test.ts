import { describe, expect, test } from 'vitest';
import { GpuTexture } from '../src/core/gpu-texture';
import type { TextureRegion } from '../src/core/texture-region';
import type { Renderer } from '../src/renderer/core/renderer';
import { writeTexture } from '../src/renderer/core/write-texture';
import * as d from '../src/schema/schema';

/** a renderer whose backend keeps the boxes writeTexture hands it. */
function recordingRenderer(): { renderer: Renderer; writes: TextureRegion[] } {
    const writes: TextureRegion[] = [];
    const backend = { writeTexture: (_texture: GpuTexture, region: TextureRegion) => writes.push(region) };
    return { renderer: { backend, _assertInitialized() {} } as unknown as Renderer, writes };
}

describe('cpu: false textures', () => {
    test('take no source, and refuse the CPU-side updates', () => {
        expect(
            () =>
                new GpuTexture(d.texture2d(), {
                    width: 4,
                    height: 4,
                    cpu: false,
                    source: { data: new Uint8Array(64), width: 4, height: 4 },
                }),
        ).toThrow(/writeTexture/);
        expect(() => new GpuTexture(d.texture2d(), { width: 4, height: 4, cpu: false, generateMipmaps: true })).toThrow(
            /generateMipmaps/,
        );
        const texture = new GpuTexture(d.texture2d(), { width: 4, height: 4, cpu: false });
        expect(() => texture.addUpdateRegion({})).toThrow(/writeTexture/);
        expect(() => {
            texture.needsUpdate = true;
        }).toThrow(/writeTexture/);
    });

    test('are complete with no sources, cube included', () => {
        expect(new GpuTexture(d.textureCube(), { size: 4, cpu: false }).isComplete).toBe(true);
    });
});

describe('writeTexture', () => {
    test('fills an omitted box with the rest of the level', () => {
        const { renderer, writes } = recordingRenderer();
        const texture = new GpuTexture(d.texture2d(), { width: 8, height: 4, cpu: false });
        writeTexture(renderer, texture, new Uint8Array(6 * 3 * 4), { x: 2, y: 1 });
        expect(writes).toEqual([{ x: 2, y: 1, z: 0, width: 6, height: 3, depth: 1, level: 0 }]);
    });

    test('halves 3D slices down the chain, but not array layers', () => {
        const { renderer, writes } = recordingRenderer();
        const volume = new GpuTexture(d.texture3d(), {
            width: 8,
            height: 8,
            depth: 8,
            mipLevelCount: 2,
            format: 'r8unorm',
            cpu: false,
        });
        writeTexture(renderer, volume, new Uint8Array(4 * 4 * 4), { level: 1 });
        const layers = new GpuTexture(d.texture2dArray(), {
            width: 8,
            height: 8,
            layers: 3,
            mipLevelCount: 2,
            format: 'r8unorm',
            cpu: false,
        });
        writeTexture(renderer, layers, new Uint8Array(4 * 4 * 3), { level: 1 });
        expect(writes.map((box) => box.depth)).toEqual([4, 3]);
    });

    test('refuses a box outside the level, data that is not the box, and a texture with a source', () => {
        const { renderer } = recordingRenderer();
        const texture = new GpuTexture(d.texture2d(), { width: 4, height: 4, cpu: false });
        expect(() => writeTexture(renderer, texture, new Uint8Array(16), { x: 3, width: 2, height: 2 })).toThrow(/not inside/);
        expect(() => writeTexture(renderer, texture, new Uint8Array(15), { width: 2, height: 2 })).toThrow(/16 bytes/);
        expect(() => writeTexture(renderer, texture, new Uint8Array(64), { level: 1 })).toThrow(/mip levels/);
        const sourced = new GpuTexture(d.texture2d(), {
            width: 1,
            height: 1,
            source: { data: new Uint8Array(4), width: 1, height: 1 },
        });
        expect(() => writeTexture(renderer, sourced, new Uint8Array(4))).toThrow(/cpu: false/);
    });
});
