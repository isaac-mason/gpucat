import { expect, test } from 'vitest';
import { createIndexBuffer, getIndexFormat } from '../src/core/gpu-buffer';

/**
 * WGSL has no u16, so an index buffer has no truthful schema: `u32` is a placeholder and the array
 * itself is what the index format is read from.
 */
test('a 16-bit index buffer keeps its array type and reports uint16', () => {
    const buffer = createIndexBuffer(new Uint16Array([0, 1, 2, 2, 3, 0]));

    expect(buffer.array).toBeInstanceOf(Uint16Array);
    expect(getIndexFormat(buffer.array)).toBe('uint16');
});

test('a 32-bit index buffer reports uint32', () => {
    const buffer = createIndexBuffer(new Uint32Array([0, 1, 2]));

    expect(buffer.array).toBeInstanceOf(Uint32Array);
    expect(getIndexFormat(buffer.array)).toBe('uint32');
});

/** The placeholder schema must not drive the element count, which is what the cast is claiming. */
test('the placeholder schema does not change the element count', () => {
    expect(createIndexBuffer(new Uint16Array([0, 1, 2, 2, 3, 0])).count).toBe(6);
    expect(createIndexBuffer(new Uint32Array([0, 1, 2])).count).toBe(3);
});
