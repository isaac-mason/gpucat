import { GpuSampler } from '../core/gpu-sampler';
import { GpuTexture } from '../core/gpu-texture';
import * as d from '../schema/schema';
export type DepthTextureFormat = 'depth16unorm' | 'depth24plus' | 'depth24plus-stencil8' | 'depth32float' | 'depth32float-stencil8';
/**
 * A texture for storing depth information.
 * Used as the depth attachment in RenderTarget, or for shadow mapping.
 *
 * Defaults to comparison sampler for shadow mapping convenience.
 *
 * No region API, deliberately: this is a render-target attachment whose contents are written by the
 * GPU, so there is no CPU-side source for a partial upload to read from.
 */
export declare class DepthTexture {
    readonly isDepthTexture = true;
    /** The underlying GPU texture resource: a 2D depth, or a 2D-array one when it has layers */
    readonly _gpuTexture: GpuTexture<d.textureDepth2d | d.textureDepth2dArray>;
    /** The underlying sampler */
    readonly _gpuSampler: GpuSampler;
    /**
     * Optional name for debugging. Also the identifier this texture reads under in emitted shader
     * source, and its `GPUTexture.label` in devtools. Forwards to the underlying `GpuTexture` — the
     * single source of truth the backends and the emitters read — so setting it on the wrapper at any
     * point takes effect, exactly as `isRenderTargetTexture` does.
     */
    get name(): string;
    set name(value: string);
    /**
     * Constructs a new DepthTexture.
     *
     * @param width - The width of the texture
     * @param height - The height of the texture
     * @param format - The depth format (default: 'depth24plus')
     * @param layers - Array layers: more than one makes it a 2D-array depth, a layer a pass (default: 1)
     */
    constructor(width: number, height: number, format?: DepthTextureFormat, layers?: number);
    get id(): number;
    get width(): number;
    get height(): number;
    get format(): DepthTextureFormat;
    /** Array layers; 1 for a plain 2D depth. */
    get layers(): number;
    get compareFunction(): GPUCompareFunction | undefined;
    set compareFunction(v: GPUCompareFunction | undefined);
    /** Version for dirty tracking. */
    get version(): number;
    /** Mark as needing re-upload. */
    set needsUpdate(v: boolean);
    /** Set the size of the depth texture. */
    setSize(width: number, height: number): void;
    clone(): DepthTexture;
    dispose(): void;
}
/** The factory form; the contents are written by the GPU, so there is no data argument. */
export declare function createDepthTexture(width: number, height: number, format?: DepthTextureFormat, layers?: number): DepthTexture;
