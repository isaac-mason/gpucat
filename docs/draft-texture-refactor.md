# Draft: Texture Resource Refactor

## Current State

The texture system has a three.js-inspired class hierarchy organized by **semantic role / data source**:

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

**Problems with this approach:**
1. Combinatorial explosion — CSM needs a depth 2D array, so do we add `DepthArrayTexture`? Depth cube? Depth cube array?
2. `Texture` conflates GPU resource descriptor (dimension, format, usage) with source data management AND sampling parameters
3. Renderer has scattered `isCubeTexture`/`isArrayTexture`/`isDepthTexture` checks to determine GPU texture dimension
4. Not aligned with WebGPU's actual resource model

## Proposed Model

Follow the `GpuBuffer` pattern: a class per GPU resource type that **owns its source data** and **handles dirty tracking**.

### Layer 1: GpuTexture Classes (by GPU dimension)

```typescript
// Mirrors WebGPU GPUTextureDescriptor + carries source data

class GpuTexture2D {
    readonly dimension = '2d' as const;
    width: number;
    height: number;
    format: GPUTextureFormat;
    usage: GPUTextureUsageFlags;
    mipLevelCount: number;
    sampleCount: number;
    
    // CPU data source (like GpuBuffer.array)
    source: Source | null;
    mipmaps: Source[];
    generateMipmaps: boolean;
    
    // Upload options
    flipY: boolean;
    premultiplyAlpha: boolean;
    
    // GPU resource
    gpuTexture: GPUTexture | null = null;
    
    // Dirty tracking (same as GpuBuffer)
    version = 0;
    set needsUpdate(v: boolean) { if (v) this.version++; }
    
    // Lifecycle
    _onDispose: (() => void) | null = null;
    dispose(): void;
}

class GpuTexture2DArray {
    readonly dimension = '2d' as const;
    width: number;
    height: number;
    layers: number;  // depthOrArrayLayers
    format: GPUTextureFormat;
    // ... same fields
    
    // Layer-specific updates (like current ArrayTexture)
    layerUpdates: Set<number>;
}

class GpuTextureCube {
    readonly dimension = '2d' as const;
    size: number;  // width = height
    readonly layers = 6;
    format: GPUTextureFormat;
    
    // 6 face sources
    faces: Source[];
    get isComplete(): boolean;
}

class GpuTextureCubeArray {
    readonly dimension = '2d' as const;
    size: number;
    cubeCount: number;  // layers = cubeCount * 6
    format: GPUTextureFormat;
    // ...
}

class GpuTexture3D {
    readonly dimension = '3d' as const;
    width: number;
    height: number;
    depth: number;
    format: GPUTextureFormat;
    // ...
}
```

**Key insight: Depth is a format property, not a class axis.**

```typescript
// CSM shadow map — just a 2D array with depth format
const shadowMap = new GpuTexture2DArray(2048, 2048, 4, {
    format: 'depth32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});

// Point light shadow — cube with depth format
const pointShadow = new GpuTextureCube(1024, {
    format: 'depth32float',
});
```

### Layer 2: GpuSampler

```typescript
class GpuSampler {
    minFilter: GPUFilterMode = 'linear';
    magFilter: GPUFilterMode = 'linear';
    mipmapFilter: GPUMipmapFilterMode = 'linear';
    addressModeU: GPUAddressMode = 'clamp-to-edge';
    addressModeV: GPUAddressMode = 'clamp-to-edge';
    addressModeW: GPUAddressMode = 'clamp-to-edge';
    maxAnisotropy: number = 1;
    compare?: GPUCompareFunction;  // For comparison samplers
    
    gpuSampler: GPUSampler | null = null;
    
    get settingsKey(): string;
}
```

### Layer 3: Convenience Wrappers (optional)

Thin wrappers for common use cases. Following `GpuBuffer` precedent, these might not even be needed — users can work with `GpuTexture*` directly.

```typescript
// If we keep convenience wrappers:
class Texture {
    readonly gpuTexture: GpuTexture2D;
    readonly sampler: GpuSampler;
    
    constructor(image: SourceData, opts?: TextureOptions) {
        const source = new Source(image);
        this.gpuTexture = new GpuTexture2D(source.width, source.height, {
            source,
            format: opts?.format ?? 'rgba8unorm',
            generateMipmaps: opts?.generateMipmaps ?? true,
        });
        this.sampler = new GpuSampler(opts?.sampler);
    }
}

class VideoTexture {
    readonly gpuTexture: GpuTexture2D;
    readonly sampler: GpuSampler;
    
    update(): void {
        const video = this.gpuTexture.source?.data as HTMLVideoElement;
        if (video?.readyState >= video.HAVE_CURRENT_DATA) {
            this.gpuTexture.needsUpdate = true;
        }
    }
}
```

### How Components Connect

```
User code
    │
    ├─► GpuTexture2D ◄─── TextureBindingNode.value
    │       │
    │       └─► Source (CPU data)
    │
    ├─► GpuSampler ◄───── SamplerNode references
    │
    └─► RenderTarget
            │
            ├─► GpuTexture2D (color)
            ├─► GpuTexture2D (depth format)
            └─► or GpuTexture2DArray (layered)
```

### Renderer Changes

```typescript
// Texture cache keyed by GpuTexture* objects
function updateTexture(cache: TextureCache, device: GPUDevice, tex: GpuTexture2D | GpuTexture2DArray | ...): TextureData {
    // Version check
    // Create GPUTexture if needed (dimension/format/layers known from class)
    // Upload from tex.source
}

// No more isCubeTexture/isArrayTexture branching in createGPUTexture
// Each GpuTexture* class knows its own GPU dimension
```

### Node System Changes

```typescript
// TextureBindingNode.value becomes a GpuTexture*
type GpuTextureFor<D extends AnyTextureDesc> =
    D extends texture2d ? GpuTexture2D
    : D extends texture2dArray ? GpuTexture2DArray
    : D extends textureCube ? GpuTextureCube
    : D extends texture3d ? GpuTexture3D
    : // ... etc
    : GpuTexture2D;

class TextureBindingNode<D extends AnyTextureDesc> extends Node<D> {
    value: GpuTextureFor<D> | null = null;
}

// SamplerNode wraps or references a GpuSampler
class SamplerNode<D extends SamplerDesc | SamplerComparisonDesc> extends Node<D> {
    sampler: GpuSampler;  // Settings live here
    resource: GPUSampler | null = null;  // GPU resource
}
```

### Migration: What Goes Away

| Current Class | Replacement |
|---------------|-------------|
| `Texture` | `GpuTexture2D` + `GpuSampler` |
| `DataTexture` | `GpuTexture2D` with typed array in Source |
| `DepthTexture` | `GpuTexture2D` with depth format |
| `ArrayTexture` | `GpuTexture2DArray` |
| `Data3DTexture` | `GpuTexture3D` |
| `CubeTexture` | `GpuTextureCube` |
| `VideoTexture` | thin wrapper or direct `GpuTexture2D` use |
| `CanvasTexture` | direct `GpuTexture2D` use |

### Benefits

1. **No combinatorial explosion** — depth is format, not class
2. **WebGPU-aligned** — classes match GPU texture dimensions
3. **Renderer simplification** — each class knows its dimension
4. **RenderTarget composition is natural** — owns `GpuTexture*` directly
5. **Consistent with GpuBuffer** — same pattern for both resource types

### Open Questions

1. **Should convenience wrappers exist?** `GpuBuffer` doesn't have them — users work with it directly. Same for textures?

2. **How to handle `isRenderTargetTexture`?** Currently a flag on `Texture`. Could be:
   - A flag on `GpuTexture*` (simple)
   - Inferred from usage flags having `RENDER_ATTACHMENT`
   - RenderTarget tracks its own textures

3. **Source ownership** — `GpuTexture*` owns the Source, or shares it? GpuBuffer owns its array.

---

## Comparison: How Other Engines Handle This

### wgpu (Rust)
- **Single `Texture` struct** — just wraps `TextureDescriptor` (dimension, size, format, usage, etc.)
- **Single `Sampler` struct** — wraps `SamplerDescriptor` (address modes, filters, compare function)
- **No class hierarchy by dimension** — dimension is a field (`D1`, `D2`, `D3`)
- **Depth is format, not class** — `depth32float`, `depth24plus-stencil8`, etc.
- **Confirms**: Texture and Sampler are completely separate concerns

### MaterialX
- **`Image` class** — CPU data container with `resourceId` for GPU handle reference
- **`ImageSamplingProperties`** — separate struct for sampler settings (filter, address modes)
- **`ImageHandler`** — manages binding, uploading, caching
- **Confirms**: Clear separation of data, sampling, and GPU resource management

### OpenImageIO
- **`TextureOpt`** — sampling options (wrap mode, filter, mip mode, anisotropy)
- **Texture system manages caching** — separate from per-sample options
- **Confirms**: Sampling parameters are a separate concern from texture data

### Babylon.js
**Architecture (3 layers):**
1. **`InternalTexture`** — GPU resource handle, extends `TextureSampler`
   - Owns the actual GPU texture (`_hardwareTexture`)
   - Dimension info via flags: `isCube`, `is3D`, `is2DArray`
   - Source type enum: `Url`, `Raw`, `Cube`, `Raw3D`, `Raw2DArray`, `DepthStencil`, etc.
   - Reference counted (`_references`)

2. **`TextureSampler`** — sampling parameters (base class for `InternalTexture`)
   - `wrapU`, `wrapV`, `wrapR` (address modes)
   - `samplingMode` (combined min/mag/mip filter)
   - `anisotropicFilteringLevel`
   - `comparisonFunction` (for shadow mapping)
   - `compareSampler()` for equality checks

3. **`BaseTexture` / `Texture`** — user-facing API
   - References an `InternalTexture` via `_texture` field
   - Higher-level features: UV transforms, gamma space, animations
   - Many subclasses: `CubeTexture`, `RawTexture`, `RawTexture2DArray`, `RawTexture3D`, etc.

**Key insights from Babylon:**
- They embed sampler in `InternalTexture` (texture owns its sampler) — we're going the opposite way (separate `GpuSampler`)
- Dimension is determined by flags (`isCube`, `is3D`, `is2DArray`) not class hierarchy at GPU level
- They have many user-facing subclasses but one GPU resource class
- `InternalTextureSource` enum tracks data origin, not GPU dimension
- Depth textures are `source: DepthStencil` or `source: Depth`, not a separate class at GPU level

**Babylon's approach differs from ours:**
- Babylon: Many convenience classes → single `InternalTexture` with flags
- gpucat proposed: Separate `GpuTexture*` classes per GPU dimension (cleaner WebGPU mapping)

Both approaches work, but our proposed approach:
1. Makes dimension explicit in the type (better for TypeScript inference)
2. Avoids runtime flag checks (each class knows its own `createView()` logic)
3. More directly maps to WebGPU's `GPUTextureDescriptor.dimension`

### PlayCanvas
**Architecture:**
- **Single `Texture` class** — handles all texture types via constructor options
- **No separate Sampler class** — sampling parameters live on the Texture itself
- **Dimension via flags:** `cubemap`, `volume`, `array` booleans + `arrayLength` number
- **WebGPU impl (`WebgpuTexture`)** creates `GPUSampler` on-demand in `getSampler()`

**Key fields on Texture:**
```javascript
// Dimension/structure
_cubemap: boolean
_volume: boolean  
_arrayLength: number  // > 0 means 2D array
_width, _height, _depth: number

// Sampling (embedded, not separate)
_minFilter, _magFilter: FilterMode
_addressU, _addressV, _addressW: AddressMode
_anisotropy: number
_compareOnRead: boolean  // for depth/shadow
_compareFunc: CompareFunction
```

**WebGPU sampler creation:**
```javascript
// Samplers created lazily, cached by sample type
getSampler(device, sampleType) {
    let sampler = this.samplers[sampleType];
    if (!sampler) {
        const desc = {
            addressModeU: gpuAddressModes[texture.addressU],
            addressModeV: gpuAddressModes[texture.addressV],
            // ... filter modes based on sampleType
        };
        sampler = device.wgpu.createSampler(desc);
        this.samplers[sampleType] = sampler;
    }
    return sampler;
}
```

**Key insights from PlayCanvas:**
- Simpler than Babylon — no `InternalTexture` separation, just one `Texture` class
- Sampling params embedded on texture (like three.js) — but creates separate `GPUSampler` for WebGPU
- Uses boolean flags for dimension, not class hierarchy
- `compareOnRead` + `compareFunc` for shadow/depth comparison sampling
- Static factory: `Texture.createDataTexture2D()` for common cases

**PlayCanvas differs from our proposal:**
- PlayCanvas: Single class + flags — simpler but less type-safe
- gpucat: Separate classes per dimension — more verbose but better TypeScript inference

---

## Summary of Research

All engines confirm:
1. **Texture and Sampler should be separate at GPU level** — even PlayCanvas/Babylon (which embed sampler params on texture) create separate `GPUSampler` objects
2. **Depth is a format, not a class axis** — no engine has `DepthCubeTexture`, `Depth2DArrayTexture`, etc.
3. **Comparison sampling is a sampler concern** — `compareOnRead`/`compareFunc` (PlayCanvas), `comparisonFunction` (Babylon)
4. **Single class vs class hierarchy is a design choice** — both work; we choose class hierarchy for TypeScript benefits

### Comparison Table

| Engine | Texture Classes | Sampler | Dimension |
|--------|----------------|---------|-----------|
| wgpu | Single `Texture` | Separate `Sampler` | Field |
| Babylon | Many user-facing → single `InternalTexture` | Embedded (`TextureSampler` base) | Flags |
| PlayCanvas | Single `Texture` | Embedded (lazy `GPUSampler`) | Flags |
| **gpucat (proposed)** | `GpuTexture*` per dimension | Separate `GpuSampler` | Class |

Our proposed model:
- `GpuTexture*` classes = typed by dimension (unlike others)
- `GpuSampler` class = explicit separation (like wgpu, cleaner than embedded)
- No convenience wrappers initially (like `GpuBuffer`)
