# Plan: TSL Texture Functions (Phase 2)

## Overview

This document outlines the TSL (Three Shading Language) texture functions that Three.js provides but gpucat currently lacks. After implementing Phase 1 (mipmap generation and anisotropic filtering), these functions will provide feature parity with Three.js for texture operations.

## Current gpucat Texture Functions

gpucat currently has these texture-related functions in `src/nodes/lib/texture.ts`:

```typescript
// Current exports
export class TextureNode extends Node<d.vec4f> { ... }
export class SamplerNode<D> extends Node<D> { ... }
export const texture = (tex: Texture, textureDesc?) => TextureNode;
export const textureSample = (t, s, uv) => CallNode;  // Raw WGSL call
export const textureLoad = (t, coord, level) => CallNode;  // Raw WGSL call
export const textureSampleLevel = (t, s, uv, level) => CallNode;  // Raw WGSL call
```

## Missing TSL Texture Functions

### Priority 1: Core TextureNode Methods

These methods should be added to `TextureNode` class to align with Three.js:

| Three.js Method | WGSL Function | Description |
|-----------------|---------------|-------------|
| `.level(levelNode)` | `textureSampleLevel` | Sample at specific mip level |
| `.bias(biasNode)` | `textureSampleBias` | Sample with LOD bias |
| `.sample(uvNode)` | `textureSample` | Sample at different UVs (already exists) |
| `.load(uvNode)` | `textureLoad` | Fetch texel without interpolation |
| `.compare(compareNode)` | `textureSampleCompare` | Shadow map comparison |
| `.grad(gradX, gradY)` | `textureSampleGrad` | Sample with explicit gradients |
| `.depth(depthNode)` | - | Select layer from array texture |
| `.offset(offsetNode)` | `textureSampleOffset` | Sample with texel offset |
| `.size(levelNode)` | `textureDimensions` | Get texture dimensions |
| `.blur(amount)` | - | Convenience for `.bias(amount * maxMipLevel)` |

### Priority 2: Specialized Texture Nodes

**CubeTextureNode** (`src/nodes/lib/cube-texture.ts`)
```typescript
export class CubeTextureNode extends TextureNode {
  isCubeTextureNode = true;
  // Uses vec3 UVs (reflection/refraction vectors)
  // Default UV is reflectVector or refractVector based on mapping
}

export const cubeTexture = (value, uvNode?, levelNode?, biasNode?) => CubeTextureNode;
export const uniformCubeTexture = (value) => CubeTextureNode;
```

**Texture3DNode** (`src/nodes/lib/texture-3d.ts`)
```typescript
export class Texture3DNode extends TextureNode {
  isTexture3DNode = true;
  // Uses vec3 UVs
  // Generates texture_3d<f32> binding
}

export const texture3D = (value, uvNode?, levelNode?) => Texture3DNode;
export const texture3DLoad = (...params) => texture3D(...params).setSampler(false);
export const texture3DLevel = (value, uv, level) => texture3D(value, uv).level(level);
```

**StorageTextureNode** (`src/nodes/lib/storage-texture.ts`)
```typescript
export class StorageTextureNode extends TextureNode {
  isStorageTextureNode = true;
  storeNode: Node<d.vec4f> | null;
  access: 'read' | 'write' | 'read_write';
}

export const storageTexture = (value, uvNode, storeNode?) => StorageTextureNode;
export const textureStore = (value, uvNode, storeNode) => StorageTextureNode;
```

### Priority 3: Texture Utility Nodes

**TextureSizeNode** (`src/nodes/lib/texture-size.ts`)
```typescript
export class TextureSizeNode extends Node<d.uvec2> {
  textureNode: TextureNode;
  levelNode: Node<d.i32> | null;
}

// Generates: textureDimensions(texture, level)
export const textureSize = (textureNode, levelNode?) => TextureSizeNode;
```

**MaxMipLevelNode** (`src/nodes/lib/max-mip-level.ts`)
```typescript
export class MaxMipLevelNode extends UniformNode<d.f32> {
  textureNode: TextureNode;
  // Computes: Math.log2(Math.max(width, height))
  // Updates per frame
}

export const maxMipLevel = (textureNode) => MaxMipLevelNode;
```

### Priority 4: Advanced Texture Functions

**textureBicubic** (TSL function, not node)
```typescript
// Mipped Bicubic Texture Filtering (Shadertoy: N8)
// Uses multiple texture samples with cubic interpolation
export const textureBicubic = Fn(([textureNode, strength]) => { ... });
export const textureBicubicLevel = Fn(([textureNode, lodNode]) => { ... });
```

**triplanarTexture** (TSL function)
```typescript
// Triplanar texture projection for seamless texturing on arbitrary geometry
export const triplanarTextures = Fn(([texX, texY, texZ, scale, position, normal]) => { ... });
export const triplanarTexture = (...params) => triplanarTextures(...params);
```

---

## Implementation Details

### TextureNode Extensions

Modify `src/nodes/lib/texture.ts`:

```typescript
export class TextureNode extends Node<d.vec4f> {
  // ... existing properties ...
  
  /** Explicit mip level (null = auto via derivatives) */
  levelNode: Node<d.f32> | null = null;
  
  /** Bias to add to auto-computed mip level */
  biasNode: Node<d.f32> | null = null;
  
  /** Reference value for shadow comparison */
  compareNode: Node<d.f32> | null = null;
  
  /** Explicit gradients for mip selection */
  gradNode: [Node<d.vec2f>, Node<d.vec2f>] | null = null;
  
  /** Layer index for array textures */
  depthNode: Node<d.i32> | null = null;
  
  /** Texel offset applied before sampling */
  offsetNode: Node<d.ivec2> | null = null;
  
  /** Whether to use sampler (true) or direct load (false) */
  sampler: boolean = true;
  
  // Methods
  
  level(levelNode: Node<d.f32>): TextureNode {
    const cloned = this.clone();
    cloned.levelNode = levelNode;
    cloned.referenceNode = this.getBase();
    return cloned;
  }
  
  bias(biasNode: Node<d.f32>): TextureNode {
    const cloned = this.clone();
    cloned.biasNode = biasNode;
    cloned.referenceNode = this.getBase();
    return cloned;
  }
  
  blur(amountNode: Node<d.f32>): TextureNode {
    // amount * maxMipLevel = bias
    return this.bias(mul(amountNode, maxMipLevel(this)));
  }
  
  compare(compareNode: Node<d.f32>): TextureNode {
    const cloned = this.clone();
    cloned.compareNode = compareNode;
    cloned.referenceNode = this.getBase();
    return cloned;
  }
  
  grad(gradX: Node<d.vec2f>, gradY: Node<d.vec2f>): TextureNode {
    const cloned = this.clone();
    cloned.gradNode = [gradX, gradY];
    cloned.referenceNode = this.getBase();
    return cloned;
  }
  
  depth(depthNode: Node<d.i32>): TextureNode {
    const cloned = this.clone();
    cloned.depthNode = depthNode;
    cloned.referenceNode = this.getBase();
    return cloned;
  }
  
  offset(offsetNode: Node<d.ivec2>): TextureNode {
    const cloned = this.clone();
    cloned.offsetNode = offsetNode;
    cloned.referenceNode = this.getBase();
    return cloned;
  }
  
  load(uvNode: Node<d.vec2i>): TextureNode {
    return this.sample(uvNode).setSampler(false);
  }
  
  setSampler(value: boolean): TextureNode {
    const cloned = this.clone();
    cloned.sampler = value;
    cloned.referenceNode = this.getBase();
    return cloned;
  }
  
  size(levelNode?: Node<d.i32>): TextureSizeNode {
    return textureSize(this, levelNode);
  }
}
```

### Builder Updates

Modify `src/nodes/builder.ts` to handle new TextureNode properties:

```typescript
function generateTextureSampleExpr(
  ctx: Context,
  textureNode: TextureNode,
  texVar: string,
  sampVar: string,
  uvExpr: string
): string {
  const { levelNode, biasNode, compareNode, gradNode, depthNode, offsetNode, sampler } = textureNode;
  
  // Build optional snippets
  const levelExpr = levelNode ? build(levelNode, ctx) : null;
  const biasExpr = biasNode ? build(biasNode, ctx) : null;
  const compareExpr = compareNode ? build(compareNode, ctx) : null;
  const depthExpr = depthNode ? build(depthNode, ctx) : null;
  const offsetExpr = offsetNode ? build(offsetNode, ctx) : null;
  const gradExprs = gradNode 
    ? [build(gradNode[0], ctx), build(gradNode[1], ctx)] 
    : null;
  
  // Generate appropriate WGSL call
  if (!sampler) {
    // textureLoad(texture, coord, level)
    return `textureLoad(${texVar}, ${uvExpr}, ${levelExpr ?? '0'})`;
  }
  
  if (compareExpr) {
    // textureSampleCompare(depthTex, sampler, uv, compareRef)
    return `textureSampleCompare(${texVar}, ${sampVar}, ${uvExpr}, ${compareExpr})`;
  }
  
  if (gradExprs) {
    // textureSampleGrad(tex, sampler, uv, ddx, ddy)
    return `textureSampleGrad(${texVar}, ${sampVar}, ${uvExpr}, ${gradExprs[0]}, ${gradExprs[1]})`;
  }
  
  if (biasExpr) {
    // textureSampleBias(tex, sampler, uv, bias)
    return `textureSampleBias(${texVar}, ${sampVar}, ${uvExpr}, ${biasExpr})`;
  }
  
  if (levelExpr) {
    // textureSampleLevel(tex, sampler, uv, level)
    return `textureSampleLevel(${texVar}, ${sampVar}, ${uvExpr}, ${levelExpr})`;
  }
  
  // Default: textureSample(tex, sampler, uv)
  return `textureSample(${texVar}, ${sampVar}, ${uvExpr})`;
}
```

---

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `src/nodes/lib/texture.ts` | **Modify** | Add methods: level, bias, blur, compare, grad, depth, offset, load, size |
| `src/nodes/lib/cube-texture.ts` | **Create** | CubeTextureNode class and cubeTexture function |
| `src/nodes/lib/texture-3d.ts` | **Create** | Texture3DNode class and texture3D function |
| `src/nodes/lib/storage-texture.ts` | **Create** | StorageTextureNode class and textureStore function |
| `src/nodes/lib/texture-size.ts` | **Create** | TextureSizeNode class and textureSize function |
| `src/nodes/lib/max-mip-level.ts` | **Create** | MaxMipLevelNode class and maxMipLevel function |
| `src/nodes/lib/texture-bicubic.ts` | **Create** | textureBicubic and textureBicubicLevel TSL functions |
| `src/nodes/lib/triplanar.ts` | **Create** | triplanarTextures and triplanarTexture TSL functions |
| `src/nodes/builder.ts` | **Modify** | Update texture expression generation for new features |
| `src/texture/cube-texture.ts` | **Create** | CubeTexture class (Phase 1) |
| `src/texture/array-texture.ts` | **Create** | ArrayTexture class (Phase 1) |
| `src/texture/texture-3d.ts` | **Create** | Texture3D class (Phase 1) |
| `src/index.ts` | **Modify** | Export new nodes and texture classes |

---

## WGSL Texture Functions Reference

| WGSL Function | Usage | Notes |
|---------------|-------|-------|
| `textureSample(t, s, uv)` | 2D texture sampling | Requires fragment shader (uses derivatives) |
| `textureSampleLevel(t, s, uv, level)` | Explicit LOD | Works in any shader stage |
| `textureSampleBias(t, s, uv, bias)` | LOD with bias | Fragment only |
| `textureSampleGrad(t, s, uv, ddx, ddy)` | Explicit gradients | Works in any shader stage |
| `textureSampleCompare(t, s, uv, ref)` | Depth comparison | Shadow mapping |
| `textureLoad(t, coord, level)` | Direct texel fetch | No interpolation, integer coords |
| `textureStore(t, coord, value)` | Write to storage | Compute only |
| `textureDimensions(t, level)` | Get size | Returns uvec2 or uvec3 |
| `textureNumLevels(t)` | Mip count | Returns u32 |
| `textureNumLayers(t)` | Array layers | Returns u32 |

---

## Three.js Alignment Reference

| Three.js File | gpucat Equivalent |
|---------------|-------------------|
| `TextureNode.js` | `texture.ts` |
| `CubeTextureNode.js` | `cube-texture.ts` (new) |
| `Texture3DNode.js` | `texture-3d.ts` (new) |
| `StorageTextureNode.js` | `storage-texture.ts` (new) |
| `TextureSizeNode.js` | `texture-size.ts` (new) |
| `MaxMipLevelNode.js` | `max-mip-level.ts` (new) |
| `TextureBicubic.js` | `texture-bicubic.ts` (new) |
| `TriplanarTextures.js` | `triplanar.ts` (new) |

---

## Dependencies

This phase depends on **Phase 1** (mipmap generation) being complete, specifically:
- `CubeTexture` class must exist for `CubeTextureNode`
- `ArrayTexture` class must exist for `.depth()` method
- `Texture3D` class must exist for `Texture3DNode`
- Mipmap generation must work for `.blur()` and `maxMipLevel` to be useful

---

## Testing Strategy

1. **TextureNode methods**: Test each method produces correct WGSL output
2. **CubeTextureNode**: Render skybox with cubemap
3. **Texture3DNode**: Volume rendering or 3D LUT
4. **StorageTextureNode**: Compute shader writing to texture
5. **textureSize/maxMipLevel**: Verify runtime values match texture dimensions
6. **textureBicubic**: Visual quality comparison with standard sampling
