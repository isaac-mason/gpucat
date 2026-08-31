import { describe, expect, test } from 'vitest';
import {
    addRegion,
    deriveMipRegion,
    normalizeRegion,
    regionTexelCount,
    regionsFromLinearRun,
    tryMergeRegions,
    type TextureRegion,
} from '../src/core/texture-region';
import { createStructTexture, DataTexture } from '../src/texture/data-texture';
import { ArrayTexture } from '../src/texture/array-texture';
import { CubeTexture } from '../src/texture/cube-texture';
import { GpuTexture } from '../src/core/gpu-texture';
import { Source } from '../src/texture/source';
import { struct } from '../src/nodes/lib/core';
import { structFieldLayout } from '../src/schema/pack';
import * as d from '../src/schema/schema';

// Texture dirty tracking is a list of boxes, merged exactly on insert. The two properties that matter:
// a merge never picks up a clean texel (no bounding-boxing), and a small write never dirties more than
// it touched. Both are what the old linear-range + covering-row-span model could not give.

const region = (r: Partial<TextureRegion>): TextureRegion =>
    normalizeRegion(r, { width: 1024, height: 1024, depth: 8 });

describe('regionsFromLinearRun - linear run to exact boxes', () => {
    test('a run inside one row is a single 1-row box, NOT the whole row', () => {
        const out = regionsFromLinearRun(10, 4, 1024);
        expect(out).toEqual([{ x: 10, y: 0, z: 0, width: 4, height: 1, depth: 1, level: 0 }]);
    });

    test('a run on a later row keeps its x offset', () => {
        // texel 2050 in a 1024-wide grid is row 2, column 2.
        const out = regionsFromLinearRun(2050, 3, 1024);
        expect(out).toEqual([{ x: 2, y: 2, z: 0, width: 3, height: 1, depth: 1, level: 0 }]);
    });

    test('a run crossing one boundary becomes head + tail', () => {
        const out = regionsFromLinearRun(1022, 4, 1024);
        expect(out).toEqual([
            { x: 1022, y: 0, z: 0, width: 2, height: 1, depth: 1, level: 0 },
            { x: 0, y: 1, z: 0, width: 2, height: 1, depth: 1, level: 0 },
        ]);
    });

    test('a long run becomes head + tail + one full-row middle, covering exactly the run', () => {
        const out = regionsFromLinearRun(1020, 1024 * 3, 1024);
        expect(out).toHaveLength(3);
        const covered = out.reduce((n, r) => n + regionTexelCount(r), 0);
        expect(covered).toBe(1024 * 3);
        // every emitted box is inside the grid
        for (const r of out) expect(r.x + r.width).toBeLessThanOrEqual(1024);
    });

    test('a run starting exactly on a row boundary emits no empty head', () => {
        const out = regionsFromLinearRun(1024, 2048, 1024);
        expect(out).toEqual([{ x: 0, y: 1, z: 0, width: 1024, height: 2, depth: 1, level: 0 }]);
    });

    test('an empty run emits nothing', () => {
        expect(regionsFromLinearRun(5, 0, 1024)).toEqual([]);
    });
});

describe('tryMergeRegions - exact union only', () => {
    test('merges horizontally when adjacent and rows agree', () => {
        const a = region({ x: 0, y: 3, width: 4, height: 1, depth: 1 });
        const b = region({ x: 4, y: 3, width: 4, height: 1, depth: 1 });
        expect(tryMergeRegions(a, b)).toMatchObject({ x: 0, y: 3, width: 8, height: 1 });
    });

    test('merges vertically when adjacent and columns agree', () => {
        const a = region({ x: 0, y: 0, width: 1024, height: 1, depth: 1 });
        const b = region({ x: 0, y: 1, width: 1024, height: 1, depth: 1 });
        expect(tryMergeRegions(a, b)).toMatchObject({ y: 0, height: 2 });
    });

    test('absorbs a contained region', () => {
        const a = region({ x: 0, y: 0, width: 100, height: 100, depth: 1 });
        const b = region({ x: 10, y: 10, width: 5, height: 5, depth: 1 });
        expect(tryMergeRegions(a, b)).toBe(a);
    });

    test('REFUSES a merge whose union is not a box - the anti-bounding-box property', () => {
        const a = region({ x: 0, y: 0, width: 4, height: 1, depth: 1 });
        const b = region({ x: 500, y: 900, width: 4, height: 1, depth: 1 });
        expect(tryMergeRegions(a, b)).toBeNull();
    });

    test('refuses rows with a gap between them', () => {
        const a = region({ x: 0, y: 0, width: 1024, height: 1, depth: 1 });
        const b = region({ x: 0, y: 5, width: 1024, height: 1, depth: 1 });
        expect(tryMergeRegions(a, b)).toBeNull();
    });

    test('merges adjacent layers - z is just another axis', () => {
        const a = region({ z: 3, depth: 1 });
        const b = region({ z: 4, depth: 1 });
        expect(tryMergeRegions(a, b)).toMatchObject({ z: 3, depth: 2 });
    });

    test('never merges across mip levels', () => {
        const a = region({ x: 0, y: 0, width: 4, height: 1, depth: 1, level: 0 });
        const b = region({ x: 4, y: 0, width: 4, height: 1, depth: 1, level: 1 });
        expect(tryMergeRegions(a, b)).toBeNull();
    });
});

describe('addRegion - insertion and coalescing', () => {
    test('a sequential write loop collapses to one region', () => {
        const list: TextureRegion[] = [];
        for (let i = 0; i < 256; i++) {
            addRegion(list, region({ x: i * 4, y: 0, width: 4, height: 1, depth: 1 }));
        }
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ x: 0, width: 1024, height: 1 });
    });

    test('sequential full rows then merge into one row span', () => {
        const list: TextureRegion[] = [];
        for (let y = 0; y < 8; y++) {
            addRegion(list, region({ x: 0, y, width: 1024, height: 1, depth: 1 }));
        }
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ y: 0, height: 8 });
    });

    test('scattered writes stay separate instead of bounding-boxing', () => {
        const list: TextureRegion[] = [];
        addRegion(list, region({ x: 0, y: 0, width: 4, height: 1, depth: 1 }));
        addRegion(list, region({ x: 0, y: 999, width: 4, height: 1, depth: 1 }));
        expect(list).toHaveLength(2);
        const covered = list.reduce((n, r) => n + regionTexelCount(r), 0);
        expect(covered).toBe(8); // a bounding span would have been 1000 rows
    });

    test('a bridging write cascades the two neighbours into one', () => {
        const list: TextureRegion[] = [];
        addRegion(list, region({ x: 0, y: 0, width: 4, height: 1, depth: 1 }));
        addRegion(list, region({ x: 8, y: 0, width: 4, height: 1, depth: 1 }));
        expect(list).toHaveLength(2);
        addRegion(list, region({ x: 4, y: 0, width: 4, height: 1, depth: 1 }));
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ x: 0, width: 12 });
    });

    test('the cap bounds the list under pathological scattering', () => {
        const list: TextureRegion[] = [];
        for (let i = 0; i < 500; i++) {
            addRegion(list, region({ x: (i * 7) % 1000, y: (i * 13) % 1000, width: 2, height: 1, depth: 1 }), 16);
        }
        expect(list.length).toBeLessThanOrEqual(16);
    });

    test('an empty region is dropped', () => {
        const list: TextureRegion[] = [];
        addRegion(list, region({ x: 0, y: 0, width: 0, height: 1, depth: 1 }));
        expect(list).toEqual([]);
    });
});

describe('DataTexture.packAtIndex - the producer', () => {
    const Rec = struct('Rec', { color: d.vec4f, id: d.u32 });
    const { texelStride } = structFieldLayout(Rec as never);
    const value = { color: [0.25, 0.5, 0.75, 1], id: 7 };

    test('a small record does not dirty the whole row', () => {
        const tex = createStructTexture(Rec, 4096);
        expect(tex.width).toBeGreaterThan(texelStride * 4); // a wide texture, so amplification would show
        tex.packAtIndex(Rec, 0, value);

        const regions = tex._gpuTexture.updateRegions;
        expect(regions).toHaveLength(1);
        expect(regions[0].width).toBe(texelStride);
        expect(regions[0].width).toBeLessThan(tex.width);
    });

    test('two far-apart records stay two regions, not one covering span', () => {
        const tex = createStructTexture(Rec, 4096);
        tex.packAtIndex(Rec, 0, value);
        tex.packAtIndex(Rec, 3000, value);

        const regions = tex._gpuTexture.updateRegions;
        expect(regions).toHaveLength(2);
        const covered = regions.reduce((n, r) => n + regionTexelCount(r), 0);
        expect(covered).toBe(texelStride * 2);
    });

    test('a dense record loop still collapses to a single region', () => {
        const tex = createStructTexture(Rec, 512);
        for (let i = 0; i < 512; i++) tex.packAtIndex(Rec, i, value);

        const regions = tex._gpuTexture.updateRegions;
        expect(regions).toHaveLength(1);
        expect(regionTexelCount(regions[0])).toBe(512 * texelStride);
    });

    test('a full re-upload supersedes queued regions', () => {
        const tex = createStructTexture(Rec, 16);
        tex.packAtIndex(Rec, 1, value);
        expect(tex._gpuTexture.updateRegions.length).toBeGreaterThan(0);
        tex.needsUpdate = true;
        expect(tex._gpuTexture.needsFullUpload).toBe(true);
    });
});

describe('deriveMipRegion - explicit mip chains patch themselves', () => {
    test('halves origin and extent, covering the footprint', () => {
        const r = region({ x: 8, y: 16, width: 8, height: 8, depth: 1 });
        expect(deriveMipRegion(r, 1, 512, 512)).toMatchObject({ x: 4, y: 8, width: 4, height: 4, level: 1 });
    });

    test('an odd box ceils its extent rather than shaving a texel', () => {
        // texels [3, 7) at level 0 touch texels [1, 4) at level 1 - floor the origin, ceil the end.
        const r = region({ x: 3, y: 0, width: 4, height: 1, depth: 1 });
        const m = deriveMipRegion(r, 1, 512, 512);
        expect(m.x).toBe(1);
        expect(m.x + m.width).toBeGreaterThanOrEqual(4);
    });

    test('never collapses to nothing, and never exceeds the level', () => {
        const r = region({ x: 0, y: 0, width: 1, height: 1, depth: 1 });
        const m = deriveMipRegion(r, 4, 4, 4);
        expect(m.width).toBeGreaterThanOrEqual(1);
        expect(m.height).toBeGreaterThanOrEqual(1);
        expect(m.x + m.width).toBeLessThanOrEqual(4);
        expect(m.y + m.height).toBeLessThanOrEqual(4);
    });

    test('layers pass through untouched - only x/y halve', () => {
        const r = region({ x: 4, y: 4, z: 3, width: 4, height: 4, depth: 2 });
        expect(deriveMipRegion(r, 1, 512, 512)).toMatchObject({ z: 3, depth: 2 });
    });
});

describe('GpuTexture.addUpdateRegion - mip auto-propagation', () => {
    const newTex = () => new GpuTexture(d.texture2d(), { width: 64, height: 64, format: 'rgba8unorm' });

    test('with no explicit mips, one region is queued', () => {
        const tex = newTex();
        tex.addUpdateRegion({ x: 0, y: 0, width: 8, height: 8 });
        expect(tex.updateRegions).toHaveLength(1);
        expect(tex.updateRegions[0].level).toBe(0);
    });

    test('with an explicit chain, every level gets a derived region', () => {
        const tex = newTex();
        tex.mipmaps = [
            new Source({ data: new Uint8Array(32 * 32 * 4), width: 32, height: 32 }),
            new Source({ data: new Uint8Array(16 * 16 * 4), width: 16, height: 16 }),
        ];
        tex.addUpdateRegion({ x: 8, y: 8, width: 8, height: 8 });

        const levels = tex.updateRegions.map((r) => r.level).sort();
        expect(levels).toEqual([0, 1, 2]);
        // level 1 covers half the coordinates of level 0
        const l1 = tex.updateRegions.find((r) => r.level === 1)!;
        expect(l1).toMatchObject({ x: 4, y: 4, width: 4, height: 4 });
    });

    test('regions at different levels never merge with each other', () => {
        const tex = newTex();
        tex.mipmaps = [new Source({ data: new Uint8Array(32 * 32 * 4), width: 32, height: 32 })];
        tex.addUpdateRegion({ x: 0, y: 0, width: 64, height: 64 });
        expect(new Set(tex.updateRegions.map((r) => r.level)).size).toBe(tex.updateRegions.length);
    });
});

describe('wrapper surface - each class in its own vocabulary', () => {
    test('ArrayTexture.addUpdateLayer lowers to a z region', () => {
        const tex = new ArrayTexture(new Uint8Array(4 * 4 * 3 * 4), 4, 4, 3, { format: 'rgba8unorm' });
        tex.addUpdateLayer(2);
        expect(tex._gpuTexture.updateRegions).toEqual([
            { x: 0, y: 0, z: 2, width: 4, height: 4, depth: 1, level: 0 },
        ]);
    });

    test('ArrayTexture.addUpdateLayer takes a sub-rect of that layer', () => {
        const tex = new ArrayTexture(new Uint8Array(8 * 8 * 2 * 4), 8, 8, 2, { format: 'rgba8unorm' });
        tex.addUpdateLayer(1, { x: 2, y: 3, width: 4, height: 4 });
        expect(tex._gpuTexture.updateRegions[0]).toMatchObject({ x: 2, y: 3, z: 1, width: 4, height: 4, depth: 1 });
    });

    test('CubeTexture.addUpdateFace lowers to the same z axis', () => {
        const face = () => ({ data: new Uint8Array(4), width: 1, height: 1 });
        const tex = new CubeTexture([face(), face(), face(), face(), face(), face()], { format: 'rgba8unorm' });
        tex.addUpdateFace(4);
        expect(tex._gpuTexture.updateRegions[0]).toMatchObject({ z: 4, depth: 1 });
    });

    test('sequential layers merge through the wrapper, same as through the primitive', () => {
        const tex = new ArrayTexture(new Uint8Array(4 * 4 * 4 * 4), 4, 4, 4, { format: 'rgba8unorm' });
        tex.addUpdateLayer(0);
        tex.addUpdateLayer(1);
        tex.addUpdateLayer(2);
        expect(tex._gpuTexture.updateRegions).toHaveLength(1);
        expect(tex._gpuTexture.updateRegions[0]).toMatchObject({ z: 0, depth: 3 });
    });

    test('wrapper methods chain', () => {
        const tex = new ArrayTexture(new Uint8Array(4 * 4 * 2 * 4), 4, 4, 2, { format: 'rgba8unorm' });
        expect(tex.addUpdateLayer(0).addUpdateLayer(1)).toBe(tex);
    });

    test('DataTexture exposes both the record run and the rectangle', () => {
        const tex = new DataTexture(new Uint32Array(8 * 8 * 4), 8, 8, { format: 'rgba32uint' });
        tex.addUpdateRegion({ x: 1, y: 1, width: 2, height: 2 });
        expect(tex._gpuTexture.updateRegions[0]).toMatchObject({ x: 1, y: 1, width: 2, height: 2 });
    });
});
