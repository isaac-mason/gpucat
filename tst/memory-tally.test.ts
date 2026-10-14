/* GPU memory accounting: texture byte estimation, and the tally's add / resize / remove arithmetic. */

import { describe, expect, test } from 'vitest';
import {
    clearAllocation,
    createAllocation,
    createMemoryTally,
    createRendererInfo,
    readMemoryTally,
    reportAllocations,
    resetMemoryTally,
    setAllocation,
} from '../src/renderer/core/info';
import { bytesPerTexel, estimatedBytesPerTexel, gpuTextureBytes } from '../src/renderer/core/texture-size';
import type { Source } from '../src/texture/source';

/** The fields `gpuTextureBytes` reads; a real GpuTexture needs a device to construct. */
function texture(o: Partial<Parameters<typeof gpuTextureBytes>[0]> = {}) {
    return {
        width: 16,
        height: 16,
        depthOrArrayLayers: 1,
        format: 'rgba8unorm' as GPUTextureFormat,
        mipLevelCount: 1,
        mipmaps: [],
        generateMipmaps: false,
        ...o,
    } as Parameters<typeof gpuTextureBytes>[0];
}

describe('byte estimation', () => {
    test('a flat 2D texture is width x height x bytes-per-texel', () => {
        expect(gpuTextureBytes(texture({ width: 16, height: 8 }))).toBe(16 * 8 * 4);
    });

    test('format drives the per-texel cost', () => {
        expect(bytesPerTexel('r8unorm')).toBe(1);
        expect(bytesPerTexel('rgba8unorm')).toBe(4);
        expect(bytesPerTexel('rgba32float')).toBe(16);
        expect(gpuTextureBytes(texture({ format: 'r8unorm' }))).toBe(16 * 16);
    });

    /** A stride is arithmetic; the panel's figure wants a number more than it wants to be right. */
    test('the stride refuses an unknown format and the estimate still answers', () => {
        expect(() => bytesPerTexel('astc-4x4-unorm' as GPUTextureFormat)).toThrow(/astc-4x4-unorm/);
        expect(estimatedBytesPerTexel('astc-4x4-unorm' as GPUTextureFormat)).toBe(4);
        expect(estimatedBytesPerTexel('rgba16float')).toBe(8);
    });

    test('array layers and cube faces multiply', () => {
        expect(gpuTextureBytes(texture({ depthOrArrayLayers: 6 }))).toBe(16 * 16 * 4 * 6);
    });

    test('a mip chain adds the halved levels, flooring at 1x1', () => {
        // 4x4 rgba8: 64 + 16 + 4 = 84 across three levels.
        expect(gpuTextureBytes(texture({ width: 4, height: 4, mipLevelCount: 3 }))).toBe(84);
    });

    test('an auto-mipmapped texture is sized over the chain it will actually allocate', () => {
        // Its descriptor still reads mipLevelCount 1, but the backend allocates the full chain.
        // Summing the descriptor would undercount every atlas by about a third.
        const flat = gpuTextureBytes(texture({ width: 4, height: 4 }));
        const chained = gpuTextureBytes(texture({ width: 4, height: 4, generateMipmaps: true }));
        expect(flat).toBe(64);
        expect(chained).toBe(84);
    });

    test('explicit mip images win over the auto chain', () => {
        // level 0 plus the supplied levels: 16x16 + 8x8, not the full chain to 1x1.
        // The tally counts levels, never reads them, so an empty stand-in is enough for one explicit level.
        const bytes = gpuTextureBytes(texture({ width: 16, height: 16, mipmaps: [{} as Source], generateMipmaps: true }));
        expect(bytes).toBe((16 * 16 + 8 * 8) * 4);
    });

    test('a non-square texture floors each dimension independently', () => {
        // 8x2 -> 4x1 -> 2x1: (16 + 4 + 2) texels x 4 bytes.
        expect(gpuTextureBytes(texture({ width: 8, height: 2, mipLevelCount: 3 }))).toBe((16 + 4 + 2) * 4);
    });
});

function texturePiece(label = 'atlas') {
    return createAllocation('texture', 'sampled', label);
}

describe('tally arithmetic', () => {
    test('a first set counts one allocation and its bytes, by kind, category and format', () => {
        const tally = createMemoryTally();
        setAllocation(tally, texturePiece(), 1024, 'sampled', 'rgba8unorm');
        expect(tally.textures).toBe(1);
        expect(tally.texturesSize).toBe(1024);
        expect(tally.texturesByFormat.get('rgba8unorm')).toBe(1024);
        expect(tally.byCategory.get('texture/sampled')).toBe(1024);
        expect(tally.buffers).toBe(0);
    });

    test('buffers count apart from textures and carry no format', () => {
        const tally = createMemoryTally();
        setAllocation(tally, createAllocation('buffer', 'storage', 'voxels/quads'), 4096);
        expect(tally.buffers).toBe(1);
        expect(tally.buffersSize).toBe(4096);
        expect(tally.byCategory.get('buffer/storage')).toBe(4096);
        expect(tally.textures).toBe(0);
        expect(tally.texturesByFormat.size).toBe(0);
    });

    test('re-setting the same allocation moves bytes without moving the count', () => {
        // The resize path: one texture the whole time, but its storage changed size.
        const tally = createMemoryTally();
        const piece = texturePiece();
        setAllocation(tally, piece, 1024, 'sampled', 'rgba8unorm');
        setAllocation(tally, piece, 4096, 'sampled', 'rgba8unorm');
        expect(tally.textures).toBe(1);
        expect(tally.texturesSize).toBe(4096);
        expect(tally.texturesByFormat.get('rgba8unorm')).toBe(4096);
    });

    test('a format or category change moves the bytes between buckets and drops the empty ones', () => {
        const tally = createMemoryTally();
        const piece = texturePiece();
        setAllocation(tally, piece, 1024, 'sampled', 'rgba8unorm');
        setAllocation(tally, piece, 2048, 'render-target', 'r32float');
        expect(tally.textures).toBe(1);
        expect(tally.texturesByFormat.has('rgba8unorm')).toBe(false);
        expect(tally.texturesByFormat.get('r32float')).toBe(2048);
        expect(tally.byCategory.has('texture/sampled')).toBe(false);
        expect(tally.byCategory.get('texture/render-target')).toBe(2048);
    });

    test('clearing removes exactly what the allocation contributed', () => {
        const tally = createMemoryTally();
        const a = texturePiece('a');
        const b = texturePiece('b');
        setAllocation(tally, a, 1024, 'sampled', 'rgba8unorm');
        setAllocation(tally, b, 512, 'sampled', 'rgba8unorm');
        clearAllocation(tally, a);
        expect(tally.textures).toBe(1);
        expect(tally.texturesSize).toBe(512);
        expect(tally.texturesByFormat.get('rgba8unorm')).toBe(512);
        expect(tally.live.size).toBe(1);
    });

    test('clearing is idempotent and never counts below zero', () => {
        const tally = createMemoryTally();
        const piece = texturePiece();
        setAllocation(tally, piece, 1024, 'sampled', 'rgba8unorm');
        clearAllocation(tally, piece);
        clearAllocation(tally, piece);
        expect(tally.textures).toBe(0);
        expect(tally.texturesSize).toBe(0);
        expect(tally.texturesByFormat.size).toBe(0);
        expect(tally.byCategory.size).toBe(0);
        expect(tally.live.size).toBe(0);
    });

    test('an allocation cleared then re-set counts again', () => {
        const tally = createMemoryTally();
        const piece = texturePiece();
        setAllocation(tally, piece, 1024, 'sampled', 'rgba8unorm');
        clearAllocation(tally, piece);
        setAllocation(tally, piece, 256, 'sampled', 'rgba8unorm');
        expect(tally.textures).toBe(1);
        expect(tally.texturesSize).toBe(256);
    });

    test('reset empties everything, and a later clear of a reset allocation does nothing', () => {
        const tally = createMemoryTally();
        const piece = texturePiece();
        setAllocation(tally, piece, 1024, 'sampled', 'rgba8unorm');
        setAllocation(tally, createAllocation('buffer', 'vertex', 'mesh'), 64);
        resetMemoryTally(tally);
        clearAllocation(tally, piece);
        expect(tally.textures).toBe(0);
        expect(tally.buffers).toBe(0);
        expect(tally.texturesSize).toBe(0);
        expect(tally.buffersSize).toBe(0);
        expect(tally.byCategory.size).toBe(0);
        expect(tally.live.size).toBe(0);
    });

    test('the live set always sums to the running totals', () => {
        const tally = createMemoryTally();
        const pieces = [
            texturePiece('a'),
            texturePiece('b'),
            createAllocation('buffer', 'index', 'c'),
            createAllocation('buffer', 'uniform', 'd'),
        ];
        setAllocation(tally, pieces[0]!, 100, 'sampled', 'rgba8unorm');
        setAllocation(tally, pieces[1]!, 300, 'depth', 'depth24plus');
        setAllocation(tally, pieces[2]!, 40);
        setAllocation(tally, pieces[3]!, 256);
        setAllocation(tally, pieces[1]!, 600, 'depth', 'depth24plus');
        clearAllocation(tally, pieces[0]!);
        let buffers = 0;
        let textures = 0;
        for (const piece of tally.live) {
            if (piece.kind === 'buffer') buffers += piece.bytes;
            else textures += piece.bytes;
        }
        expect(buffers).toBe(tally.buffersSize);
        expect(textures).toBe(tally.texturesSize);
        let byCategory = 0;
        for (const bytes of tally.byCategory.values()) byCategory += bytes;
        expect(byCategory).toBe(buffers + textures);
    });
});

describe('snapshot', () => {
    test('reading a tally fills the neutral memory fields', () => {
        const info = createRendererInfo();
        const tally = createMemoryTally();
        setAllocation(tally, texturePiece(), 1024, 'sampled', 'rgba8unorm');
        setAllocation(tally, texturePiece('depth'), 512, 'depth', 'depth24plus');
        setAllocation(tally, createAllocation('buffer', 'storage', 'quads'), 2048);

        readMemoryTally(tally, info.memory);
        expect(info.memory.textures).toBe(2);
        expect(info.memory.texturesSize).toBe(1536);
        expect(info.memory.buffers).toBe(1);
        expect(info.memory.buffersSize).toBe(2048);
        expect(info.memory.totalSize).toBe(3584);
        expect(info.memory.texturesByFormat).toEqual({ rgba8unorm: 1024, depth24plus: 512 });
        expect(info.memory.byCategory).toEqual({ 'texture/sampled': 1024, 'texture/depth': 512, 'buffer/storage': 2048 });
    });

    test('the snapshot keeps its records across reads and drops keys that emptied', () => {
        const info = createRendererInfo();
        const tally = createMemoryTally();
        const piece = texturePiece();
        setAllocation(tally, piece, 1024, 'sampled', 'rgba8unorm');
        readMemoryTally(tally, info.memory);
        const byFormat = info.memory.texturesByFormat;

        clearAllocation(tally, piece);
        setAllocation(tally, texturePiece('b'), 64, 'sampled', 'r8unorm');
        readMemoryTally(tally, info.memory);
        expect(info.memory.texturesByFormat).toBe(byFormat);
        expect(info.memory.texturesByFormat).toEqual({ r8unorm: 64 });
    });
});

describe('report', () => {
    test('every live allocation, largest first, as copies', () => {
        const tally = createMemoryTally();
        const small = texturePiece('small');
        setAllocation(tally, small, 16, 'sampled', 'r8unorm');
        setAllocation(tally, createAllocation('buffer', 'storage', 'voxels/quads'), 4096);
        setAllocation(tally, texturePiece('gone'), 99, 'sampled', 'r8unorm');
        clearAllocation(tally, [...tally.live].find((piece) => piece.label === 'gone')!);

        const rows = reportAllocations(tally);
        expect(rows.map((row) => row.label)).toEqual(['voxels/quads', 'small']);
        expect(rows[0]).toEqual({ kind: 'buffer', category: 'storage', format: '', label: 'voxels/quads', bytes: 4096 });

        setAllocation(tally, small, 32, 'sampled', 'r8unorm');
        expect(rows[1]!.bytes).toBe(16);
    });
});

describe('snapshot skipping', () => {
    test('an unchanged tally skips the breakdown copy, but a reset snapshot is filled again', () => {
        const info = createRendererInfo();
        const tally = createMemoryTally();
        setAllocation(tally, texturePiece(), 1024, 'sampled', 'rgba8unorm');
        readMemoryTally(tally, info.memory);
        const version = tally.version;

        readMemoryTally(tally, info.memory);
        expect(tally.version).toBe(version);
        expect(info.memory.texturesByFormat).toEqual({ rgba8unorm: 1024 });

        info.memory.byCategory = {};
        info.memory.texturesByFormat = {};
        readMemoryTally(tally, info.memory);
        expect(info.memory.byCategory).toEqual({ 'texture/sampled': 1024 });
        expect(info.memory.texturesByFormat).toEqual({ rgba8unorm: 1024 });
    });
});
