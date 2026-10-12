import { describe, expect, test } from 'vitest';
import { GpuBuffer } from '../src/core/gpu-buffer';
import { GpuTexture, TEXTURE_USAGE } from '../src/core/gpu-texture';
import type { TextureOrigin, TextureRegion } from '../src/core/texture-region';
import { copyBuffer } from '../src/renderer/core/copy-buffer';
import { copyTexture } from '../src/renderer/core/copy-texture';
import type { Renderer } from '../src/renderer/core/renderer';
import * as d from '../src/schema/schema';

type BufferCopy = [sourceByteOffset: number, destinationByteOffset: number, byteSize: number];
type TextureCopy = [region: TextureRegion, origin: TextureOrigin];

/** a renderer whose backend keeps the copies it is handed. */
function recordingRenderer(): { renderer: Renderer; buffers: BufferCopy[]; textures: TextureCopy[] } {
    const buffers: BufferCopy[] = [];
    const textures: TextureCopy[] = [];
    const backend = {
        copyBuffer: (
            _source: GpuBuffer,
            sourceByteOffset: number,
            _destination: GpuBuffer,
            destinationByteOffset: number,
            byteSize: number,
        ) => buffers.push([sourceByteOffset, destinationByteOffset, byteSize]),
        copyTexture: (_source: GpuTexture, region: TextureRegion, _destination: GpuTexture, origin: TextureOrigin) =>
            textures.push([region, origin]),
    };
    return { renderer: { backend, _assertInitialized() {} } as unknown as Renderer, buffers, textures };
}

const u32s = (count: number, cpu = false) =>
    cpu
        ? new GpuBuffer(d.array(d.u32), { data: new Uint32Array(count), usage: 'storage' })
        : new GpuBuffer(d.array(d.u32), { count, usage: 'storage', cpu: false });

describe('copyBuffer', () => {
    test('copies the whole source to the start when given no placement', () => {
        const { renderer, buffers } = recordingRenderer();
        copyBuffer(renderer, u32s(4), u32s(8));
        copyBuffer(renderer, u32s(4), u32s(8), 8, 4);
        expect(buffers).toEqual([
            [0, 0, 16],
            [8, 4, 8],
        ]);
    });

    test('skips an empty copy', () => {
        const { renderer, buffers } = recordingRenderer();
        copyBuffer(renderer, u32s(4), u32s(4), 0, 0, 0);
        expect(buffers).toEqual([]);
    });

    test('refuses a destination with a CPU array, which the copy would leave stale', () => {
        const { renderer } = recordingRenderer();
        expect(() => copyBuffer(renderer, u32s(4), u32s(4, true))).toThrow(/CPU array/);
    });

    test('takes a source with a CPU array', () => {
        const { renderer, buffers } = recordingRenderer();
        copyBuffer(renderer, u32s(4, true), u32s(4));
        expect(buffers).toEqual([[0, 0, 16]]);
    });

    test('refuses ranges off either end, unaligned ones, and overlap within one buffer', () => {
        const { renderer } = recordingRenderer();
        expect(() => copyBuffer(renderer, u32s(4), u32s(8), 4, 0, 16)).toThrow(/overrun the source/);
        expect(() => copyBuffer(renderer, u32s(4), u32s(4), 0, 4)).toThrow(/overrun the destination/);
        expect(() => copyBuffer(renderer, u32s(4), u32s(4), 2, 0, 4)).toThrow(/multiples of 4/);
        const buffer = u32s(8);
        expect(() => copyBuffer(renderer, buffer, buffer, 0, 8, 16)).toThrow(/overlap/);
        copyBuffer(renderer, buffer, buffer, 0, 16, 16);
    });

    test('refuses a disposed end', () => {
        const { renderer } = recordingRenderer();
        const source = u32s(4);
        source.dispose();
        expect(() => copyBuffer(renderer, source, u32s(4))).toThrow(/disposed/);
    });
});

const image = (width: number, height: number, options: { format?: GPUTextureFormat; usage?: number; cpu?: boolean } = {}) =>
    new GpuTexture(d.texture2d(), { width, height, cpu: options.cpu ?? false, format: options.format, usage: options.usage });

describe('copyTexture', () => {
    test('copies the rest of the source level to the origin when given no box', () => {
        const { renderer, textures } = recordingRenderer();
        copyTexture(renderer, image(8, 4), image(8, 4), { x: 2, y: 1 });
        copyTexture(renderer, image(4, 4), image(8, 8), {}, { x: 4, y: 4 });
        expect(textures).toEqual([
            [
                { x: 2, y: 1, z: 0, width: 6, height: 3, depth: 1, level: 0 },
                { x: 0, y: 0, z: 0, level: 0 },
            ],
            [
                { x: 0, y: 0, z: 0, width: 4, height: 4, depth: 1, level: 0 },
                { x: 4, y: 4, z: 0, level: 0 },
            ],
        ]);
    });

    test('reads levels at their own extent', () => {
        const { renderer, textures } = recordingRenderer();
        const mipped = new GpuTexture(d.texture2d(), { width: 8, height: 8, mipLevelCount: 2, cpu: false });
        copyTexture(renderer, mipped, image(4, 4), { level: 1 });
        expect(textures[0]![0]).toEqual({ x: 0, y: 0, z: 0, width: 4, height: 4, depth: 1, level: 1 });
    });

    test('refuses a box that leaves either texture', () => {
        const { renderer } = recordingRenderer();
        expect(() => copyTexture(renderer, image(4, 4), image(4, 4), { x: 2, width: 4 })).toThrow(/not inside source/);
        expect(() => copyTexture(renderer, image(4, 4), image(4, 4), {}, { x: 1 })).toThrow(/not inside destination/);
        const texture = image(4, 4);
        expect(() => copyTexture(renderer, texture, texture, { width: 2, height: 2 }, { x: 1, y: 1 })).toThrow(/overlap/);
        copyTexture(renderer, texture, texture, { width: 2, height: 2 }, { x: 2, y: 2 });
    });

    test('takes formats that differ only in -srgb, and refuses any other pair', () => {
        const { renderer, textures } = recordingRenderer();
        copyTexture(renderer, image(2, 2, { format: 'rgba8unorm-srgb' }), image(2, 2));
        expect(textures).toHaveLength(1);
        expect(() => copyTexture(renderer, image(2, 2, { format: 'rgba16float' }), image(2, 2))).toThrow(/same format/);
    });

    test('refuses depth and compressed formats', () => {
        const { renderer } = recordingRenderer();
        const depth = () => image(2, 2, { format: 'depth32float' });
        expect(() => copyTexture(renderer, depth(), depth())).toThrow(/uncompressed colour/);
    });

    test('refuses a destination with a CPU source, and ends whose usage lacks the copy', () => {
        const { renderer } = recordingRenderer();
        expect(() => copyTexture(renderer, image(2, 2), image(2, 2, { cpu: true }))).toThrow(/CPU source/);
        const sampled = image(2, 2, { usage: TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_DST });
        expect(() => copyTexture(renderer, sampled, image(2, 2))).toThrow(/COPY_SRC/);
        const unwritable = image(2, 2, { usage: TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_SRC });
        expect(() => copyTexture(renderer, image(2, 2), unwritable)).toThrow(/COPY_DST/);
    });
});
