import { expect, test } from 'vitest';
import { createCubeRenderTarget } from '../src/core/cube-render-target';
import { createRenderTarget } from '../src/core/render-target';
import { f32, vec4f } from '../src/nodes/nodes';
import { fullscreen, vertexCountGeometry } from '../src/objects/fullscreen';
import { createCanvasTarget } from '../src/renderer/core/canvas-target';
import { createRenderContextsState } from '../src/renderer/core/pass-context';
import { resolvePassContext, resolvePassParams } from '../src/renderer/core/pass-desc';

const canvas = (w = 100, h = 50) => createCanvasTarget({ width: w, height: h } as HTMLCanvasElement);
const state = () => createRenderContextsState();

test('a canvas target resolves to the swapchain, a render target to itself', () => {
    const rt = createRenderTarget(64, 32);
    expect(resolvePassParams({ target: canvas() }).renderTarget).toBeNull();
    expect(resolvePassParams({ target: rt }).renderTarget).toBe(rt);
});

test('size comes from the target, honouring the canvas pixel ratio', () => {
    const view = canvas(100, 50);
    view.setPixelRatio(2);

    const ctx = resolvePassContext(state(), { target: view });
    expect([ctx.width, ctx.height]).toEqual([200, 100]);

    const rtCtx = resolvePassContext(state(), { target: createRenderTarget(64, 32) });
    expect([rtCtx.width, rtCtx.height]).toEqual([64, 32]);
});

test('omitted clear uses the target own clear colour', () => {
    const rt = createRenderTarget(8, 8, { clearColor: [0.1, 0.2, 0.3, 1] });

    const params = resolvePassParams({ target: rt });
    expect(params.clearColor).toEqual({ r: 0.1, g: 0.2, b: 0.3, a: 1 });
    expect(params.autoClear).toBe(true);
});

test('an explicit clear colour overrides the target one', () => {
    const rt = createRenderTarget(8, 8, { clearColor: [0.1, 0.2, 0.3, 1] });

    const params = resolvePassParams({ target: rt, clear: [1, 0, 0, 1] });
    expect(params.clearColor).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(params.autoClear).toBe(true);
});

// These assert on resolvePassParams, the only shape a backend reads. An earlier version asserted on
// the RenderContext copies, which were computed correctly and consumed by nothing.
test('clear false preserves', () => {
    expect(resolvePassParams({ target: createRenderTarget(8, 8), clear: false }).autoClear).toBe(false);
});

test('clearDepth takes a value or false, and 0 survives for reversed-Z', () => {
    const reversed = resolvePassParams({ target: createRenderTarget(8, 8), clearDepth: 0 });
    expect(reversed.clearDepthValue).toBe(0);
    expect(reversed.autoClearDepth).toBe(true);

    const preserved = resolvePassParams({ target: createRenderTarget(8, 8), clearDepth: false });
    expect(preserved.autoClearDepth).toBe(false);

    expect(resolvePassParams({ target: createRenderTarget(8, 8) }).clearDepthValue).toBe(1);
});

test('clearStencil takes a value or false', () => {
    expect(resolvePassParams({ target: createRenderTarget(8, 8), clearStencil: 7 }).clearStencilValue).toBe(7);
    expect(resolvePassParams({ target: createRenderTarget(8, 8), clearStencil: false }).autoClearStencil).toBe(false);
});

test('a stencil depth format is reported for either kind of target', () => {
    const view = createCanvasTarget({ width: 8, height: 8 } as HTMLCanvasElement, { depthFormat: 'depth24plus-stencil8' });
    expect(resolvePassParams({ target: view }).swapchainStencil).toBe(true);

    const plain = canvas();
    expect(resolvePassParams({ target: plain }).swapchainStencil).toBe(false);
});

test('viewport and scissor are taken as physical pixels, with defaults filled', () => {
    const view = canvas(100, 50);
    view.setPixelRatio(2);

    const ctx = resolvePassContext(state(), {
        target: view,
        viewport: { width: 320, height: 180 },
        scissor: { x: 4, y: 8, width: 16, height: 32 },
    });

    expect(ctx.viewport).toBe(true);
    expect(ctx.viewportValue).toEqual({ x: 0, y: 0, width: 320, height: 180, minDepth: 0, maxDepth: 1 });
    expect(ctx.scissor).toBe(true);
    expect(ctx.scissorValue).toEqual({ x: 4, y: 8, width: 16, height: 32 });
});

test('no viewport or scissor means the full target', () => {
    const ctx = resolvePassContext(state(), { target: createRenderTarget(8, 8) });
    expect(ctx.viewport).toBe(false);
    expect(ctx.scissor).toBe(false);
});

test('the label becomes the passId', () => {
    expect(resolvePassParams({ target: createRenderTarget(8, 8), label: 'gbuffer' }).passId).toBe('gbuffer');
    expect(resolvePassParams({ target: createRenderTarget(8, 8) }).passId).toBe('render');
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
    const colourOnly = resolvePassParams({ target: createRenderTarget(8, 8), clearDepth: false });
    expect(colourOnly.autoClear).toBe(true);
    expect(colourOnly.autoClearDepth).toBe(false);

    // Preserving colour while clearing depth is what a depth-only clear needs.
    const depthOnly = resolvePassParams({ target: createRenderTarget(8, 8), clear: false, clearDepth: 0 });
    expect(depthOnly.autoClear).toBe(false);
    expect(depthOnly.autoClearDepth).toBe(true);
    expect(depthOnly.clearDepthValue).toBe(0);
});

test('mrt output names resolve against the target texture names', () => {
    const target = createRenderTarget(8, 8, { count: 2 });
    target.textures[0].name = 'output';
    target.textures[1].name = 'normal';

    expect(target.getTextureIndex('output')).toBe(0);
    expect(target.getTextureIndex('normal')).toBe(1);
    // The contract's failure mode: an unknown name is -1, which resolveOutputs warns on and skips.
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
    const state = createRenderContextsState();
    const plain = createRenderTarget(8, 8);

    expect(() => resolvePassContext(state, { target: plain, layer: 2 })).toThrow(/has neither/);
    expect(() => resolvePassContext(state, { target: plain, mipLevel: 1 })).toThrow(/has neither/);
    expect(() => resolvePassContext(state, { target: plain })).not.toThrow();
});

test('a cube target takes both, and the backends read them off the target', () => {
    const state = createRenderContextsState();
    const cube = createCubeRenderTarget(8, { generateMipmaps: true });

    resolvePassContext(state, { target: cube, layer: 3, mipLevel: 1 });

    expect(cube.activeFace).toBe(3);
    expect(cube.activeMipmapLevel).toBe(1);
});
