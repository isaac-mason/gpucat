# gpucat Compute API

This document describes the compute shader API in gpucat. The design is inspired
by three.js TSL's `ComputeNode` pattern, but follows WebGPU spec naming
conventions more closely (`global_invocation_id`, `workgroup_id`, etc.) and uses
an **explicit imperative dispatch model** rather than auto-discovery via the
render graph.

---

## Overview

The compute API lets you dispatch a `@compute` shader that writes to one or more
storage buffers, then consume those buffers in the same-frame render pass.  
You compile and dispatch compute nodes explicitly; the renderer shares a single
`GPUCommandEncoder` between compute and render passes so everything submits in
one command buffer per frame.

```
storageArray(...)
       │
       ▼
compute({ body, dispatch, storage })
       │
  renderer.compile(node)   ← async, pre-warms the pipeline
  renderer.compute(node)   ← synchronous dispatch
       │
  storage buffer written ──► used in vertex / fragment shader
```

---

## Quick start

```ts
import * as gpu from 'gpucat';
import * as S from 'gpucat/schema';

const N = 4096;

// 1. Allocate a storage buffer (zero-initialised)
const positions = gpu.storageArray(N, S.array(S.vec4f()), 'read_write');

// 2. Define the compute kernel
const updatePositions = gpu.compute({
    workgroupSize: [64, 1, 1],
    dispatch:      [Math.ceil(N / 64)],
    storage:       [positions],
    body({ globalId }) {
        const idx = gpu.toVar('u32', globalId.x, 'idx');
        const pos = gpu.toVar('vec4f', gpu.index('vec4f', positions, idx), 'pos');
        gpu.index('vec4f', positions, idx).assign(
            gpu.vec4(pos.x, gpu.add(pos.y, gpu.float(0.001)), pos.z, gpu.float(1.0))
        );
    },
});

// 3. Initialise device and compile the pipeline
await renderer.init();
await renderer.compile(updatePositions);

// 4. Per-frame: dispatch compute then render
function frame() {
    renderer.compute(updatePositions);
    renderer.render(outputNode);      // outputNode reads from `positions`
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

---

## API reference

### `compute(opts: ComputeNodeOptions): ComputeNode`

Creates a `ComputeNode` that wraps a compute kernel body. The body callback is
traced (executed once at JS time with placeholder builtin nodes) by the compiler
— the same tracing mechanism used by `Fn()`.

```ts
type ComputeNodeOptions = {
    /** Workgroup size [x, y, z]. Default: [64, 1, 1]. */
    workgroupSize?: [number, number, number];

    /** Dispatch dimensions — number of workgroups. Trailing 1s may be omitted. */
    dispatch: [number, number, number] | [number, number] | [number];

    /** Storage buffers read or written by this kernel. Bound at group 0. */
    storage: StorageNode<WgslType>[];

    /** Body callback traced at compile time. Use DSL helpers inside. */
    body: (builtins: ComputeBuiltins) => void;
};
```

`ComputeNode` is a plain class — it does **not** extend `Node` and cannot be
used directly inside the render graph. Use the storage buffers it writes to link
compute results into your materials.

**Binding layout** — all `storage` entries are bound at `@group(0)`, with
`binding` indices matching their position in the `storage` array. No camera,
time, or mesh UBOs are present.

---

### `renderer.compile(node: ComputeNode): Promise<void>`

Pre-warms the compute pipeline for a given node. Resolves when the
`GPUComputePipeline` is ready. No-op if the pipeline is already compiled.

Requires `renderer.init()` to have been called first.

```ts
await renderer.init();
await renderer.compile(myKernel);  // pipeline compiled and cached
renderer.compute(myKernel);        // guaranteed to dispatch immediately
```

---

### `renderer.compute(node: ComputeNode): void`

Synchronous dispatch — encodes the compute pass into the current frame's
`GPUCommandEncoder`. If called before `renderer.render()` in the same frame,
the compute and render passes share one command buffer.

**Throws** if `init()` has not been called.  
**Throws** if the pipeline is not yet compiled — always call
`renderer.compile(node)` before dispatching.

```ts
// One-shot initialisation pattern
await renderer.init();
await renderer.compile(initKernel);
renderer.compute(initKernel);        // runs once, no render pass

// Per-frame pattern
function frame() {
    renderer.compute(updateKernel);  // encode compute pass
    renderer.render(outputNode);     // encode render pass; submits both
    requestAnimationFrame(frame);
}
```

> When `renderer.compute()` is called first, the encoder is held open.
> `renderer.render()` picks it up, appends the render pass, then submits.
> The encoder is reset to `null` after each submit so the next frame starts
> clean.

---

### `ComputeBuiltins`

Provided to the `body` callback. Only builtins actually used in the body are
emitted as `@compute` entry point parameters.

| Property | WGSL builtin | Type |
|---|---|---|
| `globalId` | `@builtin(global_invocation_id)` | `vec3u` |
| `localId` | `@builtin(local_invocation_id)` | `vec3u` |
| `localIndex` | `@builtin(local_invocation_index)` | `u32` |
| `workgroupId` | `@builtin(workgroup_id)` | `vec3u` |
| `numWorkgroups` | `@builtin(num_workgroups)` | `vec3u` |

Standalone helpers available as named exports:

```ts
import { globalId, localId, localIndex, workgroupId, numWorkgroups } from 'gpucat';
```

---

### `compileCompute(node: ComputeNode): ComputeCompileResult`

Pure function — traces the body once and emits a complete WGSL compute module.
Can be used offline (no WebGPU device required).

```ts
type ComputeCompileResult = {
    code: string;                       // complete WGSL module
    storage: ComputeStorageEntry[];     // binding metadata
    workgroupSize: [number, number, number];
};

type ComputeStorageEntry = {
    node: StorageNode<WgslType>;
    name: string;           // e.g. '_cs0'
    type: string;           // e.g. 'array<vec4f>'
    access: 'read' | 'read_write';
    binding: number;        // always group 0
};
```

---

## Dispatch math

Dispatch is specified as the number of **workgroups** (not threads). To process
`N` elements with a workgroup size of 64:

```ts
dispatch: [Math.ceil(N / 64)]   // = [Math.ceil(N / 64), 1, 1]
```

For 2D work (e.g. a 512×512 texture):

```ts
workgroupSize: [8, 8, 1],
dispatch:      [64, 64, 1],   // 64×8=512 threads per axis
```

---

## Storage buffer access modes

| `access` value | WGSL | GPUBufferUsage |
|---|---|---|
| `'read'` | `var<storage, read>` | `STORAGE \| COPY_DST` |
| `'read_write'` | `var<storage, read_write>` | `STORAGE \| COPY_DST \| COPY_SRC` |

Pass `'read_write'` for any buffer the compute shader writes to.

---

## Chaining compute passes

To chain passes (A writes `bufA`, B reads `bufA` and writes `bufB`), compile
and dispatch them in dependency order:

```ts
const phase1 = gpu.compute({ storage: [bufA], dispatch: [...], body: () => { ... } });
const phase2 = gpu.compute({ storage: [bufA, bufB], dispatch: [...], body: () => { ... } });

await renderer.compile(phase1);
await renderer.compile(phase2);

function frame() {
    renderer.compute(phase1);   // writes bufA
    renderer.compute(phase2);   // reads bufA, writes bufB
    renderer.render(outputNode);
    requestAnimationFrame(frame);
}
```

All three calls encode into the same `GPUCommandEncoder`, so ordering is
guaranteed by WebGPU's command buffer serialisation.

---

## WGSL output example

For:

```ts
const buf = gpu.storageArray(64, S.array(S.vec4f()), 'read_write');
const node = gpu.compute({
    workgroupSize: [64, 1, 1],
    dispatch: [1],
    storage: [buf],
    body({ globalId }) {
        const idx = gpu.toVar('u32', globalId.x, 'idx');
        gpu.index('vec4f', buf, idx).assign(gpu.vec4f(gpu.float(idx), 0.0, 0.0, 1.0));
    },
});
```

Generated WGSL:

```wgsl
@group(0) @binding(0) var<storage, read_write> _cs0 : array<vec4f>;

@compute @workgroup_size(64, 1, 1)
fn cs_main(
    @builtin(global_invocation_id) global_invocation_id : vec3u
) {
    var idx : u32 = global_invocation_id.x;
    _cs0[idx] = vec4f(f32(idx), 0.0, 0.0, 1.0);
}
```

---

## Full example — compute particle simulation

See `examples/src/example-compute-particles.ts` for a complete working example
that:

- Allocates a `vec4f` storage buffer for particle positions (xyz + lifetime).
- Uses a compute shader each frame to advance particle positions.
- Renders the particles as instanced points reading directly from the storage
  buffer (no `computeOutput` bridge needed).

---

## Comparison with three.js TSL

three.js r163+ ships a compute API under the same TSL umbrella. This section
documents where gpucat converges with it, where it diverges, and why.

### Where they are the same

- Both represent compute work as a node-like object.
- Both use JavaScript tracing (a callback executed once at compile time) to
  produce the shader body, rather than requiring raw WGSL strings.
- Both use `storage()` / `instancedArray()` to declare GPU-side buffers.
- The builtin names (`globalId`, `localId`, etc.) map to the same underlying
  WebGPU/WGSL builtins; only the JS accessor spelling differs.

### Dispatch model

**three.js**
```js
// ComputeNode carries updateBeforeType = 'object'.
// renderer.render() auto-dispatches it as a side effect when a material
// references the storage buffer.
renderer.compute(updateParticles);   // or called automatically each frame
```

**gpucat**
```ts
// Explicit: caller compiles the pipeline, then dispatches before render.
await renderer.compile(updatePositions);

function frame() {
    renderer.compute(updatePositions);
    renderer.render(outputNode);
    requestAnimationFrame(frame);
}
```

gpucat's explicit model makes compute–render ordering visible at the call site
and requires no BFS traversal of the render graph to discover compute nodes.
Chained passes are ordered by the sequence of `renderer.compute()` calls rather
than by graph topology.

### Signature of `compute()`

**three.js**
```js
// Body built separately with Fn(); passed as the first argument.
// Count = total invocations (threads), not workgroups.
const updateParticles = Fn(() => {
    const idx = instanceIndex;
    positionStorage.element(idx).x.addAssign(0.001);
})().compute(particleCount, [64]);
```

**gpucat**
```ts
// Body is a callback property inside the options object.
// dispatch = workgroup count; workgroupSize is explicit.
const updateParticles = gpu.compute({
    workgroupSize: [64, 1, 1],
    dispatch: [Math.ceil(N / 64)],
    storage: [positions],
    body({ globalId }) {
        const idx = gpu.toVar('u32', globalId.x, 'idx');
        gpu.index('vec4f', positions, idx).assign(...);
    },
});
```

| | three.js | gpucat |
|---|---|---|
| Body definition | Separate `Fn(() => {...})` call | Inline `body` callback in options |
| Dispatch unit | **Thread count** | **Workgroup count** |
| Workgroup size | Second arg to `.compute()` | `workgroupSize` in options |
| Active thread index | `instanceIndex` (global constant) | `globalId.x` from builtins arg |

**Why workgroup count?** `dispatchWorkgroups(x, y, z)` takes workgroup counts.
Exposing them directly avoids a hidden divide-and-round inside the library and
makes dispatch math explicit and auditable at the call site.

### Storage buffer declaration

**three.js**
```js
// instancedArray(count, elementType) — GPU-only, element type inferred from string.
const positionBuffer = instancedArray(particleCount, 'vec3');
```

**gpucat**
```ts
// storageArray(count, schema, access) — CPU array optional; schema is explicit.
const positions = gpu.storageArray(N, S.array(S.vec4f()), 'read_write');
```

### Element access

**three.js**
```js
const pos = positionBuffer.element(instanceIndex);
pos.x.addAssign(vel.x);  // Proxy-based property assignment
```

**gpucat**
```ts
const pos = gpu.toVar('vec4f', gpu.index('vec4f', positions, idx), 'pos');
gpu.index('vec4f', positions, idx).assign(gpu.vec4(newX, newY, newZ, newW));
```

gpucat uses explicit `assign()` rather than a JS `Proxy`. This is less terse
but unambiguous and easier to type-check.

### What three.js has that gpucat does not (yet)

- **Atomic operations** — `atomicAdd`, `atomicMax`, etc. via `.toAtomic()`.
- **Indirect dispatch** — `IndirectStorageBufferAttribute` for GPU-driven
  dispatch counts.
- **WebGL fallback** — three.js falls back to PBO-based reads on WebGL2; gpucat
  is WebGPU-only.
