# Cube feature parity: three.js WebGPU → gpucat

Current state: cube camera runs and tests pass, cube render target is clean (no generic, no back-compat alias), cube texture sampling works for basic reflection.

---

## P0 — Bug: wrong X negation in `generateCubeTexture()`

**This is very likely why the example looks misaligned.**

### Three.js `CubeTextureNode.setupUV()` (cube-texture-node.js:127-131)

```js
if (builder.renderer.coordinateSystem === WebGPUCoordinateSystem || !texture.isRenderTargetTexture) {
    uvNode = vec3(uvNode.x.negate(), uvNode.yz);
}
return materialEnvRotation.mul(uvNode);
```

The condition for WebGPU coordinate system is `true || anything` = always enters the if block. **In WebGPU mode, three.js ALWAYS negates X**, regardless of `isRenderTargetTexture`. The `!isRenderTargetTexture` sub-condition only gates the negation for WebGL.

### gpucat `generateCubeTexture()` (builder.ts:1412-1415)

```ts
const sampleDir = node.bindingNode.value?.isRenderTargetTexture
    ? `(${rawDir})`
    : `((${rawDir}) * vec3f(-1.0, 1.0, 1.0))`;
```

Only negates X when `!isRenderTargetTexture`. For `CubeRenderTarget.texture` (which has `isRenderTargetTexture = true`), **X is NOT negated**.

### Impact

The CubeCamera face directions are identical between three.js and gpucat:

| Face | three.js WebGPU | gpucat |
|------|----------------|--------|
| +X | lookAt(-1,0,0), up(0,-1,0) | dir[-1,0,0], up[0,-1,0] |
| -X | lookAt(1,0,0), up(0,-1,0) | dir[1,0,0], up[0,-1,0] |
| +Y | lookAt(0,1,0), up(0,0,1) | dir[0,1,0], up[0,0,1] |
| -Y | lookAt(0,-1,0), up(0,0,-1) | dir[0,-1,0], up[0,0,-1] |
| +Z | lookAt(0,0,1), up(0,-1,0) | dir[0,0,1], up[0,-1,0] |
| -Z | lookAt(0,0,-1), up(0,-1,0) | dir[0,0,-1], up[0,-1,0] |

Since the cubemaps are identical but the sample direction X is negated in three.js and NOT in gpucat, **the reflection is horizontally mirrored.**

### Fix

Change `generateCubeTexture()` to always negate X, matching three.js WebGPU:

```ts
const sampleDir = `((${rawDir}) * vec3f(-1.0, 1.0, 1.0))`;
```

---

## P1 — Needed for three.js parity

### 1. Auto UV direction from `CubeTexture.mapping`

**Three.js:** `getDefaultUV()` returns `reflectVector` / `refractVector` based on `texture.mapping`. This automates what the example does manually.

**gpucat gap:** `CubeTextureNode` has `directionNode` but no `getDefaultUV()`.

Not blocking the example (manual reflection works), but needed for `MeshStandardNodeMaterial`-style workflows where `envMap: cubeRenderTarget.texture` auto-samples.

**Depends on:** `positionViewDirection`, `normalView`, `.reflect()`/`.refract()`, `.transformDirection(Mat4)` — none exist in gpucat yet.

### 2. `materialEnvRotation` support

**Three.js:** `materialEnvRotation.mul(uvNode)` applies env map rotation in `setupUV()`.

**gpucat gap:** No env rotation node.

Not used in the basic example (default rotation is identity). Needed for parity.

### 3. `fromEquirectangularTexture(renderer, texture)`

**Three.js:** Converts equirectangular HDR → cubemap at runtime.

**gpucat gap:** No equivalent.

Not used in this example (loads 6 face files directly). Needed for HDR workflow parity.

**Depends on:** `equirectUV`, `positionWorldDirection`.

### 4. `CubeRenderTarget.clear(renderer, color, depth, stencil)`

**Three.js:** Iterates 6 faces calling `renderer.clear()`.

**gpucat gap:** No clear method.

Not used in this example.

### 5. `uniformCubeTexture` export

**Three.js:** TSL function for unbound cube texture node.

**gpucat gap:** Not exported. Trivial to add.

---

## P2 — Nice to have

### 6. `CubeMapNode` — auto equirect→cubemap at render time. Blocked on item 3.

### 7. `PMREMGenerator` — pre-filtered env maps. ~1000+ lines. Not needed for cube camera parity.

---

## P3 — Not blocking

| Item | Three.js | gpucat | Impact |
|------|----------|--------|--------|
| `updateCoordinateSystem()` | WebGL/WebGPU switch | Hardcoded WebGPU | None — gpucat is WebGPU-only |
| `CubeTexture extends Texture` | Subclass | Standalone | Architectural; `RenderTargetTexture` covers it |
| `SampledCubeTexture` binding | Separate class | `GpuTexture<textureCube>` | Unified binding handles it |
