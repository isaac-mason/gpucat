# Plan: Mipmap Generation and Anisotropic Filtering

## Overview

This plan aligns gpucat's mipmap and anisotropic filtering implementation with Three.js's WebGPURenderer approach. The current gpucat codebase already has the **data structures** in place (`texture.generateMipmaps`, `texture.anisotropy`, `texture.mipmapFilter`) but lacks the actual **mipmap generation** implementation.

## Current State Analysis

### What gpucat already has:
- `Texture.generateMipmaps: boolean = true` (src/texture/texture.ts:92)
- `Texture.anisotropy: number = 1` (src/texture/texture.ts:80)
- `Texture.mipmapFilter: MipmapFilterMode` (src/texture/texture.ts:74)
- `mipLevelCount` calculation in `createGPUTexture()` (src/renderer/textures.ts:180-182)
- `GPUTextureUsage.RENDER_ATTACHMENT` flag already set for mipmap generation (src/renderer/textures.ts:190)
- Sampler creation with `maxAnisotropy` parameter (src/renderer/textures.ts:355)

### What's missing:
1. **Mipmap generation render pass** - The actual GPU-based mipmap generation (see TODO at textures.ts:238-239)
2. **Anisotropic filtering validation** - WebGPU requires all filter modes to be `linear` for anisotropy > 1
3. **User-provided mipmap upload** - Support for `texture.mipmaps[]` array
4. **Texture node mip level sampling** - `textureSampleLevel()` and `.level()` method on TextureNode
5. **Additional texture types** - CubeTexture, ArrayTexture, 3DTexture for full mipmap support

---

## Phase 1: Mipmap Generation Pass Utility

### New file: `src/renderer/mipmap-utils.ts`

Create a standalone mipmap generation utility aligned with Three.js's `WebGPUTexturePassUtils.js`:

```typescript
export type MipmapUtilsState = {
  device: GPUDevice;
  sampler: GPUSampler;
  pipelines: Map<string, GPURenderPipeline>;  // keyed by "format-dimension"
  shaderModule: GPUShaderModule;
  noFlipBuffer: GPUBuffer;
};

export function createMipmapUtils(device: GPUDevice): MipmapUtilsState;
export function generateMipmaps(state: MipmapUtilsState, texture: GPUTexture, encoder?: GPUCommandEncoder): void;
```

**Design decisions (aligned with Three.js):**
- Use render passes (not compute) for mipmap generation - same as Three.js
- Cache render pipelines per format + dimension (e.g., `rgba8unorm-2d`, `rgba8unorm-cube`)
- Support optional encoder parameter to batch with other operations
- Use render bundles for repeated mipmap generation (Three.js optimization pattern)

**WGSL Shader** (adapted from Three.js `WebGPUTexturePassUtils.js:27-101`):

```wgsl
struct Varys {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat, either) layer: u32,
};

@group(0) @binding(0) var imgSampler: sampler;
@group(0) @binding(1) var img2d: texture_2d<f32>;
@group(0) @binding(2) var<uniform> flipY: u32;

@vertex
fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Varys {
  var pos = array(vec2f(-1, -1), vec2f(-1, 3), vec2f(3, -1));
  let p = pos[vi];
  let mult = select(vec2f(0.5, -0.5), vec2f(0.5, 0.5), flipY != 0);
  
  var out: Varys;
  out.position = vec4f(p, 0, 1);
  out.uv = p * mult + vec2f(0.5);
  out.layer = ii;
  return out;
}

@fragment
fn fs_2d(v: Varys) -> @location(0) vec4f {
  return textureSample(img2d, imgSampler, v.uv);
}

// 2D array variant
@group(0) @binding(1) var img2dArray: texture_2d_array<f32>;

@fragment
fn fs_2d_array(v: Varys) -> @location(0) vec4f {
  return textureSample(img2dArray, imgSampler, v.uv, v.layer);
}

// Cube variant
const faceMat = array(
  mat3x3f( 0,  0, -2,  0, -2,  0,  1,  1,  1),  // +X
  mat3x3f( 0,  0,  2,  0, -2,  0, -1,  1, -1),  // -X
  mat3x3f( 2,  0,  0,  0,  0,  2, -1,  1, -1),  // +Y
  mat3x3f( 2,  0,  0,  0,  0, -2, -1, -1,  1),  // -Y
  mat3x3f( 2,  0,  0,  0, -2,  0, -1,  1,  1),  // +Z
  mat3x3f(-2,  0,  0,  0, -2,  0,  1,  1, -1),  // -Z
);

@group(0) @binding(1) var imgCube: texture_cube<f32>;

@fragment
fn fs_cube(v: Varys) -> @location(0) vec4f {
  return textureSample(imgCube, imgSampler, faceMat[v.layer] * vec3f(fract(v.uv), 1));
}
```

**Mipmap generation algorithm:**
```typescript
function generateMipmaps(state, textureGPU, encoder?) {
  const ownEncoder = !encoder;
  encoder = encoder ?? state.device.createCommandEncoder();
  
  const pipeline = getPipeline(state, textureGPU.format, getDimension(textureGPU));
  
  for (let mipLevel = 1; mipLevel < textureGPU.mipLevelCount; mipLevel++) {
    for (let layer = 0; layer < textureGPU.depthOrArrayLayers; layer++) {
      // Create bind group sampling from mipLevel-1
      const bindGroup = state.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: state.sampler },
          { binding: 1, resource: textureGPU.createView({
            dimension: getDimension(textureGPU),
            baseMipLevel: mipLevel - 1,
            mipLevelCount: 1,
          })},
          { binding: 2, resource: { buffer: state.noFlipBuffer } },
        ],
      });
      
      // Render pass targeting mipLevel
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: textureGPU.createView({
            dimension: '2d',
            baseMipLevel: mipLevel,
            mipLevelCount: 1,
            baseArrayLayer: layer,
            arrayLayerCount: 1,
          }),
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3, 1, 0, layer);
      pass.end();
    }
  }
  
  if (ownEncoder) {
    state.device.queue.submit([encoder.finish()]);
  }
}
```

---

## Phase 2: Additional Texture Types

### New file: `src/texture/cube-texture.ts`

```typescript
import { Texture } from './texture';
import { Source } from './source';

export class CubeTexture extends Texture {
  readonly isCubeTexture = true;
  
  /** Array of 6 images for cube faces: +X, -X, +Y, -Y, +Z, -Z */
  images: Source[] = [];
  
  constructor(images?: Source[]) {
    super(null);
    if (images) {
      this.images = images;
    }
  }
}
```

### New file: `src/texture/array-texture.ts`

```typescript
import { Texture } from './texture';

export class ArrayTexture extends Texture {
  readonly isArrayTexture = true;
  
  /** Number of layers in the texture array */
  depth: number = 1;
  
  /** Track which layers need updating (optimization for partial updates) */
  layerUpdates: Set<number> = new Set();
  
  constructor(width: number, height: number, depth: number) {
    super(null);
    this.source.width = width;
    this.source.height = height;
    this.depth = depth;
  }
  
  clearLayerUpdates(): void {
    this.layerUpdates.clear();
  }
}
```

### New file: `src/texture/texture-3d.ts`

```typescript
import { Texture } from './texture';

export class Texture3D extends Texture {
  readonly is3DTexture = true;
  
  /** Depth of the 3D texture */
  depth: number = 1;
  
  constructor(width: number, height: number, depth: number) {
    super(null);
    this.source.width = width;
    this.source.height = height;
    this.depth = depth;
  }
}
```

---

## Phase 3: Integrate Mipmap Generation into Texture Upload

### Modify: `src/renderer/textures.ts`

1. **Add MipmapUtilsState to TextureCache:**

```typescript
export type TextureCache = {
  textureMap: WeakMap<Texture, TextureData>;
  samplerCache: Map<string, SamplerData>;
  defaultTextures: Map<GPUTextureFormat, GPUTexture>;
  mipmapUtils: MipmapUtilsState | null;  // Lazy-initialized
  textureCount: number;
  samplerCount: number;
};
```

2. **Update `uploadTextureData()` to call mipmap generation:**

```typescript
function uploadTextureData(device, texture, data, cache): void {
  const image = texture.image;
  if (!image) return;
  
  // Handle user-provided mipmaps first
  if (texture.mipmaps.length > 0) {
    for (let i = 0; i < texture.mipmaps.length; i++) {
      uploadMipLevel(device, data.texture, texture.mipmaps[i], i + 1);
    }
    return; // Don't auto-generate if user provided mipmaps
  }
  
  // Upload base level (existing code)
  // ... existing upload code ...
  
  // Generate mipmaps if needed
  if (texture.generateMipmaps && data.texture.mipLevelCount > 1) {
    if (!cache.mipmapUtils) {
      cache.mipmapUtils = createMipmapUtils(device);
    }
    generateMipmaps(cache.mipmapUtils, data.texture);
  }
}
```

3. **Support different texture types in `createGPUTexture()`:**

```typescript
function createGPUTexture(device, texture): GPUTexture {
  const width = texture.width;
  const height = texture.height;
  const format = texture.format ?? 'rgba8unorm';
  
  // Determine dimensions and depth
  let dimension: GPUTextureDimension = '2d';
  let depthOrArrayLayers = 1;
  
  if ('isCubeTexture' in texture && texture.isCubeTexture) {
    depthOrArrayLayers = 6;
  } else if ('isArrayTexture' in texture && texture.isArrayTexture) {
    depthOrArrayLayers = texture.depth;
  } else if ('is3DTexture' in texture && texture.is3DTexture) {
    dimension = '3d';
    depthOrArrayLayers = texture.depth;
  }
  
  const mipLevelCount = texture.generateMipmaps
    ? Math.floor(Math.log2(Math.max(width, height))) + 1
    : 1;
  
  return device.createTexture({
    size: [width, height, depthOrArrayLayers],
    format,
    dimension,
    usage: GPUTextureUsage.TEXTURE_BINDING | 
           GPUTextureUsage.COPY_DST | 
           GPUTextureUsage.RENDER_ATTACHMENT,
    mipLevelCount,
  });
}
```

---

## Phase 4: Anisotropic Filtering Validation

### Modify: `src/renderer/textures.ts` - `getSampler()`

Align with Three.js validation logic (WebGPUTextureUtils.js:137-143):

```typescript
export function getSampler(cache, device, texture): GPUSampler {
  const key = computeSamplerKey(texture);
  
  let data = cache.samplerCache.get(key);
  if (data) {
    data.usedTimes++;
    return data.sampler;
  }
  
  // WebGPU constraint: anisotropy requires all filters to be linear
  let maxAnisotropy = 1;
  if (
    texture.magFilter === 'linear' &&
    texture.minFilter === 'linear' &&
    texture.mipmapFilter === 'linear'
  ) {
    maxAnisotropy = texture.anisotropy;
  }
  
  // Depth textures without compare function must use nearest filtering
  let magFilter = texture.magFilter;
  let minFilter = texture.minFilter;
  let mipmapFilter = texture.mipmapFilter;
  
  if (texture.isDepthTexture && !texture.compareFunction) {
    magFilter = 'nearest';
    minFilter = 'nearest';
    mipmapFilter = 'nearest';
    maxAnisotropy = 1;
  }
  
  const sampler = device.createSampler({
    magFilter,
    minFilter,
    mipmapFilter,
    addressModeU: texture.wrapS,
    addressModeV: texture.wrapT,
    maxAnisotropy,
  });
  
  cache.samplerCache.set(key, { sampler, usedTimes: 1 });
  cache.samplerCount++;
  
  return sampler;
}
```

---

## Phase 5: TextureNode LOD/Level Sampling

### Modify: `src/nodes/lib/texture.ts`

Add methods for explicit mip level sampling (aligned with Three.js TextureNode):

```typescript
export class TextureNode extends Node<d.vec4f> {
  // ... existing properties ...
  
  /** Explicit mip level node (null = auto via derivatives) */
  levelNode: Node<d.f32> | null = null;
  
  /** Bias to add to auto-computed mip level */
  biasNode: Node<d.f32> | null = null;
  
  /** Sample at a specific mip level (uses textureSampleLevel) */
  level(levelNode: Node<d.f32>): TextureNode {
    const cloned = this.clone();
    cloned.levelNode = levelNode;
    cloned.biasNode = null; // level takes precedence
    cloned.referenceNode = this.getBase();
    return cloned;
  }
  
  /** Sample with bias added to auto-computed mip level (uses textureSampleBias) */
  bias(biasNode: Node<d.f32>): TextureNode {
    const cloned = this.clone();
    cloned.biasNode = biasNode;
    cloned.levelNode = null; // bias is different from level
    cloned.referenceNode = this.getBase();
    return cloned;
  }
  
  clone(): TextureNode {
    const cloned = new TextureNode(this.textureType, this.textureId, this.uvNode, this.groupNode);
    cloned.value = this.value;
    cloned.resource = this.resource;
    cloned.gpuSampler = this.gpuSampler;
    cloned.referenceNode = this.referenceNode;
    cloned.levelNode = this.levelNode;
    cloned.biasNode = this.biasNode;
    return cloned;
  }
}
```

### Modify: `src/nodes/builder.ts`

Update TextureNode code generation to emit appropriate WGSL:

```typescript
// When building texture sample expression:
function buildTextureSampleExpr(textureNode, texVar, sampVar, uvExpr, builder): string {
  if (textureNode.levelNode) {
    const levelExpr = builder.build(textureNode.levelNode);
    return `textureSampleLevel(${texVar}, ${sampVar}, ${uvExpr}, ${levelExpr})`;
  } else if (textureNode.biasNode) {
    const biasExpr = builder.build(textureNode.biasNode);
    return `textureSampleBias(${texVar}, ${sampVar}, ${uvExpr}, ${biasExpr})`;
  } else {
    return `textureSample(${texVar}, ${sampVar}, ${uvExpr})`;
  }
}
```

---

## Phase 6: Expose Renderer API

### Modify: `src/renderer/renderer.ts`

Add public API for manual mipmap generation:

```typescript
export class WebGPURenderer {
  // ... existing code ...
  
  /**
   * Manually generate mipmaps for a texture.
   * Normally called automatically during texture upload when texture.generateMipmaps=true.
   * 
   * @param texture - The texture to generate mipmaps for
   */
  generateMipmaps(texture: Texture): void {
    if (!this._initialized) {
      throw new Error('[WebGPURenderer] generateMipmaps() called before init()');
    }
    
    const texData = textures.updateTexture(this._textures, this._device, texture);
    
    if (!this._textures.mipmapUtils) {
      this._textures.mipmapUtils = mipmapUtils.createMipmapUtils(this._device);
    }
    
    mipmapUtils.generateMipmaps(this._textures.mipmapUtils, texData.texture);
  }
}
```

---

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `src/renderer/mipmap-utils.ts` | **Create** | Mipmap generation pipeline, shader, and caching |
| `src/texture/cube-texture.ts` | **Create** | CubeTexture class for cubemap support |
| `src/texture/array-texture.ts` | **Create** | ArrayTexture class for texture arrays |
| `src/texture/texture-3d.ts` | **Create** | Texture3D class for 3D textures |
| `src/renderer/textures.ts` | **Modify** | Integrate mipmap generation, fix anisotropy validation |
| `src/nodes/lib/texture.ts` | **Modify** | Add `.level()` and `.bias()` methods |
| `src/nodes/builder.ts` | **Modify** | Generate `textureSampleLevel`/`textureSampleBias` WGSL |
| `src/renderer/renderer.ts` | **Modify** | Add `generateMipmaps()` public API |
| `src/index.ts` | **Modify** | Export new texture classes |

---

## Three.js Alignment Reference

| Three.js File | gpucat Equivalent | Alignment Notes |
|---------------|-------------------|-----------------|
| `WebGPUTexturePassUtils.js` | `mipmap-utils.ts` | Same render-pass approach, same shader pattern |
| `WebGPUTextureUtils.js:137-143` | `textures.ts:getSampler()` | Anisotropy validation |
| `WebGPUTextureUtils.js:370-376` | `textures.ts:uploadTextureData()` | generateMipmaps call site |
| `TextureNode.js:689-695` | `texture.ts:level()` | LOD sampling API |
| `CubeTexture.js` | `cube-texture.ts` | Cubemap texture class |
| `DataArrayTexture.js` | `array-texture.ts` | Texture array class |
| `Data3DTexture.js` | `texture-3d.ts` | 3D texture class |

---

## Testing Strategy

1. **Unit test**: Create texture with `generateMipmaps=true`, verify GPU texture has correct `mipLevelCount`
2. **Visual test**: Render textured plane at various distances, verify smooth LOD transitions
3. **Anisotropy test**: Render floor plane at oblique angle, compare `anisotropy=1` vs `anisotropy=16`
4. **Cube texture test**: Render skybox with mipmapped cube texture
5. **Edge cases**: 
   - Non-power-of-2 textures
   - Float textures (rgba16float, rgba32float) - may not support filtering
   - Video textures (`generateMipmaps=false` by default)
   - Formats that don't support `RENDER_ATTACHMENT` (warn and skip, like Three.js)
