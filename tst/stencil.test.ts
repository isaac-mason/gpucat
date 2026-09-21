import { expect, test } from 'vitest';
import { createRenderTarget, Material } from '../src/index';
import { createCanvasTarget } from '../src/renderer/core/canvas-target';
import { formatHasStencil } from '../src/renderer/core/render-types';
import { makeRenderPipelineKey } from '../src/renderer/webgpu/pipelines';
import type { DepthTextureFormat } from '../src/texture/depth-texture';
import { installWebGPUPolyfills } from './stub-gpu';

installWebGPUPolyfills();

// makeRenderPipelineKey reads material.vertex.id but never dereferences the node otherwise; a stub id
// is enough to exercise the key without building a real node graph.
function mat(overrides: Partial<Material> = {}): Material {
    const m = new Material({ vertex: { id: 1 } as never });
    return Object.assign(m, overrides);
}

/** WebGL matched two formats exactly and WebGPU matched a substring, so they disagreed about stencil8. */
test('formatHasStencil detects the stencil aspect', () => {
    expect(formatHasStencil('depth24plus')).toBe(false);
    expect(formatHasStencil('depth32float')).toBe(false);
    expect(formatHasStencil('depth16unorm')).toBe(false);
    expect(formatHasStencil(undefined)).toBe(false);
    expect(formatHasStencil('depth24plus-stencil8')).toBe(true);
    expect(formatHasStencil('depth32float-stencil8')).toBe(true);
    expect(formatHasStencil('stencil8')).toBe(true);
});

test('Material defaults to a no-op stencil state', () => {
    const m = mat();
    expect(m.stencilTest).toBe(false);
    expect(m.stencilFunc).toBe('always');
    expect(m.stencilRef).toBe(0);
    expect(m.stencilReadMask).toBe(0xff);
    expect(m.stencilWriteMask).toBe(0xff);
    expect(m.stencilFail).toBe('keep');
    expect(m.stencilZFail).toBe('keep');
    expect(m.stencilZPass).toBe('keep');
});

test('Material applies stencil options', () => {
    const m = new Material({
        vertex: { id: 1 } as never,
        stencilTest: true,
        stencilFunc: 'equal',
        stencilRef: 1,
        stencilZPass: 'replace',
        stencilWriteMask: 0x0f,
    });
    expect(m.stencilTest).toBe(true);
    expect(m.stencilFunc).toBe('equal');
    expect(m.stencilRef).toBe(1);
    expect(m.stencilZPass).toBe('replace');
    expect(m.stencilWriteMask).toBe(0x0f);
    // Untouched fields keep their defaults.
    expect(m.stencilFail).toBe('keep');
});

const KEY_ARGS = ['12:v|', 1, ['bgra8unorm'] as GPUTextureFormat[], 'depth24plus-stencil8' as GPUTextureFormat, null] as const;

test('pipeline cache key varies with baked stencil state', () => {
    const base = makeRenderPipelineKey(mat(), ...KEY_ARGS);
    expect(makeRenderPipelineKey(mat(), ...KEY_ARGS)).toBe(base); // deterministic

    expect(makeRenderPipelineKey(mat({ stencilTest: true }), ...KEY_ARGS)).not.toBe(base);
    expect(makeRenderPipelineKey(mat({ stencilFunc: 'equal' }), ...KEY_ARGS)).not.toBe(base);
    expect(makeRenderPipelineKey(mat({ stencilZPass: 'replace' }), ...KEY_ARGS)).not.toBe(base);
    expect(makeRenderPipelineKey(mat({ stencilWriteMask: 0x0f }), ...KEY_ARGS)).not.toBe(base);
    expect(makeRenderPipelineKey(mat({ stencilReadMask: 0x0f }), ...KEY_ARGS)).not.toBe(base);
});

test('stencilBack (per-face ops) defaults off and splits the pipeline cache key', () => {
    expect(mat().stencilBack).toBe(null);
    const base = makeRenderPipelineKey(mat({ stencilTest: true }), ...KEY_ARGS);
    // A back-face override must produce a distinct pipeline from the same-both-faces material.
    const withBack = makeRenderPipelineKey(mat({ stencilTest: true, stencilBack: { zPass: 'invert' } }), ...KEY_ARGS);
    expect(withBack).not.toBe(base);
});

test('colorWrite defaults on and splits the pipeline cache key', () => {
    expect(mat().colorWrite).toBe(true);
    const base = makeRenderPipelineKey(mat(), ...KEY_ARGS);
    expect(makeRenderPipelineKey(mat({ colorWrite: false }), ...KEY_ARGS)).not.toBe(base);
});

test('pipeline cache key splits on the vertex layout', () => {
    // arrayStride can come from the geometry's buffer format, not the node graph, so two geometries
    // supplying one attribute name with different formats must not share a pipeline.
    const [, ...rest] = KEY_ARGS;
    const base = makeRenderPipelineKey(mat(), '12:v|', ...rest);
    expect(makeRenderPipelineKey(mat(), '16:v|', ...rest)).not.toBe(base);
    expect(makeRenderPipelineKey(mat(), '12:i|', ...rest)).not.toBe(base);
    expect(makeRenderPipelineKey(mat(), '12:v|', ...rest)).toBe(base);
});

test('pipeline cache key ignores the dynamic stencil reference', () => {
    // stencilRef is applied via setStencilReference, not baked into the pipeline — so it must NOT split the cache.
    const a = makeRenderPipelineKey(mat({ stencilTest: true, stencilRef: 1 }), ...KEY_ARGS);
    const b = makeRenderPipelineKey(mat({ stencilTest: true, stencilRef: 42 }), ...KEY_ARGS);
    expect(a).toBe(b);
});

test('a canvas target resolves its own stencil aspect from its depth format', () => {
    const mk = (depthFormat?: DepthTextureFormat) =>
        createCanvasTarget({ width: 8, height: 8 } as OffscreenCanvas, { depthFormat }).depthFormat.includes('stencil');
    expect(mk()).toBe(false);
    expect(mk('depth24plus-stencil8')).toBe(true);
    expect(mk('depth32float-stencil8')).toBe(true);
    expect(mk('depth32float')).toBe(false);
});

test('RenderTarget stencilBuffer allocates a stencil-capable depth texture', () => {
    expect(createRenderTarget(64, 64)._depthAttachment?.format).toBe('depth24plus');
    expect(createRenderTarget(64, 64, { stencilBuffer: true })._depthAttachment?.format).toBe('depth24plus-stencil8');
    // An explicit depthFormat wins over stencilBuffer.
    expect(createRenderTarget(64, 64, { stencilBuffer: true, depthFormat: 'depth32float' })._depthAttachment?.format).toBe(
        'depth32float',
    );
});
