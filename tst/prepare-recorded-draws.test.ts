import { expect, test } from 'vitest';
import { createRenderTarget } from '../src/core/render-target';
import { Geometry } from '../src/geometry/geometry';
import { Material } from '../src/material/material';
import { Mesh } from '../src/objects/mesh';
import { bundle } from '../src/renderer/core/bundle';
import type { DrawOpts, DrawRecord, PassEntry } from '../src/renderer/core/frame';
import * as NodeManager from '../src/renderer/core/node-manager';
import { createRenderContextsState, getRenderContext } from '../src/renderer/core/pass-context';
import * as RenderObjects from '../src/renderer/core/render-objects';
import type { PreparedRenderObject, PreparedSegment } from '../src/renderer/core/render-types';
import { prepareRecordedDraws, type RendererState } from '../src/renderer/core/renderer-ops';
import type { View } from '../src/renderer/core/view';

const camera = {
    projectionMatrix: null,
    matrixWorldInverse: null,
    matrixWorld: null,
    near: 0.1,
    far: 100,
    coordinateSystem: 1,
} as unknown as View;

function state() {
    return {
        inspector: null,
        _renderObjects: RenderObjects.createRenderObjectsState(),
        _nodes: NodeManager.createNodeManagerState(),
    } as unknown as RendererState;
}

const mesh = (name: string) => {
    const m = new Mesh(new Geometry(), new Material({ vertex: { id: 1 } as never }));
    m.name = name;
    return m;
};

const record = (m: Mesh): DrawRecord => ({ kind: 'draw', mesh: m, material: m.material, opts: null });

function ctx() {
    return getRenderContext(createRenderContextsState(), createRenderTarget(8, 8), null);
}

test('records become render objects in recorded order', () => {
    const records = [mesh('a'), mesh('b'), mesh('c')].map(record);
    const out: PreparedRenderObject[] = [];

    const n = prepareRecordedDraws(state(), records, records.length, camera, ctx(), 'render', () => true, out, [], []);

    expect(n).toBe(3);
    expect(out.slice(0, n).map((ro) => ro.mesh.name)).toEqual(['a', 'b', 'c']);
});

test('prepare returning false drops that draw and does not shift the rest', () => {
    const records = [mesh('a'), mesh('b'), mesh('c')].map(record);
    const out: PreparedRenderObject[] = [];

    const n = prepareRecordedDraws(
        state(),
        records,
        records.length,
        camera,
        ctx(),
        'render',
        (_nodes, ro) => ro.mesh.name !== 'b',
        out,
        [],
        [],
    );

    expect(n).toBe(2);
    expect(out.slice(0, n).map((ro) => ro.mesh.name)).toEqual(['a', 'c']);
});

test('only the first `count` records are read', () => {
    const records = [mesh('a'), mesh('b'), mesh('c')].map(record);
    const out: PreparedRenderObject[] = [];

    const n = prepareRecordedDraws(state(), records, 1, camera, ctx(), 'render', () => true, out, [], []);

    expect(n).toBe(1);
    expect(out[0].mesh.name).toBe('a');
});

test('the same mesh and material reuse one render object across calls', () => {
    const shared = state();
    const passCtx = ctx();
    const m = mesh('a');
    const out: PreparedRenderObject[] = [];

    prepareRecordedDraws(shared, [record(m)], 1, camera, passCtx, 'render', () => true, out, [], []);
    const first = out[0];
    prepareRecordedDraws(shared, [record(m)], 1, camera, passCtx, 'render', () => true, out, [], []);

    expect(out[0]).toBe(first);
});

test('the out array is reused, so a steady-state pass allocates nothing', () => {
    const records = [mesh('a'), mesh('b')].map(record);
    const out: PreparedRenderObject[] = [];
    const shared = state();
    const passCtx = ctx();

    prepareRecordedDraws(shared, records, 2, camera, passCtx, 'render', () => true, out, [], []);
    const backing = out;
    prepareRecordedDraws(shared, records, 2, camera, passCtx, 'render', () => true, out, [], []);

    expect(out).toBe(backing);
    expect(out).toHaveLength(2);
});

test('per-submission opts travel beside the prepared object, one slot each', () => {
    const records = [mesh('a'), mesh('b')].map(record);
    records[0].opts = { instances: 7 };
    records[1].opts = null;
    const out: PreparedRenderObject[] = [];
    const outOpts: (DrawOpts | null)[] = [];

    const n = prepareRecordedDraws(state(), records, records.length, camera, ctx(), 'render', () => true, out, outOpts, []);

    expect(n).toBe(2);
    expect(outOpts[0]).toEqual({ instances: 7 });
    expect(outOpts[1]).toBeNull();
});

test('a dropped draw does not shift the opts out of step with the objects', () => {
    const records = [mesh('a'), mesh('b'), mesh('c')].map(record);
    records[0].opts = { instances: 1 };
    records[1].opts = { instances: 2 };
    records[2].opts = { instances: 3 };
    const out: PreparedRenderObject[] = [];
    const outOpts: (DrawOpts | null)[] = [];

    const n = prepareRecordedDraws(
        state(),
        records,
        records.length,
        camera,
        ctx(),
        'render',
        (_nodes, ro) => ro.mesh.name !== 'b',
        out,
        outOpts,
        [],
    );

    expect(n).toBe(2);
    expect(out.slice(0, n).map((ro) => ro.mesh.name)).toEqual(['a', 'c']);
    expect(outOpts.slice(0, n)).toEqual([{ instances: 1 }, { instances: 3 }]);
});

/**
 * Segments are what let WebGPU record one device bundle per run instead of re-encoding its draws.
 * A bundle's draws are still prepared — a bundle has to be prepared before it can be recorded — so
 * the segment is a range over the same flat array, not a separate list.
 */
test('a bundle becomes one segment, and the draws around it become their own', () => {
    const b = bundle();
    b.draw(mesh('x'));
    b.draw(mesh('y'));
    const pair = b.finish();

    const records: PassEntry[] = [record(mesh('before')), { kind: 'bundle', bundle: pair }, record(mesh('after'))];
    const out: PreparedRenderObject[] = [];
    const segments: PreparedSegment[] = [];

    const n = prepareRecordedDraws(state(), records, records.length, camera, ctx(), 'render', () => true, out, [], segments);

    expect(n).toBe(4);
    expect(out.slice(0, n).map((ro) => ro.mesh.name)).toEqual(['before', 'x', 'y', 'after']);
    expect(segments).toEqual([
        { bundle: null, start: 0, count: 1 },
        { bundle: pair, start: 1, count: 2 },
        { bundle: null, start: 3, count: 1 },
    ]);
});
