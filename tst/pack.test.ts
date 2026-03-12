import { describe, expect, test } from 'vitest';
import * as d from '../src/schema/schema';
import { struct } from '../src/nodes/nodes';
import {
    pack,
    packTo,
    packArray,
    unpack,
    unpackArray,
    layoutSizeOf,
    layoutStrideOf,
    getCompiledLayout,
    packToView,
    unpackFromView,
} from '../src/schema/pack';

// ---------------------------------------------------------------------------
// layoutSizeOf / layoutStrideOf
// ---------------------------------------------------------------------------

describe('layoutSizeOf', () => {
    describe('storage', () => {
        test('f32: 4', () => expect(layoutSizeOf(d.f32, 'storage')).toBe(4));
        test('vec2f: 8', () => expect(layoutSizeOf(d.vec2f, 'storage')).toBe(8));
        test('vec3f: 12', () => expect(layoutSizeOf(d.vec3f, 'storage')).toBe(12));
        test('vec4f: 16', () => expect(layoutSizeOf(d.vec4f, 'storage')).toBe(16));
        test('mat3x3f: 48', () => expect(layoutSizeOf(d.mat3x3f, 'storage')).toBe(48));
        test('mat4x4f: 64', () => expect(layoutSizeOf(d.mat4x4f, 'storage')).toBe(64));
    });

    describe('uniform', () => {
        test('f32: 4', () => expect(layoutSizeOf(d.f32, 'uniform')).toBe(4));
        test('vec3f: 12', () => expect(layoutSizeOf(d.vec3f, 'uniform')).toBe(12));
        test('mat3x3f: 48', () => expect(layoutSizeOf(d.mat3x3f, 'uniform')).toBe(48));
    });
    
    describe('defaults to storage', () => {
        test('f32: 4', () => expect(layoutSizeOf(d.f32)).toBe(4));
    });
});

describe('layoutStrideOf', () => {
    describe('storage', () => {
        test('f32 stride: 4', () => expect(layoutStrideOf(d.f32, 'storage')).toBe(4));
        test('vec3f stride: 16', () => expect(layoutStrideOf(d.vec3f, 'storage')).toBe(16));
    });

    describe('uniform', () => {
        test('f32 stride: 4', () => expect(layoutStrideOf(d.f32, 'uniform')).toBe(4));
        test('vec3f stride: 16', () => expect(layoutStrideOf(d.vec3f, 'uniform')).toBe(16));
    });
    
    describe('defaults to storage', () => {
        test('f32 stride: 4', () => expect(layoutStrideOf(d.f32)).toBe(4));
    });
});

// ---------------------------------------------------------------------------
// pack/unpack primitives
// ---------------------------------------------------------------------------

describe('pack/unpack primitives', () => {
    test('f32', () => {
        const buf = pack(d.f32, 3.14);
        const result = unpack(d.f32, buf);
        expect(result).toBeCloseTo(3.14);
    });

    test('i32', () => {
        const buf = pack(d.i32, -42);
        const result = unpack(d.i32, buf);
        expect(result).toBe(-42);
    });

    test('u32', () => {
        const buf = pack(d.u32, 12345);
        const result = unpack(d.u32, buf);
        expect(result).toBe(12345);
    });

    test('vec2f', () => {
        const buf = pack(d.vec2f, [1.5, 2.5]);
        const result = unpack(d.vec2f, buf);
        expect(result[0]).toBeCloseTo(1.5);
        expect(result[1]).toBeCloseTo(2.5);
    });

    test('vec3f', () => {
        const buf = pack(d.vec3f, [1, 2, 3]);
        const result = unpack(d.vec3f, buf);
        expect(result[0]).toBeCloseTo(1);
        expect(result[1]).toBeCloseTo(2);
        expect(result[2]).toBeCloseTo(3);
    });

    test('vec4f', () => {
        const buf = pack(d.vec4f, [1, 2, 3, 4]);
        const result = unpack(d.vec4f, buf);
        expect(result[0]).toBeCloseTo(1);
        expect(result[1]).toBeCloseTo(2);
        expect(result[2]).toBeCloseTo(3);
        expect(result[3]).toBeCloseTo(4);
    });

    test('vec3i', () => {
        const buf = pack(d.vec3i, [-1, 0, 1]);
        const result = unpack(d.vec3i, buf);
        expect(result).toEqual([-1, 0, 1]);
    });

    test('vec4u', () => {
        const buf = pack(d.vec4u, [10, 20, 30, 40]);
        const result = unpack(d.vec4u, buf);
        expect(result).toEqual([10, 20, 30, 40]);
    });
});

// ---------------------------------------------------------------------------
// pack/unpack matrices
// ---------------------------------------------------------------------------

describe('pack/unpack matrices', () => {
    test('mat2x2f', () => {
        const value: [number, number, number, number] = [1, 2, 3, 4]; // col-major: col0=[1,2], col1=[3,4]
        const buf = pack(d.mat2x2f, value);
        const result = unpack(d.mat2x2f, buf);
        expect(result).toEqual(value);
    });

    test('mat3x3f', () => {
        // 3 columns, 3 rows each = 9 values
        const value: [number, number, number, number, number, number, number, number, number] = [1, 2, 3, 4, 5, 6, 7, 8, 9];
        const buf = pack(d.mat3x3f, value);
        const result = unpack(d.mat3x3f, buf);
        expect(result).toEqual(value);
    });

    test('mat4x4f', () => {
        const value: [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number] = 
            [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
        const buf = pack(d.mat4x4f, value);
        const result = unpack(d.mat4x4f, buf);
        expect(result).toEqual(value);
    });

    test('mat3x3f layout: columns padded to 16 bytes', () => {
        const value: [number, number, number, number, number, number, number, number, number] = [1, 2, 3, 4, 5, 6, 7, 8, 9];
        const buf = pack(d.mat3x3f, value);

        // Check raw layout: each column at 16-byte offset
        // col0: bytes 0-11, col1: bytes 16-27, col2: bytes 32-43
        const f32 = new Float32Array(buf);
        expect(f32[0]).toBeCloseTo(1);
        expect(f32[1]).toBeCloseTo(2);
        expect(f32[2]).toBeCloseTo(3);
        expect(f32[4]).toBeCloseTo(4); // col1 starts at index 4 (byte 16)
        expect(f32[5]).toBeCloseTo(5);
        expect(f32[6]).toBeCloseTo(6);
        expect(f32[8]).toBeCloseTo(7); // col2 starts at index 8 (byte 32)
    });
});

// ---------------------------------------------------------------------------
// pack/unpack structs
// ---------------------------------------------------------------------------

describe('pack/unpack structs', () => {
    test('flat struct with f32 fields', () => {
        const S = struct('S', { a: d.f32, b: d.f32, c: d.f32 });
        const value = { a: 1, b: 2, c: 3 };
        
        const buf = pack(S, value);
        const result = unpack(S, buf);
        
        expect(result.a).toBeCloseTo(1);
        expect(result.b).toBeCloseTo(2);
        expect(result.c).toBeCloseTo(3);
    });

    test('struct with vec3f and f32', () => {
        const Particle = struct('Particle', {
            position: d.vec3f,
            health: d.f32,
        });
        
        const size = layoutSizeOf(Particle);
        expect(size).toBe(16); // vec3f(12) + f32(4), aligned to 16
        
        const value = { position: [10, 20, 30] as [number, number, number], health: 100 };
        const buf = pack(Particle, value);
        const result = unpack(Particle, buf);
        
        expect(result.position[0]).toBeCloseTo(10);
        expect(result.position[1]).toBeCloseTo(20);
        expect(result.position[2]).toBeCloseTo(30);
        expect(result.health).toBeCloseTo(100);
    });

    test('struct with two vec3f fields: padding between them', () => {
        const S = struct('Vec3Pair', { a: d.vec3f, b: d.vec3f });
        
        const size = layoutSizeOf(S);
        expect(size).toBe(32); // vec3f(12) + padding(4) + vec3f(12) + padding(4)
        
        const value = { 
            a: [1, 2, 3] as [number, number, number], 
            b: [4, 5, 6] as [number, number, number] 
        };
        
        const buf = pack(S, value);
        const result = unpack(S, buf);
        
        expect(result.a).toEqual([1, 2, 3]);
        expect(result.b).toEqual([4, 5, 6]);
        
        // Verify raw layout: b starts at offset 16
        const f32 = new Float32Array(buf);
        expect(f32[4]).toBeCloseTo(4); // b.x at byte 16
    });

    test('struct with mixed types', () => {
        const S = struct('Mixed', {
            uv: d.vec2f,
            id: d.u32,
            scale: d.f32,
        });
        
        const value = { uv: [0.5, 0.25] as [number, number], id: 42, scale: 2.0 };
        const buf = pack(S, value);
        const result = unpack(S, buf);
        
        expect(result.uv[0]).toBeCloseTo(0.5);
        expect(result.uv[1]).toBeCloseTo(0.25);
        expect(result.id).toBe(42);
        expect(result.scale).toBeCloseTo(2.0);
    });
});

// ---------------------------------------------------------------------------
// packTo with offsets (array element access)
// ---------------------------------------------------------------------------

describe('packTo with offsets', () => {
    test('write array of structs with packTo', () => {
        const Particle = struct('Particle', {
            position: d.vec3f,
            health: d.f32,
        });
        
        const stride = layoutStrideOf(Particle);
        const count = 3;
        const buf = new ArrayBuffer(stride * count);
        
        const particles = [
            { position: [0, 0, 0] as [number, number, number], health: 100 },
            { position: [1, 1, 1] as [number, number, number], health: 80 },
            { position: [2, 2, 2] as [number, number, number], health: 60 },
        ];
        
        for (let i = 0; i < count; i++) {
            packTo(Particle, buf, i * stride, particles[i]);
        }
        
        for (let i = 0; i < count; i++) {
            const result = unpack(Particle, buf, i * stride);
            expect(result.position).toEqual(particles[i].position);
            expect(result.health).toBeCloseTo(particles[i].health);
        }
    });

    test('update single element at index', () => {
        const S = struct('Item', { value: d.f32 });
        const stride = layoutStrideOf(S);
        const count = 5;
        const buf = new ArrayBuffer(stride * count);
        
        // Write initial values
        for (let i = 0; i < count; i++) {
            packTo(S, buf, i * stride, { value: i * 10 });
        }
        
        // Update element at index 2
        packTo(S, buf, 2 * stride, { value: 999 });
        
        // Verify all values
        expect(unpack(S, buf, 0 * stride).value).toBeCloseTo(0);
        expect(unpack(S, buf, 1 * stride).value).toBeCloseTo(10);
        expect(unpack(S, buf, 2 * stride).value).toBeCloseTo(999);
        expect(unpack(S, buf, 3 * stride).value).toBeCloseTo(30);
        expect(unpack(S, buf, 4 * stride).value).toBeCloseTo(40);
    });
    
    test('packTo works with TypedArray', () => {
        const S = struct('Item', { x: d.f32, y: d.f32 });
        const f32 = new Float32Array(4);
        
        packTo(S, f32, 0, { x: 1.5, y: 2.5 });
        
        expect(f32[0]).toBeCloseTo(1.5);
        expect(f32[1]).toBeCloseTo(2.5);
    });
});

// ---------------------------------------------------------------------------
// packArray / unpackArray
// ---------------------------------------------------------------------------

describe('packArray / unpackArray', () => {
    test('packArray creates buffer with correct size', () => {
        const S = struct('Item', { x: d.f32 });
        const items = [{ x: 1 }, { x: 2 }, { x: 3 }];
        
        const buf = packArray(S, items);
        expect(buf.byteLength).toBe(layoutStrideOf(S) * items.length);
    });
    
    test('unpackArray reads all items', () => {
        const S = struct('Item', { x: d.f32, y: d.f32 });
        const items = [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }];
        
        const buf = packArray(S, items);
        const result = unpackArray(S, buf, items.length);
        
        expect(result).toEqual(items);
    });
    
    test('packArray with structs', () => {
        const Particle = struct('Particle', {
            position: d.vec3f,
            health: d.f32,
        });
        
        const particles = [
            { position: [0, 0, 0] as [number, number, number], health: 100 },
            { position: [1, 1, 1] as [number, number, number], health: 80 },
        ];
        
        const buf = packArray(Particle, particles);
        const result = unpackArray(Particle, buf, 2);
        
        expect(result[0].position).toEqual([0, 0, 0]);
        expect(result[0].health).toBeCloseTo(100);
        expect(result[1].position).toEqual([1, 1, 1]);
        expect(result[1].health).toBeCloseTo(80);
    });
});

// ---------------------------------------------------------------------------
// nested structs
// ---------------------------------------------------------------------------

describe('nested structs', () => {
    test('struct containing struct', () => {
        const Inner = struct('Inner', { x: d.f32, y: d.f32 });
        const Outer = struct('Outer', { inner: Inner, z: d.f32 });
        
        const value = { inner: { x: 1, y: 2 }, z: 3 };
        const buf = pack(Outer, value);
        const result = unpack(Outer, buf);
        
        expect(result.inner.x).toBeCloseTo(1);
        expect(result.inner.y).toBeCloseTo(2);
        expect(result.z).toBeCloseTo(3);
    });

    test('deeply nested struct', () => {
        const A = struct('A', { val: d.f32 });
        const B = struct('B', { a: A, extra: d.i32 });
        const C = struct('C', { b: B, flag: d.u32 });
        
        const value = { b: { a: { val: 3.14 }, extra: -42 }, flag: 1 };
        const buf = pack(C, value);
        const result = unpack(C, buf);
        
        expect(result.b.a.val).toBeCloseTo(3.14);
        expect(result.b.extra).toBe(-42);
        expect(result.flag).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// sized arrays in schemas
// ---------------------------------------------------------------------------

describe('sized arrays in schemas', () => {
    test('array of f32', () => {
        const arr = d.sizedArray(d.f32, 4);
        const value = [1, 2, 3, 4] as [number, number, number, number];
        
        const buf = pack(arr, value);
        const result = unpack(arr, buf);
        
        expect(result).toEqual([1, 2, 3, 4]);
    });

    test('array of vec3f', () => {
        const arr = d.sizedArray(d.vec3f, 3);
        const size = layoutSizeOf(arr);
        expect(size).toBe(3 * 16); // vec3f stride = 16
        
        const value: [number, number, number][] = [
            [1, 2, 3],
            [4, 5, 6],
            [7, 8, 9],
        ];
        
        const buf = pack(arr, value);
        const result = unpack(arr, buf);
        
        expect(result[0]).toEqual([1, 2, 3]);
        expect(result[1]).toEqual([4, 5, 6]);
        expect(result[2]).toEqual([7, 8, 9]);
    });

    test('array of structs', () => {
        const Item = struct('Item', { pos: d.vec2f, id: d.u32 });
        const arr = d.sizedArray(Item, 2);
        
        const value = [
            { pos: [1, 2] as [number, number], id: 100 },
            { pos: [3, 4] as [number, number], id: 200 },
        ];
        
        const buf = pack(arr, value);
        const result = unpack(arr, buf);
        
        expect(result[0].pos).toEqual([1, 2]);
        expect(result[0].id).toBe(100);
        expect(result[1].pos).toEqual([3, 4]);
        expect(result[1].id).toBe(200);
    });
});

// ---------------------------------------------------------------------------
// uniform vs storage layout differences
// ---------------------------------------------------------------------------

describe('uniform vs storage layout', () => {
    test('struct alignment: uniform rounds up to 16', () => {
        const Inner = struct('Inner', { a: d.f32, b: d.f32 }); // align=4 in storage
        
        // In storage: Inner has align=4
        // In uniform: Inner has align=roundUp(4, 16)=16
        const storageAlign = layoutStrideOf(Inner, 'storage');
        const uniformAlign = layoutStrideOf(Inner, 'uniform');
        
        expect(storageAlign).toBe(8); // 2 * f32
        expect(uniformAlign).toBe(16); // rounded up to 16
    });

    test('array element alignment: uniform rounds up to 16', () => {
        const arr = d.sizedArray(d.f32, 4);
        
        // Storage: f32 has align=4, stride=4
        // Uniform: array elements have align=roundUp(4, 16)=16
        const storageSize = layoutSizeOf(arr, 'storage');
        const uniformSize = layoutSizeOf(arr, 'uniform');
        
        expect(storageSize).toBe(16); // 4 * 4
        expect(uniformSize).toBe(64); // 4 * 16
    });

    test('array of vec3f: same in both (already 16-aligned)', () => {
        const arr = d.sizedArray(d.vec3f, 2);
        
        const storageSize = layoutSizeOf(arr, 'storage');
        const uniformSize = layoutSizeOf(arr, 'uniform');
        
        // vec3f already has align=16, so no difference
        expect(storageSize).toBe(32);
        expect(uniformSize).toBe(32);
    });
});

// ---------------------------------------------------------------------------
// caching
// ---------------------------------------------------------------------------

describe('caching', () => {
    test('same schema returns same compiled layout', () => {
        const S = struct('CacheTest', { x: d.f32 });
        
        const layout1 = getCompiledLayout(S);
        const layout2 = getCompiledLayout(S);
        
        expect(layout1).toBe(layout2);
    });

    test('different address space returns different layout', () => {
        const S = struct('CacheTest2', { x: d.f32 });
        
        const storageLayout = getCompiledLayout(S, 'storage');
        const uniformLayout = getCompiledLayout(S, 'uniform');
        
        expect(storageLayout).not.toBe(uniformLayout);
    });
});

// ---------------------------------------------------------------------------
// packToView / unpackFromView (internal API)
// ---------------------------------------------------------------------------

describe('packToView / unpackFromView', () => {
    test('packToView writes to DataView', () => {
        const S = struct('Item', { x: d.f32, y: d.f32 });
        const buf = new ArrayBuffer(8);
        const view = new DataView(buf);
        
        packToView(S, view, 0, { x: 1.5, y: 2.5 });
        
        expect(view.getFloat32(0, true)).toBeCloseTo(1.5);
        expect(view.getFloat32(4, true)).toBeCloseTo(2.5);
    });
    
    test('unpackFromView reads from DataView', () => {
        const S = struct('Item', { x: d.f32, y: d.f32 });
        const buf = new ArrayBuffer(8);
        const view = new DataView(buf);
        view.setFloat32(0, 3.14, true);
        view.setFloat32(4, 2.71, true);
        
        const result = unpackFromView(S, view, 0);
        
        expect(result.x).toBeCloseTo(3.14);
        expect(result.y).toBeCloseTo(2.71);
    });
});
