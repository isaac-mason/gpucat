import type { GpuBuffer } from '../../core/gpu-buffer';
import type { GpuTexture } from '../../core/gpu-texture';
import type { RenderTarget } from '../../core/render-target';
import type { TextureOrigin, TextureRegion } from '../../core/texture-region';
import type { ComputeNode } from '../../nodes/lib/core';
import type { FrameBackend } from './frame';
import type { MemoryInfo, MemoryTally } from './info';
import type { RenderObject } from './render-object';
import type { RenderPassParams } from './render-types';
import type { Renderer } from './renderer';

/**
 * Everything a graphics API owes the renderer, beyond the frame encoding `FrameBackend` already
 * names. One interface rather than a convention, so a backend that has drifted from the other is a
 * compile error instead of an audit.
 *
 * A backend owns device handles and caches only; the node graph, render lists, render objects and
 * pass contexts live on the `Renderer` it is handed at `init`.
 */
export interface DeviceBackend extends FrameBackend {
    /** Acquire the device. The renderer is kept for the neutral state the encode path reads. */
    /** @internal */ init(renderer: Renderer<DeviceBackend>): Promise<void>;
    /** @internal */ dispose(): void;

    /** Warm whatever this API compiles per drawable, for objects `compileTargets` already resolved. */
    /** @internal */ compileObjects(objects: RenderObject[], params: RenderPassParams): Promise<void>;

    /** Warm compute pipelines. WebGL2 implements it by refusing: it has no compute shaders. */
    /** @internal */ compileCompute(nodes: readonly ComputeNode[]): Promise<void>;

    /** @internal */ readPixels(
        target: RenderTarget,
        attachmentIndex: number,
        layer: number,
        mipLevel: number,
    ): Promise<Uint8Array>;

    /** copies `byteSize` bytes of `data` into a `cpu: false` buffer at `byteOffset` before returning; bounds already checked. */
    /** @internal */ writeBuffer(
        buffer: GpuBuffer,
        byteOffset: number,
        data: ArrayBufferView,
        dataByteOffset: number,
        byteSize: number,
    ): void;

    /** copies packed `data` into one box of a `cpu: false` texture before returning; region and size already checked. */
    /** @internal */ writeTexture(texture: GpuTexture, region: TextureRegion, data: ArrayBufferView): void;

    /** queues a GPU copy of `byteSize` bytes between two buffers; ranges and ownership already checked. */
    /** @internal */ copyBuffer(
        source: GpuBuffer,
        sourceByteOffset: number,
        destination: GpuBuffer,
        destinationByteOffset: number,
        byteSize: number,
    ): void;

    /** queues a GPU copy of one box between two textures of one format; box, origin and formats already checked. */
    /** @internal */ copyTexture(source: GpuTexture, region: TextureRegion, destination: GpuTexture, origin: TextureOrigin): void;

    /**
     * Fill the shared counts and this API's own, at the renderer's frame boundary: bytes from
     * `memoryTally`, the rest read live off the caches.
     */
    /** @internal */ readMemoryStats(memory: MemoryInfo): void;

    /** Destroy the uniform block `key` names. Its owner calls this when it dies; a key with no block is a no-op. */
    /** @internal */ releaseUniformBlock(key: object): void;

    /** Every GPU allocation this backend holds, adjusted at each create, resize and destroy. */
    /** @internal */ readonly memoryTally: MemoryTally;
}
