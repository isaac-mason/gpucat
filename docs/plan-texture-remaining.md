# Texture System: Remaining Phases (2e + 2f)

Phases 2a–2d are complete. This document covers what's left.

## Status of "Unclear Items" — All Resolved

**Builder `generateTexture()` rewrite — DONE.** `src/nodes/builder.ts` has fully separate `generateTexture()`, `generateCubeTexture()`, and `generateDepthTexture()` functions (lines 1090–1272). Each dispatches on `samplingMode` and generates the correct WGSL call.

**Sampler binding emission — DONE.** `emitAllBindings()` (line 1699–1711) determines sampler type from `node.compare`: comparison samplers emit `sampler_comparison`, regular samplers emit `sampler`.

**Free functions via CallNode — DONE.** Free functions like `textureSampleCompare(t, s, coords, depthRef)` create `CallNode` instances. The builder's `generateCall()` handles them generically — `generateExpr()` on each arg correctly registers texture bindings and samplers.

---

## What Already Exists

### Resource classes (already implemented, not yet exported)
- `DataArrayTexture` — `src/texture/array-texture.ts` — 2D array texture with `depth` (layer count), `layerUpdates` tracking
- `Data3DTexture` — `src/texture/texture-3d.ts` — 3D volume texture with `depth`

### Schema descriptors (already in `src/nodes/schema.ts`)
- `texture2dArray<S>` — `texture_2d_array<f32>`
- `texture3d<S>` — `texture_3d<f32>`
- `textureCubeArray<S>` — `texture_cube_array<f32>`
- `textureDepth2dArray` — `texture_depth_2d_array`
- `textureDepthCube` — `texture_depth_cube`
- `textureDepthCubeArray` — `texture_depth_cube_array`

### TextureBindingNode — generic over descriptor
`TextureBindingNode<D extends AnyTextureDesc>` already works for any texture descriptor. The binding emission at builder line 1688 uses `node.type.wgslType`, so a `TextureBindingNode<texture2dArray>` will automatically emit `var tFoo: texture_2d_array<f32>`. No builder changes needed for binding emission.

---

## Schema Changes (`src/nodes/schema.ts`)

### Problem: Descriptor union types are too broad

The existing union types conflate multiple WGSL texture dimensionalities:

```
FlatSampledTextureDesc = texture1d | texture2d | texture2dArray | texture3d | textureMultisampled2d
CubeSampledTextureDesc = textureCube | textureCubeArray
FlatDepthTextureDesc   = textureDepth2d | textureDepth2dArray | textureDepthMultisampled2d
CubeDepthTextureDesc   = textureDepthCube | textureDepthCubeArray
```

`TextureNode` uses `FlatSampledTextureDesc` but should only represent `texture_2d` (not arrays or 3D). `CubeTextureNode` uses `CubeSampledTextureDesc` but should only represent `texture_cube` (not cube arrays). Same issue for depth.

### Solution: Narrow the unions, add new ones

**Replace the existing unions** so each node type gets exactly its descriptor:

```typescript
// Narrowed: TextureNode only handles these (2D flat, non-array, non-3D)
export type FlatSampledTextureDesc =
    | texture1d
    | texture2d
    | textureMultisampled2d;

// Narrowed: CubeTextureNode only handles single cube
export type CubeSampledTextureDesc = textureCube;

// Narrowed: DepthTextureNode only handles single 2D depth
export type FlatDepthTextureDesc =
    | textureDepth2d
    | textureDepthMultisampled2d;

// Narrowed: DepthCubeTextureNode only handles single cube depth
export type CubeDepthTextureDesc = textureDepthCube;
```

**New per-node-type descriptor aliases** (for readability, not strictly required since the descriptors themselves already exist):

```typescript
// ArrayTextureNode uses this directly:
//   TextureBindingNode<texture2dArray>

// Texture3DNode uses this directly:
//   TextureBindingNode<texture3d>

// CubeArrayTextureNode uses this directly:
//   TextureBindingNode<textureCubeArray>

// DepthArrayTextureNode uses this directly:
//   TextureBindingNode<textureDepth2dArray>

// DepthCubeArrayTextureNode uses this directly:
//   TextureBindingNode<textureDepthCubeArray>
```

No new aliases needed — each node uses the concrete descriptor type directly. The union types are only needed where we accept "any texture of this shape."

**Keep the broad unions for generic contexts** (e.g., `AnyTextureDesc`, `TextureDesc`, `DepthTextureDesc` — these stay unchanged):

```typescript
// These stay as-is:
export type TextureDesc = texture1d | texture2d | texture2dArray | texture3d
    | textureCube | textureCubeArray | textureMultisampled2d;

export type DepthTextureDesc = textureDepth2d | textureDepth2dArray
    | textureDepthCube | textureDepthCubeArray | textureDepthMultisampled2d;

export type AnyTextureDesc = TextureDesc | DepthTextureDesc;
```

### `TextureValueOf<D>` update

Currently in `src/nodes/lib/texture.ts`:

```typescript
export type TextureValueOf<D extends AnyTextureDesc> =
    D extends DepthTextureDesc ? DepthTexture
    : D extends CubeSampledTextureDesc ? CubeTexture
    : Texture;
```

Needs to map new descriptors to their resource classes:

```typescript
import { DataArrayTexture } from '../../texture/array-texture';
import { Data3DTexture } from '../../texture/texture-3d';

export type TextureValueOf<D extends AnyTextureDesc> =
    D extends textureDepth2dArray ? DepthTexture         // depth array (render target)
    : D extends textureDepthCube ? DepthTexture          // depth cube (render target)
    : D extends textureDepthCubeArray ? DepthTexture     // depth cube array (render target)
    : D extends DepthTextureDesc ? DepthTexture          // remaining depth types
    : D extends textureCubeArray ? CubeTexture           // cube array TODO: CubeArrayTexture?
    : D extends textureCube ? CubeTexture                // single cube
    : D extends texture2dArray ? DataArrayTexture        // 2D array
    : D extends texture3d ? Data3DTexture                // 3D volume
    : Texture;                                           // fallback (texture_2d, etc.)
```

The order matters — more specific types must come before their parent unions.

### `TextureSampleResultOf` — no changes needed

`TextureSampleResultOf<D>` already works correctly: depth descs → `f32`, sampled descs → `vec4f`/`vec4i`/`vec4u` based on `sampleType`. The new concrete descriptors all fit this existing logic.

### Free function type signatures — overloads needed

The existing free functions in `src/nodes/lib/texture.ts` have signatures like:

```typescript
export function textureSample<D extends FlatSampledTextureDesc>(
    t: TextureBindingNode<D>, s: AnySamplerNode, coords: Node<d.vec2f>, offset?: Node<d.vec2i>
): CallNode<d.TextureSampleResultOf<D>>
```

This takes `coords: vec2f` — correct for 2D textures but wrong for 3D/cube/array textures which need different coords and extra args. Since these are `CallNode` factories (the WGSL string is just the function name + args), **type-safety is the concern, not code generation**.

**Option A: Overloads per texture dimensionality.**

```typescript
// 2D textures (existing signature, narrowed constraint)
export function textureSample<D extends FlatSampledTextureDesc>(
    t: TextureBindingNode<D>, s: AnySamplerNode,
    coords: Node<d.vec2f>, offset?: Node<d.vec2i>
): CallNode<d.TextureSampleResultOf<D>>;

// 2D array textures
export function textureSample(
    t: TextureBindingNode<d.texture2dArray>, s: AnySamplerNode,
    coords: Node<d.vec2f>, arrayIndex: Node<d.i32>,
    offset?: Node<d.vec2i>
): CallNode<d.vec4f>;

// 3D textures
export function textureSample(
    t: TextureBindingNode<d.texture3d>, s: AnySamplerNode,
    coords: Node<d.vec3f>
): CallNode<d.vec4f>;

// Cube textures
export function textureSample(
    t: TextureBindingNode<d.textureCube>, s: AnySamplerNode,
    coords: Node<d.vec3f>
): CallNode<d.vec4f>;

// Cube array textures
export function textureSample(
    t: TextureBindingNode<d.textureCubeArray>, s: AnySamplerNode,
    coords: Node<d.vec3f>, arrayIndex: Node<d.i32>
): CallNode<d.vec4f>;

// Depth 2D (existing)
// Depth 2D array
export function textureSample(
    t: TextureBindingNode<d.textureDepth2dArray>, s: AnySamplerNode,
    coords: Node<d.vec2f>, arrayIndex: Node<d.i32>,
    offset?: Node<d.vec2i>
): CallNode<d.f32>;

// ... etc for each textureSampleLevel, textureSampleBias, textureSampleGrad
```

**Option B: Keep the current loose signatures** — they already work at runtime (CallNode just passes args through), and add strict overloads incrementally as we implement each type.

**Decision: Option B for now.** The free functions work at runtime regardless of types. We can add overloads when we implement each phase step. The node method APIs (`.sample()`, `.layer()` etc.) already provide the type-safe ergonomic layer. The free functions are the "escape hatch" where the user explicitly controls arg order.

When we implement each node type, we should add at minimum a correctly-typed convenience overload for that type's `textureSample` and `textureSampleLevel` (the most common operations). The full set of overloads for every function × every type can be done as a polish pass.

### Comparison free functions — array and cube depth overloads

These are the most important new overloads since comparison sampling is only available via free functions:

```typescript
// Depth 2D array comparison (CSM)
export function textureSampleCompare(
    t: TextureBindingNode<d.textureDepth2dArray>, s: AnyComparisonSamplerNode,
    coords: Node<d.vec2f>, arrayIndex: Node<d.i32>, depthRef: Node<d.f32>,
    offset?: Node<d.vec2i>
): CallNode<d.f32>;

// Depth cube comparison (omni shadow)
export function textureSampleCompare(
    t: TextureBindingNode<d.textureDepthCube>, s: AnyComparisonSamplerNode,
    coords: Node<d.vec3f>, depthRef: Node<d.f32>
): CallNode<d.f32>;

// Depth cube array comparison
export function textureSampleCompare(
    t: TextureBindingNode<d.textureDepthCubeArray>, s: AnyComparisonSamplerNode,
    coords: Node<d.vec3f>, arrayIndex: Node<d.i32>, depthRef: Node<d.f32>
): CallNode<d.f32>;
```

Same pattern for `textureSampleCompareLevel` and `textureGatherCompare`.

### Summary of schema.ts changes

| Change | What | Why |
|--------|------|-----|
| Narrow `FlatSampledTextureDesc` | Remove `texture2dArray`, `texture3d` | TextureNode should only be 2D |
| Narrow `CubeSampledTextureDesc` | Remove `textureCubeArray` | CubeTextureNode should only be single cube |
| Narrow `FlatDepthTextureDesc` | Remove `textureDepth2dArray` | DepthTextureNode should only be single 2D depth |
| Narrow `CubeDepthTextureDesc` | Remove `textureDepthCubeArray` | DepthCubeTextureNode should only be single cube depth |
| Keep broad unions | `TextureDesc`, `DepthTextureDesc`, `AnyTextureDesc` unchanged | Generic contexts still need them |
| No new descriptor types | All concrete descriptors already exist | Schema is already complete |
| `TextureValueOf<D>` | Add branches for `texture2dArray→DataArrayTexture`, `texture3d→Data3DTexture`, depth variants | Factory/binding needs correct resource class |

---

## Phase 2e: Array Textures

### 2e.1 — ArrayTextureNode class

New class in `src/nodes/lib/texture.ts`:

```typescript
class ArrayTextureNode extends Node<d.vec4f> {
    readonly isArrayTextureNode = true;

    readonly bindingNode: TextureBindingNode<d.texture2dArray>;

    // UV coordinates (vec2f)
    uvNode: Node<d.vec2f>;

    // Array layer index (i32)
    layerNode: Node<d.i32> | null = null;

    referenceNode: ArrayTextureNode | null = null;
    samplerNode: SamplerNode<d.SamplerDesc> | null = null;

    // Sampling mode
    samplingMode: SamplingMode = 'sample'; // reuse existing SamplingMode type
    levelNode: Node<d.f32> | null = null;
    biasNode: Node<d.f32> | null = null;
    gradNode: [Node<d.vec2f>, Node<d.vec2f>] | null = null;
    offsetNode: Node<d.vec2i> | null = null; // 2D array supports offset
    loadCoords: Node<d.vec2i> | null = null;
    loadLevel: Node<d.i32> | null = null;
}
```

**Methods:**
- `.layer(layerNode)` — set array layer index, returns clone
- `.sample(uvNode)` — set UV coordinates
- `.level(levelNode)` — textureSampleLevel
- `.bias(biasNode)` — textureSampleBias
- `.grad(ddx, ddy)` — textureSampleGrad
- `.offset(offsetNode)` — add offset
- `.load(coords, level?)` — textureLoad

**Clone must copy:** all sampling properties + layerNode.

### 2e.2 — `arrayTexture()` factory

```typescript
export const arrayTexture = (tex: DataArrayTexture): ArrayTextureNode => {
    const desc = d.texture2dArray();
    const binding = new TextureBindingNode(desc, `t${tex.id}`);
    binding.value = tex;
    const node = new ArrayTextureNode(binding);
    node.samplerNode = sampler(tex, binding.groupNode);
    return node;
};
```

Needs: import `DataArrayTexture`, update `TextureValueOf<D>` to handle `texture2dArray → DataArrayTexture`.

### 2e.3 — Builder: `generateArrayTexture()`

New function following the same pattern as `generateTexture()` but inserting `layerExpr` after coords in all WGSL calls.

**WGSL arg order for 2D array textures:**
- `textureSample(t, s, coords, array_index)`
- `textureSampleLevel(t, s, coords, array_index, level)`
- `textureSampleBias(t, s, coords, array_index, bias)`
- `textureSampleGrad(t, s, coords, array_index, ddx, ddy)`
- `textureLoad(t, coords, array_index, level)`

All with optional trailing offset where supported.

```typescript
function generateArrayTexture(ctx: BuildContext, node: ArrayTextureNode): string {
    const binding = node.bindingNode;
    const name = generateTextureBinding(ctx, binding);

    const layerExpr = node.layerNode ? generateExpr(ctx, node.layerNode) : '0';

    // textureLoad
    if (node.samplingMode === 'load') {
        const coordsExpr = generateExpr(ctx, node.loadCoords!);
        const levelExpr = node.loadLevel ? generateExpr(ctx, node.loadLevel) : '0';
        return `textureLoad(${name}, ${coordsExpr}, ${layerExpr}, ${levelExpr})`;
    }

    // Sampling modes
    let samplerNode = node.samplerNode;
    if (!samplerNode) {
        samplerNode = new SamplerNode(d.sampler, name, binding.groupNode);
        node.samplerNode = samplerNode;
    }
    const samplerName = generateSampler(ctx, samplerNode);
    const uvExpr = generateExpr(ctx, node.uvNode);
    const offsetSuffix = node.offsetNode ? `, ${generateExpr(ctx, node.offsetNode)}` : '';

    if (node.samplingMode === 'grad') {
        const ddx = generateExpr(ctx, node.gradNode![0]);
        const ddy = generateExpr(ctx, node.gradNode![1]);
        return `textureSampleGrad(${name}, ${samplerName}, ${uvExpr}, ${layerExpr}, ${ddx}, ${ddy}${offsetSuffix})`;
    }

    if (node.samplingMode === 'bias') {
        const bias = generateExpr(ctx, node.biasNode!);
        return `textureSampleBias(${name}, ${samplerName}, ${uvExpr}, ${layerExpr}, ${bias}${offsetSuffix})`;
    }

    if (node.samplingMode === 'level') {
        const level = generateExpr(ctx, node.levelNode!);
        return `textureSampleLevel(${name}, ${samplerName}, ${uvExpr}, ${layerExpr}, ${level}${offsetSuffix})`;
    }

    return `textureSample(${name}, ${samplerName}, ${uvExpr}, ${layerExpr}${offsetSuffix})`;
}
```

**Builder integration points:**
1. `getChildren()` — add `else if (node instanceof ArrayTextureNode)` with all child nodes including `layerNode`
2. `generateExpr()` — add `else if (node instanceof ArrayTextureNode)` dispatching to `generateArrayTexture()`
3. Import `ArrayTextureNode` at top of builder

### 2e.4 — Renderer: array texture creation and upload

In `src/renderer/textures.ts`, `createGPUTexture()` and `uploadTextureData()` need array texture support.

**createGPUTexture changes:**
```typescript
const isArray = 'isArrayTexture' in texture && texture.isArrayTexture === true;

if (isArray) {
    const arrTex = texture as unknown as DataArrayTexture;
    return device.createTexture({
        size: [width, height, arrTex.depth],
        format,
        dimension: '2d', // 2D array uses dimension '2d' with depthOrArrayLayers > 1
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        mipLevelCount,
    });
}
```

**uploadTextureData changes:**
```typescript
if (isArray) {
    uploadArrayTextureData(device, texture as unknown as DataArrayTexture, data);
    return;
}
```

New function:
```typescript
function uploadArrayTextureData(
    device: GPUDevice,
    texture: DataArrayTexture,
    data: TextureData,
): void {
    const img = texture.image;
    if (!img.data) return;

    const width = img.width;
    const height = img.height;
    const depth = img.depth;
    const format = texture.format ?? 'rgba8unorm';
    const bytesPerPixel = getBytesPerPixel(format);
    const bytesPerLayer = width * height * bytesPerPixel;

    const srcData = img.data as ArrayBufferView;

    for (let layer = 0; layer < depth; layer++) {
        device.queue.writeTexture(
            { texture: data.texture, origin: { x: 0, y: 0, z: layer } },
            srcData.buffer,
            {
                offset: srcData.byteOffset + layer * bytesPerLayer,
                bytesPerRow: width * bytesPerPixel,
                rowsPerImage: height,
            },
            [width, height, 1],
        );
    }
}
```

**Renderer bind group creation** — when binding the texture view, array textures need `dimension: '2d-array'`. Check how the renderer currently creates texture views and add the dimension override. The renderer at `src/renderer/renderer.ts` (or wherever bind groups are built) needs to detect `isArrayTexture` on the source `Texture` and create the view with `{ dimension: '2d-array' }`.

### 2e.5 — Exports

In `src/index.ts`:
- Export `DataArrayTexture` from `'./texture/array-texture'`
- Export `arrayTexture` factory and `ArrayTextureNode` type from nodes

### 2e.6 — Example

Create `examples/src/example-array-texture.ts`:
- Create a `DataArrayTexture` with multiple colored layers (generated procedurally)
- Sample different layers based on some varying (e.g., fragment position, time)
- Demonstrate `.layer()`, `.level()`, `.sample()` methods

---

## Phase 2f: Remaining Texture Types

### 2f.1 — Texture3DNode

New class in `src/nodes/lib/texture.ts`:

```typescript
class Texture3DNode extends Node<d.vec4f> {
    readonly isTexture3DNode = true;

    readonly bindingNode: TextureBindingNode<d.texture3d>;

    // 3D coordinates (vec3f)
    uvNode: Node<d.vec3f> | null = null;

    referenceNode: Texture3DNode | null = null;
    samplerNode: SamplerNode<d.SamplerDesc> | null = null;

    // Sampling mode — same as TextureNode but NO offset
    samplingMode: SamplingMode = 'sample';
    levelNode: Node<d.f32> | null = null;
    biasNode: Node<d.f32> | null = null;
    gradNode: [Node<d.vec3f>, Node<d.vec3f>] | null = null; // vec3f gradients
    loadCoords: Node<d.vec3i> | null = null; // vec3i for 3D
    loadLevel: Node<d.i32> | null = null;
}
```

**Methods:** `.sample(uvw)`, `.level()`, `.bias()`, `.grad(ddx, ddy)`, `.load(coords, level?)`
**NO `.offset()`** — 3D textures don't support offset in WGSL.

**Factory:**
```typescript
export const texture3D = (tex: Data3DTexture): Texture3DNode => { ... };
```

**Builder:** `generateTexture3D()` — same pattern as `generateTexture()` but coords are vec3f, gradients are vec3f, load coords are vec3i, no offset.

**Renderer:** `createGPUTexture()` needs `dimension: '3d'` for 3D textures. `uploadTextureData()` needs to handle 3D data layout (single `writeTexture` with `depthOrArrayLayers` set to depth). Texture view needs `dimension: '3d'`.

### 2f.2 — CubeArrayTextureNode

```typescript
class CubeArrayTextureNode extends Node<d.vec4f> {
    readonly isCubeArrayTextureNode = true;

    readonly bindingNode: TextureBindingNode<d.textureCubeArray>;

    directionNode: Node<d.vec3f> | null = null;
    layerNode: Node<d.i32> | null = null; // array layer

    referenceNode: CubeArrayTextureNode | null = null;
    samplerNode: SamplerNode<d.SamplerDesc> | null = null;

    samplingMode: CubeSamplingMode = 'sample'; // same as CubeTextureNode
    levelNode: Node<d.f32> | null = null;
    biasNode: Node<d.f32> | null = null;
    gradNode: [Node<d.vec3f>, Node<d.vec3f>] | null = null;
}
```

**Methods:** `.layer()`, `.sample()`, `.level()`, `.bias()`, `.grad()`
**NO `.offset()`, NO `.load()`** — cube textures don't support these.

**WGSL arg order:**
- `textureSample(t, s, coords, array_index)`
- `textureSampleLevel(t, s, coords, array_index, level)`
- etc.

**Factory:**
```typescript
export const cubeArrayTexture = (tex: CubeArrayTexture): CubeArrayTextureNode => { ... };
```

**Resource class needed:** `CubeArrayTexture` — extends Texture, holds N×6 face images. Renderer creates with `depthOrArrayLayers: N * 6`, view dimension `'cube-array'`.

**Note:** `texture_cube_array` requires the WebGPU feature `"texture-cube-array"` — this is not universally available. The renderer should request the feature if needed, or the user should pass it. Document this limitation.

### 2f.3 — DepthCubeTextureNode

```typescript
class DepthCubeTextureNode extends Node<d.f32> {
    readonly isDepthCubeTextureNode = true;

    readonly bindingNode: TextureBindingNode<d.textureDepthCube>;

    directionNode: Node<d.vec3f> | null = null;
    referenceNode: DepthCubeTextureNode | null = null;
    samplerNode: SamplerNode<d.SamplerDesc> | null = null;

    samplingMode: 'sample' | 'level' = 'sample';
    levelNode: Node<d.i32> | null = null; // i32 for depth
}
```

**Methods:** `.sample()`, `.level()`
**NO `.offset()`, NO `.load()`, NO `.bias()`, NO `.grad()`** — depth cube constraints.

**WGSL functions:**
- `textureSample(t, s, coords)` → f32
- `textureSampleLevel(t, s, coords, level)` → f32
- `textureSampleCompare(t, s_cmp, coords, depth_ref)` → f32 (via free function)
- `textureSampleCompareLevel(t, s_cmp, coords, depth_ref, level)` → f32 (via free function)

**Factory:**
```typescript
export const depthCubeTexture = (tex: DepthTexture): DepthCubeTextureNode => { ... };
```

Uses existing `DepthTexture` resource class — the cube-ness is in how it's created (6-face depth render target). We may need a `DepthCubeTexture` resource class, or just use `DepthTexture` with a flag. **Decision: use `DepthTexture` for now** — the GPU texture creation already handles cube depth via render targets.

### 2f.4 — DepthArrayTextureNode

```typescript
class DepthArrayTextureNode extends Node<d.f32> {
    readonly isDepthArrayTextureNode = true;

    readonly bindingNode: TextureBindingNode<d.textureDepth2dArray>;

    uvNode: Node<d.vec2f>;
    layerNode: Node<d.i32> | null = null;
    referenceNode: DepthArrayTextureNode | null = null;
    samplerNode: SamplerNode<d.SamplerDesc> | null = null;

    samplingMode: DepthSamplingMode = 'sample'; // 'sample' | 'level' | 'load'
    levelNode: Node<d.i32> | null = null; // i32 for depth
    offsetNode: Node<d.vec2i> | null = null; // 2D array supports offset
    loadCoords: Node<d.vec2i> | null = null;
    loadLevel: Node<d.i32> | null = null;
}
```

**Methods:** `.layer()`, `.sample()`, `.level()`, `.offset()`, `.load()`
**NO `.bias()`, NO `.grad()`** — depth texture constraints.

**WGSL arg order (with layer):**
- `textureSample(t, s, coords, array_index)`
- `textureSampleLevel(t, s, coords, array_index, level)`
- `textureSampleCompare(t, s_cmp, coords, array_index, depth_ref)` (free function)
- `textureLoad(t, coords, array_index, level)`

**Use case:** Cascaded shadow maps (CSM).

**Factory:**
```typescript
export const depthArrayTexture = (tex: DepthTexture): DepthArrayTextureNode => { ... };
```

The `DepthTexture` resource class can represent a depth array — the GPU texture is created by the render target with multiple layers. May need a layer count property or a `DepthArrayTexture` resource class.

### 2f.5 — DepthCubeArrayTextureNode

```typescript
class DepthCubeArrayTextureNode extends Node<d.f32> {
    readonly isDepthCubeArrayTextureNode = true;

    readonly bindingNode: TextureBindingNode<d.textureDepthCubeArray>;

    directionNode: Node<d.vec3f> | null = null;
    layerNode: Node<d.i32> | null = null;
    referenceNode: DepthCubeArrayTextureNode | null = null;
    samplerNode: SamplerNode<d.SamplerDesc> | null = null;

    samplingMode: 'sample' | 'level' = 'sample';
    levelNode: Node<d.i32> | null = null;
}
```

**Methods:** `.layer()`, `.sample()`, `.level()`

**Use case:** Point light shadow arrays (one cube per light).

**Requires `"texture-cube-array"` feature** (same as CubeArrayTextureNode).

---

## Implementation Order

### Phase 2e (do first — higher practical value)

1. **ArrayTextureNode class** — add to `src/nodes/lib/texture.ts`
2. **`arrayTexture()` factory** — same file
3. **Builder changes** — `getChildren()`, `generateExpr()`, `generateArrayTexture()` in `src/nodes/builder.ts`
4. **Renderer changes** — array texture creation, upload, texture view dimension in `src/renderer/textures.ts` and `src/renderer/renderer.ts`
5. **Exports** — `DataArrayTexture`, `arrayTexture`, `ArrayTextureNode` from `src/index.ts`
6. **Example** — `examples/src/example-array-texture.ts`

### Phase 2f (do second — incremental, each type is independent)

7. **Texture3DNode + `texture3D()` + builder + renderer 3D support**
8. **DepthArrayTextureNode + `depthArrayTexture()` + builder** (CSM use case)
9. **DepthCubeTextureNode + `depthCubeTexture()` + builder** (omni shadow maps)
10. **CubeArrayTextureNode + `cubeArrayTexture()` + CubeArrayTexture resource class + builder + renderer** (requires `"texture-cube-array"` feature)
11. **DepthCubeArrayTextureNode + `depthCubeArrayTexture()` + builder** (requires `"texture-cube-array"` feature)

Steps 10 and 11 depend on the `"texture-cube-array"` feature and are lowest priority.

---

## Files to Modify

### `src/nodes/lib/texture.ts`
- Add: `ArrayTextureNode`, `Texture3DNode`, `CubeArrayTextureNode`, `DepthCubeTextureNode`, `DepthArrayTextureNode`, `DepthCubeArrayTextureNode`
- Add factories: `arrayTexture()`, `texture3D()`, `cubeArrayTexture()`, `depthCubeTexture()`, `depthArrayTexture()`, `depthCubeArrayTexture()`
- Update `TextureValueOf<D>` to handle new descriptor → resource class mappings

### `src/nodes/builder.ts`
- `getChildren()` — add branches for each new node type
- `generateExpr()` — add dispatch for each new node type
- Add: `generateArrayTexture()`, `generateTexture3D()`, `generateCubeArrayTexture()`, `generateDepthCubeTexture()`, `generateDepthArrayTexture()`, `generateDepthCubeArrayTexture()`

### `src/renderer/textures.ts`
- `createGPUTexture()` — detect array textures (`depthOrArrayLayers`), 3D textures (`dimension: '3d'`)
- `uploadTextureData()` — add array and 3D upload paths

### `src/renderer/renderer.ts`
- Texture view creation — add `dimension` overrides for array (`'2d-array'`), 3D (`'3d'`), cube-array (`'cube-array'`)

### `src/index.ts`
- Export `DataArrayTexture`, `Data3DTexture` resource classes
- Export new factories and node types

### New files (if CubeArrayTexture resource class is needed)
- `src/texture/cube-array-texture.ts` — `CubeArrayTexture` class

---

## Validation

For each new texture type:
- [ ] TypeScript compiles (`pnpm run build`)
- [ ] Builder generates correct WGSL (verify with inspector or manual check)
- [ ] Renderer creates correct GPU texture dimensions/format
- [ ] Renderer uploads data correctly
- [ ] Texture view has correct dimension
- [ ] Existing tests still pass (`pnpm test` — same pre-existing failures)
- [ ] Example renders correctly (visual check)
