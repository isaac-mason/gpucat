import { expect, test } from 'vitest';
import { createCubeRenderTarget } from '../src/core/cube-render-target';
import { createRenderTarget } from '../src/core/render-target';
import { f32, vec4f } from '../src/nodes/nodes';
import { fullscreen, vertexCountGeometry } from '../src/objects/fullscreen';
import { createCanvasTarget } from '../src/renderer/core/canvas-target';
import { createRenderContextsState } from '../src/renderer/core/pass-context';
import { resolvePassContext, resolvePassParams } from '../src/renderer/core/pass-desc';
import { createPassParams } from '../src/renderer/core/render-types';

const canvas = (w = 100, h = 50) => createCanvasTarget({ width: w, height: h } as HTMLCanvasElement);
const state = () => createRenderContextsState();

test('a canvas target resolves to the swapchain, a render target to itself', () => {
    const rt = createRenderTarget(64, 32);
    expect(resolvePassParams({ target: canvas() }, createPassParams()).renderTarget).toBeNull();
    expect(resolvePassParams({ target: rt }, createPassParams()).renderTarget).toBe(rt);
});

test('size comes from the target, honouring the canvas pixel ratio', () => {
    const view = canvas(100, 50);
    view.setPixelRatio(2);

    const params = resolvePassParams({ target: view }, createPassParams());
    expect([params.width, params.height]).toEqual([200, 100]);

    const rtParams = resolvePassParams({ target: createRenderTarget(64, 32) }, createPassParams());
    expect([rtParams.width, rtParams.height]).toEqual([64, 32]);
});

test('omitted clear uses the target own clear colour', () => {
    const rt = createRenderTarget(8, 8, { clearColor: [0.1, 0.2, 0.3, 1] });

    const params = resolvePassParams({ target: rt }, createPassParams());
    expect(params.clearColor).toEqual({ r: 0.1, g: 0.2, b: 0.3, a: 1 });
    expect(params.clearsColor).toBe(true);
});

test('an explicit clear colour overrides the target one', () => {
    const rt = createRenderTarget(8, 8, { clearColor: [0.1, 0.2, 0.3, 1] });

    const params = resolvePassParams({ target: rt, clear: [1, 0, 0, 1] }, createPassParams());
    expect(params.clearColor).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(params.clearsColor).toBe(true);
});

// These assert on resolvePassParams, the only shape a backend reads. An earlier version asserted on
// the RenderContext copies, which were computed correctly and consumed by nothing.
test('clear false preserves', () => {
    expect(resolvePassParams({ target: createRenderTarget(8, 8), clear: false }, createPassParams()).clearsColor).toBe(false);
});

test('clearDepth takes a value or false, and 0 survives for reversed-Z', () => {
    const reversed = resolvePassParams({ target: createRenderTarget(8, 8), clearDepth: 0 }, createPassParams());
    expect(reversed.clearDepthValue).toBe(0);
    expect(reversed.clearsDepth).toBe(true);

    const preserved = resolvePassParams({ target: createRenderTarget(8, 8), clearDepth: false }, createPassParams());
    expect(preserved.clearsDepth).toBe(false);

    expect(resolvePassParams({ target: createRenderTarget(8, 8) }, createPassParams()).clearDepthValue).toBe(1);
});

test('clearStencil takes a value or false', () => {
    expect(resolvePassParams({ target: createRenderTarget(8, 8), clearStencil: 7 }, createPassParams()).clearStencilValue).toBe(
        7,
    );
    expect(resolvePassParams({ target: createRenderTarget(8, 8), clearStencil: false }, createPassParams()).clearsStencil).toBe(
        false,
    );
});

test('a stencil depth format is reported for either kind of target', () => {
    const view = createCanvasTarget({ width: 8, height: 8 } as HTMLCanvasElement, { depthFormat: 'depth24plus-stencil8' });
    expect(resolvePassParams({ target: view }, createPassParams()).swapchainStencil).toBe(true);

    const plain = canvas();
    expect(resolvePassParams({ target: plain }, createPassParams()).swapchainStencil).toBe(false);
});

test('viewport and scissor are taken as physical pixels, with defaults filled', () => {
    const view = canvas(100, 50);
    view.setPixelRatio(2);

    const params = resolvePassParams(
        {
            target: view,
            viewport: { width: 320, height: 180 },
            scissor: { x: 4, y: 8, width: 16, height: 32 },
        },
        createPassParams(),
    );

    expect(params.viewport).toBe(true);
    expect(params.viewportValue).toEqual({ x: 0, y: 0, width: 320, height: 180, minDepth: 0, maxDepth: 1 });
    expect(params.scissor).toBe(true);
    expect(params.scissorValue).toEqual({ x: 4, y: 8, width: 16, height: 32 });
});

test('no viewport or scissor means the full target', () => {
    const params = resolvePassParams({ target: createRenderTarget(8, 8) }, createPassParams());
    expect(params.viewport).toBe(false);
    expect(params.scissor).toBe(false);
});

test('the label becomes the passId', () => {
    expect(resolvePassParams({ target: createRenderTarget(8, 8), label: 'gbuffer' }, createPassParams()).passId).toBe('gbuffer');
    expect(resolvePassParams({ target: createRenderTarget(8, 8) }, createPassParams()).passId).toBe('render');
});

test('fullscreen() carries a uv buffer, because a TextureNode samples with varying(uv())', () => {
    const mesh = fullscreen(vec4f(f32(1), f32(0), f32(0), f32(1)));

    // Without this a post chain reading `pass.getTextureNode().rgb` samples a constant.
    expect(mesh.geometry.buffers.has('uv')).toBe(true);
    expect(mesh.geometry.buffers.has('position')).toBe(true);
    expect(mesh.frustumCulled).toBe(false);
});

test('vertexCountGeometry is the bufferless alternative, for fragments that never sample by uv', () => {
    const geometry = vertexCountGeometry(3);

    expect(geometry.buffers.size).toBe(0);
    expect(geometry.drawRange).toEqual({ start: 0, count: 3 });
});

test('clear, clearDepth and clearStencil are independent', () => {
    const colourOnly = resolvePassParams({ target: createRenderTarget(8, 8), clearDepth: false }, createPassParams());
    expect(colourOnly.clearsColor).toBe(true);
    expect(colourOnly.clearsDepth).toBe(false);

    // Preserving colour while clearing depth is what a depth-only clear needs.
    const depthOnly = resolvePassParams({ target: createRenderTarget(8, 8), clear: false, clearDepth: 0 }, createPassParams());
    expect(depthOnly.clearsColor).toBe(false);
    expect(depthOnly.clearsDepth).toBe(true);
    expect(depthOnly.clearDepthValue).toBe(0);
});

test('mrt output names resolve against the target texture names', () => {
    const target = createRenderTarget(8, 8, { count: 2 });
    target.textures[0].name = 'output';
    target.textures[1].name = 'normal';

    expect(target.getTextureIndex('output')).toBe(0);
    expect(target.getTextureIndex('normal')).toBe(1);
    // -1 is the lookup miss; `resolveOutputs` turns it into a throw, which `mrt-outputs` holds.
    expect(target.getTextureIndex('velocity')).toBe(-1);
});

test('a context is not shared between targets whose textures are named differently', () => {
    const contexts = createRenderContextsState();
    const a = createRenderTarget(8, 8, { count: 2 });
    a.textures[0].name = 'output';
    a.textures[1].name = 'normal';
    const b = createRenderTarget(8, 8, { count: 2 });
    b.textures[0].name = 'output';
    b.textures[1].name = 'velocity';

    // Same formats and counts; only the names differ, and an MRT material resolves against them.
    expect(resolvePassContext(contexts, { target: a })).not.toBe(resolvePassContext(contexts, { target: b }));
});

test('layer and mipLevel select a cube face and level, so a plain target rejects them', () => {
    const plain = createRenderTarget(8, 8);

    expect(() => resolvePassParams({ target: plain, layer: 2 }, createPassParams())).toThrow(/has neither/);
    expect(() => resolvePassParams({ target: plain, mipLevel: 1 }, createPassParams())).toThrow(/has neither/);
    expect(() => resolvePassParams({ target: plain }, createPassParams())).not.toThrow();
});

test('a cube target takes both, and they travel with the pass', () => {
    const params = resolvePassParams(
        { target: createCubeRenderTarget(8, { generateMipmaps: true }), layer: 3, mipLevel: 1 },
        createPassParams(),
    );

    expect(params.layer).toBe(3);
    expect(params.mipLevel).toBe(1);
});

/** Six faces and no default among them; inheriting the last pass's face is how a bake writes one face six times. */
test('a cube pass must name its face, and one pass cannot inherit another one', () => {
    const cube = createCubeRenderTarget(8);

    expect(resolvePassParams({ target: cube, layer: 5 }, createPassParams()).layer).toBe(5);
    expect(() => resolvePassParams({ target: cube }, createPassParams())).toThrow(/face/);
});

/** A nested pass resolves between the outer pass's prepare and its `beginPass`. */
test('a nested pass of the same attachment shape leaves the outer pass size alone', () => {
    const contexts = state();
    const outer = createRenderTarget(64, 64);
    const nested = createRenderTarget(16, 16);

    const outerCtx = resolvePassContext(contexts, { target: outer });
    const outerParams = resolvePassParams({ target: outer }, createPassParams());

    const nestedCtx = resolvePassContext(contexts, { target: nested });

    expect(nestedCtx, 'size is not in the shape key, so the context is shared').toBe(outerCtx);
    expect(outerParams.width, 'and the size the outer pass encodes with is its own').toBe(64);
});
