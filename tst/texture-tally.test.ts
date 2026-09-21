/* Texture accounting: byte estimation, and the tally's add / resize / remove arithmetic. */

import { describe, expect, test } from 'vitest';
import {
    createRendererInfo,
    createTextureTally,
    createTextureTallyEntry,
    readTextureTally,
    resetTextureTally,
    tallyClearTexture,
    tallySetTexture,
} from '../src/renderer/core/info';
import { bytesPerTexel, gpuTextureBytes } from '../src/renderer/core/texture-size';
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

    test('an unknown format falls back rather than throwing', () => {
        expect(bytesPerTexel('astc-4x4-unorm' as GPUTextureFormat)).toBe(4);
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

describe('tally arithmetic', () => {
    test('a first set counts one texture and its bytes', () => {
        const tally = createTextureTally();
        tallySetTexture(tally, createTextureTallyEntry(), 'rgba8unorm', 1024);
        expect(tally.count).toBe(1);
        expect(tally.bytes).toBe(1024);
        expect(tally.byFormat.get('rgba8unorm')).toBe(1024);
    });

    test('re-setting the same entry moves bytes without moving the count', () => {
        // The resize path: one texture the whole time, but its storage changed size.
        const tally = createTextureTally();
        const entry = createTextureTallyEntry();
        tallySetTexture(tally, entry, 'rgba8unorm', 1024);
        tallySetTexture(tally, entry, 'rgba8unorm', 4096);
        expect(tally.count).toBe(1);
        expect(tally.bytes).toBe(4096);
        expect(tally.byFormat.get('rgba8unorm')).toBe(4096);
    });

    test('a format change moves the bytes between buckets and drops the empty one', () => {
        const tally = createTextureTally();
        const entry = createTextureTallyEntry();
        tallySetTexture(tally, entry, 'rgba8unorm', 1024);
        tallySetTexture(tally, entry, 'r32float', 2048);
        expect(tally.count).toBe(1);
        expect(tally.byFormat.has('rgba8unorm')).toBe(false);
        expect(tally.byFormat.get('r32float')).toBe(2048);
    });

    test('clearing removes exactly what the entry contributed', () => {
        const tally = createTextureTally();
        const a = createTextureTallyEntry();
        const b = createTextureTallyEntry();
        tallySetTexture(tally, a, 'rgba8unorm', 1024);
        tallySetTexture(tally, b, 'rgba8unorm', 512);
        tallyClearTexture(tally, a);
        expect(tally.count).toBe(1);
        expect(tally.bytes).toBe(512);
        expect(tally.byFormat.get('rgba8unorm')).toBe(512);
    });

    test('clearing is idempotent and never counts below zero', () => {
        const tally = createTextureTally();
        const entry = createTextureTallyEntry();
        tallySetTexture(tally, entry, 'rgba8unorm', 1024);
        tallyClearTexture(tally, entry);
        tallyClearTexture(tally, entry);
        expect(tally.count).toBe(0);
        expect(tally.bytes).toBe(0);
        expect(tally.byFormat.size).toBe(0);
    });

    test('an entry cleared then re-set counts again', () => {
        const tally = createTextureTally();
        const entry = createTextureTallyEntry();
        tallySetTexture(tally, entry, 'rgba8unorm', 1024);
        tallyClearTexture(tally, entry);
        tallySetTexture(tally, entry, 'rgba8unorm', 256);
        expect(tally.count).toBe(1);
        expect(tally.bytes).toBe(256);
    });

    test('reset empties everything', () => {
        const tally = createTextureTally();
        tallySetTexture(tally, createTextureTallyEntry(), 'rgba8unorm', 1024);
        resetTextureTally(tally);
        expect(tally.count).toBe(0);
        expect(tally.bytes).toBe(0);
        expect(tally.byFormat.size).toBe(0);
    });
});

describe('snapshot', () => {
    test('reading a tally fills the neutral memory fields', () => {
        const info = createRendererInfo();
        const tally = createTextureTally();
        tallySetTexture(tally, createTextureTallyEntry(), 'rgba8unorm', 1024);
        tallySetTexture(tally, createTextureTallyEntry(), 'depth24plus', 512);

        readTextureTally(tally, info.memory);
        expect(info.memory.textures).toBe(2);
        expect(info.memory.texturesSize).toBe(1536);
        expect(info.memory.texturesByFormat).toEqual({ rgba8unorm: 1024, depth24plus: 512 });
    });

    test('the snapshot is a copy, so a later tally change does not mutate it', () => {
        const info = createRendererInfo();
        const tally = createTextureTally();
        tallySetTexture(tally, createTextureTallyEntry(), 'rgba8unorm', 1024);
        readTextureTally(tally, info.memory);

        tallySetTexture(tally, createTextureTallyEntry(), 'rgba8unorm', 4096);
        expect(info.memory.texturesByFormat).toEqual({ rgba8unorm: 1024 });
    });
});
