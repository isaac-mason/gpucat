import { test, expect } from 'vitest';
import { installWebGPUPolyfills } from './stub-gpu';
import { CubeRenderTarget, CubeCamera } from '../src/index';

// RenderTarget construction references GPUTextureUsage (a browser global).
installWebGPUPolyfills();

test('CubeRenderTarget wraps a sized cube texture with 6 faces', () => {
    const rt = new CubeRenderTarget(256);
    expect(rt.isCubeRenderTarget).toBe(true);
    expect(rt.size).toBe(256);
    expect(rt.activeFace).toBe(0);
    expect(rt.texture.size).toBe(256);
    expect(rt.texture._gpuTexture.depthOrArrayLayers).toBe(6);
    expect(rt.texture._gpuTexture.viewDimension).toBe('cube');
    // render-only cube: filled by the renderer, not uploaded
    expect(rt.texture._gpuTexture.isRenderTargetTexture).toBe(true);
    // the inherited 2D color texture carries the face format for pipeline creation
    expect(rt.texture.format).toBe('rgba8unorm');
    // a depth attachment is allocated and reused across faces
    expect(rt.depthTexture).not.toBeNull();
});

test('CubeCamera sets up six 90-degree face cameras', () => {
    const rt = new CubeRenderTarget(128);
    const cam = new CubeCamera(0.1, 100, rt);
    expect(cam.cameras).toHaveLength(6);
    expect(cam.renderTarget).toBe(rt);
    for (const c of cam.cameras) {
        expect(c.fov).toBeCloseTo(-Math.PI / 2);
        expect(c.aspect).toBe(1);
    }
});
