# Design: GpuTexture<D> and GpuSampler

This document describes the new texture resource model for gpucat, replacing the current three.js-inspired class hierarchy with a WebGPU-native approach.

## Motivation

The current texture system has 8 classes organized by **semantic role / data source**:

```
Texture (base 2D, accepts images/canvas/video)
├── DataTexture (2D from typed array)
├── DepthTexture (depth format, always render target)
├── ArrayTexture (2D array, typed array)
├── Data3DTexture (3D volume, typed array)
├── CubeTexture (6 face images)
├── VideoTexture (video source)
└── CanvasTexture (canvas source)
```

**Problems:**
1. **Combinatorial explosion** — CSM needs a depth 2D array, so do we add `DepthArrayTexture`? Depth cube? Depth cube array?
2. **Conflation** — `Texture` mixes GPU resource descriptor (dimension, format, usage) with source data management AND sampling parameters
3. **Renderer complexity** — scattered `isCubeTexture`/`isArrayTexture`/`isDepthTexture` checks
4. **Not WebGPU-aligned** — WebGPU has one `GPUTexture` with dimension as a field

## Design: Single Generic Class

WebGPU has one `GPUTexture` type. We follow suit with `GpuTexture<D>` where `D` is the schema type (`d.texture2d()`, `d.textureCube()`, etc.).

The schema type drives:
- TypeScript type safety (compile-time)
- WGSL codegen (the schema's `wgslType`)
- Runtime behavior (dimension, view dimension, size extraction)

### Core Insight

The `d.*` schema system already mirrors WGSL grammar exactly:
- `d.texture2d()` → `texture_2d<f32>`
- `d.textureCube()` → `texture_cube<f32>`
- `d.textureDepth2dArray()` → `texture_depth_2d_array`

Making `GpuTexture<D>` generic over this schema means:
- **One class** for all texture types (like WebGPU)
- **Type-safe bindings** — `TextureBindingNode<d.textureCube>.value: GpuTexture<d.textureCube>`
- **Schema is the single source of truth** for both WGSL and runtime

---

## GpuTexture<D>

```typescript
import * as d from './nodes/schema';
import { Source, SourceData } from './texture/source';

// ─────────────────────────────────────────────────────────────────────────────
// Schema → Dimension mapping (compile-time)
// ─────────────────────────────────────────────────────────────────────────────

/** GPU texture dimension from schema type */
type DimensionOf<D extends d.AnyTextureDesc> =
    D extends d.texture1d ? '1d'
    : D extends d.texture3d ? '3d'
    : '2d';  // All others: 2d, 2d_array, cube, cube_array, multisampled, depth variants

/** View dimension from schema type (for GPUTextureView) */
type ViewDimensionOf<D extends d.AnyTextureDesc> =
    D extends d.texture1d ? '1d'
    : D extends d.texture2d | d.textureDepth2d | d.textureMultisampled2d | d.textureDepthMultisampled2d ? '2d'
    : D extends d.texture2dArray | d.textureDepth2dArray ? '2d-array'
    : D extends d.textureCube | d.textureDepthCube ? 'cube'
    : D extends d.textureCubeArray | d.textureDepthCubeArray ? 'cube-array'
    : D extends d.texture3d ? '3d'
    : '2d';

// ─────────────────────────────────────────────────────────────────────────────
// Options types (conditional on schema)
// ─────────────────────────────────────────────────────────────────────────────

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
    faces?: [Source, Source, Source, Source, Source, Source] | (Source | SourceData)[];
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
type OptionsFor<D extends d.AnyTextureDesc> =
    D extends d.texture1d ? Options1D
    : D extends d.texture2d | d.textureDepth2d | d.textureMultisampled2d | d.textureDepthMultisampled2d ? Options2D
    : D extends d.texture2dArray | d.textureDepth2dArray ? Options2DArray
    : D extends d.textureCube | d.textureDepthCube ? OptionsCube
    : D extends d.textureCubeArray | d.textureDepthCubeArray ? OptionsCubeArray
    : D extends d.texture3d ? Options3D
    : Options2D;

// ─────────────────────────────────────────────────────────────────────────────
// GpuTexture<D>
// ─────────────────────────────────────────────────────────────────────────────

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
    // Source data (like GpuBuffer.array)
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
    // GPU resource
    // ─────────────────────────────────────────────────────────────────────────
    
    /** The GPU texture resource (set by renderer) */
    gpuTexture: GPUTexture | null = null;
    
    /** Renderer-set callback to destroy GPU resources */
    _onDispose: (() => void) | null = null;
    
    /** Set to true after dispose() */
    disposed = false;
    
    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────
    
    constructor(type: D, options: OptionsFor<D>) {
        this.type = type;
        
        // Derive dimension and viewDimension from schema type
        this.dimension = deriveDimension(type) as DimensionOf<D>;
        this.viewDimension = deriveViewDimension(type) as ViewDimensionOf<D>;
        
        // Extract size from options (type-safe per schema)
        const { width, height, depthOrArrayLayers } = extractSize(type, options);
        this.width = width;
        this.height = height;
        this.depthOrArrayLayers = depthOrArrayLayers;
        
        // Format defaults based on whether it's a depth texture
        this.format = options.format ?? (isDepthSchema(type) ? 'depth32float' : 'rgba8unorm');
        
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
        this.initSources(options);
    }
    
    private initSources(options: OptionsFor<D>): void {
        const opts = options as BaseOptions & { sources?: any[]; faces?: any[] };
        
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
    
    // ─────────────────────────────────────────────────────────────────────────
    // Convenience getters
    // ─────────────────────────────────────────────────────────────────────────
    
    /** For cube textures: the size (width = height) */
    get size(): number { return this.width; }
    
    /** For 2D array: number of layers */
    get layers(): number { return this.depthOrArrayLayers; }
    
    /** For 3D: depth */
    get depth(): number { return this.depthOrArrayLayers; }
    
    /** For cube array: number of cubes */
    get cubeCount(): number { return this.depthOrArrayLayers / 6; }
    
    /** Is this a depth texture? */
    get isDepth(): boolean { return isDepthSchema(this.type); }
    
    /** Is all source data ready for upload? */
    get isComplete(): boolean {
        if (this.source && !this.source.dataReady) return false;
        for (const s of this.sources) {
            if (!s.dataReady) return false;
        }
        // Cube textures need exactly 6 faces
        if (isCubeSchema(this.type) && this.sources.length !== 6) return false;
        return true;
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ─────────────────────────────────────────────────────────────────────────
    
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this._onDispose?.();
        this._onDispose = null;
        this.gpuTexture = null;
        this.source = null;
        this.sources = [];
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────────────────────

function deriveDimension(type: d.AnyTextureDesc): '1d' | '2d' | '3d' {
    if (type.type === 'texture_1d') return '1d';
    if (type.type === 'texture_3d') return '3d';
    return '2d';
}

function deriveViewDimension(type: d.AnyTextureDesc): GPUTextureViewDimension {
    switch (type.type) {
        case 'texture_1d': return '1d';
        case 'texture_2d':
        case 'texture_depth_2d':
        case 'texture_multisampled_2d':
        case 'texture_depth_multisampled_2d':
            return '2d';
        case 'texture_2d_array':
        case 'texture_depth_2d_array':
            return '2d-array';
        case 'texture_cube':
        case 'texture_depth_cube':
            return 'cube';
        case 'texture_cube_array':
        case 'texture_depth_cube_array':
            return 'cube-array';
        case 'texture_3d':
            return '3d';
        default:
            return '2d';
    }
}

function isDepthSchema(type: d.AnyTextureDesc): boolean {
    return type.type.startsWith('texture_depth');
}

function isCubeSchema(type: d.AnyTextureDesc): boolean {
    return type.type === 'texture_cube' || type.type === 'texture_depth_cube';
}

function extractSize(type: d.AnyTextureDesc, options: any): { 
    width: number; 
    height: number; 
    depthOrArrayLayers: number;
} {
    const viewDim = deriveViewDimension(type);
    
    switch (viewDim) {
        case 'cube':
            return { width: options.size, height: options.size, depthOrArrayLayers: 6 };
        case 'cube-array':
            return { width: options.size, height: options.size, depthOrArrayLayers: options.cubeCount * 6 };
        case '2d-array':
            return { width: options.width, height: options.height, depthOrArrayLayers: options.layers };
        case '3d':
            return { width: options.width, height: options.height, depthOrArrayLayers: options.depth };
        case '1d':
            return { width: options.width, height: 1, depthOrArrayLayers: 1 };
        default:
            return { width: options.width, height: options.height, depthOrArrayLayers: 1 };
    }
}
```

---

## GpuSampler

Samplers are separate from textures (WebGPU model). This replaces the current approach where sampling parameters live on the `Texture` class.

```typescript
let _samplerId = 0;

export type GpuSamplerOptions = {
    minFilter?: GPUFilterMode;
    magFilter?: GPUFilterMode;
    mipmapFilter?: GPUMipmapFilterMode;
    addressModeU?: GPUAddressMode;
    addressModeV?: GPUAddressMode;
    addressModeW?: GPUAddressMode;
    maxAnisotropy?: number;
    compare?: GPUCompareFunction;
    lodMinClamp?: number;
    lodMaxClamp?: number;
};

export class GpuSampler {
    readonly id = _samplerId++;
    
    minFilter: GPUFilterMode;
    magFilter: GPUFilterMode;
    mipmapFilter: GPUMipmapFilterMode;
    addressModeU: GPUAddressMode;
    addressModeV: GPUAddressMode;
    addressModeW: GPUAddressMode;
    maxAnisotropy: number;
    lodMinClamp: number;
    lodMaxClamp: number;
    
    /** For comparison samplers (shadow mapping) */
    compare?: GPUCompareFunction;
    
    /** GPU sampler resource (set by renderer) */
    gpuSampler: GPUSampler | null = null;
    
    /** Renderer-set callback to destroy GPU resources */
    _onDispose: (() => void) | null = null;
    
    disposed = false;
    
    constructor(options: GpuSamplerOptions = {}) {
        this.minFilter = options.minFilter ?? 'linear';
        this.magFilter = options.magFilter ?? 'linear';
        this.mipmapFilter = options.mipmapFilter ?? 'linear';
        this.addressModeU = options.addressModeU ?? 'clamp-to-edge';
        this.addressModeV = options.addressModeV ?? 'clamp-to-edge';
        this.addressModeW = options.addressModeW ?? 'clamp-to-edge';
        this.maxAnisotropy = options.maxAnisotropy ?? 1;
        this.lodMinClamp = options.lodMinClamp ?? 0;
        this.lodMaxClamp = options.lodMaxClamp ?? 32;
        this.compare = options.compare;
    }
    
    /** Is this a comparison sampler? */
    get isComparison(): boolean {
        return this.compare !== undefined;
    }
    
    /** Settings key for deduplication */
    get settingsKey(): string {
        const base = `${this.minFilter}-${this.magFilter}-${this.mipmapFilter}-` +
                     `${this.addressModeU}-${this.addressModeV}-${this.addressModeW}-` +
                     `${this.maxAnisotropy}-${this.lodMinClamp}-${this.lodMaxClamp}`;
        return this.compare ? `${base}-cmp-${this.compare}` : base;
    }
    
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this._onDispose?.();
        this._onDispose = null;
        this.gpuSampler = null;
    }
}
```

---

## Node System Updates

### TextureBindingNode

The `value` field becomes type-safe:

```typescript
export class TextureBindingNode<D extends d.AnyTextureDesc = d.AnyTextureDesc> extends Node<D> {
    /** GPU texture resource. Set this before rendering, or use `value`. */
    resource: GPUTexture | GPUTextureView | null = null;

    /** The GpuTexture — now type-safe based on schema */
    value: GpuTexture<D> | null = null;

    readonly textureId: string;
    groupNode: UniformGroup;

    constructor(desc: D, textureId: string, groupNode: UniformGroup = objectGroup) {
        super(desc);
        this.textureId = textureId;
        this.groupNode = groupNode;
    }
}
```

### SamplerNode

Now references a `GpuSampler` instead of copying settings from `Texture`:

```typescript
export class SamplerNode<D extends d.SamplerDesc | d.SamplerComparisonDesc = d.SamplerDesc> extends Node<D> {
    /** GPU sampler resource (set by renderer) */
    resource: GPUSampler | null = null;

    /** The GpuSampler that holds settings */
    value: GpuSampler | null = null;

    readonly samplerId: string;
    groupNode: UniformGroup;

    constructor(desc: D, samplerId: string, groupNode: UniformGroup = objectGroup) {
        super(desc);
        this.samplerId = samplerId;
        this.groupNode = groupNode;
    }

    /** Settings key from the GpuSampler (for deduplication) */
    get settingsKey(): string {
        return this.value?.settingsKey ?? 'default';
    }
}
```

### Factory Functions

The `texture()`, `cubeTexture()`, etc. factories now take `GpuTexture<D>` + `GpuSampler`:

```typescript
/**
 * Create a texture node from a GpuTexture and GpuSampler.
 */
export function texture<D extends d.FlatSampledTextureDesc>(
    tex: GpuTexture<D>,
    sampler: GpuSampler,
): TextureNode {
    const binding = new TextureBindingNode(tex.type, `t${tex.id}`);
    binding.value = tex;
    
    const samplerNode = new SamplerNode(
        sampler.isComparison ? d.samplerComparison : d.sampler,
        `s${sampler.id}`,
    );
    samplerNode.value = sampler;
    
    const node = new TextureNode(binding);
    node.samplerNode = samplerNode;
    return node;
}

/**
 * Create a cube texture node.
 */
export function cubeTexture(
    tex: GpuTexture<d.textureCube>,
    sampler: GpuSampler,
): CubeTextureNode {
    const binding = new TextureBindingNode(tex.type, `t${tex.id}`);
    binding.value = tex;
    
    const samplerNode = new SamplerNode(d.sampler, `s${sampler.id}`);
    samplerNode.value = sampler;
    
    const node = new CubeTextureNode(binding);
    node.samplerNode = samplerNode;
    return node;
}

/**
 * Create a depth texture node (for shadow sampling).
 */
export function depthTexture<D extends d.FlatDepthTextureDesc>(
    tex: GpuTexture<D>,
    sampler: GpuSampler,
): DepthTextureNode {
    const binding = new TextureBindingNode(tex.type as d.FlatDepthTextureDesc, `t${tex.id}`);
    binding.value = tex as GpuTexture<d.FlatDepthTextureDesc>;
    
    const samplerNode = new SamplerNode(
        sampler.isComparison ? d.samplerComparison : d.sampler,
        `s${sampler.id}`,
    );
    samplerNode.value = sampler;
    
    const node = new DepthTextureNode(binding);
    node.samplerNode = samplerNode;
    return node;
}
```

---

## Usage Examples

### Basic 2D Texture

```typescript
import * as d from 'gpucat';
import { GpuTexture, GpuSampler, texture } from 'gpucat';

// Create texture from image
const albedoTex = new GpuTexture(d.texture2d(), {
    width: 512,
    height: 512,
    source: imageElement,
    generateMipmaps: true,
});

// Create sampler with desired settings
const linearSampler = new GpuSampler({
    minFilter: 'linear',
    magFilter: 'linear',
    mipmapFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
});

// Create texture node for shader
const albedo = texture(albedoTex, linearSampler);

// Use in shader
const color = albedo.sample(uv);
```

### Cube Map

```typescript
const envMapTex = new GpuTexture(d.textureCube(), {
    size: 1024,
    faces: [posX, negX, posY, negY, posZ, negZ],
    generateMipmaps: true,
});

const envSampler = new GpuSampler({
    minFilter: 'linear',
    magFilter: 'linear',
    mipmapFilter: 'linear',
});

const envMap = cubeTexture(envMapTex, envSampler);

// Sample with reflection direction
const reflected = envMap.sample(reflectDir).level(roughness.mul(maxMipLevel));
```

### Shadow Map (Depth 2D)

```typescript
const shadowMapTex = new GpuTexture(d.textureDepth2d(), {
    width: 2048,
    height: 2048,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});

// Comparison sampler for hardware PCF
const shadowSampler = new GpuSampler({
    compare: 'less',
    minFilter: 'linear',
    magFilter: 'linear',
});

const shadowMap = depthTexture(shadowMapTex, shadowSampler);

// Use textureSampleCompare
const shadow = shadowMap.compare(shadowUv, depthRef);
```

### CSM Shadow Cascades (Depth 2D Array)

```typescript
const csmTex = new GpuTexture(d.textureDepth2dArray(), {
    width: 2048,
    height: 2048,
    layers: 4,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});

const csmSampler = new GpuSampler({ compare: 'less' });
const csm = depthTexture(csmTex, csmSampler);
```

### Point Light Shadow (Depth Cube)

```typescript
const pointShadowTex = new GpuTexture(d.textureDepthCube(), {
    size: 1024,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});

const pointShadowSampler = new GpuSampler({ compare: 'less' });
// Note: need depthCubeTexture() factory for this
```

### 3D Volume Texture

```typescript
const volumeTex = new GpuTexture(d.texture3d(), {
    width: 64,
    height: 64,
    depth: 64,
    source: volumeData,  // Source with DataTextureImage containing 3D data
});

const volumeSampler = new GpuSampler({
    minFilter: 'linear',
    magFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    addressModeW: 'clamp-to-edge',
});

// Need texture3d() factory
const volume = texture3d(volumeTex, volumeSampler);
```

### Sampler Sharing

Multiple textures can share the same sampler:

```typescript
const linearRepeat = new GpuSampler({
    minFilter: 'linear',
    magFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
});

const albedo = texture(albedoTex, linearRepeat);
const normal = texture(normalTex, linearRepeat);
const roughness = texture(roughnessTex, linearRepeat);
```

---

## Migration: What Changes

| Current | New |
|---------|-----|
| `Texture` | `GpuTexture<d.texture2d>` |
| `DataTexture` | `GpuTexture<d.texture2d>` with typed array in Source |
| `DepthTexture` | `GpuTexture<d.textureDepth2d>` |
| `ArrayTexture` | `GpuTexture<d.texture2dArray>` |
| `Data3DTexture` | `GpuTexture<d.texture3d>` |
| `CubeTexture` | `GpuTexture<d.textureCube>` |
| `VideoTexture` | thin wrapper or direct `GpuTexture<d.texture2d>` use |
| `CanvasTexture` | direct `GpuTexture<d.texture2d>` use |
| Sampling params on Texture | Separate `GpuSampler` |
| `texture(tex)` | `texture(gpuTex, sampler)` |
| `cubeTexture(tex)` | `cubeTexture(gpuTex, sampler)` |

---

## Benefits

1. **Single class** — matches WebGPU's single `GPUTexture`
2. **Type-safe via generic** — `GpuTexture<d.textureCube>` knows it's a cube at compile time
3. **Schema is source of truth** — same `d.textureCube()` for WGSL codegen AND runtime
4. **Conditional options** — TypeScript enforces `size` for cubes, `width/height/layers` for arrays
5. **No combinatorial explosion** — depth is a format, cube is a view dimension
6. **Follows GpuBuffer pattern** — `type` field, dirty tracking, lifecycle
7. **Explicit sampler sharing** — samplers are first-class, can be shared across textures

---

## Layer 2: High-Level Classes

The low-level `GpuTexture<D>` and `GpuSampler` are powerful but verbose for common cases. High-level wrapper classes provide a familiar, ergonomic API while using the low-level primitives internally.

### Design Principle

High-level classes:
- Own a `GpuTexture<D>` and `GpuSampler` internally
- Expose familiar properties (like current `Texture` API)
- Forward to the internal objects
- Work with `texture()`, `cubeTexture()`, etc. which extract the internals

### Texture

The main high-level class for 2D textures. Accepts images, canvas, video, typed arrays.

```typescript
export type TextureOptions = {
    // Sampling
    wrapS?: GPUAddressMode;
    wrapT?: GPUAddressMode;
    magFilter?: GPUFilterMode;
    minFilter?: GPUFilterMode;
    mipmapFilter?: GPUMipmapFilterMode;
    anisotropy?: number;
    
    // Format/upload
    format?: GPUTextureFormat;
    generateMipmaps?: boolean;
    flipY?: boolean;
    premultiplyAlpha?: boolean;
};

export class Texture {
    readonly isTexture = true;
    
    /** The underlying GPU texture resource */
    readonly gpuTexture: GpuTexture<d.texture2d>;
    
    /** The underlying sampler */
    readonly sampler: GpuSampler;
    
    name = '';
    
    constructor(source: SourceData | Source, options: TextureOptions = {}) {
        const src = source instanceof Source ? source : new Source(source);
        
        this.gpuTexture = new GpuTexture(d.texture2d(), {
            width: src.width || 1,
            height: src.height || 1,
            source: src,
            format: options.format,
            generateMipmaps: options.generateMipmaps ?? true,
            flipY: options.flipY ?? false,
            premultiplyAlpha: options.premultiplyAlpha ?? false,
        });
        
        this.sampler = new GpuSampler({
            addressModeU: options.wrapS ?? 'clamp-to-edge',
            addressModeV: options.wrapT ?? 'clamp-to-edge',
            magFilter: options.magFilter ?? 'linear',
            minFilter: options.minFilter ?? 'linear',
            mipmapFilter: options.mipmapFilter ?? 'linear',
            maxAnisotropy: options.anisotropy ?? 1,
        });
    }
    
    // ─── Convenience getters/setters that forward to internals ───
    
    get id() { return this.gpuTexture.id; }
    get width() { return this.gpuTexture.width; }
    get height() { return this.gpuTexture.height; }
    get source() { return this.gpuTexture.source; }
    
    get wrapS() { return this.sampler.addressModeU; }
    set wrapS(v) { this.sampler.addressModeU = v; }
    
    get wrapT() { return this.sampler.addressModeV; }
    set wrapT(v) { this.sampler.addressModeV = v; }
    
    get magFilter() { return this.sampler.magFilter; }
    set magFilter(v) { this.sampler.magFilter = v; }
    
    get minFilter() { return this.sampler.minFilter; }
    set minFilter(v) { this.sampler.minFilter = v; }
    
    get mipmapFilter() { return this.sampler.mipmapFilter; }
    set mipmapFilter(v) { this.sampler.mipmapFilter = v; }
    
    get anisotropy() { return this.sampler.maxAnisotropy; }
    set anisotropy(v) { this.sampler.maxAnisotropy = v; }
    
    set needsUpdate(v: boolean) {
        if (v) this.gpuTexture.needsUpdate = true;
    }
    
    dispose() {
        this.gpuTexture.dispose();
        this.sampler.dispose();
    }
}
```

### CubeTexture

High-level class for cube maps.

```typescript
export type CubeTextureOptions = TextureOptions & {
    mapping?: 'reflection' | 'refraction';
};

export class CubeTexture {
    readonly isCubeTexture = true;
    
    readonly gpuTexture: GpuTexture<d.textureCube>;
    readonly sampler: GpuSampler;
    
    mapping: 'reflection' | 'refraction';
    name = '';
    
    constructor(
        faces: [SourceData, SourceData, SourceData, SourceData, SourceData, SourceData] | SourceData[],
        options: CubeTextureOptions = {}
    ) {
        const size = faces[0] ? (faces[0] as any).width || 1 : 1;
        
        this.gpuTexture = new GpuTexture(d.textureCube(), {
            size,
            faces: faces.map(f => f instanceof Source ? f : new Source(f)),
            format: options.format,
            generateMipmaps: options.generateMipmaps ?? true,
            flipY: options.flipY ?? false,
        });
        
        this.sampler = new GpuSampler({
            addressModeU: options.wrapS ?? 'clamp-to-edge',
            addressModeV: options.wrapT ?? 'clamp-to-edge',
            addressModeW: 'clamp-to-edge',
            magFilter: options.magFilter ?? 'linear',
            minFilter: options.minFilter ?? 'linear',
            mipmapFilter: options.mipmapFilter ?? 'linear',
        });
        
        this.mapping = options.mapping ?? 'reflection';
    }
    
    get id() { return this.gpuTexture.id; }
    get size() { return this.gpuTexture.size; }
    get isComplete() { return this.gpuTexture.isComplete; }
    
    // ... similar forwarding properties
    
    dispose() {
        this.gpuTexture.dispose();
        this.sampler.dispose();
    }
}
```

### VideoTexture

Thin wrapper that adds per-frame update logic.

```typescript
export class VideoTexture {
    readonly isVideoTexture = true;
    
    readonly gpuTexture: GpuTexture<d.texture2d>;
    readonly sampler: GpuSampler;
    
    constructor(video: HTMLVideoElement, options: TextureOptions = {}) {
        this.gpuTexture = new GpuTexture(d.texture2d(), {
            width: video.videoWidth || 1,
            height: video.videoHeight || 1,
            source: new Source(video),
            generateMipmaps: false,  // Videos don't use mipmaps
            flipY: false,
        });
        
        this.sampler = new GpuSampler({
            addressModeU: options.wrapS ?? 'clamp-to-edge',
            addressModeV: options.wrapT ?? 'clamp-to-edge',
            magFilter: options.magFilter ?? 'linear',
            minFilter: options.minFilter ?? 'linear',
        });
    }
    
    get id() { return this.gpuTexture.id; }
    
    /** Call each frame to check if video has new data */
    update(): void {
        const video = this.gpuTexture.source?.data as HTMLVideoElement;
        if (video && video.readyState >= video.HAVE_CURRENT_DATA) {
            this.gpuTexture.needsUpdate = true;
        }
    }
    
    dispose() {
        this.gpuTexture.dispose();
        this.sampler.dispose();
    }
}
```

### CanvasTexture

Thin wrapper for canvas sources.

```typescript
export class CanvasTexture {
    readonly isCanvasTexture = true;
    
    readonly gpuTexture: GpuTexture<d.texture2d>;
    readonly sampler: GpuSampler;
    
    constructor(canvas: HTMLCanvasElement | OffscreenCanvas, options: TextureOptions = {}) {
        this.gpuTexture = new GpuTexture(d.texture2d(), {
            width: canvas.width,
            height: canvas.height,
            source: new Source(canvas),
            generateMipmaps: false,
            flipY: false,
        });
        
        this.sampler = new GpuSampler({
            addressModeU: options.wrapS ?? 'clamp-to-edge',
            addressModeV: options.wrapT ?? 'clamp-to-edge',
            magFilter: options.magFilter ?? 'linear',
            minFilter: options.minFilter ?? 'linear',
        });
    }
    
    get id() { return this.gpuTexture.id; }
    
    dispose() {
        this.gpuTexture.dispose();
        this.sampler.dispose();
    }
}
```

### DataTexture

High-level class for textures created from typed arrays. Useful for procedural textures, LUTs, noise textures, heightmaps, etc.

```typescript
export type DataTextureOptions = TextureOptions & {
    format?: GPUTextureFormat;
};

export class DataTexture {
    readonly isDataTexture = true;
    
    readonly gpuTexture: GpuTexture<d.texture2d>;
    readonly sampler: GpuSampler;
    
    name = '';
    
    constructor(
        data: Uint8Array | Uint16Array | Float32Array,
        width: number,
        height: number,
        options: DataTextureOptions = {}
    ) {
        // Infer format from data type if not specified
        const format = options.format ?? inferFormat(data);
        
        this.gpuTexture = new GpuTexture(d.texture2d(), {
            width,
            height,
            source: new Source({ data, width, height }),
            format,
            generateMipmaps: options.generateMipmaps ?? false,
            flipY: options.flipY ?? false,
        });
        
        this.sampler = new GpuSampler({
            addressModeU: options.wrapS ?? 'clamp-to-edge',
            addressModeV: options.wrapT ?? 'clamp-to-edge',
            magFilter: options.magFilter ?? 'nearest',
            minFilter: options.minFilter ?? 'nearest',
            mipmapFilter: options.mipmapFilter ?? 'nearest',
        });
    }
    
    get id() { return this.gpuTexture.id; }
    get width() { return this.gpuTexture.width; }
    get height() { return this.gpuTexture.height; }
    get format() { return this.gpuTexture.format; }
    
    /** The underlying data array */
    get data(): Uint8Array | Uint16Array | Float32Array | null {
        const img = this.gpuTexture.source?.data;
        if (img && typeof img === 'object' && 'data' in img) {
            return img.data as Uint8Array | Uint16Array | Float32Array;
        }
        return null;
    }
    
    set needsUpdate(v: boolean) {
        if (v) this.gpuTexture.needsUpdate = true;
    }
    
    dispose() {
        this.gpuTexture.dispose();
        this.sampler.dispose();
    }
}

/** Infer texture format from typed array type */
function inferFormat(data: Uint8Array | Uint16Array | Float32Array): GPUTextureFormat {
    if (data instanceof Float32Array) return 'rgba32float';
    if (data instanceof Uint16Array) return 'rgba16float';
    return 'rgba8unorm';  // Uint8Array
}
```

**Usage examples:**

```typescript
// Procedural noise texture
const noiseData = new Float32Array(256 * 256 * 4);
for (let i = 0; i < noiseData.length; i += 4) {
    const v = Math.random();
    noiseData[i] = v;
    noiseData[i + 1] = v;
    noiseData[i + 2] = v;
    noiseData[i + 3] = 1;
}
const noiseTex = new DataTexture(noiseData, 256, 256, { 
    wrapS: 'repeat', 
    wrapT: 'repeat' 
});

// Color LUT (lookup table)
const lutData = new Uint8Array(256 * 1 * 4);
for (let i = 0; i < 256; i++) {
    lutData[i * 4 + 0] = i;        // R
    lutData[i * 4 + 1] = 255 - i;  // G
    lutData[i * 4 + 2] = 128;      // B
    lutData[i * 4 + 3] = 255;      // A
}
const lutTex = new DataTexture(lutData, 256, 1);

// Heightmap
const heightData = new Float32Array(512 * 512 * 4);
// ... fill with height values
const heightmap = new DataTexture(heightData, 512, 512, {
    format: 'r32float',  // Single channel float
});
```

### ArrayTexture

High-level class for 2D texture arrays.

```typescript
export class ArrayTexture {
    readonly isArrayTexture = true;
    
    readonly gpuTexture: GpuTexture<d.texture2dArray>;
    readonly sampler: GpuSampler;
    
    constructor(
        data: Uint8Array | Float32Array | null,
        width: number,
        height: number,
        layers: number,
        options: TextureOptions = {}
    ) {
        this.gpuTexture = new GpuTexture(d.texture2dArray(), {
            width,
            height,
            layers,
            source: data ? new Source({ data, width, height, depth: layers }) : undefined,
            format: options.format,
            generateMipmaps: options.generateMipmaps ?? false,
        });
        
        this.sampler = new GpuSampler({
            addressModeU: options.wrapS ?? 'clamp-to-edge',
            addressModeV: options.wrapT ?? 'clamp-to-edge',
            magFilter: options.magFilter ?? 'nearest',
            minFilter: options.minFilter ?? 'nearest',
        });
    }
    
    get id() { return this.gpuTexture.id; }
    get width() { return this.gpuTexture.width; }
    get height() { return this.gpuTexture.height; }
    get layers() { return this.gpuTexture.layers; }
    
    /** Mark a specific layer as needing update */
    addLayerUpdate(layerIndex: number): void {
        this.gpuTexture.layerUpdates.add(layerIndex);
    }
    
    dispose() {
        this.gpuTexture.dispose();
        this.sampler.dispose();
    }
}
```

### Data3DTexture

High-level class for 3D volume textures.

```typescript
export class Data3DTexture {
    readonly is3DTexture = true;
    
    readonly gpuTexture: GpuTexture<d.texture3d>;
    readonly sampler: GpuSampler;
    
    constructor(
        data: Uint8Array | Float32Array | null,
        width: number,
        height: number,
        depth: number,
        options: TextureOptions = {}
    ) {
        this.gpuTexture = new GpuTexture(d.texture3d(), {
            width,
            height,
            depth,
            source: data ? new Source({ data, width, height, depth }) : undefined,
            format: options.format,
            generateMipmaps: options.generateMipmaps ?? false,
        });
        
        this.sampler = new GpuSampler({
            addressModeU: options.wrapS ?? 'clamp-to-edge',
            addressModeV: options.wrapT ?? 'clamp-to-edge',
            addressModeW: 'clamp-to-edge',
            magFilter: options.magFilter ?? 'nearest',
            minFilter: options.minFilter ?? 'nearest',
        });
    }
    
    get id() { return this.gpuTexture.id; }
    get width() { return this.gpuTexture.width; }
    get height() { return this.gpuTexture.height; }
    get depth() { return this.gpuTexture.depth; }
    
    dispose() {
        this.gpuTexture.dispose();
        this.sampler.dispose();
    }
}
```

### DepthTexture

`DepthTexture` is kept as a high-level class. While it's primarily for render targets, having a high-level wrapper provides consistency and convenience:

```typescript
export type DepthTextureFormat = 'depth16unorm' | 'depth24plus' | 'depth24plus-stencil8' | 'depth32float' | 'depth32float-stencil8';

export class DepthTexture {
    readonly isDepthTexture = true;
    readonly gpuTexture: GpuTexture<d.textureDepth2d>;
    readonly sampler: GpuSampler;
    
    name = '';
    
    constructor(width: number, height: number, format: DepthTextureFormat = 'depth24plus') {
        this.gpuTexture = new GpuTexture(d.textureDepth2d(), {
            width,
            height,
            format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        
        // Default to comparison sampler for shadow mapping
        this.sampler = new GpuSampler({
            compare: 'less',
            magFilter: 'linear',
            minFilter: 'linear',
        });
    }
    
    get id() { return this.gpuTexture.id; }
    get width() { return this.gpuTexture.width; }
    get height() { return this.gpuTexture.height; }
    get format() { return this.gpuTexture.format as DepthTextureFormat; }
    
    get compareFunction() { return this.sampler.compare ?? null; }
    set compareFunction(v: GPUCompareFunction | null) {
        this.sampler.compare = v ?? undefined;
    }
    
    setSize(width: number, height: number) {
        if (this.gpuTexture.width !== width || this.gpuTexture.height !== height) {
            this.gpuTexture.width = width;
            this.gpuTexture.height = height;
            this.gpuTexture.needsUpdate = true;
        }
    }
    
    dispose() {
        this.gpuTexture.dispose();
        this.sampler.dispose();
    }
}

---

## Updated Factory Functions

### Design Principles

1. **High-level classes are the primary input** — `texture(myTexture)` is the common case
2. **Extract internals, don't accept both** — High-level classes have `.gpuTexture` and `.sampler`, we extract them
3. **Low-level input via object** — `{ gpuTexture, sampler }` for advanced use
4. **Nodes reference low-level objects** — `TextureBindingNode.value` is `GpuTexture<D>`, `SamplerNode.value` is `GpuSampler`

### Type Definitions

```typescript
/** 
 * High-level texture types that can be passed to texture().
 * All have .gpuTexture and .sampler properties.
 */
type HighLevelTexture = Texture | DataTexture | VideoTexture | CanvasTexture;

/**
 * Low-level input: explicit GpuTexture + GpuSampler pair.
 * Use this when you want to share a sampler across textures or need full control.
 */
type LowLevelTextureInput<D extends d.AnyTextureDesc = d.texture2d> = {
    gpuTexture: GpuTexture<D>;
    sampler: GpuSampler;
};

/**
 * Input to texture() factory.
 */
type TextureInput = HighLevelTexture | LowLevelTextureInput<d.FlatSampledTextureDesc>;

/**
 * Type guard: is this a high-level texture class?
 */
function isHighLevelTexture(input: TextureInput): input is HighLevelTexture {
    return 'isTexture' in input || 'isDataTexture' in input || 'isVideoTexture' in input || 'isCanvasTexture' in input;
}
```

### texture()

```typescript
/**
 * Create a texture node for 2D texture sampling.
 * 
 * @param input - High-level Texture/DataTexture/VideoTexture/CanvasTexture, or low-level { gpuTexture, sampler }
 * 
 * @example
 * // High-level (most users)
 * const albedo = new Texture(image, { wrapS: 'repeat', wrapT: 'repeat' });
 * const albedoNode = texture(albedo);
 * 
 * // Low-level (sampler sharing)
 * const linearRepeat = new GpuSampler({ addressModeU: 'repeat', addressModeV: 'repeat' });
 * const albedoNode = texture({ gpuTexture: albedoTex.gpuTexture, sampler: linearRepeat });
 * const normalNode = texture({ gpuTexture: normalTex.gpuTexture, sampler: linearRepeat });
 */
export function texture(input: TextureInput): TextureNode {
    // Extract low-level objects from input
    let gpuTex: GpuTexture<d.FlatSampledTextureDesc>;
    let sampler: GpuSampler;
    
    if (isHighLevelTexture(input)) {
        // High-level: extract from wrapper
        gpuTex = input.gpuTexture;
        sampler = input.sampler;
    } else {
        // Low-level: use directly
        gpuTex = input.gpuTexture;
        sampler = input.sampler;
    }
    
    // Create binding node (holds reference to GpuTexture)
    const binding = new TextureBindingNode(gpuTex.type, `t${gpuTex.id}`);
    binding.value = gpuTex;
    
    // Create sampler node (holds reference to GpuSampler)
    const samplerNode = new SamplerNode(
        sampler.isComparison ? d.samplerComparison : d.sampler,
        `s${sampler.id}`,
    );
    samplerNode.value = sampler;
    
    // Create texture node with binding and sampler
    const node = new TextureNode(binding);
    node.samplerNode = samplerNode;
    return node;
}
```

### cubeTexture()

```typescript
type CubeTextureInput = CubeTexture | LowLevelTextureInput<d.textureCube>;

function isHighLevelCubeTexture(input: CubeTextureInput): input is CubeTexture {
    return 'isCubeTexture' in input;
}

/**
 * Create a cube texture node for environment mapping, skyboxes, etc.
 */
export function cubeTexture(input: CubeTextureInput): CubeTextureNode {
    let gpuTex: GpuTexture<d.textureCube>;
    let sampler: GpuSampler;
    
    if (isHighLevelCubeTexture(input)) {
        gpuTex = input.gpuTexture;
        sampler = input.sampler;
    } else {
        gpuTex = input.gpuTexture;
        sampler = input.sampler;
    }
    
    const binding = new TextureBindingNode(gpuTex.type, `t${gpuTex.id}`);
    binding.value = gpuTex;
    
    const samplerNode = new SamplerNode(d.sampler, `s${sampler.id}`);
    samplerNode.value = sampler;
    
    const node = new CubeTextureNode(binding);
    node.samplerNode = samplerNode;
    return node;
}
```

### depthTexture()

```typescript
type DepthTextureInput = DepthTexture | LowLevelTextureInput<d.FlatDepthTextureDesc>;

function isHighLevelDepthTexture(input: DepthTextureInput): input is DepthTexture {
    return 'isDepthTexture' in input;
}

/**
 * Create a depth texture node for shadow mapping, depth reads, etc.
 * 
 * The sampler determines whether this uses regular sampling or comparison sampling:
 * - Regular sampler → textureSample returns raw depth value
 * - Comparison sampler → textureSampleCompare for hardware PCF
 * 
 * DepthTexture defaults to comparison sampler for shadow mapping convenience.
 */
export function depthTexture(input: DepthTextureInput): DepthTextureNode {
    let gpuTex: GpuTexture<d.FlatDepthTextureDesc>;
    let sampler: GpuSampler;
    
    if (isHighLevelDepthTexture(input)) {
        gpuTex = input.gpuTexture;
        sampler = input.sampler;
    } else {
        gpuTex = input.gpuTexture;
        sampler = input.sampler;
    }
    
    const binding = new TextureBindingNode(gpuTex.type, `t${gpuTex.id}`);
    binding.value = gpuTex;
    
    const samplerNode = new SamplerNode(
        sampler.isComparison ? d.samplerComparison : d.sampler,
        `s${sampler.id}`,
    );
    samplerNode.value = sampler;
    
    const node = new DepthTextureNode(binding);
    node.samplerNode = samplerNode;
    return node;
}
```

### arrayTexture()

```typescript
type ArrayTextureInput = ArrayTexture | LowLevelTextureInput<d.texture2dArray>;

function isHighLevelArrayTexture(input: ArrayTextureInput): input is ArrayTexture {
    return 'isArrayTexture' in input;
}

/**
 * Create an array texture node for texture atlases, sprite sheets, etc.
 */
export function arrayTexture(
    input: ArrayTextureInput,
    layerNode: Node<d.i32>,
): ArrayTextureNode {
    let gpuTex: GpuTexture<d.texture2dArray>;
    let sampler: GpuSampler;
    
    if (isHighLevelArrayTexture(input)) {
        gpuTex = input.gpuTexture;
        sampler = input.sampler;
    } else {
        gpuTex = input.gpuTexture;
        sampler = input.sampler;
    }
    
    const binding = new TextureBindingNode(gpuTex.type, `t${gpuTex.id}`);
    binding.value = gpuTex;
    
    const samplerNode = new SamplerNode(d.sampler, `s${sampler.id}`);
    samplerNode.value = sampler;
    
    const node = new ArrayTextureNode(binding, layerNode);
    node.samplerNode = samplerNode;
    return node;
}
```

### What Changes in Existing Node Classes

**TextureBindingNode:**
```typescript
// BEFORE
value: TextureValueOf<D> | null = null;  // High-level class

// AFTER  
value: GpuTexture<D> | null = null;  // Low-level GpuTexture
```

**SamplerNode:**
```typescript
// BEFORE
// Settings copied onto node:
minFilter: GPUFilterMode = 'linear';
magFilter: GPUFilterMode = 'linear';
// ... etc

// AFTER
// Reference to GpuSampler:
value: GpuSampler | null = null;

// Settings accessed via value:
get minFilter() { return this.value?.minFilter ?? 'linear'; }
get settingsKey() { return this.value?.settingsKey ?? 'default'; }
```

### Usage Examples

```typescript
// ═══════════════════════════════════════════════════════════════════════════
// HIGH-LEVEL (most users) — unchanged from current API
// ═══════════════════════════════════════════════════════════════════════════

const albedo = new Texture(image, { wrapS: 'repeat', wrapT: 'repeat' });
const albedoNode = texture(albedo);

const envMap = new CubeTexture(faces);
const envNode = cubeTexture(envMap);

// ═══════════════════════════════════════════════════════════════════════════
// LOW-LEVEL (advanced users) — explicit control
// ═══════════════════════════════════════════════════════════════════════════

// Sampler sharing across multiple textures
const linearRepeat = new GpuSampler({
    minFilter: 'linear',
    magFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
});

const albedoNode = texture({ gpuTexture: albedoTex.gpuTexture, sampler: linearRepeat });
const normalNode = texture({ gpuTexture: normalTex.gpuTexture, sampler: linearRepeat });
const roughnessNode = texture({ gpuTexture: roughnessTex.gpuTexture, sampler: linearRepeat });

// ═══════════════════════════════════════════════════════════════════════════
// MIXED — high-level texture with custom sampler
// ═══════════════════════════════════════════════════════════════════════════

const myTexture = new Texture(image);
const pointSampler = new GpuSampler({ minFilter: 'nearest', magFilter: 'nearest' });

// Use the texture's GpuTexture but a different sampler
const node = texture({ gpuTexture: myTexture.gpuTexture, sampler: pointSampler });

// ═══════════════════════════════════════════════════════════════════════════
// RENDER TARGET — via high-level classes
// ═══════════════════════════════════════════════════════════════════════════

const rt = new RenderTarget(512, 512);
const rtColorNode = texture(rt.texture);  // rt.texture is a Texture

// Shadow mapping
const shadowRT = new RenderTarget(2048, 2048, { depthOnly: true });
const shadowNode = depthTexture(shadowRT.depthTexture);  // rt.depthTexture is a DepthTexture
```

---

## Renderer Updates

The renderer's texture system (`src/renderer/textures.ts`) needs to be refactored to work with `GpuTexture<D>` and `GpuSampler` instead of high-level classes.

### Key Changes

**1. Cache keyed by GpuTexture, not Texture:**

```typescript
// BEFORE
textureMap: WeakMap<Texture, TextureData>;

// AFTER
textureMap: WeakMap<GpuTexture<any>, TextureData>;
```

**2. updateTexture() takes GpuTexture:**

```typescript
// BEFORE
export function updateTexture(
    cache: TextureCache,
    device: GPUDevice,
    texture: Texture,
): TextureData { ... }

// AFTER
export function updateTexture<D extends d.AnyTextureDesc>(
    cache: TextureCache,
    device: GPUDevice,
    gpuTexture: GpuTexture<D>,
): TextureData { ... }
```

**3. Use GpuTexture properties directly:**

```typescript
// BEFORE — scattered type checks
const isCube = 'isCubeTexture' in texture && texture.isCubeTexture === true;
const isArray = 'isArrayTexture' in texture && texture.isArrayTexture === true;

// AFTER — derived from schema type
const viewDimension = gpuTexture.viewDimension;  // 'cube', '2d-array', etc.
const isCube = viewDimension === 'cube' || viewDimension === 'cube-array';
const isArray = viewDimension === '2d-array';
```

**4. Sampler cache uses GpuSampler:**

```typescript
// BEFORE — sampler settings copied from Texture
function getSamplerKey(texture: Texture): string {
    return `${texture.minFilter}-${texture.magFilter}-...`;
}

// AFTER — use GpuSampler.settingsKey
function updateSampler(
    cache: TextureCache,
    device: GPUDevice,
    sampler: GpuSampler,
): GPUSampler {
    const key = sampler.settingsKey;
    let data = cache.samplerCache.get(key);
    if (!data) {
        data = { sampler: createGPUSampler(device, sampler), usedTimes: 0 };
        cache.samplerCache.set(key, data);
    }
    sampler.gpuSampler = data.sampler;
    return data.sampler;
}
```

**5. Bindings use GpuTexture from nodes:**

```typescript
// In bindings.ts — when processing TextureBindingNode

// BEFORE
const texture = bindingNode.value as Texture;
const textureData = updateTexture(cache, device, texture);

// AFTER
const gpuTexture = bindingNode.value;  // Already GpuTexture<D>
const textureData = updateTexture(cache, device, gpuTexture);
gpuTexture.gpuTexture = textureData.texture;  // Set the GPU resource
```

### Dimension Detection Simplification

Currently `bindings.ts` has scattered dimension detection:

```typescript
// BEFORE (bindings.ts:643-645)
const isCube = 'isCubeTexture' in tex && tex.isCubeTexture;
const isArray = 'isArrayTexture' in tex && tex.isArrayTexture;
const is3D = 'is3DTexture' in tex && tex.is3DTexture;
```

With `GpuTexture<D>`, dimension comes from the schema:

```typescript
// AFTER
const viewDimension = gpuTexture.viewDimension;  // '2d' | 'cube' | '2d-array' | '3d' | ...
```

### Upload Logic

The upload functions need minor changes to read from `GpuTexture` properties:

```typescript
// BEFORE
const width = texture.width;
const height = texture.height;
const format = texture.format ?? 'rgba8unorm';
const flipY = texture.flipY;

// AFTER — same properties exist on GpuTexture
const width = gpuTexture.width;
const height = gpuTexture.height;
const format = gpuTexture.format;  // Always explicit, no default
const flipY = gpuTexture.flipY;
```

### Size/Format Change Detection

`GpuTexture.needsUpdate` triggers re-upload. The renderer should also detect size/format changes that require GPU texture recreation:

```typescript
function updateTexture<D extends d.AnyTextureDesc>(
    cache: TextureCache,
    device: GPUDevice,
    gpuTexture: GpuTexture<D>,
): TextureData {
    let data = cache.textureMap.get(gpuTexture);
    
    // Check if GPU texture needs recreation (size/format changed)
    if (data && !data.isDefaultTexture) {
        const needsRecreate = 
            data.texture.width !== gpuTexture.width ||
            data.texture.height !== gpuTexture.height ||
            data.texture.format !== gpuTexture.format;
        
        if (needsRecreate) {
            data.texture.destroy();
            data = undefined;
        }
    }
    
    // Check version for data re-upload
    if (data?.initialized && data.version === gpuTexture.version) {
        return data;
    }
    
    // ... rest of update logic
}
```

### Complete Upload Flow

Here's the full flow from user code to GPU, showing before/after:

#### Current Flow (High-Level Classes)

```
User Code                    Node System                   Bindings                      Textures
─────────────────────────────────────────────────────────────────────────────────────────────────────
                                                           
const tex = new Texture(img) ─────────────────────────────────────────────────────────────────────────
                                                           
texture(tex) ──────────────► TextureBindingNode            
                             .value = tex (Texture)        
                             SamplerNode                   
                             .minFilter = tex.minFilter    
                             .magFilter = tex.magFilter    
                             ... (settings copied)         
                                                           
                             ─────────────────────────────► updateTextureBinding()
                                                           │
                                                           ├─ if tex.isRenderTargetTexture:
                                                           │    use tex.gpuTexture directly
                                                           │
                                                           └─ else:
                                                                updateTexture(cache, device, tex)
                                                                │                              
                                                                ├─ isCube = 'isCubeTexture' in tex
                                                                ├─ isArray = 'isArrayTexture' in tex
                                                                ├─ createGPUTexture(device, tex)
                                                                │    └─ reads tex.width, tex.height, tex.format
                                                                └─ uploadTextureData(device, tex, data)
                                                                     ├─ if isCube: uploadCubeTextureData()
                                                                     ├─ if isArray: uploadArrayTextureData()
                                                                     └─ else: upload 2D data
                                                           
                             ─────────────────────────────► updateSamplerBinding()
                                                           │
                                                           └─ getSamplerFromNode(cache, device, samplerNode)
                                                                └─ uses samplerNode.minFilter, etc.
```

#### New Flow (GpuTexture + GpuSampler)

```
User Code                    Node System                   Bindings                      Textures
─────────────────────────────────────────────────────────────────────────────────────────────────────

const tex = new Texture(img) 
  └─ internally creates:
     gpuTexture = new GpuTexture(d.texture2d(), {...})
     sampler = new GpuSampler({...})
                                                           
texture(tex) ──────────────► TextureBindingNode            
                             .value = tex.gpuTexture ◄──── extracts GpuTexture
                             SamplerNode                   
                             .value = tex.sampler ◄─────── extracts GpuSampler
                                                           
                             ─────────────────────────────► updateTextureBinding()
                                                           │
                                                           └─ gpuTex = textureNode.value  // GpuTexture<D>
                                                              updateTexture(cache, device, gpuTex)
                                                              │
                                                              ├─ viewDim = gpuTex.viewDimension  // from schema
                                                              ├─ createGPUTexture(device, gpuTex)
                                                              │    └─ reads gpuTex.width, height, format, depthOrArrayLayers
                                                              └─ uploadTextureData(device, gpuTex, data)
                                                                   └─ dispatch by gpuTex.viewDimension:
                                                                        'cube' → uploadCubeFaces(gpuTex.sources)
                                                                        '2d-array' → uploadLayers(gpuTex.sources)
                                                                        '2d' → uploadSingle(gpuTex.source)
                                                           
                             ─────────────────────────────► updateSamplerBinding()
                                                           │
                                                           └─ sampler = samplerNode.value  // GpuSampler
                                                              updateSampler(cache, device, sampler)
                                                              └─ uses sampler.minFilter, sampler.settingsKey, etc.
```

### Detailed Function Changes

#### textures.ts

```typescript
// ═══════════════════════════════════════════════════════════════════════════
// updateTexture — main entry point
// ═══════════════════════════════════════════════════════════════════════════

export function updateTexture<D extends d.AnyTextureDesc>(
    cache: TextureCache,
    device: GPUDevice,
    gpuTexture: GpuTexture<D>,
): TextureData {
    let data = cache.textureMap.get(gpuTexture);
    
    // ─── Size/format change detection ───
    if (data && !data.isDefaultTexture) {
        const current = data.texture;
        if (current.width !== gpuTexture.width ||
            current.height !== gpuTexture.height ||
            current.depthOrArrayLayers !== gpuTexture.depthOrArrayLayers ||
            current.format !== gpuTexture.format) {
            current.destroy();
            data = undefined;
        }
    }
    
    // ─── Version check (skip if unchanged) ───
    if (data?.initialized && data.version === gpuTexture.version) {
        return data;
    }
    
    // ─── Completeness check ───
    if (!gpuTexture.isComplete) {
        // Use placeholder
        if (!data) {
            const defaultTex = getDefaultTexture(cache, device, gpuTexture.format);
            data = {
                texture: defaultTex,
                version: 0,
                generation: 0,
                initialized: true,
                isDefaultTexture: true,
            };
            cache.textureMap.set(gpuTexture, data);
        }
        return data;
    }
    
    // ─── Create GPU texture if needed ───
    if (!data || data.isDefaultTexture) {
        const tex = createGPUTextureFromDesc(device, gpuTexture);
        
        if (!data) {
            data = {
                texture: tex,
                version: gpuTexture.version,
                generation: gpuTexture.version,
                initialized: true,
                isDefaultTexture: false,
            };
            cache.textureMap.set(gpuTexture, data);
            cache.textureCount++;
        } else {
            data.texture = tex;
            data.generation = gpuTexture.version;
            data.isDefaultTexture = false;
            cache.textureCount++;
        }
        
        setupDispose(cache, gpuTexture);
    }
    
    // ─── Upload data ───
    uploadGpuTextureData(device, gpuTexture, data);
    
    // ─── Mipmaps ───
    if (gpuTexture.generateMipmaps && data.texture.mipLevelCount > 1) {
        const mipmapState = getMipmapState(cache, device);
        const isCube = gpuTexture.viewDimension === 'cube' || gpuTexture.viewDimension === 'cube-array';
        const arrayLayers = gpuTexture.viewDimension === '2d-array' ? gpuTexture.depthOrArrayLayers : 0;
        generateMipmaps(mipmapState, data.texture, isCube, arrayLayers);
    }
    
    // ─── Update tracking ───
    data.version = gpuTexture.version;
    data.initialized = true;
    
    // ─── Store GPU resource on GpuTexture ───
    gpuTexture.gpuTexture = data.texture;
    
    return data;
}

// ═══════════════════════════════════════════════════════════════════════════
// createGPUTextureFromDesc — creates GPUTexture from GpuTexture descriptor
// ═══════════════════════════════════════════════════════════════════════════

function createGPUTextureFromDesc<D extends d.AnyTextureDesc>(
    device: GPUDevice,
    gpuTexture: GpuTexture<D>,
): GPUTexture {
    const mipLevelCount = gpuTexture.generateMipmaps
        ? Math.floor(Math.log2(Math.max(gpuTexture.width, gpuTexture.height))) + 1
        : gpuTexture.mipLevelCount;
    
    return device.createTexture({
        dimension: gpuTexture.dimension,  // '1d' | '2d' | '3d'
        size: [gpuTexture.width, gpuTexture.height, gpuTexture.depthOrArrayLayers],
        format: gpuTexture.format,
        usage: gpuTexture.usage,
        mipLevelCount,
        sampleCount: gpuTexture.sampleCount,
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// uploadGpuTextureData — dispatches to appropriate upload function
// ═══════════════════════════════════════════════════════════════════════════

function uploadGpuTextureData<D extends d.AnyTextureDesc>(
    device: GPUDevice,
    gpuTexture: GpuTexture<D>,
    data: TextureData,
): void {
    const viewDim = gpuTexture.viewDimension;
    
    switch (viewDim) {
        case 'cube':
        case 'cube-array':
            uploadCubeFaces(device, gpuTexture, data);
            break;
        case '2d-array':
            uploadArrayLayers(device, gpuTexture, data);
            break;
        case '3d':
            upload3DVolume(device, gpuTexture, data);
            break;
        default:
            // '2d', '1d'
            uploadSingleSource(device, gpuTexture, data);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Upload helpers — use GpuTexture.source / GpuTexture.sources
// ═══════════════════════════════════════════════════════════════════════════

function uploadSingleSource<D extends d.AnyTextureDesc>(
    device: GPUDevice,
    gpuTexture: GpuTexture<D>,
    data: TextureData,
): void {
    const source = gpuTexture.source;
    if (!source?.dataReady) return;
    
    const image = source.data;
    if (!image) return;
    
    // Check if it's raw data or an image source
    if (isDataImage(image)) {
        // Typed array data
        const bytesPerPixel = getBytesPerPixel(gpuTexture.format);
        device.queue.writeTexture(
            { texture: data.texture },
            image.data.buffer,
            {
                offset: image.data.byteOffset,
                bytesPerRow: gpuTexture.width * bytesPerPixel,
                rowsPerImage: gpuTexture.height,
            },
            [gpuTexture.width, gpuTexture.height],
        );
    } else {
        // External image (HTMLImageElement, ImageBitmap, Canvas, Video, etc.)
        device.queue.copyExternalImageToTexture(
            { source: image, flipY: gpuTexture.flipY },
            { texture: data.texture, premultipliedAlpha: gpuTexture.premultiplyAlpha },
            [gpuTexture.width, gpuTexture.height],
        );
    }
}

function uploadCubeFaces<D extends d.AnyTextureDesc>(
    device: GPUDevice,
    gpuTexture: GpuTexture<D>,
    data: TextureData,
): void {
    const faces = gpuTexture.sources;
    if (faces.length !== 6) return;
    
    for (let faceIndex = 0; faceIndex < 6; faceIndex++) {
        const source = faces[faceIndex];
        if (!source?.dataReady) continue;
        
        const image = source.data;
        if (!image) continue;
        
        device.queue.copyExternalImageToTexture(
            { source: image as GPUImageCopyExternalImageSource, flipY: gpuTexture.flipY },
            {
                texture: data.texture,
                premultipliedAlpha: gpuTexture.premultiplyAlpha,
                origin: { x: 0, y: 0, z: faceIndex },
            },
            [gpuTexture.width, gpuTexture.height],
        );
    }
}

function uploadArrayLayers<D extends d.AnyTextureDesc>(
    device: GPUDevice,
    gpuTexture: GpuTexture<D>,
    data: TextureData,
): void {
    // Option 1: Single source with all layers packed
    if (gpuTexture.source) {
        const source = gpuTexture.source;
        if (!source.dataReady) return;
        
        const image = source.data;
        if (!isDataImage(image)) return;
        
        const bytesPerPixel = getBytesPerPixel(gpuTexture.format);
        const bytesPerLayer = gpuTexture.width * gpuTexture.height * bytesPerPixel;
        
        for (let layer = 0; layer < gpuTexture.depthOrArrayLayers; layer++) {
            device.queue.writeTexture(
                { texture: data.texture, origin: { x: 0, y: 0, z: layer } },
                image.data.buffer,
                {
                    offset: image.data.byteOffset + layer * bytesPerLayer,
                    bytesPerRow: gpuTexture.width * bytesPerPixel,
                    rowsPerImage: gpuTexture.height,
                },
                [gpuTexture.width, gpuTexture.height],
            );
        }
        return;
    }
    
    // Option 2: Per-layer sources
    for (let layer = 0; layer < gpuTexture.sources.length; layer++) {
        const source = gpuTexture.sources[layer];
        if (!source?.dataReady) continue;
        
        const image = source.data;
        if (!image) continue;
        
        if (isDataImage(image)) {
            const bytesPerPixel = getBytesPerPixel(gpuTexture.format);
            device.queue.writeTexture(
                { texture: data.texture, origin: { x: 0, y: 0, z: layer } },
                image.data.buffer,
                {
                    offset: image.data.byteOffset,
                    bytesPerRow: gpuTexture.width * bytesPerPixel,
                    rowsPerImage: gpuTexture.height,
                },
                [gpuTexture.width, gpuTexture.height],
            );
        } else {
            device.queue.copyExternalImageToTexture(
                { source: image as GPUImageCopyExternalImageSource },
                { texture: data.texture, origin: { x: 0, y: 0, z: layer } },
                [gpuTexture.width, gpuTexture.height],
            );
        }
    }
}

function upload3DVolume<D extends d.AnyTextureDesc>(
    device: GPUDevice,
    gpuTexture: GpuTexture<D>,
    data: TextureData,
): void {
    const source = gpuTexture.source;
    if (!source?.dataReady) return;
    
    const image = source.data;
    if (!isDataImage(image)) return;
    
    const bytesPerPixel = getBytesPerPixel(gpuTexture.format);
    
    device.queue.writeTexture(
        { texture: data.texture },
        image.data.buffer,
        {
            offset: image.data.byteOffset,
            bytesPerRow: gpuTexture.width * bytesPerPixel,
            rowsPerImage: gpuTexture.height,
        },
        [gpuTexture.width, gpuTexture.height, gpuTexture.depthOrArrayLayers],
    );
}
```

#### bindings.ts

```typescript
// ═══════════════════════════════════════════════════════════════════════════
// updateTextureBinding — simplified, works with GpuTexture directly
// ═══════════════════════════════════════════════════════════════════════════

function updateTextureBinding(
    textureCache: TextureCache,
    device: GPUDevice,
    binding: TextureBinding,
    data: BindGroupData,
): void {
    const textureNode = binding.entry.node;
    const gpuTexture = textureNode.value;  // Now GpuTexture<D>, not Texture
    
    if (!gpuTexture) return;
    
    // Update texture (handles creation, upload, caching)
    const texData = updateTexture(textureCache, device, gpuTexture);
    
    // Store GPU resource on node for bind group creation
    textureNode.resource = texData.texture;
    
    // Check for texture recreation
    if (binding.generation !== texData.generation) {
        binding.generation = texData.generation;
        data.needsUpdate = true;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// updateSamplerBinding — uses GpuSampler
// ═══════════════════════════════════════════════════════════════════════════

function updateSamplerBinding(
    textureCache: TextureCache,
    device: GPUDevice,
    binding: SamplerBinding,
    data: BindGroupData,
): void {
    const samplerNode = binding.entry.samplerNode;
    const sampler = samplerNode.value;  // Now GpuSampler, not copied settings
    
    if (!sampler) return;
    
    // Get or create GPU sampler
    const gpuSampler = updateSampler(textureCache, device, sampler);
    
    // Store on both sampler object and node
    sampler.gpuSampler = gpuSampler;
    samplerNode.resource = gpuSampler;
    
    // Check for sampler changes
    const samplerKey = sampler.settingsKey;
    if (binding.samplerKey !== samplerKey) {
        binding.samplerKey = samplerKey;
        data.needsUpdate = true;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// rebuildGPUBindGroup — view dimension from GpuTexture
// ═══════════════════════════════════════════════════════════════════════════

// In the 'texture' case:
case 'texture': {
    const textureNode = binding.entry.node;
    const gpuTexture = textureNode.value;
    
    if (!gpuTexture?.gpuTexture) break;
    
    // View dimension comes directly from GpuTexture (derived from schema)
    const view = gpuTexture.gpuTexture.createView({
        dimension: gpuTexture.viewDimension,
    });
    
    entries.push({ binding: binding.entry.binding, resource: view });
    break;
}
```

---

## Summary: Class Hierarchy

```
Layer 1: Low-Level (WebGPU-native)
├── GpuTexture<D>          — single generic class for all GPU textures
├── GpuSampler             — separate sampler settings
└── Source                 — CPU data container (unchanged)

Layer 2: High-Level (User-friendly)
├── Texture                — 2D textures from images
├── DataTexture            — 2D textures from typed arrays (noise, LUTs, procedural)
├── CubeTexture            — cube maps
├── VideoTexture           — video with update()
├── CanvasTexture          — canvas source
├── ArrayTexture           — 2D texture arrays
├── Data3DTexture          — 3D volume textures
└── DepthTexture           — depth textures (render targets, shadow maps)

Layer 3: Node System
├── TextureBindingNode<D>  — holds GpuTexture<D>
├── SamplerNode            — holds GpuSampler
├── TextureNode            — sampling operations (2D)
├── CubeTextureNode        — sampling operations (cube)
├── DepthTextureNode       — depth sampling operations
└── texture(), cubeTexture(), etc. — factory functions
```

---

## Migration Path

For existing code:

| Before | After |
|--------|-------|
| `new Texture(image)` | `new Texture(image)` (unchanged!) |
| `tex.wrapS = 'repeat'` | `tex.wrapS = 'repeat'` (unchanged!) |
| `texture(tex)` | `texture(tex)` (unchanged!) |
| `new DepthTexture(w, h)` | `new DepthTexture(w, h)` (unchanged!) |

The high-level API is essentially unchanged. Only advanced use cases (explicit sampler sharing, non-standard configurations) use the low-level API.

---

## RenderTarget Integration

RenderTarget continues to expose high-level `Texture` and `DepthTexture` classes. This keeps the simple API unchanged while allowing advanced users to access the underlying `GpuTexture` and `GpuSampler`.

### Design Decision

RenderTarget **owns high-level classes**, not low-level `GpuTexture` directly:

```typescript
class RenderTarget {
    readonly texture: Texture;           // High-level, owns GpuTexture<d.texture2d>
    readonly depthTexture: DepthTexture; // High-level, owns GpuTexture<d.textureDepth2d>
    
    // ...
}
```

### Why High-Level?

1. **Simple usage unchanged**: `texture(rt.texture)` works as today
2. **Consistency**: Users expect `rt.texture` to behave like any other `Texture`
3. **Convenience**: `rt.texture.wrapS = 'repeat'` just works
4. **Advanced access available**: `rt.texture.gpuTexture` and `rt.texture.sampler` for low-level control

### Usage Examples

**Simple (unchanged):**
```typescript
const rt = new RenderTarget(512, 512);

// Render to texture
pass(rt, mesh);

// Use the texture
const color = texture(rt.texture).sample(uv);
```

**With sampler modification:**
```typescript
const rt = new RenderTarget(512, 512);
rt.texture.wrapS = 'repeat';
rt.texture.wrapT = 'repeat';
rt.texture.minFilter = 'nearest';
```

**Advanced (low-level access):**
```typescript
const rt = new RenderTarget(512, 512);

// Access the underlying GpuTexture for custom operations
const gpuTex = rt.texture.gpuTexture;
console.log(gpuTex.format, gpuTex.width, gpuTex.height);

// Use a different sampler than the default
const customSampler = new GpuSampler({
    minFilter: 'nearest',
    magFilter: 'nearest',
    addressModeU: 'mirror-repeat',
    addressModeV: 'mirror-repeat',
});
const node = texture({ gpuTexture: rt.texture.gpuTexture, sampler: customSampler });
```

**Shadow mapping:**
```typescript
const shadowRT = new RenderTarget(2048, 2048, { depthOnly: true });

// The DepthTexture has a comparison sampler by default
const shadow = depthTexture(shadowRT.depthTexture);

// Custom comparison function
shadowRT.depthTexture.compareFunction = 'less-equal';
```

### Internal Implementation

RenderTarget creates high-level classes internally, which create `GpuTexture` instances:

```typescript
class RenderTarget {
    readonly texture: Texture;
    readonly depthTexture: DepthTexture | null;
    
    constructor(width: number, height: number, options: RenderTargetOptions = {}) {
        // Color attachment (unless depth-only)
        if (!options.depthOnly) {
            this.texture = new Texture(null, {
                // No source data - this is a render target
                format: options.format ?? 'rgba8unorm',
            });
            this.texture.gpuTexture.width = width;
            this.texture.gpuTexture.height = height;
            this.texture.gpuTexture.usage = 
                GPUTextureUsage.RENDER_ATTACHMENT | 
                GPUTextureUsage.TEXTURE_BINDING | 
                GPUTextureUsage.COPY_SRC;
        }
        
        // Depth attachment
        if (options.depth !== false) {
            this.depthTexture = new DepthTexture(width, height, options.depthFormat);
        }
    }
    
    setSize(width: number, height: number) {
        if (this.texture) {
            this.texture.gpuTexture.width = width;
            this.texture.gpuTexture.height = height;
            this.texture.gpuTexture.needsUpdate = true;
        }
        if (this.depthTexture) {
            this.depthTexture.setSize(width, height);
        }
    }
    
    dispose() {
        this.texture?.dispose();
        this.depthTexture?.dispose();
    }
}
```

---

## Resolved Decisions

1. **DepthTexture**: Kept as a high-level class wrapping `GpuTexture<d.textureDepth2d>` + `GpuSampler`. Defaults to comparison sampler for shadow mapping convenience.

2. **RenderTarget integration**: RenderTarget owns high-level `Texture` and `DepthTexture` instances. Simple usage unchanged (`texture(rt.texture)`), advanced users can access `.gpuTexture` and `.sampler` for low-level control.

3. **Sampler deduplication**: Left to users. Multiple high-level textures create their own `GpuSampler` instances. Users wanting to share can use the low-level API directly.

4. **DataTexture**: Added as a high-level class for textures created from typed arrays. Useful for procedural textures, LUTs, noise, heightmaps. Defaults to `nearest` filtering (appropriate for data). Format inference from typed array type (`Float32Array` → `rgba32float`, etc.).

---

## Implementation Guide

This section provides the recommended implementation order and key files to modify.

### Phase 1: Core Low-Level Classes

**Create new files:**

1. `src/core/gpu-texture.ts` — `GpuTexture<D>` class
   - Use the code from the "GpuTexture<D>" section above
   - Import schema types from `src/nodes/schema.ts`
   - Import `Source` from `src/texture/source.ts`

2. `src/core/gpu-sampler.ts` — `GpuSampler` class
   - Use the code from the "GpuSampler" section above

**Export from index:**
- Add exports to `src/index.ts`

### Phase 2: Refactor High-Level Classes

**Modify existing files (in order):**

1. `src/texture/texture.ts` — Refactor `Texture`
   - Keep the public API (constructor signature, properties)
   - Internally create `GpuTexture<d.texture2d>` and `GpuSampler`
   - Forward property access to internals
   - Add `readonly gpuTexture` and `readonly sampler` getters

2. `src/texture/depth-texture.ts` — Refactor `DepthTexture`
   - Similar pattern to `Texture`
   - Default sampler to comparison mode

3. `src/texture/cube-texture.ts` — Refactor `CubeTexture`

4. `src/texture/video-texture.ts` — Refactor `VideoTexture`

5. `src/texture/canvas-texture.ts` — Refactor `CanvasTexture`

6. `src/texture/array-texture.ts` — Refactor `ArrayTexture`

7. `src/texture/texture-3d.ts` — Refactor `Data3DTexture`

8. `src/texture/data-texture.ts` — Create new `DataTexture` class (currently may exist, check first)

### Phase 3: Node System Updates

**Modify:**

1. `src/nodes/lib/texture.ts`
   - Update `TextureBindingNode.value` type to `GpuTexture<D> | null`
   - Update `SamplerNode` to have `.value: GpuSampler | null` instead of copied settings
   - Update factory functions (`texture()`, `cubeTexture()`, `depthTexture()`, `arrayTexture()`)
   - Add type guards and input types

### Phase 4: Renderer Updates

**Modify:**

1. `src/renderer/textures.ts`
   - Change `TextureCache.textureMap` to `WeakMap<GpuTexture<any>, TextureData>`
   - Refactor `updateTexture()` to take `GpuTexture<D>`
   - Refactor upload functions to use `GpuTexture` properties
   - Add `updateSampler()` function for `GpuSampler`

2. `src/renderer/bindings.ts`
   - Update `updateTextureBinding()` to work with `GpuTexture`
   - Update `updateSamplerBinding()` to work with `GpuSampler`
   - Simplify view dimension detection in `rebuildGPUBindGroup()`

### Phase 5: RenderTarget Updates

**Modify:**

1. `src/core/render-target.ts`
   - Keep `Texture` and `DepthTexture` ownership
   - Update internal creation to use refactored classes
   - Ensure `setSize()` works with new internals

### Phase 6: Validation

**Test with examples:**
- `examples/src/example-texture.ts` — basic 2D texture
- `examples/src/example-cubemap.ts` — cube texture
- `examples/src/example-shadow-map.ts` — depth texture, comparison sampling
- `examples/src/example-render-to-texture.ts` — render target usage
- `examples/src/example-mrt.ts` — multiple render targets

**Run:**
```bash
pnpm build        # Type check
pnpm test         # Run tests
pnpm dev          # Test examples visually
```

### Key Files Reference

| File | Purpose |
|------|---------|
| `src/core/buffer.ts` | **Pattern to follow** — `GpuBuffer` shows dirty tracking, lifecycle, `_onDispose` |
| `src/nodes/schema.ts` | Schema types (`d.texture2d()`, etc.) — lines 265-425 |
| `src/texture/source.ts` | `Source` class — **unchanged**, used by `GpuTexture` for CPU data |
| `src/texture/*.ts` | Current high-level classes to refactor |
| `src/nodes/lib/texture.ts` | Node classes and factory functions |
| `src/renderer/textures.ts` | Texture cache and upload logic |
| `src/renderer/bindings.ts` | Binding updates, lines 515-576 most relevant |
| `src/core/render-target.ts` | RenderTarget class |

### Classes That Don't Change

- **`Source`** — Already has everything needed: `data`, `dataReady`, `width/height/depth` getters, `version`/`needsUpdate`. `GpuTexture` uses `Source` directly for CPU data storage.

### Important Patterns

**Dirty tracking (from GpuBuffer):**
```typescript
version = 0;
set needsUpdate(_: true) { this.version++; }
```

**Disposal callback:**
```typescript
_onDispose: (() => void) | null = null;
disposed = false;

dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this._onDispose?.();
    this._onDispose = null;
    // ... cleanup
}
```

**Schema to dimension mapping:**
```typescript
function deriveViewDimension(type: d.AnyTextureDesc): GPUTextureViewDimension {
    switch (type.type) {
        case 'texture_cube': return 'cube';
        case 'texture_2d_array': return '2d-array';
        // ... etc
    }
}
```

### Common Pitfalls

1. **Circular imports**: The design accepts circular imports as noted in AGENTS.md. Don't restructure to avoid them.

2. **Backwards compatibility**: This library has NO users yet. Don't preserve old APIs — clean break is fine.

3. **Format defaults**: High-level classes can default format (e.g., `rgba8unorm`), but `GpuTexture` requires explicit format.

4. **Sampler on DepthTexture**: Defaults to comparison sampler (`compare: 'less'`) for shadow mapping convenience.

5. **RenderTarget textures**: These don't have source data — they're render attachments. The upload flow skips them (detected by checking if source exists).

6. **View dimension vs dimension**: `dimension` is for `GPUTextureDescriptor` ('1d', '2d', '3d'). `viewDimension` is for `GPUTextureView` ('2d', 'cube', '2d-array', etc.). Cube textures use dimension '2d' with 6 array layers, but viewDimension 'cube'.
