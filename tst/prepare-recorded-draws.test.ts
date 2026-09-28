import { expect, test } from 'vitest';
import { createRenderTarget } from '../src/core/render-target';
import { Geometry } from '../src/geometry/geometry';
import { Material } from '../src/material/material';
import { Mesh } from '../src/objects/mesh';
import type { DrawRecord } from '../src/renderer/core/frame';
import * as NodeManager from '../src/renderer/core/node-manager';
import { createRenderContextsState, getRenderContext } from '../src/renderer/core/pass-context';
import * as RenderObjects from '../src/renderer/core/render-objects';
import { prepareRecordedDraw, type RendererState } from '../src/renderer/core/renderer-ops';
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

test('a record becomes the render object for its mesh and material', () => {
    const m = mesh('a');

    const renderObject = prepareRecordedDraw(state(), record(m), camera, ctx(), () => {});

    expect(renderObject.mesh).toBe(m);
    expect(renderObject.material).toBe(m.material);
});

test('a draw its backend cannot prepare throws from the call, rather than dropping out of the pass', () => {
    const refuse = () => {
        throw new Error("'a' has no pipeline");
    };

    expect(() => prepareRecordedDraw(state(), record(mesh('a')), camera, ctx(), refuse)).toThrow(/'a' has no pipeline/);
});

test('the same mesh and material reuse one render object across calls', () => {
    const shared = state();
    const passCtx = ctx();
    const m = mesh('a');

    const first = prepareRecordedDraw(shared, record(m), camera, passCtx, () => {});
    const second = prepareRecordedDraw(shared, record(m), camera, passCtx, () => {});

    expect(second).toBe(first);
});
