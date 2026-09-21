import { expect, test } from 'vitest';
import { createTextureCache, updateTexture } from '../src/renderer/webgpu/textures';
import { createDataTexture } from '../src/texture/data-texture';
import { createData3DTexture } from '../src/texture/texture-3d';
import { createStubGPU, installWebGPUPolyfills } from './stub-gpu';

installWebGPUPolyfills();

/** The write extents `updateTexture` asked the device for, in call order. */
function recordWrites(device: GPUDevice): GPUExtent3D[] {
    const extents: GPUExtent3D[] = [];
    (device.queue as { writeTexture: GPUQueue['writeTexture'] }).writeTexture = (
        _dest: GPUTexelCopyTextureInfo,
        _data: BufferSource,
        _layout: GPUTexelCopyBufferLayout,
        size: GPUExtent3D,
    ) => {
        extents.push(size);
    };
    return extents;
}

// A volume's slices all live in its one packed source, so the upload's extent is the only thing that
// carries them to the device: a 2D-shaped [width, height] write lands slice 0 and drops the rest.
test('a 3D texture uploads every slice, not just the first', () => {
    const { device } = createStubGPU();
    const extents = recordWrites(device);

    const volume = createData3DTexture(new Uint8Array(4 * 4 * 4 * 4), 4, 4, 4);
    updateTexture(createTextureCache(), device, volume._gpuTexture);

    expect(extents).toEqual([[4, 4, 4]]);
});

test('a 2D texture still uploads one slice', () => {
    const { device } = createStubGPU();
    const extents = recordWrites(device);

    const tex = createDataTexture(new Uint8Array(4 * 4 * 4), 4, 4);
    updateTexture(createTextureCache(), device, tex._gpuTexture);

    expect(extents).toEqual([[4, 4, 1]]);
});
