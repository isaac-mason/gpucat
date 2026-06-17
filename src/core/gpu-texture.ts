import * as d from '../schema/schema';
import { Source, type SourceData } from '../texture/source';
import type { RenderTarget } from './render-target';

/** GPU texture dimension from schema type */
export type DimensionOf<D extends d.Texture> =
    D extends d.texture1d | d.textureStorage1d ? '1d'
    : D extends d.texture3d | d.textureStorage3d ? '3d'
    : '2d';  // All others: 2d, 2d_array, cube, cube_array, multisampled, depth, storage 2d/2d_array

/** View dimension from schema type (for GPUTextureView) */
export type ViewDimensionOf<D extends d.Texture> =
    D extends d.texture1d | d.textureStorage1d ? '1d'
    : D extends d.texture2d | d.textureDepth2d | d.textureMultisampled2d | d.textureDepthMultisampled2d | d.textureStorage2d ? '2d'
    : D extends d.texture2dArray | d.textureDepth2dArray | d.textureStorage2dArray ? '2d-array'
    : D extends d.textureCube | d.textureDepthCube ? 'cube'
    : D extends d.textureCubeArray | d.textureDepthCubeArray ? 'cube-array'
    : D extends d.texture3d | d.textureStorage3d ? '3d'
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

    /** Storage textures only: regenerate mips after a compute write (default true). */
    mipmapsAutoUpdate?: boolean;
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
export type GpuTextureOptions<D extends d.Texture> =
    D extends d.texture1d | d.textureStorage1d ? Options1D
    : D extends d.texture2d | d.textureDepth2d | d.textureMultisampled2d | d.textureDepthMultisampled2d | d.textureStorage2d ? Options2D
    : D extends d.texture2dArray | d.textureDepth2dArray | d.textureStorage2dArray ? Options2DArray
    : D extends d.textureCube | d.textureDepthCube ? OptionsCube
    : D extends d.textureCubeArray | d.textureDepthCubeArray ? OptionsCubeArray
    : D extends d.texture3d | d.textureStorage3d ? Options3D
    : Options2D;

/**
 * GPUTextureUsage flag bits, spec-fixed numeric values. Used instead of the global
 * `GPUTextureUsage` so texture construction works in headless/Node (no WebGPU global).
 */
const TEXTURE_USAGE = {
    COPY_SRC: 0x01,
    COPY_DST: 0x02,
    TEXTURE_BINDING: 0x04,
    STORAGE_BINDING: 0x08,
    RENDER_ATTACHMENT: 0x10,
} as const;

let _textureId = 0;

export class GpuTexture<D extends d.Texture = d.Texture> {
    readonly isGpuTexture = true;
    /** Unique ID */
    readonly id = _textureId++;
    
    /** Schema type descriptor, source of truth for WGSL type */
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

    /** Storage textures: regenerate mips after a compute pass writes this texture (if it has mips). */
    mipmapsAutoUpdate: boolean = true;
    
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

    /**
     * Render target this texture belongs to (color or depth attachment), or null.
     * Lets the bind path lazily (re)allocate a sampled render target whose own
     * render pass hasn't run this frame — e.g. it was resized between renders.
     */
    renderTarget: RenderTarget | null = null;

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
        
        // Format defaults: storage → descriptor's format, depth → depth32float, else rgba8unorm.
        this.format = options.format ?? (
            d.isStorageTextureDesc(type) ? type.format
            : d.isDepthTextureDesc(type) ? 'depth32float'
            : 'rgba8unorm'
        );

        // Usage defaults. Storage textures get STORAGE_BINDING and keep TEXTURE_BINDING (so the same
        // texture can be sampled in a later render pass) plus COPY_SRC for readback.
        this.usage = options.usage ?? (
            d.isStorageTextureDesc(type)
                ? TEXTURE_USAGE.STORAGE_BINDING | TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_DST | TEXTURE_USAGE.COPY_SRC
                : TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_DST
        );
        this.mipmapsAutoUpdate = options.mipmapsAutoUpdate ?? true;
        
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

function extractTextureSize(type: d.Texture, options: GpuTextureOptions<d.Texture>): { 
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
// ─────────────────────────────────────────────────────────────────────────────
// Storage texture creation helpers
// ─────────────────────────────────────────────────────────────────────────────
//
// Storage textures are written from compute shaders via `textureStore` and read via
// `textureLoad`. They default to STORAGE_BINDING | TEXTURE_BINDING usage, so the same
// texture can be written in compute and then sampled in a later render pass.
// `access` is a per-binding property set on the node (see `storageTexture(...)`), not
// the texture — the descriptor's default `'write'` is just the node's default.

/** Create a 2D storage texture (`texture_storage_2d<format, _>`). */
export function createStorageTexture<F extends d.StorageTextureFormat = 'rgba8unorm'>(
    width: number,
    height: number,
    format?: F,
): GpuTexture<d.textureStorage2d<F, 'write'>> {
    return new GpuTexture(d.textureStorage2d(format), { width, height } as GpuTextureOptions<d.textureStorage2d<F, 'write'>>);
}

/** Create a 3D storage texture (`texture_storage_3d<format, _>`). */
export function createStorageTexture3d<F extends d.StorageTextureFormat = 'rgba8unorm'>(
    width: number,
    height: number,
    depth: number,
    format?: F,
): GpuTexture<d.textureStorage3d<F, 'write'>> {
    return new GpuTexture(d.textureStorage3d(format), { width, height, depth } as GpuTextureOptions<d.textureStorage3d<F, 'write'>>);
}

/** Create a 2D-array storage texture (`texture_storage_2d_array<format, _>`). */
export function createStorageTextureArray<F extends d.StorageTextureFormat = 'rgba8unorm'>(
    width: number,
    height: number,
    layers: number,
    format?: F,
): GpuTexture<d.textureStorage2dArray<F, 'write'>> {
    return new GpuTexture(d.textureStorage2dArray(format), { width, height, layers } as GpuTextureOptions<d.textureStorage2dArray<F, 'write'>>);
}

/** Create a 1D storage texture (`texture_storage_1d<format, _>`). */
export function createStorageTexture1d<F extends d.StorageTextureFormat = 'rgba8unorm'>(
    width: number,
    format?: F,
): GpuTexture<d.textureStorage1d<F, 'write'>> {
    return new GpuTexture(d.textureStorage1d(format), { width } as GpuTextureOptions<d.textureStorage1d<F, 'write'>>);
}
