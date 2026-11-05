import { expect, test } from 'vitest';
import { GpuBuffer } from '../src/core/gpu-buffer';
import { d } from '../src/index';
import { createMemoryTally, createRendererInfo } from '../src/renderer/core/info';
import { createBufferCache, ensureUploaded } from '../src/renderer/webgl/buffers';
import { createGlState } from '../src/renderer/webgl/state';
import { createTextureCache, updateStorageBufferTexture } from '../src/renderer/webgl/textures';

// WebGL2 has no storage buffers: a buffer with storage usage is the texture its storage() reads go through, and only
// that, so its written ranges have one place to go.

const ELEMENT_ARRAY_BUFFER = 0x8893;
const ELEMENTS = 64;

/** A GL context that records the texels `texSubImage2D` writes; every other call does nothing. */
function recordingGl() {
    const textureWrites: [number, number][] = [];
    let next = 1;
    const calls: Record<string, (...args: never[]) => unknown> = {
        createBuffer: () => ({ id: next++ }),
        createTexture: () => ({ id: next++ }),
        getParameter: () => 4096,
        texSubImage2D: (_t: number, _level: number, x: number, _y: number, width: number) => {
            textureWrites.push([x, width]);
        },
    };
    const gl = new Proxy(
        {},
        {
            // GL enums read as numbers, every call not listed above does nothing
            get: (_, name: string) => calls[name] ?? (/^[A-Z0-9_]+$/.test(name) ? name.length : () => undefined),
        },
    ) as WebGL2RenderingContext;
    return { gl, textureWrites };
}

test('a storage buffer is refused a GL buffer', () => {
    const { gl } = recordingGl();
    const buffers = createBufferCache(createRendererInfo(), createMemoryTally(), createGlState());
    const buffer = new GpuBuffer(d.u32, { data: new Uint32Array(ELEMENTS), usage: ['index', 'storage'], label: 'pool' });
    expect(() => ensureUploaded(gl, buffers, buffer, ELEMENT_ARRAY_BUFFER, 'index')).toThrow(/'pool' has storage usage/);
});

test('a buffer without storage usage is refused a storage() read', () => {
    const { gl } = recordingGl();
    const textures = createTextureCache(createMemoryTally());
    const buffer = new GpuBuffer(d.u32, { data: new Uint32Array(ELEMENTS), usage: 'index', label: 'indices' });
    const source = { buffer, width: ELEMENTS, height: 1, bytesPerTexel: 4 };
    expect(() => updateStorageBufferTexture(gl, textures, source)).toThrow(/'indices' is read through storage\(\)/);
});

test("a range written with no version bump reaches the storage buffer's texture, once", () => {
    const { gl, textureWrites } = recordingGl();
    const textures = createTextureCache(createMemoryTally());
    const buffer = new GpuBuffer(d.u32, { data: new Uint32Array(ELEMENTS), usage: 'storage' });
    const source = { buffer, width: ELEMENTS, height: 1, bytesPerTexel: 4 };
    updateStorageBufferTexture(gl, textures, source);
    textureWrites.length = 0;
    // as a pool appends a mesh: the range alone, as gpucat allows
    buffer.addUpdateRange(40, 8);

    updateStorageBufferTexture(gl, textures, source);
    updateStorageBufferTexture(gl, textures, source);

    expect(textureWrites).toEqual([[40, 8]]);
});
