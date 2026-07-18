import { test, expect } from 'vitest';
import { installWebGPUPolyfills } from './stub-gpu';
import { Material, RenderTarget } from '../src/index';
import { formatHasStencil, makeRenderPipelineKey } from '../src/renderer/pipelines';

installWebGPUPolyfills();

// makeRenderPipelineKey reads material.vertex.id but never dereferences the node otherwise; a stub id
// is enough to exercise the key without building a real node graph.
function mat(overrides: Partial<Material> = {}): Material {
    const m = new Material({ vertex: { id: 1 } as never });
    return Object.assign(m, overrides);
}

test('formatHasStencil detects the stencil aspect', () => {
    expect(formatHasStencil('depth24plus')).toBe(false);
    expect(formatHasStencil('depth32float')).toBe(false);
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

const KEY_ARGS = [1, ['bgra8unorm'] as GPUTextureFormat[], 'depth24plus-stencil8' as GPUTextureFormat, null] as const;

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

test('pipeline cache key ignores the dynamic stencil reference', () => {
    // stencilRef is applied via setStencilReference, not baked into the pipeline — so it must NOT split the cache.
    const a = makeRenderPipelineKey(mat({ stencilTest: true, stencilRef: 1 }), ...KEY_ARGS);
    const b = makeRenderPipelineKey(mat({ stencilTest: true, stencilRef: 42 }), ...KEY_ARGS);
    expect(a).toBe(b);
});

test('RenderTarget stencilBuffer allocates a stencil-capable depth texture', () => {
    expect(new RenderTarget(64, 64).depthTexture?.format).toBe('depth24plus');
    expect(new RenderTarget(64, 64, { stencilBuffer: true }).depthTexture?.format).toBe('depth24plus-stencil8');
    // An explicit depthFormat wins over stencilBuffer.
    expect(new RenderTarget(64, 64, { stencilBuffer: true, depthFormat: 'depth32float' }).depthTexture?.format).toBe('depth32float');
});
