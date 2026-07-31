import { describe, expect, test } from 'vitest';
import * as d from '../src/schema/schema';
import { layoutSizeOf, packToView, unpackFromView } from '../src/schema/pack';

// Regression guard for env-style array UBOs (e.g. makecat's `envSky` = sizedArray(vec3f, 12) LUT).
// In `wgsl-uniform` layout an array element rounds its stride up to 16 bytes, so a vec3f array packs
// with a 16-byte stride (12 bytes data + 4 pad). The emitter generates `array<vec3f, N>` and the WGSL
// driver reads element(i) at i*16; packTo{View} MUST write at the same stride or the shader reads
// garbage (symptom: env/sky renders black or wrong colours).
describe('vec3f array in a uniform buffer packs at 16-byte stride', () => {
    const N = 12;
    const schema = d.sizedArray(d.vec3f, N);

    test('layout size is N * 16 under wgsl-uniform', () => {
        expect(layoutSizeOf(schema, 'wgsl-uniform')).toBe(N * 16);
    });

    test('each element lands at offset i*16 and round-trips', () => {
        const values: [number, number, number][] = Array.from({ length: N }, (_, i) => [i + 0.5, i + 100, i + 200]);
        const buf = new ArrayBuffer(layoutSizeOf(schema, 'wgsl-uniform'));
        const view = new DataView(buf);

        packToView(schema, view, 0, values as never, 'wgsl-uniform');

        // Raw layout: element i's x is a float at byte i*16.
        const f32 = new Float32Array(buf);
        for (let i = 0; i < N; i++) {
            expect(f32[(i * 16) / 4]).toBeCloseTo(i + 0.5, 5); // x at i*16
            expect(f32[(i * 16) / 4 + 1]).toBeCloseTo(i + 100, 5); // y
            expect(f32[(i * 16) / 4 + 2]).toBeCloseTo(i + 200, 5); // z
        }

        // Round-trip through the reader.
        const out = unpackFromView(schema, view, 0, 'wgsl-uniform') as [number, number, number][];
        expect(out).toHaveLength(N);
        for (let i = 0; i < N; i++) {
            expect(out[i][0]).toBeCloseTo(i + 0.5, 5);
            expect(out[i][1]).toBeCloseTo(i + 100, 5);
            expect(out[i][2]).toBeCloseTo(i + 200, 5);
        }
    });
});
