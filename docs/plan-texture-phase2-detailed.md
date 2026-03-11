# Texture System Phase 2: Detailed Implementation Plan

## Design Principles

1. **Mirror WGSL's type distinctions directly.** Each WGSL texture type gets its own DSL class with:
   - Correct coordinate type (vec2f vs vec3f)
   - Correct gradient type (matching coords)
   - Only the methods WGSL actually supports for that texture type
   - Correct return types (vec4f vs f32 for depth)

2. **No auto-magic.** Map DSL close to WGSL:
   - No auto-conversion of `textureSample` to `textureSampleLevel` in vertex shaders
   - No auto-swapping of sampler types for comparison
   - If user writes invalid WGSL (e.g., `textureSample` in vertex), that's their bug

3. **Two-layer DSL approach:**
   - **Free functions** (WGSL-mapped): Direct 1:1 mapping to WGSL builtins
   - **TextureNode methods** (ergonomic sugar): Chainable methods for common patterns

4. **Explicit SamplerNode.** Samplers are first-class nodes, not implicitly created alongside textures:
   - `SamplerNode` holds sampling parameters (filter, wrap, compare)
   - `texture()` factory auto-creates a `SamplerNode` from texture settings (ergonomic default)
   - User can create explicit `SamplerNode` for advanced control (custom settings, sharing across textures)
   - `discover()` finds and deduplicates samplers by settings key
   - Depth textures can use both `sampler` and `sampler_comparison` — user controls via explicit sampler choice

---

## WGSL Reference

### Sampling Functions (Fragment-only: textureSample, textureSampleBias, textureSampleCompare)

```wgsl
// --- 2D texture ---
textureSample(t: texture_2d<f32>, s: sampler, coords: vec2f) -> vec4f
textureSample(t: texture_2d<f32>, s: sampler, coords: vec2f, offset: vec2i) -> vec4f
textureSampleLevel(t: texture_2d<f32>, s: sampler, coords: vec2f, level: f32) -> vec4f
textureSampleLevel(t: texture_2d<f32>, s: sampler, coords: vec2f, level: f32, offset: vec2i) -> vec4f
textureSampleBias(t: texture_2d<f32>, s: sampler, coords: vec2f, bias: f32) -> vec4f
textureSampleBias(t: texture_2d<f32>, s: sampler, coords: vec2f, bias: f32, offset: vec2i) -> vec4f
textureSampleGrad(t: texture_2d<f32>, s: sampler, coords: vec2f, ddx: vec2f, ddy: vec2f) -> vec4f
textureSampleGrad(t: texture_2d<f32>, s: sampler, coords: vec2f, ddx: vec2f, ddy: vec2f, offset: vec2i) -> vec4f
textureLoad(t: texture_2d<f32>, coords: vec2i, level: i32) -> vec4f

// --- Cube texture (no offset, no textureLoad) ---
textureSample(t: texture_cube<f32>, s: sampler, coords: vec3f) -> vec4f
textureSampleLevel(t: texture_cube<f32>, s: sampler, coords: vec3f, level: f32) -> vec4f
textureSampleBias(t: texture_cube<f32>, s: sampler, coords: vec3f, bias: f32) -> vec4f
textureSampleGrad(t: texture_cube<f32>, s: sampler, coords: vec3f, ddx: vec3f, ddy: vec3f) -> vec4f

// --- 3D texture (no offset) ---
textureSample(t: texture_3d<f32>, s: sampler, coords: vec3f) -> vec4f
textureSampleLevel(t: texture_3d<f32>, s: sampler, coords: vec3f, level: f32) -> vec4f
textureSampleBias(t: texture_3d<f32>, s: sampler, coords: vec3f, bias: f32) -> vec4f
textureSampleGrad(t: texture_3d<f32>, s: sampler, coords: vec3f, ddx: vec3f, ddy: vec3f) -> vec4f
textureLoad(t: texture_3d<f32>, coords: vec3i, level: i32) -> vec4f

// --- 2D array texture (offset supported) ---
textureSample(t: texture_2d_array<f32>, s: sampler, coords: vec2f, array_index: i32) -> vec4f
textureSample(t: texture_2d_array<f32>, s: sampler, coords: vec2f, array_index: i32, offset: vec2i) -> vec4f
textureSampleLevel(t: texture_2d_array<f32>, s: sampler, coords: vec2f, array_index: i32, level: f32) -> vec4f
textureSampleLevel(t: texture_2d_array<f32>, s: sampler, coords: vec2f, array_index: i32, level: f32, offset: vec2i) -> vec4f
textureSampleBias(t: texture_2d_array<f32>, s: sampler, coords: vec2f, array_index: i32, bias: f32) -> vec4f
textureSampleBias(t: texture_2d_array<f32>, s: sampler, coords: vec2f, array_index: i32, bias: f32, offset: vec2i) -> vec4f
textureSampleGrad(t: texture_2d_array<f32>, s: sampler, coords: vec2f, array_index: i32, ddx: vec2f, ddy: vec2f) -> vec4f
textureSampleGrad(t: texture_2d_array<f32>, s: sampler, coords: vec2f, array_index: i32, ddx: vec2f, ddy: vec2f, offset: vec2i) -> vec4f
textureLoad(t: texture_2d_array<f32>, coords: vec2i, array_index: i32, level: i32) -> vec4f

// --- Cube array texture (no offset, no textureLoad) ---
textureSample(t: texture_cube_array<f32>, s: sampler, coords: vec3f, array_index: i32) -> vec4f
textureSampleLevel(t: texture_cube_array<f32>, s: sampler, coords: vec3f, array_index: i32, level: f32) -> vec4f
textureSampleBias(t: texture_cube_array<f32>, s: sampler, coords: vec3f, array_index: i32, bias: f32) -> vec4f
textureSampleGrad(t: texture_cube_array<f32>, s: sampler, coords: vec3f, array_index: i32, ddx: vec3f, ddy: vec3f) -> vec4f

// --- Depth 2D (returns f32, comparison uses sampler_comparison) ---
textureSample(t: texture_depth_2d, s: sampler, coords: vec2f) -> f32
textureSample(t: texture_depth_2d, s: sampler, coords: vec2f, offset: vec2i) -> f32
textureSampleLevel(t: texture_depth_2d, s: sampler, coords: vec2f, level: i32) -> f32
textureSampleLevel(t: texture_depth_2d, s: sampler, coords: vec2f, level: i32, offset: vec2i) -> f32
textureSampleCompare(t: texture_depth_2d, s: sampler_comparison, coords: vec2f, depth_ref: f32) -> f32
textureSampleCompare(t: texture_depth_2d, s: sampler_comparison, coords: vec2f, depth_ref: f32, offset: vec2i) -> f32
textureSampleCompareLevel(t: texture_depth_2d, s: sampler_comparison, coords: vec2f, depth_ref: f32, level: i32) -> f32
textureSampleCompareLevel(t: texture_depth_2d, s: sampler_comparison, coords: vec2f, depth_ref: f32, level: i32, offset: vec2i) -> f32
textureLoad(t: texture_depth_2d, coords: vec2i, level: i32) -> f32

// --- Depth cube (no offset, no textureLoad) ---
textureSample(t: texture_depth_cube, s: sampler, coords: vec3f) -> f32
textureSampleLevel(t: texture_depth_cube, s: sampler, coords: vec3f, level: i32) -> f32
textureSampleCompare(t: texture_depth_cube, s: sampler_comparison, coords: vec3f, depth_ref: f32) -> f32
textureSampleCompareLevel(t: texture_depth_cube, s: sampler_comparison, coords: vec3f, depth_ref: f32, level: i32) -> f32

// --- Depth 2D array (offset supported) ---
textureSample(t: texture_depth_2d_array, s: sampler, coords: vec2f, array_index: i32) -> f32
textureSample(t: texture_depth_2d_array, s: sampler, coords: vec2f, array_index: i32, offset: vec2i) -> f32
textureSampleLevel(t: texture_depth_2d_array, s: sampler, coords: vec2f, array_index: i32, level: i32) -> f32
textureSampleLevel(t: texture_depth_2d_array, s: sampler, coords: vec2f, array_index: i32, level: i32, offset: vec2i) -> f32
textureSampleCompare(t: texture_depth_2d_array, s: sampler_comparison, coords: vec2f, array_index: i32, depth_ref: f32) -> f32
textureSampleCompare(t: texture_depth_2d_array, s: sampler_comparison, coords: vec2f, array_index: i32, depth_ref: f32, offset: vec2i) -> f32
textureSampleCompareLevel(t: texture_depth_2d_array, s: sampler_comparison, coords: vec2f, array_index: i32, depth_ref: f32, level: i32) -> f32
textureSampleCompareLevel(t: texture_depth_2d_array, s: sampler_comparison, coords: vec2f, array_index: i32, depth_ref: f32, level: i32, offset: vec2i) -> f32
textureLoad(t: texture_depth_2d_array, coords: vec2i, array_index: i32, level: i32) -> f32

// --- Depth cube array (no offset, no textureLoad) ---
textureSample(t: texture_depth_cube_array, s: sampler, coords: vec3f, array_index: i32) -> f32
textureSampleLevel(t: texture_depth_cube_array, s: sampler, coords: vec3f, array_index: i32, level: i32) -> f32
textureSampleCompare(t: texture_depth_cube_array, s: sampler_comparison, coords: vec3f, array_index: i32, depth_ref: f32) -> f32
textureSampleCompareLevel(t: texture_depth_cube_array, s: sampler_comparison, coords: vec3f, array_index: i32, depth_ref: f32, level: i32) -> f32
```

### Query Functions

```wgsl
textureDimensions(t: texture_*) -> vec2u | vec3u | u32  // depends on texture type
textureDimensions(t: texture_*, level: u32) -> vec2u | vec3u | u32
textureNumLayers(t: texture_*_array) -> u32
textureNumLevels(t: texture_*) -> u32
```

### Gather Functions

```wgsl
textureGather(component: i32, t: texture_2d<f32>, s: sampler, coords: vec2f) -> vec4f
textureGather(component: i32, t: texture_2d<f32>, s: sampler, coords: vec2f, offset: vec2i) -> vec4f
textureGather(component: i32, t: texture_cube<f32>, s: sampler, coords: vec3f) -> vec4f
// ... etc for other texture types

textureGatherCompare(t: texture_depth_2d, s: sampler_comparison, coords: vec2f, depth_ref: f32) -> vec4f
textureGatherCompare(t: texture_depth_2d, s: sampler_comparison, coords: vec2f, depth_ref: f32, offset: vec2i) -> vec4f
// ... etc for other depth texture types
```

### Storage Texture Functions

```wgsl
textureStore(t: texture_storage_2d<F, write>, coords: vec2i, value: vec4<ST>)
textureStore(t: texture_storage_2d<F, read_write>, coords: vec2i, value: vec4<ST>)
// ... etc for other storage texture types
textureLoad(t: texture_storage_2d<F, read>, coords: vec2i) -> vec4<ST>
textureLoad(t: texture_storage_2d<F, read_write>, coords: vec2i) -> vec4<ST>
```

---

## DSL Design

### Layer 1: WGSL-Mapped Free Functions

These are direct 1:1 mappings to WGSL builtins. They work with any texture/sampler nodes.

```typescript
// Sampling (free functions for full control)
textureSample(t, s, coords)
textureSample(t, s, coords, offset)
textureSampleLevel(t, s, coords, level)
textureSampleLevel(t, s, coords, level, offset)
textureSampleBias(t, s, coords, bias)
textureSampleBias(t, s, coords, bias, offset)
textureSampleGrad(t, s, coords, ddx, ddy)
textureSampleGrad(t, s, coords, ddx, ddy, offset)

// Comparison (requires sampler_comparison)
textureSampleCompare(t, s_cmp, coords, depthRef)
textureSampleCompare(t, s_cmp, coords, depthRef, offset)
textureSampleCompareLevel(t, s_cmp, coords, depthRef, level)
textureSampleCompareLevel(t, s_cmp, coords, depthRef, level, offset)

// Direct load (no sampler)
textureLoad(t, coords, level)
textureLoad(t, coords, arrayIndex, level)  // for array textures

// Storage
textureStore(t, coords, value)
textureStore(t, coords, arrayIndex, value)  // for array textures

// Query
textureDimensions(t)
textureDimensions(t, level)
textureNumLayers(t)
textureNumLevels(t)

// Gather
textureGather(component, t, s, coords)
textureGather(component, t, s, coords, offset)
textureGatherCompare(t, s_cmp, coords, depthRef)
textureGatherCompare(t, s_cmp, coords, depthRef, offset)
```

### Layer 2: TextureNode Methods (Ergonomic Sugar)

Chainable methods on texture nodes for common patterns. These build on the internal node state.

**Methods available on all sampling texture nodes:**
- `.sample(coords)` — set coordinates, returns clone
- `.level(level)` — use `textureSampleLevel`
- `.bias(bias)` — use `textureSampleBias`
- `.grad(ddx, ddy)` — use `textureSampleGrad`

**Methods on 2D and 2D-array only:**
- `.offset(offset)` — add offset parameter (WGSL const expression)

**Methods on textures that support textureLoad:**
- `.load(coords)` — use `textureLoad` (disables sampler)
- `.load(coords, level)` — use `textureLoad` with explicit level

**Methods on array textures:**
- `.layer(index)` — set array layer index

**NOT provided as methods (use free functions instead):**
- `.compare()` — requires different sampler type, use `textureSampleCompare()` free function

---

### Class Hierarchy

```
TextureNode                    // texture_2d<f32>           coords: vec2f, returns: vec4f
CubeTextureNode                // texture_cube<f32>         coords: vec3f, returns: vec4f
Texture3DNode                  // texture_3d<f32>           coords: vec3f, returns: vec4f
ArrayTextureNode               // texture_2d_array<f32>     coords: vec2f + layer, returns: vec4f
CubeArrayTextureNode           // texture_cube_array<f32>   coords: vec3f + layer, returns: vec4f
DepthTextureNode               // texture_depth_2d          coords: vec2f, returns: f32
DepthCubeTextureNode           // texture_depth_cube        coords: vec3f, returns: f32
DepthArrayTextureNode          // texture_depth_2d_array    coords: vec2f + layer, returns: f32
DepthCubeArrayTextureNode      // texture_depth_cube_array  coords: vec3f + layer, returns: f32
```

### SamplerNode

Samplers are first-class nodes with their own bindings. This mirrors WGSL where textures and samplers are separate.

```typescript
class SamplerNode<D extends d.SamplerDesc | d.SamplerComparisonDesc = d.SamplerDesc> extends Node<D> {
    readonly isSamplerNode = true;
    
    /** GPU sampler resource (set by renderer) */
    resource: GPUSampler | null = null;
    
    /** Unique ID for this sampler instance */
    samplerId: string;
    
    /** Uniform group — determines @group index */
    groupNode: UniformGroup;
    
    // Sampling parameters
    minFilter: GPUFilterMode = 'linear';
    magFilter: GPUFilterMode = 'linear';
    mipmapFilter: GPUMipmapFilterMode = 'linear';
    addressModeU: GPUAddressMode = 'clamp-to-edge';
    addressModeV: GPUAddressMode = 'clamp-to-edge';
    addressModeW: GPUAddressMode = 'clamp-to-edge';
    maxAnisotropy: number = 1;
    
    /** For sampler_comparison only */
    compare?: GPUCompareFunction;
    
    /** Settings key for deduplication */
    get settingsKey(): string {
        const base = `${this.minFilter}-${this.magFilter}-${this.mipmapFilter}-${this.addressModeU}-${this.addressModeV}-${this.addressModeW}-${this.maxAnisotropy}`;
        return this.compare ? `${base}-cmp-${this.compare}` : base;
    }
}
```

**TextureNode has samplerNode property:**

```typescript
class TextureNode extends Node<d.vec4f> {
    // ... existing properties ...
    
    /** The sampler for this texture (auto-created by texture() factory) */
    samplerNode: SamplerNode<d.SamplerDesc> | null = null;
}
```

### Factory Functions

```typescript
// Regular textures (auto-create sampler from texture settings)
texture(tex: Texture): TextureNode  // sets node.samplerNode = sampler(tex)
cubeTexture(tex: CubeTexture): CubeTextureNode
texture3D(tex: Data3DTexture): Texture3DNode
arrayTexture(tex: DataArrayTexture): ArrayTextureNode
cubeArrayTexture(tex: CubeArrayTexture): CubeArrayTextureNode

// Depth textures
depthTexture(tex: DepthTexture): DepthTextureNode
depthCubeTexture(tex: DepthCubeTexture): DepthCubeTextureNode
depthArrayTexture(tex: DepthArrayTexture): DepthArrayTextureNode
depthCubeArrayTexture(tex: DepthCubeArrayTexture): DepthCubeArrayTextureNode

// Samplers
sampler(tex: Texture): SamplerNode<SamplerDesc>  // derive from texture settings
sampler(options: SamplerOptions): SamplerNode<SamplerDesc>  // explicit settings
comparisonSampler(tex: Texture, compare?: GPUCompareFunction): SamplerNode<SamplerComparisonDesc>
```

### DSL Usage Examples

```typescript
// --- 2D texture with methods ---
const albedo = texture(myTex);
albedo                                    // textureSample(t, s, uv)
albedo.sample(customUv)                   // textureSample(t, s, customUv)
albedo.level(float(2))                    // textureSampleLevel(t, s, uv, 2.0)
albedo.bias(float(1))                     // textureSampleBias(t, s, uv, 1.0)
albedo.grad(ddx, ddy)                     // textureSampleGrad(t, s, uv, ddx, ddy)
albedo.offset(vec2i(1, 0))                // textureSample(t, s, uv, vec2i(1,0))
albedo.level(float(2)).offset(vec2i(1,0)) // textureSampleLevel(t, s, uv, 2.0, vec2i(1,0))
albedo.load(vec2i(10, 20))                // textureLoad(t, ivec2(10,20), 0)
albedo.load(vec2i(10, 20), int(2))        // textureLoad(t, ivec2(10,20), 2)

// --- Cube texture (no offset, no load) ---
const env = cubeTexture(myCubeTex);
env.sample(reflectDir)                    // textureSample(t, s, dir)
env.sample(reflectDir).level(float(0))    // textureSampleLevel(t, s, dir, 0.0)
env.sample(reflectDir).bias(float(1))     // textureSampleBias(t, s, dir, 1.0)
env.sample(reflectDir).grad(ddx, ddy)     // textureSampleGrad(t, s, dir, ddx, ddy)
// env.load() → TypeScript error! No such method on CubeTextureNode
// env.offset() → TypeScript error! No such method on CubeTextureNode

// --- 3D texture (no offset) ---
const vol = texture3D(myVolumeTex);
vol.sample(uvw)                           // textureSample(t, s, uvw)
vol.sample(uvw).level(float(0))           // textureSampleLevel(t, s, uvw, 0.0)
vol.load(vec3i(x, y, z))                  // textureLoad(t, ivec3(x,y,z), 0)
// vol.offset() → TypeScript error! No such method on Texture3DNode

// --- 2D array texture ---
const arr = arrayTexture(myArrayTex);
arr.layer(int(3))                         // textureSample(t, s, uv, 3)
arr.layer(int(3)).level(float(0))         // textureSampleLevel(t, s, uv, 3, 0.0)
arr.layer(int(3)).bias(float(1))          // textureSampleBias(t, s, uv, 3, 1.0)
arr.layer(int(3)).offset(vec2i(1, 0))     // textureSample(t, s, uv, 3, vec2i(1,0))
arr.layer(int(3)).load(vec2i(x, y))       // textureLoad(t, ivec2(x,y), 3, 0)
arr.layer(int(3)).load(vec2i(x, y), int(2)) // textureLoad(t, ivec2(x,y), 3, 2)

// --- Depth texture (shadow mapping with free functions) ---
const shadowTex = depthTexture(myShadowTex);
const shadowSampler = comparisonSamplerNode(myShadowTex);  // sampler_comparison

// Regular depth read (uses regular sampler)
shadowTex.sample(uv)                      // textureSample(t, s, uv) → f32
shadowTex.level(int(0))                   // textureSampleLevel(t, s, uv, 0) → f32
shadowTex.load(vec2i(x, y))               // textureLoad(t, ivec2(x,y), 0) → f32

// Comparison sampling (use free function with sampler_comparison)
textureSampleCompare(shadowTex, shadowSampler, uv, depthRef)
textureSampleCompareLevel(shadowTex, shadowSampler, uv, depthRef, int(0))

// --- Depth 2D array (cascaded shadow maps) ---
const csm = depthArrayTexture(myCsmTex);
const csmSampler = comparisonSamplerNode(myCsmTex);

csm.layer(cascadeIndex)                   // textureSample(t, s, uv, cascade) → f32
csm.layer(cascadeIndex).load(vec2i(x, y)) // textureLoad(t, ivec2(x,y), cascade, 0) → f32

// Comparison with array (free function)
textureSampleCompare(csm.layer(cascadeIndex), csmSampler, uv, depthRef)

// --- Query functions ---
textureDimensions(albedo)                 // → vec2u
textureDimensions(albedo, uint(0))        // → vec2u (specific mip level)
textureNumLevels(albedo)                  // → u32
textureNumLayers(arr)                     // → u32

// --- Gather functions ---
textureGather(int(0), albedo, albedo.sampler, uv)  // gather red channel
textureGatherCompare(shadowTex, shadowSampler, uv, depthRef)
```

---

## Class Design

### TextureNode (2D)

```typescript
class TextureNode extends Node<d.vec4f> {
    readonly isTextureNode = true;
    
    // Resources
    resource: GPUTexture | GPUTextureView | null = null;
    gpuSampler: GPUSampler | null = null;
    value: Texture | null = null;
    
    // Coordinate node
    uvNode: Node<d.vec2f>;
    
    // Reference to base (for chained methods)
    referenceNode: TextureNode | null = null;
    
    // WGSL type
    readonly textureType: string;  // 'texture_2d<f32>'
    
    // Uniform group
    groupNode: UniformGroup;
    textureId: string;
    
    // Sampling mode properties
    levelNode: Node<d.f32> | null = null;
    biasNode: Node<d.f32> | null = null;
    gradNode: [Node<d.vec2f>, Node<d.vec2f>] | null = null;
    offsetNode: Node<d.vec2i> | null = null;
    
    /** When false, uses textureLoad (no sampler) */
    sampler: boolean = true;
    
    /** Coords for textureLoad (integer coords) */
    loadCoords: Node<d.vec2i> | null = null;
    
    // Methods
    sample(uvNode: Node<d.vec2f>): TextureNode
    level(levelNode: Node<d.f32>): TextureNode
    bias(biasNode: Node<d.f32>): TextureNode
    grad(ddx: Node<d.vec2f>, ddy: Node<d.vec2f>): TextureNode
    offset(offsetNode: Node<d.vec2i>): TextureNode  // 2D only
    load(coords: Node<d.vec2i>, level?: Node<d.i32>): TextureNode
    
    getBase(): TextureNode
    clone(): TextureNode
}
```

### CubeTextureNode

```typescript
class CubeTextureNode extends Node<d.vec4f> {
    readonly isCubeTextureNode = true;
    
    // Same resource/group properties as TextureNode...
    readonly textureType = 'texture_cube<f32>';
    
    // Direction (vec3f)
    uvNode: Node<d.vec3f> | null = null;
    
    // Sampling modes (NO offsetNode, NO load)
    levelNode: Node<d.f32> | null = null;
    biasNode: Node<d.f32> | null = null;
    gradNode: [Node<d.vec3f>, Node<d.vec3f>] | null = null;
    
    // Methods
    sample(direction: Node<d.vec3f>): CubeTextureNode
    level(levelNode: Node<d.f32>): CubeTextureNode
    bias(biasNode: Node<d.f32>): CubeTextureNode
    grad(ddx: Node<d.vec3f>, ddy: Node<d.vec3f>): CubeTextureNode
    // NO offset() - not supported for cube
    // NO load() - not supported for cube
}
```

### Texture3DNode

```typescript
class Texture3DNode extends Node<d.vec4f> {
    readonly isTexture3DNode = true;
    readonly textureType = 'texture_3d<f32>';
    
    uvNode: Node<d.vec3f> | null = null;
    
    levelNode: Node<d.f32> | null = null;
    biasNode: Node<d.f32> | null = null;
    gradNode: [Node<d.vec3f>, Node<d.vec3f>] | null = null;
    // NO offsetNode - not supported for 3D
    
    sampler: boolean = true;
    loadCoords: Node<d.vec3i> | null = null;
    
    // Methods
    sample(uvw: Node<d.vec3f>): Texture3DNode
    level(levelNode: Node<d.f32>): Texture3DNode
    bias(biasNode: Node<d.f32>): Texture3DNode
    grad(ddx: Node<d.vec3f>, ddy: Node<d.vec3f>): Texture3DNode
    load(coords: Node<d.vec3i>, level?: Node<d.i32>): Texture3DNode
    // NO offset() - not supported for 3D
}
```

### ArrayTextureNode

```typescript
class ArrayTextureNode extends Node<d.vec4f> {
    readonly isArrayTextureNode = true;
    readonly textureType = 'texture_2d_array<f32>';
    
    uvNode: Node<d.vec2f>;
    layerNode: Node<d.i32 | d.u32> | null = null;
    
    levelNode: Node<d.f32> | null = null;
    biasNode: Node<d.f32> | null = null;
    gradNode: [Node<d.vec2f>, Node<d.vec2f>] | null = null;
    offsetNode: Node<d.vec2i> | null = null;  // 2D array supports offset
    
    sampler: boolean = true;
    loadCoords: Node<d.vec2i> | null = null;
    
    // Methods
    layer(layerNode: Node<d.i32 | d.u32>): ArrayTextureNode
    sample(uvNode: Node<d.vec2f>): ArrayTextureNode
    level(levelNode: Node<d.f32>): ArrayTextureNode
    bias(biasNode: Node<d.f32>): ArrayTextureNode
    grad(ddx: Node<d.vec2f>, ddy: Node<d.vec2f>): ArrayTextureNode
    offset(offsetNode: Node<d.vec2i>): ArrayTextureNode
    load(coords: Node<d.vec2i>, level?: Node<d.i32>): ArrayTextureNode
}
```

### DepthTextureNode

```typescript
class DepthTextureNode extends Node<d.f32> {  // Returns f32!
    readonly isDepthTextureNode = true;
    readonly textureType = 'texture_depth_2d';
    
    uvNode: Node<d.vec2f>;
    
    // Note: depth textures use i32 level, not f32
    levelNode: Node<d.i32> | null = null;
    offsetNode: Node<d.vec2i> | null = null;
    
    sampler: boolean = true;
    loadCoords: Node<d.vec2i> | null = null;
    
    // Methods (NO compare - use free function)
    sample(uvNode: Node<d.vec2f>): DepthTextureNode
    level(levelNode: Node<d.i32>): DepthTextureNode
    offset(offsetNode: Node<d.vec2i>): DepthTextureNode
    load(coords: Node<d.vec2i>, level?: Node<d.i32>): DepthTextureNode
    // NO compare() - use textureSampleCompare() free function with sampler_comparison
    // NO bias() - depth textures don't support bias
    // NO grad() - depth textures don't support grad
}
```

---

## Builder Changes

### generateTexture() Rewrite

The builder needs to detect sampling mode and generate correct WGSL:

```typescript
function generateTexture(ctx: BuildContext, node: TextureNode | CubeTextureNode | ...): string {
    const name = node.textureId;
    const samplerName = `${name}_sampler`;
    
    // Register texture
    if (!ctx.textures.has(name)) {
        ctx.textures.set(name, node);
    }
    
    // Register sampler (if using one - not for textureLoad)
    if (node.sampler && !ctx.samplers.has(name)) {
        ctx.samplers.set(name, node);
    }
    
    // Dispatch based on node type
    if ('isArrayTextureNode' in node || 'isDepthArrayTextureNode' in node) {
        return generateArrayTextureSample(ctx, node, name, samplerName);
    }
    if ('isDepthTextureNode' in node || 'isDepthCubeTextureNode' in node) {
        return generateDepthTextureSample(ctx, node, name, samplerName);
    }
    return generateStandardTextureSample(ctx, node, name, samplerName);
}

function generateStandardTextureSample(ctx, node, name, samplerName): string {
    const uvExpr = generateExpr(ctx, node.uvNode);
    
    // textureLoad
    if (!node.sampler) {
        const coordsExpr = generateExpr(ctx, node.loadCoords);
        const levelExpr = node.levelNode ? generateExpr(ctx, node.levelNode) : '0';
        return `textureLoad(${name}, ${coordsExpr}, ${levelExpr})`;
    }
    
    // Build offset suffix if present (2D/2D-array only)
    const offsetSuffix = node.offsetNode ? `, ${generateExpr(ctx, node.offsetNode)}` : '';
    
    // textureSampleGrad
    if (node.gradNode) {
        const ddx = generateExpr(ctx, node.gradNode[0]);
        const ddy = generateExpr(ctx, node.gradNode[1]);
        return `textureSampleGrad(${name}, ${samplerName}, ${uvExpr}, ${ddx}, ${ddy}${offsetSuffix})`;
    }
    
    // textureSampleBias
    if (node.biasNode) {
        const bias = generateExpr(ctx, node.biasNode);
        return `textureSampleBias(${name}, ${samplerName}, ${uvExpr}, ${bias}${offsetSuffix})`;
    }
    
    // textureSampleLevel
    if (node.levelNode) {
        const level = generateExpr(ctx, node.levelNode);
        return `textureSampleLevel(${name}, ${samplerName}, ${uvExpr}, ${level}${offsetSuffix})`;
    }
    
    // textureSample (default)
    return `textureSample(${name}, ${samplerName}, ${uvExpr}${offsetSuffix})`;
}

function generateArrayTextureSample(ctx, node, name, samplerName): string {
    const uvExpr = generateExpr(ctx, node.uvNode);
    const layerExpr = node.layerNode ? generateExpr(ctx, node.layerNode) : '0';
    
    // textureLoad with layer
    if (!node.sampler) {
        const coordsExpr = generateExpr(ctx, node.loadCoords);
        const levelExpr = node.levelNode ? generateExpr(ctx, node.levelNode) : '0';
        return `textureLoad(${name}, ${coordsExpr}, ${layerExpr}, ${levelExpr})`;
    }
    
    const offsetSuffix = node.offsetNode ? `, ${generateExpr(ctx, node.offsetNode)}` : '';
    
    // textureSampleGrad with layer
    if (node.gradNode) {
        const ddx = generateExpr(ctx, node.gradNode[0]);
        const ddy = generateExpr(ctx, node.gradNode[1]);
        return `textureSampleGrad(${name}, ${samplerName}, ${uvExpr}, ${layerExpr}, ${ddx}, ${ddy}${offsetSuffix})`;
    }
    
    // textureSampleBias with layer
    if (node.biasNode) {
        const bias = generateExpr(ctx, node.biasNode);
        return `textureSampleBias(${name}, ${samplerName}, ${uvExpr}, ${layerExpr}, ${bias}${offsetSuffix})`;
    }
    
    // textureSampleLevel with layer
    if (node.levelNode) {
        const level = generateExpr(ctx, node.levelNode);
        return `textureSampleLevel(${name}, ${samplerName}, ${uvExpr}, ${layerExpr}, ${level}${offsetSuffix})`;
    }
    
    // textureSample with layer
    return `textureSample(${name}, ${samplerName}, ${uvExpr}, ${layerExpr}${offsetSuffix})`;
}

function generateDepthTextureSample(ctx, node, name, samplerName): string {
    const uvExpr = generateExpr(ctx, node.uvNode);
    
    // textureLoad
    if (!node.sampler) {
        const coordsExpr = generateExpr(ctx, node.loadCoords);
        const levelExpr = node.levelNode ? generateExpr(ctx, node.levelNode) : '0';
        return `textureLoad(${name}, ${coordsExpr}, ${levelExpr})`;
    }
    
    const offsetSuffix = node.offsetNode ? `, ${generateExpr(ctx, node.offsetNode)}` : '';
    
    // textureSampleLevel (depth uses i32 level)
    if (node.levelNode) {
        const level = generateExpr(ctx, node.levelNode);
        return `textureSampleLevel(${name}, ${samplerName}, ${uvExpr}, ${level}${offsetSuffix})`;
    }
    
    // textureSample
    return `textureSample(${name}, ${samplerName}, ${uvExpr}${offsetSuffix})`;
}
```

### Sampler Binding Emission Fix

Current code auto-detects depth textures and emits `sampler_comparison`. This is WRONG — a depth texture used with regular `textureSample` needs `sampler`, not `sampler_comparison`.

**Fix:** Each texture node should have an explicit `samplerType` property set by the sampling mode:
- Regular sampling methods → `'sampler'`
- `textureSampleCompare` free function → needs separate `sampler_comparison` binding

For the free function approach, the `SamplerNode` with `SamplerComparisonDesc` type will be registered separately.

```typescript
// In binding emission:
for (const { name, node } of group.samplers) {
    // Use the sampler type from the node, not auto-detection
    const samplerType = node.samplerType ?? 'sampler';
    lines.push(`@group(${groupIndex}) @binding(${bindingIndex}) var ${name}_sampler: ${samplerType};`);
    // ...
}
```

---

## Free Function Implementation

Free functions are `CallNode` factories that produce correct WGSL:

```typescript
// In src/nodes/lib/texture.ts

export const textureSample = (
    t: TextureNode | CubeTextureNode | ...,
    s: SamplerNode<d.SamplerDesc>,
    coords: Node<d.vec2f> | Node<d.vec3f>,
    offset?: Node<d.vec2i>
): CallNode<d.vec4f> => {
    const args = offset ? [t, s, coords, offset] : [t, s, coords];
    return new CallNode(d.vec4f, 'textureSample', args);
};

export const textureSampleLevel = (
    t: TextureNode | ...,
    s: SamplerNode<d.SamplerDesc>,
    coords: Node<d.vec2f> | Node<d.vec3f>,
    level: Node<d.f32>,
    offset?: Node<d.vec2i>
): CallNode<d.vec4f> => {
    const args = offset ? [t, s, coords, level, offset] : [t, s, coords, level];
    return new CallNode(d.vec4f, 'textureSampleLevel', args);
};

export const textureSampleCompare = (
    t: DepthTextureNode | DepthCubeTextureNode | ...,
    s: SamplerNode<d.SamplerComparisonDesc>,  // Must be comparison sampler!
    coords: Node<d.vec2f> | Node<d.vec3f>,
    depthRef: Node<d.f32>,
    offset?: Node<d.vec2i>
): CallNode<d.f32> => {
    const args = offset ? [t, s, coords, depthRef, offset] : [t, s, coords, depthRef];
    return new CallNode(d.f32, 'textureSampleCompare', args);
};

export const textureLoad = (
    t: TextureNode | Texture3DNode | ArrayTextureNode | DepthTextureNode | ...,
    coords: Node<d.vec2i> | Node<d.vec3i>,
    levelOrArrayIndex: Node<d.i32>,
    level?: Node<d.i32>  // Only for array textures
): CallNode<d.vec4f | d.f32> => {
    const returnType = 'isDepthTextureNode' in t ? d.f32 : d.vec4f;
    const args = level ? [t, coords, levelOrArrayIndex, level] : [t, coords, levelOrArrayIndex];
    return new CallNode(returnType, 'textureLoad', args);
};

export const textureDimensions = (
    t: TextureNode | ...,
    level?: Node<d.u32>
): CallNode<d.vec2u | d.vec3u | d.u32> => {
    // Return type depends on texture dimension
    const returnType = 'isCubeTextureNode' in t || 'isTexture3DNode' in t ? d.vec3u : d.vec2u;
    const args = level ? [t, level] : [t];
    return new CallNode(returnType, 'textureDimensions', args);
};

export const textureNumLayers = (
    t: ArrayTextureNode | CubeArrayTextureNode | ...
): CallNode<d.u32> => {
    return new CallNode(d.u32, 'textureNumLayers', [t]);
};

export const textureNumLevels = (
    t: TextureNode | ...
): CallNode<d.u32> => {
    return new CallNode(d.u32, 'textureNumLevels', [t]);
};

export const textureStore = (
    t: StorageTextureNode,
    coords: Node<d.vec2i> | Node<d.vec3i>,
    value: Node<d.vec4f>
): CallNode<d.void_> => {
    return new CallNode(d.void_, 'textureStore', [t, coords, value]);
};

export const textureGather = (
    component: Node<d.i32>,
    t: TextureNode | CubeTextureNode | ...,
    s: SamplerNode<d.SamplerDesc>,
    coords: Node<d.vec2f> | Node<d.vec3f>,
    offset?: Node<d.vec2i>
): CallNode<d.vec4f> => {
    const args = offset ? [component, t, s, coords, offset] : [component, t, s, coords];
    return new CallNode(d.vec4f, 'textureGather', args);
};

export const textureGatherCompare = (
    t: DepthTextureNode | ...,
    s: SamplerNode<d.SamplerComparisonDesc>,
    coords: Node<d.vec2f> | Node<d.vec3f>,
    depthRef: Node<d.f32>,
    offset?: Node<d.vec2i>
): CallNode<d.vec4f> => {
    const args = offset ? [t, s, coords, depthRef, offset] : [t, s, coords, depthRef];
    return new CallNode(d.vec4f, 'textureGatherCompare', args);
};
```

---

## Renderer Changes

### Cube Texture Support

1. **createGPUTexture**: Detect `isCubeTexture`, create with `depthOrArrayLayers: 6`
2. **uploadTextureData**: Upload each of the 6 faces to the correct layer
3. **getTextureView**: Create view with `dimension: 'cube'` for cube textures

### Array Texture Support

1. **createGPUTexture**: Use `depthOrArrayLayers` from texture's layer count
2. **uploadTextureData**: Upload each layer
3. **getTextureView**: Create view with `dimension: '2d-array'`

### 3D Texture Support

1. **createGPUTexture**: Use `dimension: '3d'`
2. **uploadTextureData**: Handle 3D data layout

### Comparison Sampler Support

Create `sampler_comparison` samplers for use with `textureSampleCompare`:

```typescript
export function getComparisonSampler(
    cache: TextureCache,
    device: GPUDevice,
    texture: Texture,
    compare: GPUCompareFunction = 'less'
): GPUSampler {
    const key = `${computeSamplerKey(texture)}-cmp-${compare}`;
    
    let data = cache.samplerCache.get(key);
    if (data) {
        data.usedTimes++;
        return data.sampler;
    }
    
    const sampler = device.createSampler({
        magFilter: texture.magFilter,
        minFilter: texture.minFilter,
        mipmapFilter: texture.mipmapFilter,
        addressModeU: texture.wrapS,
        addressModeV: texture.wrapT,
        compare,  // This makes it a comparison sampler
    });
    
    cache.samplerCache.set(key, { sampler, usedTimes: 1 });
    cache.samplerCount++;
    
    return sampler;
}
```

---

## Implementation Order

### Phase 2a: Core DSL Methods on TextureNode (High Priority)
1. Add sampling properties to existing TextureNode (levelNode, biasNode, gradNode, offsetNode, loadCoords, sampler)
2. Add `.level()`, `.bias()`, `.grad()`, `.offset()`, `.load()` methods
3. Update `clone()` to copy new properties
4. Update builder `generateTexture()` to handle these modes
5. Fix sampler binding emission (no auto-detection of comparison)
6. Update mipmap example to demonstrate `.level()`

### Phase 2b: WGSL-Mapped Free Functions (High Priority)
7. Implement `textureSample`, `textureSampleLevel`, `textureSampleBias`, `textureSampleGrad` free functions
8. Implement `textureSampleCompare`, `textureSampleCompareLevel` free functions
9. Implement `textureLoad` free function
10. Implement `textureStore` free function
11. Implement `textureDimensions`, `textureNumLayers`, `textureNumLevels` query functions
12. Implement `textureGather`, `textureGatherCompare` free functions
13. Add `SamplerNode` factory functions (`samplerNode`, `comparisonSamplerNode`)

### Phase 2c: Cube Textures (Medium Priority)
14. Create CubeTextureNode class
15. Create `cubeTexture()` factory
16. Update renderer for cube texture creation/upload
17. Create cube texture example (skybox or reflection)

### Phase 2d: Depth/Shadow Textures (Medium Priority)
18. Create DepthTextureNode class
19. Add comparison sampler support to renderer
20. Create shadow mapping example using `textureSampleCompare()` free function

### Phase 2e: Array Textures (Lower Priority)
21. Create ArrayTextureNode class with `.layer()` method
22. Create `arrayTexture()` factory
23. Update renderer for array texture support
24. Create array texture example

### Phase 2f: Remaining Types (Lower Priority)
25. Texture3DNode + `texture3D()` factory
26. CubeArrayTextureNode + factory
27. DepthCubeTextureNode + factory
28. DepthArrayTextureNode + factory
29. DepthCubeArrayTextureNode + factory

---

## File Changes Summary

### Modified Files
- `src/nodes/lib/texture.ts` — Add sampling properties/methods to TextureNode, add free functions
- `src/nodes/builder.ts` — Rewrite generateTexture(), fix sampler binding emission
- `src/renderer/textures.ts` — Add cube/array/3D support, add comparison sampler support
- `src/index.ts` — Export new functions and classes

### New Files
- `src/nodes/lib/cube-texture-node.ts` — CubeTextureNode class
- `src/nodes/lib/texture-3d-node.ts` — Texture3DNode class
- `src/nodes/lib/array-texture-node.ts` — ArrayTextureNode class
- `src/nodes/lib/depth-texture-node.ts` — DepthTextureNode class (and variants)

### New Examples
- `examples/src/example-mip-levels.ts` — Show specific mip levels with `.level()`
- `examples/src/example-cubemap.ts` — Skybox or reflection demo
- `examples/src/example-shadow-map.ts` — Shadow mapping with `textureSampleCompare()`

---

## Validation

- [ ] TypeScript compiles with no errors in texture node files
- [ ] Existing mipmap example still works
- [ ] New `.level()` demo shows correct mip selection
- [ ] Free functions generate correct WGSL
- [ ] Cube texture example renders correctly
- [ ] Shadow mapping example works with comparison sampler
- [ ] Run `pnpm test` — expect same 5 pre-existing failures, no new ones
