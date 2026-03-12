import { Source, type SourceData } from './source';
import { GpuTexture } from '../core/gpu-texture';
import { GpuSampler } from '../core/gpu-sampler';
import * as d from '../schema/schema';

/**
 * Cube texture mapping modes.
 * Determines which vector to use for cube texture sampling.
 */
export type CubeTextureMapping = 'reflection' | 'refraction';

export type CubeTextureOptions = {
    // Sampling
    wrapS?: GPUAddressMode;
    wrapT?: GPUAddressMode;
    magFilter?: GPUFilterMode;
    minFilter?: GPUFilterMode;
    mipmapFilter?: GPUMipmapFilterMode;
    
    // Format/upload
    format?: GPUTextureFormat;
    generateMipmaps?: boolean;
    flipY?: boolean;
    
    // Cube-specific
    mapping?: CubeTextureMapping;
};

/**
 * A texture for cubemaps (environment maps, skyboxes, etc).
 *
 * Stores 6 faces: +X, -X, +Y, -Y, +Z, -Z.
 * Sampled using a 3D direction vector.
 */
export class CubeTexture {
    /** Type flag for runtime checking */
    readonly isCubeTexture = true;

    /** The underlying GPU texture resource */
    readonly _gpuTexture: GpuTexture<d.textureCube>;
    
    /** The underlying sampler */
    readonly _gpuSampler: GpuSampler;

    /** Optional name for debugging */
    name = '';

    /**
     * Mapping mode - determines default UV vector.
     * - 'reflection': uses reflect(viewDir, normal)
     * - 'refraction': uses refract(viewDir, normal, ior)
     */
    mapping: CubeTextureMapping;

    /**
     * Constructs a new CubeTexture.
     *
     * @param faces - Array of 6 images for cube faces (+X, -X, +Y, -Y, +Z, -Z)
     * @param options - Texture options
     */
    constructor(
        faces: [SourceData, SourceData, SourceData, SourceData, SourceData, SourceData] | SourceData[] = [],
        options: CubeTextureOptions = {}
    ) {
        // Determine size from first face
        const firstFace = faces[0];
        let size = 1;
        if (firstFace) {
            if (firstFace instanceof Source) {
                size = firstFace.width || 1;
            } else if (typeof firstFace === 'object' && firstFace !== null && 'width' in firstFace) {
                size = (firstFace as { width: number }).width || 1;
            }
        }

        this._gpuTexture = new GpuTexture(d.textureCube(), {
            size,
            faces: faces.map(f => f instanceof Source ? f : new Source(f)),
            format: options.format,
            generateMipmaps: options.generateMipmaps ?? true,
            flipY: options.flipY ?? false,
        });
        
        this._gpuSampler = new GpuSampler({
            addressModeU: options.wrapS ?? 'clamp-to-edge',
            addressModeV: options.wrapT ?? 'clamp-to-edge',
            addressModeW: 'clamp-to-edge',
            magFilter: options.magFilter ?? 'linear',
            minFilter: options.minFilter ?? 'linear',
            mipmapFilter: options.mipmapFilter ?? 'linear',
        });
        
        this.mapping = options.mapping ?? 'reflection';
    }

    // ─── Convenience getters/setters ───

    get id(): number { return this._gpuTexture.id; }
    get width(): number { return this._gpuTexture.width; }
    get height(): number { return this._gpuTexture.height; }
    get size(): number { return this._gpuTexture.size; }
    
    /** Check if all 6 faces are present and ready */
    get isComplete(): boolean { return this._gpuTexture.isComplete; }

    /** The 6 face images as SourceData */
    get images(): SourceData[] {
        return this._gpuTexture.sources.map(s => s.data);
    }

    set images(value: SourceData[]) {
        this._gpuTexture.sources = value.map(img =>
            img instanceof Source ? img : new Source(img)
        );
        // Update size from first face
        if (value.length > 0) {
            const first = this._gpuTexture.sources[0];
            if (first) {
                this._gpuTexture.width = first.width || 1;
                this._gpuTexture.height = first.height || 1;
            }
        }
        this._gpuTexture.needsUpdate = true;
    }

    /** The 6 face Sources */
    get imageSources(): Source[] {
        return this._gpuTexture.sources;
    }

    get wrapS(): GPUAddressMode { return this._gpuSampler.addressModeU; }
    set wrapS(v: GPUAddressMode) { this._gpuSampler.addressModeU = v; }

    get wrapT(): GPUAddressMode { return this._gpuSampler.addressModeV; }
    set wrapT(v: GPUAddressMode) { this._gpuSampler.addressModeV = v; }

    get magFilter(): GPUFilterMode { return this._gpuSampler.magFilter; }
    set magFilter(v: GPUFilterMode) { this._gpuSampler.magFilter = v; }

    get minFilter(): GPUFilterMode { return this._gpuSampler.minFilter; }
    set minFilter(v: GPUFilterMode) { this._gpuSampler.minFilter = v; }

    get mipmapFilter(): GPUMipmapFilterMode { return this._gpuSampler.mipmapFilter; }
    set mipmapFilter(v: GPUMipmapFilterMode) { this._gpuSampler.mipmapFilter = v; }

    get anisotropy(): number { return this._gpuSampler.maxAnisotropy; }
    set anisotropy(v: number) { this._gpuSampler.maxAnisotropy = v; }

    get format(): GPUTextureFormat { return this._gpuTexture.format; }
    set format(v: GPUTextureFormat) { this._gpuTexture.format = v; }

    get generateMipmaps(): boolean { return this._gpuTexture.generateMipmaps; }
    set generateMipmaps(v: boolean) { this._gpuTexture.generateMipmaps = v; }

    get flipY(): boolean { return this._gpuTexture.flipY; }
    set flipY(v: boolean) { this._gpuTexture.flipY = v; }

    get premultiplyAlpha(): boolean { return this._gpuTexture.premultiplyAlpha; }
    set premultiplyAlpha(v: boolean) { this._gpuTexture.premultiplyAlpha = v; }

    get version(): number { return this._gpuTexture.version; }

    set needsUpdate(v: boolean) {
        if (v) this._gpuTexture.needsUpdate = true;
    }

    clone(): CubeTexture {
        const tex = new CubeTexture(this.images as [SourceData, SourceData, SourceData, SourceData, SourceData, SourceData], {
            wrapS: this.wrapS,
            wrapT: this.wrapT,
            magFilter: this.magFilter,
            minFilter: this.minFilter,
            mipmapFilter: this.mipmapFilter,
            format: this.format,
            generateMipmaps: this.generateMipmaps,
            flipY: this.flipY,
            mapping: this.mapping,
        });
        tex.name = this.name;
        return tex;
    }

    dispose(): void {
        this._gpuTexture.dispose();
        this._gpuSampler.dispose();
    }
}
