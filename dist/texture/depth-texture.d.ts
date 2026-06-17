import { GpuTexture } from '../core/gpu-texture';
import { GpuSampler } from '../core/gpu-sampler';
import * as d from '../schema/schema';
export type DepthTextureFormat = 'depth16unorm' | 'depth24plus' | 'depth24plus-stencil8' | 'depth32float' | 'depth32float-stencil8';
/**
 * A texture for storing depth information.
 * Used as the depth attachment in RenderTarget, or for shadow mapping.
 *
 * Defaults to comparison sampler for shadow mapping convenience.
 */
export declare class DepthTexture {
    readonly isDepthTexture = true;
    /** The underlying GPU texture resource */
    readonly _gpuTexture: GpuTexture<d.textureDepth2d>;
    /** The underlying sampler */
    readonly _gpuSampler: GpuSampler;
    /** Optional name for debugging */
    name: string;
    /**
     * Constructs a new DepthTexture.
     *
     * @param width - The width of the texture
     * @param height - The height of the texture
     * @param format - The depth format (default: 'depth24plus')
     */
    constructor(width: number, height: number, format?: DepthTextureFormat);
    get id(): number;
    get width(): number;
    get height(): number;
    get format(): DepthTextureFormat;
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
