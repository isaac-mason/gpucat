import { describe, expect, test } from 'vitest';
import { createStructTexture } from '../src/texture/data-texture';
import { struct } from '../src/nodes/lib/core';
import { structFieldLayout, unpack } from '../src/schema/pack';
import * as d from '../src/schema/schema';

// DataTexture pack family — the CPU-side schema-typed write into an rgba32uint struct texture. Records
// are laid out std430, one every `texelStride` texels (16 B each); read back by reinterpreting the
// backing buffer at the record's byte offset. Parallels the GpuBuffer pack tests.

const Rec = struct('Rec', { color: d.vec4f, id: d.u32 });
const { texelStride } = structFieldLayout(Rec as never);

describe('DataTexture.packAtIndex / packAtTexel', () => {
    test('packAtIndex(i) === packAtTexel(i · texelStride) and round-trips', () => {
        const a = createStructTexture(Rec, 4);
        const b = createStructTexture(Rec, 4);
        const rec = { color: [0.25, 0.5, 0.75, 1], id: 42 };
        a.packAtIndex(Rec, 2, rec);
        b.packAtTexel(Rec, 2 * texelStride, rec);
        expect(Array.from(b.data as Uint32Array)).toEqual(Array.from(a.data as Uint32Array));
        // Read record 2 straight out of the backing rgba32uint buffer (std430 at its texel byte offset).
        const back = unpack(Rec, (a.data as Uint32Array).buffer, 2 * texelStride * 16);
        expect(back).toEqual(rec);
    });
});

describe('DataTexture.pack — bulk whole-array write', () => {
    test('fills every record and flags a full re-upload (no partial ranges)', () => {
        const tex = createStructTexture(Rec, 3);
        // Pre-dirty a partial range to prove pack() supersedes it with a full upload.
        tex.packAtIndex(Rec, 0, { color: [0, 0, 0, 0], id: 0 });
        expect(tex._gpuTexture.updateRanges.length).toBeGreaterThan(0);

        const v0 = tex.version;
        // f32-exact values (dyadic rationals) so the rgba32uint round-trip is bit-exact.
        const values = [
            { color: [0.25, 0.5, 0.75, 1], id: 1 },
            { color: [0.5, 0.25, 0.125, 1], id: 2 },
            { color: [0.75, 0.5, 0.25, 1], id: 3 },
        ];
        tex.pack(Rec, values);

        for (let i = 0; i < values.length; i++) {
            expect(unpack(Rec, (tex.data as Uint32Array).buffer, i * texelStride * 16)).toEqual(values[i]);
        }
        // needsUpdate (full) — not per-record ranges; needsFullUpload wins at the renderer.
        expect(tex._gpuTexture.needsFullUpload).toBe(true);
        expect(tex.version).toBeGreaterThan(v0);
    });

    test('grows the texture (height only) to hold more records than the initial capacity', () => {
        const tex = createStructTexture(Rec, 1);
        const h0 = tex.height;
        const values = Array.from({ length: 8 }, (_, i) => ({ color: [i, 0, 0, 1], id: i }));
        tex.pack(Rec, values);
        expect(tex.height).toBeGreaterThanOrEqual(h0);
        expect(unpack(Rec, (tex.data as Uint32Array).buffer, 7 * texelStride * 16)).toEqual(values[7]);
    });
});
