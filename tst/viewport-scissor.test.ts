import { expect, test } from 'vitest';
import { Renderer } from '../src/renderer/core/renderer';
import { createRenderTarget, WebGPUBackend } from '../src/index';
import type { PassDesc } from '../src/renderer/core/frame';
import type { RenderContext } from '../src/renderer/core/pass-context';
import { resolvePassContext } from '../src/renderer/core/pass-desc';
import { installWebGPUPolyfills } from './stub-gpu';

installWebGPUPolyfills();

// The pass-context cache is the renderer's, and a fresh one needs no device at all.
function contexts(): Renderer<WebGPUBackend>['_renderContexts'] {
    return new Renderer(new WebGPUBackend())._renderContexts;
}

/** Resolve one pass over a `width` x `height` target with whatever rects the desc names. */
function resolve(width: number, height: number, desc: Pick<PassDesc, 'viewport' | 'scissor'>): RenderContext {
    return resolvePassContext(contexts(), {
        target: createRenderTarget(width, height, { depthBuffer: false }),
        ...desc,
    });
}

test('a pass with no scissor leaves the scissor off', () => {
    expect(resolve(800, 600, {}).scissor).toBe(false);
});

test('an in-bounds sub-rect resolves and enables the scissor', () => {
    const ctx = resolve(800, 600, { scissor: { x: 10, y: 20, width: 100, height: 200 } });
    expect(ctx.scissor).toBe(true);
    expect(ctx.scissorValue).toMatchObject({ x: 10, y: 20, width: 100, height: 200 });
});

test('a full-framebuffer scissor clips nothing and is skipped', () => {
    expect(resolve(800, 600, { scissor: { x: 0, y: 0, width: 800, height: 600 } }).scissor).toBe(false);
});

test('an oversized scissor is clamped to the framebuffer', () => {
    const ctx = resolve(800, 600, { scissor: { x: 700, y: 500, width: 400, height: 400 } });
    expect(ctx.scissor).toBe(true);
    expect(ctx.scissorValue).toMatchObject({ x: 700, y: 500, width: 100, height: 100 });
});

test('a negative origin is pulled to zero and its extent shrunk', () => {
    const ctx = resolve(800, 600, { scissor: { x: -30, y: -40, width: 200, height: 200 } });
    expect(ctx.scissorValue).toMatchObject({ x: 0, y: 0, width: 170, height: 160 });
});

test('a viewport resolves without enabling the scissor', () => {
    const ctx = resolve(800, 600, { viewport: { x: 5, y: 6, width: 320, height: 240, minDepth: 0, maxDepth: 1 } });
    expect(ctx.viewport).toBe(true);
    expect(ctx.viewportValue).toMatchObject({ x: 5, y: 6, width: 320, height: 240, minDepth: 0, maxDepth: 1 });
    expect(ctx.scissor).toBe(false);
});

test('a viewport omitting its depth range spans the full range', () => {
    const ctx = resolve(800, 600, { viewport: { x: 5, y: 6, width: 320, height: 240 } });
    expect(ctx.viewportValue).toMatchObject({ minDepth: 0, maxDepth: 1 });
});

test('a target is clipped only by what its own pass desc asks for', () => {
    const state = contexts();
    const target = createRenderTarget(256, 256, { depthBuffer: false });

    const clipped = resolvePassContext(state, {
        target,
        viewport: { x: 8, y: 8, width: 64, height: 64 },
        scissor: { x: 32, y: 48, width: 64, height: 80 },
    });
    expect(clipped.viewport).toBe(true);
    expect(clipped.scissor).toBe(true);

    // Same target, a desc that names neither: the previous pass's rects must not carry over.
    const plain = resolvePassContext(state, { target });
    expect(plain.viewport).toBe(false);
    expect(plain.scissor).toBe(false);
});
