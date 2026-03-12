# Phase 2f: Remaining Texture Types

Phases 2a–2e are complete. This document is the implementation spec for Phase 2f.

## Overview

Phase 2f adds the remaining WGSL texture types that don't have node-level support yet:

| Step | WGSL type | Node class / Feature | Factory | Use case |
|------|-----------|----------------------|---------|----------|
| 2f.0 | — | Schema narrowing + `TextureValueOf` fix | — | Prerequisite |
| 2f.1 | `texture_3d<f32>` | `Texture3DNode` | `texture3D()` | Volume rendering, 3D LUTs |
| 2f.2 | `texture_depth_2d_array` | `DepthArrayTextureNode` | `depthArrayTexture()` | Cascaded shadow maps (CSM) |
| 2f.3 | `texture_depth_cube` | `DepthCubeTextureNode` | `depthCubeTexture()` | Omnidirectional shadow maps |
| 2f.4 | `texture_cube_array<f32>` | `CubeArrayTextureNode` | `cubeArrayTexture()` | Environment probe arrays |
| 2f.5 | `texture_depth_cube_array` | `DepthCubeArrayTextureNode` | `depthCubeArrayTexture()` | Point light shadow arrays |
| 2f.6 | — | `RenderTarget` with `layers` option | — | Render to 2D array layers (CSM) |
| 2f.7 | — | `RenderTarget3D` | — | Render to 3D texture slices (volume) |

Steps 2f.4 and 2f.5 require the `"texture-cube-array"` GPU feature. Lower priority.

**RenderTarget variants (2f.6 and 2f.7):**
- **2f.6 `RenderTarget` with `layers`** — Adds `layers` option to existing `RenderTarget`. Creates 2D array textures. Renderer uses `setRenderTarget(target, layer)` to render to individual layers. Uses `baseArrayLayer` in texture view. Required for CSM.
- **2f.7 `RenderTarget3D`** — New class for rendering to 3D texture slices. Uses `depthSlice` in `GPURenderPassColorAttachment`. Required for volume rendering (e.g., voxelization, 3D fluid sim).

---

## 2f.0 — Schema Narrowing + TextureValueOf

Before adding new node types, fix the existing union types so each existing node constrains to exactly its WGSL type.

### schema.ts changes

**Narrow `FlatSampledTextureDesc`** — remove `texture2dArray` and `texture3d`:

```typescript
// Before:
export type FlatSampledTextureDesc =
    | texture1d | texture2d | texture2dArray | texture3d | textureMultisampled2d;

// After:
export type FlatSampledTextureDesc =
    | texture1d | texture2d | textureMultisampled2d;
```

**Narrow `CubeSampledTextureDesc`** — remove `textureCubeArray`:

```typescript
// Before:
export type CubeSampledTextureDesc = textureCube | textureCubeArray;

// After:
export type CubeSampledTextureDesc = textureCube;
```

**Narrow `FlatDepthTextureDesc`** — remove `textureDepth2dArray`:

```typescript
// Before:
export type FlatDepthTextureDesc = textureDepth2d | textureDepth2dArray | textureDepthMultisampled2d;

// After:
export type FlatDepthTextureDesc = textureDepth2d | textureDepthMultisampled2d;
```

**Narrow `CubeDepthTextureDesc`** — remove `textureDepthCubeArray`:

```typescript
// Before:
export type CubeDepthTextureDesc = textureDepthCube | textureDepthCubeArray;

// After:
export type CubeDepthTextureDesc = textureDepthCube;
```

**Keep broad unions unchanged** — `TextureDesc`, `DepthTextureDesc`, `AnyTextureDesc` remain as-is. These serve generic contexts (e.g. `TextureBindingNode<AnyTextureDesc>`).

### TextureValueOf update (texture.ts)

Current `TextureValueOf` is missing mappings for new texture types:

```typescript
// Before:
export type TextureValueOf<D extends AnyTextureDesc> =
    D extends DepthTextureDesc ? DepthTexture
    : D extends CubeSampledTextureDesc ? CubeTexture
    : D extends d.texture2dArray ? ArrayTexture
    : Texture;

// After:
export type TextureValueOf<D extends AnyTextureDesc> =
    D extends d.textureDepth2dArray ? DepthTexture
    : D extends d.textureDepthCube ? DepthTexture
    : D extends d.textureDepthCubeArray ? DepthTexture
    : D extends DepthTextureDesc ? DepthTexture
    : D extends d.textureCubeArray ? CubeTexture
    : D extends d.textureCube ? CubeTexture
    : D extends d.texture2dArray ? ArrayTexture
    : D extends d.texture3d ? Data3DTexture
    : Texture;
```

Order matters — specific types before their parent unions.

### Validation

After this step:
- `pnpm run build` must pass
- All existing examples type-check (`npx tsc --noEmit -p examples/tsconfig.json`)
- No runtime changes — pure type narrowing

---

## 2f.1 — Texture3DNode

### WGSL Texture Type

`texture_3d<f32>` — sampled with `vec3f` coordinates, returns `vec4<f32>`.

### Supported WGSL Operations

| WGSL function | Coords | Extra args | Offset? | Result |
|---------------|--------|------------|---------|--------|
| `textureSample(t, s, coords)` | `vec3f` | — | NO | `vec4f` |
| `textureSampleLevel(t, s, coords, level)` | `vec3f` | `level: f32` | NO | `vec4f` |
| `textureSampleBias(t, s, coords, bias)` | `vec3f` | `bias: f32` | NO | `vec4f` |
| `textureSampleGrad(t, s, coords, ddx, ddy)` | `vec3f` | `ddx: vec3f, ddy: vec3f` | NO | `vec4f` |
| `textureLoad(t, coords, level)` | `vec3i` | `level: i32` | — | `vec4f` |

3D textures do **NOT** support offset in any WGSL sampling function.

### Node Class

```typescript
class Texture3DNode extends Node<d.vec4f> {
    readonly isTexture3DNode = true;

    readonly bindingNode: TextureBindingNode<d.texture3d>;

    // 3D UV coordinates (vec3f)
    uvNode: Node<d.vec3f>;

    referenceNode: Texture3DNode | null = null;
    samplerNode: SamplerNode<d.SamplerDesc> | null = null;

    samplingMode: SamplingMode = 'sample';
    levelNode: Node<d.f32> | null = null;
    biasNode: Node<d.f32> | null = null;
    gradNode: [Node<d.vec3f>, Node<d.vec3f>] | null = null;  // vec3f gradients
    loadCoords: Node<d.vec3i> | null = null;
    loadLevel: Node<d.i32> | null = null;
}
```

**Methods:** `.sample(uvw)`, `.level(level)`, `.bias(bias)`, `.grad(ddx, ddy)`, `.load(coords, level?)`

**No `.offset()`** — 3D textures don't support it in WGSL.

The `uvNode` needs a default. Unlike 2D textures which default to `varying(uv())`, 3D textures have no natural default UV. The constructor requires a `uvNode: Node<d.vec3f>` argument (no default). Users must always provide coordinates explicitly.

### Factory

```typescript
export const texture3D = (tex: Data3DTexture, uvNode: Node<d.vec3f>): Texture3DNode => {
    const desc = d.texture3d();
    const binding = new TextureBindingNode(desc, `t${tex.id}`);
    binding.value = tex;
    const node = new Texture3DNode(binding, uvNode);
    node.samplerNode = sampler(tex, binding.groupNode);
    return node;
};
```

### Builder

**`getChildren()`** — add branch for `Texture3DNode`:
```typescript
} else if (node instanceof Texture3DNode) {
    children.push(node.bindingNode);
    if (node.samplerNode) children.push(node.samplerNode);
    if (node.uvNode) children.push(node.uvNode);
    if (node.levelNode) children.push(node.levelNode);
    if (node.biasNode) children.push(node.biasNode);
    if (node.gradNode) children.push(node.gradNode[0], node.gradNode[1]);
    if (node.loadCoords) children.push(node.loadCoords);
    if (node.loadLevel) children.push(node.loadLevel);
}
```

**`generateExpr()`** — add dispatch:
```typescript
} else if (node instanceof Texture3DNode) {
    expr = generateTexture3D(ctx, node);
}
```

**`generateTexture3D()`** — same pattern as `generateTexture()` but with vec3f coords, vec3f gradients, vec3i load coords, and no offset:

```typescript
function generateTexture3D(ctx: BuildContext, node: Texture3DNode): string {
    const binding = node.bindingNode;
    const name = generateTextureBinding(ctx, binding);

    // textureLoad mode
    if (node.samplingMode === 'load') {
        const coordsExpr = generateExpr(ctx, node.loadCoords!);
        const levelExpr = node.loadLevel ? generateExpr(ctx, node.loadLevel) : '0';
        return `textureLoad(${name}, ${coordsExpr}, ${levelExpr})`;
    }

    // Sampling modes
    let samplerNode = node.samplerNode;
    if (!samplerNode) {
        samplerNode = new SamplerNode(d.sampler, name, binding.groupNode);
        node.samplerNode = samplerNode;
    }
    const samplerName = generateSampler(ctx, samplerNode);
    const uvExpr = generateExpr(ctx, node.uvNode);

    if (node.samplingMode === 'grad') {
        const ddx = generateExpr(ctx, node.gradNode![0]);
        const ddy = generateExpr(ctx, node.gradNode![1]);
        return `textureSampleGrad(${name}, ${samplerName}, ${uvExpr}, ${ddx}, ${ddy})`;
    }

    if (node.samplingMode === 'bias') {
        const bias = generateExpr(ctx, node.biasNode!);
        return `textureSampleBias(${name}, ${samplerName}, ${uvExpr}, ${bias})`;
    }

    if (node.samplingMode === 'level') {
        const level = generateExpr(ctx, node.levelNode!);
        return `textureSampleLevel(${name}, ${samplerName}, ${uvExpr}, ${level})`;
    }

    return `textureSample(${name}, ${samplerName}, ${uvExpr})`;
}
```

### Renderer

**`src/renderer/textures.ts` — `createGPUTexture()`:**

Add 3D texture detection. 3D textures use `dimension: '3d'` in the WebGPU texture descriptor (unlike cube/array which use `'2d'` with `depthOrArrayLayers`).

```typescript
const is3D = 'is3DTexture' in texture && texture.is3DTexture === true;

if (is3D) {
    const tex3d = texture as unknown as Data3DTexture;
    const mipLevelCount = texture.generateMipmaps
        ? Math.floor(Math.log2(Math.max(width, height, tex3d.depth))) + 1
        : 1;
    return device.createTexture({
        size: [width, height, tex3d.depth],
        dimension: '3d',
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        mipLevelCount,
    });
}
```

Note: `GPUTextureUsage.RENDER_ATTACHMENT` is NOT added for 3D textures — 3D textures can't be render attachments. Mipmap generation for 3D textures is complex and skipped for now (`Data3DTexture` defaults to `generateMipmaps = false`).

**`src/renderer/textures.ts` — `uploadTextureData()`:**

Add 3D upload path. A single `writeTexture` call with full `[width, height, depth]` extent:

```typescript
if (is3D) {
    upload3DTextureData(device, texture as unknown as Data3DTexture, data);
    return;
}
```

```typescript
function upload3DTextureData(
    device: GPUDevice,
    texture: Data3DTexture,
    data: TextureData,
): void {
    const srcData = texture.image.data;
    if (!srcData) return;

    const width = texture.width;
    const height = texture.height;
    const depth = texture.depth;
    const format = texture.format ?? 'rgba8unorm';
    const bytesPerPixel = getBytesPerPixel(format);

    device.queue.writeTexture(
        { texture: data.texture },
        srcData.buffer,
        {
            offset: srcData.byteOffset,
            bytesPerRow: width * bytesPerPixel,
            rowsPerImage: height,
        },
        [width, height, depth],
    );
}
```

**`src/renderer/bindings.ts` — texture view dimension:**

Add `texture_3d` case:

```typescript
const is3D = textureNode.type.type === 'texture_3d';
// ...
if (is3D) {
    view = res.createView({ dimension: '3d' });
} else if (isCube) {
    // existing
} else if (isArray) {
    // existing
}
```

### Exports

In `src/index.ts`:
- Export `Data3DTexture` from `'./texture/texture-3d'`
- Export `texture3D` factory and `Texture3DNode` type from nodes

### Example: 3D Color LUT

Create `examples/src/example-texture-3d.ts` — a 3D color grading LUT applied to a textured quad.

```typescript
import {
    texture, texture3D,
    attribute, cameraProjectionMatrix, cameraViewMatrix,
    d, Data3DTexture, Texture,
    f32, vec3, vec4,
    Inspector, Material, Mesh,
    modelWorldMatrix, mul,
    PerspectiveCamera, renderOutput, RenderPipeline, Scene,
    uniform, varying,
    WebGPURenderer,
    type Node,
} from 'gpucat';
import { quat } from 'mathcat';

// ─── Renderer ───────────────────────────────────────────────────────────────

const renderer = new WebGPURenderer({ antialias: true });
renderer.inspector = new Inspector();
await renderer.init();

document.body.appendChild(renderer.domElement);
document.body.appendChild((renderer.inspector as Inspector).domElement);
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);

// ─── Camera ─────────────────────────────────────────────────────────────────

const camera = new PerspectiveCamera(
    Math.PI / 4,
    window.innerWidth / window.innerHeight,
    0.1,
    100,
);
camera.position = [0, 0, 3];
camera.lookAt([0, 0, 0]);

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

// ─── Create a 3D LUT texture ───────────────────────────────────────────────

const LUT_SIZE = 32;

const lutData = new Uint8Array(LUT_SIZE * LUT_SIZE * LUT_SIZE * 4);
for (let z = 0; z < LUT_SIZE; z++) {
    for (let y = 0; y < LUT_SIZE; y++) {
        for (let x = 0; x < LUT_SIZE; x++) {
            const i = (z * LUT_SIZE * LUT_SIZE + y * LUT_SIZE + x) * 4;
            // Identity LUT: output color = input coordinate
            // Then apply a color shift: boost red, reduce green
            const r = x / (LUT_SIZE - 1);
            const g = y / (LUT_SIZE - 1);
            const b = z / (LUT_SIZE - 1);
            lutData[i + 0] = Math.min(255, (r * 1.2) * 255) | 0;
            lutData[i + 1] = (g * 0.8) * 255 | 0;
            lutData[i + 2] = b * 255 | 0;
            lutData[i + 3] = 255;
        }
    }
}

const lutTexture = new Data3DTexture(lutData, LUT_SIZE, LUT_SIZE, LUT_SIZE);
lutTexture.magFilter = 'linear';
lutTexture.minFilter = 'linear';

// ─── Create a source 2D texture (procedural gradient) ───────────────────────

const TEX_SIZE = 256;
const texData = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
        const i = (y * TEX_SIZE + x) * 4;
        texData[i + 0] = (x / TEX_SIZE) * 255 | 0;
        texData[i + 1] = (y / TEX_SIZE) * 255 | 0;
        texData[i + 2] = 128;
        texData[i + 3] = 255;
    }
}
const srcTexture = new Texture({ data: texData, width: TEX_SIZE, height: TEX_SIZE });
srcTexture.magFilter = 'linear';
srcTexture.minFilter = 'linear';

// ─── Scene setup ────────────────────────────────────────────────────────────

const scene = new Scene();

// Sample the source texture, then use its RGB as coordinates into the 3D LUT
const srcColor = texture(srcTexture); // vec4f

// Use source color's RGB as UVW coordinates into the 3D LUT
const lutNode = texture3D(lutTexture, vec3(srcColor.x, srcColor.y, srcColor.z));

// Vertex transform
const position = attribute<d.vec3f>('position');
const mvp = mul(cameraProjectionMatrix, mul(cameraViewMatrix, modelWorldMatrix));
const clip = mul(mvp, vec4(position, f32(1)));

const material = new Material();
material.vertexNode = clip;
material.fragmentNode = renderOutput(vec4(lutNode.x, lutNode.y, lutNode.z, f32(1)));

const { geometry } = await import('gpucat').then(m => m.createPlaneGeometry(2, 2));
const mesh = new Mesh(geometry, material);
// plane already faces +Z (toward camera), no rotation needed
scene.add(mesh);

// ─── Render loop ────────────────────────────────────────────────────────────

const pipeline = new RenderPipeline(renderer);

function animate() {
    pipeline.render(scene, camera);
    requestAnimationFrame(animate);
}
animate();
```

This example:
- Creates a 32x32x32 3D LUT with a color shift (boosted red, reduced green)
- Creates a 2D gradient source texture
- Samples the source texture's RGB and uses it as vec3f coordinates into the 3D LUT
- Demonstrates `.sample()` implicitly via the factory's initial `uvNode` argument

### Validation

- `pnpm run build` passes
- `npx tsc --noEmit -p examples/tsconfig.json` passes
- 3D LUT example renders a color-graded gradient quad

---

## 2f.2 — DepthArrayTextureNode

### WGSL Texture Type

`texture_depth_2d_array` — depth texture with array layers. Returns `f32`.

Primary use case: **Cascaded Shadow Maps (CSM)** — one depth layer per cascade.

### Supported WGSL Operations

| WGSL function | Coords | Extra args | Offset? | Result |
|---------------|--------|------------|---------|--------|
| `textureSample(t, s, coords, array_index)` | `vec2f` | `array_index: i32` | YES | `f32` |
| `textureSampleLevel(t, s, coords, array_index, level)` | `vec2f` | `array_index: i32, level: i32` | YES | `f32` |
| `textureSampleCompare(t, s_cmp, coords, array_index, depth_ref)` | `vec2f` | `array_index: i32, depth_ref: f32` | YES | `f32` |
| `textureSampleCompareLevel(t, s_cmp, coords, array_index, depth_ref)` | `vec2f` | `array_index: i32, depth_ref: f32` | YES | `f32` |
| `textureLoad(t, coords, array_index, level)` | `vec2i` | `array_index: i32, level: i32` | — | `f32` |
| `textureGatherCompare(t, s_cmp, coords, array_index, depth_ref)` | `vec2f` | `array_index: i32, depth_ref: f32` | YES | `vec4f` |

**No `.bias()`, no `.grad()`** — depth textures don't support these.

### DepthTexture Resource Class Consideration

`DepthTexture` currently has `width`, `height`, `setSize()`, and `compareFunction`. It has no concept of array layers. For CSM we need a depth texture with N layers.

Options:
1. Add optional `depth` / `layers` to `DepthTexture`
2. Create a separate `DepthArrayTexture` class

**Decision: Add `layers` to `DepthTexture` constructor.** The DepthTexture is always a render target (created by the renderer when attaching to a RenderTarget). We add an optional `layers` parameter:

```typescript
constructor(width: number, height: number, format: DepthTextureFormat = 'depth24plus', layers: number = 1) {
    // ...existing...
    this._layers = layers;
}

get layers(): number { return this._layers; }
```

The renderer's RenderTarget attachment logic already creates the GPU texture — it just needs to use `depthOrArrayLayers: layers` when `layers > 1`. No new resource class needed.

### Node Class

```typescript
export type DepthArraySamplingMode = 'sample' | 'level' | 'load';

class DepthArrayTextureNode extends Node<d.f32> {
    readonly isDepthArrayTextureNode = true;

    readonly bindingNode: TextureBindingNode<d.textureDepth2dArray>;

    uvNode: Node<d.vec2f>;
    layerNode: Node<d.i32>;

    referenceNode: DepthArrayTextureNode | null = null;
    samplerNode: SamplerNode<d.SamplerDesc> | null = null;

    samplingMode: DepthArraySamplingMode = 'sample';
    levelNode: Node<d.i32> | null = null;        // i32 for depth textures
    offsetNode: Node<d.vec2i> | null = null;
    loadCoords: Node<d.vec2i> | null = null;
    loadLevel: Node<d.i32> | null = null;
}
```

**Methods:** `.layer(layerNode)`, `.sample(uvNode)`, `.level(levelNode)`, `.offset(offsetNode)`, `.load(coords, level?)`

**No `.bias()`, no `.grad()`** — depth textures don't support these.

### Factory

```typescript
export const depthArrayTexture = (
    tex: DepthTexture,
    layerNode: Node<d.i32>,
): DepthArrayTextureNode => {
    const desc = d.textureDepth2dArray;
    const binding = new TextureBindingNode(desc, `t${tex.id}`);
    binding.value = tex;
    const node = new DepthArrayTextureNode(binding, layerNode);
    node.samplerNode = sampler(tex, binding.groupNode);
    return node;
};
```

### Builder: `generateDepthArrayTexture()`

Same pattern as `generateArrayTexture()` but:
- Result type is `f32` (not vec4f)
- Level is `i32` (not f32)
- No bias or grad modes

```typescript
function generateDepthArrayTexture(ctx: BuildContext, node: DepthArrayTextureNode): string {
    const binding = node.bindingNode;
    const name = generateTextureBinding(ctx, binding);
    const layerExpr = generateExpr(ctx, node.layerNode);

    if (node.samplingMode === 'load') {
        const coordsExpr = generateExpr(ctx, node.loadCoords!);
        const levelExpr = node.loadLevel ? generateExpr(ctx, node.loadLevel) : '0';
        return `textureLoad(${name}, ${coordsExpr}, ${layerExpr}, ${levelExpr})`;
    }

    let samplerNode = node.samplerNode;
    if (!samplerNode) {
        samplerNode = new SamplerNode(d.sampler, name, binding.groupNode);
        node.samplerNode = samplerNode;
    }
    const samplerName = generateSampler(ctx, samplerNode);
    const uvExpr = generateExpr(ctx, node.uvNode);
    const offsetSuffix = node.offsetNode ? `, ${generateExpr(ctx, node.offsetNode)}` : '';

    if (node.samplingMode === 'level') {
        const level = generateExpr(ctx, node.levelNode!);
        return `textureSampleLevel(${name}, ${samplerName}, ${uvExpr}, ${layerExpr}, ${level}${offsetSuffix})`;
    }

    return `textureSample(${name}, ${samplerName}, ${uvExpr}, ${layerExpr}${offsetSuffix})`;
}
```

### Renderer Changes

**`src/renderer/bindings.ts`** — add `'texture_depth_2d_array'` to the `isArray` check:

```typescript
const isArray = textureNode.type.type === 'texture_2d_array'
    || textureNode.type.type === 'texture_depth_2d_array';
```

**`src/renderer/textures.ts`** — depth array textures are render targets, so `createGPUTexture()` and `uploadTextureData()` don't apply. The GPU texture is created by the RenderTarget when it detects a multi-layer depth attachment. We need to update the RenderTarget's depth attachment creation to use `depthOrArrayLayers: tex.layers`.

### Comparison Sampling (Free Functions)

Comparison sampling for depth array textures uses these overloads:

```typescript
// textureSampleCompare — depth 2D array
export function textureSampleCompare(
    t: TextureBindingNode<d.textureDepth2dArray>,
    s: AnyComparisonSamplerNode,
    coords: Node<d.vec2f>,
    arrayIndex: Node<d.i32>,
    depthRef: Node<d.f32>,
    offset?: Node<d.vec2i>
): CallNode<d.f32>;

// textureSampleCompareLevel — depth 2D array
export function textureSampleCompareLevel(
    t: TextureBindingNode<d.textureDepth2dArray>,
    s: AnyComparisonSamplerNode,
    coords: Node<d.vec2f>,
    arrayIndex: Node<d.i32>,
    depthRef: Node<d.f32>,
    offset?: Node<d.vec2i>
): CallNode<d.f32>;

// textureGatherCompare — depth 2D array
export function textureGatherCompare(
    t: TextureBindingNode<d.textureDepth2dArray>,
    s: AnyComparisonSamplerNode,
    coords: Node<d.vec2f>,
    arrayIndex: Node<d.i32>,
    depthRef: Node<d.f32>,
    offset?: Node<d.vec2i>
): CallNode<d.vec4f>;
```

These are critical for the CSM use case — users need to do comparison shadow testing per cascade layer.

### Example: Cascaded Shadow Maps

Create `examples/src/example-csm.ts` — three cascade depth layers with visualization.

This example is complex (needs multiple render passes with per-cascade light cameras). The core pattern is:

```typescript
const CASCADES = 3;
const SHADOW_SIZE = 1024;

// Create a multi-layer depth texture
const shadowTex = new DepthTexture(SHADOW_SIZE, SHADOW_SIZE, 'depth32float', CASCADES);
shadowTex.compareFunction = 'less';

// In the fragment shader: select cascade based on depth
const cascadeIndex = uniform(i32(0)); // or computed from fragment depth
const shadowNode = depthArrayTexture(shadowTex, cascadeIndex);

// Comparison sampling with the comparison sampler
const cmpSamp = comparisonSampler(shadowTex, 'less');
const shadowResult = textureSampleCompare(
    shadowNode.bindingNode, cmpSamp, shadowUV, cascadeIndex, fragmentDepth
);
```

Full example deferred to implementation time — depends on RenderTarget multi-layer support.

---

## 2f.3 — DepthCubeTextureNode

### WGSL Texture Type

`texture_depth_cube` — cube depth texture. Returns `f32`.

Primary use case: **Omnidirectional point light shadow maps** — render 6 faces of a cube depth map, sample with a direction vector.

### Supported WGSL Operations

| WGSL function | Coords | Extra args | Offset? | Result |
|---------------|--------|------------|---------|--------|
| `textureSample(t, s, coords)` | `vec3f` | — | NO | `f32` |
| `textureSampleLevel(t, s, coords, level)` | `vec3f` | `level: i32` | NO | `f32` |
| `textureSampleCompare(t, s_cmp, coords, depth_ref)` | `vec3f` | `depth_ref: f32` | NO | `f32` |
| `textureSampleCompareLevel(t, s_cmp, coords, depth_ref)` | `vec3f` | `depth_ref: f32` | NO | `f32` |
| `textureGatherCompare(t, s_cmp, coords, depth_ref)` | `vec3f` | `depth_ref: f32` | NO | `vec4f` |

**No `.offset()`, no `.load()`, no `.bias()`, no `.grad()`.**

### Node Class

```typescript
export type DepthCubeSamplingMode = 'sample' | 'level';

class DepthCubeTextureNode extends Node<d.f32> {
    readonly isDepthCubeTextureNode = true;

    readonly bindingNode: TextureBindingNode<d.textureDepthCube>;

    directionNode: Node<d.vec3f>;

    referenceNode: DepthCubeTextureNode | null = null;
    samplerNode: SamplerNode<d.SamplerDesc> | null = null;

    samplingMode: DepthCubeSamplingMode = 'sample';
    levelNode: Node<d.i32> | null = null;  // i32 for depth
}
```

**Methods:** `.sample(directionNode)`, `.level(levelNode)`

### Factory

```typescript
export const depthCubeTexture = (
    tex: DepthTexture,
    directionNode: Node<d.vec3f>,
): DepthCubeTextureNode => {
    const desc = d.textureDepthCube;
    const binding = new TextureBindingNode(desc, `t${tex.id}`);
    binding.value = tex;
    const node = new DepthCubeTextureNode(binding, directionNode);
    node.samplerNode = sampler(tex, binding.groupNode);
    return node;
};
```

### Builder: `generateDepthCubeTexture()`

```typescript
function generateDepthCubeTexture(ctx: BuildContext, node: DepthCubeTextureNode): string {
    const binding = node.bindingNode;
    const name = generateTextureBinding(ctx, binding);

    let samplerNode = node.samplerNode;
    if (!samplerNode) {
        samplerNode = new SamplerNode(d.sampler, name, binding.groupNode);
        node.samplerNode = samplerNode;
    }
    const samplerName = generateSampler(ctx, samplerNode);
    const dirExpr = generateExpr(ctx, node.directionNode);

    if (node.samplingMode === 'level') {
        const level = generateExpr(ctx, node.levelNode!);
        return `textureSampleLevel(${name}, ${samplerName}, ${dirExpr}, ${level})`;
    }

    return `textureSample(${name}, ${samplerName}, ${dirExpr})`;
}
```

### Renderer Changes

The existing bind group code at `src/renderer/bindings.ts:643` already handles `texture_depth_cube` — it's in the `isCube` check. No renderer changes needed.

The GPU texture for a depth cube is created by the RenderTarget (6-face depth render target). No changes to `createGPUTexture()` needed.

### Comparison Sampling (Free Functions)

```typescript
// textureSampleCompare — depth cube
export function textureSampleCompare(
    t: TextureBindingNode<d.textureDepthCube>,
    s: AnyComparisonSamplerNode,
    coords: Node<d.vec3f>,
    depthRef: Node<d.f32>,
): CallNode<d.f32>;

// textureSampleCompareLevel — depth cube
export function textureSampleCompareLevel(
    t: TextureBindingNode<d.textureDepthCube>,
    s: AnyComparisonSamplerNode,
    coords: Node<d.vec3f>,
    depthRef: Node<d.f32>,
): CallNode<d.f32>;
```

### Example: Omni Shadow Map

```typescript
const SHADOW_SIZE = 512;

// 6-face depth cube texture
const shadowCubeTex = new DepthTexture(SHADOW_SIZE, SHADOW_SIZE, 'depth32float');
shadowCubeTex.compareFunction = 'less';

// Direction from fragment to light
const fragToLight = /* compute from fragment world pos and light pos */;

const shadowCube = depthCubeTexture(shadowCubeTex, fragToLight);

// Regular sampling reads the depth value
const depthValue = shadowCube; // f32

// Comparison sampling for shadow test
const cmpSamp = comparisonSampler(shadowCubeTex, 'less');
const shadow = textureSampleCompare(
    shadowCube.bindingNode, cmpSamp, fragToLight, fragmentDistance
);
```

---

## 2f.4 — CubeArrayTextureNode

### WGSL Texture Type

`texture_cube_array<f32>` — requires `"texture-cube-array"` GPU feature. Returns `vec4f`.

### Supported WGSL Operations

| WGSL function | Coords | Extra args | Offset? | Result |
|---------------|--------|------------|---------|--------|
| `textureSample(t, s, coords, array_index)` | `vec3f` | `array_index: i32` | NO | `vec4f` |
| `textureSampleLevel(t, s, coords, array_index, level)` | `vec3f` | `array_index: i32, level: f32` | NO | `vec4f` |
| `textureSampleBias(t, s, coords, array_index, bias)` | `vec3f` | `array_index: i32, bias: f32` | NO | `vec4f` |
| `textureSampleGrad(t, s, coords, array_index, ddx, ddy)` | `vec3f` | `array_index: i32, ddx: vec3f, ddy: vec3f` | NO | `vec4f` |

**No `.offset()`, no `.load()`.**

### Resource Class: CubeArrayTexture

Need a new resource class — `CubeTexture` holds exactly 6 faces, but a cube array holds N×6 faces.

Create `src/texture/cube-array-texture.ts`:

```typescript
export class CubeArrayTexture extends Texture {
    readonly isCubeArrayTexture = true;

    /** Number of cube layers */
    private _layerCount: number;

    /** Per-layer face image sources (layer × 6 faces) */
    readonly layerSources: Source[][];  // [layer][face]

    constructor(layerCount: number, width: number, height: number) {
        super({ width, height });
        this._layerCount = layerCount;
        this.layerSources = Array.from({ length: layerCount }, () =>
            Array.from({ length: 6 }, () => new Source({ data: null, width, height }))
        );
    }

    get layerCount(): number { return this._layerCount; }

    /** Total array layers for GPU texture = layerCount * 6 */
    get depthOrArrayLayers(): number { return this._layerCount * 6; }
}
```

### Node Class

```typescript
class CubeArrayTextureNode extends Node<d.vec4f> {
    readonly isCubeArrayTextureNode = true;

    readonly bindingNode: TextureBindingNode<d.textureCubeArray>;

    directionNode: Node<d.vec3f>;
    layerNode: Node<d.i32>;

    referenceNode: CubeArrayTextureNode | null = null;
    samplerNode: SamplerNode<d.SamplerDesc> | null = null;

    samplingMode: CubeSamplingMode = 'sample';  // reuse from CubeTextureNode
    levelNode: Node<d.f32> | null = null;
    biasNode: Node<d.f32> | null = null;
    gradNode: [Node<d.vec3f>, Node<d.vec3f>] | null = null;
}
```

**Methods:** `.layer(layerNode)`, `.sample(directionNode)`, `.level(levelNode)`, `.bias(biasNode)`, `.grad(ddx, ddy)`

### Factory

```typescript
export const cubeArrayTexture = (
    tex: CubeArrayTexture,
    layerNode: Node<d.i32>,
    directionNode: Node<d.vec3f>,
): CubeArrayTextureNode => { ... };
```

### Renderer Changes

- `createGPUTexture()` — detect `isCubeArrayTexture`, use `depthOrArrayLayers: layerCount * 6`
- Bind group — `texture_cube_array` is already in the `isCube` check... but it creates a `'cube'` view. Need `'cube-array'` view instead. Split the check:

```typescript
const isCubeArray = textureNode.type.type === 'texture_cube_array'
    || textureNode.type.type === 'texture_depth_cube_array';
const isCube = !isCubeArray && (textureNode.type.type === 'texture_cube'
    || textureNode.type.type === 'texture_depth_cube');

if (isCubeArray) {
    view = res.createView({ dimension: 'cube-array' });
} else if (isCube) {
    view = res.createView({ dimension: 'cube' });
}
```

### Feature Requirement

`texture_cube_array` requires `"texture-cube-array"` in the WebGPU adapter features. Either:
- The user requests it in `WebGPURenderer` options
- Or the renderer checks for it and warns

For now, document that the user must request the feature. No auto-detection.

---

## 2f.5 — DepthCubeArrayTextureNode

### WGSL Texture Type

`texture_depth_cube_array` — requires `"texture-cube-array"` GPU feature. Returns `f32`.

### Supported WGSL Operations

| WGSL function | Coords | Extra args | Offset? | Result |
|---------------|--------|------------|---------|--------|
| `textureSample(t, s, coords, array_index)` | `vec3f` | `array_index: i32` | NO | `f32` |
| `textureSampleLevel(t, s, coords, array_index, level)` | `vec3f` | `array_index: i32, level: i32` | NO | `f32` |
| `textureSampleCompare(t, s_cmp, coords, array_index, depth_ref)` | `vec3f` | `array_index: i32, depth_ref: f32` | NO | `f32` |
| `textureSampleCompareLevel(t, s_cmp, coords, array_index, depth_ref)` | `vec3f` | `array_index: i32, depth_ref: f32` | NO | `f32` |

### Node Class

```typescript
export type DepthCubeArraySamplingMode = 'sample' | 'level';

class DepthCubeArrayTextureNode extends Node<d.f32> {
    readonly isDepthCubeArrayTextureNode = true;

    readonly bindingNode: TextureBindingNode<d.textureDepthCubeArray>;

    directionNode: Node<d.vec3f>;
    layerNode: Node<d.i32>;

    referenceNode: DepthCubeArrayTextureNode | null = null;
    samplerNode: SamplerNode<d.SamplerDesc> | null = null;

    samplingMode: DepthCubeArraySamplingMode = 'sample';
    levelNode: Node<d.i32> | null = null;  // i32 for depth
}
```

**Methods:** `.layer(layerNode)`, `.sample(directionNode)`, `.level(levelNode)`

### Factory

```typescript
export const depthCubeArrayTexture = (
    tex: DepthTexture,
    layerNode: Node<d.i32>,
    directionNode: Node<d.vec3f>,
): DepthCubeArrayTextureNode => { ... };
```

### Comparison Sampling

```typescript
export function textureSampleCompare(
    t: TextureBindingNode<d.textureDepthCubeArray>,
    s: AnyComparisonSamplerNode,
    coords: Node<d.vec3f>,
    arrayIndex: Node<d.i32>,
    depthRef: Node<d.f32>,
): CallNode<d.f32>;
```

---

## 2f.6 — RenderTarget with `layers` Option

### Purpose

Enable rendering to individual layers of a 2D array texture. Required for CSM (render each cascade to a separate layer).

### API Changes

**`RenderTargetOptions`:**

```typescript
export type RenderTargetOptions = {
    colorFormat?: GPUTextureFormat;
    depthFormat?: DepthTextureFormat | null;
    samples?: number;
    count?: number;
    layers?: number;  // NEW: array layer count (default 1)
};
```

**`DepthTexture`:**

```typescript
constructor(width: number, height: number, format: DepthTextureFormat = 'depth24plus', layers: number = 1)

get layers(): number
```

**`Texture`** (for color attachments):

Add `layers` property. When `layers > 1`, the texture is a 2D array.

### Renderer Changes

**`_ensureRenderTargetAllocated()` in `renderer.ts`:**

When creating depth texture:
```typescript
const depthOrArrayLayers = depthTexture.layers > 1 ? depthTexture.layers : 1;
const gpuTexture = device.createTexture({
    size: [width, height, depthOrArrayLayers],
    format: depthTexture.format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    // dimension is '2d' (default) — depthOrArrayLayers makes it an array
});
```

When creating color textures (if `layers > 1`):
```typescript
const gpuTexture = device.createTexture({
    size: [width, height, layers],
    format: colorFormat,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});
```

**`setRenderTarget(target, layer?)` in `renderer.ts`:**

```typescript
private _activeLayer: number = 0;

setRenderTarget(target: RenderTarget | null, layer: number = 0): void {
    this._renderTarget = target;
    this._activeLayer = layer;
}
```

**Render pass creation:**

When creating depth/color attachment views, use per-layer views:

```typescript
// Depth attachment view
const depthView = depthTexture.gpuTexture!.createView({
    dimension: '2d',
    baseArrayLayer: this._activeLayer,
    arrayLayerCount: 1,
});

// Color attachment view
const colorView = colorTexture.gpuTexture!.createView({
    dimension: '2d',
    baseArrayLayer: this._activeLayer,
    arrayLayerCount: 1,
});
```

### Usage Pattern (CSM)

```typescript
const CASCADES = 4;
const SHADOW_SIZE = 2048;

// Create render target with depth array
const shadowTarget = new RenderTarget(SHADOW_SIZE, SHADOW_SIZE, {
    colorFormat: null,  // depth-only
    depthFormat: 'depth32float',
    layers: CASCADES,
});

// Render each cascade
for (let i = 0; i < CASCADES; i++) {
    renderer.setRenderTarget(shadowTarget, i);
    renderer.render(scene, cascadeCameras[i]);
}
renderer.setRenderTarget(null);

// Sample in main pass
const cascadeIndex = /* compute from fragment depth */;
const shadow = depthArrayTexture(shadowTarget.depthTexture!, cascadeIndex);
```

---

## 2f.7 — RenderTarget3D

### Purpose

Enable rendering to individual Z slices of a 3D texture. Uses WebGPU's `depthSlice` in `GPURenderPassColorAttachment`. Required for volume rendering techniques like voxelization, 3D fluid simulation, light propagation volumes.

### Class

Create `src/core/render-target-3d.ts`:

```typescript
import { Data3DTexture } from '../texture/texture-3d';
import { DepthTexture, type DepthTextureFormat } from '../texture/depth-texture';

export type RenderTarget3DOptions = {
    colorFormat?: GPUTextureFormat;
    depthFormat?: DepthTextureFormat | null;  // per-slice 2D depth
};

export class RenderTarget3D {
    readonly isRenderTarget3D = true;

    width: number;
    height: number;
    depth: number;

    readonly colorFormat: GPUTextureFormat;
    readonly depthFormat: DepthTextureFormat | null;

    /** 3D color texture */
    texture: Data3DTexture;

    /** 2D depth texture (shared across slices, or null) */
    depthTexture: DepthTexture | null = null;

    constructor(width: number, height: number, depth: number, opts: RenderTarget3DOptions = {}) {
        this.width = width;
        this.height = height;
        this.depth = depth;
        this.colorFormat = opts.colorFormat ?? 'rgba16float';
        this.depthFormat = opts.depthFormat !== undefined ? opts.depthFormat : 'depth24plus';

        // Create 3D color texture
        this.texture = new Data3DTexture(null, width, height, depth);
        this.texture.format = this.colorFormat;
        this.texture.isRenderTargetTexture = true;
        this.texture.renderTarget = this;
        this.texture.generateMipmaps = false;

        // Create 2D depth texture (shared for all slices)
        if (this.depthFormat) {
            this.depthTexture = new DepthTexture(width, height, this.depthFormat);
            this.depthTexture.name = 'depth';
            this.depthTexture.renderTarget = this;
        }
    }

    setSize(width: number, height: number, depth: number): void {
        if (this.width === width && this.height === height && this.depth === depth) return;
        this.dispose();
        this.width = width;
        this.height = height;
        this.depth = depth;
        // Update texture dimensions...
    }

    dispose(): void {
        this.texture.gpuTexture?.destroy();
        this.texture.gpuTexture = null;
        this.depthTexture?.gpuTexture?.destroy();
        if (this.depthTexture) this.depthTexture.gpuTexture = null;
    }
}
```

### Renderer Changes

**`_ensureRenderTarget3DAllocated()` in `renderer.ts`:**

```typescript
private _ensureRenderTarget3DAllocated(target: RenderTarget3D): void {
    const { width, height, depth, colorFormat, depthFormat } = target;

    // Create 3D color texture
    if (!target.texture.gpuTexture) {
        target.texture.gpuTexture = this._device.createTexture({
            size: [width, height, depth],
            dimension: '3d',
            format: colorFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
    }

    // Create 2D depth texture (not 3D — WebGPU doesn't support 3D depth)
    if (depthFormat && target.depthTexture && !target.depthTexture.gpuTexture) {
        target.depthTexture.gpuTexture = this._device.createTexture({
            size: [width, height, 1],
            format: depthFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
    }
}
```

**`setRenderTarget()` overload:**

```typescript
setRenderTarget(target: RenderTarget3D, slice: number): void;
setRenderTarget(target: RenderTarget | null, layer?: number): void;
setRenderTarget(target: RenderTarget | RenderTarget3D | null, layerOrSlice: number = 0): void {
    if (target && 'isRenderTarget3D' in target) {
        this._renderTarget3D = target;
        this._renderTarget = null;
        this._activeSlice = layerOrSlice;
    } else {
        this._renderTarget = target;
        this._renderTarget3D = null;
        this._activeLayer = layerOrSlice;
    }
}
```

**Render pass creation for RenderTarget3D:**

Use `depthSlice` instead of `baseArrayLayer`:

```typescript
if (this._renderTarget3D) {
    const target = this._renderTarget3D;
    this._ensureRenderTarget3DAllocated(target);

    // 3D texture view (full volume)
    const colorView = target.texture.gpuTexture!.createView({
        dimension: '3d',
    });

    colorAttachments.push({
        view: colorView,
        depthSlice: this._activeSlice,  // WebGPU's 3D slice selection
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
    });

    // 2D depth (shared across slices)
    if (target.depthTexture?.gpuTexture) {
        depthStencilAttachment = {
            view: target.depthTexture.gpuTexture.createView(),
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
            depthClearValue: 1.0,
        };
    }
}
```

### Usage Pattern (Voxelization)

```typescript
const VOXEL_SIZE = 128;

const voxelTarget = new RenderTarget3D(VOXEL_SIZE, VOXEL_SIZE, VOXEL_SIZE, {
    colorFormat: 'rgba8unorm',
    depthFormat: null,  // no depth for voxelization
});

// Render each slice (or use geometry shader / conservative rasterization)
for (let z = 0; z < VOXEL_SIZE; z++) {
    renderer.setRenderTarget(voxelTarget, z);
    renderer.render(scene, sliceCamera);
}
renderer.setRenderTarget(null);

// Sample the voxel volume
const voxelNode = texture3D(voxelTarget.texture, worldPos);
```

### WebGPU Constraints

- **No 3D depth textures** — WebGPU doesn't support `dimension: '3d'` for depth formats. The depth texture is 2D and shared across slices.
- **`depthSlice` requires 3D view** — The color attachment view must have `dimension: '3d'`.
- **No MSAA for 3D** — WebGPU doesn't support multisampled 3D textures.

---

## Implementation Order

1. **2f.0 — Schema narrowing + TextureValueOf** (pure type changes, no runtime)
2. **2f.1 — Texture3DNode** (highest practical value — 3D LUTs, volume rendering)
3. **2f.6 — RenderTarget with `layers`** (prerequisite for 2f.2)
4. **2f.2 — DepthArrayTextureNode** (CSM — depends on 2f.6)
5. **2f.3 — DepthCubeTextureNode** (omni shadows — moderate practical value)
6. **2f.7 — RenderTarget3D** (enables 3D texture generation)
7. **2f.4 — CubeArrayTextureNode** (requires GPU feature — lower priority)
8. **2f.5 — DepthCubeArrayTextureNode** (requires GPU feature — lowest priority)

**Dependencies:**
- 2f.2 depends on 2f.6 (need `RenderTarget` with `layers` to create depth arrays)
- 2f.7 depends on 2f.1 (uses `Data3DTexture` from Texture3DNode work)
- 2f.4 and 2f.5 require `"texture-cube-array"` GPU feature and `CubeArrayTexture` resource class

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/nodes/schema.ts` | Narrow `FlatSampledTextureDesc`, `CubeSampledTextureDesc`, `FlatDepthTextureDesc`, `CubeDepthTextureDesc` |
| `src/nodes/lib/texture.ts` | Add `Texture3DNode`, `DepthArrayTextureNode`, `DepthCubeTextureNode`, `CubeArrayTextureNode`, `DepthCubeArrayTextureNode` + factories. Update `TextureValueOf<D>`. Add free function overloads. |
| `src/nodes/builder.ts` | `getChildren()` branches, `generateExpr()` dispatches, `generateTexture3D()`, `generateDepthArrayTexture()`, `generateDepthCubeTexture()`, `generateCubeArrayTexture()`, `generateDepthCubeArrayTexture()` |
| `src/renderer/textures.ts` | 3D texture creation (`dimension: '3d'`), 3D texture upload (`upload3DTextureData()`) |
| `src/renderer/bindings.ts` | Add `'texture_3d'` → `'3d'` view, `'texture_depth_2d_array'` → `'2d-array'` view, split cube/cube-array view dimension |
| `src/renderer/renderer.ts` | Add `_activeLayer`, `_activeSlice`, `setRenderTarget()` overloads, per-layer/slice view creation, `_ensureRenderTarget3DAllocated()` |
| `src/core/render-target.ts` | Add `layers` option to `RenderTargetOptions`, update color/depth texture creation |
| `src/core/render-target-3d.ts` | **NEW** — `RenderTarget3D` class for rendering to 3D texture slices |
| `src/texture/depth-texture.ts` | Add optional `layers` parameter |
| `src/texture/texture.ts` | Add optional `layers` property for array textures |
| `src/texture/cube-array-texture.ts` | **NEW** — `CubeArrayTexture` resource class (for 2f.4) |
| `src/index.ts` | Export `Data3DTexture`, `CubeArrayTexture`, `RenderTarget3D`, new factories and node types |
| `examples/src/example-texture-3d.ts` | **NEW** — 3D color LUT example |
| `examples/src/example-csm.ts` | **NEW** — Cascaded shadow maps example (optional, complex) |
| `examples/src/examples.json` | Register new examples |

---

## Validation Checklist (per step)

- [ ] `pnpm run build` passes
- [ ] `npx tsc --noEmit -p examples/tsconfig.json` passes
- [ ] Builder generates correct WGSL (inspect with `Inspector`)
- [ ] Renderer creates correct GPU texture dimensions/format/dimension
- [ ] Bind group texture view has correct dimension
- [ ] Example renders correctly (visual check)
