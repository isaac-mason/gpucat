/* Resolving a geometry's drawRange: the clamp that had drifted between the two backends. */

import { describe, expect, test } from 'vitest';
import { createIndexBuffer, createVertexBuffer } from '../src/core/gpu-buffer';
import { Geometry } from '../src/geometry/geometry';
import { resolveIndexedDrawRange, resolveVertexDrawRange } from '../src/renderer/core/draw-range';
import * as d from '../src/schema/schema';

/** `vertices` positions, and an index buffer of `indices` entries when asked for. */
function geometry(vertices: number, indices?: number): Geometry {
    const geo = new Geometry();
    geo.setBuffer('position', createVertexBuffer(d.vec3f, new Float32Array(vertices * 3)));
    if (indices !== undefined) geo.setIndex(createIndexBuffer(new Uint32Array(indices)));
    return geo;
}

describe('indexed', () => {
    test('the default range draws every index', () => {
        expect(resolveIndexedDrawRange(geometry(4, 6))).toEqual({ first: 0, count: 6 });
    });

    test('an explicit count is honoured', () => {
        const geo = geometry(4, 6);
        geo.drawRange = { start: 0, count: 3 };
        expect(resolveIndexedDrawRange(geo)).toEqual({ first: 0, count: 3 });
    });

    test('a non-zero start clamps against what REMAINS, not the whole buffer', () => {
        // The drift: clamping against total length let start + count overrun the buffer. With
        // start 4 of 6 indices, at most 2 remain however many were asked for.
        const geo = geometry(4, 6);
        geo.drawRange = { start: 4, count: Infinity };
        expect(resolveIndexedDrawRange(geo)).toEqual({ first: 4, count: 2 });

        geo.drawRange = { start: 4, count: 6 };
        expect(resolveIndexedDrawRange(geo)).toEqual({ first: 4, count: 2 });
    });

    test('a start past the end draws nothing rather than a negative count', () => {
        const geo = geometry(4, 6);
        geo.drawRange = { start: 10, count: Infinity };
        expect(resolveIndexedDrawRange(geo)).toEqual({ first: 10, count: 0 });
    });

    test('no index buffer resolves to an empty range', () => {
        expect(resolveIndexedDrawRange(geometry(4))).toEqual({ first: 0, count: 0 });
    });
});

describe('non-indexed', () => {
    test('the default range draws every vertex, never Infinity', () => {
        // `drawRange` defaults to count: Infinity. Passing that straight to a draw call is what the
        // WebGPU path used to do; the vertex count comes from the position attribute instead.
        const resolved = resolveVertexDrawRange(geometry(3));
        expect(resolved).toEqual({ first: 0, count: 3 });
        expect(Number.isFinite(resolved.count)).toBe(true);
    });

    test('an explicit count smaller than the buffer is honoured', () => {
        const geo = geometry(9);
        geo.drawRange = { start: 0, count: 3 };
        expect(resolveVertexDrawRange(geo)).toEqual({ first: 0, count: 3 });
    });

    test('an explicit count larger than the buffer is clamped to it', () => {
        const geo = geometry(3);
        geo.drawRange = { start: 0, count: 99 };
        expect(resolveVertexDrawRange(geo)).toEqual({ first: 0, count: 3 });
    });

    test('a non-zero start clamps against the remaining vertices', () => {
        const geo = geometry(9);
        geo.drawRange = { start: 6, count: Infinity };
        expect(resolveVertexDrawRange(geo)).toEqual({ first: 6, count: 3 });
    });

    test('a start past the end draws nothing', () => {
        const geo = geometry(3);
        geo.drawRange = { start: 5, count: Infinity };
        expect(resolveVertexDrawRange(geo)).toEqual({ first: 5, count: 0 });
    });

    test('no position attribute falls back without producing Infinity', () => {
        const geo = new Geometry();
        expect(resolveVertexDrawRange(geo)).toEqual({ first: 0, count: 3 });
    });
});
