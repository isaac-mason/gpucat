import * as d from '../schema/schema';
import { Source, type SourceData } from '../texture/source';

/** GPU texture dimension from schema type */
export type DimensionOf<D extends d.AnyTextureDesc> =
    D extends d.texture1d ? '1d'
    : D extends d.texture3d ? '3d'
    : '2d';  // All others: 2d, 2d_array, cube, cube_array, multisampled, depth variants

/** View dimension from schema type (for GPUTextureView) */
export type ViewDimensionOf<D extends d.AnyTextureDesc> =
    D extends d.texture1d ? '1d'
    : D extends d.texture2d | d.textureDepth2d | d.textureMultisampled2d | d.textureDepthMultisampled2d ? '2d'
    : D extends d.texture2dArray | d.textureDepth2dArray ? '2d-array'
    : D extends d.textureCube | d.textureDepthCube ? 'cube'
    : D extends d.textureCubeArray | d.textureDepthCubeArray ? 'cube-array'
    : D extends d.texture3d ? '3d'
    : '2d';

type BaseOptions = {
    format?: GPUTextureFormat;
    usage?: GPUTextureUsageFlags;
    mipLevelCount?: number;
    sampleCount?: number;
    
    // Source data
    source?: Source | SourceData;
    generateMipmaps?: boolean;
    
    // Upload options
    flipY?: boolean;
    premultiplyAlpha?: boolean;
};

type Options2D = BaseOptions & {
    width: number;
    height: number;
};

type Options2DArray = BaseOptions & {
    width: number;
    height: number;
    layers: number;
    sources?: (Source | SourceData)[];
};

type OptionsCube = BaseOptions & {
    size: number;
    faces?: [Source | SourceData, Source | SourceData, Source | SourceData, Source | SourceData, Source | SourceData, Source | SourceData] | (Source | SourceData)[];
};

type OptionsCubeArray = BaseOptions & {
    size: number;
    cubeCount: number;
    faces?: (Source | SourceData)[];
};

type Options3D = BaseOptions & {
    width: number;
    height: number;
    depth: number;
};

type Options1D = BaseOptions & {
    width: number;
};

/** Map schema type → options type */
export type GpuTextureOptions<D extends d.AnyTextureDesc> =
    D extends d.texture1d ? Options1D
    : D extends d.texture2d | d.textureDepth2d | d.textureMultisampled2d | d.textureDepthMultisampled2d ? Options2D
    : D extends d.texture2dArray | d.textureDepth2dArray ? Options2DArray
    : D extends d.textureCube | d.textureDepthCube ? OptionsCube
    : D extends d.textureCubeArray | d.textureDepthCubeArray ? OptionsCubeArray
    : D extends d.texture3d ? Options3D
    : Options2D;

let _textureId = 0;

export class GpuTexture<D extends d.AnyTextureDesc = d.AnyTextureDesc> {
    /** Unique ID */
    readonly id = _textureId++;
    
    /** Schema type descriptor — source of truth for WGSL type */
    readonly type: D;
    
    /** GPU texture dimension ('1d', '2d', '3d') */
    readonly dimension: DimensionOf<D>;
    
    /** View dimension for createView() */
    readonly viewDimension: ViewDimensionOf<D>;
    
    // ─────────────────────────────────────────────────────────────────────────
    // GPUTextureDescriptor fields
    // ─────────────────────────────────────────────────────────────────────────
    
    width: number;
    height: number;
    depthOrArrayLayers: number;
    
    format: GPUTextureFormat;
    usage: GPUTextureUsageFlags;
    mipLevelCount: number;
    sampleCount: number;
    
    // ─────────────────────────────────────────────────────────────────────────
    // Source data
    // ─────────────────────────────────────────────────────────────────────────
    
    /** Primary source (for 2D/3D) */
    source: Source | null = null;
    
    /** Per-layer/face sources (for array/cube textures) */
    sources: Source[] = [];
    
    /** Generate mipmaps on upload */
    generateMipmaps: boolean = false;
    
    /** Flip Y on upload (for image sources) */
    flipY: boolean = false;
    
    /** Premultiply alpha on upload */
    premultiplyAlpha: boolean = false;
    
    // ─────────────────────────────────────────────────────────────────────────
    // Dirty tracking (same pattern as GpuBuffer)
    // ─────────────────────────────────────────────────────────────────────────
    
    /** Version number, incremented when needsUpdate is set */
    version = 0;
    
    /** Mark texture as needing re-upload */
    set needsUpdate(_: true) {
        this.version++;
    }
    
    /** Track which layers need updating (for 2D array textures) */
    readonly layerUpdates: Set<number> = new Set();
    
    // ─────────────────────────────────────────────────────────────────────────
    // Render target flag
    // ─────────────────────────────────────────────────────────────────────────
    
    /**
     * Whether this texture is a render target (managed by RenderTarget system).
     * When true, the renderer skips source data upload - the GPU texture is
     * created and managed by RenderTarget.
     */
    isRenderTargetTexture = false;
    
    // ─────────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ─────────────────────────────────────────────────────────────────────────
    
    /** Renderer-set callback to destroy GPU resources */
    _onDispose: (() => void) | null = null;
    
    /** Set to true after dispose() */
    disposed = false;
    
    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────
    
    constructor(type: D, options: GpuTextureOptions<D>) {
        this.type = type;
        
        // Derive dimension and viewDimension from schema type
        this.dimension = d.textureDimension(type) as DimensionOf<D>;
        this.viewDimension = d.textureViewDimension(type) as ViewDimensionOf<D>;
        
        // Extract size from options (type-safe per schema)
        const { width, height, depthOrArrayLayers } = extractTextureSize(type, options);
        this.width = width;
        this.height = height;
        this.depthOrArrayLayers = depthOrArrayLayers;
        
        // Format defaults based on whether it's a depth texture
        this.format = options.format ?? (d.isDepthTextureDesc(type) ? 'depth32float' : 'rgba8unorm');
        
        // Usage defaults
        this.usage = options.usage ?? (GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
        
        // Mip levels
        this.mipLevelCount = options.mipLevelCount ?? 1;
        this.sampleCount = options.sampleCount ?? 1;
        
        // Source handling
        this.generateMipmaps = options.generateMipmaps ?? false;
        this.flipY = options.flipY ?? false;
        this.premultiplyAlpha = options.premultiplyAlpha ?? false;
        
        // Handle source(s) based on texture type
        const opts = options as BaseOptions & { sources?: (Source | SourceData)[]; faces?: (Source | SourceData)[] };
        
        if (opts.source) {
            this.source = opts.source instanceof Source 
                ? opts.source 
                : new Source(opts.source);
        }
        
        if (opts.sources) {
            this.sources = opts.sources.map((s: Source | SourceData) => 
                s instanceof Source ? s : new Source(s)
            );
        }
        
        if (opts.faces) {
            this.sources = opts.faces.map((s: Source | SourceData) =>
                s instanceof Source ? s : new Source(s)
            );
        }
    }
    
    // Convenience getters
    
    /** For cube textures: the size (width = height) */
    get size(): number { return this.width; }
    
    /** For 2D array: number of layers */
    get layers(): number { return this.depthOrArrayLayers; }
    
    /** For 3D: depth */
    get depth(): number { return this.depthOrArrayLayers; }
    
    /** For cube array: number of cubes */
    get cubeCount(): number { return this.depthOrArrayLayers / 6; }
    
    /** Is this a depth texture? */
    get isDepth(): boolean { return d.isDepthTextureDesc(this.type); }
    
    /** Is all source data ready for upload? */
    get isComplete(): boolean {
        if (this.source && !this.source.dataReady) return false;
        for (const s of this.sources) {
            if (!s.dataReady) return false;
        }
        // Cube textures need exactly 6 faces
        if (d.isCubeTextureDesc(this.type) && this.sources.length !== 6) return false;
        return true;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this._onDispose?.();
        this._onDispose = null;
        this.source = null;
        this.sources = [];
    }
}

function extractTextureSize(type: d.AnyTextureDesc, options: GpuTextureOptions<d.AnyTextureDesc>): { 
    width: number; 
    height: number; 
    depthOrArrayLayers: number;
} {
    const viewDim = d.textureViewDimension(type);
    const opts = options as Record<string, unknown>;
    
    switch (viewDim) {
        case 'cube':
            return { width: opts.size as number, height: opts.size as number, depthOrArrayLayers: 6 };
        case 'cube-array':
            return { width: opts.size as number, height: opts.size as number, depthOrArrayLayers: (opts.cubeCount as number) * 6 };
        case '2d-array':
            return { width: opts.width as number, height: opts.height as number, depthOrArrayLayers: opts.layers as number };
        case '3d':
            return { width: opts.width as number, height: opts.height as number, depthOrArrayLayers: opts.depth as number };
        case '1d':
            return { width: opts.width as number, height: 1, depthOrArrayLayers: 1 };
        default:
            return { width: opts.width as number, height: opts.height as number, depthOrArrayLayers: 1 };
    }
}