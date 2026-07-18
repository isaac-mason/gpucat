import { test, expect } from 'vitest';
import { installWebGPUPolyfills } from './stub-gpu';
import { WebGPURenderer, RenderTarget } from '../src/index';
import { createRenderContext, type RenderContext } from '../src/renderer/pass-context';

installWebGPUPolyfills();

// A headless renderer needs a device but never touches it during construction, so a stub is enough.
// With no canvas target the pixelRatio resolves to 1, keeping the resolved rects easy to assert on.
function makeRenderer(): WebGPURenderer {
    return new WebGPURenderer({ headless: true, device: {} as unknown as GPUDevice });
}

function resolve(renderer: WebGPURenderer, width: number, height: number): RenderContext {
    const ctx = createRenderContext();
    ctx.width = width;
    ctx.height = height;
    // _resolveViewportScissor is private; exercise it directly on a hand-built context.
    (renderer as unknown as { _resolveViewportScissor(c: RenderContext): void })._resolveViewportScissor(ctx);
    return ctx;
}

test('scissor is skipped when the test is disabled', () => {
    const r = makeRenderer();
    r.setScissor(10, 10, 100, 100);
    const ctx = resolve(r, 800, 600);
    expect(ctx.scissor).toBe(false);
});

test('an in-bounds sub-rect resolves and enables the scissor', () => {
    const r = makeRenderer();
    r.setScissorTest(true);
    r.setScissor(10, 20, 100, 200);
    const ctx = resolve(r, 800, 600);
    expect(ctx.scissor).toBe(true);
    expect(ctx.scissorValue).toMatchObject({ x: 10, y: 20, width: 100, height: 200 });
});

test('a full-framebuffer scissor clips nothing and is skipped', () => {
    const r = makeRenderer();
    r.setScissorTest(true);
    r.setScissor(0, 0, 800, 600);
    const ctx = resolve(r, 800, 600);
    expect(ctx.scissor).toBe(false);
});

test('an oversized scissor is clamped to the framebuffer', () => {
    const r = makeRenderer();
    r.setScissorTest(true);
    r.setScissor(700, 500, 400, 400); // extends past 800x600
    const ctx = resolve(r, 800, 600);
    expect(ctx.scissor).toBe(true);
    expect(ctx.scissorValue).toMatchObject({ x: 700, y: 500, width: 100, height: 100 });
});

test('a negative origin is pulled to zero and its extent shrunk', () => {
    const r = makeRenderer();
    r.setScissorTest(true);
    r.setScissor(-30, -40, 200, 200);
    const ctx = resolve(r, 800, 600);
    expect(ctx.scissorValue).toMatchObject({ x: 0, y: 0, width: 170, height: 160 });
});

test('viewport is resolved independently of the scissor test', () => {
    const r = makeRenderer();
    r.setViewport(5, 6, 320, 240, 0, 1);
    const ctx = resolve(r, 800, 600);
    expect(ctx.viewport).toBe(true);
    expect(ctx.viewportValue).toMatchObject({ x: 5, y: 6, width: 320, height: 240, minDepth: 0, maxDepth: 1 });
    expect(ctx.scissor).toBe(false);
});

test('a render target uses its own viewport/scissor, not the swapchain state', () => {
    const r = makeRenderer();
    // Swapchain compositing state that must NOT leak into the render-target pass.
    r.setViewport(0, 0, 100, 100);
    r.setScissorTest(true);
    r.setScissor(0, 0, 100, 100);

    const rt = new RenderTarget(256, 256, { depthBuffer: false });
    rt.scissorTest = true;
    rt.scissor = [32, 48, 64, 80];
    r.renderTarget = rt;

    const ctx = resolve(r, 256, 256); // render-target framebuffer dims
    expect(ctx.scissor).toBe(true);
    expect(ctx.scissorValue).toMatchObject({ x: 32, y: 48, width: 64, height: 80 });
    // The swapchain viewport must not appear; the target left its own viewport null (full target).
    expect(ctx.viewport).toBe(false);
});

test('setScissor/setViewport accept a Vec4 tuple', () => {
    const r = makeRenderer();
    r.setScissorTest(true);
    r.setScissor([10, 20, 100, 200]);
    r.setViewport([5, 6, 320, 240]);
    const ctx = resolve(r, 800, 600);
    expect(ctx.scissorValue).toMatchObject({ x: 10, y: 20, width: 100, height: 200 });
    expect(ctx.viewportValue).toMatchObject({ x: 5, y: 6, width: 320, height: 240, minDepth: 0, maxDepth: 1 });
});

test('a render target with no scissor set leaves the pass scissor off', () => {
    const r = makeRenderer();
    r.setScissorTest(true);
    r.setScissor(0, 0, 50, 50); // swapchain scissor — irrelevant to the target

    const rt = new RenderTarget(256, 256, { depthBuffer: false });
    r.renderTarget = rt;

    const ctx = resolve(r, 256, 256);
    expect(ctx.scissor).toBe(false);
    expect(ctx.viewport).toBe(false);
});
