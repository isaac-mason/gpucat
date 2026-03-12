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
export class DepthTexture {
    /** The underlying GPU texture resource */
    readonly _gpuTexture: GpuTexture<d.textureDepth2d>;
    
    /** The underlying sampler */
    readonly _gpuSampler: GpuSampler;
    
    /** Optional name for debugging */
    name = '';

    /**
     * Constructs a new DepthTexture.
     *
     * @param width - The width of the texture
     * @param height - The height of the texture
     * @param format - The depth format (default: 'depth24plus')
     */
    constructor(width: number, height: number, format: DepthTextureFormat = 'depth24plus') {
        this._gpuTexture = new GpuTexture(d.textureDepth2d, {
            width,
            height,
            format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        
        // Default to comparison sampler for shadow mapping
        this._gpuSampler = new GpuSampler({
            compare: 'less',
            magFilter: 'linear',
            minFilter: 'linear',
        });
    }

    get id(): number { return this._gpuTexture.id; }
    get width(): number { return this._gpuTexture.width; }
    get height(): number { return this._gpuTexture.height; }
    get format(): DepthTextureFormat { return this._gpuTexture.format as DepthTextureFormat; }
    
    get compareFunction(): GPUCompareFunction | undefined { return this._gpuSampler.compare; }
    set compareFunction(v: GPUCompareFunction | undefined) { this._gpuSampler.compare = v; }
    
    /** Version for dirty tracking. */
    get version(): number { return this._gpuTexture.version; }
    
    /** Mark as needing re-upload. */
    set needsUpdate(v: boolean) {
        if (v) this._gpuTexture.needsUpdate = true;
    }
    
    /** Set the size of the depth texture. */
    setSize(width: number, height: number): void {
        if (this._gpuTexture.width !== width || this._gpuTexture.height !== height) {
            this._gpuTexture.width = width;
            this._gpuTexture.height = height;
            this._gpuTexture.needsUpdate = true;
        }
    }
    
    clone(): DepthTexture {
        const tex = new DepthTexture(this.width, this.height, this.format);
        tex.name = this.name;
        tex.compareFunction = this.compareFunction;
        return tex;
    }
    
    dispose(): void {
        this._gpuTexture.dispose();
        this._gpuSampler.dispose();
    }
}
