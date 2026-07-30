import { describe, expect, test } from 'vitest';
import { Texture } from '../src/index';

// Regression: Texture.isRenderTargetTexture used to be a plain wrapper field, separate from the
// underlying GpuTexture's flag that the backends actually read. PassNode.getTexture() sets it on the
// wrapper for lazily-created MRT attachments — which never reached the GpuTexture, so the WebGL
// backend treated them as source uploads (0-sized storage) instead of render-target allocations,
// giving 0x0 attachments and an incomplete framebuffer. The setter must forward to the GpuTexture.
describe('Texture.isRenderTargetTexture forwards to the underlying GpuTexture', () => {
    test('setting the wrapper flag reaches the GpuTexture the backends read', () => {
        const t = new Texture({ width: 4, height: 4 });
        expect(t._gpuTexture.isRenderTargetTexture).toBe(false);
        expect(t.isRenderTargetTexture).toBe(false);

        t.isRenderTargetTexture = true;
        expect(t._gpuTexture.isRenderTargetTexture).toBe(true);
        expect(t.isRenderTargetTexture).toBe(true);
    });
});
