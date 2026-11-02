import { describe, expect, test } from 'vitest';
import { ArrayTexture, createCubeRenderTarget, createRenderTarget, Data3DTexture, Texture } from '../src/index';
import { installWebGPUPolyfills } from './stub-gpu';

installWebGPUPolyfills();

describe('render target layouts', () => {
    test('the colour attachments follow the layout: a texture, an array of them, or a 3D texture', () => {
        expect(createRenderTarget(8, 8).texture).toBeInstanceOf(Texture);
        expect(createRenderTarget(8, 8, { layers: 3 }).texture).toBeInstanceOf(ArrayTexture);
        expect(createRenderTarget(8, 8, { dimension: '3d', layers: 4, depthBuffer: false }).texture).toBeInstanceOf(
            Data3DTexture,
        );
    });

    test('every attachment, depth included, takes the layout', () => {
        const target = createRenderTarget(32, 32, { layers: 3, mipLevelCount: 'full', count: 2 });
        for (const texture of [...target.textures.map((t) => t._gpuTexture), target._depthAttachment!._gpuTexture]) {
            expect(texture.depthOrArrayLayers).toBe(3);
            expect(texture.mipLevelCount).toBe(6);
        }
    });

    test("'full' is the whole chain at the current size", () => {
        const target = createRenderTarget(32, 32, { mipLevelCount: 'full', depthBuffer: false });
        expect(target.mipLevelCount).toBe(6);
        target.setSize(128, 64);
        expect(target.mipLevelCount).toBe(8);
        expect(target.texture!._gpuTexture.mipLevelCount).toBe(8);
    });

    test('a cube target is six layers, its depth a layer a face', () => {
        const cube = createCubeRenderTarget(16, { generateMipmaps: true });
        expect(cube.layers).toBe(6);
        expect(cube.mipLevelCount).toBe(5);
        expect(cube._depthAttachment!.layers).toBe(6);
    });

    test('the spec rules a layout breaks are named', () => {
        expect(() => createRenderTarget(8, 8, { dimension: '3d', layers: 4 })).toThrow(/depth formats cannot be 3D/);
        expect(() => createRenderTarget(8, 8, { samples: 4, mipLevelCount: 2 })).toThrow(/multisampled target has one mip/);
        expect(() => createRenderTarget(8, 8, { samples: 4, dimension: '3d', depthBuffer: false })).toThrow(/cannot be '3d'/);
        expect(() => createRenderTarget(8, 8, { layers: 0 })).toThrow(/whole number of at least 1/);
        expect(() => createRenderTarget(8, 8, { mipLevelCount: 0 })).toThrow(/whole number of at least 1/);
    });

    test('a multisampled target may have layers: each keeps its own samples', () => {
        expect(() => createRenderTarget(8, 8, { samples: 4, layers: 2 })).not.toThrow();
    });
});
