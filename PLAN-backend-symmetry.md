# Backend symmetry plan

Status: **steps 1-5 done, discharged in layer 6.3**; audited again in 6.72 after the `Renderer`
rebuild, which changed the file list, and mechanised in 6.82 so it is not audited by hand a fourth
time. Uncommitted on purpose; delete it when the work lands.

Rules 1 and 4 are held by `tst/backend-symmetry.test.ts`. It asserts both directions: an unpaired
module must carry a justification, and a justification must name a module that is still unpaired. The
second half is what the hand audits kept missing.

Rule 3 is held by `tst/core-has-no-device.test.ts` (layer 6.83), which walks identifiers off the AST
so a backend named in a comment or an error string does not count as one touched. It allowlists the
four WebGPU string unions core is entitled to use as neutral vocabulary (`GPUTextureFormat`,
`GPUBlendFactor`, `GPUBlendState`, `GPUFeatureName`) and rejects everything else, so a device type
entering core has to be classified rather than merely unanticipated.

**A `bindingsVersion` asymmetry that is earned, checked in 6.106.** `webgl/geometries.ts` tracks it and
rebuilds VAOs when it moves; `webgpu/geometries.ts` never mentions it. That reads like a rule-4 breach
and is not one: WebGPU re-reads `geometry.buffers` every update and binds per draw, so it captures no
layout to invalidate. Recorded because the next sweep will find it again.

**One real asymmetry, deliberately not fixed.** Disposing a `Material` evicts the RenderObjects that
reference it; disposing a `Geometry` evicts nothing. Mirroring it would be wrong — geometry is not part
of RenderObject identity, and lib disposes a geometry on every brush move, so eviction would discard
the compile and the pipeline each time the cursor moves. What remains is a leak in the strong
`renderObjects` set, which belongs with the deferred delete queue.

Rule 2 is held by `tst/cache-owns-its-stats.test.ts` (layer 6.84): a module that creates a resource
cache must export a `get*Stats`, with frame and per-draw state excluded by name and four real gaps
recorded with reasons. 6.84 also found the rule broken in the place it matters most, WebGPU's
`readMemoryStats`, which read four counts off cache fields while the owning modules' stats functions
sat exported and uncalled, and `PipelinesStats` reporting a count owned by `bind-group-layout.ts`.

**Where the two backends stand, counted in 6.72**: 11 filenames paired, 17 unpaired. Most unpaired
files are the API differences rule 4 allows — `transform-feedback`, `context`, `state`, `programs` on
one side; `compute`, `mipmap-utils`, `bind-group-layout`, `pipelines` on the other. One is not: WebGPU carries both `prepare.ts` and `render-objects.ts` where WebGL has only
`prepare.ts`. That is decomposition, not API, which rule 4 forbids; it is recorded rather than
resolved because splitting or merging it is a judgement about where per-object device work belongs,
not a rename.

**`render-object-gl.ts` against `render-object-gpu.ts` was recorded as a second violation in 6.72,
on the grounds that the directory already disambiguates the name. Layer 6.82 checked the importers
and withdrew that.** All nine modules that import either one also import `core/render-object`, so the
neutral `RenderObject` and the device-side cache are in scope together at every call site. The
suffix is doing work on the *symbols*, not just the filename: dropping it would give a
`render-object.ts` whose exports still had to be `getRenderObjectGpu` and `RenderObjectGpuCache` to
avoid colliding with core's, which is a filename that no longer describes what it exports. They are an
earned pair instead, alongside `programs.ts`/`pipelines.ts`.

## The goal

The two backends should **share little but look identical**. Someone who knows `webgl/` should be
able to open `webgpu/` and find the same files, doing the same jobs, in the same order. Sharing
happens only through `core/`, and only for things that must not differ between them.

This is not a step toward a shared renderer or a common orchestrator. Those were considered and
rejected: three.js's `common/Renderer.js` + `Backend.js` split does not prevent the class of bug we
actually hit (it duplicates blend resolution across its two backends exactly as gpucat did), and it
costs a 4000-line Renderer to unify a frame sequence that is ~85% identical by convention already.

## The rule

1. **One module per engine resource, per backend, same filename on both sides.**
2. **Whoever owns the cache owns the release, the stats, and the teardown.**
3. **`core/` holds decisions that must not differ, and machinery with no device in it. Core never
   touches a device handle; a backend never re-decides something core decided.**
4. **A file with no sibling must be justified by an API difference, not a decomposition preference.**

## Where the module list comes from

It is not a layout anyone picked. gpucat's public API defines the resources that need a device
representation, and each one gets a module:

| engine type | defined in | device artifact | webgl | webgpu |
| --- | --- | --- | --- | --- |
| `GpuBuffer` | `core/gpu-buffer.ts` | GL buffer / `GPUBuffer` | `buffers.ts` | `buffers.ts` |
| `GpuTexture` | `core/gpu-texture.ts` | GL texture / `GPUTexture` | `textures.ts` | `textures.ts` |
| `GpuSampler` | `core/gpu-sampler.ts` | GL sampler / `GPUSampler` | `samplers.ts` | `samplers.ts` |
| `Geometry` | `geometry/geometry.ts` | VAO + buffers / vertex layout | `geometries.ts` | `geometries.ts` |
| `RenderTarget` | `core/render-target.ts` | FBO / attachment set | `render-target.ts` | `render-target.ts` |
| `BindGroup` | `renderer/core/bind-group.ts` | UBO binding points / `GPUBindGroup` | `bindings.ts` | `bindings.ts` |

Six one-to-one mappings, all six present since layer 6.3. **This table read the pre-6.3 state until
layer 6.82**, listing three of the six as missing and naming WebGL's bind-group module `uniforms.ts`,
which it stopped being in step 3. A stale table in the document that says what work remains is worse
than no table, so `tst/backend-symmetry.test.ts` now derives the pairing from the directories.

Each of the three that used to be missing explains a symptom this plan was written from:

- No `webgl/buffers.ts` was why disposing a standalone `GpuBuffer` did nothing on WebGL. No module
  owned the mapping, so there was nowhere for the dispose hook to live.
- No `webgpu/samplers.ts` was why `samplerCount` was wedged into `getTextureCacheStats`.
- No `webgpu/render-target.ts` was why `removeRenderTargetTexture` lived in `textures.ts`.

## The seventh module is NOT a resource

`programs.ts` / `pipelines.ts` compiles a **shader variant**, and its input is not one engine object:

- render: keyed by (material, geometry, render context)
- compute: keyed by a `ComputeNode`, which has no `Material` at all

`webgpu/pipelines.ts` holds both `renderPipelines` and `computePipelines`; `webgl/programs.ts` is
render-only, because WebGL2 has no compute.

So an earlier idea to name both `materials.ts` was wrong, and the name difference here is **earned**:
a linked GL program and a WebGPU pipeline are genuinely different artifacts (the pipeline bakes
fixed-function state in; the GL program is driven by live state via `webgl/state.ts`). Keep
`programs.ts` and `pipelines.ts`.

## The rest of the tree

Everything lands in one of three categories:

- **A. Resource modules** - the six above.
- **B. Frame path** - `renderer.ts`, `render-pass.ts`, `prepare.ts`, `read-pixels.ts`. Already paired.
- **C. Earned backend-only** - `webgl/context.ts`, `webgl/probe.ts`, `webgl/constants.ts`,
  `webgl/transform-feedback.ts`, `webgpu/compute.ts`, `webgpu/mipmap-utils.ts`.

Currently-unpaired files that are really pieces of a category-A module, to be absorbed as each is
built: `webgl/state.ts` and `webgl/texture-bindings.ts`, `webgpu/bind-group-layout.ts`.

## The shape inside every resource module

Same five things, same order, both backends. This is what makes symmetry checkable by eye, and read
as a checklist it catches the leaks we found (WebGL textures had 1, 2, 4, 5 and no 3; WebGL
geometries had 3 written but never wired to anything).

```
createXCache()                     state, nothing else
updateX(device, cache, resource)   get-or-create, then upload
setupXDispose(...)                 owns the cache, so owns the release
getXStats(cache)                   what it currently holds
disposeXCache(device, cache)       teardown
```

## How a module receives the backend (6.124-6.125)

A sixth symmetry, and the one both backends were violating unevenly: **a cross-module entry point
takes `BackendState`; a module-private helper names the caches it uses.** The private half is not a
concession — a helper's parameter list is the only statement of what it touches, and handing it the
whole backend erases that.

WebGPU was half converted and WebGL nearly whole, which is exactly the asymmetry this plan exists to
catch, and no rule here covered it. `tst/backend-state-boundary.test.ts` now scans both directories
under one rule.

The two `BackendState` types stay different in one respect, with a reason recorded in `webgl/backend-state.ts`:
WebGL's excludes `gl`, because it is nullable until `init` acquires it and an immediate-mode backend
passes it at every call anyway. That is the "unpaired needs an API-difference justification" rule
satisfied, not broken.

## Steps

Ordered relocations first: they are mechanically verifiable and establish the module shape, so the
one real restructure lands last with the pattern already proven.

### 1. `webgpu/samplers.ts` (relocation)

Move out of `webgpu/textures.ts`: `samplerCache`, `samplerCount`, `SamplerData`, `getSampler`
(line ~720-760). `TextureCache` loses both sampler fields; `getTextureCacheStats` loses
`samplerCount` and gains a `getSamplerCacheStats` sibling.

Touches `webgpu/bindings.ts` and `webgpu/render-pass.ts` (4 and 1 references).
Fixes the stats shape mismatch papered over in `_beginInfoFrame`.

Verify: `tsc`, unit suite, WebGL harness unaffected.

### 2. `webgpu/render-target.ts` (relocation)

Move out of `webgpu/textures.ts`: `createSwapchainDepthTexture`, `createSwapchainMsaaTexture`,
`getRenderTargetView`, `getRenderTargetMsaaView`, `setRenderTargetTexture`,
`removeRenderTargetTexture`, `ensureRenderTargetTexturesAllocated`.

Pairs with the existing `webgl/render-target.ts`. Note the two will NOT have matching internals: GL
manages FBOs and renderbuffers, WebGPU manages attachment views. That is fine; the rule is same
resource, same filename, not same implementation.

Verify: `tsc`, unit suite.

### 3. `webgl/uniforms.ts` -> `webgl/bindings.ts` (rename)

Pairs with `webgpu/bindings.ts`, and matches the neutral type name in `core/bind-group.ts`.

Falls out of this, not a step of its own: `invokeUniformGroupCallbacks` currently lives in
`webgpu/bindings.ts` and is imported by `webgl/uniforms.ts`. That is the only cross-backend import in
the tree. It touches no device (it walks `block.members` and calls `frame.updateNode`), so it moves
beside its type in `core/bind-group.ts`.

Verify: `tsc`, unit suite, WebGL harness.

### 4. `webgl/buffers.ts` (real restructure, not a move)

The only step that changes ownership rather than location, and the only one that touches the hot
upload path. Detailed because of that.

#### Today: three owners, two keying schemes

| owner | what it holds | keyed by | GL usage hint |
| --- | --- | --- | --- |
| `geometries.ts` | attribute + index buffers | `(geometry, attribute-name)` | `STATIC_DRAW` |
| `bindings.ts` | UBOs | `UniformBinding` / `UniformGroupBlock` | `DYNAMIC_DRAW` |
| `transform-feedback.ts` | TF input/output buffers | `GpuBuffer` | `DYNAMIC_COPY` |

Nothing owns `GpuBuffer -> WebGLBuffer`. Two consequences:

1. ~~**Disposing a standalone `GpuBuffer` does nothing.** Only TF registers a hook.~~ **Done.**
   `setupBufferDispose` hangs the release off the buffer's own dispose, chained rather than assigned
   so the storage-texture path's callback survives.
2. ~~**"One GpuBuffer = one GL buffer" is already claimed but is not true.**~~ **Done**, and the file
   that documented the broken promise (`webgl/renderer.ts`) no longer exists. A single
   `bufferMap: WeakMap<GpuBuffer, CacheEntry>` keys by buffer identity, so a buffer used as both a TF
   output and a geometry attribute resolves to one GL object.

   Both verified in 6.136 rather than read off the code: `tst/webgl-buffer-ownership.test.ts` drives
   the real cache against a recording GL context. Dropping the dispose hook, or keying the map by
   anything but the buffer, each fail it.

#### Target: mirror `webgpu/buffers.ts`

That module already solves exactly this shape, with two maps, and both are needed here:

- `bufferMap: WeakMap<GpuBuffer, entry>` for anything backed by a `GpuBuffer` (attributes, indices,
  TF IO).
- `rawMap: WeakMap<object, buffer>` for device buffers with no `GpuBuffer` behind them. WebGPU uses
  this for uniform blocks via `uploadUniformBlock`; WebGL's UBOs are the same case.

So `webgl/buffers.ts` gets the standard five, plus the raw path:

```
createBufferCache(info)                     state; takes `info` by reference, as WebGPU's does
ensureUploaded(gl, cache, buffer, name)     get-or-create + version-gated upload
getUploaded(cache, buffer)                  resolve without uploading (VAO build, readback)
uploadUniformBlock(gl, cache, key, data)    the raw path, for UBOs
setupBufferDispose(...)                     owns the cache, owns the release
disposeBufferCache(gl, cache)               teardown
getBufferCacheStats(cache)                  what it holds
```

#### Consequence worth naming: keying changes

Attribute buffers move from `(geometry, name)` to `GpuBuffer` identity. Two geometries sharing a
`GpuBuffer` currently get two GL buffers and two uploads; afterwards they share one. That is a
behaviour change, and it is the correct direction, but it means version and size tracking move from
per-(geometry, name) to per-buffer, which is also where they belong.

The `__direct_${shaderLocation}` synthetic keys in `prepareGeometry` disappear entirely. They exist
only because there was nowhere to key a non-geometry buffer by identity.

#### Sub-steps, each independently typechecked and tested

- **4a.** Create `webgl/buffers.ts` with the surface above and no callers. Includes `glUsageHint(buffer)`
  deriving the GL hint from `buffer.usage`, the analogue of WebGPU's `deriveGPUUsage`.
- **4b.** Point `geometries.ts` at it for attributes and indices. Delete the `__direct_` keys; the VAO
  build resolves through `getUploaded`.
- **4c.** Point `bindings.ts` UBOs at the raw path.
- **4d.** Point `transform-feedback.ts` at it. `getGlBufferFor` and `readBufferAsync` then resolve
  through `buffers.ts`, and the TF-specific buffer map goes away.
- **4e.** Extend `dispose-releases` with a standalone-buffer case.

#### Risks, each with its check

- **Usage hints.** Today the hint is chosen by the call site (`STATIC_DRAW` / `DYNAMIC_DRAW` /
  `DYNAMIC_COPY`); afterwards it is derived from `buffer.usage`. A TF output landing on `STATIC_DRAW`
  would be a silent performance regression, not a failure. *Check:* the `tf-*` harness cases exercise
  the TF path end to end; assert the hint mapping in a unit test rather than trusting the harness.
- **VAO capture.** Uploads must land on VAO 0, because `ELEMENT_ARRAY_BUFFER` (and attribute pointer
  state) is captured into whatever VAO is bound. `prepareGeometry` already guards this with
  `bindVertexArray(null)` before uploading, and that guard must stay at the caller, since
  `buffers.ts` will bind `ARRAY_BUFFER` / `ELEMENT_ARRAY_BUFFER` itself. *Check:* existing
  `batched-draws-*` and `instanced` harness cases fail loudly if VAO state is corrupted.
- **Dispose chaining.** `transform-feedback.ts` and the storage-texture path in `textures.ts` both
  already hang callbacks on `GpuBuffer._onDispose`, and chain rather than assign. `buffers.ts` must
  chain too. *Check:* `tf-alias` plus the new standalone-buffer case in `dispose-releases`.
- **Resize guard.** `geometries.ts` currently recreates a GL buffer when the array grows, tracked by
  `attributeSizes`. That guard moves into `buffers.ts` and must keep using `core/buffer-upload.ts`'s
  `planBufferUpload`, which already decides allocate-vs-partial-vs-full for both backends.
  *Check:* `tst/buffer-upload.test.ts` and `tst/buffer-lifecycle.test.ts` already cover the decision;
  the harness covers the GL side.
- **Upload attribution.** `recordBufferWrite` calls currently sit in `geometries.ts` and `bindings.ts`.
  They move with the uploads, and must keep passing label / usage / material / changedBytes so the
  GPU tab's by-buffer breakdown does not regress. *Check:* compare `gpu/upload/by/*` rows in the
  editor before and after on the same scene.

#### Not in scope for step 4

Deduping the engine's shared pool buffers is a possible side effect of the keying change, not a goal.
Whether `render/mesh/mesh-resources.ts`'s vertex/index pools are actually referenced by more than one
`Geometry` has not been measured, so no saving is being claimed.

### 5. Parity harness

The structural work cannot enforce behaviour. `webgl/geometries.ts` had a correct, complete
`disposeGeometry` with zero callers; it would satisfy any file-layout rule or interface.

`tst/` currently has one real-rendering harness and it is WebGL-only (`wgsl-validate` only validates
shaders). So every WebGPU claim made while doing steps 1-4 rests on reading code, not running it.

First job for the harness: run `dispose-releases` on **both** backends, extended to one case per
resource kind.

## Deliberately not doing

- A shared `render()` or a common orchestrator. See "The goal".
- Common per-resource managers in `core/` (three.js's `common/Textures.js` shape). That would move
  cache ownership out of the backends, which is a much larger change and buys nothing the paired
  modules plus the harness do not.
- `destroyX` on the neutral `Renderer` interface. A type can force a method to be declared; it cannot
  force it to delete anything. three.js's `Backend.js:343` is an empty stub for exactly this reason.
- A `FinalizationRegistry` GC backstop (three.js `Textures.js:75`). Real gap, separate decision.

## Open question

`core/renderer-interface.ts` documents itself as "the surface the node graph (via NodeFrame) needs".
`info` was added to it and the node graph does not need `info`, so that interface now means two
things. Either widen the doc deliberately ("what every backend must satisfy") or move `info` to
`RendererState` in `renderer-ops.ts`, which is already the internal-state contract both renderers
implement. Leaning toward widening the doc, since `info` is genuinely a backend obligation.
