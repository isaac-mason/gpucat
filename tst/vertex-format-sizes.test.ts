import { expect, test } from 'vitest';
import { deriveVertexFormat } from '../src/core/gpu-buffer';
import { getBytesPerElement, wgslTypeItemSize, wgslTypeToVertexFormat } from '../src/renderer/webgpu/pipelines';

const ARRAYS = [Float32Array, Int32Array, Uint32Array, Int16Array, Uint16Array, Int8Array, Uint8Array];

/** A format with no recorded size used to become 16 bytes, which is a wrong stride and not an error. */
test('every format the deriver emits has a byte size, and it matches the array', () => {
    const derived: string[] = [];
    for (const Ctor of ARRAYS) {
        for (const itemSize of [1, 2, 3, 4]) {
            const format = deriveVertexFormat(new Ctor(itemSize), itemSize);
            if (format === undefined) continue;
            derived.push(format);
            expect(getBytesPerElement(format)).toBe(Ctor.BYTES_PER_ELEMENT * itemSize);
        }
    }
    expect(derived.length).toBeGreaterThan(15);
});

/** WebGPU has no 8- or 16-bit format at one or three components, so those are absences, not gaps. */
test('the deriver declines the widths WebGPU has no format for', () => {
    for (const Ctor of [Int16Array, Uint16Array, Int8Array, Uint8Array]) {
        expect(deriveVertexFormat(new Ctor(1), 1)).toBeUndefined();
        expect(deriveVertexFormat(new Ctor(3), 3)).toBeUndefined();
    }
});

test('an unrecorded format is refused by name rather than sized at a guess', () => {
    expect(() => getBytesPerElement('unorm8x4' as never)).toThrow(/no byte size recorded/);
});

/** The other half of the same stride: a group with no named buffer sizes itself from its WGSL type. */
test('every attribute type gpucat can declare has a component count', () => {
    const counts: Record<string, number> = {
        f32: 1,
        i32: 1,
        u32: 1,
        vec2f: 2,
        vec2i: 2,
        vec2u: 2,
        vec3f: 3,
        vec3i: 3,
        vec3u: 3,
        vec4f: 4,
        vec4i: 4,
        vec4u: 4,
    };
    for (const [type, expected] of Object.entries(counts)) {
        expect(wgslTypeItemSize(type)).toBe(expected);
    }
});

/** A stride guessed at four components is wrong geometry with no error, so an unknown type is refused. */
test('an unknown attribute type is refused rather than assumed to be four components', () => {
    expect(() => wgslTypeItemSize('vec3h')).toThrow(/no component count/);
});

/** `float32x4` on a miss is a 16-byte stride for whatever the type really was. */
test('wgslTypeToVertexFormat refuses a type it does not know', () => {
    expect(wgslTypeToVertexFormat('vec2f')).toBe('float32x2');
    expect(() => wgslTypeToVertexFormat('mat4x4f')).toThrow(/mat4x4f/);
});
