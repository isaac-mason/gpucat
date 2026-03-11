# Texture System Phase 2: DSL Methods & Multi-Texture Types

## Overview

Phase 1 (completed) added mipmap generation and anisotropic filtering. Phase 2 extends the texture system with:
1. New DSL methods for texture sampling control (`.level()`, `.bias()`, `.load()`, etc.)
2. Renderer support for cube textures, 3D textures, and array textures
3. New DSL functions for creating specialized texture nodes

## 1. TextureNode DSL Methods

### 1.1 Methods to Add to TextureNode

Add these methods to `src/nodes/lib/texture.ts`:

```typescript
// Explicit mip level sampling - uses textureSampleLevel
level(levelNode: Node<d.i32 | d.f32>): TextureNode

// Bias for LOD calculation - uses textureSampleBias  
bias(biasNode: Node<d.f32>): TextureNode

// Direct texel fetch without interpolation - uses textureLoad
load(uvNode: Node<d.vec2i | d.vec3i>): TextureNode

// Gradient-based sampling - uses textureSampleGrad
grad(ddxNode: Node<d.vec2f>, ddyNode: Node<d.vec2f>): TextureNode

// Depth/compare for shadow mapping - uses textureSampleCompare
compare(compareNode: Node<d.f32>): TextureNode

// Layer selection for array textures
depth(layerNode: Node<d.i32>): TextureNode

// Texel offset
offset(offsetNode: Node<d.vec2i | d.vec3i>): TextureNode
```

### 1.2 TextureNode Internal State

Add these properties to TextureNode:

```typescript
levelNode: Node<d.i32 | d.f32> | null = null;
biasNode: Node<d.f32> | null = null;
compareNode: Node<d.f32> | null = null;
depthNode: Node<d.i32> | null = null;      // for array textures
gradNode: [Node<d.vec2f>, Node<d.vec2f>] | null = null;
offsetNode: Node<d.vec2i | d.vec3i> | null = null;
sampler: boolean = true;  // false = textureLoad instead of textureSample
```

## 2. Builder Updates

### 2.1 Texture Generation Logic

Update `generateTexture()` in `src/nodes/builder.ts` to handle different sampling modes:

```typescript
function generateTexture(ctx: BuildContext, node: TextureNode): string {
    const name = node.textureId;
    // ... existing registration code ...
    
    const uvExpr = generateExpr(ctx, node.uvNode);
    const samplerName = `${name}_sampler`;
    
    // Determine which WGSL function to use based on node state
    if (node.biasNode) {
        const biasExpr = generateExpr(ctx, node.biasNode);
        return `textureSampleBias(${name}, ${samplerName}, ${uvExpr}, ${biasExpr})`;
    }
    
    if (node.gradNode) {
        const ddxExpr = generateExpr(ctx, node.gradNode[0]);
        const ddyExpr = generateExpr(ctx, node.gradNode[1]);
        return `textureSampleGrad(${name}, ${samplerName}, ${uvExpr}, ${ddxExpr}, ${ddyExpr})`;
    }
    
    if (node.compareNode) {
        const compareExpr = generateExpr(ctx, node.compareNode);
        return `textureSampleCompare(${name}, ${samplerName}, ${uvExpr}, ${compareExpr})`;
    }
    
    if (!node.sampler) {
        // textureLoad - no sampler, integer coords, explicit level
        const levelExpr = node.levelNode ? generateExpr(ctx, node.levelNode) : '0';
        return `textureLoad(${name}, ${uvExpr}, ${levelExpr})`;
    }
    
    if (node.levelNode) {
        const levelExpr = generateExpr(ctx, node.levelNode);
        return `textureSampleLevel(${name}, ${samplerName}, ${uvExpr}, ${levelExpr})`;
    }
    
    // Default: textureSample
    return `textureSample(${name}, ${samplerName}, ${uvExpr})`;
}
```

### 2.2 Handle Array/Cube/3D Texture Types

The builder needs to generate correct WGSL texture types:
- `texture_2d<f32>` - standard 2D
- `texture_cube<f32>` - cube map (uses vec3 UVs)
- `texture_3d<f32>` - 3D volume (uses vec3 UVs)
- `texture_2d_array<f32>` - 2D array (uses vec2 UV + layer index)

Sampling functions differ:
- Cube: `textureSample(tex, sampler, vec3_direction)`
- 3D: `textureSample(tex, sampler, vec3_uvw)`
- Array: `textureSample(tex, sampler, vec2_uv, layer_index)`

## 3. New Texture Node Classes

### 3.1 CubeTextureNode

Create `src/nodes/lib/cube-texture.ts`:

```typescript
export class CubeTextureNode extends TextureNode {
    readonly isCubeTextureNode = true;
    
    constructor(textureId: string, uvNode: Node<d.vec3f> | null = null) {
        super('texture_cube<f32>', textureId, uvNode);
    }
    
    // Override sample to expect vec3
    sample(uvNode: Node<d.vec3f>): CubeTextureNode { ... }
}

// Factory function
export const cubeTexture = (tex: CubeTexture): CubeTextureNode => { ... }
```

### 3.2 Texture3DNode

Create `src/nodes/lib/texture-3d.ts`:

```typescript
export class Texture3DNode extends TextureNode {
    readonly isTexture3DNode = true;
    
    constructor(textureId: string, uvNode: Node<d.vec3f> | null = null) {
        super('texture_3d<f32>', textureId, uvNode);
    }
    
    sample(uvNode: Node<d.vec3f>): Texture3DNode { ... }
}

export const texture3D = (tex: Data3DTexture): Texture3DNode => { ... }
```

### 3.3 ArrayTextureNode

Create `src/nodes/lib/array-texture.ts`:

```typescript
export class ArrayTextureNode extends TextureNode {
    readonly isArrayTextureNode = true;
    depthNode: Node<d.i32> | null = null;
    
    constructor(textureId: string, uvNode: Node<d.vec2f> | null = null) {
        super('texture_2d_array<f32>', textureId, uvNode);
    }
    
    // Select layer
    layer(layerNode: Node<d.i32>): ArrayTextureNode { ... }
}

export const arrayTexture = (tex: DataArrayTexture): ArrayTextureNode => { ... }
```

## 4. Renderer Texture Support

### 4.1 Update createGPUTexture in textures.ts

```typescript
function createGPUTexture(device: GPUDevice, texture: Texture): GPUTexture {
    const width = texture.width;
    const height = texture.height;
    const format = texture.format ?? 'rgba8unorm';
    
    // Detect texture type
    let dimension: GPUTextureDimension = '2d';
    let depthOrArrayLayers = 1;
    
    if ('isCubeTexture' in texture && texture.isCubeTexture) {
        depthOrArrayLayers = 6;
    } else if ('isArrayTexture' in texture && texture.isArrayTexture) {
        depthOrArrayLayers = (texture as DataArrayTexture).depth;
    } else if ('is3DTexture' in texture && texture.is3DTexture) {
        dimension = '3d';
        depthOrArrayLayers = (texture as Data3DTexture).depth;
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

### 4.2 Update uploadTextureData

Handle cube texture face uploads and array texture layer uploads:

```typescript
function uploadTextureData(device: GPUDevice, texture: Texture, data: TextureData): void {
    if ('isCubeTexture' in texture && texture.isCubeTexture) {
        uploadCubeTextureData(device, texture as CubeTexture, data);
        return;
    }
    
    if ('isArrayTexture' in texture && texture.isArrayTexture) {
        uploadArrayTextureData(device, texture as DataArrayTexture, data);
        return;
    }
    
    if ('is3DTexture' in texture && texture.is3DTexture) {
        upload3DTextureData(device, texture as Data3DTexture, data);
        return;
    }
    
    // ... existing 2D upload code ...
}

function uploadCubeTextureData(device: GPUDevice, texture: CubeTexture, data: TextureData): void {
    const { width, height } = texture;
    for (let face = 0; face < 6; face++) {
        const faceImage = texture.imageSources[face]?.data;
        if (!faceImage) continue;
        
        device.queue.copyExternalImageToTexture(
            { source: faceImage as ImageBitmap },
            { texture: data.texture, origin: [0, 0, face] },
            [width, height]
        );
    }
}
```

### 4.3 Update Mipmap Generation

The existing mipmap-utils.ts already has `generateMipmapsCube` - just need to call it for cube textures:

```typescript
// In updateTexture()
if (texture.generateMipmaps && data.texture.mipLevelCount > 1) {
    const mipmapState = getMipmapState(cache, device);
    const isCube = 'isCubeTexture' in texture && texture.isCubeTexture === true;
    generateMipmaps(mipmapState, data.texture, isCube);
}
```

## 5. Exports

### 5.1 Update src/index.ts

```typescript
// Texture classes
export { Texture } from './texture/texture';
export { DataTexture } from './texture/data-texture';
export { CubeTexture } from './texture/cube-texture';
export { DataArrayTexture } from './texture/array-texture';
export { Data3DTexture } from './texture/texture-3d';

// Texture node factories (in nodes export block)
export {
    texture,
    cubeTexture,
    texture3D,
    arrayTexture,
    textureSample,
    textureLoad,
    textureSampleLevel,
} from './nodes/lib/texture';
```

## 6. Task Breakdown

### High Priority
1. **TextureNode.level()** - Explicit mip level sampling
2. **TextureNode.bias()** - LOD bias for blur effects
3. **Builder texture generation** - Handle levelNode/biasNode

### Medium Priority  
4. **TextureNode.load()** - Direct texel fetch
5. **CubeTextureNode** - Node class + cubeTexture() factory
6. **Cube texture renderer support** - createGPUTexture + upload + view creation

### Lower Priority
7. **Texture3DNode** - Node class + texture3D() factory
8. **ArrayTextureNode** - Node class + arrayTexture() factory  
9. **3D/Array texture renderer support**
10. **TextureNode.compare()** - Shadow mapping
11. **TextureNode.grad()** - Gradient-based sampling

## 7. Testing

- Update mipmap example to demonstrate `.level()` for showing specific mip levels
- Create cube texture example (skybox or environment reflection)
- Create 3D texture example (volume rendering or 3D LUT)

## References

- Three.js TextureNode.js: level(), bias(), sample(), load(), etc.
- Three.js CubeTextureNode.js
- Three.js Texture3DNode.js
- Three.js WGSLNodeBuilder.js: generateTexture*, textureSample* methods
- WebGPU spec: texture sampling functions
