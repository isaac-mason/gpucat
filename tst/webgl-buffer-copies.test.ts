import { expect, test } from 'vitest';
import { GpuBuffer } from '../src/core/gpu-buffer';
import { d } from '../src/index';
import { createMemoryTally, createRendererInfo } from '../src/renderer/core/info';
import { createBufferCopies } from '../src/renderer/webgl/buffer-copies';
import { createBufferCache, ensureUploaded } from '../src/renderer/webgl/buffers';
import { createGlState } from '../src/renderer/webgl/state';
import { createTextureCache, updateStorageBufferTexture } from '../src/renderer/webgl/textures';

// A buffer drawn from as indices and read through storage() has two copies on WebGL, its GL buffer and the texture
// the storage() read goes through, both kept current from its one queue of written ranges.

const ELEMENT_ARRAY_BUFFER = 0x8893;
const ELEMENTS = 64;

/** A GL context that records the writes into either copy: `bufferSubData`'s element range, `texSubImage2D`'s texels. */
function recordingGl() {
    const bufferWrites: [number, number][] = [];
    const textureWrites: [number, number][] = [];
    let next = 1;
    const calls: Record<string, (...args: never[]) => unknown> = {
        createBuffer: () => ({ id: next++ }),
        createTexture: () => ({ id: next++ }),
        getParameter: () => 4096,
        bufferSubData: (_target: number, byteOffset: number, _array: unknown, start?: number, count?: number) => {
            bufferWrites.push([start ?? byteOffset / 4, count ?? ELEMENTS]);
        },
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
    return { gl, bufferWrites, textureWrites };
}

function bothCopies() {
    const copies = createBufferCopies();
    const buffers = createBufferCache(createRendererInfo(), createMemoryTally(), createGlState(), copies);
    const textures = createTextureCache(createMemoryTally(), copies);
    const buffer = new GpuBuffer(d.u32, { data: new Uint32Array(ELEMENTS), usage: ['index', 'storage'] });
    const source = { buffer, width: ELEMENTS, height: 1, bytesPerTexel: 4 };
    const recorded = recordingGl();
    const syncBuffer = () => ensureUploaded(recorded.gl, buffers, buffer, ELEMENT_ARRAY_BUFFER, 'index');
    const syncTexture = () => updateStorageBufferTexture(recorded.gl, textures, source);
    syncBuffer();
    syncTexture();
    recorded.bufferWrites.length = 0;
    recorded.textureWrites.length = 0;
    return { buffer, syncBuffer, syncTexture, ...recorded };
}

test('a range written with no version bump reaches the storage() texture after the GL buffer took it', () => {
    const { buffer, syncBuffer, syncTexture, bufferWrites, textureWrites } = bothCopies();
    // as a pool appends a mesh: the range alone, as gpucat allows
    buffer.addUpdateRange(40, 8);

    syncBuffer();
    syncTexture();

    expect(bufferWrites).toEqual([[40, 8]]);
    expect(textureWrites).toEqual([[40, 8]]);
});

test('a range written with no version bump reaches the GL buffer after the storage() texture took it', () => {
    const { buffer, syncBuffer, syncTexture, bufferWrites, textureWrites } = bothCopies();
    buffer.addUpdateRange(8, 4);

    syncTexture();
    syncBuffer();

    expect(textureWrites).toEqual([[8, 4]]);
    expect(bufferWrites).toEqual([[8, 4]]);
});

test('each copy writes a range once, however many times it syncs', () => {
    const { buffer, syncBuffer, syncTexture, bufferWrites, textureWrites } = bothCopies();
    buffer.addUpdateRange(0, 4);

    syncBuffer();
    syncBuffer();
    syncTexture();
    syncTexture();

    expect(bufferWrites).toEqual([[0, 4]]);
    expect(textureWrites).toEqual([[0, 4]]);
});

test('a whole rewrite after a range neither copy took rewrites both whole, not just the range', () => {
    const { buffer, syncBuffer, syncTexture, bufferWrites, textureWrites } = bothCopies();
    buffer.addUpdateRange(4, 4);
    syncBuffer();
    bufferWrites.length = 0;
    // the texture still holds that range when the whole buffer is rewritten
    buffer.pack(
        d.u32,
        Array.from({ length: ELEMENTS }, (_, i) => i),
    );

    syncTexture();
    syncBuffer();

    expect(textureWrites).toEqual([[0, ELEMENTS]]);
    expect(bufferWrites).toEqual([[0, ELEMENTS]]);
});
