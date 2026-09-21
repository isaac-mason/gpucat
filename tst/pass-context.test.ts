import { expect, test } from 'vitest';
import { createRenderTarget, type RenderTarget } from '../src/core/render-target';
import { type CanvasTarget, createCanvasTarget } from '../src/renderer/core/canvas-target';
import { createRenderContextsState, getRenderContext } from '../src/renderer/core/pass-context';

function gbuffer(names: [string, string]): RenderTarget {
    const rt = createRenderTarget(64, 64, { count: 2, colorFormat: 'rgba16float' });
    rt.textures[0].name = names[0];
    rt.textures[1].name = names[1];
    return rt;
}

test('same-shaped targets share a render context', () => {
    const state = createRenderContextsState();
    const a = createRenderTarget(64, 64, { colorFormat: 'rgba16float' });
    const b = createRenderTarget(64, 64, { colorFormat: 'rgba16float' });

    expect(getRenderContext(state, a, null)).toBe(getRenderContext(state, b, null));
});

test('differing formats split the context', () => {
    const state = createRenderContextsState();
    const a = createRenderTarget(64, 64, { colorFormat: 'rgba16float' });
    const b = createRenderTarget(64, 64, { colorFormat: 'rgba8unorm' });

    expect(getRenderContext(state, a, null)).not.toBe(getRenderContext(state, b, null));
});

test('differing texture names split the context, because MRT resolves outputs by name', () => {
    // node-manager resolves through the context's target, which is whichever one created it.
    const state = createRenderContextsState();
    const lit = gbuffer(['albedo', 'normal']);
    const velocity = gbuffer(['colour', 'motion']);

    expect(lit.getTextureIndex('albedo')).toBe(0);
    expect(velocity.getTextureIndex('albedo')).toBe(-1);

    expect(getRenderContext(state, lit, null)).not.toBe(getRenderContext(state, velocity, null));
});

test('identical names and formats still share', () => {
    const state = createRenderContextsState();
    const a = gbuffer(['albedo', 'normal']);
    const b = gbuffer(['albedo', 'normal']);

    expect(getRenderContext(state, a, null)).toBe(getRenderContext(state, b, null));
});

/** A context's shape needs no device, so a bare sized canvas is enough. */
function canvas(opts: { samples?: number; depthFormat?: 'depth24plus' | 'depth24plus-stencil8' } = {}): CanvasTarget {
    return createCanvasTarget({ width: 64, height: 64 } as OffscreenCanvas, opts);
}

test('two canvases sharing a shape share a context', () => {
    const state = createRenderContextsState();

    expect(getRenderContext(state, canvas(), null)).toBe(getRenderContext(state, canvas(), null));
});

test('a canvas and a render target never share a context', () => {
    const state = createRenderContextsState();
    const rt = createRenderTarget(64, 64, { colorFormat: 'rgba16float' });

    expect(getRenderContext(state, canvas(), null)).not.toBe(getRenderContext(state, rt, null));
});

test('differing canvas sample counts split the context, so neither builds on the other pipeline', () => {
    const state = createRenderContextsState();

    const single = getRenderContext(state, canvas(), null);
    const msaa = getRenderContext(state, canvas({ samples: 4 }), null);

    expect(single).not.toBe(msaa);
    expect(single.sampleCount).toBe(1);
    expect(msaa.sampleCount).toBe(4);
});

test('differing canvas depth formats split the context, and the stencil aspect follows the target', () => {
    const state = createRenderContextsState();

    const plain = getRenderContext(state, canvas(), null);
    const stencilled = getRenderContext(state, canvas({ depthFormat: 'depth24plus-stencil8' }), null);

    expect(plain).not.toBe(stencilled);
    expect(plain.stencil).toBe(false);
    expect(stencilled.stencil).toBe(true);
});
