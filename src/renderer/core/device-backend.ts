import type { RenderTarget } from '../../core/render-target';
import type { ComputeNode } from '../../nodes/lib/core';
import type { FrameBackend } from './frame';
import type { MemoryInfo } from './info';
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
    init(renderer: Renderer<DeviceBackend>): Promise<void>;
    dispose(): void;

    /** Warm whatever this API compiles per drawable, for objects `compileTargets` already resolved. */
    compileObjects(objects: RenderObject[], params: RenderPassParams): Promise<void>;

    /** Warm compute pipelines. WebGL2 implements it by refusing: it has no compute shaders. */
    compileCompute(nodes: readonly ComputeNode[]): Promise<void>;

    readPixels(target: RenderTarget, attachmentIndex: number, layer: number, mipLevel: number): Promise<Uint8Array>;

    /**
     * Fill the shared counts and this API's own, at the renderer's frame boundary. Read live off the
     * caches rather than mirrored at every create/dispose site, which would only ever approximate what
     * the maps already know exactly.
     */
    readMemoryStats(memory: MemoryInfo): void;
}
