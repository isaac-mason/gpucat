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

### What About DepthTexture?

`DepthTexture` is different — it's primarily for render targets, not user data. Two options:

**Option A: Keep DepthTexture as high-level class**
```typescript
export class DepthTexture {
    readonly isDepthTexture = true;
    readonly gpuTexture: GpuTexture<d.textureDepth2d>;
    readonly sampler: GpuSampler;
    
    compareFunction: GPUCompareFunction | null = null;
    
    constructor(width: number, height: number, format: DepthTextureFormat = 'depth24plus') {
        this.gpuTexture = new GpuTexture(d.textureDepth2d(), {
            width,
            height,
            format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        
        this.sampler = new GpuSampler({
            magFilter: 'nearest',
            minFilter: 'nearest',
        });
    }
    
    setSize(width: number, height: number) {
        this.gpuTexture.width = width;
        this.gpuTexture.height = height;
        this.gpuTexture.needsUpdate = true;
    }
}
```

**Option B: Just use GpuTexture directly for depth**

Since depth textures are mostly created by RenderTarget internally, maybe no high-level wrapper is needed. Users doing advanced shadow mapping can use `GpuTexture<d.textureDepth2d>` directly.

**Recommendation:** Option B — no `DepthTexture` high-level class. RenderTarget creates `GpuTexture` internally. For shadow maps, users work with `GpuTexture<d.textureDepth*>` directly (it's an advanced use case anyway).

---

## Updated Factory Functions

The `texture()` etc. functions accept EITHER high-level OR low-level:

```typescript
/** Input can be high-level Texture OR low-level GpuTexture + GpuSampler */
type TextureInput = 
    | Texture 
    | VideoTexture 
    | CanvasTexture
    | { gpuTexture: GpuTexture<d.FlatSampledTextureDesc>; sampler: GpuSampler };

/**
 * Create a texture node.
 * Accepts high-level Texture or low-level GpuTexture + GpuSampler.
 */
export function texture(input: TextureInput): TextureNode {
    const gpuTex = 'gpuTexture' in input ? input.gpuTexture : input.gpuTexture;
    const sampler = 'sampler' in input ? input.sampler : input.sampler;
    
    const binding = new TextureBindingNode(gpuTex.type, `t${gpuTex.id}`);
    binding.value = gpuTex;
    
    const samplerNode = new SamplerNode(d.sampler, `s${sampler.id}`);
    samplerNode.value = sampler;
    
    const node = new TextureNode(binding);
    node.samplerNode = samplerNode;
    return node;
}

// Similar for cubeTexture(), etc.
```

**Usage stays simple:**

```typescript
// High-level (most users)
const albedo = new Texture(image, { wrapS: 'repeat', wrapT: 'repeat' });
const albedoNode = texture(albedo);  // Just like today!

// Low-level (advanced users)
const gpuTex = new GpuTexture(d.texture2d(), { width: 512, height: 512, source: image });
const sampler = new GpuSampler({ addressModeU: 'repeat', addressModeV: 'repeat' });
const node = texture({ gpuTexture: gpuTex, sampler });
```

---

## Summary: Class Hierarchy

```
Layer 1: Low-Level (WebGPU-native)
├── GpuTexture<D>          — single generic class for all GPU textures
├── GpuSampler             — separate sampler settings
└── Source                 — CPU data container (unchanged)

Layer 2: High-Level (User-friendly)
├── Texture                — 2D textures (image, canvas, video, data)
├── CubeTexture            — cube maps
├── VideoTexture           — video with update()
├── CanvasTexture          — canvas source
├── ArrayTexture           — 2D texture arrays
└── Data3DTexture          — 3D volume textures

(No DepthTexture — use GpuTexture<d.textureDepth*> directly)

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
| `new DepthTexture(w, h)` | `new GpuTexture(d.textureDepth2d(), { width: w, height: h, ... })` |

The high-level API is essentially unchanged. Only advanced use cases (depth textures, explicit sampler sharing, non-standard configurations) use the low-level API.

---

## Open Questions

1. **DataTexture?** Currently there's no `DataTexture` class — `Texture` can accept typed arrays via `Source`. Should we add a convenience class, or is `Texture` sufficient?

2. **RenderTarget integration?** RenderTarget owns its attachments. It should create `GpuTexture` instances internally. The `DepthTexture` it currently creates becomes `GpuTexture<d.textureDepth2d>`.

3. **Sampler deduplication?** Multiple high-level textures with identical sampler settings could share the same `GpuSampler` instance. Worth doing, or let users handle it?
