import { describe, expect, test } from 'vitest';
import * as d from '../src/nodes/schema';
import { struct } from '../src/nodes/nodes';
import {
    packStruct,
    packStructArray,
    writeStructArray,
} from '../src/utils/buffer-layout';

// ---------------------------------------------------------------------------
// wgslAlignOf / wgslSizeOf / wgslStrideOf
// ---------------------------------------------------------------------------

describe('wgslAlignOf', () => {
    test('f32: 4', () => expect(d.wgslAlignOf(d.f32)).toBe(4));
    test('vec2f: 8', () => expect(d.wgslAlignOf(d.vec2f)).toBe(8));
    test('vec3f: 16', () => expect(d.wgslAlignOf(d.vec3f)).toBe(16));
    test('vec4f: 16', () => expect(d.wgslAlignOf(d.vec4f)).toBe(16));
});

describe('wgslSizeOf', () => {
    test('f32: 4', () => expect(d.wgslSizeOf(d.f32)).toBe(4));
    test('vec2f: 8', () => expect(d.wgslSizeOf(d.vec2f)).toBe(8));
    test('vec3f: 12', () => expect(d.wgslSizeOf(d.vec3f)).toBe(12)); // size ≠ alignment
    test('vec4f: 16', () => expect(d.wgslSizeOf(d.vec4f)).toBe(16));
    test('mat4x4f: 64', () => expect(d.wgslSizeOf(d.mat4x4f)).toBe(64));
});

describe('wgslStrideOf', () => {
    // stride = roundUp(size, align)
    test('f32 stride: 4', () => expect(d.wgslStrideOf(d.f32)).toBe(4));
    // vec3f: size=12 but align=16, so stride=16
    test('vec3f stride: 16', () => expect(d.wgslStrideOf(d.vec3f)).toBe(16));
});

// ---------------------------------------------------------------------------
// packStruct — simple flat struct
// ---------------------------------------------------------------------------

describe('packStruct', () => {
    test('flat struct: f32 fields', () => {
        const S = struct('S', { a: d.f32, b: d.f32, c: d.f32 });
        const buf = packStruct(S, { a: 1, b: 2, c: 3 });
        const view = new Float32Array(buf);
        expect(view[0]).toBeCloseTo(1);
        expect(view[1]).toBeCloseTo(2);
        expect(view[2]).toBeCloseTo(3);
    });

    test('struct with vec3f: correct size and alignment', () => {
        // struct { position: vec3f, health: f32 }
        // position: offset=0, align=16, size=12 → next field at roundUp(12, align(f32))=roundUp(12,4)=12
        // health:   offset=12, align=4, size=4  → next at 16
        // struct align = max(16, 4) = 16
        // struct size  = roundUp(16, 16) = 16
        const Particle = struct('LayoutParticle', {
            position: d.vec3f,
            health: d.f32,
        });

        const structSize = d.wgslSizeOf(Particle);
        expect(structSize).toBe(16);

        const buf = packStruct(Particle, {
            position: [10, 20, 30],
            health: 100,
        });
        expect(buf.byteLength).toBe(16);

        const f32 = new Float32Array(buf);
        // position at offset 0
        expect(f32[0]).toBeCloseTo(10);
        expect(f32[1]).toBeCloseTo(20);
        expect(f32[2]).toBeCloseTo(30);
        // health at offset 12 (bytes) → float index 3
        expect(f32[3]).toBeCloseTo(100);
    });

    test('struct with vec3f then vec3f: stride forces padding', () => {
        // struct { a: vec3f, b: vec3f }
        // a: offset=0, size=12 → next at roundUp(12, 16)=16 (b needs 16-byte align)
        // b: offset=16, size=12 → next at 28
        // struct align=16, size=roundUp(28, 16)=32
        const S = struct('Vec3PairStruct', { a: d.vec3f, b: d.vec3f });
        const sz = d.wgslSizeOf(S);
        expect(sz).toBe(32);

        const buf = packStruct(S, { a: [1, 2, 3], b: [4, 5, 6] });
        expect(buf.byteLength).toBe(32);

        const f32 = new Float32Array(buf);
        expect(f32[0]).toBeCloseTo(1); // a.x
        expect(f32[1]).toBeCloseTo(2); // a.y
        expect(f32[2]).toBeCloseTo(3); // a.z
        // offset 16 bytes = float index 4 for b
        expect(f32[4]).toBeCloseTo(4); // b.x
        expect(f32[5]).toBeCloseTo(5); // b.y
        expect(f32[6]).toBeCloseTo(6); // b.z
    });

    test('struct with vec2f: no padding needed', () => {
        // struct { uv: vec2f, id: u32, pad: u32 }
        // uv:  offset=0,  align=8, size=8  → next at 8
        // id:  offset=8,  align=4, size=4  → next at 12
        // struct align = max(8,4)=8, size=roundUp(12,8)=16
        const UV = struct('UVStruct', {
            uv: d.vec2f,
            id: d.u32,
        });

        const buf = packStruct(UV, { uv: [0.5, 0.25], id: 7 });
        // struct align=8, size after id=12, roundUp(12,8)=16
        expect(buf.byteLength).toBe(16);

        const f32 = new Float32Array(buf);
        const u32 = new Uint32Array(buf);
        expect(f32[0]).toBeCloseTo(0.5);
        expect(f32[1]).toBeCloseTo(0.25);
        expect(u32[2]).toBe(7);
    });
});

// ---------------------------------------------------------------------------
// packStructArray
// ---------------------------------------------------------------------------

describe('packStructArray', () => {
    test('particle array: byte length = count × stride', () => {
        const Particle = struct('Particle', {
            position: d.vec3f,
            velocity: d.vec3f,
            health: d.f32,
        });

        const count = 4;
        const items = Array.from({ length: count }, (_, i) => ({
            position: [i * 1.0, 0, 0] as [number, number, number],
            velocity: [0, 0, 0] as [number, number, number],
            health: 100,
        }));

        const buf = packStructArray(Particle, items);
        const stride = d.wgslStrideOf(Particle);
        expect(buf.byteLength).toBe(count * stride);

        // Each element's position.x should be i * 1.0
        const f32 = new Float32Array(buf);
        for (let i = 0; i < count; i++) {
            // position.x at byte offset i*stride, float index i*stride/4
            const floatIdx = (i * stride) / 4;
            expect(f32[floatIdx]).toBeCloseTo(i * 1.0);
        }
    });

    test('all-f32 struct: tightly packed', () => {
        // align=4, size=4, stride=4 per float
        const Color = struct('Color', { r: d.f32, g: d.f32, b: d.f32, a: d.f32 });
        const items = [
            { r: 1, g: 0, b: 0, a: 1 },
            { r: 0, g: 1, b: 0, a: 1 },
        ];
        const buf = packStructArray(Color, items);
        // struct align=4, size=16, stride=16
        expect(buf.byteLength).toBe(32);

        const f32 = new Float32Array(buf);
        expect(f32[0]).toBeCloseTo(1); // r of first
        expect(f32[4]).toBeCloseTo(0); // r of second
        expect(f32[5]).toBeCloseTo(1); // g of second
    });
});

// ---------------------------------------------------------------------------
// writeStructArray — in-place write into existing buffer
// ---------------------------------------------------------------------------

describe('writeStructArray', () => {
    test('writes at byteOffset', () => {
        const S = struct('SWS', { x: d.f32 });
        const stride = d.wgslStrideOf(S); // 4
        const buf = new ArrayBuffer(stride * 3 + 4); // room for 3 items + 4 byte header
        writeStructArray(S, [{ x: 10 }, { x: 20 }, { x: 30 }], buf, 4);

        const f32 = new Float32Array(buf);
        // items start at byte 4 = float index 1
        expect(f32[1]).toBeCloseTo(10);
        expect(f32[2]).toBeCloseTo(20);
        expect(f32[3]).toBeCloseTo(30);
    });

    test('throws when buffer is too small', () => {
        const S = struct('SSmall', { x: d.f32 });
        const buf = new ArrayBuffer(4); // room for 1 item
        expect(() => writeStructArray(S, [{ x: 1 }, { x: 2 }], buf)).toThrow(RangeError);
    });
});

// ---------------------------------------------------------------------------
// arrayOf descriptor
// ---------------------------------------------------------------------------

describe('arrayOf', () => {
    test('wgslType contains count', () => {
        const desc = d.arrayOf(d.vec3f, 100);
        expect(desc.wgslType).toBe('array<vec3f, 100>');
        expect(desc.length).toBe(100);
    });

    test('isSizedArrayDesc guard', () => {
        const sized = d.arrayOf(d.f32, 10);
        const unsized = d.array(d.f32);
        expect(d.isSizedArrayDesc(sized)).toBe(true);
        expect(d.isSizedArrayDesc(unsized)).toBe(false);
    });
});
