# Plan: Port `webgpu_compute_particles_fluid` to gpucat

Target reference: [`three.js/examples/webgpu_compute_particles_fluid.html`](https://github.com/mrdoob/three.js/blob/master/examples/webgpu_compute_particles_fluid.html)

Goal: a 1:1 functional port in `examples/src/example-compute-fluid.ts` — same MLS-MPM fluid simulation, same GUI, same mouse interaction, flat colour material (no PBR/HDR needed).

---

## Gap analysis

| Feature | Status | Notes |
|---|---|---|
| MLS-MPM kernels (clearGrid, p2g1, p2g2, updateGrid, g2p) | Partially done | Core kernel logic is written but uses fixed dispatch counts — not indirect |
| `workgroupKernel` (writes runtime dispatch counts) | Missing | Requires indirect compute on renderer |
| `renderer.compute(node, indirectBuffer)` | **Missing** | Core blocker — does not exist anywhere in gpucat |
| `IndirectStorageBufferAttribute` exported from `src/index.ts` | Missing | One-line fix |
| `inspector.dispatchWorkgroupsIndirect()` on `InspectorBase` | Missing | Needed to keep inspector aligned |
| Dynamic `particleCount` uniform + GUI slider | Missing | Depends on indirect compute |
| Mouse interaction (raycaster + force uniforms) | Missing | Example-level only |
| Rounded-box containment | Done | Already in g2pKernel |

---

## Work breakdown

### 1 — Export `IndirectStorageBufferAttribute` from `src/index.ts`

**File:** `src/index.ts`

`IndirectStorageBufferAttribute` is defined in `src/core/attribute.ts` and used internally (for draw-indirect), but is not part of the public API. The fluid example needs to create indirect *compute* dispatch buffers of the same class.

Add to `src/index.ts`:

```ts
export { IndirectStorageBufferAttribute } from './core/attribute';
```

---

### 2 — Add `dispatchWorkgroupsIndirect` to `InspectorBase`

**File:** `src/inspector/inspector-base.ts`

`InspectorBase` has a `dispatchWorkgroups(x, y, z)` stub (line 165) used by the renderer to record compute dispatches in the timeline. The indirect path needs an equivalent.

Add below the existing `dispatchWorkgroups` stub:

```ts
dispatchWorkgroupsIndirect(_buffer: GPUBuffer, _offset: number): void {}
```

---

### 3 — Add `dispatchWorkgroupsIndirect` to the concrete `Inspector`

**File:** `src/inspector/inspector.ts`

The concrete `Inspector` overrides `dispatchWorkgroups` at line 278. Add a parallel override:

```ts
override dispatchWorkgroupsIndirect(buffer: GPUBuffer, offset: number): void {
    if (this.timeline) {
        this.timeline.onCall('dispatchWorkgroupsIndirect', `offset=${offset}`);
    }
}
```

---

### 4 — Add `computeDispatchWorkgroupsIndirect` helper + wire it into `_dispatchComputeNode`

**File:** `src/renderer/renderer.ts`

#### 4a — Add a free helper function (alongside `computeDispatchWorkgroups` at line 1783)

```ts
function computeDispatchWorkgroupsIndirect(
    pass: GPUComputePassEncoder,
    inspector: InspectorBase,
    indirectBuffer: GPUBuffer,
    offset: number,
): void {
    pass.dispatchWorkgroupsIndirect(indirectBuffer, offset);
    inspector.dispatchWorkgroupsIndirect(indirectBuffer, offset);
}
```

#### 4b — Change the signature of `_dispatchComputeNode`

Currently (line 914):
```ts
private _dispatchComputeNode(node: ComputeNode, encoder: GPUCommandEncoder): void
```

Change to:
```ts
private _dispatchComputeNode(
    node: ComputeNode,
    encoder: GPUCommandEncoder,
    indirectBuffer?: GPUBuffer,   // resolved GPUBuffer, already uploaded
    indirectOffset?: number,
): void
```

Inside the method, replace the fixed dispatch (line 977–978):
```ts
const [dx, dy, dz] = node.dispatch;
computeDispatchWorkgroups(computePass, this.inspector, dx, dy, dz);
```

With:
```ts
if (indirectBuffer) {
    computeDispatchWorkgroupsIndirect(computePass, this.inspector, indirectBuffer, indirectOffset ?? 0);
} else {
    const [dx, dy, dz] = node.dispatch;
    computeDispatchWorkgroups(computePass, this.inspector, dx, dy, dz);
}
```

#### 4c — Add `compute` overload / new `computeIndirect` public method

Add a new public method alongside the existing `compute()` at line 743:

```ts
/**
 * Encode an indirect compute dispatch. The workgroup counts are read from
 * `indirectAttr` on the GPU — no CPU-side dispatch count is needed.
 *
 * The IndirectStorageBufferAttribute must hold u32 data in the layout
 * expected by dispatchWorkgroupsIndirect: [countX, countY, countZ] at
 * `byteOffset` (default 0).
 *
 * Must be called inside a requestAnimationFrame callback, before render().
 */
computeIndirect(
    node: ComputeNode,
    indirectAttr: IndirectStorageBufferAttribute,
    byteOffset = 0,
): void {
    if (this._isDeviceLost) return;

    if (!this._initialized) {
        throw new Error('[WebGPURenderer] computeIndirect() called before init().');
    }

    const entry = pipelines.getForCompute(this.pipelines, node);
    if (!entry.pipeline) {
        throw new Error(
            `[WebGPURenderer] computeIndirect() called for node "${node.id}" before pipeline compiled.`,
        );
    }

    if (!this._frameEncoder) {
        this._frameEncoder = this.device.createCommandEncoder();
    }

    // Ensure the indirect buffer is uploaded to the GPU.
    const gpuBuf = buffers.uploadIndirect(this.buffers, indirectAttr);

    this._dispatchComputeNode(node, this._frameEncoder, gpuBuf, byteOffset);
}
```

Export `IndirectStorageBufferAttribute` in the import block at the top of `renderer.ts` so it is usable in the signature.

---

### 5 — Update `example-compute-fluid.ts` to be 1:1 with the three.js example

The existing file has the five MLS-MPM kernels partially correct. It needs the following additions/changes:

#### 5a — Indirect dispatch buffers (`workgroupKernel`)

Three.js creates three `IndirectStorageBufferAttribute` objects (one per indirectly-dispatched kernel), each holding a `[countX, 1, 1]` u32 triple, and writes to them from a tiny 1-workgroup `workgroupKernel` shader each frame.

```ts
// Each indirect dispatch buffer holds [countX, countY, countZ] as u32.
const p2g1IndirectAttr = new IndirectStorageBufferAttribute(false, new Uint32Array([1, 1, 1]));
const p2g2IndirectAttr = new IndirectStorageBufferAttribute(false, new Uint32Array([1, 1, 1]));
const g2pIndirectAttr  = new IndirectStorageBufferAttribute(false, new Uint32Array([1, 1, 1]));

// Storage nodes so the workgroupKernel can write to them.
const p2g1WorkgroupStorage = storage(p2g1IndirectAttr, d.array(d.u32), 'read_write');
const p2g2WorkgroupStorage = storage(p2g2IndirectAttr, d.array(d.u32), 'read_write');
const g2pWorkgroupStorage  = storage(g2pIndirectAttr,  d.array(d.u32), 'read_write');
```

Note: `IndirectStorageBufferAttribute` currently exists to serve *draw* indirect. We are repurposing it for *compute* indirect — the buffer layout (`[countX, countY, countZ]` u32s) happens to be valid for `dispatchWorkgroupsIndirect`. The class constructor needs to accept a `Uint32Array` directly (it already does via the `arrayOrDrawCount: Uint32Array` branch).

However, `IndirectStorageBufferAttribute.indirectStride` is hard-coded to 4 or 5 based on `indexed`. We want 3 u32s (no draw-call semantics). The simplest approach: use `indexed=false` and a `Uint32Array` of length 3 — but `false` → stride 4, which would reject length 3 (`3 % 4 !== 0`). 

**Fix needed in `IndirectStorageBufferAttribute` constructor:** add a third code path — when `arrayOrDrawCount` is a `Uint32Array` and length is not a multiple of `indirectStride`, allow it if a `rawStride` override is provided, or alternatively expose a separate `ComputeIndirectBufferAttribute` subclass.

The cleanest approach is a **new `ComputeIndirectBufferAttribute` class** in `src/core/attribute.ts`:

```ts
/**
 * A storage buffer that holds [countX, countY, countZ] u32 values for use
 * with dispatchWorkgroupsIndirect. Can be written by a compute shader and
 * consumed by renderer.computeIndirect().
 */
export class ComputeIndirectBufferAttribute extends StorageBufferAttribute {
    readonly isComputeIndirectBufferAttribute: true = true;

    constructor(initial: Uint32Array = new Uint32Array([1, 1, 1])) {
        if (initial.length !== 3) {
            throw new Error('[gpucat] ComputeIndirectBufferAttribute: array must have exactly 3 elements [countX, countY, countZ]');
        }
        super(initial, 1);
    }
}
```

Then `renderer.computeIndirect` accepts `ComputeIndirectBufferAttribute` (or a common base), and `buffers.ts` gets a `uploadComputeIndirect` helper mirroring `uploadIndirect`.

Update `renderer.computeIndirect` signature accordingly:

```ts
computeIndirect(
    node: ComputeNode,
    indirectAttr: ComputeIndirectBufferAttribute,
    byteOffset = 0,
): void
```

Export `ComputeIndirectBufferAttribute` from `src/index.ts`.

#### 5b — `workgroupKernel` shader

```ts
const workgroupKernel = Fn(() => {
    const count = particleCountUniform.sub(u32(1)).div(u32(workgroupSize)).add(u32(1));
    index(p2g1WorkgroupStorage, u32(0)).assign(count);
    index(p2g2WorkgroupStorage, u32(0)).assign(count);
    index(g2pWorkgroupStorage,  u32(0)).assign(count);
}).compute({ workgroupSize: [1, 1, 1], dispatch: [1] });
```

#### 5c — Dynamic `particleCount` + GUI

```ts
const params = { particleCount: 8192 * 4 };
const particleCountUniform = uniform(u32(params.particleCount));

// In init, after renderer is ready:
const gui = new GUI();
gui.add(params, 'particleCount', 4096, maxParticles, 4096).onChange((v: number) => {
    particleCountUniform.value = v;
    mesh.count = v;
});
```

Use `lil-gui` (already a dev dep of the examples workspace — verify with `package.json`).

#### 5d — Mouse interaction

Add three uniforms:

```ts
const mouseRayOriginUniform    = uniform(vec3f(0, 0, 0));
const mouseRayDirectionUniform = uniform(vec3f(0, 0, 0));
const mouseForceUniform        = uniform(vec3f(0, 0, 0));
```

Add raycaster setup (runs once after renderer init):

```ts
function setupMouse() {
    const raycaster = /* simple ray from camera + pointer coords */;
    const raycastPlane = /* y=0 plane */;

    renderer.domElement.addEventListener('pointermove', (e) => {
        // compute NDC from clientX/Y
        // raycaster.setFromCamera(ndc, camera)
        // offset ray origin by +0.5 on x/z to match particle space
        // copy origin + direction into uniforms
        // intersect plane → mouseCoord
    });
}
```

In the per-frame loop, compute `mouseForce = mouseCoord - prevMouseCoord`, clamp magnitude to 0.3, copy into `mouseForceUniform.value`, then update `prevMouseCoord`.

Add force term to `g2pKernel` (after gravity, before position integration):

```ts
const dist  = cross(mouseRayDirectionUniform, pos.sub(mouseRayOriginUniform)).length();
const force = dist.mul(f32(3)).oneMinus().max(f32(0)).pow(f32(2));
pVel.addAssign(mouseForceUniform.mul(force));
```

#### 5e — Frame loop

```ts
function frame() {
    // clamp dt to avoid instability when tab is backgrounded
    dtUniform.value = Math.min(1 / 60, /* delta */);

    // Compute mouse force from delta of mouse world position
    mouseForceUniform.value = /* mouseCoord - prevMouseCoord, clamped */;

    renderer.compute(workgroupKernel);
    renderer.compute(clearGridKernel);
    renderer.computeIndirect(p2g1Kernel, p2g1IndirectAttr);
    renderer.computeIndirect(p2g2Kernel, p2g2IndirectAttr);
    renderer.compute(updateGridKernel);
    renderer.computeIndirect(g2pKernel, g2pIndirectAttr);
    renderer.render(outputNode);
    requestAnimationFrame(frame);
}
```

#### 5f — Compile step

```ts
await Promise.all([
    renderer.compileCompute(workgroupKernel),
    renderer.compileCompute(clearGridKernel),
    renderer.compileCompute(p2g1Kernel),
    renderer.compileCompute(p2g2Kernel),
    renderer.compileCompute(updateGridKernel),
    renderer.compileCompute(g2pKernel),
]);
```

---

## File change summary

| File | Change |
|---|---|
| `src/core/attribute.ts` | Add `ComputeIndirectBufferAttribute` class |
| `src/index.ts` | Export `ComputeIndirectBufferAttribute`, `IndirectStorageBufferAttribute` |
| `src/inspector/inspector-base.ts` | Add `dispatchWorkgroupsIndirect` stub |
| `src/inspector/inspector.ts` | Add `dispatchWorkgroupsIndirect` override |
| `src/renderer/renderer.ts` | Add `computeIndirect()` method, `computeDispatchWorkgroupsIndirect()` helper, update `_dispatchComputeNode` signature |
| `src/renderer/buffers.ts` | Add `uploadComputeIndirect()` helper (mirrors `uploadIndirect`) |
| `examples/src/example-compute-fluid.ts` | Full rewrite: add workgroupKernel, indirect dispatch, GUI, mouse interaction, delta-time |
| `examples/src/examples.json` | Update description for `example-compute-fluid` |

---

## Implementation order

1. `ComputeIndirectBufferAttribute` in `attribute.ts`
2. Export it from `src/index.ts`
3. `uploadComputeIndirect` in `buffers.ts`
4. Inspector stubs
5. `computeIndirect()` + helpers in `renderer.ts`
6. Rewrite example
