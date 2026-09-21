# Worklog: explicit frame

Companion to `PLAN-explicit-frame.md`. Newest last. Every entry records what landed, how it was
verified, and anything found that changed the plan.

Verification each cycle: `npx tsc --noEmit`, `npx vitest run tst`, `npx biome check <touched files>`.
At every layer boundary, also the three harnesses that the unit tests cannot stand in for:

    node tst/wgsl-validate/run.mjs   # 38 shaders under naga
    node tst/glsl-compile/run.mjs    # 48 shaders compiled + linked
    node tst/webgl-render/run.mjs    # real pixels, headless Chromium + SwiftShader

Baseline at start: 42 test files, 365 tests.

---

## Layer 0.1 — pipeline key carries the vertex layout

`renderer/webgpu/pipelines.ts`, `tst/stencil.test.ts`.

- Extracted `resolveVertexGroupStride(group, geometry)`, now the single source for both
  `buildVertexBufferLayouts` and the cache key, so the layout builder and the key cannot disagree
  about what a pipeline is.
- Added `vertexLayoutKey(geometry, nodeState)` and threaded it into `makeRenderPipelineKey`.
- New test: the key splits on stride and on step mode.

Why: `arrayStride` falls back to `getBytesPerElement(buffer.format)` when the attribute node carries
no explicit stride, which is the common case for `attribute('position', d.vec3f)`. That stride was not
in the key, so two geometries supplying one attribute name with different formats shared a pipeline
whose stride suited only one of them. It also made `compile(gpu, material, target)` unsound, which is
why this is layer 0.

Verified: tsc 0, 366 tests, biome clean.

**Found, not fixed** (same bug from two angles: a geometry whose buffer formats change in place
invalidates nothing):

- `RenderObject.initialCacheKey` is computed for every render object and includes
  `${name}:${buffer.format}` per buffer. Its doc says "Used to detect when recompilation is needed".
  Nothing ever compares it; the only reference outside its own file is the assignment.
- `Geometry.setBuffer` bumps `version` only when the name is new, so replacing `position` with a
  different-format buffer bumps nothing.

Adding `geometry.version` to the pipeline-key memo guard would have looked like a fix without being
one, so the memo still keys on `material.version` alone.

---

## Layer 0.2 — core takes a `View`, not a `Camera`

New `renderer/core/view.ts`. Touched `node-frame`, `pass-context`, `render-object`, `render-objects`,
`renderer-ops`, `render-list`, `nodes/lib/camera.ts`.

- `View` is the six values core actually reads: `projectionMatrix`, `matrixWorldInverse`,
  `matrixWorld`, `near`, `far`, `coordinateSystem`. `Camera` satisfies it structurally, so no call
  site changed.
- `cameraPosition` now does `mat4.getTranslation(scratch, frame.camera!.matrixWorld)` instead of
  calling `Object3D.getWorldPosition`. Same semantics; `camera-position-uniform.test.ts` covers it.

`coordinateSystem` earned its place independently of the plan's argument: `render-list.ts` reads it at
two sites for frustum culling, so core needs it whoever builds the projection.

Left as `Camera` on purpose: `renderer-interface.render(scene, camera, passId?)`. Its implementations
call `camera.updateProjectionMatrix()`, a method not on `View`, and `render()` is deleted in layer 4.

Verified: tsc 0, 366 tests, biome clean.

---

## Layer 0.3 — targets become bundles (additive half)

New `renderer/core/target.ts`. Touched `canvas-target.ts`, `webgpu/renderer.ts`, `webgpu/pipelines.ts`,
`tst/canvas-target.test.ts`.

- `Target = RenderTarget | CanvasTarget`.
- `CanvasTarget` gains `depthFormat` and `samples` as neutral config, `dpr` as `number | [min, max]`
  (a number pins, a tuple clamps `setPixelRatio`), and `onResize(cb): () => void` firing on subscribe
  then on change. `setSize`'s doc already claimed it "fires 'resize'" and never did.
- `WebGPURenderer` builds its default `CanvasTarget` with those values and then builds the swapchain
  state **from the target**, falling back to the options only in headless mode where there is no
  target. One source of truth, no behaviour change.
- `DEPTH_FORMAT` / `DEPTH_STENCIL_FORMAT` narrowed from `GPUTextureFormat` to `DepthTextureFormat`,
  which is what they are. Assignable everywhere the wider type was expected.
- Four tests, including a derived target following the canvas through `onResize`, which is how
  resolution scale will work.

Verified: tsc 0, 370 tests across 43 files, biome clean.

**Plan corrected**: `RenderTarget` losing `viewport` / `scissor` / `scissorTest` moved from layer 0 to
layer 1. Its only reader is `renderer-ops.ts:262-264`, which picks between the target's values and the
renderer's ambient ones, and both sides are replaced by `PassDesc`. Removing them before `PassDesc`
exists leaves nothing to read and costs the green suite for the whole keystone layer. Big bang means
no intermediate state has to be coherent, not that a removal should precede its replacement while
there is still a suite worth running.

**Found**: `WebGPURendererOptions.headless` already exists and requires a pre-created `device`, with
`_canvasTarget` left null. So headless is further along than the plan's Headless section assumes.

---

## Layer 0.4 — same wiring for WebGL, and layer 0 closes

`webgl/renderer.ts`.

WebGL has no `depthFormat` option, only `stencil: boolean`, so its canvas target expresses the default
framebuffer the same neutral way WebGPU expresses its swapchain: `depthFormat` is
`'depth24plus-stencil8'` or `'depth24plus'`, and `samples` carries through (0 stays 0, since
`opts.samples ?? 1` only defaults on nullish). `this.samples` and `this.stencil` now derive from the
target rather than from the options, so there is one source of truth on both backends.
`WebGLRendererOptions` gains `dpr` to match.

Verified: tsc 0, 370 tests, no new biome findings. One pre-existing `organizeImports` finding at
`webgl/renderer.ts:15`, on an import this change did not touch; left alone.

**Layer 0 is done**, minus the `RenderTarget` viewport/scissor removal that moved to layer 1.

---

## Layer 1.0 — pass identity, corrected before building on it

No production code changed this cycle. The plan's keystone was wrong and building `core/frame.ts`
against it would have baked in a regression.

**`WeakMap<Target, RenderContext>` is wrong.** `buildCacheKey` hashes
`{count}:{formats}:{samples}:{depth}:{stencil}` plus MRT id plus `callDepth`
(`core/pass-context.ts:253-284`), so contexts are keyed by attachment **shape**, and two different
`RenderTarget` objects with identical configuration deliberately share one, and therefore share
pipelines and RenderObjects. Identity keying would split all of that per target. For lib's per-room
targets that is a real regression. Keep shape keying; drop `callDepth` when nesting goes; drop
`passId` from the RenderObject cache as the review said.

**Found a latent bug while checking that claim.** `context.renderTarget` is set once at creation, so
it is a representative of the shape class. Two readers are safe (format lookups the key guarantees
are identical). The third is not: `node-manager.ts:109` calls
`renderTarget.getTextureIndex(name)` to resolve MRT output names, and the cache key does not hash
texture names. Two same-shaped targets with differently named textures share a context, and an MRT
material resolves against whichever created it. Fix is to hash texture names too; deferred to the
pass-identity work rather than done ahead of it.

I first wrote this as a seven-line block comment in `pass-context.ts` and was pulled up on it. The
comment was also **wrong** (it claimed two readers, there are three), and the rename I tried in its
place would have been a lie. Knowledge went to the plan instead. The loop now carries a comment goblin
pass: delete comments that restate the code, and move anything load-bearing into a name, a type or a
test.

Verified: tsc 0, 370 tests, `pass-context.ts` back to its original two pre-existing biome findings.

---

## Layer 1.1 — MRT texture names enter the context cache key

`core/pass-context.ts`, new `tst/pass-context.test.ts`.

`buildAttachmentState` now hashes `${name}:${format}` per texture instead of format alone, so the
latent bug from 1.0 is closed: a gbuffer named `albedo`/`normal` no longer shares a render context
with one named `colour`/`motion`, and MRT output resolution can no longer land on the wrong target's
texture list.

Four tests pin both directions, since the risk is over-splitting as much as under-splitting: same
formats still share, different formats split, different names split, identical names and formats still
share.

Goblin pass: deleted the doc block over `buildAttachmentState`, which restated the code and was
already stale (it advertised a `{type}` field the key has never had). Replaced with one line naming
the non-obvious part, that names are in the key because MRT resolves by name. Also trimmed my own
three-line comment in the new test down to one, since the test name already carried the reason.

Verified: tsc 0, 374 tests across 44 files, biome clean.

---

## Next: layer 1

Pass identity (`WeakMap<Target, RenderContext>`, `passId` out of the RenderObject cache, `callDepth`
out of the context key), then `core/frame.ts` and `core/pass.ts`. `RenderTarget` loses
`viewport` / `scissor` / `scissorTest` here, once `PassDesc` exists to receive them.
`render-encoder.test.ts` gets rewritten against the new invariant.

## Layer 1.2 — `core/frame.ts`, the recording machinery

New `src/renderer/core/frame.ts` and `tst/frame.test.ts` (11 tests).

`Frame` and `Pass` with `PassDesc`, `DrawOpts`, `DrawRecord`, and a `FrameBackend` interface the
backends will implement in layer 2. Additive: nothing imports it yet, so the suite stayed green
throughout.

Semantics, each pinned by a test rather than a comment:

- Nothing reaches the backend until `end()`. `draw()` only records.
- `end()` runs `beginPass`, `encodeDraws`, `endPass` in order, and closes the pass in a `finally` so a
  throw inside encode still ends it.
- One open pass at a time. Opening a second, or submitting with one open, throws and names the open
  pass via its label.
- `submit()` twice, `end()` twice, and `draw()` after `end()` all throw.
- `abandon()` ends an open pass and calls `discardFrame`, not `submitFrame`.
- `beginFrame` on a frame a throw escaped from abandons it first, so the next frame starts clean.

**The pooling test caught a real design bug.** I first had the pass pool on `Frame` and constructed a
`Frame` per frame, which throws the pool away every frame and allocates a Frame plus a Pass plus
DrawRecords each time: exactly the per-frame allocation regression the review warned about. Fixed by
introducing `FrameState`, which holds one `Frame` for the life of the renderer, with `beginFrame`
resetting it. Steady state now allocates none of the three. `encodeDraws` takes `(records, count)`
rather than a slice for the same reason.

Goblin pass: cut three block comments that tests now pin (the backend contract, the pooling claim, and
`abandon`'s rationale), leaving one line each where the line said something the code did not.

Verified: tsc 0, 385 tests across 45 files, biome clean.

---

## Layer 1.3 — verification baseline before the live render path

No production code. Layer 2 is the first chunk that modifies working rendering, and until now the
entire net has been 385 unit tests that never draw a pixel. Checked what else actually runs here.

All four layers work, and all pass at this commit:

- `npx vitest run tst` — 385 tests, stub GPU, no device.
- `node tst/wgsl-validate/run.mjs` — 38 shaders valid under naga.
- `node tst/glsl-compile/run.mjs` — 48 / 48 compiled and linked.
- `node tst/webgl-render/run.mjs` — **all cases pass**, real WebGL2 through headless Chromium on
  SwiftShader, centre-pixel compared within ±3 per channel. Covers clear, fullscreen triangle, a
  std140 UBO uniform, a camera-transformed lit box, MRT (including 4x rgba16f, upfront and lazy),
  render-target resize realloc, cubemaps and cube mips, array layers, partial subrect uploads,
  instancing, default-blend transparency, dispose accounting, batched `mesh.draws` (indexed and
  non-indexed), transform feedback (add, ping-pong, readback, uniform re-pack, neighbour gather), and
  the unsupported-format error paths.

**The asymmetry that matters: there is no WebGPU pixel harness.** Only WebGL has one. So layer 2 wires
**WebGL first**, where a regression shows up as a wrong pixel, and WebGPU second, where it would only
show up as a type error or a unit-test failure. The plan said "both backends" with no ordering; the
evidence gives one.

Also worth recording: wgsl-validate and glsl-compile never go through the renderer, so like the golden
snapshots they must stay untouched by all of this. They are a second independent check on the
"the graph and both emitters are not involved" claim.

---

## Layer 2.1 — WebGL `executeRenderPass` splits into three phases

`webgl/render-pass.ts`. Pure refactor, zero behaviour change, verified by pixels.

`executeRenderPass` was ~170 lines doing begin, encode and end inline. Now:

- `beginPass(gl, caches, passCtx, params): PassScope` — plan blend, bind framebuffer, apply
  viewport and scissor, clear on autoClear.
- `encodeDraws(gl, caches, nodes, passCtx, prepared, inspector, info, scope)` — baseline, fresh GL
  state cache, the draw loop.
- `endPass(gl, caches)` — unbind the VAO, resolve an MSAA target.
- `executeRenderPass` kept as a wrapper calling the three, so every existing caller is untouched.

Only one value crosses a phase boundary, `passBlend`, carried in a `PassScope`. Everything else the
loop needs is either a parameter or created and consumed inside the loop.

The old early return for an empty prepared list (`resolve, return`) becomes `if (prepared.length > 0)`
around `encodeDraws`, so an empty pass still reaches `endPass` and a cleared MSAA target is still
resolved. The structure now shows that, where before it took a comment.

Goblin pass: deleted three block comments the split made redundant (the MRT-blend rejection, the
autoClear equivalence, the two-part VAO-unbind and resolve explanation), keeping one line on `endPass`
for the part the code does not say, that the unbind exists so later buffer mutations cannot record
into the VAO.

Verified: tsc 0, 385 tests, biome clean, **`webgl-render` all cases pass**, and both shader harnesses
unchanged at 48/48 and 38 valid.

This is the first chunk to touch working render code, and the pixel harness is what made it safe to
do mechanically rather than nervously.

---

## Layer 2.2 — `PreparedRenderObject` collapses, closing the `RenderItem` leak

`core/render-types.ts`, `core/renderer-ops.ts`, both `render-pass.ts`.

`PreparedRenderObject` was `{ renderObject: RenderObject; item: RenderItem }`. Checked what the two
draw loops actually take from `item`: `mesh`, `material`, `geometry`, and nothing else. `RenderObject`
already carries all three. So the wrapper was pure redundancy, and it is now
`type PreparedRenderObject = RenderObject`.

Three things fall out:

- **The `RenderItem` leak is closed.** The Fable review's finding 13 was that the backend interface
  takes `RenderItem`, which carries `groupOrder` / `renderOrder` / `z` sort keys, the scene-layer
  concern this plan pushes above core. `render-types.ts` no longer imports `RenderItem` at all, and
  tsc flagging that import as unused is the proof.
- **One less object per draw per frame.** `preparedObjects.push({ renderObject, item })` became
  `preparedObjects.push(renderObject)`, so the per-draw wrapper allocation is gone.
- **The adapter gets much simpler.** A recorded `DrawRecord` no longer needs a synthetic `RenderItem`
  to be encodable; it needs a `RenderObject`, which `getRenderObject` already returns.

Verified: tsc 0, 385 tests, `webgl-render` all cases pass. Lint findings in the touched files are all
pre-existing (an import block, the device-lost `console.error`, and a format nit at
`webgpu/render-pass.ts:277`, none from these edits).

Goblin pass: deleted the doc line I put over the alias, which restated the alias name.

**What the adapter still needs**, now that the shape is clear. `prepareRenderObjects` does five things;
a recorded draw list skips the first and needs the rest:

1. `collectRenderList(scene, camera, overrideMaterial)` — **skipped**, the recorded list is the order.
2. `getRenderObject(state, mesh, material, scene, camera, passCtx, passId)` — needs a `scene`, which a
   recorded draw has none of. `RenderObject.scene` is only ever forwarded to `frame.scene`.
3. the backend's `prepare` callback.
4. `NodeManager.updateBefore` — where PassNode's nested render happens.
5. push.

So the open question for the next chunk is what `scene` means for a recorded draw, given nothing in
`nodes/` appears to read `frame.scene`.

---

## Layer 2.3 — `scene` was write-only state; deleted from the render path

`core/node-frame.ts`, `core/render-object.ts`, `core/render-objects.ts`, `core/node-manager.ts`,
`core/renderer-ops.ts`, both `render-pass.ts`, both `renderer.ts`.

Last cycle's open question was what `scene` means for a recorded draw, since
`getRenderObject(state, mesh, material, scene, camera, passCtx, passId)` wanted one and a recorded
draw has none.

Answer: nothing, because **`NodeFrame.scene` is never read.** Six writes across the two backends,
`node-manager` and the pre-warm path, and zero reads anywhere in `src`, `tst` or `examples`.
`RenderObject.scene` existed solely to feed it.

So both fields are gone, and `getRenderObject` and `createRenderObject` lost the parameter. The
inspector's scene-hierarchy tab is unaffected: it reads its own record from
`beginRenderScene(passId, scene, ...)`, not from the node frame.

This removes a scene-layer type from two core structures, and it means the adapter needs no
workaround for `scene` at all. `prepareRenderObjects` still takes a `scene`, but only for
`collectRenderList`, which is the tree walk a recorded draw list replaces.

Goblin pass found an orphaned `@param scene` in `createRenderObject`'s jsdoc. The whole block was a
`@param` list restating the signature, so it went rather than being patched.

Verified: tsc 0, 385 tests, `webgl-render` all cases pass, biome clean on every touched file.

---

## Layer 2.4 — `prepareRecordedDraws`, the adapter's core half

`core/renderer-ops.ts`, new `tst/prepare-recorded-draws.test.ts` (5 tests).

```ts
prepareRecordedDraws(r, records, count, camera, passCtx, passId, prepare, out): number
```

The recorded-draw counterpart to `prepareRenderObjects`. Of the five things that one does, this skips
`collectRenderList` (the caller's order is the draw order) and keeps the other four: `getRenderObject`,
the backend's `prepare` callback, `NodeManager.updateBefore`, and the push.

It fills a caller-owned `out` and returns a count rather than allocating an array, matching the
`(records, count)` convention already used by `FrameBackend.encodeDraws`. So a steady-state pass now
allocates nothing across the whole recording path: no Frame, no Pass, no DrawRecord, no prepared array.

Tests pin order preserved, a `prepare` rejection dropping one draw without shifting the rest, `count`
honoured over `records.length`, render-object reuse for the same mesh and material, and the `out`
array being reused rather than replaced.

Worth noting how cheap this was. The plan called the adapter "the real work of this layer". It came to
about twenty-five lines, because the two previous cycles removed what would have made it hard:
`PreparedRenderObject` collapsing to `RenderObject` meant no synthetic `RenderItem`, and `scene` being
write-only meant no scene to invent.

Goblin pass: cut the three-line doc to one. The middle sentence was already pinned by a test, and the
last restated the signature.

Verified: tsc 0, 390 tests across 46 files, `webgl-render` all cases pass, biome clean apart from the
pre-existing `useTemplate` on the device-lost log.

---

## Layer 2.5 — `PassDesc` to `RenderContext` and `RenderPassParams`

New `core/pass-desc.ts` and `tst/pass-desc.test.ts` (10 tests). `clearColor` added to both targets.

`resolvePassContext(state, desc)` and `resolvePassParams(desc)` mirror exactly what both renderers do
inline today before calling `executeRenderPass`. A `CanvasTarget` resolves to a null render target,
which is how every backend already addresses the swapchain.

**Found a gap in my own plan.** `clear?: Color | false` with "omitted clears with the target's own
clear colour" was settled several cycles ago, but **no target had a `clearColor`.** It lived on the
renderer. Both `RenderTarget` and `CanvasTarget` now carry one, defaulting to `[0, 0, 0, 1]` and
writable, which is where vgpu puts it and what makes the bundle claim true.

**A semantic the plan never stated.** `resolveViewportScissor` multiplies by the canvas pixel ratio
for the swapchain but not for a render target, because `renderer.setViewport` took logical pixels.
`PassDesc.viewport` and `scissor` are **physical pixels of the target, uniformly** — the logical-pixel
behaviour belonged to `setViewport`, which this work deletes. Pinned by a test that sets a pixel ratio
of 2 and asserts the viewport passes through unscaled while the context size does scale.

Everything else the converter needs now comes off the target itself, which is layer 0 paying off: a
`CanvasTarget` carries its own `samples` and `depthFormat`, so the converter needs no renderer state
and takes `(state, desc)` and nothing more.

Goblin pass: two one-line comments kept, for the swapchain-is-null mapping and the physical-pixels
rule, both saying something the code does not. Fixed my own `useOptionalChain` finding by hand rather
than letting the unsafe autofix widen the return type to `boolean | undefined`.

Verified: tsc 0, 400 tests across 47 files, `webgl-render` all cases pass, biome clean on all four
touched files.

---

## Layer 2.6 — orchestration converted to State plus standalone functions

`core/frame.ts` and `tst/frame.test.ts` rewritten. Prompted by a direct question: is the orchestration
code in the same functional TS the backends use?

It was not. `core/frame.ts` had `class Frame` and `class Pass` with private fields and methods, which
is the one shape the module-pattern rule says not to reach for. Now:

```ts
type PassState  = { desc; records; count; ended }
type FrameState = { backend; pool; poolIndex; open; closed }

createFrameState(backend)
beginFrame(frame)
beginPass(frame, desc): PassState
draw(pass, mesh, opts?)
endPass(frame, pass)
submitFrame(frame)
abandonFrame(frame)
```

Plain data, no privates, no methods, no back-pointer. `endPass(frame, pass)` takes both rather than
`Pass` holding a reference to its `Frame`, which the class version needed and this does not.

All eleven tests carried over unchanged in meaning. Two naming knock-ons: `frame.openPass` became
`frame.open`, and the errors now read `endPass called twice` rather than `end() called twice`.

Still owing the same treatment: `webgl/frame-backend.ts` returns an object of closures, which is the
factory-plus-closures collapse. Next cycle.

Verified: tsc 0, 400 tests across 47 files, `webgl-render` all cases pass, biome clean.

---

## Layer 2.7 — WebGL `FrameBackend`, first wiring of the live path

`webgl/frame-backend.ts` (new), `webgl/render-pass.ts`, `webgl/renderer.ts`.

`createFrameBackend(r)` assembles the three phases with `resolvePassContext`, `resolvePassParams` and
`prepareRecordedDraws`, and carries the per-pass in-flight state plus a pooled prepared array.

Two things this forced:

- **`encodeDraws` was exported and gained a `count`.** I had written
  `prepared.slice(0, preparedCount)` at the call site, which allocates per pass, exactly what the
  `(records, count)` convention exists to avoid. It now takes `(prepared, count)` like everything else
  on this path.
- **WebGL's caches were `private`; WebGPU's are public.** The same seven caches are `readonly` and
  public on `WebGPURenderer` and were `private` on `WebGLRenderer`. That asymmetry is the sort the
  sibling symmetry plan exists to catch. WebGL's are now internal-public, matching, which is what let
  the backend live in its own module rather than as a method on a 900-line class.

**WebGL cannot discard a frame.** `submitFrame` and `discardFrame` both only close the inspector's
frame: the work reached the driver as each pass ended. So `abandonFrame`'s recovery is real on WebGPU
and nominal on WebGL, which is worth stating rather than implying the two are equivalent.

Verified: tsc 0, 400 tests, `webgl-render` all cases pass.

---

## Layer 2.8 — backend converted to State plus functions, and the frame path draws

`webgl/frame-backend.ts` rewritten, `webgl/renderer.ts` gains `frame()`, new pixel case in
`tst/webgl-render/harness.ts`.

The backend is now `WebGLFrameBackendState` plus module-level `beginFrame` / `beginPass` /
`encodeDraws` / `endPass` / `submitFrame` / `discardFrame`, with one `frameBackend(s)` that binds them
into the vtable core calls through. That last binding is the only place arrow functions appear, and
the state stays a named value you can hold and inspect, which is the point of the rule rather than
arrow functions being forbidden.

The conversion caught a live allocation bug: `caches` was a `() => ({...})` arrow, so every
`beginPass`, `encodeDraws` and `endPass` built a fresh seven-field object. Three allocations per pass
per frame. It is now built once in the state.

**The milestone.** A new harness case draws the `solid` geometry through
`renderer.frame()` plus `beginPass` / `draw` / `endPass` / `submitFrame` instead of
`render(scene, camera)`:

```
solid        [230, 77, 153, 255]    [230, 76, 153, 255]    PASS
frame-api    [230, 77, 153, 255]    [230, 76, 153, 255]    PASS
```

Identical pixels through a real WebGL2 context. The recorded path and the scene-walking path agree,
which is the first end-to-end proof that any of this works rather than merely typechecks.

Verified: tsc 0, 400 tests, whole `webgl-render` harness passes, biome clean on all touched files.

---

## Layer 2.9 — WebGPU split and wired, and layer 2 closes

`webgpu/render-pass.ts`, new `webgpu/frame-backend.ts`, `webgpu/renderer.ts`.

`draw` split into `beginPass` / `encodeDraws` / `endPass` with a `PassScope` carrying the
`GPURenderPassEncoder` and `currentSets`; `draw` kept as a wrapper. More crosses the boundary here
than on WebGL, where only `passBlend` did, because the GPU pass object itself is the scope.

`webgpu/frame-backend.ts` mirrors WebGL's: `WebGPUFrameBackendState` plus module-level phase
functions and one `frameBackend(s)` binding. `_currentEncoder` and `_beginInfoFrame` opened up the
same way WebGL's caches were, so both backends now expose the same shape to their own frame module.

**A bug I wrote and caught by reading, not by testing.** My first `submitFrame` took the mip-regen
targets from `s.inFlight`, but `endPass` nulls `inFlight` before `submitFrame` runs, so mip chains
would never have been regenerated. Now `endPass` pushes any target with `generateMipmaps` onto a
pooled `mipTargets`, drained after submit and cleared on discard.

That bug is the WebGPU-has-no-pixel-harness risk made concrete. On WebGL, `cube-mips` and
`mrt4rgba16f*` would have gone red immediately. On WebGPU nothing would have failed: tsc passes, the
unit tests pass, and the mips would simply be missing. The asymmetry recorded at 1.3 is not
theoretical.

Verified: tsc 0, 400 tests, `webgl-render` all cases pass, biome clean on the touched files.

---

## Layer 2.10 — `WebGPURenderer.frame()` and an encoder-invariant test

`webgpu/renderer.ts`, new `tst/frame-encoder.test.ts` (3 tests).

Both renderers now hand out their one reusable `FrameState` via `frame()`.

The WebGPU path gets the closest thing it has to a harness: the stub GPU from
`render-encoder.test.ts`, driven through the frame API and asserting the same invariant that test
locks for `render(scene, camera)`.

- a frame of several passes is **one encoder, one submit**, with `drawCalls >= 2` so the assertion is
  not vacuous
- three frames are three encoders and three submits, so nothing leaks between them
- a pass that records nothing still opens and closes its GPU pass, and still submits

The plan said `render-encoder.test.ts` "gets rewritten". Adding the equivalent alongside is better:
both paths exist right now, so both should be pinned. It gets deleted with `render()`, not before.

Verified: tsc 0, 403 tests across 48 files, `webgl-render` all cases pass, biome clean.

---

## Layer 2 is done

Both backends split into `beginPass` / `encodeDraws` / `endPass`, both with a `FrameBackend` over
State plus functions, both renderers exposing `frame()`, and both paths pinned: real pixels on WebGL,
encoder ownership on WebGPU.

Standing asymmetry, worth keeping in view: WebGL regressions surface as wrong pixels, WebGPU ones only
as type errors or stub-level assertions. The mip-regeneration bug at 2.9 is what that costs.

---

## Layer 2.11 — tried to close the WebGPU verification gap, and could not

No production code. Two experiments, both negative, both worth recording so they are not retried.

**A browser WebGPU harness is not available here.** Playwright's bundled Chromium has no
`navigator.gpu` at all, not merely no adapter, across four flag sets:

    --enable-unsafe-webgpu
    --enable-unsafe-webgpu --enable-features=Vulkan
    --enable-unsafe-webgpu --enable-features=Vulkan,UseSkiaRenderer --use-angle=swiftshader
    --enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader --use-webgpu-adapter=swiftshader

All four report `{ gpu: false }`. So the WebGL harness's approach does not transfer, and the only
route to real WebGPU pixels is Node plus Dawn via the `webgpu` npm package. That is a native
dependency, so it is a decision for Isaac rather than something to add mid-loop.

**The 2.9 mip bug cannot be guarded with the current stub.** The idea was that mip generation records
and submits an encoder of its own, so it should show as a second encoder/submit pair. It does not
fire at all: `generateTextureMipmaps` returns early when `mipLevelCount <= 1`, and
`render-target.ts:238` creates render-target textures with `generateMipmaps = false`, so setting the
flag after construction gives no chain. The WebGL harness catches this class only because
`cube-mips` uses a `CubeRenderTarget`, which does get one.

Asserting it on the backend state instead is blocked by the vtable binding: `frameBackend(s)` closes
over the state, so `renderer._frameState` gives no route back to `mipTargets`. That is a real cost of
the binding, and the first time it has cost anything.

So the gap stands, now with a concrete case attached: **a bug that silently removes mip regeneration
on WebGPU passes tsc, passes 403 unit tests, and would ship.** That is the argument for the Dawn
harness, stated with evidence rather than as a worry.

---

## Layer 3.1 — `fullscreen()`, and a landmine in module-level node construction

New `src/objects/fullscreen.ts`, exported from the index, plus a pixel case.

```ts
fullscreenPosition(): Node<Any>          // clip position from vertex_index alone
vertexCountGeometry(count): Geometry     // no buffers, just a draw range
fullscreen(fragment): Mesh
```

Proven, not argued: a new harness case draws `fullscreen(vec4(0.2, 0.7, 0.4, 1))` through the frame
API with **no vertex buffer bound at all** and lands on `[51, 179, 102, 255]`. The layer 0 claim that
a bufferless geometry already works is now a passing pixel test.

**The important finding, and it cost five failing tests to learn.** `fullscreenPosition` was first a
module-level `/*@__PURE__*/` IIFE. Exporting it from `index.ts` broke **five golden snapshots** across
`wgsl-golden`, `glsl-golden` and `struct-texture-decode-golden`.

Node ids come from a global counter and emitted shader identifiers derive from them, so constructing
nodes at module scope renumbers every node built afterwards and rewrites identifiers in unrelated
shaders. The existing module-level nodes (`modelWorldMatrix`, `cameraProjectionMatrix` and friends)
are safe only because the goldens were recorded with them already there.

So **any new DSL constant must be built on call, never at module scope**, or it silently rewrites
every shader the goldens cover. `fullscreenPosition` is now a function for exactly this reason.

This is also the golden-snapshot invariant doing its job. The plan says they must stay byte identical
because neither the graph nor either emitter is touched; the moment that stopped being true they went
red, and they were right to.

Smaller finding: gpucat's DSL exports `shiftLeft` and `shiftRight` but **no bitwise AND, OR or XOR**,
so the canonical `(vid << 1) & 2` fullscreen trick is not expressible. `select` plus `equal` is, and
reads better.

Verified: tsc 0, 403 tests across 48 files, all three harnesses pass (`webgl-render` all cases,
48/48 GLSL, 38 shaders under naga), biome clean on the files I touched.

---

## Layer 3.2 — the frame API was unreachable from outside the package

`src/index.ts`, `tst/webgl-render/harness.ts`.

Stock-take before picking the next chunk turned up something embarrassing: **none of layers 1 and 2
were exported.** `renderer.frame()` returned a `FrameState` that a package consumer had no functions
to operate on. `grep -c` for `core/frame`, `core/pass-desc`, `core/target`, `core/view` and
`frame-backend` in `index.ts` returned 0. The harness only worked because it imports deep paths.

Now exported: `beginPass`, `draw`, `endPass`, `submitFrame`, `abandonFrame`, and the types
`PassDesc`, `DrawOpts`, `PassState`, `FrameState`, `Rect`, `Target`, `View`.

Deliberately not exported: `createFrameState` and `beginFrame`, which `renderer.frame()` owns, so a
consumer cannot double-begin a frame; `FrameBackend` and the two backend states, which are
implementation; and the `pass-desc` resolvers.

No name collisions: all ten candidate names were absent from the index, `draw` included.

The proof is that the harness now imports `beginPass`, `draw`, `endPass`, `submitFrame` and
`fullscreen` from `../../src/index` rather than deep paths, and both frame cases still pass. If the
surface were incomplete the harness would not compile.

Also recorded, since it is a standing risk rather than a finding: fifteen cycles in, the working tree
is 19 modified files (+523/-231) and 16 untracked, with no commit. That is a lot of unreviewed change
with no checkpoint, which is why this cycle chose the lowest-sprawl chunk available rather than
starting the `RenderPipeline` deletion that touches 39 examples.

Verified: tsc 0, 403 tests, `webgl-render` all cases pass, biome clean.

---

## Layer 3.3 — compute is a pass on the frame's encoder

`core/frame.ts`, `webgpu/compute.ts`, `webgpu/frame-backend.ts`, `webgl/frame-backend.ts`,
`webgpu/renderer.ts`, `core/render-types.ts`, `index.ts`, seven examples, `tst/compute-pass.test.ts`.

`beginComputePass(frame, desc)` / `dispatch(pass, node, opts)` / `endPass(frame, pass)`. The proof is
a test: a compute pass and a render pass in one frame produce **one encoder and one submit**, where
`renderer.compute()` then `render()` was two of each with a sync point between.

`PassState` is now a discriminated union of `RenderPassState` and `ComputePassState`, so `endPass`
takes either and `draw`/`dispatch` each take only the kind they belong to. Two pools, two indices,
both reset per frame, so a steady-state frame still allocates nothing.

`ComputeDispatch` is gone. It was a union with `never` fields on both branches; `DispatchOpts` is one
shape with optional `counts` and `indirect`, and `dispatch` throws unless exactly one is present,
which the union encoded in the type system and nowhere at runtime. `buffers` survived intact, since
lib's whole GPU voxel path rebinds named storage per dispatch.

`BackendComputeEntry` in `core/render-types.ts` was already structurally identical to the new
`DispatchRecord`, so it is deleted rather than adapted: one spelling, no shim. That renamed its
`dispatch` field to `counts` across seven examples, which reads better next to the `dispatch` verb.

**A hazard rejected during the work.** The first design made `renderer.compute()` a wrapper over
`renderer.frame()`. That collapses two code paths into one and would have given the new path seven
examples of free coverage, which is why it was tempting. It is also wrong: `frame()` returns the
renderer's *one reusable* `FrameState`, so a `compute()` call between a caller's `beginPass` and
`submitFrame` would silently `abandonFrame` their in-flight encoder. `compute()` therefore keeps a
local encoder, and the shared code is `encodeDispatches` plus `regenerateComputeMips`, which both
paths call. A test pins each side: one submit for the frame path, its own encoder for `compute()`.

Mip regeneration for storage textures written by compute now defers to `submitFrame`, alongside the
render-target mips already deferred there, because generation owns an encoder of its own and cannot
run while the frame's is open.

Two strays found and deleted while reading: an orphaned `compute()` jsdoc block sitting above
`_beginInfoFrame`'s own jsdoc, and an orphaned `render()` jsdoc above `frame()`. Both were left by
earlier cycles of this work.

`stub-gpu` gained a `dispatches` counter; without it no test could tell an encoded dispatch from a
silently skipped one.

Verified: tsc 0, 409 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on touched files.

**Correction inside the cycle.** The first version let `beginComputePass` succeed on WebGL and threw
from `encodeComputePass` at `endPass`, so a caller recorded dispatches into a pass that could never
run. The fix failed fast at begin. The first fix for *that* added a `supportsCompute: boolean` to
`FrameBackend`, which Isaac rejected as indirect: there are two backends, not an open capability set,
and both renderers already carry `readonly backend = 'webgl' | 'webgpu'`. `FrameBackend.name` now
holds that same tag (typed `BackendName`) and `beginComputePass` pivots on it. One vocabulary, not two.

**Second correction, from the vgpu read.** `dispatch( c, node, opts )` with `counts?` and `indirect?`
both optional plus a runtime "exactly one of" throw was the union-with-`never`-fields problem moved
from the type system into runtime, not solved. vgpu types the same choice as two overloads, so the
compiler enforces it and there is no check at all. gpucat now has `dispatch( c, node, counts, opts? )`
and `dispatchIndirect( c, node, buffer, opts? )`, which also matches WebGPU's own
`dispatchWorkgroups` / `dispatchWorkgroupsIndirect` split and the names gpucat's compute encoder
already uses internally. `DispatchOpts` narrows to just `buffers`, so the common call is positional,
which is the house API style. The runtime throw and its test are gone; the indirect test now proves
the path instead of proving a guard.

`DispatchRecord` keeps both fields, since the pooled record is mutated between forms, but it is
internal and the two entry points are what maintain the invariant.

---

## Layer 3.4 — a compute batch shares one GPU pass

`webgpu/compute.ts`, `webgpu/frame-backend.ts`, `tst/stub-gpu.ts`, `tst/compute-pass.test.ts`.

Acting on the three.js finding from the previous cycle's review. `encodeDispatches` opened one
`beginComputePass` per entry, so lib's radix sort (a dozen dispatches in a row) paid a dozen pass
begin/ends. three opens **one** pass for the whole group and dedups `setPipeline`
(`common/Renderer.js:2920-2965`, `WebGPUBackend.js:1855-1899`).

gpucat now does the same, with one honest exception: an attached inspector still gets one pass per
entry, because `timestampWrites` is a field on the *pass descriptor*, so per-node GPU timings are
impossible inside a shared pass. The cost is paid only when something is actually inspecting.

Three tests, and they are the whole argument: three dispatches of one node are one pass and one
`setPipeline`; two distinct nodes are one pass and two `setPipeline`; the same three dispatches with
an `InspectorBase` attached are three passes. `stub-gpu` gained `computePasses` and
`computeSetPipelines` for this, since nothing else could tell a batched pass from a split one.

`InspectorBase` turned out to be a concrete class of no-op methods rather than abstract, so the
inspector branch is testable with `new InspectorBase()` and needed no fake.

Verified: tsc 0, 413 tests across 49 files, `webgl-render` all cases pass, biome clean on touched files.

---

## Layer 3.5 — encoding a pass is atomic, because prepare must run outside the GPU pass

`core/frame.ts`, `core/renderer-ops.ts`, both `frame-backend.ts`, `tst/frame.test.ts`.

**The plan contradicted itself and the code made it concrete.** "Recording is two phase" says the
composite pass's `end()` triggers prepare, which evaluates the graph, "which opens and closes the
beauty passes on the same encoder before the composite's own GPU pass opens". "The backend interface"
then settled the opposite: core calls `beginPass`, then one `encodeDraws` that owns prepare *and*
encode, then `endPass`. Under that order prepare runs with the composite's GPU render pass already
open, and a nested pass on the same encoder is illegal in WebGPU.

The two-phase reasoning wins, because it is about correctness rather than taste. The interface note
was answering a different question (who owns the prepare/encode split) and had not considered
`PassNode`'s nesting at all.

`beginPass` / `encodeDraws` / `endPass` collapse into one `encodePass( desc, records, count )`. Each
backend now resolves context, prepares, *then* opens its GPU pass, encodes and closes it. Core never
held a half-open pass anyway: it called the three in fixed sequence and gained nothing from the split.

Three things fell out, all of them simplifications:

- `abandonFrame` no longer calls into the backend to close a dangling pass. Atomic encoding means
  there is never a GPU pass open outside `encodePass`, so abandoning drops the recorded pass and
  discards the frame.
- `endPass` clears `frame.open` **before** encoding. That is what lets a nested `beginPass` run during
  prepare, and it is the "tolerate a pass beginning while another is mid-`end()`" the plan asked for.
- The backends' `inFlight` state is gone entirely; context, params and scope are locals of `encodePass`.

**One real bug this would have introduced, caught by thinking about the aliasing rather than by a
test.** Both backends held a single `prepared: PreparedRenderObject[]` on their state. With nesting, a
nested pass's prepare would clobber the outer pass's list while the outer was still mid-prepare, and
the outer's earlier entries would be lost. It is now one list per nesting depth (`preparedByDepth`
plus a `depth` counter, `preparedAt` in `core/renderer-ops.ts`), grown on demand, so a steady-state
frame still has exactly one array and allocates nothing.

Four tests: a pass opened from inside another's encode lands on the stream first and in order; a
nested pass takes its own pool slot and leaves the outer's records intact; a pass still cannot open
while another is *recording*; a throw inside encode leaves the frame able to open another pass.

The middle two are the rule in full: nesting is legal during encode, never during recording. The first
draft of that test tried to nest while recording and failed, correctly.

Verified: tsc 0, 416 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders under
naga, biome clean on touched files.

---

## Layer 3.6 — the scene walk becomes an ordinary function

`src/scene/draw-scene.ts` (new), `core/frame.ts`, `index.ts`, `tst/webgl-render/harness.ts`.

`drawScene( gpu, pass, scene, camera, opts? )` collects the render list and records each visible mesh
with `draw`. It unblocks both remaining layer-3 items: `PassNode` needs it to express its Scene form,
and deleting `RenderPipeline` needs it to replace `renderer.render( scene, camera )`.

**The plan's signature was `drawScene( p, scene, camera )`, with no gpu, on the grounds that the tree
walk uses "only public API". That does not survive contact.** `collectRenderList` needs
`RenderListsState`, the per-(scene, camera) cache that keeps a steady-state frame from rebuilding and
reallocating its lists every frame. A `RenderPassState` carries no renderer, so the cache has to come
from somewhere. The alternatives were a module-scope side map, which is exactly the thing not to do,
or rebuilding the list per call, which is a per-frame allocation. Taking the gpu is the plan's own
stated rule anyway: resources stay declarative, operations take the gpu, and `drawScene` is an
operation. `RendererState` is the parameter type, so it becomes `Gpu` for free in layer 4.

**`DrawOpts` gained `material`.** The render list resolves each item's material, which is
`overrideMaterial` when one is set and `mesh.material` otherwise, so `draw` needed a way to say "this
submission uses that material". It is the same shape of fact as `instances` and `draws`: how one
submission differs, not what the mesh is. The override is identical for every item in a pass, so one
opts object is built per `drawScene` call rather than one per draw.

**Proven by pixels, because nothing weaker would do.** A stub test can show `draw` was called; it
cannot show the render list's sort survived. The new `draw-scene` harness case puts a transparent blue
mesh into the scene **first** and an opaque red mesh second. Insertion order would leave pure red;
correct opaque-before-transparent ordering leaves half blue over red. It reads `[128, 0, 128, 255]`,
which is that blend exactly.

Goblin pass turned up another orphan: a five-line jsdoc describing `prepareRenderObjects` sitting
above `prepareRecordedDraws`'s own one-liner in `core/renderer-ops.ts`, left by an earlier cycle.

Two pre-existing biome findings are in files this cycle touched but in code it did not write
(`handleDeviceLost`'s string concatenation, a `forEach` returning a value in the harness). Left alone.

Verified: tsc 0, 416 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders under
naga, biome clean on the files this cycle wrote.

---

## Layer 3.7 — the frame path was missing five things `render()` does

`webgpu/frame-backend.ts`, `webgl/frame-backend.ts`, `tst/frame-encoder.test.ts`.

This cycle set out to port `PassNode` onto the frame API and stopped to check parity first, which was
the right order: grepping `encodePass` for what `render()` does returned **zero matches for all five**.

1. **`nodeFrame.beginRender()` / `endRender()`.** Every pass in a frame shared one `renderId`, so
   RENDER-scope node updates ran once per *frame* instead of once per *pass*. A uniform that should
   refresh for the second pass kept the first pass's value. This is the severe one.
2. **`mrt.resolveOutputs(...)`.** `PassDesc.mrt` was threaded into the render context and never
   resolved, so MRT through the frame API wrote to the wrong attachment indices or none.
3. **`Geometries.incrementCallId`** (WebGPU only), which dedupes per-render geometry uploads.
4. **`info.render.calls` / `frameCalls`**, never incremented, so `renderer.info` read zero renders in a
   frame-API app.
5. **`device.pushErrorScope('validation')`** and its pop, so WebGPU validation errors on the frame path
   were silently discarded. Worth noting on its own: every frame-API bug so far has been found by
   reading or by pixels, with the API's own validation reporting switched off.

All five now run inside `encodePass`, per pass rather than per frame, which is the correct scope for
each of them.

**Why nothing caught this.** The `webgl-render` harness cases are single-pass and non-MRT, so one
renderId per frame and one per pass are indistinguishable there, and `resolveOutputs` is never
reached. The lesson is that harness coverage was shaped by what was easy to write, not by what the
frame path actually does differently from `render()`.

`PassNode` would have hit items 1 and 2 immediately, since it is a second pass in the same frame and
its whole purpose includes MRT. Checking parity before porting saved debugging that through the
renderer.

Two tests: four passes across two frames mint four distinct renderIds and each pass restores the scope
it opened in; `info.render.frameCalls` counts passes rather than frames. The first draft asserted on
`nodeFrame.renderId` after `endPass` and failed, correctly, because `endRender` restores it. The
observable that actually proves a fresh scope per pass is the counter's delta.

Verified: tsc 0, 418 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders under
naga, biome clean on touched files.

---

## Layer 3.8 — PassNode records a pass, and `render()` becomes the scene layer

`nodes/lib/display/pass-node.ts`, `core/renderer-interface.ts`, `core/pass-desc.ts`,
`core/renderer-ops.ts`, both renderers, `tst/viewport-scissor.test.ts`.

`PassNode` no longer saves renderer state, sets target/mrt/clearColor, calls `render()` and restores.
It opens a pass on the renderer's open frame, records into it, and ends it. `pass()` and `depthPass()`
take `PassContents = Object3D | ((pass) => void)`, so the Scene form is `drawScene` and the recorder
form is the caller's own draws. The slogan the plan wanted is now literally true in the code: nodes
never mutate renderer state.

**This forced `renderer.render()` to be rewritten, and that is the good news.** A `PassNode` records on
`renderer._frameState`, which the old `render()` never opened, so both harness `pass` cases died with
`Cannot read properties of null`. The fix is the plan's own stated test: `render( scene, camera )` is
now one `frame()`, one `beginPass`, one `drawScene`, one `endPass`, one `submitFrame` on both backends.
The scene tree is a layer rather than a privileged path, and the proof is that the beauty-pass pixel
cases (`passdepthsample`, `passocclude`) pass through it unchanged.

That deleted four functions outright: `prepareRenderObjects`, `resolveViewportScissor`, and both
backends' `executeRenderPass`, plus WebGPU's private `draw`. Nothing referenced them but comments.

**Two bugs this cycle nearly shipped, both caught by tests rather than by reading.**

1. Deleting `resolveViewportScissor` silently dropped scissor **clamping**. `ops.scissorRect` converts
   logical to physical pixels but does not pull a negative origin to zero, shrink an oversized extent
   to the framebuffer, or skip a rect that covers everything. `tst/viewport-scissor.test.ts` went red
   on all of it. The clamp now lives in `resolvePassContext`, which is the right place because it is
   the only step that knows the target's size. Deleting a function whose tests still pass is safe;
   deleting one whose tests go red means the behaviour had nowhere else to live.
2. `render()` passed `ops.viewportRect(this)` unconditionally, so the swapchain viewport would have
   overridden a `RenderTarget`'s own. The old code preferred the target's. Both renderers now pass the
   swapchain pair only when `renderTarget === null`, and the test that names this exact leak
   ("a render target uses its own viewport/scissor, not the swapchain state") is what caught it.

**Two more dead `PassDesc` fields found and wired.** `layer` and `mipLevel` were declared and never
read; the backends take the face and level off `CubeRenderTarget.activeFace` / `activeMipmapLevel`.
`resolvePassContext` now lands the desc there. Same family as last cycle's five: the desc grew fields
faster than the path that consumes them. A target's own `viewport` / `scissor` were being ignored by
the frame path too, and now fall back in behind the desc.

**Left standing on purpose.** The node contract keeps `render`, `renderTarget`, `mrt` and `clearColor`
because `QuadMesh` and `CubeCamera` still drive the renderer through them, and both go with
`RenderPipeline`. Removing them now would drag 39 examples into this cycle, which is the ordering
Isaac set: examples last.

Verified: tsc 0, 418 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders under
naga, biome clean on touched files.

---

## Layer 3.9 — CubeCamera records six passes

`camera/cube-camera.ts`, `core/renderer-interface.ts`, `tst/webgl-render/harness.ts`.

`CubeCamera.update` no longer sets `renderer.renderTarget`, calls `render()` six times and restores.
It opens a frame, records six passes with `layer: face`, and submits. The save/restore of
`renderer.renderTarget` is gone outright, since nothing is mutated to need restoring.

The node contract gained `frame(): FrameState` alongside `_frameState`. They are not the same thing
and the distinction is load-bearing: `frame()` opens the reusable frame, which is what top-level work
like `CubeCamera.update` needs; `_frameState` is that frame *while it is open*, which is what a node
records into during `updateBefore`. A node must never call `frame()`, because that would abandon the
frame it is running inside.

**The pixel case is chosen to fail if the new `layer` wiring is dead.** `PassDesc.layer` only started
reaching `CubeRenderTarget.activeFace` last cycle. So `cube-camera` clears the cube target to a known
colour over an empty scene, then samples the **-X** face. If `layer` never landed, all six passes
would write face 0 and the -X read would come back as untouched texture instead of the clear colour.
It reads `[51, 204, 102, 255]`, which is (0.2, 0.8, 0.4) exactly.

`caseCubeMips` already covered per-face writes, but it sets `rt.activeFace` by hand, so it proves the
backend honours the field rather than that the desc reaches it. Those are different claims.

**One consumer of the ambient contract left.** `QuadMesh.render` is now the only caller of
`Renderer.render`, and `RenderPipeline` the only holder of `Renderer`. Both go together, and both drag
the 39 examples with them, so they wait for the examples layer. After that the contract's `render`,
`renderTarget`, `mrt` and `clearColor` all delete.

Noted while reading, not acted on: `getRenderContext`'s `callDepth` parameter is passed a literal `0`
at every call site, in the old `render()` as well as in `resolvePassContext`. It is a dead cache-key
component, not a behaviour difference.

Verified: tsc 0, 418 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders under
naga, biome clean on touched files.

---

## Layer 4.1 — the inspector's scene input, and a counter that outlived its job

`scene/draw-scene.ts`, `core/canvas-target.ts`, `core/renderer-interface.ts`, `core/info.ts`,
both renderers, `webgpu/render-pass.ts`, `tst/frame-encoder.test.ts`.

The plan's inspector section calls the viewer path a rewrite and says a dev tool may keep concrete
coupling. So this cycle did not start one; it fixed what the port to the frame API actually broke.

**A regression I introduced last cycle and had not noticed.** `beginRenderScene` fired from
`renderer.render()`. Once `PassNode` stopped calling `render()` and started recording a pass, beauty
passes vanished from the scene-hierarchy tab. Nothing failed, because no test watches the inspector.

The fix puts `beginRenderScene` in `drawScene`, which is the only place that knows a pass draws a
tree. It now fires for `render()`, for `PassNode`'s scene form and for `CubeCamera`, and correctly
does not fire for a pass recorded by hand. That is the plan's open question answered by construction
rather than by a policy: a pass with no tree reports no tree, because reporting is part of walking one.

**`CanvasTarget` gained `colorFormat`,** because `drawScene` needs the pass's colour format for that
report and a canvas target did not know its own. The backend stamps it where it configures the
context. This is the same move as the earlier cycles that gave `CanvasTarget` its `depthFormat`,
`samples`, `clearColor` and dpr clamp: swapchain configuration belongs on the target, and the backend
owns only the texture.

**`_renderCallDepth` is deleted.** It was the re-entrancy guard doubling as a frame boundary. With
`PassNode` recording rather than re-entering `render()`, it only ever went 0 to 1 to 0 inside
`compute()`, and WebGL's copy was declared and never read at all. `beginFrame` and `submitFrame` are
the boundary now. A stale comment in `info.ts` still explained the counter's depth-guard; scrubbed.

The test is the rule in one line: a frame with one walked pass and one hand-recorded pass reports
exactly `['walked']`. It needed a three-line `InspectorBase` subclass, which is the first test in this
work to watch the inspector at all, and is why the regression above went unseen.

Verified: tsc 0, 419 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders under
naga, biome clean on touched files.

---

## Layer 4.2 — QuadMesh, __quadCamera__ and save/restoreRendererState deleted

`objects/quad-mesh.ts` (deleted), `core/render-pipeline.ts`, `objects/fullscreen.ts`,
`core/renderer-interface.ts`, `inspector/tabs/viewer.ts`, `inspector/inspector.ts`, both renderers,
`tst/pass-desc.test.ts`.

All of this is src-only: `RenderPipeline`'s public API is untouched, so the 39 examples are untouched
and the eventual deletion shrinks to a pure API swap.

`RenderPipeline.render()` is now one frame, one pass, one `draw` of a `fullscreen()` mesh. It no longer
goes through `renderer.render()`, so it walks no tree and needs no camera. The inspector's viewer tab
lost the save-state / swap-canvas-target / restore dance entirely: it opens a frame against the
preview's own `CanvasTarget` and draws.

That emptied three things out:

- **`QuadMesh`**, with the module-level shared geometry and the `__quadCamera__` it carried.
- **`saveRendererState` / `restoreRendererState`** on both renderers, whose last caller was the viewer.
  The plan said they exist only because of nested render; with nothing nesting through `render()` any
  more, they had no callers at all.
- **`render` and `mrt` off the node contract.** Nothing in src drives the renderer now. What is left
  (`renderTarget`, `getCanvasTarget`, `clearColor`, `autoClear`) is read to build a `PassDesc`.

**The real find, and it cost a red pixel test to get.** `pass-occlude` failed with both halves reading
`[232, 0]`, a constant. `fullscreen()` built its mesh on `vertexCountGeometry(3)` with **no vertex
buffers at all**, which layer 3.1 recorded as a virtue. But a `TextureNode` defaults its coordinate to
`varying(uv())`, the **uv vertex attribute**. So a post chain reading `pass.getTextureNode().rgb`
sampled an unbound attribute and got the same texel everywhere.

`caseFullscreen` never caught it because its fragment is a constant colour. The plan's line
"`fullscreen()` replaces `RenderPipeline`" was wrong about *why* `QuadMesh` had value: it was not just
a triangle, it was a triangle **with uvs**, and the default sampling path depends on them.

`fullscreen()` now carries the position+uv triangle. `fullscreenPosition` and `vertexCountGeometry`
stay exported as the genuinely bufferless primitives, for a fragment that never samples by uv. Two
tests pin the distinction, because it is exactly the kind of thing that gets "simplified" back.

Bisecting this was three experiments: a camera on the composite pass (no change, ruled out the null
camera), then the old attribute-based material (passed, isolating the mesh), then reading
`TextureNode`'s default `uvNode`. Worth noting the first two guesses were both wrong.

Repaired along the way: a scripted deletion matched the brace of `saveRendererState`'s *return type
annotation* rather than its body and corrupted `webgpu/renderer.ts`. Fixed in place by hand.

Verified: tsc 0, 421 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders under
naga, biome clean on touched files.

---

## Layer 4.3 — DrawOpts was dead the whole time

`core/draw-range.ts`, `core/renderer-ops.ts`, both `render-pass.ts`, both `frame-backend.ts`,
`tst/prepare-recorded-draws.test.ts`, `tst/webgl-render/harness.ts`.

Auditing `DrawOpts` the way `PassDesc` got audited twice: `grep` for readers of `DrawRecord.opts`
returned **one hit, the line that writes it**. `instances`, `range` and `draws` have been declared
since layer 1 and consumed by nothing. `draw( pass, mesh, { draws } )` silently did nothing.

That is the worst of the dead-field findings, because `DrawOpts` is the plan's whole argument for the
frame API: per-submission facts belong on the submission, not on a shared long-lived object. lib sets
`mesh.visible` and mutates `geometry.drawRange` on client-global batches precisely because there was
nowhere else to put them, and `mesh.draws` is named in the plan as must-keep. The replacement existed
in the type and nowhere else.

Now wired end to end. `prepareRecordedDraws` fills a second array of opts in lockstep with the
prepared objects, and both backends carry it per nesting depth beside `preparedByDepth`.

**A parallel array rather than a field on `RenderObject`, and that is not arbitrary.** `RenderObject`s
are cached by (mesh, material, camera, passCtx, passId), so the same mesh drawn twice in one pass
returns the *same* object. Storing opts on it would make the second submission's overrides win for
both. Sharing the render object is correct, since opts change no pipeline and no bind group; only the
draw-call arguments differ, and those are read at encode time from the parallel slot.

`resolveIndexedDrawRange` and `resolveVertexDrawRange` take an optional override and keep their
existing clamping, so `range` cannot overrun a buffer any more than `geometry.drawRange` can.

Two tests on the alignment, including one where a draw is dropped mid-list, since that is how a
parallel array goes wrong. Then the one that matters: a `draw-opts` pixel case draws **one geometry
twice in one pass**, differing only by `range` — left half green, right half red. The geometry's own
`drawRange` covers everything, so if `range` were ignored both draws would cover the screen and red
would win. Reading the left half returns green.

Verified: tsc 0, 423 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on the files this cycle wrote.

---

## Layer 4.4 — PassDesc.target was ignored for canvases

`webgpu/render-pass.ts`, `core/render-types.ts`, `core/pass-desc.ts`, both renderers,
`tst/frame-encoder.test.ts`.

Continuing the audit that found the dead `DrawOpts`. Checking who reads `CanvasTarget`'s fields turned
up something worse than a dead field: `resolveSwapchainAttachments` opened its context against
**`sc.canvasTarget`**, the swapchain's own target, and never looked at the pass. So on WebGPU,
`beginPass( frame, { target: someOtherCanvas } )` drew to the renderer's current canvas instead.

That is the frame API's central promise ("the target is an argument") failing for one of the two
target kinds. It also means the inspector viewer I ported last cycle, which renders each preview to
its own `CanvasTarget`, would have drawn every preview onto the main canvas on WebGPU. The WebGL pixel
harness could not see it: WebGL has one context per canvas, so it only ever had one.

`RenderPassParams` now carries `canvasTarget`, `resolvePassParams` fills it from the desc, and
attachment resolution uses it.

**The depth and MSAA textures had to move with it.** They were a single shared pair on
`SwapchainState`, with a comment admitting the renderer "can drive multiple canvas targets of differing
size/pixelRatio, so a target swap or resize race can leave them a frame stale" and reconciling by
recreating. With per-pass targets that reconciliation becomes a destroy-and-create on *every* pass
whenever two canvases of different size alternate, which is what a viewer with several previews does
every frame. They are now a `WeakMap<CanvasTarget, CanvasAttachments>`, and each target's own `samples`
and `depthFormat` drive its own attachments rather than the swapchain's.

That also makes `CanvasTarget.samples` and `.depthFormat` mean something for the first time. They were
read once, at renderer construction, into the single swapchain state; a second target's values were
ignored entirely.

Two tests. One asserts a second `CanvasTarget` gets its `colorFormat` stamped, which only happens if
its context is configured, which only happens if the desc's target is honoured. The other asserts two
targets hold distinct depth textures.

Verified: tsc 0, 425 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on touched files.

---

## Layer 4.5 — clearDepth was dead, and the RenderContext clear fields were why

`core/pass-context.ts`, `core/pass-desc.ts`, `core/render-types.ts`, both `render-pass.ts`,
both renderers, `tst/pass-desc.test.ts`, `tst/webgl-render/harness.ts`.

Finishing the surface audit. **`PassDesc.clearDepth` did nothing in either form.** Both backends
hardcoded the clear: `depthClearValue: 1.0` on WebGPU, `gl.clearDepth(1.0)` on WebGL. So `clearDepth:
false` still cleared and `clearDepth: 0` still cleared to 1, which makes reversed-Z impossible through
the frame API. vgpu documents that exact case on its own pass options.

`RenderPassParams` now carries `autoClearDepth` and `clearDepthValue`, and both backends read them.

**The reason it went unnoticed is the more useful finding.** A test *did* assert
`ctx.clearDepthValue === 0`, and it passed. `resolvePassContext` parsed the desc into six
`RenderContext` fields, `clearColor`, `clearDepth`, `clearStencil` and their three values, that
**nothing read**. The test proved the desc was parsed, never that the value reached the GPU, and the
duplicated state made the two look like one.

All six are deleted. `RenderPassParams` is the only shape a backend reads, and the tests now assert on
it. That is the general lesson from this whole audit run: a value computed into a second copy of the
state looks tested and is not.

The pixel case is the proof and it was checked both ways. `clear-depth` clears depth to 0 and draws a
fragment at 0.5 with a `greater` compare, so it passes only because the buffer started at 0. Removing
`clearDepth: 0` from the desc turns it red (`[255, 0, 0, 255]`); putting it back turns it green. A
green test that cannot go red proves nothing, and three of this run's findings were exactly that.

Two pre-existing `useOptionalChain` warnings in `pass-context.ts` are in code this cycle did not
write. Left alone.

Verified: tsc 0, 426 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on the files this cycle wrote.

---

## Layer 4.6 — device loss, and a guard I had deleted

`webgpu/frame-backend.ts`, `webgl/frame-backend.ts`, both renderers, `tst/frame-encoder.test.ts`.

**A regression of my own, found by reading the comment next to it.** Rewriting `WebGLRenderer.render()`
onto the frame API in layer 3.8, I dropped its `if (this._isDeviceLost) return;`. The comment on the
`webglcontextlost` handler still read "We flip `_isDeviceLost` (render() early-returns while lost)",
which was no longer true of the code twenty lines away. Nothing failed: the pixel harness never loses
a context.

Fixing it only in `render()` would have been the small version of the fix. `render()` is one caller of
the frame path now, and a host driving `frame()` / `beginPass` / `submitFrame` from its own animation
loop had **no** device-loss handling at all, so the first frame after a GPU reset called
`createCommandEncoder` on a destroyed device, every frame, forever.

So the guard went where the whole API passes through it: every phase of both frame backends no-ops
while the device is lost (`usable(s)`), which is `_isDeviceLost` on WebGPU and `_isDeviceLost || gl
=== null` on WebGL. A lost device now makes a frame a silent no-op rather than a crash, which is what
an animation loop needs.

Separately, `frame()` had no `_initialized` guard where `render()` throws one. On an uninitialised
renderer `this.device` is `null!`, so the failure was a `TypeError` from inside the backend rather
than the message that says what to do. Both renderers now throw the same "called before init" error
`render()` does.

Two tests: a full frame recorded and submitted after `_isDeviceLost` produces zero encoders, zero
draws and zero submits; `frame()` before `init()` throws.

Comment scrubbed to match: the handler now says every frame phase no-ops while lost.

Verified: tsc 0, 428 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on touched files.

---

## Layer 4.7 — a pass aligns its own camera

`core/view.ts`, `core/pass-desc.ts`, both `frame-backend.ts`, both renderers,
`tst/frame-encoder.test.ts`.

Same family as the device-loss finding, and found by asking the same question: what else did
`render()` carry that the frame path does not?

`render()` stamped `camera.coordinateSystem` with the backend's clip convention and rebuilt the
projection, so one camera could drive both backends. `beginPass` did not. `Camera` defaults to
`WEBGPU`, so a camera that never passed through `render()` kept z in [0,1] on WebGL: silently wrong
depth, not a crash.

**And the layer 3.8 `PassNode` port removed the only thing that stamped a pass camera**, since
`PassNode.updateBefore` stopped calling `render()`. The harness did not notice because every `pass`
case draws fullscreen triangles with `depthTest: false`, where the projection is irrelevant.

`View` gained an optional `updateProjectionMatrix?()`. That is the honest shape: `View` is what core
reads from a camera, and rebuilding a projection is the one thing core sometimes needs a camera to
*do*. `alignCameraToBackend` lives in `pass-desc.ts` and both backends call it at the top of
`encodePass`, so every path funnels through one place: `render()`, `PassNode`, `CubeCamera`,
`RenderPipeline` and a raw `beginPass`. Both renderers' own copies are deleted.

A `View` that does not implement it is simply not rebuilt, which the type documents and a test pins.
That is the right default for a minimal view: core reads it, the caller owns its consistency.

Three tests: a WEBGL-built camera is rebuilt for a WebGPU pass and its projection actually changes; a
matching camera's projection is left byte-identical, so alignment is not doing work every frame; a
bare `View` with no rebuild method does not throw.

Considered and rejected: throwing on a mismatch instead of rebuilding. It is the more explicit design
and fits "no magic", but `Camera` defaults to WEBGPU, so every WebGL user recording a pass would hit
it on their first frame, and the existing behaviour it would replace was already an auto-rebuild. That
is a bigger API-philosophy change than a correctness fix should smuggle in.

Verified: tsc 0, 431 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on touched files.

---

## Layer 4.8 — the last two things only `render()` did

`webgpu/render-pass.ts`, both `frame-backend.ts`, both renderers, `tst/frame-encoder.test.ts`.

Same question a third time, and the list is now empty.

**A zero-sized target skips its pass.** `render()` returned early when the canvas had zero width or
height, which happens when a tab is backgrounded or a canvas is display:none. A frame-API host got no
such guard: `getCurrentTexture()` on a zero-size canvas is a validation error, every frame, for as
long as the tab stays hidden. Both backends now return from `encodePass` when the resolved context has
no area, which covers a zero-sized `RenderTarget` too.

**Safari's dropped context configuration.** `render()` called `_resize`, which reconfigures the canvas
context unconditionally because Safari drops the configuration on every backing-store resize. The
frame path never called it, so a frame-API host on Safari would hit an unconfigured context after any
resize. `resolveSwapchainAttachments` now reconfigures when the target's backing-store size differs
from what it was last configured against, tracked per target on `CanvasAttachments`. Steady state
costs one size comparison; `_resize` keeps its eager version for the explicit `setSize` path.

Both guards are deleted from `render()`, which is now purely "build a `PassDesc` from the ambient
fields, walk the scene, submit".

The zero-size test was checked both ways: without the guard the stub still hands back a texture and
the draw lands, so `drawCalls` is 1 and the test goes red. A second test proves the skip is per pass,
not per frame, by putting a hidden target and a real one in the same frame.

Also scrubbed: `setCanvasTarget`'s comment still claimed the swapchain path resolves its present
target from `swapchain.canvasTarget`, which stopped being true in layer 4.4 when `params.canvasTarget`
took over. It is now the fallback for `renderTarget === null` and nothing more.

Verified: tsc 0, 433 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on touched files.

---

## Layer 4.9 — compile() pre-warmed a pipeline no pass ever used

`webgpu/renderer.ts`, `tst/frame-encoder.test.ts`.

The `render()` audit is exhausted, so the same lens went on the other renderer entry points. `compile`
is the one that was built beside rather than under.

It created its own `RenderContext` with `getRenderContext(contexts, null, null, 0)`, the **swapchain**
context, and took a `samples?: number` to approximate the rest. But a render pipeline is keyed by
sample count, colour formats, depth format and MRT, all of which come from the target. So compiling a
scene that is then drawn to a `RenderTarget` warmed a key that pass never looks up, and the pass
compiled the pipeline again, synchronously, on the frame it was supposed to have been warmed for.

`compile( scene, camera, target? )` now resolves its context through `resolvePassContext`, the same
function `encodePass` uses, so the key is identical by construction rather than by matching fields by
hand. `target` defaults to where `render()` would put it, so the four examples calling
`compile(scene, camera)` are unchanged.

**The test is the measurement.** Compile for a render target, count `pipelines.renderPipelines.size`,
then draw that scene to that target through the frame API and assert the count is unchanged. Pointing
the compile context back at the canvas makes it read `expected 2 to be 1`: one pipeline warmed, a
second built at draw time. That is the whole bug in one number.

Checked and clean: `compileCompute` shares `_computeContext` with both `compute()` and
`encodeComputePass`, so the compute pre-warm was always correctly keyed. `WebGLRenderer` has no
`compile`; its programs are cached by source, so there is no key to mismatch.

Still open from the plan: `compile( gpu, drawables, target )` taking drawables rather than a scene.
That is the layer 4 reshape, and it touches example call sites, so it waits.

**Done in layer 4**, and it takes a camera too: `compile(gpu, drawables, target, camera)`, because the
warm has to resolve through the same pass context the pass will.

Verified: tsc 0, 434 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on touched files.

---

## Layer 4.10 — out-of-band encoders refuse to run inside a frame

`core/frame.ts`, both renderers, `tst/frame-encoder.test.ts`.

A hazard the explicit frame introduces rather than inherits. Grepping `createCommandEncoder` outside
the frame backends found four owners: `dispatchCompute`, `readPixels`, `clear` and mipmap generation.
Mipmaps already defer to `submitFrame`. The other three submit **immediately**, so calling any of them
between `frame()` and `submitFrame()` puts their work on the queue *ahead* of everything the frame has
recorded.

`readPixels` is the one that fails silently. A host that records passes and then reads back before
submitting gets the previous frame's pixels, with no error and no clue. Under `render()` this could
not happen, because `render()` submitted before it returned; the whole point of the explicit frame is
that submission is now the caller's, which is exactly what opens the gap.

`isFrameOpen(frameState)` is one predicate in `core/frame.ts`, true between `frame()` and
`submitFrame()`. `readPixels` rejects, `clear` and `compute` throw, each naming what to do instead:
submit first, record a pass, use `beginComputePass`.

Throwing rather than auto-submitting is the deliberate choice. Auto-submitting would silently split a
frame the caller believed was one, which is the same class of surprise in the other direction.

Two tests: `readPixels` rejects with the open-frame message and, after `submitFrame`, no longer does;
`compute` and `clear` throw while a pass is recorded. The readback assertion is deliberately narrow,
since the stub cannot perform a real readback, so it asserts the guard is gone rather than that pixels
come back.

Verified: tsc 0, 436 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on touched files.

---

## Layer 4.11 — methods restored on the public API

`core/frame.ts`, `index.ts`, and every call site: both renderers, `PassNode`, `CubeCamera`,
`RenderPipeline`, the inspector viewer, `drawScene`, four test files and the harness.

**A correction from Isaac, and he is right.** The "functional TS" guidance was about orchestration and
backend state. I applied it to the front-facing surface too, turning the plan's `f.pass(desc)` /
`p.draw(x)` / `p.end()` / `f.submit()` into `beginPass(f, desc)` / `draw(p, x)` / `endPass(f, p)` /
`submitFrame(f)`, and then edited the plan to match so the original shape stopped being visible.

`Frame`, `Pass` and `ComputePass` are object literals over the same state, with methods that delegate
to the module's own functions. Nothing about the internals changed: the pools, the records and the
`FrameBackend` vtable are still plain data with no privates, and the functions are still there, just
no longer the door. `createFrame` builds a frame whose `pass`, `computePass`, `submit` and `abandon`
close over it; the pooled pass objects get `draw`/`end` and `dispatch`/`dispatchIndirect`/`end` once,
at creation, so a steady-state frame still allocates nothing.

`index.ts` now exports the three handle types and the descs, not the verbs. That is a smaller public
surface than before, since the verbs were nine exports and the methods are none.

Two things came back with the methods, both recorded rather than papered over:

- **The `pass` naming collision returns.** `f.pass(desc)` and the node `pass(contents, camera)` are
  both "pass" again. It is reader confusion, not a symbol clash, since one is a method. The plan's
  Open item said this was "resolved as a side effect of going flat"; that resolution is withdrawn and
  the item is live again, to decide before the examples are ported.
- **Error messages name methods now**: "end() called twice", "submit() while \"scene\" is still open",
  "draw after end()". The tests assert on those strings, so they moved with them.

The conversion was mechanical and the four verification layers carried it: 436 tests and every pixel
case passed on the first full run after the call sites were rewritten.

Verified: tsc 0, 436 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on the files this cycle wrote.

---

## Layer 4.12 — frame.compute(), and clear flags that are actually independent

`core/frame.ts`, both `render-pass.ts`, both renderers, `tst/pass-desc.test.ts`,
`tst/webgl-render/harness.ts`, three test files.

**`frame.computePass()` is now `frame.compute()`.** Isaac asked whether vgpu uses the longer name: it
does, `frame.pass(...)` and `frame.computePass(...)`, so gpucat had matched it by coincidence rather
than by choice. `frame.compute()` also lines up with `renderer.compute()`, which is the same verb
distinguished only by who owns the encoder, and that reads as a deliberate pair rather than two
spellings.

**Then the clear flags, which were not independent despite the type saying so.** `PassDesc` has
`clear`, `clearDepth` and `clearStencil`, and `resolvePassParams` resolved all three separately, with
a passing test to prove it. Both backends then threw two of them away: WebGPU used
`params.autoClear && params.autoClearDepth` for the depth load op and gated stencil the same way, and
WebGL only reached its clear code at all when `params.autoClear` was true. So `clear: false` meant
"preserve everything" and a depth-only clear was unreachable.

This is the same shape as the `clearDepth` finding two cycles ago: the desc parsed correctly, a test
asserted the parse, and the backend dropped it. Asserting on `resolvePassParams` was an improvement
over asserting on the `RenderContext` copy, but it still stops one layer short of the GPU.

All three are independent now. `render()` maps its single `autoClear` switch onto them explicitly
(`clearDepth: this.autoClear ? undefined : false`), which keeps the viewports example compositing
several views into one canvas without the depth buffer being wiped between them.

**The pixel case only exists because it can fail.** `clear-depth-only` runs two passes on one target:
the first writes green at depth 0.5, the second preserves colour but clears depth to 0 and draws blue
at 0.5 with a `greater` compare. Blue wins only if depth was cleared while colour was kept. It read
green (the old combined behaviour) until the WebGL gate was fixed, which is how the WebGL half of the
bug was found: the WebGPU fix alone left it red.

Verified: tsc 0, 437 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on touched files.

---

## Layer 4.13 — clear() is an empty pass, and the parallel clear path is gone

`webgpu/renderer.ts`, `webgl/renderer.ts`, both `render-pass.ts`, `tst/webgl-render/harness.ts`.

`renderer.clear( color, depth, stencil )` owned its own command encoder and its own implementation of
clear semantics: `RenderPass.clear` resolved attachments as though `autoClear` were true, then
**overrode each load op** afterwards. That is a second answer to "what does this pass clear", parallel
to the one in `resolvePassParams`, and the two had already drifted in opposite directions, which is
what last cycle's combined-flags bug was.

With the three flags independent, a pass expresses it directly: a pass with no draws opens its
attachments with the load ops the desc asks for and closes them. So `clear()` is now four lines of
desc, and both `RenderPass.clear` implementations are deleted along with the third out-of-band
encoder. Only mipmap generation still owns one, and that defers to `submitFrame` by design.

**One behaviour change, worth naming.** The old WebGL manual clear explicitly disabled the scissor
test so the whole framebuffer cleared regardless. A pass honours the target's scissor. For a canvas
target nothing changes, since the swapchain pair only reaches a pass through the desc and `clear()`
does not set it. For a `RenderTarget` with `scissorTest` on, `clear()` now clips to its scissor, which
is the more defensible reading of what a scissor is for, but it is a change rather than a fix.

**The pixel case tests both halves, because one alone proves nothing.** `clear-selective` draws red,
then clears depth and stencil only, then clears colour too. If the flags were ignored and everything
cleared, the first read would be the clear colour rather than red; if the clear were skipped
altogether, the first read would be right and the second wrong. It reports "depth-only clear left
255,0,0, colour clear left 0,0,255", which is both.

Verified: tsc 0, 437 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on touched files.

---

## Layer 4.14 — renderer.compute() is a frame, and an earlier objection is answered

`webgpu/renderer.ts`, `webgpu/compute.ts`, `tst/compute-pass.test.ts`.

Layer 3.3 considered making `renderer.compute()` a wrapper over `frame()` and **rejected it**, for a
good reason at the time: `frame()` hands back the renderer's one reusable frame, so a `compute()` call
between a caller's `f.pass()` and `f.submit()` would silently abandon their in-flight encoder. That
objection was recorded in the plan as settled.

Layer 4.10 removed it without noticing. `compute()` now throws when `isFrameOpen`, so the case the
objection was about is a loud error rather than silent corruption. The wrapper is safe, and a decision
that was right when made is no longer right.

`compute()` is now `frame()`, one `frame.compute()`, a loop of `dispatch` / `dispatchIndirect`,
`end()`, `submit()`. That deleted `dispatchCompute` and with it the last out-of-band encoder except
mipmap generation, which defers to `submitFrame` by design. All the bookkeeping the old body did by
hand, frame id, `_beginInfoFrame`, `inspector.begin`/`finish`, the `info.compute` counters, the perf
marker, is what `beginFrame` / `encodeComputePass` / `submitFrame` already do, so it is gone rather
than duplicated.

**The test compares the two routes rather than asserting numbers.** Two renderers, the same node, the
same pair of dispatches, one through `frame.compute()` and one through `renderer.compute()`, then
assert the stub sees identical dispatch counts, compute-pass counts and submits. It is stronger than
pinning constants, because it stays true if the shared encoding changes.

One test was renamed: "renderer.compute stays on an encoder of its own" described the behaviour this
cycle replaced. It opens a frame of its own now, which is the same isolation by a different mechanism.

Verified: tsc 0, 438 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on the files this cycle wrote.

---

## Layer 4.15 — auditing the plan's settled decisions against the code

`core/render-list.ts`, `scene/draw-scene.ts`, `core/renderer-ops.ts`, both renderers, `index.ts`,
`tst/webgl-render/harness.ts`.

Last cycle reversed a decision the plan recorded as settled, and only caught it by chance. So this
cycle audited the whole "Resolved during design, recorded so it is not relitigated" section against
what the code actually does. Three of the four hold. One did not.

**"Override materials are not needed."** The plan argues it well: replacing a whole material replaces
the *vertex* stage too, so it breaks skinning, instancing, morph targets and vertex displacement;
three's own shadow map does not use `scene.overrideMaterial`; and gpucat expresses the real need
better as two `Material`s over one shared vertex node, which cannot drift because it is the same node
object.

Meanwhile the code carried `overrideMaterial` on both renderers, in `RendererState`, through
`collectRenderList` and `walkObject`, and in `DrawSceneOpts` — with **zero users** in src, examples or
tests. Worse, I extended it twice without noticing: layer 3.6 added `DrawSceneOpts.overrideMaterial`
and layer 4.3 added `DrawOpts.material` to carry its resolved result. A decision recorded as settled
was quietly contradicted by the implementation, in changes I wrote while reading that plan.

The ambient form is deleted: the renderers' field, the `RendererState` entry, the parameter threaded
through the render list walk, and `DrawSceneOpts` with it.

**`DrawOpts.material` stays, and it is the opposite thing.** Ambient and scene-wide is what the
argument is against; explicit and per-submission is what the argument's own alternative *needs* to be
drawable. Two materials over one shared vertex node is only useful if a submission can pick which one.
That had no test, so the `draw-material` pixel case now draws a mesh whose own material is red with a
green variant built on the same vertex node, and reads green.

Also checked and still true: no subpath entry points (there is no `exports` map at all), no
`surface(gpu, canvas)` or `target(gpu, opts)`, and a pass still names one target rather than
assembling attachments.

Verified: tsc 0, 438 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on touched files.

---

## Layer 4.16 — the stub became dimensionally honest, and two plan claims were stale

`tst/stub-gpu.ts`, `tst/frame-encoder.test.ts`, plan corrections.

Continuing the audit onto "Not taken" and "Risks". Two claims no longer match the code.

**Risk 1 said "Nothing here is validated. Every conclusion comes from reading source. Not one line has
been written against a real frame."** That was true when written and is now the most misleading
sentence in the document: 440 tests, twenty-odd new pixel cases, 48 GLSL links and 38 naga
validations. What remains true is narrower and worth stating precisely: **WebGPU has no pixel
harness**, so every WebGPU-only path is covered by a stub rather than by a device.

**"Multiple command buffers per frame. One canvas, one room rendering at a time."** The conclusion
still holds, one `queue.submit` per frame, but its reason stopped being true in layer 4.4, which made
attachments per `CanvasTarget` precisely so one frame can draw to several canvases.

So this cycle narrowed the WebGPU gap as far as it goes without a device. The stub returned a
1x1-for-everything texture, which makes every size mismatch invisible, and views that remembered
nothing. Now `createTexture` echoes its descriptor, each canvas reports its own size, a view knows its
texture, and `beginRenderPass` enforces the rule real WebGPU enforces: every attachment in a pass
agrees on size.

**It found nothing, and that is the honest result.** All 440 tests pass under the stricter stub, so
attachment resolution is correct today. It is insurance against a bug class, not a bug.

**A test I had to correct before claiming it.** I wrote "two canvas targets of different sizes in one
frame" as a regression test for the layer 4.4 bug and checked it by reverting to shared attachments.
It stayed green: the size reconcile recreates a shared depth texture per pass, so sharing shows up as
thrashing rather than as a mismatch, and a stub cannot see thrashing. The pre-existing test asserting
distinct depth textures is the real regression test, and it did go red. The new one is relabelled as
coverage.

Verified: tsc 0, 440 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on touched files.

---

## Layer 4.17 — a pass label is not an identity

`core/render-objects.ts`, `core/render-object.ts`, `core/pass-context.ts`, `core/pass-desc.ts`,
`core/renderer-ops.ts`, both `frame-backend.ts`, both renderers, `inspector/tabs/draw-calls.ts`,
`tst/frame-encoder.test.ts`.

Two items from the plan's "What goes away" list that are src-only: `passId` out of the RenderObject
cache key and `callDepth` out of the RenderContext key.

**`callDepth` was dead.** Every call site passed the literal `0`, so it contributed a constant to the
key. Deleted.

**`passId` was worse than dead, it was actively fragmenting.** `params.passId` is `desc.label ??
'render'`, and the RenderObject cache was a `Map<passId, WeakMap<Mesh, ...>>`. So labelling passes,
which the API actively encourages and which every inspector timing depends on, silently created a
**separate RenderObject universe per label**. Three passes drawing one mesh under three labels built
three RenderObjects, each with its own compiled state and bind groups.

It also explains the loose end from layer 4.9. Fixing `compile()`'s context made the pre-warm produce
the right *pipeline*, but its RenderObjects were filed under `'compile'` and the render path looked
under `'render'`, so every one of them was rebuilt. Now the cache is one
(mesh, material, renderContext) chain and the pre-warm's objects are the ones the pass uses.

Two tests measure exactly that: after `compile(scene, camera, target)`, drawing that scene to that
target under a *different* label adds **zero** render objects; and three frames with three labels
leave the count at one.

**`RenderObject.passId` survives as `lastPassLabel`, and the rename is the point.** The draw-calls tab
buckets by pass, which is a reasonable thing for a debug tab to want. It is now an annotation written
only when an inspector is attached, threaded as `inspectorLabel: string | null` so the signature says
what it is for and the hot path pays nothing. Identity and labelling were the same field; they are
not the same thing.

Verified: tsc 0, 442 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga. Three pre-existing biome findings in touched files are in code this cycle did not write.

---

## Layer 4.18 — a target carries no viewport or scissor

`core/render-target.ts`, `core/pass-desc.ts`, `tst/viewport-scissor.test.ts`,
`tst/webgl-render/harness.ts`.

Third contradiction found by auditing the plan against the code, and the second I introduced myself.

The plan lists `RenderTarget.viewport` / `scissor` / `scissorTest` as going away, because otherwise
viewport state lives in two places. In layer 3.8 I made `resolvePassContext` **fall back to them**
when the desc omitted them, and wrote a test asserting that fallback, without noticing the plan said
the opposite. `PassDesc.viewport` and `PassDesc.scissor` are the one place; a target holding a second
copy is exactly the duplication the plan warned about, and it is how `clearDepth` and the clear flags
went wrong twice already.

All three fields deleted, along with the fallback. gpucat itself used them in exactly one place, a
pixel case, and lib mutates them per tile in `render/webgl.ts` — which under this API is
`f.pass({ target, viewport: tile.rect, scissor: tile.rect })`, a per-submission fact rather than a
mutation of a shared object, which is the whole argument of the frame API.

**The capability is unchanged, only the route.** `viewport-cell-present` renders red into the top-half
cell of a blue render target and presents the whole thing, and it is the case that catches a regressed
viewport Y-flip. It now names the cell in the pass desc instead of mutating the target, and still
reads top RED, bottom BLUE.

The unit test that asserted "a render target uses its own viewport/scissor, not the swapchain state"
encoded the behaviour being removed. It is replaced by two: the swapchain pair still does not leak
into a render-target pass, and a render target is clipped by what its desc asks for.

Verified: tsc 0, 443 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on touched files.

---

## Layer 4.19 — MRT on a canvas target, and the name contract written down

`webgpu/frame-backend.ts`, `webgl/frame-backend.ts`, `tst/pass-desc.test.ts`,
`tst/frame-encoder.test.ts`.

Auditing the MRT section. It says output names resolve to `@location` indices by matching the render
target's texture names, that this is "a real contract between two objects", and that it "is currently
written down nowhere". Both halves turned out to be actionable.

**A regression of mine, from layer 3.7.** Wiring `resolveOutputs` into `encodePass` I wrote
`renderTargetOf(desc.target)?.getTextureIndex(name) ?? 0`. `getTextureIndex` returns `-1` for an
unknown name, which `resolveOutputs` already warns on and skips, so the `??` never fires for a render
target. It fires for a **canvas target**, where it maps every output to attachment 0. The old
`render()` guarded with `if (mrt && renderTarget)` and simply did not resolve without one, so I had
turned "ignored" into "all outputs collide on attachment 0".

A pass with `mrt` and a canvas target now throws. The swapchain has one attachment, so an MRT there is
a mistake worth hearing about rather than a configuration to silently flatten.

**Writing the contract down where it bites.** Three tests: the name lookup returns the right indices
and `-1` for an unknown name, which is the contract's failure mode; two targets with identical formats
but differently named textures do **not** share a render context, which is the latent bug this plan
section found and fixed earlier, now pinned from the `resolvePassContext` side; and the canvas-target
rejection above.

Left alone deliberately: `resolveOutputs` warns and skips an unmatched name rather than throwing. That
is shared node code on both paths, and turning a warning into a throw is a semantics change for
existing users rather than a fix to this work. Recorded as an open question instead.

Verified: tsc 0, 446 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on touched files.

---

## Layer 4.20 — autoResize, a plan feature that was never built

`core/canvas-target.ts`, both `frame-backend.ts`, `tst/stub-gpu.ts`, `tst/canvas-target.test.ts`,
`tst/frame-encoder.test.ts`.

Auditing "Targets, canvases and resize". Most of it is done: `Target` covers both kinds, a zero-extent
canvas skips its pass, and `CanvasTarget` gained `dpr` as `number | [min, max]`, an `onResize` that
fires on subscribe and returns an unsubscribe, plus `depthFormat`, `samples`, `alphaMode` and
`colorFormat`. One bullet was never implemented at all: **`autoResize`, reading the canvas's layout
size at the frame boundary, default on for layout-backed canvases.**

`CanvasTarget.autoResize` now defaults to `'clientWidth' in canvas`, which is true for a DOM canvas and
false for an `OffscreenCanvas` that has no layout to read. `syncToClientSize()` matches the backing
store to `clientWidth`/`clientHeight`, and both backends call it at the top of `encodePass` before the
context resolves its size.

**It calls `setSize(w, h, false)`, and the `false` is the point.** `setSize` normally writes
`style.width`/`style.height` too, which for an autoResizing canvas would mean writing back the very
CSS it just read and fighting the layout that produced it. A test asserts the style is untouched;
the first version of that test asserted it was `undefined` and failed, because `setPixelRatio` had
written it earlier. Asserting "unchanged by this call" is the claim that was meant.

**An existing test had to change, and the change is the feature.** "A pass to a hidden canvas encodes
nothing" set the backing store to 0 while leaving `clientWidth` at 800, and now the pass resizes it
back and draws. That is correct: with `autoResize` the layout is the source of truth, and a canvas
whose layout is 800x600 is not hidden. `display:none` reports zero layout, so the test builds a canvas
of zero client size instead.

Verified: tsc 0, 450 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on touched files.

---

## Layer 4.21 — the performance section contradicted itself

`core/pass-context.ts`, `tst/frame.test.ts`, plan corrections.

Auditing "Performance: this is an ownership change, not a speed change". Its three prescriptions
against per-frame allocation:

- **"Frame owns a pool of `Pass` objects and a pooled `DrawRecord` array."** True, and now tested from
  both sides: four frames of three draws reuse one pooled pass, one record array and the same record
  objects; and a frame recording fewer draws than the last leaves stale records in the array while
  `count` bounds what the backend reads, which is the invariant the `(records, count)` signature
  exists for.
- **"`PassDesc` is consumed at `f.pass()` and never retained."** False: the pooled pass holds the desc
  by reference until `end()`, which is what `encodePass(pass.desc, ...)` reads. Copying eleven fields
  into the pass to release a literal the caller allocated anyway would be more work, not less, so the
  claim is withdrawn rather than implemented.
- **"`RenderContext` is keyed by WeakMap rather than a per-frame string build."** False, and it
  **contradicts the plan's own "Pass identity comes first" section**, which settled that identity is
  the attachment *shape* and that `WeakMap<Target, RenderContext>` "was proposed and is wrong" because
  it splits pipelines and RenderObjects per target. Both cannot hold. Shape keying won and is built, so
  the WeakMap line is the one that goes.

That leaves the string build real: `buildAttachmentState` runs per pass per frame. The intermediate
array from `.map().join()` is gone, and the double `_depthAttachment` null check with it, but the
string itself remains. **Deliberately not memoized.** A cache on the target needs a shape version, and
nothing today invalidates one (the harness assigns `texture.name` directly), so a memo would trade a
measured-at-nothing allocation for a silent staleness bug. The plan's own framing, "moderate, not a
cliff", is the right answer until there is a measurement.

Verified: tsc 0, 452 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga.

---

## Layer 4.22 — the vertex layout key had no test

`tst/frame-encoder.test.ts`, plan corrections.

Auditing "Compilation stays lazy, with an optional pre-warm". It describes a latent bug found by
reading `buildVertexBufferLayouts`: `arrayStride` comes from `geometry.buffers.get(name)` for a named
attribute, but the pipeline key did not include it, so two geometries supplying different buffer
formats for one attribute name under one material shared a pipeline, and the second drew with the
first's stride.

Layer 1 put `vertexLayoutKey` into `makeRenderPipelineKey` and the plan records it as resolved. Eleven
layers later **nothing tested it**. A fix recorded in a document and held up by one line in a key
expression is one refactor away from silently reverting, which is the same failure mode as the dead
fields this audit keeps finding, only with the evidence living in prose instead of in the type.

The test draws one material over two geometries whose `position` buffers are `vec3f` and `vec4f`, so
12 and 16 byte strides, and asserts two pipelines. Checked both ways: blanking the layout component of
the key reads `expected 1 to be 2`.

Also confirmed while reading: `compile(scene, camera, target?)` still takes a scene rather than the
plan's `compile(gpu, drawables, target)`. That shape change is layer 4's context reshape and touches
four example call sites, so it stays deferred; the context question it depended on was settled in
layer 4.9.

Noted, not acted on: `setViewport` and `setScissor` still take `x: number | Vec4`, the
rect-or-components polymorphism that "The rule" lists as a casualty. They are also on the deletion
list entirely, since a pass desc carries viewport and scissor now, so collapsing the signature first
would be churn in code that is going away.

Verified: tsc 0, 453 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on touched files.

---

## Layer 4.23 — a RenderObject resolved its pipeline once, ever

`webgpu/render-objects.ts`, `webgpu/pipelines.ts`, `core/render-object.ts`, `geometry/geometry.ts`,
`tst/frame-encoder.test.ts`.

Chasing the two latent bugs an early cycle found and deliberately left: `initialCacheKey` computed and
never compared, and `Geometry.setBuffer` bumping `version` only for a new name. I wrote a test to
decide whether the second was benign, expecting the pipeline key to cover it.

**It was not benign, and the cause was a third thing neither note mentioned.** Three layers of cache
each invalidated on less than they depended on:

1. `setBuffer` replacing a buffer never bumped `geometry.version`, though a different format means a
   different `arrayStride`.
2. `getCachedPipelineKey` memoizes the key on the RenderObject and invalidated only on
   `material.version`, while the key it caches **includes the geometry's vertex layout**.
3. `initRenderObject` guards pipeline resolution with `if (!gpu.pipeline)`, so a RenderObject resolved
   its pipeline exactly once and never again.

Layer 3 is the one that matters, and it is not limited to geometry: **a material change after the
first draw kept the old pipeline too.** `needsNodeUpdate` already recompiled the node graph, so the
shader updated while the pipeline state it was baked into did not. Toggling `depthWrite` and bumping
`material.version` mid-session silently kept the old depth state.

All three fixed. `setBuffer` bumps on a format change (not on a same-format swap, which is the
streaming case and costs a recompile for nothing); the key memo watches `geometry.version` as well;
and pipeline resolution reuses the `needsNodeUpdate` result it already computed, so the guard is
`!gpu.pipeline || stale` at no extra cost.

Two tests, both checked against the unfixed code, both reading `expected 1 to be 2`: replacing a
`vec3f` position buffer with a `vec4f` one builds a second pipeline, and so does flipping `depthWrite`
with a version bump.

`initialCacheKey` is still computed and never compared. It is genuinely inert now that the three real
invalidation paths are correct, so it is dead weight rather than a bug; left for the layer 4 reshape.

Verified: tsc 0, 455 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on touched files.

---

## Layer 4.24 — a VAO outlived the buffers it was built from

`geometry/geometry.ts`, `webgl/geometries.ts`, `webgpu/render-object-gpu.ts`,
`tst/webgl-render/harness.ts`.

Carrying last cycle's bug class to the other backend. WebGL gets the *program* right: a recompile
explicitly nulls `payload.program`, which is the invalidation WebGPU was missing. Its **VAO** does
not.

A VAO records the `vertexAttribPointer` calls made when it was built, including which GL buffer was
bound. It is cached per (geometry, program) with no version check at all, so replacing a geometry's
named buffer leaves the VAO pointing at the old GL buffer. On WebGPU a swap works, because vertex
buffers are bound per draw.

The `buffer-swap` pixel case draws a triangle covering the left half, swaps `position` for one
covering the right half, and reads the right half. It returned **black**: the second draw rendered the
first buffer's geometry.

**Fixing it needed a second counter, and that distinction is the useful part.** Last cycle I made
`setBuffer` bump `geometry.version` only on a *format* change, because `version` drives node-graph
recompilation and a same-format swap is the streaming case where a recompile costs for nothing. But a
same-format swap still has to rebind. Those are two different questions and one counter cannot answer
both:

- `version` is the **shape**: a new or removed name, or a changed format. Forces a recompile.
- `bindingsVersion` is the **bindings**: any set or remove. Forces a rebind, and drops every VAO built
  against the old ones.

Also deleted: `RenderObjectGpu.vertexBuffers`, declared and nulled and **never once assigned**. The
WebGPU draw loop reads `geometry.buffers.get(group.name)` per draw, which is why that backend was
never affected and why the field had no reason to exist.

Verified: tsc 0, 455 tests across 49 files, `webgl-render` all cases pass including the new one,
48/48 GLSL, 38 shaders under naga, biome clean on touched files.

---

## Layer 4.25 — the net, measured

`tst/render-encoder.test.ts`, plan corrections.

Two caches checked first, both clean. WebGL's FBO cache tracks size, depth mode **and a generation per
attached texture**, so a reallocation invalidates it; that is the pattern the pipeline and VAO caches
were missing in the last two cycles, done right. Worth naming as the model rather than only recording
the failures.

Then the regression-net section, which was written before any of this existed and estimated
everything. Measured: 42 vitest files is now **49, and 455 tests**; four renderer-constructing tests
are now six, the two new ones being where the frame API's invariants live; `webgl-render` is at **83
pixel cases**; the golden snapshots are still 1051 lines and still byte identical.

**The prediction that was wrong is the interesting one.** The plan said `render-encoder.test.ts` "has
to be rewritten, and it is the most valuable one". It never needed rewriting. Every layer beneath it
was replaced, `render()` moved onto the frame API, `PassNode` stopped calling `render()` entirely, and
its assertion of one encoder and one submit per frame kept passing throughout. A test written as a net
for a *previous* refactor of this code turned out to be the net for this one too, which is the
argument for writing invariants rather than mechanisms.

Its wording did need fixing: "a nested PassNode render reuses the parent encoder" names a mechanism
that no longer exists, and its header still described locking behaviour for "the Phase-2 encoder
internalization". Renamed to what it asserts, and the header cut to one line.

Verified: tsc 0, 455 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on touched files.

---

## Layer 4.26 — the last cache is sound; nineteen dead exports are not

`core/render-list.ts`, `core/renderer-ops.ts`, `core/node-manager.ts`, `core/render-object.ts`,
five `webgpu/*` files, `webgl/textures.ts`.

Finishing the invalidation audit on the last big cache. **Bind groups are correct.** Textures compare
a per-texture `generation`, uniform blocks rebuild when the buffer is created or resized rather than
merely written, and storage bindings compare buffer identity directly
(`buffer !== binding.lastBuffer`). So a swapped storage buffer is caught on WebGPU, which is the same
swap that left a stale VAO on WebGL last cycle.

Final tally for the five caches audited: the **FBO** and **bind group** caches track a generation or
identity per input and are the model; **programs** key on source, which is the input itself; the
**pipeline** cache and the **VAO** cache each watched less than they depended on, and both were
broken.

What the audit turned up instead was `invalidateRenderBindings`, exported and never called, which is
exactly the hook a swap would need if the bind group had not already handled it. A sweep for exported
functions with no reference anywhere in `src`, `tst` or `examples` found **nineteen**, none of them on
the public surface:

`collectRenderListWithSort`, `deleteRenderBindings`, `deleteRenderObjectGpu`, `frameWidth`,
`frameHeight`, `getComputeBindGroupLayouts`, `getIndex`, `getIndirectBuffer`, `getNodeBuilderState`,
`getNodeFrame`, `getRenderBindGroups`, `getRenderListStats`, `getRenderListsStats`,
`getTextureCacheStats` (both backends), `invalidateRenderBindings`, `isComputeReady`, `isInitialized`,
`isReady`, `removeRenderTargetTexture`.

Some died in this work: `frameWidth` and `frameHeight` lost their last caller when `compute()` became
a frame. Others predate it. Deleting them cascaded into a private `generateWireframeIndices` and three
imports, which is the usual shape of dead code holding more dead code alive.

The scripted deletion mangled three files where a function's parameter list confused the brace matcher,
leaving bare `{ return ... }` blocks. Caught by `tsc` immediately and repaired by hand. Same failure as
the `saveRendererState` deletion in layer 4.2, and the same lesson: the typechecker is the net, so
delete and compile rather than delete and assume.

Verified: tsc 0, 455 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga. The working tree is now 980 insertions against 1680 deletions across 37 source files.

---

## Layer 4.27 — dead types and write-only fields

`core/render-object.ts`, `core/render-objects.ts`, `core/pass-context.ts`, `core/render-list.ts`,
`webgpu/render-object-gpu.ts`, `webgpu/textures.ts`.

Extending last cycle's sweep from exported functions to exported types, and then to the harder case:
fields that are **written and never read**, which is the same defect one level down and is what
`passId`, `vertexBuffers` and the dead `PassDesc` fields all were.

Two dead types, both cascade-dead from my own earlier deletions: `ClearColorValue` lost its users when
the duplicated `RenderContext` clear fields went in layer 4.5, and `TextureCacheStats` when
`getTextureCacheStats` went last cycle. Removing a function and leaving its result type behind is a
small, tidy-looking way to keep dead code alive.

Then a sweep comparing reads against writes per field across the main state types. Three survivors:

- **`RenderObject.initialCacheKey`**, the latent bug an early cycle found, recorded and deliberately
  left. Written on every RenderObject creation by a full `computeRenderObjectCacheKey` walk over the
  geometry's buffers, and read by nothing. Not merely inert: it built a string per object for nobody.
- **`RenderObjectGpu.indexBuffer`**, sibling of the `vertexBuffers` deleted last cycle, declared and
  never assigned.
- **`RenderList.occlusionQueryCount`**, initialised to 0 and reset to 0 and never incremented or read.
  A placeholder for a feature gpucat does not have, which is the same "declared but unread" shape as
  `PassDesc.layer` and `clearDepth`, except those were reachable from the public API and this one is
  not.

The read-versus-write sweep is worth keeping as a habit. It finds what a type-checker cannot: a field
that compiles, is assigned on a hot path, and means nothing.

Verified: tsc 0, 455 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on touched files.

---

## Layer 4.28 — the sweep's blind spot, found before it deleted anything

`core/canvas-target.ts`, both renderers.

Ran the read-versus-write sweep across every state type in `renderer/core`, `renderer/webgpu` and
`renderer/webgl` rather than the four sampled last cycle. Five hits, and **four of them were wrong**.

`info.memory.texturesSize`, `info.memory.texturesByFormat` and `BufferWrite.full` have no reader in
`src` because their readers are **outside it**: `lib/src/render/gpu-stats.ts` records both memory
fields into its profiler, and `full` is a field of the detailed write log a debug panel consumes. The
plan says `info` is on the renderer contract on purpose, so that any number of readers can share it;
a sweep scoped to `src` is structurally unable to see them. `pipelines.ts :: bindGroupLayouts` was a
local variable the pattern matched, not a field at all.

So the technique has a blind spot exactly where the library is most public, and the guard is to check
the consumer repo before deleting. Doing that turned four confident deletions into zero.

One real hit survived. `CanvasTarget.isDefaultCanvasTarget` is written by both renderers on the
initial target and read by **nothing**, in gpucat or in lib. Its comment explains what it is for
("the inspector preview targets are not default"), which is a use that no longer exists: the viewer
now draws each preview to its own target through the frame API and never asks which one is the main
canvas. Deleted, along with both writes.

Worth recording as the limit of the last three cycles of sweeping: dead exports and write-only fields
are findable mechanically inside a package, and everything on the public surface needs a human
checking the other side of it.

Verified: tsc 0, 455 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on touched files.

---

## Layer 4.29 — comments describing a renderer that no longer exists

`core/node-frame.ts`, `webgpu/renderer.ts`, `core/cube-render-target.ts`,
`nodes/lib/display/render-output.ts`.

The loop asks for a comment goblin pass each cycle and I have been applying it to code written that
cycle. This one applied it to the work's whole blast radius: a grep for comments naming concepts this
refactor deleted, across all of `src`.

`NodeFrame` was the worst, and it matters because it is the type nodes read. Its `frameId` claimed to
increment "once per top-level render()/compute() call", `renderId` was "a globally-unique id for the
current render() call", and `beginRender` / `endRender` were documented entirely in terms of nested
renders restoring a parent's scope. There are no nested renders. `beginFrame` bumps `frameId`, and a
`renderId` is minted per **pass** by `encodePass`. The monotonic-counter rationale was worth keeping
and is kept, reworded around passes, since the collision it prevents is still real.

`_currentEncoder` said `render()` "creates it at depth 1 and nested renders reuse it", a sentence with
two deleted concepts in it. An orphaned doc comment for `_renderCallDepth` was still sitting in the
field list with nothing under it, left when the field went in layer 4.1.

Two docs pointed users at APIs that no longer do what they say: `CubeRenderTarget` told you to "set
`activeFace` and call `renderer.render(scene, faceCamera)`", which is the pattern `CubeCamera` stopped
using when `PassDesc.layer` started working; and `renderOutput`'s example called
`renderer.render(renderOutput(...))`, a signature that never existed at all.

A second grep for the other direction, comments describing the *new* mechanism inaccurately, came back
empty, which is what the per-cycle goblin pass is for.

Verified: tsc 0, 455 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on touched files.

---

## Layer 4.30 — sideEffects: false, and the src-only work is out

`package.json`.

The last item on the plan that touches nothing outside the package. Checked before claiming it: no
module in `src` mutates anything outside itself. Everything at module scope is either a scratch buffer
(`_frustum`, `_lookAt_tmp`, `_ndc`), a constant, or a pure factory result (`vec3 = makeVec3(d.vec3f)`).
No global registration, no prototype patching, no `globalThis`.

One caveat worth writing down rather than discovering later. Module-scope DSL constants like
`modelWorldMatrix` take ids from a **global counter**, which is what broke five golden snapshots in
layer 3.1. With `sideEffects: false` a bundler may now drop an unused module, so the set of modules a
consumer imports decides the id sequence, and two applications can emit different shader identifiers
for the same graph. That is a difference in text, not in behaviour: ids are internally consistent
within a bundle. It only bites the golden snapshots, which run against `src` and are unaffected.

Rollup still builds: 674.79 KB minified, 168.07 KB gzipped.

**Where the work stands.** Everything in the plan that can be done without touching the 46 examples is
now done. What remains is one coherent block, all of it example-facing:

- delete `RenderPipeline`, `renderer.render`, and the ambient `renderTarget` / `mrt` / `clearColor` /
  `autoClear` / `setViewport` / `setScissor` surface they read
- `init({ backend })` returning a `Gpu`, and `read(gpu, target)` replacing `readPixels`
- `compile(gpu, drawables, target)` taking drawables
- the lib port, then the examples

Plus two open questions that are decisions rather than work: the `pass` naming collision between
`f.pass(desc)` and the node `pass(contents, camera)`, and whether an unmatched MRT output name should
throw instead of warning.

Verified: tsc 0, 455 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, rollup build clean. Working tree: 1014 insertions, 1760 deletions across 40 source files.

---

## Layer 4.31 — read(gpu, target), and a backend leak on the neutral surface

`core/read.ts` (new), `index.ts`, `tst/frame-encoder.test.ts`, `tst/webgl-render/harness.ts`.

Starting the remaining example-facing block with its smallest piece. The plan wants
`readPixels(renderTarget, attachmentIndex, layer)` to become `read(gpu, target, opts)`, and is
explicit about why it is **not** `target.read(opts)`: vgpu puts it on the target, but vgpu's targets
are built with a gpu and hold a device back-pointer, and ours are device-free by design.

Checking what exists first turned up something worse than a naming gap. `index.ts` exported
`readPixels` from **`renderer/webgpu/read-pixels.ts`**, whose first parameter is a `WebGPURenderer`.
So `import { readPixels } from 'gpucat'` is unusable with a `WebGLRenderer`, on a package whose whole
claim is that it is backend-neutral. It also duplicated `renderer.readPixels(...)`, which both
backends implement with the same signature precisely "so a host reads pixels without knowing which
renderer it holds".

`read(gpu, target, opts?)` replaces it: neutral by construction, since `ReadableGpu` is structural and
both renderers satisfy it. `attachment` and `layer` are named rather than the third and fourth
positional arguments, which is what an options object is for when the values are genuinely optional
configuration.

Two tests. One is behavioural: `read` inherits the open-frame guard, so reading across an unsubmitted
frame rejects rather than returning the previous frame's pixels. The other passes a hand-written
`ReadableGpu` and asserts the option mapping, which is the point of the structural type: it works
against anything that can read, not against a specific renderer class.

Verified: tsc 0, 457 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on touched files.

---

## Layer 4.32 — compile takes drawables, and `compile` was already taken

`core/compile.ts` (new), both renderers, `nodes/builder.ts`, `webgpu/prepare.ts`, `index.ts`,
four examples, fifteen test files.

The plan's `compile( gpu, drawables, target )`, built. Two things it did not anticipate.

**It needs a camera.** `getRenderObject` keys on (mesh, material, renderContext) and takes a `View` to
construct with, so a pre-warm cannot build the RenderObject a pass will reuse without one. The
signature is `compile( gpu, drawables, target, camera )`. Camera is not part of the identity and is
refreshed on a cache hit, so this is about construction, not keying, but it is required either way.

**The name was already exported.** `index.ts` exports `compile` from `nodes/builder`, the WGSL
compiler, alongside `compileGlsl`, `compileCompute` and `compileTransformFeedback`. So `compile` was
the one member of that family not saying which language it emits, and it was occupying the name the
plan wanted. Renamed to **`compileWgsl`**, which makes the family consistent and frees the name. That
is a public rename, and the right time for it is while nothing depends on this package.

`compile` is neutral like `read`: a structural `CompilableGpu`, with `WebGLRenderer.compile` as an
honest no-op, since GL programs are cached by source and there is nothing to warm ahead of a draw.

The WebGPU body no longer walks a render list. It maps drawables to render objects once and reuses
that array across both phases, where before it called `getRenderObject` a second time per item in
phase two. Phase one still collects every pipeline promise and awaits them together; the plan is right
that a per-drawable `await` would serialize what is parallel.

Two mistakes worth recording. A blanket rename hit `compileNodeState`'s **injected emitter callback**,
also named `compile`, which tsc caught immediately. And renaming the export broke 26 tests across
fifteen files in two import shapes, single-line and multi-line, so the first scripted pass fixed only
half of them.

Verified: tsc 0, 457 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on touched files.

---

## Layer 4.33 — compileCompute, and the array form earning its keep

`core/compile.ts`, both renderers, `nodes/builder.ts`, `core/node-manager.ts`, `index.ts`,
seven examples, two test files.

`compileCompute( gpu, nodes )` completes the operations trio with `compile` and `read`: gpu first,
neutral by a structural type, array form collecting every promise and awaiting them together.

**The array form is not sugar here, and two examples prove it.** `compute-birds` and `ball-cluster`
both did:

```ts
await renderer.compileCompute(clearGrid);
await renderer.compileCompute(bin);
await renderer.compileCompute(simulate);
```

Three sequential awaits, each blocking on a pipeline that could have compiled alongside the others.
They are now one call. That is exactly the argument the plan makes for `compile` taking drawables,
and it turned out to be load-bearing for the compute side, where the old API had no array form at all.

**The same name collision as last cycle, resolved the same way.** `compileCompute` was already
exported from `nodes/builder` as the compute-shader **emitter**. Renamed `compileComputeWgsl`, which
finishes what `compile` → `compileWgsl` started: the emitter family is now `compileWgsl`,
`compileComputeWgsl`, `compileGlsl`, `compileTransformFeedback`, each saying what it emits, and the
operation names are free. My first attempt aliased the export to `compileComputePipelines` to dodge
the clash, which is the lazy version and would have left the emitter family inconsistent.

**WebGL throws rather than no-ops.** `compile` is a no-op there because GL programs are cached by
source and there is genuinely nothing to warm. A compute pre-warm is different: WebGL2 cannot run
compute at all, so warming one is a mistake worth hearing about, and it matches `f.compute()`
throwing on the same backend.

Verified: tsc 0, 457 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on touched files.

---

## Layer 4.34 — piloting the RenderPipeline deletion before doing it 39 times

`examples/src/example-webgl-hello.ts`, `tst/webgl-render/harness.ts`, plan correction.

The last big piece is deleting `RenderPipeline`, which touches 39 of the 46 examples. Converting all
of them from a shape I had not rendered once would be the wrong order, so this cycle converted one
example and one pixel case.

**The pixel case is the part that proves anything.** Examples are typechecked and never rendered, so
converting them tells you only that it compiles. `pass-occlude` is the hardest shape in the harness —
two chained `PassNode`s, a depth texture sampled across them, and a composite that must not prune the
beauty pass — and it drove that composite through `RenderPipeline`. It now does it explicitly:

```ts
const composite = fullscreen(renderOutput(vec4(compRgb, f32(1))));
const frame = renderer.frame();
const compositePass = frame.pass({ target: renderer.getCanvasTarget()!, clear: [1, 0, 1, 1] });
compositePass.draw(composite);
compositePass.end();
frame.submit();
```

Same pixels: top `[232, 0]`, bottom `[0, 232]`. So the replacement is faithful through a two-pass
graph, not just for a trivial fragment.

**The ergonomic cost is real and worth naming before repeating it 38 more times.** A render loop goes
from `renderPipeline.render()` to five calls. That is the trade this design is for, control over
convenience, and it is what lib wants; it is also strictly more to read in an example whose subject is
something else entirely. The `fullscreen` mesh and the target hoist out of the loop, so the per-frame
part is four lines.

Also corrected in the plan: this section still described `fullscreen()` as "no vertex buffers, no VAO
attributes, no shared module geometry", which layer 4.2 disproved when a bufferless composite broke
every `TextureNode` sampling by `varying(uv())`. The subsection recording that fix was added; the
paragraph asserting the opposite was not.

Verified: tsc 0, 457 tests across 49 files, `webgl-render` all cases pass, 48/48 GLSL, 38 shaders
under naga, biome clean on touched files.

---

## Layer 4.35 — RenderPipeline deleted, and the examples were never typechecked

`renderer/core/render-pipeline.ts` (deleted), `index.ts`, 39 examples, `package.json`,
`tst/render-encoder.test.ts`, `tst/webgl-render/harness.ts`.

`RenderPipeline` is gone. Every example composites explicitly now: `fullscreen(outputNode)` drawn in
one pass on one frame. `renderer.render()` survives in four examples that needed real conversion
rather than a mechanical one, and they are converted too.

**The finding that matters is not the deletion.** After converting 33 examples by script and
reporting "tsc 0" each time, I checked what `npx tsc --noEmit` actually covers: `tsconfig.json` has
`"include": ["./src"]`. **The examples are not in it.** Every green typecheck I reported after an
example edit, across several cycles, was true and irrelevant.

Examples have their own `examples/tsconfig.json` and import `gpucat` by package name, which resolves
through `dist`. So checking them needs a build first, and a stale `dist` reports errors that are not
real while hiding ones that are. Running it properly surfaced, in the work I had called done:

- **`compile` and `compileCompute` were not exported from `index.ts` at all.** The export line was
  lost when I removed the neighbouring `RenderPipeline` export. The src tests never noticed because
  they import deep paths. This is layer 3.2 repeating exactly: a new public API that is not public.
- 12 `view` used-before-declaration errors, from a script that inserted the declaration at the
  `RenderPipeline` site but rewrote `renderer.clearColor` to `view.clearColor` higher up the file.
- Two examples still referencing `renderer.overrideMaterial`, deleted in layer 4.15.
- An example importing `readPixels`, replaced by `read` in layer 4.31.
- A missing `fullscreen` import where the old one sat on a multi-name line.

So `pnpm run typecheck:examples` now exists: build, then typecheck examples against what was built.
It is the only command that can see this class of breakage, and it passes.

**The shadow-map conversion is the interesting one.** It used `renderer.overrideMaterial`, deleted on
the argument that per-submission material belongs on the submission. The shadow pass now draws each
caster with `{ material: shadowMaterial }`, which is that argument in practice: one traversal, one
explicit override per draw, no ambient field.

Verified: src tsc 0, **examples tsc 0**, 457 tests across 49 files, `webgl-render` all cases pass,
48/48 GLSL, 38 shaders under naga.

---

## Layer 4.36 — the pixel harness carries the ambient state now

`tst/webgl-render/harness.ts`.

83 pixel cases were written against `renderer.setRenderTarget()` / `renderer.clearColor` /
`renderer.mrt` and then `renderer.render(scene, camera)`. Converting each case to open its own frame
would have rewritten every one of them and buried the thing each case is actually testing.

So the ambient state moved into the harness: three module-level `activeTarget` / `activeClear` /
`activeMrt` variables and one `renderScene(renderer, scene, camera)` that names them in a `PassDesc`.
Cases keep assigning them; the renderer carries none of it.

**This is worth being honest about: the harness is now the last implementation of the ambient model,
and that is the point.** The five save-and-restore sites (`savedTarget` / `savedClear` around a
render-to-texture block) are exactly the `saveRendererState` / `restoreRendererState` pair deleted in
layer 4.19, rebuilt by hand in the one place that still wants it. A test harness is where that
belongs: a case that renders to a target, samples it, and renders again is describing a sequence, and
the sequence is clearer as assignment than as two nested frames. The renderer no longer has to serve
it.

`newRenderer()` resets all three, so a case that forgets to restore cannot leak into the next one.

Verified: 83/83 pixel cases pass.

---

## Layer 4.37 — `canvasTarget()`, `renderTarget()`, `cubeRenderTarget()`

`src/core/render-target.ts`, `src/core/cube-render-target.ts`, `src/renderer/core/canvas-target.ts`,
`src/index.ts`, plus every construction site: 26 `new CanvasTarget`, 82 `new RenderTarget`, 7
`new CubeRenderTarget` across `src/**`, `tst/**` and `examples/src/**`.

Three one-line factories, exported beside their classes. `new` is gone from the call sites. The
classes stay exported and stay the type; the factory is how you make one. This is the same shape the
node DSL already has everywhere (`texture()`, `storage()`, `pass()`), so a target now reads like the
rest of the API instead of like the one place you still reach for a constructor.

The rename question behind this (`CanvasTarget` to `Surface`, `RenderTarget` to `Target`, vgpu's
naming) is deliberately deferred. The factories are useful either way, and they are what a rename
would have to preserve.

**Two things the conversion surfaced.** First, three local variables were named after the thing they
held: `const canvasTarget = new CanvasTarget(canvas)` in two inspector sites and
`const renderTarget = new RenderTarget(...)` in `PassNode`. Each became a self-referential
initializer the moment the factory shared its name. tsc caught all three as TS7022/TS2448; they are
now `probeTarget`, `previewTarget` and `target`. A factory named after its type collides with the
convention of naming a variable after its type, and the collision is silent until the import lands.

Second, a scripted import fix pointed `renderTarget` at `src/renderer/webgpu/render-target` in
`tst/render-target-msaa.test.ts`, because that path also ends in `render-target`. It typechecked (the
module has no such export, but the test's other import did) and failed at run time with
`renderTarget is not a function`. **Only the vitest layer saw it** - the backend module and the core
module share a basename, and a specifier-suffix match cannot tell them apart.

Verified: src tsc 0, examples tsc 0, 457 tests across 49 files, 83/83 pixel cases, 48/48 GLSL, 38
shaders under naga, biome clean on touched files.

---

## Layer 4.38 — `renderer.render()` and the ambient state are deleted

`src/renderer/webgpu/renderer.ts`, `src/renderer/webgl/renderer.ts`,
`src/renderer/core/renderer-ops.ts`, `src/renderer/core/renderer-interface.ts`,
`tst/viewport-scissor.test.ts` (rewritten), `tst/frame-encoder.test.ts`,
`tst/webgl-render/harness.ts`, `examples/src/example-webgpu-viewports.ts`.

Gone from both renderers: `render()`, `clear()`, `renderTarget`, `mrt`, `clearColor`, `autoClear`,
`autoClearStencil`, `clearStencilValue`, `setViewport` / `getViewport` / `setScissor` / `getScissor`
/ `setScissorTest` / `getScissorTest`, and the `_viewport` / `_scissor` / `_scissorTest` /
`_viewportMinDepth` / `_viewportMaxDepth` state behind them. Gone from `renderer-ops`: the five
setters and the two `viewportRect` / `scissorRect` converters that existed only to feed `render()`.
The `Renderer` contract lost `renderTarget`, `clearColor` and `autoClear`, so it is now the frame,
the node state, the render lists, the inspector and `info`.

`renderer.clear()` went too, which the plan had kept. Its three inputs were the ambient fields, and
without them it is `f.pass({ target, clear }).end()` with a submit: an alias, not a capability. The
plan's own line, "a pass with no draws is a clear", is the argument for deleting it rather than for
keeping a wrapper.

**The ambient model had one honest use and it survives, in the harness.** `caseClearSelective` needs
to draw, then clear one attachment and not another, then observe. That is now a `clearPass` local in
`tst/webgl-render/harness.ts` that opens an empty pass with the load ops it wants. The pixels are
unchanged, which is the point: the selective load ops were always the mechanism, and `clear(color,
depth, stencil)` was only a way to name them.

**`tst/viewport-scissor.test.ts` is now a test of the thing it was always testing.** Every case set a
rect on the renderer and asserted on what `resolvePassContext` produced, so the setters were
scaffolding between the input and the subject. The rects go straight into the pass desc now, and the
clamp rules (negative origin pulled to zero, extent shrunk to the framebuffer, a full-framebuffer
rect skipped) are asserted the same way. Two cases were about the swapchain pair not leaking into a
render-target pass; there is no ambient pair to leak, so they became one case that resolves the same
target twice and asserts the second pass, which names no rects, gets none.

`example-webgpu-viewports.ts` was the last consumer: its per-cell passes had already been converted,
but `renderer.autoClear = false` and `renderer.setScissorTest(true)` were still at the top doing
nothing, because a pass's `clear: false` and its `scissor` rect had taken over. A header comment
still described the old mechanism too.

Verified: src tsc 0, examples tsc 0, 455 tests across 49 files, 83/83 pixel cases, 48/48 GLSL, 38
shaders under naga, biome clean on touched files.

---

## Layer 4.39 — every canvas target answers for its own attachments

`src/renderer/core/pass-context.ts`, `src/renderer/core/pass-desc.ts`,
`src/renderer/core/target.ts`, `src/renderer/webgpu/pipelines.ts`,
`src/renderer/webgpu/render-pass.ts`, `src/renderer/webgpu/renderer.ts`,
`src/scene/draw-scene.ts`, `tst/pass-context.test.ts`.

This had to land before `init({ backend })`, and the reason is the whole entry: while the renderer's
own canvas is privileged, `init` cannot stop creating one, because the swapchain's configuration has
nowhere else to live.

**Three places privileged it, and one of them was a live bug.**

`buildAttachmentState(null)` returned the literal string `'default'`. **Every canvas target shared one
RenderContext**, whatever its samples, depth format or size. `resolvePassContext` then overwrote that
shared context's `sampleCount` and `stencil` from whichever target was drawing. Since the RenderObject
cache key includes the context id, two canvases with different sample counts shared render objects,
and `pipelines.canvasDepthFormat` was a single renderer-global that every canvas pass built its
depth-stencil state from. A 4x-MSAA canvas and a single-sampled one in the same frame would draw with
each other's pipelines. The existing "two canvas targets of different sizes" test passed because size
is not in the key and does not need to be.

The key now carries `canvas:${samples}:${depthFormat}`, `getRenderContext` takes the `Target` rather
than `RenderTarget | null` and sets `canvasTarget` alongside `renderTarget`, and
`getRenderContextDepthFormat` reads the context's own target. `pipelines.canvasDepthFormat` is
deleted; `canvasFormat` stays, because the colour format is a device fact
(`getPreferredCanvasFormat`) rather than a per-target one.

`SwapchainState` lost `samples` and `depthFormat`, so `samplesFor(target)` and
`depthFormatFor(target)` no longer branch on `target === sc.canvasTarget`. `sc.canvasTarget` survives
as "the canvas this renderer created and resizes" and nothing more.

`isRenderTarget` and `renderTargetOf` moved from `pass-desc.ts` to `target.ts`, next to the type they
discriminate, because `pass-context.ts` now needs them and importing `pass-desc` from it would close a
cycle.

Four new tests in `tst/pass-context.test.ts` carry what the deleted comments said: two canvases of one
shape share, a canvas and a render target never share, differing sample counts split with the right
`sampleCount` on each, differing depth formats split with `stencil` following the target.

## Layer 4.40 — `tst/` was never typechecked either

`tst/tsconfig.json` (new), `package.json`, plus 16 test files and four `src` fixes.

Layer 4.35 found that `tsconfig.json` has `"include": ["./src"]` and therefore never saw the examples.
It did not occur to me to ask the same question about `tst/`. It never saw those either. **69 errors
were sitting in a green suite**, because vitest transpiles without typechecking.

`pnpm run typecheck:tst` now exists and passes. What it caught:

- **`MRTNode` is not exported from `index.ts`.** `nodes.ts` re-exports it with `export *`, but
  `index.ts` re-exports `./nodes/nodes` through an explicit name list that omits it. The pixel harness
  had been importing it from `../../src/index` and getting nothing. Third instance of this exact
  defect, after `compile`/`compileCompute` in layer 4.35 and `readPixels` in 4.31.
- **`Infer<D>` had no branch for packed formats, so `Infer<unorm8x4>` was `never`.** Every packed
  field's CPU value was untypeable: `tex.packAtIndex(Rec, 0, { col: [...] })` was assigning to `never`.
  The four pixel cases covering the packed round trip had been writing values the type system said
  could not exist. Added: `unorm8x4`/`snorm8x4` take a 4-tuple, the 2x16 formats a 2-tuple.
- **The struct overload of `uniform()` was unreachable.** `uniform<D extends Any>(name, schema: D)`
  was declared before `uniform<S>(name, def: StructDef<S>)`, and a `StructDef` satisfies `Any`, so the
  first always won and `uniform('env', EnvConfig).tint` was a type error on working code. Reordered.
- **`StorageValue` was `Node<vec4f> | Node<vec4i> | Node<vec4u>`** while `textureLoad` answers
  `Node<vec4f | vec4i | vec4u>`, so `textureStore(st, coord, textureLoad(st, coord))` did not
  typecheck. The union belongs inside the `Node`.
- **`LoopVars` was `Record<string, Node<Any>>`.** The loop variable is always a scalar, `i32` unless a
  `LoopParam` names otherwise, and `Any` is a union, so `NumericDescOf<Any, f32>` distributed and
  `i.toF32()` came out as `Node<f32 | vec2f | vec3f | vec4f>`. Every `sum.assign(sum.add(i.toF32()))`
  in the suite was an error. Now `Record<string, Node<d.i32>>`.
- `NodeFrame` was being imported from `nodes/lib/uniform`, which imports it rather than exporting it.
- `Material` requires a `vertex` graph; four blend tests constructed `new Material({})`.

**One found and not fixed.** `atomicAdd`/`atomicLoad` answer `Node<i32 | u32>` rather than the
pointer's own scalar type. The obvious fix, `Node<AtomicScalarOf<D>>`, does nothing: inferring `D`
from `Node<D>` against a `Node` *subclass* falls back to the constraint, so `D` widens to the whole
`AtomicPtrDesc` union at the call site. Reduced to a two-line repro; `probe(plain: Node<atomicU32>)`
infers correctly and `probe(wgn: WorkgroupVarNode<atomicU32>)` does not. Reverted the change rather
than keep a type that promises narrowing it cannot deliver, and narrowed at the one use site instead.
This is a node-DSL inference question, not a frame one.

Verified: src tsc 0, **tst tsc 0**, examples tsc 0, 459 tests across 49 files, 83/83 pixel cases,
48/48 GLSL, 38 shaders under naga, biome clean on touched files.

---

## Layer 4.41 — `init({ backend })`, and the canvas stops being the renderer's

`src/renderer/core/init.ts` (new), `src/renderer/webgpu/backend.ts` (new),
`src/renderer/webgl/backend.ts` (new), both renderers, `renderer-ops.ts`, `renderer-interface.ts`,
`render-pass.ts`, `inspector.ts`, `index.ts`, six tests, the pixel harness, `tst/init.test.ts` (new),
and all 46 examples.

```ts
const canvas = document.createElement('canvas');
document.body.appendChild(canvas);

const view = canvasTarget(canvas, { samples: 4 });
view.setPixelRatio(devicePixelRatio);
view.setSize(window.innerWidth, window.innerHeight);

const gpu = await init({ backend: webgpu() });
```

Gone from both renderers: `canvas`, `domElement`, `setSize`, `setPixelRatio`, `getCanvasTarget`,
`setCanvasTarget`, `_canvasTarget`, `_resize`, `samples`, `stencil`, and the `headless` flag. Gone
from `renderer-ops`: `canvas()`, `domElement()`, `setPixelRatio()`, `isOffscreenCanvas` and the
`_canvasTarget` / `samples` / `stencil` fields on `RendererState`. `headless` is not a mode any more,
it is the absence of a canvas target, which is now the only way a renderer starts.

**`Backend` is generic, and that is what makes the union unnecessary.**

```ts
export type Backend<R extends Renderer = Renderer> = { readonly name: R['backend']; create(): Promise<R> };
export function init<R extends Renderer>(opts: { backend: Backend<R> }): Promise<R>;
```

`init({ backend: webgpu() })` is `Promise<WebGPURenderer>` statically, so `device` and `compute` are
reachable with no cast and no narrowing, while `init({ backend: runtimeChoice })` is `Promise<Renderer>`
and the caller branches on `gpu.backend` as the plan always said. No `Gpu` type and no
`WebGPURenderer | WebGLRenderer` union: `Renderer` is the one name, as it already was.

**WebGL forced an asymmetry, and it is the honest one.** A WebGL2 context *is* a canvas's context, so
that backend cannot start without one: `webgl({ target })` takes a `CanvasTarget` and keeps it as
`renderer.target`. `webgpu()` takes no canvas at all, because it acquires a context per target inside
the pass that names it. Writing them symmetrically would have meant either giving WebGPU a canvas it
does not need or pretending WebGL can defer one. The type says which is which.

**`dispose` needed the target set that layer 4.39 stopped privileging.** `SwapchainState.canvasTarget`
was the one canvas dispose could reach, so every other canvas's depth and MSAA textures leaked until
GC. It is now `sc.targets: Set<CanvasTarget>`, added to by `attachmentsFor`, and dispose releases the
context and destroys the attachments for each.

**Two things fell out rather than being removed.** `renderer.setSize` was already redundant: a pass
syncs `autoResize` and `canvasAttachments` recreates on a size mismatch, so the resize path ran
per-pass whether or not anyone called `setSize`. And the inspector's self-attach (append the panel to
`renderer.canvas.parentElement`) had no canvas to read; every example already appends
`inspector.domElement` itself.

`tst/stencil.test.ts` lost its "renderer depthFormat/stencil options resolve the swapchain stencil
aspect" case, because there are no such options. It is now a canvas-target test, which is where the
resolution moved in layer 0.

The example conversion was scripted over 46 files, then deduplicated: the old
`renderer.setSize(window.innerWidth, window.innerHeight)` after `appendChild` collided with the
`view.setSize` the new block already does, in 29 files by one path and 13 more by another.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 461 tests across 50 files, 83/83 pixel cases, 48/48
GLSL, 38 shaders under naga, biome clean on touched files.

---

## Layer 5.1 — the pass hooks are one bracket, in one place, in both backends

`src/renderer/webgpu/frame-backend.ts`, `src/renderer/webgl/frame-backend.ts`,
`src/renderer/webgpu/render-pass.ts`, `src/inspector/inspector-base.ts`,
`src/inspector/tabs/viewer.ts`, `tst/frame-encoder.test.ts`.

The plan said the frame and pass hooks get re-pointed at the new boundaries. They already were:
`begin` fires from `beginFrame`, `finish` from `submitFrame` and `discardFrame`, `beginRender` from
`encodePass`, `beginRenderScene` from `drawScene`. What was not checked is whether they are *paired*.

**They were not, and the two backends disagreed about where the closing half lives.** WebGPU fired
`finishRender` inside `RenderPass.endPass`, next to `gpuPass.end()`. WebGL fired it at the bottom of
`encodePass`. Same hook, same job, two places, held together by convention: the failure mode the
symmetry plan was written about.

**Worse, neither was balanced.** `beginRender` and `nodeFrame.beginRender()` ran before prepare, and
prepare evaluates the node graph, so anything that throws there (a bad node, a failed pipeline) left
the inspector's pass open and the render-id nesting one level deep for the rest of the frame. The
`finally` that existed only decremented `s.depth`.

Both backends now open the pass, call the body through `encodeOpenPass`, and close in a `finally`:

```ts
r.inspector?.beginRender(params.passId, nodeFrame.frameId);
try {
    encodeOpenPass(s, desc, ctx, params, records, count);
} finally {
    r.inspector?.finishRender(params.passId, nodeFrame.frameId);
    nodeFrame.endRender(previousRenderId);
}
```

`RenderPass.endPass(scope, passId, nodes, inspector)` is now `endPass(scope)`: it ends the GPU pass
and nothing else, which is what its name says.

A test in `tst/frame-encoder.test.ts` draws a mesh whose material graph throws on evaluation, asserts
`pass.end()` throws, and asserts both that `beginRender`/`finishRender` are paired and that the next
pass on the same frame is not nested inside the dead one.

**Three doc blocks were describing machinery that no longer exists.** `inspector-base.ts` listed its
hook call sites as `render() start`, `_renderPassNode start` and `_dispatchComputeNode` — none of
which are names in the codebase any more. `viewer.ts` carried the six-step save-set-restore ritual
(`save renderer state (renderTarget, mrt, clearColor)` … `restoreRendererState`) twice, in a file
whose code is now `frame.pass({ target })`, `draw`, `end`, `submit`. The one piece of real knowledge
in them survives as a line: a preview draws a `fullscreen` mesh wrapping the node rather than the
node's own graph, because a `PassNode` in it would open its pass inside the preview's and recurse.

Still ahead in layer 5: the ten public cache fields (`buffers`, `textures`, `samplers`, `pipelines`,
`bindings`, `geometries`, `renderObjectGpu`, `bindGroupLayoutCache`, `canvasContexts`, `swapchain`)
becoming a `BackendState` the inspector is handed, rather than ten fields it reaches into. Measured
now: `renderer.device` 13 times across the inspector, `_renderObjects` 6, `.buffers` 7, `.pipelines`
3, `.bindings` and `.renderObjectGpu` once each. The `setCanvasTarget`, `render(`, `clearColor` and
`renderTarget` reaches the plan counted are all gone: every remaining match was in the stale comments
deleted above.

Verified: src tsc 0, tst tsc 0, 462 tests across 50 files, 83/83 pixel cases, 48/48 GLSL, 38 shaders
under naga, biome clean on touched files.

---

## Layer 5.2 — `BackendState`, and the WebGL backend already had it

`src/renderer/webgpu/backend-state.ts` (new), `prepare.ts`, `render-pass.ts`, `frame-backend.ts`,
`renderer.ts`.

The plan called for the ten public `readonly` cache fields to "become internal to `BackendState`".
Half of that is right and half of it is not, and the code says which.

**The right half: they were being passed one at a time.** `encodeDraws` took fifteen parameters, seven
of them caches. `prepareRenderObject` took eight, six of them caches. `resolveAttachments` took six,
five. `disposeDevice` took nine, eight. Every one of those lists had to be written out at the call
site and kept in the same order as the signature.

```ts
export type BackendState = {
    device; adapter; format;
    buffers; textures; samplers; pipelines; bindings; geometries; renderObjectGpu;
    bindGroupLayoutCache; canvasContexts; swapchain;
};
```

`encodeDraws(b, nodes, ctx, …)`, `prepareRenderObject(b, nodes, renderObject)`,
`resolveAttachments(b, params)`, `disposeDevice(b, deviceProvided)`. Twenty-six parameters became
four.

**`WebGPURenderer implements BackendState`, with no field changes.** It already was exactly that
surface, which is the evidence the grouping is a description rather than an invention. The `implements`
clause is also the only check that matters: a cache added to the renderer and forgotten in the type,
or vice versa, is a compile error at the class.

**The wrong half: they do not become internal.** The plan's own inspector section concludes that a dev
tool should keep concrete coupling and be handed the backend state explicitly, and making these
`private` would contradict that — `renderer-inspector.ts` reads `pipelines` and `buffers` for the
memory tab, `compute-calls.ts` looks up compute pipelines, `inspector.ts` builds a probe pipeline off
`device`. They are now *named* rather than *hidden*, and `renderer.pipelines` under a
`backend === 'webgpu'` narrowing is already a typed `BackendState` field. Adding a `.backendState.`
hop would have been a second name for the same reach.

**The WebGL backend has had this since before the plan.** `RenderPass.DrawCaches` bundles its seven
draw-path caches, built once in `createWebGLFrameBackendState`. It is built by copying from the
renderer rather than by the renderer satisfying it, which looks like a drift hazard and is not: it is
deliberately the *subset* the draw path needs, and its seven required fields make an omission a
compile error. Renaming the renderer's `_geometries`/`_buffers`/… to drop their underscores so it
could be structural would touch 56 references and make that file's naming inconsistent with
`_programs`, `_probe` and `_transformFeedback`, for symmetry that is not real: WebGPU's is the whole
device surface, WebGL's is one path's slice.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 462 tests across 50 files, 83/83 pixel cases, 48/48
GLSL, 38 shaders under naga, biome clean on touched files.

---

## Layer 5.3 — the tree-shaking claim, measured

`tst/tree-shake/run.mjs` (new), `tst/tree-shake/webgpu-only.mjs`, `tst/tree-shake/webgl-only.mjs`,
`package.json`.

"One entry point, named exports, no subpaths" rests entirely on one claim: that a static backend
choice shakes the loser out once `"sideEffects": false` exists. The plan said so and then said it
"needs verifying against the module-level state in `pass-node.ts` and the PURE-annotated node
singletons". It never was. `"sideEffects": false` was added in layer 4 and nothing checked that it
does anything.

It does, in both directions:

```
  ✓ webgpu-only  525 KB (32% of dist)
  ✓ webgl-only   646 KB (39% of dist)
```

A WebGPU-only app carries no `compileGlsl`, no `'webglcontextlost'` listener, no
`precision highp float`, no `getContext('webgl2'`. A WebGL-only app carries no `compileWgsl`, no
`getPreferredCanvasFormat`, no `requestAdapter`, no `createRenderPipeline`. The two bundles sum to
1171 KB against a 1630 KB `dist`, so roughly 460 KB is the shared node DSL, scene and math that
neither side can drop, which is the number the "no subpaths" argument actually turns on.

**Three near-misses that would have made this a rubber stamp.** `WebGLRenderer` appears in the
webgpu-only bundle, in a comment. `fragment stage` appears twice, in a WGSL-path error message and a
comment. `Inspector` appears twenty times, all of it `NodeKind.Inspector` and `InspectorNode`, the
node-graph `inspect()` hook rather than the DOM panel. Markers have to be chosen to land in emitted
code, not in prose, or the harness passes for the wrong reason and fails for the wrong reason later.

The harness was checked against a deliberately-present marker (`class Mesh`) and reported the failure
with a non-zero exit, so it can fail. `pnpm run test:shake`.

Verified: src tsc 0, tst tsc 0, 462 tests across 50 files, 83/83 pixel cases, 2/2 shake bundles.

---

## Layer 5.4 — WebGPU is proven by a device now, not by a stub

`tst/webgpu-render/cases.ts` (new), `tst/webgpu-render/run.mjs` (new), `package.json`.

Risk 1 in the plan, unchanged since it was written: "WebGPU is validated by a stub, not by a device.
… it cannot see a wrong colour. Two WebGPU-only bugs so far were found by reading, not by a test."
Every claim this whole refactor makes about the WebGPU path rested on `stub-gpu.ts` and on reading.

```
adapter: apple / metal-3

  ✓ clear             got [51, 102, 153, 255]   want [51, 102, 153, 255]
  ✓ solid             got [255, 0, 0, 255]      want [255, 0, 0, 255]
  ✓ uniform           got [0, 255, 0, 255]      want [0, 255, 0, 255]
  ✓ scene             got [0, 0, 255, 255]      want [0, 0, 255, 255]
  ✓ two-passes        got [255, 255, 0, 255]    want [255, 255, 0, 255]
  ✓ viewport-scissor  got [0, 0, 255, 255]      want [0, 0, 255, 255]
```

Every case renders into a `RenderTarget` and reads its centre pixel back with `read(gpu, target)`,
which is the headless story the plan describes, exercised for real: no canvas exists in Node.
`two-passes` puts two targets on one frame and one submit; `viewport-scissor` puts the draw in a
corner rect and asserts the centre is still the clear colour, so a `PassDesc.scissor` that stopped
being applied reads red.

**The browser route is closed, which is worth recording so nobody retries it.** Playwright's bundled
Chromium (151) has no `navigator.gpu` at all, under `--enable-unsafe-webgpu`,
`--enable-features=WebGPU,Vulkan`, `--use-webgpu-adapter=swiftshader` and
`--use-vulkan=swiftshader` in every combination. The locally installed Chrome (153) launched headless
through the `chrome` channel is the same. The plan's "Node plus the `webgpu` package is the only
route" is correct, and it is also cheap here: `webgpu@0.4.0` is already a dependency of lib, so it is
a package this project has accepted, now a devDependency of gpucat too.

**Two things made the harness fight back.**

`esbuild.build()` forks a child process. Doing that after Dawn's native addon is loaded in the same
process segfaults the runner, silently, with the buffered stdout lost. The bundle step now runs
*before* Dawn loads, which is not an ordering anyone would guess from reading the code, so it says so.

Dawn also segfaults while Node tears the process down, which turned a fully green run into exit 139.
The runner destroys the device and exits on its own terms once the results are flushed. Checked both
ways: a deliberately wrong expectation reports `1 / 6 cases read the wrong pixel` and exits 1.

`pnpm run test:webgpu`. The regression net is now six gates: vitest, WebGL pixels, **WebGPU pixels**,
GLSL links, naga validation, tree-shaking.

Verified: src tsc 0, tst tsc 0, 462 tests across 50 files, 83/83 WebGL pixel cases, 6/6 WebGPU pixel
cases, 48/48 GLSL, 38 shaders under naga, 2/2 shake bundles.

---

## Layer 5.5 — the WebGPU gate covers what the refactor changed

`tst/webgpu-render/cases.ts`, `child.mjs` (new), `case-names.mjs` (new), `run.mjs` (rewritten).

Six cases proved a device works. They did not touch the features this refactor actually moved, so
five more do: `mrt` (a named output has to land on attachment 1, read back directly), `cube-layer`
(six faces cleared to six reds on one frame via `PassDesc.layer`, face 3 read back), `msaa` (a
4-sample target resolving into its single-sample texture), `draw-material` (the per-submission
override that replaced `overrideMaterial`, with the mesh's own material deliberately a different
colour), and `compute` (a compute pass and a render pass on one frame, the draw reading what the
dispatch wrote). Eleven for eleven on Metal-3.

**Getting there cost three findings about Dawn in Node, none of them about gpucat.**

1. **esbuild forks; forking with Dawn loaded segfaults.** Known from layer 5.4, still true.
2. **Importing the bundle into a process that has not run esbuild also segfaults.** So neither order
   is safe by itself: the working sequence is bundle, *then* Dawn, *then* import, in one process. A
   parent that bundles and hands the path to a child breaks rule 2, which is exactly what the first
   attempt at isolation did, and every case died with no output at all.
3. **One process dies after roughly eight cases whatever their order.** Forward it reached the
   eleventh; reversed it died on the eighth. Adding a 50 ms `setTimeout` between cases made it die on
   the *first*, which is the signature of Dawn's own event loop rather than of anything a case does.

So each case gets its own process, and each child does its own bundle-then-Dawn-then-import. Eleven
esbuild runs cost about five seconds, which is the price of a gate that cannot be poisoned by the
case before it and that names the case when Dawn aborts, instead of losing the buffered output.

The parent reads a plain `case-names.mjs` so it needs no bundle of its own; `cases.ts` exports
`assertCaseNames`, which the child calls, so the two lists cannot drift.

**Two near-misses worth naming.** `msaa` and `compute` each passed alone and crashed in a full run,
which reads exactly like a real MSAA-resolve or compute-ordering bug and is neither. And the
`webgpu` package was bumped 0.4.0 to 0.6.1 on the theory that the addon was old; it changed nothing,
so the upgrade stands on its own merits rather than as a fix.

Checked that the gate fails: a wrong expectation on `cube-layer` reports `1 / 11 cases failed` and
exits 1.

Verified: src tsc 0, tst tsc 0, 462 tests across 50 files, 83/83 WebGL pixel cases, **11/11 WebGPU
pixel cases**, 48/48 GLSL, 38 shaders under naga, 2/2 shake bundles.

---

## Layer 5.6 — a dead-export sweep, and the fourth unreachable export

`src/index.ts`, `src/nodes/lib/display/pass-node.ts`, `src/renderer/webgpu/pipelines.ts`,
`src/renderer/webgpu/render-object-gpu.ts`.

Swept every `export` in `src` for identifiers nothing else in `src`, `tst` or `examples` mentions.

**`depthPass` is a working feature with no way to reach it.** `PassNode`'s `scope` decides whether the
node, read as an expression, samples its colour or its linear depth — three emitters branch on it
(`glsl/emit.ts:530`, `wgsl/emit.ts:292`, `graph.ts:149`). The only constructor for a depth-scope pass
is `depthPass()`, and `index.ts` re-exports `./nodes/nodes` through an explicit name list that omits
it. Exported now. **Fourth instance of this exact defect** after `compile`/`compileCompute` (4.35),
`readPixels` (4.31) and `MRTNode` (4.40): a working thing behind an explicit export list that nobody
updated.

Deleted as residue of this refactor: `DEPTH_FORMAT` and `DEPTH_STENCIL_FORMAT` (their last readers
were the swapchain depth-format derivation removed in 4.41) and `clearRenderObjectGpu`.

**The sweep's blind spot, found by trying to use it.** `PassNode.scope` looked dead to a `this.scope`
grep, so I deleted the field, the two `FRAGMENT`/`DEPTH` constants and `depthPass` together. tsc
caught it in one run: the three readers spell it `node.scope`, not `this.scope`. A first-pass sweep
finds candidates; only the typechecker decides.

The first sweep also ran over `git ls-files`, which lists **tracked** files, and most of this
refactor's new files are untracked, so every symbol they use looked unused. Walking the working tree
instead changed the candidate list completely. A tool that answers "nothing references this" has to
be asked what "nothing" it searched.

### The `pass-node` pixel case, attempted and reverted

A `PassNode` opening its own pass inside the outer pass's prepare is the most delicate ordering in
this design, and the WebGPU gate did not cover it. A case for it makes **every** case in the harness
segfault, including `clear`, deterministically across three runs. Importing `pass` or `renderOutput`
into the bundle alone does not; only the case body's presence does, and the case never runs for
`clear`. That is bundle composition, the same Dawn-in-Node fragility as layer 5.5's three findings,
and not something gpucat does.

Reverted rather than shipped broken. The gap is narrower than it looks: the WebGL harness covers this
shape in pixels (`fullscreen(renderOutput(...))` over a `PassNode`, two cases), so the mechanism is
proven, just not on both backends.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 462 tests across 50 files, 83/83 WebGL pixel cases,
11/11 WebGPU pixel cases, 48/48 GLSL, 38 shaders under naga, 2/2 shake bundles.

---

## Layer 6 — lib ported

`lib/src/render/pipeline.ts`, `webgpu.ts`, `webgl.ts`, `offline.ts`, `voxels/voxel-resources-gpu.ts`,
`lib/src/client/{block,prefab}-icons.ts` (via the interface), three lib tests, and
`gpucat/src/index.ts`.

**`RenderPipeline` becomes a mesh.** `EngineRenderPipeline.pipeline: RenderPipeline` is
`composite: Mesh`, built by `fullscreen(outputNode)`, and `pipeline.render()` is
`renderPipelineToTarget(engine, target)`: one frame, one pass, one draw. The scene and overlay passes
still schedule themselves, because the composite samples their textures. Rebuilding on
`setRenderPipeline` disposes the two old `PassNode`s rather than the old pipeline, since the mesh
owns nothing.

**Both backends now own their canvas.** Each makes the element, wraps it in a `canvasTarget`, sizes
it, and hands it to the renderer: WebGL as `new WebGLRenderer({ target: view })`, WebGPU as nothing
at all. lib's `Renderer.canvas` reads `state.view.canvas`. lib keeps `new WebGPURenderer(...)` plus
`await renderer.init()` rather than `init({ backend })`, because its boot is deliberately two-phase
(sync construction so the pipeline can be wired against GPU buffers, async device handshake later),
and the classes are exported for exactly that.

**The icon-tile path is where the ambient state actually lived**, and it converted cleanly:

```ts
frame.pass({ target: sceneColor, camera, viewport: rect, scissor: rect,
             clear: tile.clear ? [0, 0, 0, 0] : false, clearDepth: tile.clear ? undefined : false })
```

replaces six mutations (`r.renderTarget`, `sceneColor.viewport`/`scissor`/`scissorTest`,
`r.autoClear`, `r.clearColor`) plus a save and a restore, in both backends. The plan predicted this
line almost exactly.

`OfflineRenderer.createPipeline` returns `OfflineChain = { draw: Mesh; dispose(): void }` rather than
a bare mesh, because the scene chain owns a `PassNode`'s render target and the icon bakers already
called `.dispose()` on what they got back. The post chain's `dispose` is empty and says so: it samples
a target it does not own.

### Four more holes in gpucat's export list, found by a consumer

`Renderer`, `RendererBackend`, `DispatchRecord` and `DrawRecord` were not exported from `index.ts`.
`ComputeDispatch`, which lib imported 4 times, had been renamed to `DispatchRecord` without the new
name ever becoming public. This is the same explicit-name-list hole as `compile`/`compileCompute`
(4.35), `readPixels` (4.31), `MRTNode` (4.40) and `depthPass` (5.6) — **five rounds of the same
defect**, and the only reason this round was caught is that a consumer finally compiled against it.
A star re-export or a lint rule would have caught all five.

Also renamed in lib: `DispatchRecord.dispatch` is `counts` (4 sites), and `renderer.compileCompute(x)`
is `compileCompute(renderer, x)` (18 sites).

**`renderer.compile(scene, camera)` is `compile(drawables, target, camera)`**, so lib's prewarm now
walks its throwaway scene into a `Mesh[]` and names the scene pass's own render target. That is
strictly better: the pre-warm previously compiled against whatever the ambient target happened to be,
and now compiles against the attachments the first real frame will ask for.

### The typecheck blind spot that cost two test failures

`pnpm -C lib typecheck` came back clean while two tests still threw `gpu.compile is not a function`.
Both did this:

```ts
const { compile } = gpu as unknown as { compile: (slots: {...}) => {...} };
```

A cast over the module namespace, asserting a shape onto `gpucat` itself. The `compile` to
`compileWgsl` rename passed straight through it, because the cast tells the typechecker what the
module contains instead of asking. Both now call `gpu.compileWgsl(...)` with no cast, and one gained a
named `isEnvConfig(schema)` predicate for the struct-fields probe the cast used to hide.

### State

lib's render layer and `tst/` typecheck clean. Three errors remain, none in the render layer and none
touching gpucat: two in `editor/src/processes/runtime.ts`, one in `physics/rigid/rigid-body-api.ts`.
1227 of 1229 lib unit tests pass; the one failure is `block-variants.test.ts` asserting a leaf-culling
variant count, whose file was last touched by `1ca92dce feat(voxels): self-cull leaves against
adjacent leaf blocks` and which imports nothing this port changed.

Verified: gpucat src tsc 0, tst tsc 0, examples tsc 0, 462 tests, 83/83 WebGL pixels, 11/11 WebGPU
pixels, 48/48 GLSL, 38 naga, 2/2 shake bundles; lib tsgo clean in `src/render` and `tst`, 1227 unit
tests pass.

---

## Layer 6.1 — the export-list defect gets a gate

`tst/public-api.test.ts` (new), `tst/public-api-internal.ts` (new), `src/index.ts`.

Five times across this refactor a module behind an explicit re-export list in `index.ts` gained an
export the list never picked up, and the working feature shipped unreachable:
`compile`/`compileCompute` (4.35), `readPixels` (4.31), `MRTNode` (4.40), `depthPass` (5.6),
`Renderer`/`RendererBackend`/`DispatchRecord`/`DrawRecord` (6). Every one was found by a consumer
compiling against it, never by gpucat itself. Reporting it a sixth time is not a fix.

**The first rule I wrote was wrong, and the numbers said so.** "Everything a name-listed module
exports must be in the list" fails on 197 names, and reading them shows nearly all are deliberate:
`createFrame`, `beginFrame`, `beginInfoFrame`, the node classes behind the DSL factories. The
curation is real, so the gate cannot be "export everything".

What the five bugs actually share is that they are *new* exports, not old ones. So the gate is a
ratchet: the current curation is written down once in `DELIBERATELY_INTERNAL`, and anything that
appears afterwards must go in one list or the other. The failure names the symbol and says where to
put it.

Checked by adding a `stencilPass` beside `pass` — a stand-in for exactly the next `depthPass` — and
the test failed with `./nodes/nodes#stencilPass` by name.

**Three of the 197 were the same bug, unnoticed.** `CanvasResizeEvent` is the parameter type of the
public `CanvasTarget.onResize`, and `isRenderTarget` / `renderTargetOf` are the only way to narrow the
public `Target` union. All three are reachable from a public signature and were unnameable by a
consumer. Exported.

The test uses the TypeScript compiler API rather than parsing text, so `export *` chains resolve the
way a consumer's import would; a star re-export is skipped, because it cannot go stale.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 463 tests across 51 files, 83/83 WebGL pixels, 11/11
WebGPU pixels, 48/48 GLSL, 38 naga, 2/2 shake bundles; lib's render layer and tst still typecheck
clean against the rebuilt dist.

---

## Layer 6.2 — an unmatched MRT output name throws

`src/nodes/lib/mrt.ts`, `src/renderer/core/node-manager.ts`, both frame backends,
`tst/mrt-outputs.test.ts` (new).

Open item 2 said this was "a decision rather than a fix", because throwing is "a semantics change for
existing users". **That premise is false here**: `AGENTS.md` says gpucat has no users yet and not to
work around compatibility, and the only consumer, lib, uses no MRT at all (one stale comment
mentioning `setMRT`, zero calls). So the reason it was parked does not apply, and what remains is
simply whether skipping is right. It is not.

`resolveOutputs` logged `Output 'x' not found in render target textures. Skipping.` and carried on,
which leaves a hole in `members`, so the emitted shader declares fewer `@location`s than the pass
binds attachments and the backend draws with one attachment sitting at its clear colour. A typo in an
output name produced a picture, just a quietly wrong one. It now throws and names the alternatives:

```
[mrt] output 'noraml' names no attachment on this target. It has: output, normal.
```

The attachment names are passed in purely to write that sentence, which is why the parameter says so
rather than looking like a second lookup path. Three call sites supply them.

Three tests: a named output resolves to its own index, a misspelled one throws with both the bad name
and the target's real names, and a target with no colour attachments says `(none)` rather than listing
nothing.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 466 tests across 52 files, 83/83 WebGL pixels, 11/11
WebGPU pixels (the `mrt` case among them), 48/48 GLSL, 38 naga, 2/2 shake bundles; lib typechecks
clean against the rebuilt dist and its unit suite is unchanged.

---

## Layer 6.3 — the symmetry plan audited, its last step closed, and a real bug behind it

`tst/webgpu-render/cases.ts`, `case-names.mjs`, `src/renderer/webgpu/buffers.ts`.

Risk 2 ended with "what remains is to decide whether the symmetry plan is finished enough to delete
its doc". That is checkable rather than a matter of taste, so it was checked.

**Steps 1 to 4 are all done.** Both backends now have `samplers.ts`, `render-target.ts`,
`buffers.ts` and `bindings.ts`; `webgl/uniforms.ts` is gone; `invokeUniformGroupCallbacks` sits in
`core/bind-group.ts` and there is **not one cross-backend import left** in either directory. The six
resource mappings in its table are six-for-six, and the deliberate name difference it argued for
(`programs.ts` vs `pipelines.ts`) still holds.

**Its open question was answered without anyone noticing.** It asked whether `renderer-interface.ts`
should widen its doc to "what every backend must satisfy" or move `info` out. Layer 4.41 rewrote that
doc to "what `init` returns" and kept `info` with an explicit justification, which is the widening
option. Recorded rather than left dangling.

**Step 5 was the only thing outstanding**, and it is the one that mattered: "run `dispose-releases`
on **both** backends", written when WebGPU had no harness at all. It has one now, so the case is
ported, and it failed on its first run.

### What it found

`info.memory.buffers` on WebGPU **never went down**. The `_onDispose` hook destroyed the `GPUBuffer`
and stopped there:

```ts
buffer._onDispose = () => {
    const entry = cache.bufferMap.get(buffer);
    if (entry) entry.buf.destroy();
};
```

No `bufferCount--`, no `bufferMap.delete`. `webgl/buffers.ts` does both, and also chains any previous
callback because the storage-texture path in `textures.ts` hangs its own. So this is a stat that lies
rather than a leak, but it lies in the direction that hides leaks, and it is exactly the asymmetry the
symmetry plan exists to catch. Fixed to match, chaining included.

**And the fix introduced a second bug, which the asymmetry also explains.** The old hook was guarded
by `if (buffer._onDispose) return;`, so chaining it removed the only thing stopping double
registration; WebGPU calls `setupDispose` on every Allocate, including a reallocation, whereas WebGL
calls it strictly inside `if (!entry)`. Two registrations would decrement twice. The count and the
hook now live under one guard, the same one WebGL uses.

`dispose-releases` on WebGPU: `textures 2->6->2, buffers 1->3->1`. Twelve cases on a real device.

**The case caught a flaw in itself first**, which is worth keeping: its closing warm draw built a
fresh geometry, so the baseline could never be reached again. One warm geometry, reused, and the
comment says why rather than restating the loop.

### Verdict on `PLAN-backend-symmetry.md`

Discharged. Every step is done, its open question is resolved, and its parity job now runs on both
backends and has earned its keep by finding a bug on the first run. Deleting it is the user's call,
but nothing in it is outstanding.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 466 tests across 52 files, 83/83 WebGL pixels, **12/12
WebGPU pixels**, 48/48 GLSL, 38 naga, 2/2 shake bundles.

---

## Layer 6.4 — two more parity cases, and `clearDepth` was ignored on every WebGPU render target

`tst/webgpu-render/cases.ts`, `case-names.mjs`, `src/renderer/webgpu/render-pass.ts`.

`dispose-releases` found a bug on its first run, so the obvious next move is more of the same: the
WebGL harness has 83 cases and WebGPU had 12. Picked two where the two backends have genuinely
different native behaviour behind one neutral contract, which is where an asymmetry can hide.

**`readback-orientation` passes.** `read()` promises rows top-to-bottom whichever backend produced
them, and the native conventions disagree, so the contract only held on the side that was tested.
Red above clip-space y=0, green below; row 3 is red and row 60 green on Dawn. No bug, but the promise
is now checked on both sides rather than on one.

**`clear-depth` failed, and the bug is worse than the case.** WebGPU has three depth-attachment
paths. The swapchain one honours `params.clearDepthValue` and `params.autoClearDepth`. The other two
did not:

```ts
depthClearValue: 1.0,
depthLoadOp: loadOp,   // the COLOUR load op
```

So on a `RenderTarget`, `PassDesc.clearDepth` was ignored entirely: a reversed-Z pass asking for
`clearDepth: 0` got 1.0 and every `'greater'` test failed. Two further contract breaks came free with
the same two lines, since depth borrowed colour's load op: `clear: false, clearDepth: 0` would load
depth instead of clearing it, and `clear: [...], clearDepth: false` would clear depth against the
caller's word. The cube path had the same hardcode plus a fabricated `{ autoClearStencil: true,
clearStencilValue: 0 } as RenderPassParams` where the real `params` were in scope one frame up.

All three paths now read the same two fields. `resolveCubeAttachments` takes `params` for it.

**Why nothing caught this before.** The WebGL harness has `clear-depth`, and it renders to the
*canvas*, which is the one WebGPU path that was already right. A case is only parity if it covers the
same target kind, not just the same feature name. This one uses a `RenderTarget`, since Node has no
canvas.

That is three real bugs from four ported parity cases (`dispose-releases`' buffer count,
`setupDispose`'s double registration, and this), against zero from the six cases written to prove the
device works at all. Porting from the backend that has coverage beats inventing new ones.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 466 tests across 52 files, 83/83 WebGL pixels,
**14/14 WebGPU pixels**, 48/48 GLSL, 38 naga, 2/2 shake bundles.

---

## Layer 6.5 — the harness ceiling was bundle size all along

`tst/webgpu-render/child.mjs`, `cases.ts`, `case-names.mjs`.

Three more parity cases. `clear-depth-only` passes and locks layer 6.4's fix in place: two passes to
one target, the second keeping colour while clearing depth, which reads green if depth ever borrows
colour's load op again. Then `rtt` segfaulted, and so did every other case with it in the file, which
is exactly what `pass-node` did in layer 5.6.

**Last time I called that "bundle composition" and moved on. That was a guess, and it was wrong.**

Imports alone are fine: forcing `texture` and `screenUV` into the bundle with no case body runs
clean. So it is the body's presence, which cannot matter at run time for a case that never executes.
What else changes is the bundle's size, so: take the working file, add nothing but
`export const PAD = 'xxxx…'`, 20 KB of inert characters.

It segfaults. 520 KB runs, 540 KB of the same code plus padding does not. **It was never composition,
and never anything gpucat does — it is a size ceiling on the module Dawn's process imports**, around
530 KB.

The fix is one flag: `minify: true` on the child's esbuild call takes 534 KB to 254 KB, less than half
the ceiling. `rtt` passes.

**And the case I could not have in layer 5.6 is back.** `pass-node` drives a `PassNode` opening its
own pass from inside the outer pass's prepare, which is the single ordering this whole design turns
on, and it now runs on a real device: `nested pass drew 232,0,232; the outer clear is green`. The gap
that layer said would stay open on one backend is closed.

Two lessons kept rather than re-learned. A guess that explains the symptom ("composition") is not a
diagnosis, and the difference between them here was one twenty-line experiment. And a harness with an
unexplained ceiling silently costs coverage: 5.6 reverted a case and wrote off the most delicate path
in the design because of a wall nobody had measured.

Verified: src tsc 0, tst tsc 0, 466 tests across 52 files, 83/83 WebGL pixels, **17/17 WebGPU
pixels**, 48/48 GLSL, 38 naga, 2/2 shake bundles.

---

## Layer 6.6 — three more parity cases, all green

`tst/webgpu-render/cases.ts`, `case-names.mjs`.

With the size ceiling gone the harness can take whatever the WebGL side has. Three more, 20 cases:

- **`buffer-swap`** — replacing a geometry's named buffer has to reach whatever the backend baked the
  old one into. On WebGL that is the VAO, and `Geometry.bindingsVersion` was added in layer 4 for
  exactly this; the WebGPU side had never been checked. Draw left, swap `position` for a right-hand
  triangle, draw again: the right half is green.
- **`mrt-blend`** — per-attachment blend, which WebGL2 rejects outright (its case asserts the throw),
  so the WebGPU capability had no pixel coverage at all. `colA` replaces and stays 64, `colB` is
  additive and reaches 128, from the same fragment into the same pass.
- **`pass-depth-sample`** — a pass's depth attachment sampled by a later pass through
  `getDepthTextureNode().load()`, which is how overlay occlusion reads it and where lib's
  "black canvas" bug once lived. Depth 0.2 up top reads 149, 0.8 below reads 225.

All three passed. Three ported cases, no bugs, which is worth recording as plainly as the three that
did find bugs: the yield is real but it is not every case, and a green parity case still converts an
assumption into a fact.

**One self-inflicted fault worth keeping.** `pass-depth-sample` failed on its first run with
`near row 149, far row 225`, and the reflex reading is a bug in depth sampling. It was my assertion:
depth 0.2 renders *darker*, so the near row is the smaller number, and I had written `near > far`. The
numbers were right the whole time. The variables are now named for the depth they carry rather than
for which is expected to be larger, and the comment says which row is the image top.

Verified: src tsc 0, tst tsc 0, 466 tests across 52 files, 83/83 WebGL pixels, **20/20 WebGPU
pixels**, 48/48 GLSL, 38 naga, 2/2 shake bundles.

---

## Layer 6.7 — `draw-opts` ported, and `PassDesc.layer` / `mipLevel` stop lying

`tst/webgpu-render/cases.ts`, `case-names.mjs`, `src/renderer/core/pass-desc.ts`,
`src/renderer/core/pass-context.ts`, `src/renderer/core/frame.ts`, `tst/pass-desc.test.ts`.

The parity backlog is about sixty cases and most of what is left is node-DSL surface (the `storage-*`
and `struct-texture-*` families), not frame-API surface. So this took the last two that are the frame
API's own, and stops porting there.

**`draw-opts` passes.** `DrawOpts.range` per submission is what lets one geometry serve two draws:
six vertices cover the left half and six the right, green takes the first range and red the second.
Twenty-one cases.

**`mipLevel` had no coverage anywhere**, and going to write one found why.
`resolvePassContext` does this:

```ts
if (rt !== null && isCubeRenderTarget(rt)) {
    if (desc.layer !== undefined) rt.activeFace = desc.layer;
    if (desc.mipLevel !== undefined) rt.activeMipmapLevel = desc.mipLevel;
}
```

`activeFace` and `activeMipmapLevel` exist **only on `CubeRenderTarget`**, so on any other target both
fields are accepted by the type and dropped on the floor. A cube bake wired to a plain `RenderTarget`
would write every face on top of itself at level 0 and look like a content bug. Both now throw, the
same call the MRT output names got in layer 6.2, and both fields have a doc line saying cube-only,
which neither had before.

**Two genuinely dead fields went with it.** `RenderContext.activeCubeFace` and
`activeMipmapLevel` are declared and initialised to 0 and never written or read anywhere: the state
they name lives on the cube target, and the backends read it from there. Deleted. That is the same
"declared but nothing reads it" class this refactor has now found in `PassDesc.layer`, `clearDepth`,
`DrawOpts`, `passId`, `initialCacheKey`, `vertexBuffers`, `indexBuffer` and `occlusionQueryCount` —
the difference here is that two of them were on the *context*, which is the type every pass goes
through.

Checked no caller hits the new throw: `CubeCamera` is typed `CubeRenderTarget`, the cube-camera
example reads faces through `read(..., { layer })` rather than a pass desc, and lib passes neither.
The three cube pixel cases still pass.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 468 tests across 52 files, 83/83 WebGL pixels, **21/21
WebGPU pixels**, 48/48 GLSL, 38 naga, 2/2 shake bundles.

---

## Layer 6.8 — the plan's own citations had rotted

`PLAN-explicit-frame.md`, `tst/plan-refs.test.ts` (new).

Step 4 of every cycle is "re-evaluate the plan against what the code shows", and doing that
incrementally caught claims in the sections being touched. Nobody had checked the parts not being
touched. The plan cites gpucat files as evidence and thirty of those citations carried line numbers.

**Every one had drifted, and three pointed past the end of their file**:
`webgpu/renderer.ts:885` of 452 lines, `webgl/renderer.ts:535` of 510, `renderer-ops.ts:262` of 110.
A reader following those lands on unrelated code or nothing at all, which is worse than no citation.

Re-numbering them would buy a few cycles at most, so they are names now: `alignCameraToBackend`,
`buildCacheKey`, `prepareRecordedDraws`, `encodeDraws`, `getRenderContext`, `CubeCamera.update`. A
name survives the edit that moves it; a line number is invalidated by every edit above it. The one
line reference left is into vgpu, another repo, where a line is the only locator available.

**Two claims were stale, not just their locators**, and finding them is what the exercise was for:

- "both backends stamp `coordinateSystem` onto the camera and rebuild the projection every render"
  described two copies inside two `render()` methods that no longer exist. It is one
  `alignCameraToBackend` in `core/pass-desc.ts`, called once per pass from `encodePass`.
- "`RenderObjectsState.passCaches` is a `Map<string, RenderObjectCache>` keyed by `passId`" is written
  in the present tense two paragraphs above the decision that deleted it. `passCaches` has no matches
  in `src`.

A third was merely undated: the layer-0 note that `RenderTarget.viewport`/`scissor`/`scissorTest`
"moves to layer 1" still read as future work, and both the fields and their ambient readers went in
layer 4.38.

`tst/plan-refs.test.ts` holds the line: every gpucat file the plan names must exist, and no citation
may carry a line number except into another repo. Checked by renaming one citation to
`core/pass-descriptor.ts`, which it reported by name.

The test needed two rounds to be honest rather than merely green. Bare filenames like `bindings.ts`
live in both backend directories, so it resolves against the tail of a real path instead of guessing
prefixes; and citations to lib are listed explicitly as lib-owned rather than silently skipped by a
prefix match, so the exemption is visible.

Verified: src tsc 0, tst tsc 0, 470 tests across 53 files, 83/83 WebGL pixels, 21/21 WebGPU pixels,
48/48 GLSL, 38 naga, 2/2 shake bundles.

---

## Layer 6.9 — the API listing had drifted in five places, and the ratchet had frozen a hole

`PLAN-explicit-frame.md`, `tst/plan-refs.test.ts`, `src/index.ts`, `tst/public-api-internal.ts`.

Layer 6.8 fixed where the plan points. This checks what it says. The API listing is the block a
reader takes as the contract, so every line of it went against the real types:

- **`type Drawable = Mesh` was never created.** `Pass.draw(mesh: Mesh, ...)` takes the class. An alias
  with exactly one member is a second name for the same thing, so the listing says `Mesh` now and the
  paragraph arguing the point no longer names a type that does not exist.
- **`clear?: Color | false`** — there is no `Color` type. It is
  `[number, number, number, number] | false`, spelled out.
- **`compile`, `compileCompute` and `read` take `Renderer`** in the listing and `CompilableGpu` /
  `ReadableGpu` in the code. The narrower structural minimums are deliberate, so the listing was the
  thing to fix, with a line saying why each asks for what it needs and nothing else.
- **`init` is generic.** The listing had `Promise<Renderer>`, which throws away the whole reason
  `Backend<R>` is generic (layer 4.41).
- **`GpuBuffer<Any>`** should be `GpuBuffer<d.Any>`; `Any` is reached through the exported `d`.

**And the test written to hold that line found a sixth thing, in my own gate.** `ComputeNode` is not
exported from `index.ts`, though `compileCompute(gpu, nodes: ComputeNode[])` and
`c.dispatch(node: ComputeNode, ...)` are both public: a consumer cannot name the type of the thing
they pass. That is the same defect as the five in layer 6.1, and the ratchet did not stop it, because
the ratchet only rejects exports that appear *after* its baseline, and the baseline was generated
from the surface as it stood without anyone auditing it. **A ratchet freezes whatever it starts
from.** Exported, and removed from `DELIBERATELY_INTERNAL`.

The listing test needed two corrections to be honest rather than green: it read `reversed-Z` out of a
trailing comment as a type name, and `Any` out of `d.Any` when `d` is what has to be exported. Both
are now excluded by rule (strip `//` comments; ignore dotted names) rather than by special case.
Checked it fails by renaming `PassDesc` to `PassDescriptor` in the listing, which it reported.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 471 tests across 53 files, 83/83 WebGL pixels, 21/21
WebGPU pixels, 48/48 GLSL, 38 naga, 2/2 shake bundles.

---

## Layer 6.10 — auditing the frozen baseline, and a gate that would have caught all seven

`tst/public-reach.test.ts` (new), `src/camera/orthographic-camera.ts`, `src/inspector/inspector.ts`.

Layer 6.9 ended on the observation that a ratchet freezes whatever it starts from, and that
`ComputeNode` had been sitting inside layer 6.1's 198-entry baseline as a real hole. So the baseline
needed auditing, and auditing it by hand is the wrong tool: the question "is this curation or a hole"
has an answer a machine can give. **A type named in a public signature that the package does not
export cannot be written down by a consumer.** Everything else is curation.

Measured, that rule finds 31 types. They sort into four groups, and the sorting is the work:

- **Type parameters** (`T`, `S`, `D`, `K`). A generic's own parameter is not a hole.
- **Another package's types** (`Vec3`, `Quat`, `Box3`, `Sphere`, from `math`). These looked like
  gpucat's because `checker.getSymbolAtLocation` on a type reference resolves to the **import
  specifier in the file doing the referencing**, not to the declaration. Resolving the alias moves
  them out of `src/` where they belong. Without that step the check accuses the wrong repo.
- **Reached through `d`** (`Any`, `Infer`, `StructSchema`, `TypedArrayFor`). `import { d }` is the
  documented idiom and `d.Any` is nameable, so these are reachable, just not bare.
- **Genuine**: `ViewOffset`, the type of `OrthographicCamera.view`, which a consumer setting a tiled
  frustum has to name. Exported. And seventeen dev-tool types behind `Inspector`'s tab fields and
  wiring methods, which are public so the panel can reach itself; those are `@internal` now, which is
  this codebase's existing word for it and says the intent rather than hiding it.

After all four, zero. `tst/public-reach.test.ts` keeps it there, and says `export it, or mark the
member @internal` when it fails. Checked by un-exporting `ViewOffset`, which it reported as
`ViewOffset (named by OrthographicCamera.view)`.

**This is the gate that should have existed before the ratchet.** The ratchet answers "did the surface
change"; this answers "is the surface usable", and it would have caught `compile`, `compileCompute`,
`readPixels`, `MRTNode`, `depthPass`, `ComputeNode` and `ViewOffset` without any of them needing a
consumer to trip over it first. Seven rounds of one defect, and the difference between the two gates
is that one compares against a snapshot and the other against a property.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 472 tests across 54 files, 83/83 WebGL pixels, 21/21
WebGPU pixels, 48/48 GLSL, 38 naga, 2/2 shake bundles.

---

## Layer 6.11 — the in-flight destruction hazard, asked of the device

`src/renderer/core/frame.ts`, `src/renderer/core/pass-desc.ts`, `tst/frame.test.ts`,
`tst/webgpu-render/cases.ts`.

Open item 5 wants `f.submit()` to return a completion handle, "since destruction during an in-flight
frame is a live hazard for room swaps". That is a claim, and the harness can settle it. A case
records a pass into a target, disposes the target, then submits:

```
validation:
Destroyed texture [Texture (unlabeled 64x64 px, TextureFormat::RGBA8Unorm)] used in a submit.
 - While calling [Queue].Submit([[CommandBuffer]])
```

**Real, and worse than a crash would be.** Dawn rejects the submit, so the frame's work is silently
gone; nothing throws in JS; the error arrives asynchronously through the error scope with no way back
to the pass that named the target. The renderer does recover, and the next frame draws correctly,
which is exactly what makes it a bug you find in a screenshot rather than a stack trace.

Adding the completion handle is a design decision and not mine to take, but making the failure
attributable is neither. Two checks, at the two points where the answer is knowable:

- **Opening a pass on a disposed target** throws in `resolvePassContext`, naming the attachment.
- **Disposing a target between its pass and the submit** throws in `submitFrame`, which is the room
  swap case. The frame records which render targets it encoded into, and clears that list on
  `beginFrame`, so the next frame is not still reporting the last one's casualty.

The message says what to do rather than only what happened: *abandon() the frame instead of disposing
mid-frame*. `abandon()` already exists and is the correct move; nothing pointed at it before.

**This lowers the pressure behind open item 5 rather than answering it.** A delete queue is for
deferring destruction you cannot otherwise time. Half of that need was really "the failure is
invisible", and that half is now a throw at the line that caused it. What a completion handle would
still buy is destroying *without* having to abandon, which is a real thing lib may want for room
swaps, and still a decision.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 474 tests across 54 files, 83/83 WebGL pixels, **22/22
WebGPU pixels**, 48/48 GLSL, 38 naga, 2/2 shake bundles.

---

## Layer 6.12 — open item 4 settled by its consumer, and the WebGL stub it exposed

`src/renderer/webgl/renderer.ts`, `tst/webgl-render/harness.ts`,
`lib/src/render/webgl.ts`.

Open item 4 asks whether the pre-warm should be one call taking drawables or two, and says to decide
against lib's actual load path. lib is ported now, so that is a reading rather than a judgement:
**one call.** `client.ts` awaits `renderer.prewarm()` once at the end of boot, and lib's WebGPU
prewarm builds a throwaway scene and calls `compile` once, wanting both phases. The two-call split
has no consumer.

**Reading the load path found something else.** lib's WebGL `prewarm` was `async () => {}` with a
comment: *"gpucat has no parallel-compile pre-warm for it yet, so the first frame still pays (~220ms
measured)."* And underneath it, `WebGLRenderer.compile` was also empty:

```ts
/** GL programs are cached by source, so there is nothing to warm ahead of the first draw. */
async compile(_drawables: Mesh[], _target: Target, _camera: View): Promise<void> {}
```

The comment is wrong, and lib had measured the number proving it. Caching by source saves the
*second* link, not the first, and the first is the 220 ms. A consumer awaiting this got a resolved
promise and no warming, which is `PLAN-backend-symmetry.md`'s own named anti-pattern: "A type can
force a method to be declared; it cannot force it to delete anything. three.js's `Backend.js:343` is
an empty stub for exactly this reason."

`WebGLRenderer.compile` now resolves the pass context exactly as a pass would, then prepares each
drawable with a `yieldToMain` between. It cannot overlap with anything, because WebGL2 has no async
link, and the doc comment says so rather than claiming a benefit it does not have: it moves the stall
off the first frame and onto the loading screen, which is where a consumer with a loading screen
wants it.

`compile-prewarm` in the pixel harness holds it: `programs 0 -> 1 after compile -> 1 after the draw`.
The second half of that is the part that matters, since a pre-warm that links and then re-links has
achieved nothing.

lib's no-op is now `prewarm: () => prewarm(state)`, mirroring its WebGPU twin.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 474 tests across 54 files, **84/84 WebGL pixels**,
22/22 WebGPU pixels, 48/48 GLSL, 38 naga, 2/2 shake bundles; lib's render layer typechecks clean and
its unit suite is unchanged at 1227 passing.

---

## Layer 6.13 — two selection questions, answered by measurement

`tst/init.test.ts`.

Open items 9 and 10 are about the backend-selection dance: should gpucat ship
`isSoftwareAdapter(adapter)`, and should `init` verify a device with a trial render. Both were parked
as judgement calls. Both have measurable halves.

**`forceFallbackAdapter: true` returns no adapter at all.** On Dawn/Metal the spec's own knob for
"give me the software one" yields `null`, so code written to use it as a *probe* concludes WebGPU is
unavailable rather than concluding it is software. `adapter.isFallbackAdapter` is not exposed either.
What is left is `adapter.info`, which here reads `apple / metal-3 / apple-m1-pro / "Metal driver on
macOS Version 26.5.1"` — real and useful, and entirely vendor-shaped.

**The WebGL side is worse.** A SwiftShader context reports `RENDERER: "WebKit WebGL"`, masked. The
real string needs `WEBGL_debug_renderer_info`, which browsers gate or remove, and only then says
`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0)), SwiftShader driver)`.

So a helper gpucat shipped would string-match vendor descriptions it cannot validate (no software
adapter is reachable from here to test against) on one backend, and depend on a deprecated,
masked-by-default extension on the other. **Item 9: leave it to consumers.** A guess dressed as an API
is worse than no API, because the consumer at least knows their own deployment.

**Item 10 falls to the consumer's actual shape.** lib picks a backend with `readRendererOverride() ??
(await webgpuAvailable())` and then does `try { createAndLoad('webgpu') } catch { createAndLoad('webgl') }`
— the three.js try/catch the plan recommends, already in place. A trial render would only catch a
driver that survives `requestDevice` *and* all of `init` and then fails the first draw, and lib's
first draw is already inside a path where a throw steps down. Costing every user a frame at init for
that is a bad trade.

**That fallback rests on one property nothing was checking: `init` has to reject, not resolve
something half-built.** Two tests now hold it, with `navigator.gpu` stubbed to return no adapter and
to be absent entirely. Both paths throw, both restore the real `navigator.gpu` in a `finally` so the
stub cannot leak into the rest of the suite.

The measurements went into the plan rather than a comment, because they are about the platform, not
about any line of gpucat.

Verified: src tsc 0, tst tsc 0, 476 tests across 54 files, 84/84 WebGL pixels, 22/22 WebGPU pixels,
48/48 GLSL, 38 naga, 2/2 shake bundles.

---

## Layer 6.14 — transform feedback gets a home, and the frame boundary it was missing

`src/renderer/webgl/renderer.ts`, `tst/webgl-render/harness.ts`.

Open item 6 says transform feedback "has no home in the plan" — an entire WebGL-only subsystem the
explicit-frame design never placed. Placing it turned up a gap rather than just a paragraph.

**Three entry points sit outside the frame, and two of them said so.** `readPixels()` refuses while a
frame is open ("reads stale pixels; submitFrame() first"). WebGPU's `compute()` refuses
("frame.compute() instead"). `transformFeedback()` refused nothing.

That is not a symmetry nit. WebGL2 has no encoder, so a TF kernel runs the instant it is called,
while the frame's passes encode at each `end()`. Call it between two passes and the kernel lands
*between* them rather than before them, which is exactly the hazard `compute()`'s guard exists for,
on the backend where it is harder to notice because nothing is deferred.

It refuses now, and the message says where the call belongs: before `frame()` or after `submit()`.

`tf-ordering` in the pixel harness runs the kernel before a frame, tries it mid-frame, and runs it
again after submit, asserting both that the middle call is refused and that the two outside it still
produce the doubled buffer. A guard that only proves it throws would pass just as well if the feature
were broken.

**State restoration was checked and is fine**, which is worth recording because it looked like the
likelier bug: `runTransformFeedback` brackets `RASTERIZER_DISCARD` and unbinds the TF object, and
although it leaves its own program bound, `beginPass` builds a fresh `GlStateCache` per pass, so the
next pass rebinds rather than trusting a stale memo.

Neither lib nor any example calls `transformFeedback` mid-frame, so nothing depended on the old
behaviour.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 476 tests across 54 files, **85/85 WebGL pixels**,
22/22 WebGPU pixels, 48/48 GLSL, 38 naga, 2/2 shake bundles.

---

## Layer 6.15 — the goblin pass the cycles never ran

Every cycle runs a comment pass over what it wrote. None ran one over what it *edited*, so the
pre-existing comments in the reshaped files were never held to the same standard. Searching for
comments naming mechanisms this refactor deleted found three that were actively wrong, not merely
verbose:

- **`RenderContextsState.contexts` documented a key format that has not been true since layer 1**:
  `` `{attachmentState}-{mrtId}-{callDepth}` ``. `callDepth` came out of the key in the keystone
  layer. It now points at `buildCacheKey` rather than restating a format that can drift again.
- **Two copies of "autoClear=false preserves prior contents so several viewport/scissor views can
  composite"**, explaining a `PassDesc.clear` in terms of the renderer property deleted in 4.38, and
  of the grid-of-previews workflow that property existed for. The mechanism is the same; the name in
  the comment was three layers stale.

The rest was the ordinary standard: `pass-context.ts` lost a nine-line file header listing its own
exports and a house-style note, and five blocks that restated their declaration's name
(`Create a new RenderContext with default values` above `createRenderContext`). What survived moved
into one line each: `RenderContext` is "what a backend turns into a `GPURenderPassDescriptor`, or into
framebuffer and GL state", `ComputeContext` is "a compute pass's identity, which is all a shared bind
group needs to be keyed by".

`webgl/prepare.ts`'s header described `WebGLRenderer.render()` handing itself to
`prepareRenderObjects` — two names that no longer exist. The knowledge worth keeping was never about
either: it is *which* work is once-per-object and which is per-draw, so that is now one line on the
function itself.

**I stopped at this plan's boundary.** There are 50 file headers of four or more lines across `src`,
and most are in files this work never touched; several carry real knowledge, like
`webgl/render-target.ts`'s account of the FBO strategy. Sweeping them all would be a large diff with
little signal and no way to verify the judgement calls, which is a different job from this one.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 476 tests across 54 files, 85/85 WebGL pixels, 22/22
WebGPU pixels, 48/48 GLSL, 38 naga, 2/2 shake bundles.

---

## Layer 6.16 — std430 layout, proven on a device rather than assumed

`tst/webgpu-render/cases.ts`, `case-names.mjs`.

The WebGL harness has about twenty `storage-*` cases and the WebGPU harness had none, for a reason
that sounds convincing and is not: WebGL *emulates* read-only storage through a texel grid, so its
lowering is obviously worth testing, while WebGPU binds a real storage buffer and is therefore
"fine". Every bug this refactor found lived somewhere that was assumed fine.

Layout is the specific risk. `naga` validates that the WGSL parses and type-checks; it cannot know
whether the bytes the CPU packer wrote line up with the offsets the shader reads. A disagreement
there is silent and reads as a content bug, which is exactly what
`reference_gpucat_wgsl_uniform_struct_align` records: natural alignment rather than std140, observed
rather than reasoned, and a black sky when it was wrong.

Two cases, both about offsets rather than about drawing:

- **`storage-mat4`** — `array<mat4x4f>` has a 64-byte stride with 16-byte columns, so element 1's
  column 3 sits at float 28. A stride the packer and the emitter disagree on reads a neighbour.
- **`storage-mixed-align`** — `{ scale: f32, tint: vec3f }`, which is the layout that bites: WGSL
  aligns `vec3f` to 16 and pads `scale` out to it, so a packer writing the two back to back puts
  `tint` where the shader expects padding.

Both agree, the second exactly. That is the point of running them: the answer was always going to be
"correct" or "silently wrong", and only one of those is distinguishable from not testing.

`storage-pad` was deliberately not ported. It sizes an array past `MAX_TEXTURE_SIZE` to force a
partial last row in the texel grid, which is a property of WebGL's emulation and has no WebGPU
counterpart. A parity case that cannot mean the same thing on both backends is not parity.

Verified: src tsc 0, tst tsc 0, 476 tests across 54 files, 85/85 WebGL pixels, **24/24 WebGPU
pixels**, 48/48 GLSL, 38 naga, 2/2 shake bundles.

---

## Layer 6.17 — the UBO layout that produced a black sky

`tst/webgpu-render/cases.ts`, `case-names.mjs`.

Layer 6.16 covered storage layout. Uniform layout is the same risk with a worse history: it is the
one `reference_gpucat_wgsl_uniform_struct_align` was written about, and lib carries two tests
(`sky-enabled-offset`, `sky-voxel-frame-layout`) that exist because a struct uniform's `enabled`
field was read at the wrong offset and the sky came out black.

Those lib tests compile WGSL and inspect the emitted offsets. Nothing checked that the bytes arrive
there.

`uniform-struct-align` uses lib's own shape, `{ enabled: u32, tint: vec3f }`: WGSL aligns `vec3f` to
16, so `enabled` is padded out to it, and a UBO packer writing the two back to back puts `tint` where
the shader expects padding. It reads `tint * enabled` and wants `[64, 128, 191]`. Exact.

**The case was checked for the failure it claims to detect**, which matters more here than usual,
because a test that reads only `tint` would pass whether or not `enabled` was found. Setting
`enabled: 0` turns the read black, so both the scalar at offset 0 and the vector at 16 are genuinely
being read — the same two offsets the sky bug got wrong.

Twenty-five cases. Between this and 6.16 the offsets a packer and an emitter have to agree on are now
checked on a device for both storage and uniform buffers, which is the one thing naga cannot do for
us: it validates that the WGSL is well-formed, never that the bytes line up with it.

Verified: src tsc 0, tst tsc 0, 476 tests across 54 files, 85/85 WebGL pixels, **25/25 WebGPU
pixels**, 48/48 GLSL, 38 naga, 2/2 shake bundles.

---

## Layer 6.18 — struct textures read zeros on WebGPU, and nobody would have noticed

`tst/webgpu-render/cases.ts` (case written, then reverted).

Porting the last member of the layout family — `struct-texture-unorm8x4`, which proves the CPU packer
and the shader agree that component 0 is the low bits — the case read `[0, 0, 0, 0]` on a real device.
Not a permutation, which is what a byte-order bug looks like. Nothing at all.

**What the narrowing established:**

- **Not the unpack.** Swapping the packed `unorm8x4` field for a plain `vec4f` reads zeros
  identically, so `unpack4x8unorm` is not involved.
- **Not the shader.** Compiling the same graph emits exactly what it should:
  `@group(0) @binding(0) var t0: texture_2d<u32>` and `textureLoad(t0, …)`.
- **Not texture binding in general.** `rtt` samples a render target's texture in the same harness and
  passes.
- **Not an obviously missing upload path.** `updateTextureBinding` calls `updateTexture`, which has a
  typed-array branch doing `device.queue.writeTexture` with a plausible layout, and the texture's
  source is populated (`rgba32uint`, 1x1, a typed array behind the wrapper).
- **The failure mode is silent by construction.** `bindings.ts` skips the entry entirely when
  `getTextureData` returns nothing, so a texture that never uploaded produces a bind group missing
  that entry rather than an error.

**Nothing consumes this.** Neither lib nor any example calls `createStructTexture`; the only user is
the WebGL harness, with eight cases, all passing. That is why a whole feature can be broken on one
backend without a single symptom: the tests that cover it only ever ran on the backend where it
works.

I stopped rather than guess. The remaining candidates need instrumenting the upload path, and
changing texture upload on a hunch to make one case go green is how a real bug gets buried under a
plausible-looking fix.

The case is **reverted**, because a harness with a known-failing case teaches everyone to ignore it.
The repro is four lines and is written down above.

Verified: src tsc 0, tst tsc 0, 476 tests across 54 files, 85/85 WebGL pixels, 25/25 WebGPU pixels,
48/48 GLSL, 38 naga, 2/2 shake bundles.

---

## Layer 6.19 — 6.18 was wrong: struct textures work, my geometry was missing `uv`

`tst/webgpu-render/cases.ts`, `case-names.mjs`.

Last layer reported struct textures as broken on WebGPU and filed it as open item 0. **That was
wrong**, and the way it was wrong is worth more than the case it blocked.

Instrumenting the run rather than reading around it took three steps:

1. The texture **was** in the cache after the draw (`rgba32uint`, generation 1), so it uploaded.
2. The submit was `[Invalid CommandBuffer] ... due to a previous error` — the pass never ran at all,
   which is why the clear's alpha of 1 never appeared either. That detail was visible in 6.18's own
   output (`[0, 0, 0, 0]`, not `[0, 0, 0, 255]`) and I read past it.
3. The first error, once an error scope was pushed around the frame and the process was given a tick
   to drain it:

```
Vertex attribute slot 0 used in ([ShaderModule], [EntryPoint "vs_main"]) is not present in the VertexState.
```

Not a texture error. Dumping the compiled attributes for both graphs put it beyond doubt: with the
struct texture, location 0 is **`uv`**, not `position`. `texture()` defaults its coordinate to
`varying(uv())` — the same default that broke `fullscreen()` in layer 4.2 — so any graph touching a
texture needs a `uv` attribute even when it only ever calls `load()`, which uses no coordinate at all.

The WebGL harness never hit this because its `createFullscreenTriangleGeometry` carries position
**and** uv, a change made in 4.2 for exactly this reason. My WebGPU harness geometry carried only
position. Adding `uv` makes the case read `[64, 128, 192, 255]` with no validation error.

**The false conclusion came from stopping at the right time for the wrong reason.** Declining to
guess at a fix was correct. Announcing a diagnosis anyway was not: "struct textures read zeros on
WebGPU" is a claim about gpucat, and what I actually had was one failing case in a harness I wrote
that morning. The evidence supported "my case fails and I do not know why", and that is what should
have gone in the plan.

Twenty-six cases. Open item 0 is deleted rather than struck through, because it never existed.

What survives as a real observation: `load()` indexes by element and reads no coordinate, yet drags
in the default uv varying and so imposes a vertex-input requirement nothing in the call suggests. It
is a wrinkle in the node DSL rather than a bug, and it is now written where the next person will meet
it, on the harness geometry that has to satisfy it.

Verified: src tsc 0, tst tsc 0, 476 tests across 54 files, 85/85 WebGL pixels, **26/26 WebGPU
pixels**, 48/48 GLSL, 38 naga, 2/2 shake bundles.

---

## Layer 6.20 — a load reads no coordinate, so it should not ask for one

`src/nodes/graph.ts`, `tst/webgpu-render/cases.ts`,
`tst/__snapshots__/struct-texture-decode-golden.test.ts.snap`.

Layer 6.19 ended with the wrinkle written down on the harness geometry that had to satisfy it:
`texture(t).load(schema, i)` indexes by element and reads no coordinate, yet the geometry owed a `uv`
attribute anyway. Documenting a trap is worse than removing one when removing it is three lines.

`TextureNode` builds its coordinate eagerly — `this.uvNode = uvNode ?? varying(uv())` — and graph
discovery pushed `uvNode` as a child unconditionally, for all three texture kinds. So a load-only
graph collected the default uv varying, which took vertex location 0, which displaced `position`,
which produced `Vertex attribute slot 0 ... is not present in the VertexState` and a pipeline that
was invalid before it drew anything.

Both emitters already branch on `samplingMode === 'load'` and return before touching `uvNode`.
Discovery now agrees with them.

**The proof is the thing that misled me.** The harness geometry grew a `uv` buffer in 6.19 to make
the case pass; it is position-only again and the case still reads `[64, 128, 192, 255]`. Every case
that genuinely samples still passes, on both backends.

**One golden snapshot moved, deliberately.** The struct-texture decode GLSL no longer declares
`layout(location = 0) in vec2 a_uv` or the varying that carried it, and `a_position` takes location 0.
The plan holds the goldens byte-identical *through the frame work* as evidence that neither the graph
nor either emitter was involved; this is a graph change made on purpose, and the diff is exactly the
attribute that was never read. Updated, with the whole diff checked rather than the count.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 476 tests across 54 files, 85/85 WebGL pixels, 26/26
WebGPU pixels, 48/48 GLSL, 38 naga, 2/2 shake bundles; lib's render layer typechecks clean against
the rebuilt dist and its unit suite is unchanged at 1227 passing.

---

## Layer 6.21 — the target belongs to `init`, not to the backend factory

`src/renderer/core/init.ts`, `src/renderer/webgl/backend.ts`, `src/renderer/webgpu/backend.ts`,
`src/renderer/webgl/renderer.ts`, `src/index.ts`, `tst/init.test.ts`, `tst/webgl-render/harness.ts`,
eleven `examples/src/example-webgl-*.ts`.

`init({ backend: webgl({ target: view }) })` read wrong and was wrong. A target is not device config;
it is the thing being drawn to, and burying it one level down said the opposite. It now reads
`init({ backend: webgl(), target: view })`.

The reason it was on the factory was type safety, and that reason survives without the nesting. Two
overloads on `init` carry it instead: `Backend<R, undefined>` takes no target, `Backend<R, CanvasTarget>`
requires one. Omitting a WebGL target and supplying a WebGPU one are both compile errors, which is
where they were before, only now the call site is the shape a reader expects.

**What the asymmetry actually is.** It is not an artifact of the WebGL/WebGPU renderer split; the
split only stopped hiding it. `WebGLRenderer.init` calls `createContext(this.target.canvas, …)` — a
WebGL2 device *is* a canvas's context, and the canvas's `samples` and `depthFormat` become immutable
context attributes. `WebGPURenderer.init` calls `requestAdapter()` and never sees a canvas; passes
configure their own. So on WebGL the first CanvasTarget is the device descriptor, and the overloads
state that rather than papering over it.

**A name was lying about this.** `WebGLBackendOptions` contained `target`, and the public `webgl()`
factory took `Omit<…, 'target'>` of it. Two things with one name. Split: `WebGLRendererOptions` is the
constructor's (target included), `WebGLBackendOptions` is `Omit<WebGLRendererOptions, 'target'>` and is
what `webgl()` takes. `WebGPUBackendOptions` needed no split — there the two coincide.

**The compile-time guarantee is now a test.** `tst/init.test.ts` pins all three shapes with
`@ts-expect-error`, so tst's tsc fails if the overloads are ever collapsed to a single optional
`target`. The knowledge moved out of a comment and into something that breaks.

**Still open, and it is the real question.** `WebGLRenderer.target` is one field set in the
constructor, so WebGL is single-canvas for its whole life and `frame.pass({ target: otherCanvas })`
is a lie waiting to happen on that backend. The overloads make the boot honest; they do nothing about
this. Fixing it means giving WebGL a renderer-owned offscreen canvas and blitting per target, at a
real per-frame cost. Recorded, not chased.

**Resolved the next layer.** 6.22 gave `FrameBackend` a `deviceCanvasTarget` and made
`openRenderPass` throw on any other canvas, so the lie is a compile-time-shaped error instead. The
blit was rejected in favour of one pass per viewport on the device canvas, which is what three does
too.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 477 tests across 54 files, 85/85 WebGL pixels, 26/26
WebGPU pixels, 48/48 GLSL, 38 naga, 2/2 shake bundles, biome clean on the seventeen touched files.
lib names neither renamed type and constructs `WebGLRenderer` directly, so it is untouched.

---

## Layer 6.22 — a pass names a canvas the device cannot present to, and is told so

`src/renderer/core/frame.ts`, `src/renderer/webgl/frame-backend.ts`,
`src/renderer/webgpu/frame-backend.ts`, `tst/frame.test.ts`, `tst/webgl-render/harness.ts`.

6.21 left `WebGLRenderer.target` as one constructor-set field while `frame.pass({ target })` accepts
any canvas, so a second canvas drew to the first and said nothing. `FrameBackend` now carries
`deviceCanvasTarget`: the one canvas that backend's device can present to, or `null` when any is
reachable. WebGL supplies its own; WebGPU supplies `null`, which is the truth rather than a stub,
since it acquires a context per canvas target. `openRenderPass` checks it and throws.

**It is a `FrameBackend` field, not a `frame.backend.name === 'webgl'` test**, even though the
compute-pass refusal right above it is exactly that test. The difference is that this check needs the
canvas, which core has no other route to, and the field states the constraint where a reader meets it.

**Three answers were considered and two were rejected on what the APIs actually do.** A renderer-owned
offscreen context with a per-target blit is the only way to get N canvases from one WebGL2 context,
and it charges a full-surface copy every frame. A renderer per canvas costs resource sharing. Both
lose to the thing people actually want, which is N *views*: one canvas, one pass per viewport, already
supported on both backends through `PassDesc.viewport`/`scissor` and already covered by the
`viewport-scissor` case on both harnesses.

**three.js was read rather than assumed, and it does not solve this.** `Renderer.setCanvasTarget`
(`Renderer.js:2780`) swaps one active canvas between renders, with no per-pass target at all. Its
WebGPU backend does what gpucat does, `getContext('webgpu')` per canvas target cached by target
(`WebGPUBackend.js:347`). Its WebGL fallback reads `renderer.domElement.getContext('webgl2', …)` once
at init (`WebGLBackend.js:230`), so a later `setCanvasTarget` leaves the context on the first canvas
and nothing blits. The hazard exists upstream, silently. `webgl_multiple_views.html:268` is three's
own answer to the real use case, and it is a viewport per view on one canvas.

**`init` still creates no canvas, and should not.** three's `Backend.getDomElement` manufactures one
via `createCanvasElement()` when you pass none, which it can only do because `render(scene, camera)`
names no target and the canvas then has to come back out as `renderer.domElement` — ambient target
state under another name. gpucat's passes name their target, so an invented canvas has no recipient,
and `init` touching the DOM would break the headless path the WebGPU harness runs on.

Two tests, because they fail for different reasons. `tst/frame.test.ts` pins the core logic with a
stub backend: a foreign canvas throws, the device canvas and a `RenderTarget` still encode, so the
refusal costs the frame nothing. `foreign-canvas` in the WebGL harness pins it against a real context.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 478 tests across 54 files, 86/86 WebGL pixels, 26/26
WebGPU pixels, 48/48 GLSL, 38 naga, 2/2 shake bundles, biome clean on the five touched files.

---

## Layer 6.23 — the struct-texture decode family, on a real device

`tst/webgpu-render/cases.ts`, `tst/webgpu-render/case-names.mjs`.

`struct-texture-unorm8x4` was the only packed decode with a WebGPU case. Its four siblings are ported:
`snorm8x4`, `half2x16`, `mat4` and `bits`. 26 cases to 30.

**None of them found a bug, and that is the expected outcome rather than a disappointment.** The
plan's own note from 6.17 is that ported-clean cases find nothing and are worth porting anyway,
because a green parity case turns an assumption into a fact. What is now a fact is that the CPU
packer and WGSL agree on every packed field kind gpucat has, not just the one.

**What each one is for is in `note`, not in a comment above it.** The harness prints the note beside
the pixels, so the reason the case exists is on screen when it fails, which is when someone needs it.
`-1` is the byte that separates a real sign-extend from a mask, since an unsigned read gives `+1` and
a plausible colour. `half2x16` and `unorm2x16` in one texel are silent when the halves swap, and
fp16-exact values rule out rounding as the explanation. `m * (1,0,0,0)` selects column 0, so decoding
four texels as rows stays in range. `bits` is the only member of the family that lowers to shift and
mask on both backends rather than to a builtin, so it is the one where the emitters can drift.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 478 tests across 54 files, 86/86 WebGL pixels,
**30/30 WebGPU pixels**, biome clean on the two touched files.

---

## Layer 6.24 — the depth family's two remaining WebGL-only cases, on a real device

`tst/webgpu-render/cases.ts`, `tst/webgpu-render/case-names.mjs`. 30 cases to 32.

`clear-depth` (6.16) found a real WebGPU bug because two depth paths hardcoded `1.0` and reused the
colour load op. Its two siblings were still WebGL-only, so they are ported.

**`clear-selective`** is the empty pass as a clear, which is the whole reason `renderer.clear()` could
be deleted. Its shape is the part worth keeping: a depth-only clear that preserves colour looks
*identical* to a clear that never ran, so a second empty pass clearing colour follows and must change
the pixel. One reading proves nothing; two readings pin both load ops.

**`depth-load-read`** samples a `count: 0` depth-only render target directly, rather than through a
`PassNode` as `pass-depth-sample` does. Colourless targets are exactly where the `clearDepth` bug
lived, and nothing on WebGPU covered one. `top=51 bottom=204` on the first run: the depth read
returns real depth, and row 0 is the near end, so the readback orientation agrees with the WebGL
harness even though GL reads bottom-up and WebGPU reads top-down.

Both green on the first run. That leaves `depth-bias` and `pass-occlude` as the family's remaining
WebGL-only cases.

**No comments were written this cycle.** Each case's reason to exist went into `note`, which the
harness prints beside the pixels, so it is on screen when the case fails. That is where it earns its
keep, and a doc block above the function is not.

Verified: src tsc 0, tst tsc 0, 478 tests across 54 files, **32/32 WebGPU pixels**, biome clean on
the two touched files.

---

## Layer 6.25 — the harness was throwing away Dawn's diagnosis

`src/renderer/webgpu/frame-backend.ts`, `src/renderer/webgpu/renderer.ts`,
`tst/webgpu-render/{cases.ts,case-names.mjs,run.mjs}`, `tst/webgl-render/harness.ts`.

Porting `depth-bias` and `pass-occlude` cost five rounds of probing, and four of them were wasted on
a harness defect rather than on the bug.

**`popErrorScope().then(console.error)` is fire-and-forget.** An error scope resolves after the pass
that opened it, so when a case finished and the process exited, Dawn's explanation went with it.
`pass-occlude` therefore looked like wrong pixels with no reason, and the first diagnosis written down
here — "two pass nodes in one composite graph return zeros from both" — was **wrong**. It survived
only because nothing was contradicting it. The error appeared the moment an unrelated `read()` kept
the process alive a few microtasks longer.

`WebGPURenderer.takeValidationErrors()` awaits every open scope and drains what they reported;
`runCase` calls it and fails the case with the message. The message now names the pass, which is how
`_pass1` identified the culprit in one run. A gate that can silently discard the reason a case failed
is worse than no gate, because it spends the reader's time instead of saving it.

**The real bug, once it could be read.** `graph.ts` walks a `PassNode` to
`node.getTextureNode()` — the pass's *canonical* texture node, which is in `'sample'` mode and carries
the default `varying(uv())`. A consumer that only ever calls `.load()` still drags that uv in, so the
consuming mesh's geometry owes a `uv` attribute it never declared, and the uv takes vertex location 0
and displaces `position`. It is layer 6.20's bug one level up: 6.20 fixed the walk *through* a texture
node, and this is the walk *to* one. It only bites when a pass is sampled from inside another pass's
scene, because `fullscreen()` supplies a uv and every existing case composites through it.

**Two cases are tracked rather than deleted.** `KNOWN_FAILURES` in the pixel runner is the naga gate's
pattern: listed cases may fail, and the runner **fails if a listed one starts passing**, so the set
cannot rot. `pass-occlude` and the 40-line `chained-pass-nodes` reduction both stay executable, which
is worth more than a paragraph describing how to rebuild them. The summary line counts them out rather
than claiming they matched.

**Three reductions proved what it is not**, and all three stay as cases: `two-pass-nodes` (two passes
in one composite, green), `pass-colour-and-depth` (one pass, colour and depth both sampled for real,
green), `chained-pass-nodes` (a pass sampling a pass, red). Only the third fails, which is what named
the ingredient.

**`depth-bias` was vacuous on both backends and is now real.** It used `depthCompare: 'less-equal'` on
two coplanar quads, so the second won whether or not the bias moved it. It is `'less'` now, and both
quads sit at z 0.5 rather than the fullscreen triangle's 0, because a negative bias at 0 clamps away
and reads as an ignored bias. Mutation-checked: `depthBias: 0` turns the WebGL case red, `-2` green.
A `depth:` override would defeat it entirely, since a shader-written `frag_depth` replaces the biased
value, so the case uses interpolated z and says so.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 478 tests across 54 files, 86/86 WebGL pixels,
**35/35 WebGPU pixels with 2 tracked**, biome clean on the six touched files.

---

## Layer 6.26 — a pass output is screen-space, so it reads by screen position

`src/nodes/lib/display/pass-node.ts`, `tst/webgpu-render/{cases.ts,case-names.mjs,run.mjs}`.
38 cases, none tracked.

A `TextureNode` defaults to `varying(uv())`, and `PassNode.getTextureNode()` took that default. So any
mesh consuming a pass owed a `uv` attribute, the uv took vertex location 0, and `position` was pushed
to 1 — `Vertex attribute slot 0 ... is not present in the VertexState`, a pipeline invalid before it
drew. Three call sites now set `uvNode = screenUV` instead: the colour node, the previous-frame node
and the depth node.

**The fix is a semantic correction, not a workaround.** A pass fills its whole target, so reading it
by the consuming mesh's `uv` is only meaningful when that mesh is a fullscreen quad, where uv and
screen position coincide — which is why every existing case composited through `fullscreen()` and
nothing caught this. Sampling by screen position is what a pass read always meant.

**Two edges were conflated, and understanding that is what found the one-line fix.** `getChildren`
reaches a `PassNode` two ways: as a *value* (`renderOutput(scenePass)`, used by two examples, where the
emitter delegates to the canonical texture node and genuinely needs a coordinate) and as an *ordering*
edge (`TextureBinding.passSource`, where the consumer owns its own node and the canonical one is pure
overhead). The first designs considered were a parent-aware walker and a childless ordering node,
both of which add machinery to keep the wrong default working. Changing the default served both edges
at once.

**The value edge was pinned before it was touched.** `pass-as-value` composites
`renderOutput(pass(scene, camera))` with no `.getTextureNode()`, green before the change and after.
Without it the fix would have rested on two examples that no gate runs.

**`KNOWN_FAILURES` forced its own pruning one layer after it was built.** Both tracked cases went
green and the runner refused to pass until they were removed from the set, which is the whole point
of failing on a listed case that starts working. The set is empty again.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 478 tests across 54 files, 86/86 WebGL pixels,
**38/38 WebGPU pixels with none tracked**, 48/48 GLSL, 38 naga, 2/2 shake bundles, biome clean on the
four touched files. The GLSL and WGSL goldens are byte-identical: none of them composites a pass.

---

## Layer 6.27 — a design for `Renderer` and backend, written from measurement

`PLAN-renderer-backend.md` (new). No source touched.

The expectation was three.js's shape: a concrete `Renderer` fronting pluggable backends. gpucat has a
`Renderer` *interface* and two concrete classes, with the polymorphism at the `FrameBackend` seam
rather than a renderer seam. The design weighs three options against what the code measures.

**The duplication is 60 lines, not 1000.** `setInspector` and `frame()` are identical (~12 lines);
`compile()` and `_beginInfoFrame()` share a skeleton with genuinely different middles (~50); `init`,
`dispose`, `readPixels`, `hasFeature` and `compileCompute` are genuinely different; and each backend
has five or three methods with no counterpart at all. The 986 lines across the two classes are mostly
device lifecycle with nothing to share. Writing the number down changed the recommendation.

**"Backend" already means three things**, which is the finding worth keeping whatever is decided:
`Backend<R, DeviceTarget>` is the init factory, `BackendState` is WebGPU's device handles plus caches
with **no WebGL counterpart**, and `FrameBackend` is the six-method frame vtable. Adding a fourth
meaning is the worst outcome available.

**Recommendation: extract the shared skeletons now, take the concrete class only if a third backend is
real.** The prize in a fronting class is the *contract* — three's `Backend` ABC is ~80 methods, and
that list is exactly the checklist the cross-backend symmetry plan was keeping by hand. A contract
earns its keep when something new has to satisfy it. Against two backends it costs days, puts the
tree-shake gate at risk, and turns `gpu.device` into `gpu.backend.device`.

**The counter-argument is recorded rather than buried**: if the goal is conceptual — one name, one
object, a written-down definition of what a backend is — the extraction will never provide it and the
concrete class is the honest way to get it. That is a legitimate reason to choose it, and the design
says to choose it for that reason rather than for the duplication.

Two facts that cost the least to check and mattered most: lib reaches escape hatches in **two places**
(`render/webgl.ts` reads `.gl`, `render/webgpu.ts` reads `.device`), so that churn is cheap; and the
`Renderer` interface puts `info` on the contract on purpose, so a backend that does not feed it is a
compile error, which a concrete class with optional hooks would lose.

Verified: no source changed; 478 tests across 54 files still pass.

---

## Layer 6.28 — the split designed, after starting it the wrong way round

`PLAN-renderer-backend.md` part 2, `src/renderer/core/{device-backend.ts,renderer.ts}`,
`src/renderer/core/renderer-ops.ts`.

Option B was chosen on two arguments that beat the duplication measurement: **`init` has no purpose
otherwise** — if it returns `WebGPURenderer`, it is `new WebGPURenderer(opts).init()` with ceremony,
and the plainer spelling would be better — and **a shared orchestration layer forces alignment where a
convention does not**, which is what the cross-backend symmetry audits were doing by hand.

**Then I went straight to editing, and flip-flopped on state ownership mid-file.** Having the backend
alias the renderer's `_nodes`/`_renderObjects` costs no churn and was briefly attractive, but it
leaves the backend satisfying `RendererState` and still looking like a renderer, which is precisely
the discipline the fronting class was chosen for. Reaching for it a paragraph after rejecting it was
the signal that there was no design yet.

Part 2 is that design: what moves, where the reads are, and six questions with the options for each.
The ones worth carrying out of it:

**The fields split cleanly; the *reads* are the cost.** Eleven neutral fields, and no field is
ambiguous. But inside the two `frame-backend.ts` files the two kinds interleave — WebGPU 24 neutral
against 19 device, WebGL 17 against 19. Two reads matter beyond their count: `usable(s)` guards on
`_isDeviceLost` **and** the device in one expression, and `r._beginInfoFrame()` is the frame backend
calling back into orchestration.

**A construction-order constraint that would have been found mid-edit.** `createBufferCache(info)`
*stores* the `RendererInfo` for push-style upload accounting, so caches cannot be built before the
object owning `info`. They move into `backend.init(renderer)`, where a device is needed anyway.

**`Renderer.backend` is the object and `renderer.api` is the string.** A new name, not a reuse, so
`renderer.backend === 'webgpu'` cannot silently keep compiling against the object.

**The risk is named rather than discovered**: the read tables are a grep, not a proof, and anything
reaching neutral state through a helper will only surface at migration step 3.

Step 1 of seven has landed: `DeviceBackend` (extending `FrameBackend`, so the frame path is
unchanged), the `Renderer<B>` class, and `compileTargets` in `renderer-ops.ts`. All additive, nothing
constructs a `Renderer` yet. `Renderer.inspector` is a plain field rather than the attaching accessor,
because attaching needs the inspector to accept a `Renderer` and that is step 6; a missing behaviour
is honest where a half-wired one is not.

Verified: src tsc 0, 478 tests across 54 files, biome clean on the three touched files.

---

## Layer 6.29 — migration step 2: the frame backends split their one `r` in two

`src/renderer/webgpu/frame-backend.ts`, `src/renderer/webgl/frame-backend.ts`.

`FrameBackendState.r` becomes `renderer` (neutral) and `backend` (device). Both fields are assigned
the same object at this step, because the existing class is still both, so **this step cannot change
behaviour** — it only records which half of the renderer each read wanted. Step 3 then changes two
types instead of eighty call sites.

**`r` was deleted rather than deprecated, so a misclassified read is a compile error.** That caught
one immediately: `setNodeFrame` does `frame.renderer = s.r`, and a node reaches `_frameState` through
it, so it is the renderer and not the backend. That is exactly the "read through a helper" the design
named as the risk the grep could not see, and it appeared in the first file.

**Three classifications the grep would have got wrong, found by reading:**
`Prepare.prepareRenderObject(r, …)` and `RenderPass.resolveAttachments(r, …)` take `BackendState`, so
their `r` is the device; `prepareRecordedDraws(r, …)` takes `RendererState`, so its `r` is the
renderer. Three adjacent calls, three different answers, all spelled `r`.

**WebGL's `encodePass` turned out to read no device state at all** — every device touch is inside
`encodeOpenPass` — so its destructure is `{ renderer }` alone. The split is what made that visible;
it was invisible while both halves shared a name.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 478 tests across 54 files, 86/86 WebGL pixels, 38/38
WebGPU pixels, biome clean on the two touched files. No `r.` remains in either file.

---

## Layer 6.30 — migration steps 3-6: the fronting `Renderer` is real

`src/renderer/core/{renderer.ts,device-backend.ts,init.ts,compile.ts,renderer-interface.ts,node-frame.ts}`,
`src/renderer/webgpu/{webgpu-backend.ts,backend.ts,frame-backend.ts,read-pixels.ts}`,
`src/renderer/webgl/{renderer.ts,backend.ts,frame-backend.ts}`, `src/inspector/*`, `src/index.ts`,
`src/camera/cube-camera.ts`, tst, examples, and lib's render layer.

`init({ backend: webgpu() })` returns a `Renderer<WebGPUBackend>`. The two 500-line concrete renderers
are now `WebGPUBackend` (465 lines to 282) and `WebGLBackend`, holding device state only; the node
graph, render lists, render objects, pass contexts, inspector and `info` live on the one `Renderer`.

**The `Renderer` interface is gone, because the class took its name.** `renderer-interface.ts` is four
lines now: just `RendererBackend`. Anything that held the interface — `NodeFrame.renderer`,
`CubeCamera.update`, `init`'s constraint — holds the class.

**`api` had to be `B['name']`, not `RendererBackend`.** The inspector narrows with
`renderer.api === 'webgl'` over `Renderer<WebGPUBackend> | Renderer<WebGLBackend>`, and a getter typed
as the union discriminates nothing. Typing it off the backend makes each instantiation's `api` a
literal, so the union is a discriminated one and `renderer.backend.gl` type-checks inside the branch.

**The string discriminant rename was caught by tests, not by tsc** — exactly as the design predicted
it would have to be. `expect(gpu.backend).toBe('webgpu')` still compiles happily against an object,
because `toBe` takes anything; two tests failed and named it. That is why `api` is a new name and not
a reuse.

**The tree-shake gate was the named risk, and it holds.** `Renderer` imports no backend — the factory
does — so a one-backend bundle still drops the other. 2/2.

**Two questions the refactor forced, both answered by the code rather than by preference.**
`compileCompute(gpu, nodes)` is a free function over a structural `CompilableGpu`, and only a backend
has `compileCompute`; `CompilableGpu` now reads `{ compile(…); backend: { compileCompute(…) } }`, which
keeps every call site spelled `compileCompute(renderer, node)`. And lib already had its own `Renderer`
type, so gpucat's imports there as `GpuRenderer` — a collision worth knowing about before it was hit.

**The three tiers of compute are now visible, and one of them contradicts the design.**
`frame.compute()` is on the neutral `Frame` and throws for WebGL; `backend.compute(entries)` and
`backend.transformFeedback(…)` are device batches outside a frame. The design said backend-only work
stays on the backend, but `frame.compute()` already broke that before this layer started. The rule
that actually holds is **in-frame work is neutral, out-of-frame device batches belong to the backend**,
and it is written down here rather than left accidental.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 478 tests across 54 files, 86/86 WebGL pixels, 38/38
WebGPU pixels, 48/48 GLSL, 38 naga, 2/2 shake bundles, biome clean on every touched file. lib's render
layer typechecks and its `overlay-probe` headless case passes; 18 lib failures remain in
`block-hooks`, `block-variants` and `voxel-client-light-origin`, two of which never mention a renderer
at all, so they look pre-existing rather than caused here — worth confirming before trusting that.

---

## Layer 6.31 — step 7: the names stop lying, and two gates catch the rename

`src/renderer/webgl/webgl-backend.ts` (from `renderer.ts`), `src/renderer/webgl/backend.ts`,
`src/renderer/core/{init.ts,renderer.ts}`, `src/renderer/webgpu/webgpu-backend.ts`, `src/index.ts`,
`PLAN-explicit-frame.md`, tst.

`webgl/renderer.ts` held `WebGLBackend`, and `Backend` in `init.ts` meant "factory" while
`DeviceBackend` meant "backend". Both fixed: the file is `webgl-backend.ts`, mirroring
`webgpu-backend.ts`, and `Backend<R, T>` is `BackendFactory<R, T>`. Each position now has one word.

**The options split got a name instead of an `Omit` with no meaning.** `WebGLBackendOptions` is what
the backend takes (target included, mirroring `WebGPUBackendOptions`); `WebGLContextOptions` is
`Omit<…, 'target'>`, which is what `webgl()` takes, and the name says what they are — `getContext`
attributes.

**Two gates caught the rename, and neither was tsc.** `plan-refs` failed because the plan still said
`Backend`; `public-api` failed because `DeviceLostInfo` was re-exported from both backend files, and
moving it to `renderer-ops` then dragged five genuinely internal names into the surface scan. Its home
is the renderer, whose `onDeviceLost` is the public face of it, so that is where it is exported from.
The ratchet made the wrong home visible in one run.

**The comment goblin pass found stale framing, not restatement.** The WebGL file's header described
`renderer.ts`, `WebGPURenderer`'s structure, satisfying `RendererState`, and `render()` binding the
default framebuffer — four things that are no longer true, in a block that had survived because nobody
re-read it. Deleted. Three method docs claimed "WebGLRenderer-only"; what they were carrying was the
WebGPU *alternative* (a `compute()` kernel over the same body `Fn`), which is one line and is the part
worth keeping. `dispose`'s nine-line note about not calling `loseContext()` is real knowledge and is
three lines now.

**The refactor immediately paid once, unprompted.** Both backends had the same two guards at the top
of `readPixels` — frame-open and initialised. With one orchestrator they belong to it, so
`Renderer.readPixels` owns them and both backends lost their copy. The error text moved with them and
got more honest: it said `submitFrame() first`, which is the backend's method, where a caller has
`frame.submit()`. Two tests asserted the old wording and were updated to the true one.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 478 tests across 54 files, 86/86 WebGL pixels, 38/38
WebGPU pixels, 48/48 GLSL, 38 naga, 2/2 shake bundles, biome clean on the seven touched files.

---

## Layer 6.32 — the two invariants the refactor rests on, as tests

`tst/renderer-backend-boundary.test.ts` (new). 55 files, 480 tests.

The fronting `Renderer` was chosen to force alignment. Two properties make that true, and both were
holding by accident rather than by anything that would notice them breaking.

**`src/renderer/core/*` imports no backend module.** This is what lets a one-backend bundle drop the
other, and `test:shake` only observes it from the far end, after a rollup build. The test reads every
core file's import and export specifiers through the TS parser and fails on any `webgl/` or `webgpu/`
path, so the property is checked where it is created rather than where it is felt.

**Neither backend declares a field the renderer owns.** This is the one I nearly broke: having the
backend alias `_nodes`, `_renderObjects` and the rest costs no churn and was briefly the plan, and it
would have left the backend still looking like a renderer with the discipline gone. Now a backend
declaring any of the eleven neutral names is a test failure with the name in it.

**Both were mutation-checked rather than trusted.** Adding `_nodes` to `WebGPUBackend` fails the
second; adding a `webgpu-backend` import to `core/renderer.ts` fails the first. A guard that has never
been seen to fail is a guard nobody has tested.

Verified: src tsc 0, tst tsc 0, 480 tests across 55 files, biome clean on the new file. The export
gates and `plan-refs` still pass, so the new test adds no public surface.

---

## Layer 6.33 — the plan re-read against the code it now describes wrongly, plus cube mips

`PLAN-explicit-frame.md`, `tst/webgpu-render/{cases.ts,case-names.mjs}`. 39 WebGPU cases.

The `Renderer` rebuild invalidated a dozen claims in the plan, and `plan-refs` cannot see any of them:
it checks that the **API listing** names only exported types, so prose is unguarded. Fifteen mentions
of the retired class names, split three ways.

**Eight were live claims and are corrected**: `init` returns `Promise<Renderer<WebGPUBackend>>` rather
than the concrete class, the caller branches on `gpu.api`, `Renderer.frame()` hands out the reusable
frame whichever backend is underneath, `InspectableRenderer` is the union of two `Renderer<B>` with
every reach going through `renderer.backend`, `WebGLBackend.target` is the single-canvas field, and
lib constructs `new Renderer(new WebGPUBackend(opts))`.

**Three were never true.** `WebGPURendererOptions` has no referent and never had one — the type is
`WebGPUBackendOptions`. It survived three mentions because nothing reads plan prose. The `headless`
flag it claimed "already exists" does not exist either; headless is the ordinary case of never
constructing a canvas target, which is what the reshape was for, so that paragraph now says **Done**.

**Three are correct as they stand**: `WebGPURenderer.js` is three.js's file, and two are layer records
describing what a thing was called when that layer ran.

**`cube-mips` ported, green first run.** It is the one case whose WebGL form carries a workaround that
does not translate: WebGL flips `generateMipmaps` off until the sixth face so `generateMipmap(CUBE)`
runs exactly once. On WebGPU `submitFrame` collects the frame's mip targets and flushes them after the
submit, so six faces in one frame is the whole of it. Porting the *behaviour* rather than the code is
what made that visible.

Verified: src tsc 0, tst tsc 0, 480 tests across 55 files, **39/39 WebGPU pixels**, biome clean on the
two touched files.

---

## Layer 6.34 — vertex layout on a real device: an asserted claim becomes a tested one

`tst/webgpu-render/{cases.ts,case-names.mjs}`. 39 cases to 41.

**`interleaved-attrs` existed only to prove the GLSL emitter's bug was fixed**, and its own doc
asserted the other backend was fine: *"the WGSL path, which always kept them distinct."* That is the
shape of claim this porting exercise exists to convert. Two `vec4f` attributes share one buffer at
offsets 0 and 16, each carrying a distinct probe in `.w`; deduplicating by name alone collapses both to
offset 0 and the green channel takes the red one's value. WebGPU reads `[153, 204, 0, 255]`, the
distinct pair, so the claim is now a fact rather than a sentence.

**`instanced` covers the step mode**, which is the same idea one level up: a per-instance attribute
with `stride: 12` read once per instance rather than once per vertex. Two instances of a fullscreen
triangle with depth off, so the second wins everywhere; an attribute advancing per vertex would leave
instance 0's red.

Both green first run. That is now four families ported with nothing found (`struct-texture`,
`storage` layout, vertex layout) against three families that found real bugs (`clear-depth`,
`dispose-releases`, `pass-occlude`). The ones that find bugs are the ones touching a *path* only one
backend had — a target kind, a lifecycle hook, a graph walk — rather than a shared encoder or packer.
Worth knowing when choosing what to port next.

Verified: src tsc 0, tst tsc 0, 480 tests across 55 files, **41/41 WebGPU pixels**, biome clean on the
two touched files.

---

## Layer 6.35 — the criterion from 6.34 predicted a bug, and found one

`tst/webgpu-render/{cases.ts,case-names.mjs,run.mjs}`, `src/renderer/webgpu/frame-backend.ts`.
43 cases, one tracked.

6.34 ended by writing down which ports pay: the ones touching a *path* only one backend had, not
shared encoder or packer code. `cube-face-partial` was chosen on that basis — WebGL had two cube
texture cases, WebGPU had none — and its own doc asserted something about the other backend it had
never checked: *"Proves `z` means the same face index the WebGPU backend passes as `origin.z`."*

**It passes, and mutation-checking it is what found the bug.** Pointing the region at face 2 instead
of 4 should have read the *stale* blue; it read `[0, 0, 0, 0]`. Alpha zero from a pass that clears to
`[0, 0, 0, 1]` is not a wrong colour, it is a target nothing ever wrote.

**`cubemap` is the reduction and it is now a case.** An ordinary `CubeTexture`, six ready faces, one
sample toward +Z, one pass: nothing renders, not even the clear. Swap the fragment for a constant and
the identical case passes, so the target, the pass, the read and the harness are all fine. What is
established: the sample kills the frame, and the same sample **with a queued update region works**, so
the initial full upload is where it goes wrong. What is not established is why, and the entry says so
rather than guessing.

**Established the next layer.** 6.37: `uploadCubeTextureData` had only an `isExternalImage` branch, so
a cube built from typed arrays was created and never written.

**A second error-scope gap, found the same way 6.25's was.** The per-pass scopes close before
`submitFrame`, so a command buffer Dawn rejects takes the frame with it and leaves no reason behind.
`submitFrame` now pushes its own scope. It did not explain this bug — which is itself information,
since it rules out a rejected submit — but the hole was real and is closed.

**Two ports before it were green and are kept**: `interleaved-attrs` and `instanced` in 6.34, and
`cube-mips` in 6.33. The criterion did not say shared-code ports are worthless, it said they come back
green — and being able to predict which ones do is what made this one worth doing first.

Verified: src tsc 0, tst tsc 0, 480 tests across 55 files, 86/86 WebGL pixels, **42/42 WebGPU pixels
with `cubemap` tracked**, biome clean on the four touched files.

---

## Layer 6.36 — `cubemap` narrowed to five facts and no diagnosis

`tst/webgpu-render/{cases.ts,child.mjs}`.

A second cycle on the cube bug, spent on instruments and elimination rather than a fix. What is now
**established by experiment**, each from a single-variable change to the case:

1. **The pass is counted and still writes nothing.** `info.render.calls` and `frameCalls` are both 1,
   so it passed the size guard, incremented, and entered `encodeOpenPass`.
2. **Its clear is lost too.** Changing the clear from black to green leaves the read at `[0,0,0,0]`,
   so this is not a draw that failed inside a pass that ran.
3. **The frame and the target are fine.** A second pass into the same target in the same frame lands
   its colour. The first attempt at this used a black clear and could not tell "cleared then nothing"
   from "never ran" — both leave black under the second pass. Fact 2 is the version that separates them.
4. **Nothing about the cube is unready.** All six sources report `dataReady`, and `areCubeSourcesReady`
   is what gates the fall back to the 1x1 placeholder.
5. **Replacing the fragment with a constant makes the identical case pass**, so target, pass, read and
   harness are all sound; the cube sample is the whole difference.

And the one asymmetry that should point at it: **the same sample with a queued update region works**
(`cube-face-partial`), so the fault is in the initial full upload rather than in sampling a cube.

**Three instruments were tried; two were dead ends worth recording.** Per-pass error scopes report
nothing. A scope around `submitFrame` (added in 6.35) reports nothing, which rules out a rejected
command buffer. An `uncapturederror` listener on the device — the one place errors outside every scope
land — reports nothing either. It stays in `child.mjs`: a case that fails with no scoped error now has
somewhere left to look, and the absence of an error here is itself a fact that narrows the search.

A measurement I misread and am recording so the next person does not: `info.memory.textures` is
snapshotted at `_beginInfoFrame`, so reading it after a frame reports the state *before* that frame's
uploads. `tex=0` on a first frame means nothing at all.

Verified: src tsc 0, tst tsc 0, 480 tests across 55 files, 42/42 WebGPU pixels with `cubemap` tracked,
biome clean on the two touched files.

---

## Layer 6.37 — the cube bug, found by reading the upload path

`src/renderer/webgpu/textures.ts`, `tst/webgpu-render/{cases.ts,run.mjs}`. 43 cases, none tracked.

**`uploadCubeTextureData` had one branch, `isExternalImage`.** A `CubeTexture` built from raw
`Uint8Array` faces matched nothing, so the GPU texture was created and never written. The 2D path
next to it has had an `isTypedArrayData` branch all along, and so has the 2d-array path — checked, it
handles both. Cube was the only one missing it. Four lines, and `cubemap` goes green.

**Three cycles of probing from outside could not have found this; one read of the function did.** The
external evidence was accurate and pointed straight at it — the same sample *with* a queued region
worked, and `uploadPartialRegion` is the one upload path that tests `isTypedArrayData` — but every
instrument I reached for was looking for an *error*, and there is no error to find. Nothing is invalid
about creating a texture and not writing to it. When the scopes, the submit scope and
`uncapturederror` all came back empty, that was the signal to stop instrumenting and read the code the
evidence had already named.

**One fact from 6.36 was wrong and is retracted: the clear was not lost.** `[0, 0, 0, 0]` came from a
first-frame read of a target whose only draw sampled an unwritten texture, not from a pass that never
ran, and my green-clear test could not tell those apart because the fullscreen draw covers the clear
either way. Fact 1 (the pass is counted) was right and should have carried more weight than fact 2.

**What the harness keeps**: the `uncapturederror` listener in `child.mjs` stays. It reported nothing
here, and that was informative — it ruled out an error escaping every scope, which is what sent me to
read the upload path.

Verified: src tsc 0, tst tsc 0, 480 tests across 55 files, 86/86 WebGL pixels, **43/43 WebGPU pixels,
`KNOWN_FAILURES` empty**, 2/2 shake bundles, biome clean on the four touched files.

---

## Layer 6.38 — the bug class becomes a test, and the array sibling is proved

`tst/texture-upload-source-kinds.test.ts` (new), `tst/webgpu-render/{cases.ts,case-names.mjs}`.
481 tests, 44 WebGPU cases.

6.37's bug was not "cube upload is broken", it was **an upload path missing a source-kind branch**, and
one pixel case does not stop that recurring in the next view dimension. The three full-upload paths
now have to stay in step: the test parses `textures.ts`, pulls each function's body, and fails naming
the pair that is missing. Mutation-checked by disabling the branch 6.37 added — it reports
`uploadCubeTextureData does not handle isTypedArrayData`, which is the bug in its own words.

**That guard runs in vitest in milliseconds.** The bug it describes cost three cycles of Dawn probing
to find. Structural siblings that must agree are worth checking structurally, not one instance at a
time through a real device.

**`array-layer-partial` ported, and it carries both halves of the contract in one case**: the queued
layer changes to blue *and* its untouched neighbour is still red. The WebGL harness spends two cases
on that (`array-layer-partial` and `-untouched`); a `z` that leaked into the wrong layer fails either
way, so one case with two reads says the same thing.

**The uv trap appeared again and cost one run instead of three cycles.** `arrayTexture(tex, layer)`
used as a value samples with the default `varying(uv())`, which `fullscreenTriangle()` cannot feed, so
it wants vertex slot 0 and displaces `position`. The harness named the pass and the reason
immediately, which is exactly what 6.25 and 6.35 were built for. Fixed in the case by sampling
`screenUV`, since a fullscreen read is screen-space — the same correction 6.26 made in `PassNode`.

Verified: src tsc 0, tst tsc 0, 481 tests across 56 files, **44/44 WebGPU pixels**, biome clean on the
three touched files.

---

## Layer 6.39 — the trap that cost three cycles now names itself

`src/renderer/core/node-builder-state.ts`, `src/renderer/webgpu/pipelines.ts`,
`src/renderer/webgl/geometries.ts`, `tst/missing-vertex-buffer.test.ts` (new). 484 tests.

A shader's attributes are a contract the geometry has to meet, and **both backends were dropping it
silently in one line each.** WebGPU's `buildVertexBufferLayouts` does `if (arrayStride === null)
continue`, leaving the shader declaring locations the pipeline has no buffers for, so Dawn reports
`Vertex attribute slot 0 ... is not present in the VertexState` — a slot number, no attribute name, no
mesh. WebGL's `prepareGeometry` does `if (buffer) ensureUploaded(...)`, which skips the upload and
draws whatever that attribute last held, with no message at all.

`resolveVertexGroupStride` returns null only when the shader names a buffer the geometry does not
have, so the skip is never legitimate — it is always a setup bug being swallowed.

**`assertVertexBuffers` is neutral and both backends call it**, which is the fronting-`Renderer` work
paying in its intended currency: the check is written once and neither backend can drift from it. The
message names the buffer, its shader locations, and the fix.

**This is the trap from 6.19, 6.26, 6.35's hunt and 6.38** — sampling a texture pulls in the default
`varying(uv())`, so the geometry owes a `uv` that nothing in the call mentions, and the uv takes
location 0 away from `position`. 6.26 removed it from `PassNode`, where a pass output is screen-space
and the uv was simply wrong. Everywhere else it is legitimate and the right answer is to say so: a
test builds exactly that graph and asserts the error says `reads vertex buffer 'uv'`.

Nothing regressed, which is its own result: every existing case and example already meets the
contract, so the assertion is describing what the code already does rather than tightening it.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 484 tests across 57 files, 86/86 WebGL pixels, 44/44
WebGPU pixels, 48/48 GLSL, 2/2 shake bundles, biome clean on the four touched files.

---

## Layer 6.40 — the error names the mesh, and the partial family is complete

`src/renderer/webgl/{geometries.ts,render-pass.ts}`, `src/renderer/webgpu/pipelines.ts`,
`tst/webgpu-render/{cases.ts,case-names.mjs}`. 45 WebGPU cases.

**6.39's error said `'geometry' reads vertex buffer 'uv'`, which identifies nothing.** A constant
label in a message whose whole job is to point at the thing to fix. Both call sites have the render
object one frame up, so the label is `renderObject.mesh.name` now, with `'mesh'` as the fallback for
an unnamed one. WebGPU passes it through `buildVertexBufferLayouts`; WebGL through `prepareGeometry`,
which had no access and now takes it. Both default to `'geometry'` so the probe path that calls
`prepareGeometry` directly keeps working.

**`subrect-partial` completes the partial-upload family on a real device**: cube face (6.35), array
layer (6.38) and now a 2D sub-rect. All three exercise the same `uploadPartialRegion`, which is the
one upload path that was already handling typed arrays when 6.37 found the full-upload path was not —
so proving each view dimension through it is exactly the coverage that gap argued for.

Like its two siblings it carries both halves in one case: texel (1,0) becomes magenta **and** (0,0)
stays red, so a write that widened to the row or ignored `x` fails. The WebGL harness spends a second
case on the neighbour assertion; one case with two reads says the same thing and costs one process
rather than two.

Verified: src tsc 0, tst tsc 0, 484 tests across 57 files, 86/86 WebGL pixels, **45/45 WebGPU
pixels**, biome clean on the five touched files.

---

## Layer 6.41 — the V-flip claim tested from the side that was asserting it

`tst/webgpu-render/{cases.ts,case-names.mjs}`. 46 WebGPU cases.

`rtt-flip` exists because WebGL's framebuffer origin is bottom-left, so a texture rendered into stores
its rows the other way and sampling it has to flip V. The case's stated reason for the expected value
is **what WebGPU would return**: *"WebGPU would return the top color (RED) there; the flip makes WebGL
agree."* Nothing had ever asked WebGPU. Now something does, and it does return red — so the two
harnesses assert the same convention from opposite sides, and a regression in either one breaks its
own case rather than being silently absorbed by the other's expectation.

**Two candidates were rejected by reading rather than by porting.** `cube-rtt` is `cube-mips` without
mips, and 6.33 already ported that. `a2c` looked like a pipeline state that might not be threaded,
which is the `depthBias` shape from 6.24 — but `alphaToCoverageEnabled` is set from
`material.alphaToCoverage` and is in the pipeline cache key, so the port would be green and prove
something already visible in twelve lines of grep. The criterion from 6.34 is about where bugs live;
it is also worth using to decide what *not* to spend a Dawn process on.

The case's reason went into `note` rather than a doc block, as in 6.23 onward: the harness prints it
beside the pixels, which is where it is read.

Verified: src tsc 0, tst tsc 0, 484 tests across 57 files, 86/86 WebGL pixels, **46/46 WebGPU
pixels**, biome clean on the two touched files.

---

## Layer 6.42 — the porting seam, counted rather than felt

`tst/webgpu-render/{cases.ts,case-names.mjs}`. 47 WebGPU cases against WebGL's 78.

`rt-load-orient` ported and green: render a two-tone into a target, then `texelFetch` it by
`screenUV * dims` and check the displayed top loads red. It is the load-by-index sibling of 6.41's
`rtt-flip` sample-by-uv, and the same argument applies — its expected value encodes a convention, and
a convention only one backend asserts is a convention nobody is checking.

**The 44 still WebGL-only, classified by reading each one rather than by counting:**

*Cannot port, no WebGPU counterpart (24).* The seven `tf-*` cases, since WebGPU has no transform
feedback and a compute kernel is the equivalent (layer 6.14). The three `*-unsupported` refusals of
things WebGPU supports. `foreign-canvas`, which is WebGL being single-canvas (6.22). `headless-offscreen`
and the two `screen-orient-*`, which are canvas presentation the WebGPU harness has no canvas for. The
ten `storage-*` cases covering the read-lowering texel grid, which is WebGL's emulation of storage
buffers and has no analogue.

*Already covered by a ported case (6).* `cube-rtt` is `cube-mips` without mips. `array-layer-partial-untouched`
and `subrect-partial-neighbour` are second halves folded into their siblings' single case.
`frame-api` is what every WebGPU case does. `fullscreen` and `draw-scene` are `solid` and `scene`.

*Portable and not yet done (14).* `fragcoord-direct`, `cube-camera`, `integer-texture`,
`struct-texture` and its `-grow`/`-partial` siblings, `compile-prewarm`, `lit`, `textured`,
`geomuv-present`, `transparent-default-blend`, `batched-draws-nonindexed`, `viewport-cell-present`,
`a2c`. Of these `a2c` was checked and rejected in 6.41: `alphaToCoverageEnabled` is threaded and in
the pipeline cache key, so the port proves something grep already shows.

**So the gap is 44, of which 30 are not gaps.** The seam is not exhausted, but it is no longer the
obvious place to spend a cycle: what is left is one convention (`fragcoord-direct`), two target kinds
(`cube-camera`, `integer-texture`) and a tail of ordinary draws. Counting it is what makes that a
decision rather than a feeling.

Verified: src tsc 0, tst tsc 0, 484 tests across 57 files, 86/86 WebGL pixels, **47/47 WebGPU
pixels**, biome clean on the two touched files.

---

## Layer 6.43 — the convention and the two target kinds the audit named

`tst/webgpu-render/{cases.ts,case-names.mjs}`. 49 WebGPU cases.

6.42 left fourteen worth porting and singled out three. Two are done and both green.

**`fragcoord-direct` is the third leg of the orientation set.** `readback-orientation` covers the read,
`rtt-flip` the sample by uv, `rt-load-orient` the load by texel index, and this one covers a shader
reading raw `screenCoordinate` with no uv involved at all. The WebGL case exists to guard a *flip*
applied to make GL agree with WebGPU's top-left origin; asserting the same thing on the backend the
flip is defined against is what makes it a shared convention rather than one backend's correction.

**`cube-camera` is the only WebGPU case that drives `CubeCamera.update`**, and it is the post-refactor
path: `update(gpu, scene)` now takes the `Renderer`, not a concrete backend. It bites for a reason
`cube-layer` does not cover — `cube-layer` proves `PassDesc.layer` selects a face, this proves
`CubeCamera` actually uses it, because sampling **-X** reads an untouched texture if all six passes
wrote face 0.

**`integer-texture` is deliberately left.** It is the remaining target-kind candidate, but
`bind-group-layout-sampletype.test.ts` already pins the `sampleType: 'uint'` decision in vitest, which
is where being wrong shows up; a Dawn process would confirm what a unit test already holds.

Verified: src tsc 0, tst tsc 0, 484 tests across 57 files, 86/86 WebGL pixels, **49/49 WebGPU
pixels**, 2/2 shake bundles, biome clean on the two touched files.

---

## Layer 6.44 — the lib failures settled, and the plan's own status caught up

`PLAN-explicit-frame.md`. No source touched.

**The 18 lib test failures are not this work, and that is now evidence rather than a hedge.** I
flagged them twice as "look pre-existing" without settling it, which is a claim doing the work of a
check. Four things settle it: the failing assertions are leaf-block variant counts, block hooks and
voxel light, none of which involve a renderer; two of the three files never mention gpucat at all;
`1ca92dce feat(voxels): self-cull leaves against adjacent leaf blocks` is recent work in exactly the
area `block-variants` asserts about; and lib's tree carries fourteen modified files of in-flight work
that is not mine, including `compileCompute` renamed to `compileComputeWgsl` and a half-finished
refactor of the sky tests. My own lib edits were four files, each named at the time.

**The plan said "in progress through layer 6.21".** It was 6.43. Fixed, with two sentences on what the
twenty-two layers since actually were, because "in progress" over that gap tells a reader nothing:
the frame API is built and proven, 6.27-6.32 replaced the two concrete renderers with one `Renderer`
over a `DeviceBackend`, and 6.23-6.43 took the WebGPU harness from 26 cases to 49 and found four bugs.

**`plan-refs` caught a correction I made to it**, which is the gate earning its place rather than
passively passing: naming lib's render modules by path made them look like gpucat files that do not
exist. The gate cannot tell one repo's paths from another's, and that is the right trade for how
simple it is — the prose changed instead.

Six `renderer.render(` references remain in the plan and all are correct: they describe the ambient
driver this whole change removed, in the sections arguing for removing it.

Verified: src tsc 0, 484 tests across 57 files.

---

## Layer 6.45 — a goblin pass I reported as done had not run

`src/renderer/webgl/webgl-backend.ts`.

Layer 6.39's entry says the WebGL file's stale header was "Deleted" and three method docs were cut
down. **None of that reached the file.** The edits were one Python script with several asserted
anchors; a later anchor failed, the script raised before its single `open(...).write(...)`, and every
earlier replacement went with it. The one change that did land was in a separate script that ran
after. So the layer's report was written from what the script intended rather than from the file.

The stale block was the thing 6.39 itself held up as worth catching: a header naming `renderer.ts`,
`WebGPURenderer`'s structure, satisfying `RendererState`, and `render()` binding the default
framebuffer — four things that stopped being true across 6.30 and 6.31. It survived a cycle whose
stated purpose was removing it.

Done now, one write per edit so a failed assert cannot take its neighbours with it: the 13-line header
is gone, the 5-line class doc is one line naming what is actually load-bearing (immediate mode, no
encoder, so a pass encodes as it ends), `transformFeedback` and `readBufferAsync` keep the knowledge
worth keeping (WebGPU's equivalent is a compute kernel; the fence is polled rather than spun because a
busy-loop never signals single-threaded) and drop "WebGLRenderer-only" three times over, and
`dispose`'s nine lines about not calling `loseContext()` are four. `WebGLRenderer`, `WebGPURenderer`
and `RendererState` now appear zero times in the file; the other four frame files were checked the
same way and were already clean.

**The lesson is about the edit, not the comment.** A batch of asserted replacements that writes once
at the end is all-or-nothing, and reporting from the script instead of from the file makes the
difference invisible. Verify the result, not the intent.

Verified: src tsc 0, 484 tests across 57 files, 86/86 WebGL pixels, 49/49 WebGPU pixels, biome clean
on the touched file.

---

## Layer 6.46 — auditing my own reports, and 68 user-facing names that outlived their class

`src/` (22 files, comments and error strings only).

6.45 was a report written from a script's intent rather than the file. That is a class of error, not an
incident, so every checkable claim from the layers that used batched edits was verified against the
code: 6.21's options split, 6.22's `deviceCanvasTarget` on both backends and in core, 6.26's three
`uvNode = screenUV` sites, 6.31's `BackendFactory` rename with no `Backend<` left, 6.35's submit error
scope, 6.39/6.40's `assertVertexBuffers` in both backends with the mesh name threaded. **All present.**
6.45 looks like the only one that did not land.

**The sweep that generalises it found sixty-eight.** `WebGPURenderer` and `WebGLRenderer` were still
named across 22 files — and mostly not in comments. Sixty-two were **error-message prefixes**:
`[WebGLRenderer] gl.createSampler returned null`, `[WebGPURenderer] Render target texture not found in
cache`. A user reads those and greps for a class that has not existed since layer 6.30. They are
`[webgl]` and `[webgpu]` now, matching what the two backend files already used — 6.30 renamed them
there and nowhere else.

**One was worse than stale, it was wrong advice**: `indirect draw ... is not supported on the WebGL2
backend; use WebGPURenderer.` There is no such thing to use. It says *use the webgpu backend*.

The remaining six were comments describing deleted mechanisms — `WebGLRenderer.render()` calls
`executeRenderPass`, `WebGLRenderer.clear()` calls `clear`, and two inspector hooks documented as
"called at the very start of `WebGPURenderer.render()`", a method this whole plan removed.

Left alone deliberately: two pre-existing lint findings in inspector tabs whose files are in the diff
only for a type rename. The findings sit on lines this work never touched.

Verified: src tsc 0, 484 tests across 57 files, 86/86 WebGL pixels, 49/49 WebGPU pixels, 48/48 GLSL,
2/2 shake bundles. `WebGPURenderer` and `WebGLRenderer` now appear zero times in `src/`.

---

## Layer 6.47 — a deleted name stays deleted, and one the plan called deleted was not

`tst/retired-names.test.ts` (new), `PLAN-explicit-frame.md`. 485 tests.

6.46 cleaned 68 references to classes that had not existed for sixteen layers. Cleaning them is not
the fix; nothing was looking, which is why they lasted. The plan's **What goes away** list is a
denylist that had never been used as one, so it is a test now: ten retired names, matched whole-word
across every `.ts` under `src/`, comments and error strings included. Mutation-checked by restoring
one of the exact strings 6.46 removed — it reports `src/renderer/webgl/samplers.ts:111 WebGLRenderer`,
with the file, the line and the name.

`RenderPipeline` is deliberately **not** in the list: WebGPU's own `GPURenderPipeline` contains it, and
a guard that has to be argued with every time it fires is a guard people delete.

**Checking the list against the code found the plan overstating one deletion.** It says `autoClear` /
`autoClearStencil` / `clearStencilValue` went — but the last two are in four files. They are not
leftovers: they were deleted as *ambient renderer fields* and exist now as derived `RenderPassParams`,
computed from `PassDesc.clearStencil` inside `resolvePassParams`. That is the whole shape of this
change — ambient state becomes a value resolved per pass — so the plan reading as though the names
themselves were purged was hiding its own result. Corrected in place.

Two of the last three layers have been about the same thing: a claim recorded as done while the code
said otherwise. The answer both times was to make the claim executable rather than to restate it.

Verified: src tsc 0, tst tsc 0, 485 tests across 58 files, biome clean on the new file.

---

## Layer 6.48 — auditing "What goes away" found the refactor had undone a settled decision

`src/renderer/core/{renderer.ts,device-backend.ts}`, `src/renderer/webgpu/webgpu-backend.ts`,
`src/renderer/webgl/webgl-backend.ts`, `PLAN-explicit-frame.md`.

The plan's largest claim is its **What goes away** list, asserted layer by layer and never checked as
a whole. Checked now, against the code, item by item: `RenderPipeline`, `QuadMesh`, `renderer.render`
and its three ambient fields, `RenderTarget.viewport`/`scissor`/`scissorTest`,
`saveRendererState`/`restoreRendererState`, `_renderCallDepth`, `overrideMaterial`, `setScissorTest`,
and `passId`/`callDepth` out of both cache keys — **all gone**. `BackendState` has exactly 13 fields,
which is the three device handles plus the ten caches it claims. `RenderObject.lastPassLabel` is
written only when an inspector is attached, and both backends pass `null` when there is none, so the
per-draw cost the plan says is not paid is in fact not paid.

**One item did not verify, and it was my own regression.** Open item 8 settled in layer 4.41 that
`hasFeature` is *not* on the neutral contract, because a neutral signature widens WebGPU's
`GPUFeatureName` union to `string` and throws away the only thing that makes the call checkable.
Layer 6.30 put `hasFeature(feature: string)` on `DeviceBackend` and forwarded it from `Renderer`,
which is exactly the shape 4.41 rejected — and the comment I wrote on it (*"widened to `string` so the
contract names no backend type"*) describes the cost as though it were the design.

Nothing called it, in src, tst, examples or lib. It is off the contract and off `Renderer` now;
`WebGPUBackend.hasFeature` takes `GPUFeatureName`, reached through `gpu.backend` like every other
backend-only method (the rule from 6.30). WebGL's stub went with it: it answered `false` to every
question and surfaced no feature, so its absence says the same thing more honestly.

**A settled decision is only settled while something checks it.** Six layers was enough for this one
to be quietly reversed by a refactor whose whole purpose was making the two backends agree.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 485 tests across 58 files, 86/86 WebGL pixels, 49/49
WebGPU pixels, 2/2 shake bundles, biome clean on the four touched files.

---

## Layer 6.49 — the guard I wrote first would not have caught the bug it was for

`tst/neutral-contract.test.ts` (new). 487 tests.

6.48's regression — `hasFeature` back on the neutral contract, six layers after being settled off it —
was found by hand. The guard for it is that **the neutral surfaces name no graphics API**, which is the
property the whole fronting `Renderer` rests on: `DeviceBackend` and `Renderer` are walked with the
type checker and every member's printed type is matched against `GPU*` / `WebGL*` / `WebGPU*`.

**Then the mutation check said it worked, and it was checking the wrong mutation.** Adding
`hasFeature(feature: GPUFeatureName)` fails it, correctly. But 6.30's actual regression was
`hasFeature(feature: string)` — the point of that mistake was *widening the union away* to fit the
neutral signature, so the leaked type is exactly what is not there. The guard would have watched it
happen.

The check that catches it is a ratchet on the member list, the shape `public-api.test.ts` already uses
for exports: both surfaces have their members written down, and an addition fails until it is listed,
which is where the argument for adding it has to be made. Mutation-checked with the real signature
this time: `unlisted on DeviceBackend: [ 'hasFeature' ]`.

**A mutation test is only as good as the mutation.** Writing one that passes proves the guard fires;
it does not prove the guard fires *on the defect*, and picking the convenient mutation is how a guard
ends up documenting a property nobody was going to break anyway.

Verified: src tsc 0, tst tsc 0, 487 tests across 59 files, biome clean on the new file.

---

## Layer 6.50 — `cube-mips` never tested a mip, and took three attempts to admit it

`tst/webgpu-render/cases.ts`.

6.49 ended on mutation tests being only as good as the mutation. Applying that to the harness, the
obvious suspect was `cube-mips`: six faces cleared to **one colour**, sampled fullscreen from a
same-sized cube. Every level of a flat face is that colour, and a fullscreen sample of a 64x64 cube
into a 64x64 target reads LOD 0 anyway. It passed with the chain ungenerated. It was `cube-rtt` under
a name claiming more — and 6.41 skipped porting `cube-rtt` *because* this case covered it.

**Three attempts, two of them wrong, each wrong in my instrument rather than the code.**

1. `.level(f32(3))` — still green with `generateMipmaps: false`, because a one-level chain clamps the
   request to level 0 and a flat face makes that the same colour.
2. Two-tone faces plus `.level(f32(6))`, the 1x1 level — still green, because the sample direction
   `vec3(0, 0, 1)` lands on the red/black boundary, so level 0 reads ~128 as well. The discriminator
   and the confound were the same number.
3. Aim into the red half: `vec3(0, 0.6, 1)`. Mips on reads **128**, the averaged 1x1 level; mips off
   reads **255**, level 0's red. It bites.

The second attempt is the one worth remembering: the mutation *did* change what the code did, and the
case still passed, because the value I measured could not tell the two apart. A guard that fires is
not the same as a guard that discriminates.

A slice from `caseCubeMips` to `caseCubeFacePartial` also ate the four cases between them; tsc named
two of them immediately and the file was restored from the copy taken before the edit. Function-name
boundaries are not stable edit anchors in a file that grows by insertion.

Verified: src tsc 0, tst tsc 0, 487 tests across 59 files, 49/49 WebGPU pixels, biome clean on the
touched file.

---

## Layer 6.51 — `msaa` had the same hole as `cube-mips`, found by looking for the shape

`tst/webgpu-render/cases.ts`.

6.50's vacuous case was found by hunch. The shape it had is checkable: **a case is vacuous when the
value it reads is uniform and the mechanism it names produces a blend.** Swept the harness for that,
and `msaa` was the other one.

It drew a fullscreen constant cyan into a 4-sample target and read the centre. Every sample in every
pixel is cyan, so the resolve is cyan, and the read is cyan with `samples: 4`, with `samples: 1`, and
with no resolve at all. What it proved is that a multisampled target does not crash.

**MSAA antialiases coverage, not shading**, so the case needs a geometry edge rather than a different
colour — a fragment-stage `select` is evaluated once per fragment and resolves flat. The draw is now a
half-covering triangle whose hypotenuse runs through the read pixel: 4 samples give `green=128`, which
is 2-of-4 coverage, and dropping to `samples: 1` gives `green=0`. Mutation-checked both ways.

**The rest of the sweep came back clean.** `mrt-blend` looked like the same shape — one fullscreen
draw, one flat colour — but its two attachments expect *different* numbers from the same clear (0.25
replaced against 0.5 additive), so a blend mode that did not apply fails it. The remaining cases test
presence rather than a transform: a clear landed, an upload arrived, a layer was selected. Uniform
values are fine there, because the alternative to the mechanism working is nothing at all.

Two cases in two layers, both claiming a mechanism their reading could not observe. Both were written
by porting a WebGL case that had the same hole, so the hole crossed with them.

Verified: src tsc 0, tst tsc 0, 487 tests across 59 files, 86/86 WebGL pixels, 49/49 WebGPU pixels,
biome clean on the touched file.

---

## Layer 6.52 — the same hole in the WebGL originals: one fixed, one stopped at

`tst/webgl-render/harness.ts`.

6.51 ended on the two vacuous WebGPU cases having been *ported* from WebGL cases with the same hole.
So the originals have it too.

**`msaa` fixed, and its own comment had confessed.** It drew a solid fullscreen colour into a 4-sample
target, and said so: *"if a sample count degrades, the fallback still produces the same flat color."*
That is the vacuity written down as a reassurance. It draws a half-covering triangle now, and instead
of reading one pixel it **scans the middle row for any partially covered pixel** — the WebGL path
samples the resolved target through `screenUV` onto the canvas and reads that back, two resamplings,
so where the edge lands is not worth predicting. 4 samples finds one partial pixel, `samples: 1` finds
none. Mutation-checked.

Two wrong guesses on the way, both mine: `cullMode: 'none'` on a suspicion the triangle was culled
(it was not), and a single centre-pixel read that returned a hard 0 because the edge did not land
there. The row scan is robust to the thing I could not predict, which is why it is the right shape.

**`cube-mips` attempted and reverted, with the result recorded rather than a guess.** Two-tone faces
plus a 1x1-level sample is exactly what fixed the WebGPU case, and the 1x1 level is a face average, so
it is immune to GL's row order. On WebGL it read **0**, not the ~128 blend. The GLSL emitter does emit
`textureLod(name, dir, level)` for cube level mode, so the path exists; what is not established is
whether the chain is absent or the sampler's min filter keeps the read at level 0. Not established,
so not asserted, and not left as a red gate either: the case is back to its previous form.

**Established the next layer.** 6.53: neither. `CubeCamera` flips `generateMipmaps` off mid-render and
`mipLevelCountFor` reads that same flag to size the allocation, so the chain was never allocated.

**What that costs, stated plainly**: WebGL's `cube-mips` is still vacuous for mips — it proves
render-to-cube-face and cube sampling, which is `cube-rtt`. The real mip coverage is the WebGPU case
from 6.50, and the WebGL side has none.

**Superseded one layer later.** 6.53 found the cause — the allocation this attempt was blocked on —
and the same two-tone, level-6 case went green and now guards the fix. The paragraph above was true
for exactly one layer.

Verified: src tsc 0, tst tsc 0, 487 tests across 59 files, 86/86 WebGL pixels, 49/49 WebGPU pixels,
biome clean on the touched file.

---

## Layer 6.53 — the vacuous case was hiding a real bug in `CubeCamera`

`src/core/cube-render-target.ts`, `tst/webgl-render/harness.ts`.

6.52 stopped at WebGL reading level 0 for a cube `textureLod` and refused to name a cause. The cause,
established by experiment rather than by reading:

**`CubeCamera.update` sets `texture.generateMipmaps = false` before the face loop** and restores it
before face 5, so the chain is regenerated once rather than six times. But `mipLevelCountFor` reads
that same flag to decide how much storage to allocate, and WebGL allocates with `texStorage2D`, which
is **immutable**. Face 0's render allocates one level; restoring the flag before face 5 cannot grow
it. `generateMipmap` then has nothing to fill.

One field answered two questions — *how much to allocate* and *when to regenerate* — and the
optimisation for the second silently broke the first.

**Confirmed before being asserted**: the same two-tone, level-6 probe reads `0` with the flip and
`128` without it. That is what separates this from 6.36, where I had a plausible mechanism and no
experiment.

**The fix captures the allocation intent once**, at construction: a `CubeRenderTarget` built with
`generateMipmaps` sets `mipLevelCount` to the full chain, which `mipLevelCountFor` falls back to
exactly when the flag is transiently false. The flag keeps meaning "regenerate", and allocation stops
listening to it.

**And the case that could not see the bug now guards the fix.** WebGL's `cube-mips` has two-tone faces
and reads the 1x1 level — the face average, so it does not care which way GL stored the rows. Reverting
the fix turns it red with `red=0`. It kept `CubeCamera`'s flag-flip on purpose: the flip is the thing
that used to break it.

A vacuous test is not merely worth nothing. This one had been covering a real defect for as long as it
existed, and the only reason it surfaced was 6.51 asking what value the case could actually observe.

Verified: src tsc 0, tst tsc 0, 487 tests across 59 files, 86/86 WebGL pixels, 49/49 WebGPU pixels,
biome clean on the two touched files.

---

## Layer 6.54 — the same bug on WebGPU, and it crashes rather than degrades

`tst/webgpu-render/{cases.ts,case-names.mjs,run.mjs}`. 50 cases, one tracked.

6.53 fixed allocation on WebGL and guarded it there. `CubeCamera` is backend-neutral and WebGPU
allocates from the same `mipLevelCountFor` into equally immutable textures, so the bug was there too —
and nothing could see it: the WebGPU `cube-mips` case does not flip the flag (one frame, six passes,
mips flushed at submit), and `cube-camera` does not ask for mips. The intersection had no case.

`cube-camera-mips` is that intersection, and it does not merely read the wrong level. It fails the
submit: **`Destroyed texture [Depth24Plus] used in a submit`**, surfaced by the submit-scope drain
from 6.35, which has now earned its place twice.

**That diagnosis was wrong; see layer 6.55.** I read `ensureRenderTargetTexturesAllocated`'s 2D
reallocation and blamed its `size: [width, height]`, missing the `isCubeRenderTarget` guard on its
first line that sends cube targets somewhere else entirely. The path I named is not the path this
takes.

**One attempted fix, reverted, and it made things worse.** The allocation check passes a hardcoded
`mipLevelCount: 1`; I changed it to the expected chain. That turned a silent mismatch into a
reallocation every frame, destroying the texture the open frame was still using. The crash was there
before that change and is there after it, so the change bought nothing and cost correctness elsewhere.
Reverted; `render-target.ts` carries no change from this layer.

Tracked rather than fixed: the fix belongs in whichever of those two paths is wrong, and choosing
needs more than the end of a long cycle. `KNOWN_FAILURES` carries the case with the mechanism written
next to it, and the runner fails if it starts passing.

**WebGL is unaffected and stays green** — its `cube-mips` covers the fixed path with its own
discriminating read.

Verified: src tsc 0, tst tsc 0, 487 tests across 59 files, 86/86 WebGL pixels, 49/49 WebGPU pixels
with `cube-camera-mips` tracked, biome clean on the four touched files.

---

## Layer 6.55 — my own regression, and 6.54's diagnosis was wrong

`src/renderer/webgpu/render-target.ts`, `tst/webgpu-render/run.mjs`. 50 cases, none tracked.

**6.54 blamed the wrong function.** I read the reallocation inside
`ensureRenderTargetTexturesAllocated`, saw it create `size: [width, height]` with no `mipLevelCount`,
and called that the inconsistency. Its **first line** is `if (renderTarget.isCubeRenderTarget)
{ ensureCubeRenderTargetTexturesAllocated(...); return; }`. Cube targets never reach the code I
blamed. The entry is corrected in place rather than left to be believed.

**The real mechanism, in the function cube targets do take**: `cubeMipCount` was
`texture.generateMipmaps ? fullMipChainLength(...) : 1` — the **live** flag, the one `CubeCamera`
flips off for faces 0 to 4. So the check asked "is this one level?" while the texture held a chain,
found a mismatch, and reallocated **mid-frame**, destroying the colour and depth the open frame was
still encoding against. Hence a crash rather than a wrong pixel.

**And this was 6.53's doing.** Before that layer the allocation was also one level during the flip, so
the check and the allocator agreed and the only symptom was the missing chain. Fixing allocation
without fixing the check left them disagreeing, and the disagreement is worse than the original bug.
A field that answered two questions was split in one place and not the other.

The fix is that the check now asks `mipLevelCountFor`, which is what the allocator asks. Reinstating
the flag dependence brings `Destroyed texture ... used in a submit` straight back, so
`cube-camera-mips` guards this specific line.

Twice in three layers I have named a cause from reading one function and not its caller. The cheap
correction both times was to check the entry point before believing the body.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 487 tests across 59 files, 86/86 WebGL pixels,
**50/50 WebGPU pixels with nothing tracked**, 2/2 shake bundles, biome clean on the two touched files.

---

## Layer 6.56 — the two-meanings defect, audited and then guarded

`tst/mip-count-source.test.ts` (new). 488 tests.

6.53 and 6.55 were the same defect twice: `generateMipmaps` answers **"regenerate now"**, `CubeCamera`
flips it off mid-render to regenerate once rather than six times, and code asking it **"how much to
allocate"** gets the wrong answer for five faces out of six. Two readers fixed by hand is not a fix
for a field that means two things.

**Every reader audited and classified.** `webgpu/textures.ts` at 220 and 343 and
`webgl/textures.ts:922` decide *whether to regenerate*, and all three are additionally guarded by
`mipLevelCount > 1`, so they cannot act on a chain that does not exist. `webgpu/frame-backend.ts` at
184 and 250 collect and flush the frame's mip targets, which is the same question. Those five are
correct to read the live flag. The allocation readers are `mipLevelCountFor` itself and the cube check
fixed in 6.55.

**The guard matches the defect's literal shape**: a line that computes `fullMipChainLength` from a
live `.generateMipmaps` read. Mutation-checked with the 6.55 line restored — it reports
`src/renderer/webgpu/render-target.ts:226`.

**It first fired on my own fix, correctly refusing to be simplistic.** `cube-render-target.ts` derives
the chain from `opts.generateMipmaps`, the construction option. That is not the defect — it is the
place the intent is captured once, which is precisely what 6.53 added — so the rule excludes `opts.`
and says why. A guard that cannot tell the fix from the bug would have been deleted the first time it
fired.

Verified: src tsc 0, tst tsc 0, 488 tests across 60 files, 86/86 WebGL pixels, 50/50 WebGPU pixels,
biome clean on the new file.

---

## Layer 6.57 — the gates this work leaned on were not running anywhere but here

`.github/workflows/build-and-deploy.yml`.

Six guard tests across the last nine layers, each mutation-checked, and none of it worth anything if
nothing runs them. Checked what CI actually does: build, build examples, `pnpm test`, and
`test:wgsl` behind a `cargo install naga-cli`.

**`pnpm test` is vitest, so all six guards and the 488 unit tests were already covered.** What was not,
and had never been: **`typecheck`** — a type error reaches CI only if rollup happens to fail on it —
and **`test:glsl`** (48 shaders compiled and linked), **`test:shake`** (one-backend bundles), plus both
pixel harnesses. Every gate quoted in these entries except vitest and naga has been running on this
machine and nowhere else.

Added the ones that need no GPU: `typecheck`, `typecheck:tst`, `test:glsl`, `test:shake`. All four pass
locally against the workflow exactly as written.

**`test:glsl` needs a real driver**, which is the point of it — esbuild bundles the harness and
playwright drives headless Chromium on ANGLE/SwiftShader, so the check is that the emitted GLSL links
rather than that it parses. That means a `playwright install --with-deps chromium` step in a job that
also deploys. The precedent is already there in `cargo install naga-cli`, which is slower, so I added
it rather than dropping the gate — **flagging it as the one judgement call here**, and easy to remove
if a browser download in the deploy job is not wanted.

**Both pixel harnesses stay out.** `test:webgl` wants the same browser and `test:webgpu` wants Dawn in
Node with one process per case, and a deploy job is the wrong place to find out whether that works on
a runner. They remain the local gate they have been; that is a gap and is written here rather than
implied by the workflow.

Verified: src tsc 0, tst tsc 0, 488 tests across 60 files, 48/48 GLSL, 2/2 shake bundles, 86/86 WebGL
pixels, 50/50 WebGPU pixels. The workflow has no tabs and every step carries a `run` or `uses`.

---

## Layer 6.58 — a deferral that rested on a claim about a test, not on the test

`tst/webgpu-render/{cases.ts,case-names.mjs}`, `PLAN-explicit-frame.md`. 51 cases.

Layer 6.43 declined to port `integer-texture` and gave a reason: *"`bind-group-layout-sampletype.test.ts`
already pins the `sampleType: 'uint'` decision in vitest, which is where being wrong shows up; a Dawn
process would confirm what a unit test already holds."* Read that test and it asserts
`sampleTypeForFormat('rgba8uint', false) === 'uint'` — a **pure mapping function**. It says nothing
about the bind group layout using that sample type, about an integer texture binding without a
sampler, or about `textureLoad` on `rgba32uint` returning the channels a shader reads.

So the deferral was a claim about coverage rather than the coverage, and the two sound alike in a
worklog entry. Ported: green, `[64, 128, 192, 255]`, raw u32 channels through `textureLoad`. No bug,
which is the same result as four other ports and is not the reason for doing it — the reason is that
the thing said to be covered now is.

**This is the third deferral or diagnosis this session that did not survive being checked**, after
6.45's goblin pass that never ran and 6.54's wrong cause. The pattern in all three is a statement
about the work standing in for the work, and the cure each time was the same and cheap: open the file
being cited.

Two of 6.42's fourteen portable cases remain that were ever worth the argument, and neither has one:
`compile-prewarm` and `transparent-default-blend`. The rest are ordinary draws.

Verified: src tsc 0, tst tsc 0, 488 tests across 60 files, **51/51 WebGPU pixels**, biome clean on the
two touched files.

---

## Layer 6.59 — the pre-warm proved on the backend that never had a stub

`tst/webgpu-render/{cases.ts,case-names.mjs}`, `PLAN-explicit-frame.md`. 52 cases.

`compile-prewarm` exists on WebGL because layer 6.12 found `WebGLRenderer.compile` was an **empty
stub** with a comment explaining why it needed to be one, against lib's measured 220 ms first frame.
WebGPU's pre-warm has always done real work, so nothing was watching it — the same defect there would
have been just as invisible.

Ported, and the assertion worth copying is not "a pipeline appeared" but **`afterDraw === warmed`**:
`0 -> 1 on compile -> 1 after the draw`. A pre-warm resolved against any context but the pass's own
builds a second pipeline the pass never looks up, which costs the stall it was meant to remove while
looking like it worked. That is the invariant 6.12 wrote down as *"resolved exactly as a pass resolves
it"*, and it is now checked on both backends rather than asserted on one.

Mutation-checked with `compileObjects` made a no-op: `0 -> 0 on compile -> 1 after the draw`, which is
the WebGL stub's exact signature.

That leaves `transparent-default-blend` as the last WebGL-only case with an argument behind it. The
rest of 6.42's portable fourteen are ordinary draws already covered by `solid` and `scene`.

Verified: src tsc 0, tst tsc 0, 488 tests across 60 files, 86/86 WebGL pixels, **52/52 WebGPU
pixels**, biome clean on the two touched files.

---

## Layer 6.60 — the porting programme finished, and what it came to

`tst/webgpu-render/{cases.ts,case-names.mjs}`, `PLAN-explicit-frame.md`. 53 cases.

`transparent-default-blend` was the last WebGL-only case with an argument behind it, and the argument
is that it guards a **shared** policy: a transparent material declaring no explicit `blend` must still
blend. The WebGL backend used to read `material.blend` directly and disable GL blending when it was
unset, drawing such materials fully opaque while WebGPU blended them; commit `75c42a4` moved the
policy into shared code. Only one side of that shared policy had a case. Now both do:
`[128, 128, 0]`, half green over half red. Mutation-checked by dropping `transparent`, which gives
`[0, 255, 0]` — the original bug's exact symptom.

**The programme is finished, and the final count says what it was worth.** 26 cases at layer 6.22, 53
now. Thirty-nine WebGL cases remain unported and 6.42's audit classified them: transform feedback and
WebGL refusals have no WebGPU counterpart, the storage cases cover an emulation WebGPU does not need,
canvas presentation needs a canvas the harness has not got, and the rest are ordinary draws `solid`
and `scene` already cover. Nothing left has an argument.

**Seven real bugs came out of it**, all from ports touching a path only one backend had:
`info.memory.buffers` counting destroyed buffers, a double-registered dispose hook, `PassDesc.clearDepth`
ignored on every WebGPU render target, a `PassNode` dragging its default uv into every consumer,
`uploadCubeTextureData` with no branch for typed arrays, a `CubeCamera` that allocated no mip chain on
either backend, and the allocation check beside it that reallocated a cube target under the frame
encoding into it. The ports of shared encoder and packer code found none, exactly as 6.34 predicted
once the pattern was written down.

Two of those were found not by porting a case but by asking what a *green* case could observe —
`cube-mips` and `msaa` both claimed a mechanism their reading could not see.

Verified: src tsc 0, tst tsc 0, 488 tests across 60 files, 86/86 WebGL pixels, **53/53 WebGPU
pixels**, biome clean on the two touched files.

---

## Layer 6.61 — the vacuity sweep applied to the other harness, and a stale claim retracted

`WORKLOG-explicit-frame.md`. No source changed.

6.51 swept the **WebGPU** harness for cases whose reading cannot observe the mechanism they name, and
found `msaa`. The same criterion had never been run over WebGL's 78. Run now, against every case whose
name claims a *transform* rather than a presence:

- **`a2c`** checks a band, `pixel[0] > 20 && < 235`. Without alpha-to-coverage every sample passes and
  the read is at one end or the other, so the band is the discriminator. Sound.
- **`lit`** expects `0.4 * 1.15` → 117, a value computed *through* the lighting formula. Skipping the
  lighting reads the material's own 0.4 → 102, outside the ±3 tolerance. Sound.
- **`transparent-default-blend`** expects the blended half, not either input. Sound.
- **`msaa`** and **`depth-bias`** were the two that were not, fixed in 6.52 and 6.24.
- **`rtt-flip`** reads a two-tone, so a mirrored V fails it. Sound.

Nothing new. That is the honest result of a sweep, and worth one entry rather than none: the criterion
has now been applied to both harnesses instead of one.

**And it caught a stale claim of mine.** 6.52 ended by stating plainly that WebGL's `cube-mips` was
still vacuous and the WebGL side had no mip coverage at all. **6.53 fixed it one layer later** — the
allocation bug that attempt was blocked on turned out to be the cause, and the same two-tone, level-6
case went green and now guards the fix. It reads `level 6 red=128` today. The paragraph was true for
exactly one layer and has been marked superseded in place rather than left to be read as current.

That is the second worklog claim corrected after the fact, following 6.54's wrong diagnosis. Both were
written at the end of a long cycle about work that was still moving.

Verified: src tsc 0, 488 tests across 60 files, 86/86 WebGL pixels, 53/53 WebGPU pixels.

---

## Layer 6.62 — sweeping the worklog for claims the code has since overtaken

`WORKLOG-explicit-frame.md`. No source changed.

Two entries had already been corrected after the fact — 6.54's wrong diagnosis and 6.52's "still
vacuous" — and both shared a shape: a sentence about what is *not yet known*, written at the end of a
cycle, read later as though it still held. That is a class, so the whole worklog was swept for it
rather than waiting to trip over the next one. Four found, and **every one was resolved by the very
next layer**:

- **6.21** — "WebGL is single-canvas ... Recorded, not chased." 6.22 gave `FrameBackend` a
  `deviceCanvasTarget` and made `openRenderPass` throw; the blit was rejected for one pass per viewport.
- **6.36** — "What is not established is why." 6.37: `uploadCubeTextureData` had only an
  `isExternalImage` branch, so a cube built from typed arrays was created and never written.
- **6.52** — "whether the chain is absent or the sampler's min filter." 6.53: neither; the allocation
  read a flag `CubeCamera` had flipped off.
- **Layer 3** — "Still open from the plan: `compile(gpu, drawables, target)`." Done in layer 4, and it
  takes a camera too, because the warm must resolve through the pass's own context.

Each is marked in place, pointing at the layer that settled it. The originals stay: a record that says
what was known at the time is worth more than one quietly rewritten to look prescient.

**The pattern is one cycle's lag.** An open question stated at the end of a cycle is usually answered
at the start of the next, which is exactly when nobody re-reads the sentence that posed it. The cheap
habit is to close the previous entry when the answer arrives, not when the sweep does.

Verified: src tsc 0, 488 tests across 60 files, 86/86 WebGL pixels, 53/53 WebGPU pixels.

---

## Layer 6.63 — the documentation was the last place still describing the old renderer

`docs/{snippets.ts,README.template.md,build.js}`, `README.md`, `api.md`, `tst/tsconfig.json`.

6.46 swept `src/` for retired names and stopped there. `docs/` and the generated `README.md` were never
checked, and they are what a user reads first. Every one of them still taught the deleted API.

**`docs/snippets.ts` is the getting-started example and is in no tsconfig**, which is why it rotted
without a sound: `new WebGPURenderer({ antialias: true })`, `new RenderPipeline(...)`,
`renderer.domElement`, `renderer.setPixelRatio`, `renderer.setSize`. Two of those never existed in
gpucat at all — `domElement` and renderer-level sizing are three.js's shape, copied in and never
challenged, and sizing has belonged to `CanvasTarget` throughout.

It is rewritten to `init({ backend: webgpu() })` with the canvas wrapped in a `canvasTarget` and the
frame placed explicitly, and **added to `tst/tsconfig.json`** so it cannot rot again. Mutation-checked:
putting `renderer.setSize(800, 600)` back fails with `Property 'setSize' does not exist on type
'Renderer<WebGPUBackend>'`. The fix is that the example is now code the compiler reads, not prose that
happens to be fenced.

**The template claimed the wrong model, not just the wrong names**: *"You choose the backend by
choosing the constructor"* — you choose it by what you pass `init`. `renderer.backend` was documented
as returning `'webgpu' | 'webgl'`, which is now `renderer.api`; `backend` is the object. Ten references
across the backend section, the renderer section, the pipeline section and the transform-feedback
section, all corrected, with `RenderPipeline` replaced by `pass` + `fullscreen` + an explicit frame.

**And `api.md` had been quietly incomplete.** `docs/build.js` lists modules by path; four moved or were
deleted in the refactor (`renderer/renderer`, `renderer/render-pipeline`, `renderer/canvas-target`,
`renderer/read-pixels`) and the build *warned and carried on*, so the API reference simply omitted them.
It now documents `Renderer`, `BackendFactory`, `init`, `PassDesc` and `DrawOpts` — the frame API, which
had never appeared in the published reference at all.

Verified: src tsc 0, tst tsc 0 (now including the snippet), 488 tests across 60 files, 86/86 WebGL
pixels, 53/53 WebGPU pixels, docs build with no unresolved modules. `WebGPURenderer`, `WebGLRenderer`
and `RenderPipeline` appear zero times in `docs/`, `README.md` and `api.md`.

---

## Layer 6.64 — the docs build warned about the thing it was failing to do

`docs/build.js`, `.github/workflows/build-and-deploy.yml`, `api.md`.

6.63 found the API reference missing the whole frame API and fixed the module paths. It did not fix
why nobody noticed: `dtsForModule` returning nothing printed `· no .d.ts for module "..."` and
**carried on**, dropping that group from the reference and exiting 0. A build that succeeds while
omitting its subject is worse than one that fails.

It collects the unresolved modules now and exits 1 naming each, group and path:
`Renderer -> renderer/renderer`. Mutation-checked by breaking one path — exit 1 — and restoring — exit
0. Added to CI beside the gates from 6.57, so the failure is seen rather than scrolled past.

**The regenerated `api.md` is 712 lines longer**, which is the size of what had been silently absent.

**And I made 6.45's mistake again, in the same session that wrote it up.** The declaration of the
collector and the exit went in one script; the exit's anchor did not match, the script raised before
its single write, and the declaration went with it. The build then died with a `ReferenceError` at the
line the exit was supposed to be on. 6.45's entry says one write per edit, and I did not do it. The
cure was the same as before, and it worked the second time: separate write, assert the count is one.

Knowing the rule and following it are different things, and a worklog entry does not enforce anything.
What would is a habit at the moment of writing the script, not at the moment of writing the entry.

Verified: src tsc 0, tst tsc 0, 488 tests across 60 files, docs build exits 0 with every module
resolved. The three pre-existing lint findings in `docs/build.js` are on lines this change did not
touch.

---

## Layer 6.65 — fifteen empty sections in the guide, and they are not mine

`docs/build.js`. README and api.md byte-identical.

6.64 silenced one warn-and-carry-on in the docs build. The other kind was still firing fifteen times:
`<RenderCategory> category "render pass" not found`, and fourteen more. Each one renders **nothing**, so
the guide has fifteen empty sections where the node DSL reference should be.

**Categories come from `// comment` lines inside `index.ts`'s `export { ... } from './nodes/nodes'`
block, and that block has none** — 322 names, flat. So every named category misses.

**Checked whether I caused it, because I ran `biome check --write src/index.ts` twice this session and
`organizeImports` sorts export specifiers.** The committed `HEAD` has zero category comments too, so
this predates the session. Worth the two commands it took to be sure rather than assume.

**Not fixed, and the reason is that fixing it is a taxonomy, not an edit.** Classifying 322 exports
into fifteen categories is judgement about what the DSL's shape is, and doing it quickly would produce
a worse answer than the one missing. What is added is a budget: the build collects the misses and
fails above **15**, so a sixteenth cannot appear unnoticed. Mutation-checked — adding one category that
does not exist exits 1 and names it; removing it exits 0. At the budget it prints a one-line notice
rather than fifteen warnings nobody reads.

That is the same shape as `KNOWN_FAILURES` in the pixel runner: a gap held in code with a number, not
in prose with a promise. The difference is that this one is not the frame work's to close.

Verified: src tsc 0, 488 tests across 60 files, docs build exits 0 at the budget, README and api.md
unchanged by this layer.

---

## Layer 6.66 — the plan's five load-bearing claims, checked against the code

`PLAN-explicit-frame.md`. No source changed.

The last three layers drifted into docs infrastructure. Real work, and not this plan. So: the plan's
**core architectural claims** — the ones that are the deliverable rather than a detail — audited
against what the code does now, the way 6.48 did for **What goes away**.

1. **The API shape.** `Frame.pass(desc)`, `Frame.compute(desc?)`, `Frame.submit()`, `Pass.draw(mesh,
   opts?)`, `Pass.end()` are the declared members of `Frame` and `Pass`. No `render`, no ambient target.
2. **Pass identity is attachment shape, not object identity.** `buildCacheKey` is
   `${buildAttachmentState(target)}-${buildMrtState(mrt)}`. No object reference, and — as 6.48
   confirmed — no `passId` and no `callDepth`, both of which the plan says it removed.
3. **Recording is two phase, and encoding happens at `end()`.** `endPass` clears `frame.open` and then
   calls `encodePass` / `encodeComputePass` directly. The comment on that line carries the reason:
   cleared first, because encoding evaluates the graph and the graph may open a nested pass.
4. **Nothing is deferred to `submit()` but mips.** `submitFrame` finishes and submits the encoder, then
   flushes `mipTargets` and `mipTextures`. That exception is the one the plan names, because mip
   generation needs an encoder of its own.
5. **Compute is a pass on the same encoder.** `encodeComputePass` records into
   `backend._currentEncoder`, the one `beginFrame` created and `submitFrame` finishes.

All five hold. Together with 6.48 that is both halves of the plan audited against the code rather than
against its own earlier entries.

**What is left in the plan is three decisions, none of them mine**: the `pass` name meaning two things
(a node and a method, now across 46 files), the completion handle's remaining half (destroying a
resource *without* abandoning the frame), and what the scene-hierarchy tab should show for a pass with
no tree. Everything else in the Open list is struck through and each strike now has a layer behind it.

Verified: src tsc 0, 488 tests across 60 files.

---

## Layer 6.67 — the completion handle designed, not guessed

`PLAN-completion-handle.md` (new), `PLAN-explicit-frame.md`. No source changed.

Of the three decisions left, this is the one that can be moved without an answer from the consumer: it
needs a **design**, and a design can be argued from prior art.

**What 6.11 already did, and what it did not.** Disposing a target between its pass and the submit gives
`Destroyed texture used in a submit` on a real device — Dawn drops the frame, nothing throws in JS.
`Frame.targets` plus a check in `submitFrame` makes that **loud**. It does not make it **avoidable**:
the only safe way to dispose is still to have no frame open, which a room swap cannot promise.

**The prior art was read, not recalled, and the useful part was not the shape.** vgpu has
`done: Promise<void>` as a property with `submit(): void` unchanged — but its changelog says
*"`Frame.done` is resolve-only ... not a success check"*, with asynchronous execution errors routed to
a separate `gpu.onError`. That is a lesson recorded in a changeset, which means they shipped it the
other way first. A handle that rejects invites `await frame.done` to be read as "it worked", and it
cannot mean that: the errors that matter arrive from the device after the promise would have resolved.

Four options, and the recommendation is **`frame.done`, resolve-only, with a delete queue built on it
later rather than instead of it**. `submit(): Promise<void>` is rejected for changing the hottest line
in the API to hand back a value almost nobody wants, and for making a floating promise the default.
The delete queue is what a room swap actually wants, but it is a *policy* — when to drain, how deep,
what a twice-queued resource does — and policy is worth deferring until something real is asking.

**Named what would have to be proven**, because a design that does not is a wish: that `done` resolves
after the GPU work rather than after the call, that reading it twice returns one promise and never
reading it costs nothing, and that whatever it means on WebGL2 is written down rather than resolving
immediately and being quietly useless.

Verified: src tsc 0, 488 tests across 60 files, `plan-refs` green against both plans.

---

## Layer 6.68 — `frame.done`, built to the design and to the proofs it named

`src/renderer/core/{frame.ts,device-backend.ts}`, both backends,
`src/renderer/webgl/transform-feedback.ts`, `tst/frame.test.ts`, both harnesses. 491 tests, 54 WebGPU
cases.

6.67 recommended option B and listed what would have to be proven. Built, and each of the three
proven rather than assumed.

**Resolve-only, and the name says completion.** `Frame.done` is a getter, not a `submit()` return:
`submit()` stays `void`, so the hottest line in the API is unchanged and there is no floating promise
by default. `FrameBackend.awaitCompletion()` is WebGPU's `queue.onSubmittedWorkDone()`.

**Lazy and memoised, which is testable without a device.** Submitting alone starts no wait; reading
`done` starts one; reading it again returns the same promise. `beginFrame` clears the memo, because the
frame object is pooled and handing out the previous frame's promise would be a lie that resolves.
Reading `done` before `submit()` throws rather than resolving on nothing.

**The device proof is the one that matters**, and it is a case on both backends: draw green over a red
clear, `await frame.done`, then read. A wait that resolves early reads red. WebGPU passes; WebGL
passes with the fence signalling in ~26 ms, which is the number that says it is really waiting.

**WebGL2 has no queue to ask**, so `awaitCompletion` fences the command stream and polls across
event-loop ticks — reusing `clientWaitAsync`, which `readBufferAsync` already proved is the only shape
that signals on a single-threaded backend. It is exported and takes a label now rather than being
duplicated; a synchronous spin there never signals at all.

**Two ratchets fired and both were right.** `neutral-contract` refused the new member until it was
listed, which is where the argument for adding it gets made; `tst/frame.test.ts`'s stub backends
failed to compile until they implemented it. Neither needed thought, which is the point of them.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 491 tests across 60 files, 86/86 WebGL pixels,
**54/54 WebGPU pixels**, 2/2 shake bundles, biome clean on the eight touched files.

---

## Layer 6.69 — a feature nobody can find is not finished

`docs/README.template.md`, `README.md`, `api.md`, `PLAN-explicit-frame.md`,
`PLAN-completion-handle.md`.

6.68 built `frame.done` and proved it. `api.md` picked up the declaration on its own, because it is
generated from the exported type. The **guide** mentioned it zero times, and the guide is where
somebody learns the frame API — a reference entry only helps someone who already knows the name.

The frame-loop section says it now, and says the two things that are easy to get wrong:

- **It never rejects.** The errors worth knowing about arrive from the device after it would have
  settled, so they reach you through `onDeviceLost`. This is the part vgpu had to correct after
  shipping, per 6.67, and a doc that omits it invites `await frame.done` to be read as "it worked".
- **Reading it is what starts the wait**, so a frame nobody asks about costs nothing — and it is only
  meaningful between `submit()` and the next `frame()`, because the frame object is pooled.

**Open item 7 is struck.** The half that remains — a delete queue — is recorded as deferred with its
reason rather than as an open question: it is policy (when to drain, how deep, what a twice-queued
resource does) and no consumer is asking. `PLAN-completion-handle.md` now carries a **What was proven**
section in place of a promise.

That leaves two decisions in the plan, both genuinely needing an answer rather than a design: `pass`
meaning both a node and a method across 46 files, and what the scene-hierarchy tab shows for a pass
with no tree.

Verified: src tsc 0, 491 tests across 60 files, docs build exits 0 at its recorded budget, both plans
green under `plan-refs`.

---

## Layer 6.70 — "46 files" was one number for two different decisions

`PLAN-pass-naming.md` (new), `PLAN-explicit-frame.md`. No source changed.

Open item 1 has sat as *"the ambiguity is now in 46 files and a rename is a second sweep rather than a
free one"* since layer 4.41. That is one cost for what turns out to be two decisions, and they differ
by 4x:

| | call sites | where |
|---|---|---|
| node `pass(scene, camera)` | **50** | 34 examples, 11 tst, 4 lib, **1 src** |
| method `frame.pass(desc)` | **203** | src, both harnesses, every example |

So renaming the node is fifty mechanical sites, nearly all in examples. Renaming the method is four
times that **and** changes the central verb of the API this plan exists to introduce. The option that
sounded expensive is the cheap one, and nothing in the plan said so because nobody had counted.

**The name is also not arbitrary, which the plan did not record.** `pass(scene, camera)` is three's TSL
name verbatim — `src/nodes/display/PassNode.js:1085`, and 70 of three's own examples call it. gpucat's
node DSL is TSL-shaped throughout and its `depthPass` is named off the same family. `frame.pass(desc)`
is what vgpu calls the same method.

**Both names are right for their own thing**, which is why the collision is uncomfortable rather than
obviously wrong, and why measuring it does not settle it. The recommendation is `renderTexture` for the
node **or** keep both — not renaming the method — and the choice is about audience: if this DSL is
"TSL, ported", `pass` stays; if it is "our DSL, TSL-influenced", `renderTexture` describes what every
call site actually does with the result, and fifty sites is the price.

Left as a decision, with the numbers and the prior art attached so it is one that can be made in a
minute rather than deferred again.

Verified: src tsc 0, 491 tests across 60 files, `plan-refs` green against all three plans.

---

## Layer 6.71 — the last open item traced, and the obvious answer was the wrong one

`PLAN-hierarchy-treeless.md` (new), `PLAN-explicit-frame.md`. No source changed.

Open item 4 offered two answers — *"show nothing, or show the recorded draw list flat"* — without
saying where the tab's input comes from. Traced: `drawScene()` calls
`inspector.beginRenderScene(passId, scene, …)` at `src/scene/draw-scene.ts:21`, and that is the **only**
producer of a `SceneRecord`. A pass whose draws are recorded directly never goes through it, and
neither does `pass(contents, camera)` when `contents` is the callback branch of
`Object3D | ((pass: Pass) => void)`.

**The offered answer is the wrong one, and finding out took one grep.** `draw-calls.ts` already groups
render objects under their pass via `ro.lastPassLabel`, with bindings and bind group layouts per
object. Every draw in a treeless pass is listed there today, under the right pass. "Show the draw list
flat" is not filling a hole — it is a worse copy of a tab that exists, inside the one tab whose subject
is the thing these passes do not have.

**So the recommendation is neither option as written**: one leaf row per treeless pass — label, draw
count, and a line saying the draws are in Draw Calls. The failure in "show nothing" is not that the
information is missing, it is that the tab silently implies the pass did not run.

The draw count is the part that earns the row, and it is already on hand: `pass.count` at `end()`, and
the inspector's own `beginRender`/`finishRender` bracket. The proof to write is that the count matches
what Draw Calls shows for the same pass, because two tabs disagreeing about one pass is worse than one
tab saying nothing.

**All four open items now carry either a decision or a design**: 3 fixed in 6.26, 7 built in 6.68,
1 measured in 6.70, 4 traced here. Two await an answer, and both are a sentence's worth of judgement
rather than a question about the code.

Verified: src tsc 0, 491 tests across 60 files, `plan-refs` green against all four plans.

---

## Layer 6.72 — the sixth plan, never audited, and a dead shim inside it

`src/renderer/webgpu/render-objects.ts`, `PLAN-backend-symmetry.md`.

`PLAN-backend-symmetry.md` is the one plan in the tree this session never opened. Its status still read
*"proposed, not started"* while `PLAN-explicit-frame.md` records it discharged in layer 6.3 — and the
`Renderer` rebuild changed the very file list it is about, so the claim was worth re-checking rather
than inheriting.

**Its rule 1 is checkable**: one module per resource, same filename on both sides. Counted: **11
paired, 17 unpaired.** Most unpaired files are the API differences rule 4 allows —
`transform-feedback`, `context`, `state` on one side, `compute`, `mipmap-utils`, `bind-group-layout`
on the other. Two are not. `render-object-gl.ts` against `render-object-gpu.ts` is one job under two
names that the directory already disambiguates. And WebGPU carries both `prepare.ts` and
`render-objects.ts` where WebGL has only `prepare.ts`, which is decomposition rather than API — the
thing rule 4 forbids.

**Inside the second of those was a dead re-export shim.** `webgpu/render-objects.ts` opened by
re-exporting seven symbols from `core/render-objects` "for existing call sites". Its two importers use
`initRenderObject`, `initRenderObjectWithPromises` and `updateRenderObject` — all three defined
locally. **Nothing imported the re-exported block at all.** Deleted, and tsc, 491 tests and both pixel
harnesses are unchanged, which is what dead means.

Its header still described the shim afterwards, so it went too: four lines claiming a re-export that
no longer exists became three saying what the module is. A file's own doc is the last place a deleted
mechanism survives, because nothing compiles it.

The larger asymmetry is recorded, not resolved: merging or splitting per-object device work is a
judgement about where it belongs, not a rename, and this plan is not the place to decide it.

Verified: src tsc 0, 491 tests across 60 files, 86/86 WebGL pixels, 54/54 WebGPU pixels, 2/2 shake
bundles, biome clean on the touched file.

---

## Layer 6.73 — sweeping for the shim class, one dead and one load-bearing

`src/inspector/gui/index.ts` (removed).

6.72 found a dead re-export shim by walking into it. "No lazy compat shims" is a standing rule, so the
class is worth sweeping rather than stumbling on: every `export … from` outside `src/index.ts`, which
is legitimately the public surface.

Two candidates, and they went opposite ways — which is the reason to check rather than assume.

**`src/inspector/gui/index.ts` was dead.** Ten lines re-exporting the eight controller classes beside
it, and **nothing imported it**: `inspector.ts` reaches `GUI` at `./gui/GUI` directly, and no path
form of the barrel appears anywhere in `src`, `tst` or `examples`. Removed. tsc, 491 tests, both pixel
harnesses, the shake gate and the docs build are all unchanged, which is what dead means.

**`src/nodes/lib/core.ts` re-exporting `WgslType` is load-bearing.** It looks identical in shape, but
the chain is `schema → core.ts → nodes.ts (export *) → index.ts`: deleting it would remove a type from
the public API. Kept.

A barrel that nobody imports is worse than no barrel: it offers a second import path for every symbol
it lists, so two files can name the same class two ways and neither is wrong. That it survived is not
surprising — nothing type-checks a file into existence, and `tsc` is silent about a module with no
importers.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 491 tests across 60 files, 86/86 WebGL pixels, 54/54
WebGPU pixels, 2/2 shake bundles, docs build exits 0.

---

## Layer 6.74 — `tsc` never mentions a file nobody imports, so something else has to

`tst/unimported-modules.test.ts` (new), `src/texture/video-texture.ts` (removed). 492 tests.

6.73 removed a dead barrel and ended on why it survived: nothing type-checks a file into existence.
That is guardable. The test parses every `.ts` under `src` and `tst`, resolves each relative import and
`export … from` to a file, and fails on any `src` module nothing points at. Mutation-checked with a
two-line module nobody imports — reported by path; removed, green.

**It found two more on its first run**, and they were not the same kind of thing.

**`video-texture.ts` is superseded, and the evidence was already written down.**
`examples/src/example-webgpu-video-texture.ts` says it in a comment: *"no new texture type needed, a
video is just a `Texture` whose contents change"*. The example named after `VideoTexture` deliberately
does not use it. Removed — 31 lines, no exports from `index.ts`, no references anywhere.

**`texture-3d.ts` is unfinished, not leftover.** 194 lines whose `texture_3d` the schema already
describes, so it is the only 3D texture surface there is, and deleting it would throw the feature away
rather than tidy up. Allowlisted with that reason, which keeps it visible and stops a second one
joining it quietly — the same shape as `KNOWN_FAILURES` and the category budget.

The distinction is the whole value of looking: both files are unreachable, and one wanted deleting
while the other wanted wiring. A guard that only counted would have been wrong about one of them.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 492 tests across 61 files, 86/86 WebGL pixels, 54/54
WebGPU pixels, biome clean on the new file.

---

## Layer 6.75 — unreferenced exports, and a justification I had deleted in 6.30

`src/renderer/core/renderer.ts`.

6.74 guarded unreachable *modules*. One level down is unreachable *exports*, so they were counted
before anything was built: **18** symbols exported from `src` and referenced nowhere but their own
declaration. Tractable rather than noise, and three of them were mine — `disposeAllRenderObjects`,
`disposeRenderObjectsForMesh` and `clearRenderObjectGpu` lost their last reference when 6.72 deleted
the re-export shim.

**Which strengthens 6.72 rather than undoing it.** The shim was not merely dead, it was *holding dead
code alive*: re-exporting three functions nothing called made them look used. Deleting it did not
create three orphans, it revealed them.

**Following the fourth of that group found something better.** `disposeRenderObjectsForMaterial` has
exactly one caller, inside its own module, wired as `material._onDispose` — so disposal runs through
the hook and the manual helpers are an alternative path nobody takes. That is why they are unused.

**And it exposed a comment I deleted.** `Renderer.dispose()` clears the render-object maps without
disposing each object, which looks like a bug beside a `disposeAllRenderObjects` that does both. It is
deliberate, and the old `WebGPURenderer.dispose` said why: the device teardown invalidates every GPU
resource, and each `onDispose` only does bookkeeping in the maps being dropped. **I moved that code in
6.30 and left the reason behind.** Restored, as two lines rather than three, phrased for the neutral
class it now lives on.

No mass deletion. Fifteen of the eighteen are schema type guards and helpers whose absence would be a
judgement about the schema's surface, not tidying, and this plan is not the place for it. The number
is recorded so it can be chosen about.

Verified: src tsc 0, 492 tests across 61 files, 86/86 WebGL pixels, 54/54 WebGPU pixels, biome clean
on the touched file.

---

## Layer 6.76 — what the refactor left behind, diffed rather than remembered

`src/renderer/core/frame.ts`, `src/renderer/webgl/webgl-backend.ts`.

6.75 found one justification deleted while moving code in 6.30. That is a class, so it was diffed:
every comment line in `HEAD`'s two renderer files against every comment line in the files their code
now lives in. **184 comment lines on the WebGPU side became 14.**

**Most of that collapse is correct**, and saying so matters as much as the findings: the bulk
documented `domElement`, `setScissorTest`, renderer-level `clearColor`, `renderTarget` and viewport
state — APIs this plan deleted on purpose. A comment for a deleted thing should go with it.

Filtering the lost set for lines carrying a *reason* rather than a description narrowed 170 to a dozen,
and two of those were real:

**`dispatchIndirect` had no documentation at all.** The old `compute()` doc said the buffer *"must
have 'indirect' usage"*; the method on the public `ComputePass` type says nothing, and the requirement
survives only in `createIndirectBuffer`'s doc — findable if you already know to look at the buffer
factory rather than the method that rejects your buffer. One line, at the method.

**Why VAOs are missing from `info.memory`.** The old `_beginInfoFrame` explained that geometry VAOs
and per-RenderObject GL payloads live in WeakMaps and so cannot be counted. I compressed that doc in
6.31 and kept the half about backend-shaped fields, dropping the half that answers the question a
reader actually arrives with: *why is this number lower than I expect?*

Both are the same mistake in miniature: when a comment is shortened, the sentence that describes what
the code does survives and the sentence that explains an absence does not, because the second one has
no line of code pointing at it.

Verified: src tsc 0, 492 tests across 61 files, 86/86 WebGL pixels, 54/54 WebGPU pixels, biome clean
on the two touched files.

---

## Layer 6.77 — the WebGL half of the same diff, and one rationale that belonged elsewhere

`src/renderer/core/{renderer.ts,device-backend.ts}`, `src/renderer/webgl/webgl-backend.ts`.

6.76 diffed the WebGPU renderer's comments properly and only filtered the WebGL one. Finished: 127
comment lines against the 76 in the files that code now lives in, with the deleted APIs excluded so
what is left is knowledge rather than obituaries.

Two losses, both mine, both from compressions I made:

**`Renderer.info` had no documentation at all.** The old field said it is *"reset at this renderer's
own frame boundary, never from outside"* — which is the whole reason several readers can share one
`info` without disturbing each other. It became a bare `readonly info = createRendererInfo()` in 6.30.
Restored.

**Why memory stats are pulled and not pushed.** The old `_beginInfoFrame` said they are read live off
the caches rather than mirrored at every create/dispose site, because mirrored counters only ever
approximate what the maps know exactly. 6.31 kept the half about backend-shaped fields and dropped
that.

**Restoring it on the WebGL backend was the wrong first move**, and writing it twice made that obvious:
it is a policy both backends follow, not a GL fact. It sits on `DeviceBackend.readMemoryStats` now,
where the contract is, and the WebGL doc keeps only what is actually GL-specific — the vocabulary of
`memory.backend`, and the WeakMaps that cannot be counted.

That is the rule these three layers keep finding: a shared reason written on one implementation is
half-lost already, because the other implementation is where someone will look for it next.

Verified: src tsc 0, 492 tests across 61 files, 86/86 WebGL pixels, 54/54 WebGPU pixels, biome clean
on the three touched files.

---

## Layer 6.78 — compute was the one thing the frame port never reached

`examples/src/example-webgpu-{ball-cluster,compute-birds,compute-particles,compute-texture,indirect-compute,volume,voxels}.ts`,
`docs/{README.template.md,snippets.ts,build.js}`, `.github/workflows/build-and-deploy.yml`.

The plan has a section called "Compute is a pass on the same encoder" whose claim is that
cull-then-indirect-draw becomes one submit. **Not one of the 46 examples demonstrated it.** All seven
compute examples called `renderer.backend.compute([...])`, which opens a frame of its own and submits
it, and then opened a second frame to render. Two submits, a sync point between them, and an example
reaching through `renderer.backend` to do it.

`example-webgpu-indirect-compute.ts` is the case the plan section was written about: a compute pass
writes `instanceCount` into a `DrawIndirect` buffer and the draw reads it. It was doing that across
two submissions. All seven now open one frame, record a `frame.compute()` pass and the render pass on
it, and submit once.

The docs were worse, and the reason is structural. `docs/snippets.ts` is typechecked and lives in
`tst/tsconfig.json`, but it held **exactly one snippet**, so every other code block in
`README.template.md` is hand-maintained prose that nothing checks. The frame port updated all of them
except compute, which had drifted two APIs behind:

```ts
renderer.compute([{ node: sim, dispatch: [groups, 1, 1] }]);  // wrong receiver, wrong field name
renderPipeline.render();                                      // deleted class
```

`renderer.compute` had moved to `renderer.backend.compute`, `dispatch` had been renamed `counts`, and
`RenderPipeline` was replaced by `fullscreen()` several layers ago. Eight sites, plus a support-matrix
row and two feature bullets naming the old entry point.

**The fix is a second snippet, not better prose.** `gpu-compute` covers storage buffer to kernel to
`frame.compute()` to a material reading what the kernel wrote, and the Compute section now includes it
rather than restating it. `docs/build.js` exits 1 on a snippet group it cannot resolve, where it used
to `console.warn` and ship the raw `<Snippet …/>` tag into the README. Mutation-tested: a typo'd
`select=` gives exit 1.

One doc claim was wrong rather than stale, and it only surfaced because compute moved. The transform
feedback section said calling `backend.compute()` on WebGL2 is a compile-time type error, symmetric
with `backend.transformFeedback()` on WebGPU. **Only the second half is true.** `transformFeedback` is
a member of the WebGL2 backend and absent from the neutral one, so the compiler rejects it.
`frame.compute()` is on every frame by construction and throws at runtime on a WebGL2 backend. The
asymmetry is a consequence of the frame being backend-neutral, so the doc says that now instead of
claiming a symmetry that does not hold.

Last gap: `typecheck:examples` existed as a script and nothing ran it. CI builds the examples with
`vite build`, which transpiles without typechecking, so a type error in an example has never failed
CI. Added as its own step. It would **not** have caught this drift, since `backend.compute` still
compiles fine; what this layer shows is that the examples drifted for want of a reader, not a compiler.

`WebGPUBackend.compute` stays. Its consumers are now lib's three sites in `render/webgpu.ts` and the
two tests that exercise it as a wrapper, and its doc already says `frame.compute()` is the same work on
a frame's encoder.

The `plan-refs` guard caught both citations I added to the plan, which is the first time it has fired
on new text rather than drift. `docs/snippets.ts` failed because its `ROOTS` were `src`, `examples/src`
and `tst`, so docs were never a place a cited file could live; `docs` is a root now. `render/webgpu.ts`
failed correctly: it is lib's file, and `LIB_OWNED` already knows it as `src/render/webgpu.ts`, so the
plan uses that spelling rather than the set growing a third alias for one file.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 492 tests across 61 files, biome clean on the ten
touched source files, docs build clean at the recorded budget. No `src/` change this layer, so the
pixel harnesses were not re-run.

---

## Layer 6.79 — the other forty-seven code blocks

`docs/README.template.md`, `tst/doc-code-blocks.test.ts` (new).

6.78 fixed the compute blocks and left the premise untested: if one unchecked doc block had drifted,
how many others had? Counted rather than guessed. The rendered README has 49 `ts` blocks; **two** come
from the typechecked `docs/snippets.ts` and the other **47** are hand-maintained prose that nothing
compiles.

Extracting every `renderer.<member>` from those 47 and checking it against the real `Renderer` found
three:

- **`renderer.domElement`**, in the OrbitControls block. `domElement` does not appear anywhere in
  `src/renderer/` any more; the canvas belongs to the caller under this plan, so it is
  `new OrbitControls(camera, canvas)`.
- **`renderer.inspector.domElement`**. Wrong twice: `inspector` is `InspectorBase | null`, and
  `domElement` is on the concrete `Inspector`, not the base. The examples work around it with
  `(renderer.inspector as Inspector).domElement`; the docs now keep the local and assign from it,
  which is what a reader should copy.
- **`renderer.transformFeedback(...)`**, in a block sitting directly above prose that correctly says
  `renderer.backend.transformFeedback(...)`. Three prose sites had the same stale receiver.

**The guard is the point, not the three fixes.** `tst/doc-code-blocks.test.ts` pulls `Renderer`'s
members off the type checker and asserts every member the README reaches for is one of them.
Mutation-tested by putting `renderer.domElement` back: it names `domElement` and fails. It scans only
the template, since the snippets are typechecked already.

A second test in the same file keeps doc code ASCII. Two arrows and an ellipsis had got into code
comments a reader is meant to copy. Scoped to the doc blocks deliberately: `src/` has 3301 box-drawing
characters, 327 em dashes and 219 arrows, nearly all in comments and inspector UI strings, and
conforming the engine to that preference is a separate decision that is not mine to take inside this
plan.

Verified: 494 tests across 62 files, tst tsc 0, biome clean on the new test, docs build clean at the
recorded budget. No `src/` change this layer.

---

## Layer 6.80 — the retired-names guard was only looking at src

`tst/retired-names.test.ts`, `tst/webgpu-render/cases.ts`, `tst/webgl-render/harness.ts`,
`src/renderer/webgl/render-target.ts`, `src/renderer/core/render-objects.ts`.

6.79's `renderer.domElement` should have been caught by the guard 6.46 built for exactly this, and was
not, for two reasons worth separating. The guard scans `src` only, and `domElement` is not a retired
name anyway: it is a live member of `Inspector` and of the controls, and only `renderer.domElement`
went. **A name list has the wrong granularity for a member that moved rather than died**, which is why
6.79's member-vs-type check is the right gate there and this one stays a name list.

The first reason is fixable and was. Widening the roots to `examples/src`, `tst` and `docs` found two
live references the src-only scan could not see:

- `tst/webgpu-render/cases.ts` documented its `draw-material` case as "the per-submission override,
  which is what replaced the ambient `overrideMaterial`". `overrideMaterial` has no referent anywhere
  in the repo, so that sends a reader looking for something that does not exist. It now says what
  `DrawOpts.material` does.
- `tst/webgl-render/harness.ts` called its composite "the explicit form of what `RenderPipeline`
  does", another deleted class, and labelled it "makecat-faithful", which is a cross-repo attribution
  this repo should not carry.

The examples were swept too and are clean: the only `backend.` reach-throughs left are
`transformFeedback` and `readBufferAsync`, both genuinely WebGL2-only, and `clearColor` is set on the
target rather than the renderer in all 15 examples that set it. 6.78's port did its job.

Mutation-tested by putting `overrideMaterial` back into `cases.ts`: the widened guard names the file
and line, and the src-only version did not.

**The sweep also found what a name list structurally cannot catch.** `src/renderer/core/render-objects.ts`
opens by saying it owns "per-pass nested WeakMaps" and that "each passId maps to a chain of WeakMaps",
while the field two screens down correctly says "a pass's label is not part of the identity". The
header describes the `passCaches` structure this plan deleted; `passCaches` appears nowhere in `src`.
No retired *name* is present, so nothing was ever going to flag it. A reader meets the contradiction
and has to guess which half is true. The same header called WebGL2 the "future" backend, which it has
not been for a long time.

Corrected, and three restating docs in the same file went with it: a `/** Create a new RenderObjects
state. */` above `createRenderObjectsState`, and a numbered list explaining that `getRenderObject`
looks in a cache and creates on a miss.

Verified: src tsc 0, tst tsc 0, 494 tests across 62 files, biome clean on the touched files apart from
pre-existing format debt at unrelated lines in the two harness files. The only `src/` changes are
comments, so the pixel harnesses were not re-run.

---

## Layer 6.81 — comments citing modules that are not there

`src/renderer/webgl/{buffers.ts,probe.ts,state.ts,bindings.ts,programs.ts,texture-bindings.ts}`,
`tst/cited-files.test.ts` (new).

6.80 found a header describing a deleted structure and noted that a name list could never have caught
it. The generalisation is worth a gate: this codebase cites sibling modules in comments constantly,
and a rename leaves the citation pointing at nothing while `tsc` stays silent and every test passes.

Measured across `src`, `examples/src`, `tst` and `docs`: **two dangling citations**.

- `webgl/buffers.ts` credited the one-GL-buffer-per-`GpuBuffer` invariant to `webgl/renderer.ts`,
  which this plan deleted in 6.27-6.32. The invariant is real and still documented, now at
  `readBufferAsync` in `webgl-backend.ts`.
- `webgl/probe.ts` said it reuses `uniforms.ts` to update and bind the object's std140 UBOs. That
  module is `bindings.ts`, and has been for longer than this plan.

Two is a small number and that is the point: the codebase is accurate, which is exactly the condition
under which a cheap gate is worth adding, because the next rename is the one that breaks it.
`tst/cited-files.test.ts` resolves every backticked `*.ts` in every comment. Mutation-tested by
putting `uniforms.ts` back into `probe.ts`.

A fourth guard interaction, worth recording because it is now a pattern: `plan-refs` rejected this
layer's own worklog-to-plan summary for naming the deleted `webgl` renderer module as a path. The plan
is a historical record and has to be able to say what went, but `plan-refs` exists to check the plan,
so it cannot carry the exemption `retired-names` gives the plan and worklog. The plan names deleted
modules in prose now rather than as backticked paths, which keeps the guard strict.

Its allowlist is keyed by **citing file plus citation**, not by citation alone. A guard that records
what it deleted has to be able to name it (`unimported-modules.test.ts` names
`inspector/gui/index.ts`, which 6.73 removed), but naming it there must not make the same dead path
resolve anywhere else. The mutation test confirms that split: `uniforms.ts` is allowlisted in this
guard's own docstring and still dangles in `probe.ts`.

**Five comments credited "the reference renderer"** and are gone. That phrase names another codebase
a reader of this one cannot open, and in four of the five it was doing no work beyond attribution:
`programs.ts` "ports the reference renderer's `compile()` program half" before describing, correctly,
compile-attach-link-check. The fifth carried something real in its second clause, that `Material`'s
fields are WebGPU vocabulary with no second enum set to translate through, and that is what
`state.ts` says now. `bindings.ts`'s sentence was pure redundancy: its header already states two
paragraphs earlier that uniform values must go through UBOs and never loose `glUniform*`.

Recorded, not chased: the two backends have drifted in documentation shape as much as they once did
structurally. Every `webgl/` module carries a 10-26 line file header; almost every `webgpu/` module
has none, because this plan's layers rewrote them. That is a real asymmetry and picking a house shape
for it is a decision, not a cleanup. `probe.ts:21` also has a pre-existing `useImportType` warning,
untouched here since it is unrelated to the comment edit.

Verified: src tsc 0, tst tsc 0, 495 tests across 63 files, biome clean on the touched files apart from
that pre-existing warning. The only `src/` changes are comments, so the pixel harnesses were not
re-run.

---

## Layer 6.82 — the symmetry rule, mechanised, and a recorded violation withdrawn

`tst/backend-symmetry.test.ts` (new), `PLAN-backend-symmetry.md`.

Four layers on comment and doc accuracy (6.78-6.81) reached the point where 6.81 found two dangling
citations in the whole repo, so this one goes after the structural question the fronting `Renderer`
was actually for: the user's reason for wanting it was *"having a fronting orchestration layer will
force us to align the implementations. They have drifted structurally before."*

`PLAN-backend-symmetry.md` states that alignment as four rules and has been audited by hand twice,
in 6.3 and 6.72. **Its own module table had gone stale between those audits**, still listing
`webgl/buffers.ts`, `webgpu/samplers.ts` and `webgpu/render-target.ts` as missing and naming WebGL's
bind-group module `uniforms.ts`, which it stopped being in the plan's own step 3. A table in the
document that says what work remains, describing work already done, is worse than no table.

`tst/backend-symmetry.test.ts` derives the pairing from the two directories and asserts **both**
directions:

- an unpaired module must carry a justification naming an API difference, and
- a justification must name a module that is still unpaired.

The second half is the one the hand audits kept missing, and it is the half that would have caught
the stale table. Mutation-tested by justifying `webgl/textures.ts`, which has a sibling: it is
rejected by name.

**A violation 6.72 recorded turned out not to be one, and checking it was the substance of this
layer.** 6.72 listed `render-object-gl.ts` against `render-object-gpu.ts` as a rule 1 breach, on the
grounds that the directory already disambiguates the name. It does, for the filename. But all nine
modules that import either one also import `core/render-object`, so the neutral `RenderObject` and
the device-side cache sit in scope together at every call site. The suffix is carrying the
disambiguation on the *symbols*. Dropping it would produce a `render-object.ts` whose exports still
had to be `getRenderObjectGpu` and `RenderObjectGpuCache` to avoid colliding with core's, which is a
filename that no longer describes what it exports. Withdrawn, and recorded as an earned pair beside
`programs.ts`/`pipelines.ts`.

That leaves one real rule 4 breach, unchanged: WebGPU carries both `prepare.ts` and
`render-objects.ts` where WebGL keeps that work in `prepare.ts`. It stays recorded rather than
resolved, because where per-object device work belongs is a judgement rather than a rename, and the
guard now names it as a violation in its own justification string rather than letting it read as
earned.

Verified: tst tsc 0, 497 tests across 64 files, biome clean on the new test. No `src/` change this
layer.

---

## Layer 6.83 — rule 3, and a scan that lied to me first

`tst/core-has-no-device.test.ts` (new).

6.82 mechanised the symmetry plan's rules 1 and 4. Rule 3 is the load-bearing one and was unguarded:
*"core holds decisions that must not differ, and machinery with no device in it. Core never touches a
device handle."* That property is the whole reason one `Renderer` can serve both backends, and the
only thing checking any of it was `neutral-contract`, which reads two type declarations.

**My first measurement said ten of the 29 core files touch a graphics API, and it was wrong.** The
scan skipped lines beginning with `*` or `//` and so missed one-line `/** … */` JSDoc, which is how
this codebase writes most of its comments. Every hit in `frame.ts`, `renderer-ops.ts`, `compile.ts`,
`init.ts` and `pass-context.ts` turned out to be a comment or an error string: *"a WebGL2 context
belongs to one canvas for its lifetime"*, `'[frame] compute passes need the webgpu backend'`. Core is
clean. Had I written the layer from the first number I would have reported a ten-file rule violation
that does not exist.

So the guard walks identifiers off the AST rather than matching text, which excludes comments and
string literals by construction. A backend named in a message is not a backend touched.

The real distinction rule 3 needs is not "no WebGPU name in core" but **no device object**. Four
`GPU*` types are legitimately there and must stay: `GPUTextureFormat`, `GPUBlendFactor`,
`GPUBlendState`, `GPUFeatureName`. Those are string unions, and they are gpucat's neutral vocabulary
rather than WebGPU's property: `Material` is authored in them on both backends and `webgl/state.ts`
translates them to GL at the edge, which is the fact `state.ts`'s header carries since 6.81.

The guard is therefore an allowlist of that vocabulary rather than a denylist of handles, so a
`GPU*` type entering core has to be classified on the way in instead of being missed because nobody
predicted it. Mutation-tested both directions: a `device?: GPUDevice` field added to `Frame` is
named and rejected, and an allowlist entry core does not use is named and rejected.

Verified: src tsc 0, tst tsc 0, 499 tests across 65 files, biome clean on the new test. No `src/`
change this layer.

---

## Layer 6.84 — rule 2, where the stats actually came from

`src/renderer/webgpu/{webgpu-backend.ts,pipelines.ts,bind-group-layout.ts}`,
`src/inspector/renderer-inspector.ts`, `tst/cache-owns-its-stats.test.ts` and
`tst/memory-stats-source.test.ts` (new).

Rule 2 of the symmetry plan is *whoever owns the cache owns the release, the stats and the teardown*.
Putting the two `readMemoryStats` side by side makes the breach obvious:

```
webgl:   memory.buffers = Buffers.getBufferCacheStats(this._buffers) -> bufferCount + rawCount
webgpu:  memory.buffers = this.buffers.bufferCount + this.buffers.rawCount
```

WebGL asks each owning module. WebGPU reached into four cache fields directly, **while
`webgpu/buffers.ts` exported `getBufferCacheStats` and nothing called it**. `webgpu/pipelines.ts` had
a `getStats` the inspector used and `readMemoryStats` ignored in favour of `.renderPipelines.size`.
Rerouted, and `getStats` renamed to `getPipelineCacheStats` so it reads as the checklist's
`getXStats` and as WebGL's `getProgramCacheStats` does.

**The same breach one level down, which is the more interesting one.** `PipelinesStats` carried
`bindGroupLayoutCount: state.bindGroupLayoutCache.cache.size` — the pipeline cache reporting a count
belonging to `bind-group-layout.ts`, which creates and disposes that cache. `getBindGroupLayoutCacheStats`
lives on the owner now, and the inspector's frame record carries `bindGroupLayoutStats` beside
`pipelineStats` rather than inside it.

**Two first reads looked like violations and were not**, which is becoming the reliable part of these
sweeps. `webgpu/textures.ts` exports `setupTextureDispose` and `webgl/textures.ts` exports nothing of
the kind, which reads as a missing release path until you grep: WebGL sets `texture._onDispose` from
an internal function at `textures.ts:417`. Same capability, different visibility. And the five-function
checklist appeared to fail on `textures.ts` for stats on both sides, until the tally path showed both
backends reporting identically through `cache.tally` and core's `readTextureTally`.

`tst/cache-owns-its-stats.test.ts` holds the rule: a module exporting `create*Cache` or `create*State`
must export a `get*Stats`, with frame and per-draw state excluded by name and four real gaps recorded
with reasons rather than left invisible. Both directions again, so a recorded gap must be removed once
the module grows stats. Mutation-tested by unexporting `getSamplerCacheStats`.

**Nothing covered `readMemoryStats` on either backend, in either shape.** `tst/memory-stats-source.test.ts`
pins each count to its owner rather than to a number. The first version of it was vacuous: against an
idle stub every count is zero, so `0 === 0` held whatever `readMemoryStats` did. It runs a dispatch
first and asserts the caches are non-empty before comparing. Mutation-tested by zeroing
`memory.backend.computePipelines`.

Verified: src tsc 0, tst tsc 0, 502 tests across 67 files, biome clean on the touched files apart
from pre-existing format debt at unrelated lines in `renderer-inspector.ts`. The WebGPU pixel harness
was re-run because this layer changes `src` behaviour rather than comments: 54/54.

---

## Layer 6.85 — four frame-record fields nobody read, one of which I added last layer

`src/inspector/renderer-inspector.ts`, `tst/frame-record-is-read.test.ts` (new).

6.84 noted in passing that `pipelineStats` looked unread and set it aside as scope creep. Measured
properly: `bufferStats`, `pipelineStats`, `bindGroupLayoutStats` and `renderObjectStats` are written
into `FrameRecord` every frame and **read nowhere in `src/`**. `FrameRecord` is not exported from
`index.ts`, so there is no consumer outside the tree either.

They duplicated a source that was already correct. The Memory tab reads `renderer.info.memory` and
calls `getRenderObjectsStats(renderer._renderObjects)` itself, on demand, when it draws. The frame
record recomputed the same four numbers on every frame, including a walk of the RenderObject set, so
the ring could hold them unread.

**One of the four is `bindGroupLayoutStats`, which I added in 6.84.** Rule 2 was right that
`PipelinesStats` should not report a cache owned by `bind-group-layout.ts`, and the fix in
`readMemoryStats` stands, because `info.memory` is genuinely read. Moving the same number into the
frame record instead of deleting it was the mistake, and the reason is plain: I checked who *owned*
the stat and never checked who *read* it. The comment sitting above that literal already said
"nothing else consumes them", so the deadness was documented rather than acted on, which is the
weaker half of the same habit.

`_resolveTimestamps(frameId, record)` fell out with them. Its only use of `frameId` was `void frameId;`
in a catch block, an explicit admission that the parameter is dead while the record beside it carries
the same number.

`tst/frame-record-is-read.test.ts` reads `FrameRecord`'s fields off the AST and requires each to be
read somewhere under `src/inspector`. `tsc` cannot do this: an object property counts as used by
being written, which is exactly how four fields survived. Mutation-tested by re-adding a `bufferStats`
field.

`frameId` is exempt and named as such. It is the record's key in the ring, costs one number and
duplicates nothing, which is a different thing from a recomputed snapshot of another module's cache.
An exception on the guard's first day is worth stating rather than hiding: the rule the guard actually
encodes is "no unread recomputed state", not "no unread field".

Verified: src tsc 0, tst tsc 0, 503 tests across 68 files, biome clean on the new test, and
`renderer-inspector.ts`'s only complaints are the pre-existing format debt at two unrelated regions
that this layer's deletions shifted up the file. The pixel harnesses were not re-run: the deleted code
produced nothing any pass reads.

---

## Layer 6.86 — two ambient-state leftovers, and a false positive from my own guard

`src/renderer/core/pass-context.ts`, `tst/frame-record-is-read.test.ts`.

6.85's finding generalises, so the same measurement ran across every `*State` / `*Cache` / `*Entry`
type in `src/renderer`. It reported three never-read fields. **Two were real and the third was my
scan being wrong**, which is the more useful half of the layer.

Real: `RenderContextsState.defaultClearDepth` and `defaultClearStencil`, documented as "clear values a
pass falls back to when its desc names none", initialised to 1 and 0, and read by nothing. The
fallback they describe is real but lives in `pass-desc.ts` as literals:

```ts
clearDepthValue: typeof desc.clearDepth === 'number' ? desc.clearDepth : 1,
clearStencilValue: typeof desc.clearStencil === 'number' ? desc.clearStencil : 0,
```

These are the depth and stencil siblings of the ambient `clearColor` this plan deleted. "What goes
away" caught the colour and missed these two, because `clearColor` was on the renderer where it was
visible and these sat on a state bag nobody had reason to open.

False: `TfNodeCache.compiled` is read four lines below where it is stored, as
`const { compiled, programInfo, vao } = cache`. My scan matched `.compiled` and destructuring does not
produce that shape. I had already deleted the field and had to put it back; `tsc` named it, which is
the only reason the round trip was safe.

**That blind spot was also in the guard I shipped in 6.85**, which counted reads with the same
`.field` regex. A guard that reports a destructured field as dead invites someone to delete live code,
and a false positive there is worse than no guard at all. `readCount` walks the AST now and counts
property access and binding elements both. Mutation-tested in both directions: a field read only via
`const { probe } = frame` passes, and a field read nowhere still fails.

Three of the last four layers have had a first measurement that did not survive checking. The pattern
is consistent enough to name: text matching finds the shape I pictured, not the shape the language
allows, and the check is cheap next to the cost of acting on it.

Verified: src tsc 0, tst tsc 0, 503 tests across 68 files, biome clean on the touched files apart from
two `useOptionalChain` warnings in `pass-context.ts` that are present at HEAD and unrelated to the
deleted fields. `transform-feedback.ts` is back to its pre-layer content. No pixel re-run: the two
deleted fields were read by nothing, so no pass could observe them.

---

## Layer 6.87 — the pooling claim, finally tested

`tst/frame-pooling.test.ts` (new).

Nine layers of audit work had reached the point where 6.86 found two dead fields in the whole
renderer, so this one goes back to a claim the plan makes and nothing checks. `Frame`'s own doc says
it "holds both pass pools for the life of the renderer, so a steady-state frame allocates nothing",
and the performance section leans on exactly that as the answer to the per-frame allocation the
explicit frame introduces: a `PassDesc` literal, a `Pass`, a recorded draw list, and the loss of
`RenderList`'s pooling on a consumer that records draws directly.

`frame-encoder.test.ts` has thirty tests and not one of them touches pooling. It was a performance
claim in a type doc, load-bearing for a design decision, with no gate under it.

Four tests now, written against object identity rather than heap size so there is no GC noise to
average away:

- a second frame is the same `Frame` object and hands back the same `Pass` objects,
- a shorter frame reuses the longer one's `DrawRecord` slots, with `count` shrinking and `records`
  staying put,
- the pass pool grows to the deepest frame and stays there,
- compute passes pool the same way, dispatch slots included.

Mutation-tested per mechanism rather than in bulk, which is what makes them worth keeping. Forcing
`openPass` to allocate a fresh `Pass` fails all four. Truncating `pass.records` to `count` fails only
the draw-slot test, and doing the same in `recordDispatch` fails only the compute one. A test that
fails for every break is a test that is really only checking that the frame runs.

Recorded, not chased: the plan's other two performance claims. **Correction, layer 6.88: the submit
claim was already gated** by `compute then render is one encoder and one submit`, the first test in
`compute-pass.test.ts`, which asserts `encoderCreations` and `submits` are both 1. Recording it as
unmeasured was a failure to look. That file also has `compute passes are pooled across frames`, which
overlaps this layer's compute test: the existing one asserts the pool does not grow, and the new one
adds object identity and dispatch-slot reuse on top.

Verified: src tsc 0, tst tsc 0, 507 tests across 69 files, biome clean on the new test. `frame.ts` is
back to its pre-mutation content, checked by grep rather than assumed. No `src/` change this layer.

---

## Layer 6.88 — a leaked error scope, found by pulling on a claim I had recorded wrong

`src/renderer/webgpu/frame-backend.ts`, `tst/stub-gpu.ts`, `tst/error-scope-balance.test.ts` (new).

6.87 recorded two performance claims as unmeasured. Checking the first one before acting on it found
it already gated: `compute then render is one encoder and one submit` is the **first test** in
`compute-pass.test.ts` and asserts exactly what I said needed asserting. The 6.87 entry is corrected
in place. That file also holds `compute passes are pooled across frames`, which overlaps 6.87's
compute test; the existing one asserts the pool does not grow, and mine adds object identity and
dispatch-slot reuse, so it strengthens rather than duplicates. Both facts were one grep away.

The second claim, one fewer `pushErrorScope`/`popErrorScope` pair per nested render, turned out to be
unmeasurable in the stated form and to be sitting on top of a real bug.

**`encodePass` pushed a validation scope and reached its `popErrorScope` past three statements that
can throw.** `prepareRecordedDraws` evaluates the node graph, so `assertVertexBuffers` throws there
by design, naming a missing buffer. `resolveAttachments` and `beginPass` sit outside any `try` at all.
`encodeDraws` has a `finally` that ends the GPU pass and then rethrows. Every one of those paths
skipped the pop.

The consequence is worse than the leak. WebGPU error scopes are a device-level stack, so a scope that
is never popped means every later `popErrorScope` returns the wrong scope's error: a validation
failure gets reported against whichever pass happens to pop next, and the stack grows for the life of
the device. The failure mode is a misattributed error message, which is the hardest kind to trace back
to its cause.

`submitFrame` had the same shape, with `encoder.finish()` between the push and the pop.

Both wrapped so the pop runs from a `finally`. The stub's `pushErrorScope`/`popErrorScope` were
no-ops, so they now move an `errorScopeDepth` counter, and `tst/error-scope-balance.test.ts` asserts a
multi-pass frame ends at zero and that a pass throwing in prepare still pops.

Mutation-tested against the pre-fix shape, which took two attempts: the first revert left a `try` with
no handler and failed to compile, which is not evidence of anything. Restoring the original control
flow properly, a throwing pass leaks exactly one scope. The happy-path test passes either way, as it
should; only the throwing case regresses, which is why it is worth having.

Verified: src tsc 0, tst tsc 0, 509 tests across 70 files, 54/54 WebGPU pixels on a real device,
biome clean on the three touched files.

---

## Layer 6.89 — the same bug in the sibling function, and compute had no scope at all

`src/renderer/webgpu/frame-backend.ts`, `tst/stub-gpu.ts`, `tst/error-scope-balance.test.ts`.

6.88's question generalised: what else is acquired before a region that can throw? Two verified
negatives first, because they are the reason the third finding is worth trusting.

**Both backends' `encodePass` are correctly bracketed and symmetric.** Each opens the render scope and
the inspector's pass, then calls an inner `encodeOpenPass` inside a `try`, with `finishRender` and
`endRender` in the `finally`, carrying the same comment on both sides. `encodeOpenPass` balances
`s.depth++` and `beginPass` the same way on both. The error scope 6.88 fixed was the one thing in
that function not already covered.

**`endPass` in `core/frame.ts` is also correct, and deliberately so.** It sets `frame.open = null`
*before* encoding, with a comment saying why: encoding evaluates the graph, which may open a nested
pass. A throw out of `encodePass` therefore leaves the frame with no open pass, which is what makes
the next `frame()` recoverable rather than permanently wedged.

**`encodeComputePass` is where it was wrong, twice.** It had no validation error scope at all, so a
compute dispatch with a bad binding surfaced only at submit, attributed to the whole frame, while a
render pass in the same frame would have said `pass '<id>'`. And `perf.start(label)` had no matching
`finally`, so a throw out of `encodeDispatches` left the inspector's perf stack open for the rest of
the session. That second one is 6.88's bug exactly, in the function next door, and I would not have
looked at it if 6.88 had stopped at its own fix.

Both fixed together: the scope is pushed and popped from a `finally` that also ends the perf span,
and its message names the pass the way the render one does.

**The two new tests catch different things, and saying which matters.** `errorScopePushes >= 2`
catches the original state, where compute pushed nothing: mutated back to no scope at all, it fails
and the throw test passes. The throw test catches an unbalanced scope, not a missing one. A test that
only fires on the mutation you happened to try is worth less than knowing which mutation it fires on.

Verified: src tsc 0, tst tsc 0, 511 tests across 70 files, biome clean on the three touched files.
WebGPU pixels re-run because this changes the compute encode path.

---

## Layer 6.90 — the WebGL half of the throw-balance sweep

`src/renderer/webgl/transform-feedback.ts`, `tst/webgl-render/harness.ts`.

6.88 and 6.89 both landed on WebGPU, so the question was whether WebGL had the same class of
acquisition-before-a-throwable-region. The candidate is transform feedback, which is the one place the
GL backend enables global state (`RASTERIZER_DISCARD`) and binds an object that outlives the call.

The discard enable and disable turned out to be fine: nothing between them can realistically throw.
The leak was earlier, and a comment pointed straight at it while describing the opposite.

```ts
// Validate every declared input/output has a buffer.
for (const attr of compiled.inputAttributes) { ... }
```

**It validates inputs only.** The matching output check sat sixty-eight lines further down, past
`useProgram`, the UBO binds, the texture binds, `bindVertexArray`, the attribute setup and
`bindTransformFeedback`. A kernel called with a missing output buffer threw with the program, the VAO
and the transform-feedback object all left bound, and nothing unwinding them.

The fix is not a `try`/`finally`. The input check already has the right shape, so the output check
moved up beside it: validate everything before touching GL, and the throw happens with no state to
unwind. The late check became unreachable and went. The comment is true now, and says why the
ordering matters rather than what the loops do.

`tf-unbound` in the WebGL harness reads the bindings back rather than the pixels, because the bindings
are the leak: `TRANSFORM_FEEDBACK_BINDING`, `CURRENT_PROGRAM` and `VERTEX_ARRAY_BINDING` must all be
null after the throw. It reports `tf=true prog=true vao=true`.

Verified: src tsc 0, tst tsc 0, WebGL pixels all pass with the new case.

---

## Layer 6.91 — the backend factories were building the renderer

`src/renderer/core/init.ts`, `src/renderer/{webgl,webgpu}/backend.ts`, `tst/init.test.ts`.

Isaac asked why `webgl()` and `webgpu()` construct and return a `Renderer` rather than their backend.
Reading it, there is no reason, and three things were wrong with it.

**`init` had been reduced to a forward.** Its whole body was `return opts.backend.create(opts.target)`.
The question it was created to answer — what does `init` do that a constructor does not — had the
answer "nothing".

**The only `new Renderer` in the codebase existed twice**, once in each factory, as
`new Renderer(new XBackend(opts)).init()`. That is the line the fronting class was introduced to own.

**The dependency ran backwards.** `webgl/backend.ts` and `webgpu/backend.ts` both imported
`core/renderer`, so each backend depended on the orchestration layer that sits on top of it.

Now the factories build a backend and `init` builds the renderer over it. `BackendFactory` loses its
`R extends Renderer` parameter for `B extends DeviceBackend`, the discriminant becomes `B['name']`
where the name actually lives instead of `R['api']` a level up, and `Renderer<B>` falls out of `init`'s
return type rather than being threaded through the factory. `gpu.backend.device` still needs no cast,
which is what `init.test.ts` already asserted and still does.

A test pins the layering rather than leaving it a property of how the file happens to read: a factory's
`create` returns something that is a `WebGPUBackend` and is **not** a `Renderer`, and `init` returns
one that is.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 512 tests across 70 files, 54/54 WebGPU pixels, WebGL
pixels all pass, 2/2 tree-shake bundles, biome clean on the four touched files.

---

## Layer 6.92 — a backend bound to the name `renderer`

`src/renderer/webgpu/read-pixels.ts`, `src/inspector/tabs/compute-calls.ts`,
`tst/renderer-name-means-renderer.test.ts` (new).

6.91's inversion was spotted by Isaac, not by any of the sweeps, so this one went looking for the same
shape elsewhere: a lower layer reaching for a higher one. Four backend modules still import
`core/renderer`, all `import type`, all for the back-reference the `DeviceBackend` contract hands them
in `init(renderer)`. That is bidirectional by design and not the same defect.

Surveying what the backends actually use off `renderer` reported three suspects, and **all three were
my regex over-reporting**, for the fourth time in this run: `renderer.compile` was inside a comment,
`renderer.init` came from two error strings, and `renderer.textures` / `renderer.device` came from a
parameter declared `renderer: WebGPUBackend`.

That last one is a real defect rather than a misreading, and it is what made the survey wrong.
**Five bindings named `renderer` held a backend**, one in `read-pixels.ts` and four in
`compute-calls.ts`, in a codebase where `renderer` is also a genuine `Renderer<DeviceBackend>` field
on those same backends. `renderer.pipelines` and `renderer.info` read alike and come from different
objects. Renamed to `backend`.

`tst/renderer-name-means-renderer.test.ts` walks parameter, variable and property declarations named
`renderer` and rejects any annotated with a backend type. The cost of the ambiguity is not theoretical:
it is the wrong measurement two paragraphs up.

Recorded, not chased: `webgl-backend.ts` and `webgpu-backend.ts` both declare
`renderer: Renderer<DeviceBackend> = null!`. A backend is constructed before its renderer exists, so
the field cannot hold a real value at construction, and `null!` is the shape that lies about it. The
honest fix is a nullable field with assertions at the reach sites, or not holding the renderer at all;
both are larger than this layer and neither is a rename.

---

## Layer 6.93 — BackendFactory deleted

`src/renderer/core/init.ts`, `src/renderer/{webgl,webgpu}/backend.ts`, `src/index.ts`,
`tst/init.test.ts`, `tst/plan-refs.test.ts`, 50 example and test files, `docs/README.template.md`.

Isaac asked what `BackendFactory` buys over constructing the backend at the call site. Measured
rather than argued:

- **`factory.name` is read by no code in `src`.** Every real discriminant (`frame.ts`'s
  `backend.name === 'webgl'`, `renderer.api`) reads it off the constructed backend. One test asserted
  it.
- **`create( target )`'s parameter is used by one of the two backends.** `webgpu()`'s was
  `create: () => new WebGPUBackend( opts )`, ignoring the argument.

What it did buy is the overload pair making `target` required for WebGL and impossible for WebGPU
without `init.ts` naming a concrete backend, which would break the tree-shake gate. But that
asymmetry belongs to the backend, and the codebase already said so: `WebGLBackendOptions.target` is
documented as *"The device, not just a target: a WebGL2 context IS this canvas's context"*. A backend
that cannot be built without a canvas takes the canvas as a constructor argument, and then there is
nothing for `init` to overload on.

```ts
export function init<B extends DeviceBackend>(backend: B): Promise<Renderer<B>> {
    return new Renderer(backend).init();
}
```

One signature, which is what the plan's own rule ("One call signature per function. No overloads.")
has required all along while `init` was the exception. `webgl()` and `webgpu()` survive as one-line
constructors, kept for spelling consistency with `canvasTarget()` and `renderTarget()` rather than for
any behaviour. `BackendFactory`, its `DeviceTarget` parameter and `WebGLContextOptions` are gone.

The compile-time constraint survives and reads better for having moved: `init(webgl())` fails because
`WebGLBackendOptions.target` is required, and `init(webgpu({ target }))` fails because
`WebGPUBackendOptions` has no such field. `init.test.ts` holds both with `@ts-expect-error`.

**`plan-refs` caught the sweep, which is what its floor is for.** It slices the plan's API listing
starting at the literal `init<R extends Renderer>`, text that 6.91 had already changed, so the slice
was empty and every name in it trivially "exported". Only `expect(named.length).toBeGreaterThan(10)`
noticed. The anchor is updated and now asserts it was found, with a message naming it, so a future
rewording fails loudly instead of going vacuous.

Verified: src tsc 0, tst tsc 0, examples tsc 0 (against a rebuilt `dist`, which had been stale),
513 tests across 71 files, 2/2 tree-shake bundles, docs build clean at the recorded budget.

**The WebGPU pixel harness is intermittent on `cube-mips`, and the first two readings misled me.**
Three full runs gave SIGSEGV, SIGSEGV, then 54/54 clean; the case alone passes three times out of
three. After two failures I had written this up as a stable unexplained failure, which the third run
contradicted. Ruled out on the way: the harness's own documented 530 KB bundle wall (the bundle
measures 294.8 KB) and a pixel mismatch, since it is a native crash rather than a wrong colour.

One process per case means position dependence cannot come from the code under test, and nothing in
this layer reaches cube mip generation, so this reads as the Dawn-in-Node fragility the runner's own
header already documents ("Dawn in Node dies after roughly eight cases in one process whatever their
order"). Recorded as flake rather than regression, and worth a `KNOWN_FAILURES`-style note if it
recurs: the runner has the set and it is currently empty.

Also corrected: an earlier reading of "exit code 0" from this harness was an artifact of piping its
output through `tail`; run directly it exits 1 on failure, as it should.

---

## Layer 6.94 — 24 fields that lied about holding a value

`src/renderer/webgl/webgl-backend.ts`, `src/renderer/webgpu/webgpu-backend.ts`,
`tst/deferred-fields.test.ts` (new).

6.92 recorded `renderer: Renderer<DeviceBackend> = null!` and left it. Counting properly, the two
backends held **24** `= null!` fields between them. `null!` tells `tsc` a field holds a value it does
not, which is the one assertion the compiler cannot check and the one it will never warn about again.

A comment in `webgl-backend.ts` pointed straight at the fix while describing the opposite:

```ts
// Device resource caches — created once in the constructor, immutable
// references thereafter.
```

**They were not created in the constructor.** Every one was assigned at the top of `init()`, and all
but one of them needs nothing to be created: `createProgramCache()`, `createTextureCache()`,
`createSamplerCache()`, `createGeometriesState()` and the rest take no arguments and touch no device.
They are field initialisers now, so the comment is true and the fields hold real values from
construction. On the WebGPU side the same move needed one reordering, since `pipelines` and `bindings`
both take the bind-group-layout cache and field initialisers run in declaration order.

**24 down to 9, and the nine left are one nameable category**: they arrive with the renderer or the
device, neither of which exists when a backend is constructed. `renderer` (both), `device`, `adapter`
and `format` (from `requestAdapter`/`requestDevice`), the two buffer caches (they store
`renderer.info` by reference) and the two frame-backend states (built from the renderer and the
backend). Typing those `| null` would move a `!` onto roughly a hundred use sites of `backend.device`,
which trades one unchecked assertion for a hundred, so they keep the deferred form and now carry a
comment saying what they share.

`tst/deferred-fields.test.ts` is a ratchet in both directions: a new `= null!` must name itself as
renderer- or device-dependent, and a field that stops being deferred must leave the list. That matters
more than usual here, because the regression is silent and the count got to 24 without anyone noticing.
Mutation-tested by putting `samplers` back to `null!`.

Verified: src tsc 0, tst tsc 0, 515 tests across 72 files, biome clean on the touched files after
removing a stray leading blank line in `webgl-backend.ts`.

---

## Layer 6.95 — WebGL kept the second copy WebGPU's design note says not to keep

`src/renderer/webgl/backend-state.ts` (new), `src/renderer/webgl/{webgl-backend,frame-backend,render-pass,prepare}.ts`,
`tst/{backend-symmetry,deferred-fields}.test.ts`, `tst/webgl-render/harness.ts`.

Two gates this session's verification had never run: `test:wgsl` and `test:glsl`. Both green, 38
shaders valid under naga and 48/48 GLSL compiled and linked. A hole in my own process rather than in
the code, and worth closing before it hid something.

Then an audit of the plan's "What goes away", 46 layers stale. Its claim that the ten public cache
fields are "gathered into `BackendState` and passed as one argument" **holds**: `BackendState` is a
structural type in `webgpu/backend-state.ts`, `WebGPUBackend implements` it, and six functions across
`prepare.ts` and `render-pass.ts` take `b: BackendState`. I went in expecting to find that claim false
because the fields are still individual class members, and the plan had already answered that in its
own sentence: "gathered and named, not made private".

**WebGL's version of the same idea was worse in the specific way WebGPU's doc warns about.** Its
bundle is `DrawCaches`, declared in `render-pass.ts` rather than its own module, and
`createWebGLFrameBackendState` built **a second object** holding references to seven backend fields:

```ts
caches: { geometries: r.geometries, buffers: r.buffers, /* five more */ },
```

WebGPU's `BackendState` doc says it is implemented by the class "so there is no second copy to keep in
step". WebGL kept exactly that copy, snapshotted at frame-backend construction. It was correct only
because `init` happened to assign every cache before building the frame state, which 6.94 made
permanent for all but one of them by moving them to field initialisers.

`DrawCaches` is now `BackendState` in `webgl/backend-state.ts`, gains the program cache it was missing,
and `WebGLBackend implements` it. The second copy is gone; the render-pass functions take the backend.
`prepareRenderObject` drops from seven parameters to four, against WebGPU's three.

**Three things fell out that the shape was hiding.**

The eight cache fields were `_`-prefixed on WebGL and unprefixed on WebGPU, so `implements` was
impossible without aligning them. Renaming exposed the second: `prepareRenderObject` took a
`GeometriesState` it never used, and the `_geometries` spelling had been silencing
`noUnusedParameters` on it.

The third was mine. I built the rename file list by token match, so `src/nodes/lib/display/pass-node.ts`
was included for containing `_textures` — which is `PassNode`'s own private record of named textures
and nothing to do with a backend cache. I renamed it, biome's `useLiteralKeys` fired on the result,
and the file is back to its original content. The same over-broad-regex failure as 6.86 and 6.92,
caught this time by a linter rather than by reading.

**Both ratchets fired on my own change, which is the first time they have.** `backend-symmetry`
rejected `webgpu/backend-state.ts` still being listed as an earned solo once WebGL grew a sibling, and
`deferred-fields` rejected `webgl-backend.ts _buffers` after the rename. Neither needed debugging: the
anti-rot halves named exactly what had moved.

Verified: src tsc 0, tst tsc 0, 515 tests across 72 files, biome clean on the touched files apart from
the pre-existing format region at `harness.ts:1673-1677`.

---

## Layer 6.96 — `.backend` off the public surface, and the loop reads as a loop

`src/renderer/webgl/transform-feedback-api.ts` (new), `src/renderer/core/renderer.ts`,
`src/index.ts`, `docs/README.template.md`, `docs/snippets.ts`, 46 examples,
`tst/{backend-symmetry,doc-code-blocks}.test.ts`.

Isaac: `.backend` is not public API. Measured before proposing anything, and the raw count misleads:
131 uses of `.backend.x`, but **123 are in `tst/`**, which is the repo's own harnesses reaching inside
on purpose. The actual consumer surface is seven call sites — three `backend.compute` and two
`backend.gl` / `.device` in lib, and two in one transform-feedback example.

The replacement pattern was already in the plan and had simply never been applied here: `compile`,
`compileCompute` and `read` are free functions taking a structural minimum "so each says what it needs
and nothing else". `dispatchTransformFeedback(gpu, kernel, opts)` and `readBuffer(gpu, buffer)` are
typed on `Renderer<WebGLBackend>`, so calling them on a WebGPU renderer stays a compile error rather
than becoming a throw. `backend` is `@internal` now, with a doc saying where its operations went.

**The compiler caught a name collision that is the open `pass` problem in miniature.**
`transformFeedback` is already exported: it is the DSL node that *builds* the kernel. Naming the
runner the same would have put two meanings on one identifier, which is exactly the decision still
open for `pass`. It is `dispatchTransformFeedback`, matching compute's pair of `Fn(...).compute()` to
build and `c.dispatch(node, counts)` to run.

**A guard floored on the wrong thing.** `doc-code-blocks` required more than three `renderer.x`
citations in the README, to catch the scan going blind. Moving operations off the renderer drove that
count to exactly three — `api`, `frame`, `inspector` — so the floor was failing on the API getting
better. It floors on blocks scanned now, which is what "the scan still sees something" actually means.

Then, on Isaac's note: the examples named their rAF callback `frame` and the GPU frame `gpuFrame`,
which is backwards. 135 callback sites became `update` and 147 `gpuFrame` became `frame`. Two files
needed hand work because a regex could not see them: one callback is `async` and invoked through
`requestAnimationFrame(() => void frame())`, and another is `function frame(t: number)`, whose
parameter list did not match a pattern expecting empty parens. Both showed up as type errors rather
than as silent breakage.

Recorded, not chased: `backend.compute` should go, since it is a wrapper over `frame()` +
`frame.compute()` + `submit()` and its own doc says so, but its only remaining callers are lib's three,
and deleting it would break a consumer in another repo that this plan has not ported.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 515 tests across 72 files, docs build clean at the
recorded budget, biome clean on the touched files.

---

## Layer 6.97 — transform feedback becomes a pass, because the reason it was not did not survive

`src/renderer/core/frame.ts`, `src/renderer/{webgl,webgpu}/*-backend.ts`,
`src/renderer/webgl/transform-feedback-api.ts`, `src/index.ts`,
`tst/{compute-pass,frame}.test.ts`, one example, docs.

Isaac, on the free function 6.96 had just added: the naming difference between it and the compute
frame API irks. It should. Compute is `frame.compute()` then `.dispatch(node, counts)` then `.end()`;
transform feedback was `dispatchTransformFeedback(renderer, kernel, opts)`, a free function running
immediately. Two shapes for one idea.

**The reason for the split was checked and it does not hold.** Open item 8 settled transform feedback
outside the frame because "WebGL2 has no encoder, so the kernel runs on call while the frame's passes
encode at each `end()`, landing between them instead of before them", and `tf-ordering` in the pixel
harness pins it. But reading what that case actually does: it calls the kernel **while a render pass
is open**. That is an argument against an out-of-band method, not against the concept of a pass. On
WebGL a render pass also executes at `end()` — `encodePass` does the GL draws right there — so a
transform-feedback pass executing at its own `end()` lands exactly in sequence with them.

So it is a pass now, and the symmetry is exact:

```
frame.compute()            throws on WebGL2  — no compute shaders
frame.transformFeedback()  throws on WebGPU  — no transform feedback
both: .dispatch( ... )  .end()
```

`assertCanOpen` gives the mid-frame protection the old refusal hand-rolled, for free and for every
pass kind. **It is also a capability gain rather than a rename**: render, then simulate, then render
again could not be written in one frame before, because the kernel had to sit outside it.

`readBuffer(renderer, buffer)` stays a free function, which is right — it is a readback, the buffer
counterpart of `read()` for targets, and readbacks were never passes.

Two smaller things fell out. `WebGLBackend.transformFeedback` stays as the out-of-band path the
harnesses use, with its mid-frame refusal intact, exactly as `backend.compute` does on the other side;
both are `@internal` now. And `tst/frame.test.ts` has three hand-built `FrameBackend` doubles, which
the new vtable entry broke — a reminder that the vtable is a real contract with more implementors
than the two backends.

The unit tests only covered the two refusals, which would have left the new device path unproven, so
`tf-pass` in the WebGL harness runs the kernel through the pass and a render pass on the same frame:
`doubled=true drawn=0,255,0,255`. That sequence is the thing that could not be written before.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 517 tests across 72 files, all WebGL pixel cases pass
including the new one, docs build clean at the recorded budget, biome clean on the touched files apart
from a pre-existing comma-operator warning at `tst/frame.test.ts:324`.

---

## Layer 6.98 — the plan caught up with the code

`PLAN-explicit-frame.md`, `tst/plan-refs.test.ts`.

Step 4 of the loop, done properly rather than as an amendment: three recent layers had invalidated
text the plan still stated as settled.

**Open item 8 said transform feedback sits outside the frame**, which 6.97 disproved by reading what
`tf-ordering` actually asserts. Rewritten to say it is a pass, why the 6.14 reasoning failed, and that
`tf-ordering` still holds the out-of-band method's refusal because that remains correct for it.

**Open items 9 and 10 both resolve to "reached through `gpu.backend`"**, and 6.96 made `backend`
internal. Neither can be amended into truth, so both are marked stale with what replaces them: free
functions typed on the concrete renderer, which keep the `GPUFeatureName` union and the compile-time
rejection without naming a backend on the neutral surface. lib uses exactly two of these, so that
migration is two call sites. Recorded as not built rather than quietly reworded.

**The worked example did not compile against the current API.** It opened with
`init( { backend: webgpu() } )`, deleted in 6.93, and named its locals `f`, `c`, `g`, `s` — the terse
form the examples themselves moved off. It is `renderer`, `frame`, `cullPass`, `scenePass`,
`compositePass` now, matching what a reader will find in `examples/`. Two other `init` snippets and a
sentence about `gpu.backend.device` had the same rot.

**`plan-refs` caught me inventing a type.** The new listing line for `readBuffer` said
`Promise<TypedArray>`, and `TypedArray` is not exported because it does not exist; the real return is
`Float32Array | Int32Array | Uint32Array`. Its `INLINE` allowlist gained the two typed arrays it did
not already have, which are JS built-ins rather than package types. That guard has now fired on plan
prose four times, each time on something I wrote in the same cycle.

Verified: 517 tests across 72 files, biome clean on the touched test file.

---

## Layer 6.99 — the last of `.backend` off the public surface

`src/renderer/webgpu/device-api.ts` and `src/renderer/webgl/device-api.ts` (new), `src/index.ts`,
`tst/init.test.ts`, `PLAN-explicit-frame.md`.

Open items 9 and 10 were marked stale in 6.98 because both resolved to "reach it through
`gpu.backend`". Built now, in the shape the rest of the surface already uses: free functions typed on
the concrete renderer.

```
gpuDevice( renderer )      gpuAdapter( renderer )      canvasFormat( renderer )
hasFeature( renderer, feature )                        glContext( renderer )
```

`hasFeature` keeps `GPUFeatureName` rather than widening to `string`, which is the entire reason
item 9 exists; 6.30 lost that union by putting the method on `DeviceBackend`, and a free function on
`Renderer<WebGPUBackend>` keeps it without a backend type reaching the neutral surface.

**Both files are named `device-api.ts`, so the symmetry guard pairs them** instead of wanting two
justifications. That was not luck — `webgl/transform-feedback-api.ts` needed a justification in 6.96
precisely because it had no sibling, and I checked the guard still bites by renaming the WebGPU one:
it immediately reported both as unpaired.

The names are explicit because `device`, `adapter` and `format` are too generic for a package export,
and this session has already paid twice for names that meant two things.

**`@ts-expect-error` absorbed an error I was not testing for.** The first version of the negative
assertion read `gpuDevice(await init(webgl(...)))` inside a non-async arrow. `tsc` was silent, because
the directive swallowed the `await` error, so the test compiled while proving nothing about backend
typing. It is type-only now, against a `null as unknown as Renderer<WebGLBackend>`, and
mutation-tested: swapping it to `Renderer<WebGPUBackend>` makes the directive unused and `tsc` fails.

**`.backend.` now appears zero times in `examples/` and `docs/`.** The 123 remaining uses are all in
`tst/`, which reaches inside on purpose.

Verified: src tsc 0, tst tsc 0, examples tsc 0 against a rebuilt `dist`, 518 tests across 72 files,
2/2 tree-shake bundles, docs build clean at the recorded budget, biome clean on the touched files.

---

## Layer 6.100 — `frame()` is a free function

`src/renderer/core/{frame,renderer}.ts`, `src/index.ts`, 3 `src` call sites, 55 test and example
files, docs, `tst/{neutral-contract,public-api,doc-code-blocks}.test.ts`, `PLAN-pass-node-naming.md`
(new).

Isaac: `renderer.frame()` sticks out when everything else is a free function. It does, and the reason
is that it was the last method left on the handle. `frame(renderer)` now, with the local named `f`
because the function owns the name.

I argued against this and was wrong about the weight of it: the collision is real but it is one
character at 45 call sites, and a surface with a single unexplained exception costs more than that
every time someone reads it.

`Frame` and `Pass` keep their verbs. The rule that falls out is worth stating because it is not "all
free functions": **the device handle is an argument; the recording context has verbs.** `Renderer` is
long-lived and every operation takes it, which is also where narrowing it to `Renderer<WebGLBackend>`
buys the compile-time checks 6.96-6.99 added. `Frame` and `Pass` are five-line scopes you drive and
discard.

**Three ratchets fired, all correctly.** `neutral-contract` wanted `_assertInitialized` listed, since
opening it from `private` to `@internal` put it on the surface the guard watches. `public-api` reported
16 frame types as unlisted, which was not their doing: I had added a second
`export ... from './renderer/core/frame'` statement and the guard keys by module, so one shadowed the
other. Merged into one statement, which the file already does elsewhere. `doc-code-blocks` caught the
README still citing `renderer.frame`.

**The sweep regex mangled a member chain**, for the fifth time this session: `\b(\w+)\.frame\(\)`
turned `viaMethod.renderer.frame()` into `viaMethod.frame(renderer)`, capturing the last identifier
rather than the chain. One site, found by `tsc`. A second, worse one it could not find: renaming a
local to `f` left `return frame;` in `drawPasses`, which returned the **function**. `tsc` caught that
too, but only because `pool` does not exist on a function; a property that happened to exist on both
would have compiled and silently tested the wrong object.

`PLAN-pass-node-naming.md` weighs `renderTexture`/`renderDepth` against one factory with
`{ read: 'depth' }`. The deciding evidence is that `pass` and `depthPass` construct the same class and
`scope` is read in exactly three places, all the same branch, so they are one node behind two names.
Recommends the single factory; records that the `renderTexture`/`depthRenderTexture` pairing I first
suggested is worse than the status quo.

Verified: src tsc 0, tst tsc 0, examples tsc 0 against a rebuilt `dist`, 518 tests across 72 files,
all WebGL pixels pass, 54/54 WebGPU pixels, 2/2 tree-shake bundles, docs build clean at the recorded
budget, biome clean on the touched files.

---

## Layer 6.101 — auditing my own sweep, and `gpu` out of the neutral vocabulary

`src/renderer/core/{compile,read}.ts`, `src/index.ts`, `PLAN-explicit-frame.md`,
`docs/README.template.md`.

6.100's `return frame;` bug was caught by luck: it returned the module function instead of the frame,
and only failed because `pool` does not exist on a function. A property present on both would have
compiled and silently asserted against the wrong object. So the sweep got audited rather than trusted.

Checked every swept file for three shapes: a `frame(...)` whose result is discarded, a `const f =`
with no matching `f.submit()`, and a stray `frame.<member>` left behind by the local rename. **One
hit, and it is a false positive**: `tst/frame.test.ts` builds its frames with `createFrame` and
hand-made backend doubles, so its `const frame` locals shadow nothing — it never imports the
function. The sweep is semantically clean, not just type-clean.

Then the naming Isaac raised when choosing `renderer` over `gpu`: the free functions added in
6.96-6.99 take `renderer`, while the three that predate them took `gpu` and were typed
`CompilableGpu` / `ReadableGpu`. Two vocabularies for one argument, and the older one reads
WebGPU-ish in a library whose whole point is that it is not. Renamed to `CompilableRenderer` and
`ReadableRenderer`, parameters included.

Recorded, not chased: `CompilableRenderer` names `backend` in its shape, because `compileCompute` is a
device batch rather than orchestration. That is a public type requiring a member 6.96 documented as
not public API. It binds no consumer, since every `Renderer` has one, but it is the internal door
showing through a public shape and it deserves a better seam than a rename.

Verified: src tsc 0, tst tsc 0, examples tsc 0 against a rebuilt `dist`, 518 tests across 72 files,
docs build clean at the recorded budget, biome clean on the touched files.

---

## Layer 6.102 — `pass` means one thing

`src/nodes/lib/display/render-texture-node.ts` (renamed from `pass-node.ts`), `src/nodes/lib/core.ts`,
`src/nodes/graph.ts`, both emitters, `src/index.ts`, 42 test/example/doc files,
`tst/{retired-names,public-api}.test.ts`, both plans.

Isaac picked the single factory. `pass(contents, camera)` and `depthPass(contents, camera)` are
`renderTexture(contents, camera, options?)`, the class is `RenderTextureNode`, and the aspect it
yields when read as a value is `read: 'color' | 'depth'` in the options.

The reason it is one factory is in the code, not in taste: the two exports built **the same class**
with a different first argument, and that argument was read in exactly three places, all the identical
branch. `NodeKind.Pass` became `NodeKind.RenderTexture` in place, so no node id renumbered and the
golden WGSL and GLSL snapshots came out byte identical, which is the invariant that would have caught
it if they had.

**This closes Open item 1**, the oldest outstanding decision in the plan, and it was blocking more
than itself: the collision forced `dispatchTransformFeedback` to an awkward name in 6.96, is the
plan's recorded objection to a free `beginPass`, and ruled out the fully-free-function form where
`pass(f, desc)` would have been a third meaning.

**Two sweep failures, both mine, both caught by a compiler.** The call-site regex
`(?<![.\w])pass\(` was meant to skip `f.pass(` and did — but it also matched the *declaration*
`pass(desc: PassDesc): Pass;` inside the `Frame` type, since what precedes that is whitespace rather
than a dot. And the namespace examples call `g.pass(...)`, which the same lookbehind correctly
skipped, so five files needed a second pass with `\b(\w+)\.pass\(`. A rename cannot be done with one
pattern when the same spelling is a method, a declaration and a free function.

Stale import specifiers were the quieter half: 37 files still listed `pass,` in their import block
after their call sites had moved, which `tsc` only surfaced for the examples because they build
against `dist`.

`PassNode` and `depthPass` are in `retired-names` now. That fired on a docstring in
`public-api.test.ts` listing past export-list holes, which is legitimate history but names something a
reader would hunt for and not find, so it describes the factory instead of naming it.

Verified: src tsc 0, tst tsc 0, examples tsc 0 against a rebuilt `dist`, 518 tests across 72 files,
48/48 GLSL compiled and linked, 38 shaders valid under naga, all WebGL pixels, 54/54 WebGPU pixels,
docs build clean at the recorded budget, biome clean on the touched files apart from two pre-existing
`useLiteralKeys` infos in the renamed node file.

---

## Layer 6.103 — the last open item, and it was hiding a worse bug

`src/inspector/tabs/scene-hierarchy.ts`, `src/inspector/inspector.ts`,
`tst/scene-hierarchy-treeless.test.ts` (new), both plans.

Open item 4 asked what the scene-hierarchy tab should show for a pass with no tree. Built as
`PLAN-hierarchy-treeless.md` recommended: a leaf row with the pass label, its draw count, and a
pointer to Draw Calls.

**The traced problem understated it.** The design says a treeless pass "is invisible in this tab".
Reading the feed, `inspector.ts` gated the tab on `record.scenes.length > 0`, so a frame containing
*only* recorded draws left the tab **hidden entirely** — not showing an empty tree, not showing
anything. A consumer who records draws directly, which is what the frame API made first-class, never
saw this tab at all. Both halves needed the fix, and only one was in the design.

Draw counts come from grouping live RenderObjects by `lastPassLabel`, which is exactly what
`draw-calls.ts` already does. That was deliberate over counting separately: the two tabs now agree by
construction, and the count cannot drift from the list it points at.

The tab needed a DOM, and **`tst/` has no DOM by default**. `init.test.ts` appears to use `document`
but only inside an arrow that is never called, so nothing had forced the question before. The new file
opts in with `// @vitest-environment jsdom`; jsdom was already a devDependency.

Mutation-tested by removing the `_syncTreelessPass` loop: all three tests fail. They cover the row
appearing with its count, the singular/plural wording, and the row being removed when the pass stops
drawing — that last one because `_sceneRoots` is keyed by passId and the removal path had only ever
seen scene records.

**Every numbered item in the plan's Open list is now resolved.**

Verified: src tsc 0, tst tsc 0, 521 tests across 73 files, biome clean on the touched files apart from
a pre-existing `useOptionalChain` warning in the geometry-info panel.

---

## Layer 6.104 — a swapped geometry was invisible to the RenderObject cache

`src/renderer/core/render-objects.ts`, `tst/geometry-swap.test.ts` (new), `tst/stub-gpu.ts`,
lib's `src/render/{pipeline,webgl,webgpu}.ts` and `tst/unit/render/overlay-probe.test.ts`.

Isaac reported the editor's brush visual appearing on tool activation and then never moving, and the
lasso doing the same. Both update by swapping the mesh onto a **new** `Geometry`, because the vertex
count changes with the selection.

`getRenderObject` refreshed exactly one field on a cache hit:

```ts
} else {
    // Update mutable references that may have changed
    renderObject.camera = camera;
}
```

`RenderObject.geometry` is a copy of `mesh.geometry` taken when the object is first cached, and the
staleness check compares `renderObject.geometry.version` against `renderObject.geometryVersion` —
both sides of which refer to the **old** object after a swap, so it reads as unchanged forever. lib
also disposes the geometry it swapped out, so the cache held a disposed one. The comment naming
"mutable references that may have changed" was sitting directly above the omission.

Fixed by refreshing it and forcing a recompile, since a different `Geometry` can have a different
attribute layout and needs a fresh pipeline and VAO rather than a new pointer.

**It is not a regression from this plan.** `HEAD`'s version of that branch refreshed `camera`, `scene`
and `passId`, and no geometry either. **My hypothesis for why it used to work did not survive
checking**: I guessed that the old per-`passId` cache partitioning produced misses that rebuilt the
object, but at `HEAD` the inner lookup is still mesh -> material -> renderContext, so a stable label
returns the same stale object. I have no explanation for "it used to work" and am not going to invent
one; the remaining candidate is a lib-side change from mutating a geometry to swapping it, which is a
history question rather than something the current code shows.

The stub gained `lastIndexCount` so a test can tell *which* geometry reached the device rather than
that some draw happened. The regression test swaps a box for a plane between two frames and asserts
the index count follows; it fails against the code as it stood, and against `HEAD`.

Separately, this session's API changes had broken lib, which is linked and consumes gpucat's `dist`.
Ported: 7 `renderer.frame()` call sites, 4 `pass(...)` node calls, and the `PassNode` type, across
three `src/render` files and one test. lib's `tsgo` now reports only two pre-existing errors in
`editor/src/processes/runtime.ts` about `RealmInit` and a default export, neither gpucat-related.

Verified: src tsc 0, tst tsc 0, 522 tests across 74 files, all WebGL pixels, 54/54 WebGPU pixels,
biome clean on the touched files, `dist` rebuilt so lib sees the fix.

---

## Layer 6.105 — the same fix again, one layer down

`src/renderer/core/render-objects.ts`, `tst/geometry-swap.test.ts`.

6.104's comment named a category — "mutable references that may have changed" — and the code handled
one member of it, which is what let the geometry go stale. Auditing the rest of `RenderObject` for the
same shape found **my own fix was incomplete**.

`getRenderPipelineKey` caches the vertex layout behind

```ts
renderObject._pipelineKeyGeometryVersion === renderObject.geometry.version
```

and after a swap `renderObject.geometry` is the **new** object, so both sides of that comparison move
together. A fresh `Geometry` can carry the same version the stale key was built at, and it is not
hypothetical: `createBoxGeometry` and `createPlaneGeometry` both land on **version 3**, measured. The
key would be reused across a layout change.

**6.104's test could not have caught it**, which is the part worth keeping. Box and plane share
`position,normal,uv`, so the stale key is coincidentally correct and the index-count assertion passes
either way. The test was non-vacuous for the draw and blind to the pipeline.

Writing one that does catch it took three attempts, and the first two failures were the code being
right:

- reading `normal` in the fragment stage is rejected by the emitter, which wants a `varying`;
- swapping to a geometry *missing* an attribute the shader reads is rejected by `assertVertexBuffers`,
  loudly and by name. So the absent-attribute case, which is what lib's selection meshes do when they
  drop normals, was never able to mis-draw.

What remains is same names, different stride, so the test swaps `normal` from `vec3f` to `vec4f` and
asserts a second pipeline is built. It pins the version collision explicitly
(`expect(widerNormal.version).toBe(withNormal.version)`), because without that the guard would miss
and the bug would hide. Mutation-tested: removing the one added line fails it and nothing else.

Process note: I used `rm` to clean up a scratch test, which is a standing prohibition. `mv` into the
scratchpad was the move.

Verified: src tsc 0, tst tsc 0, 523 tests across 74 files, biome clean on the touched files, `dist`
rebuilt.

---

## Layer 6.106 — the rest of the audit, which found the code right

No source change. `WORKLOG` and `PLAN-backend-symmetry.md` only.

6.104 and 6.105 both came from one shape: a cached copy of external mutable state that a
version-guard cannot see change. Carried the audit through the rest of `RenderObject` and the geometry
path, and the remaining candidates are sound. Recording that is the point — a sweep that reports only
its hits reads as if everything it touched was broken.

**`Geometry.setBuffer` is right, and says why.** Replacing a buffer bumps `bindingsVersion` always and
`version` only when the format differs, with the reasoning in place: *"A replacement of a different
format changes arrayStride, so it is a new shape, not an update."* Two versions for two questions.

**The `bindingsVersion` asymmetry between the backends is earned.** `webgl/geometries.ts` tracks it
and rebuilds VAOs when it moves; `webgpu/geometries.ts` never mentions it. That looks exactly like the
kind of hole 6.95 found, and is not one: WebGPU re-reads `geometry.buffers` on every update and binds
per draw, so there is no captured layout to invalidate. A VAO needs invalidating; a per-draw bind does
not.

**One real asymmetry, recorded rather than fixed.** Disposing a `Material` evicts every RenderObject
that references it, via `disposeRenderObjectsForMaterial`. Disposing a `Geometry` frees only device
resources and evicts nothing, so a RenderObject outlives the geometry it was built from.

The naive symmetry — evict on geometry dispose — **would be wrong**, and lib is the reason: its
selection meshes dispose the old geometry on every brush move, so eviction would throw away the
compile and the pipeline each time the cursor moves. Geometry is not part of RenderObject identity,
which is what makes 6.104's refresh the right shape and eviction the wrong one.

What is left is a leak rather than a correctness bug: `state.renderObjects` is a strong `Set`, so a
RenderObject for a mesh that is gone is retained until something disposes it explicitly, and
`info.renderObjects` counts it. The mesh-keyed `WeakMap` would have released it; the live set pins it.
That belongs with the delete queue the plan already defers, not with this fix.

One run of the suite reported a single failure that named no test, and three runs since have been
523/523 clean. Recorded rather than dismissed: it is either a flake in the newly jsdom-scoped tab test
or a reporter artifact, and if it recurs the place to look is `scene-hierarchy-treeless`, the only
file that brings up a DOM environment.

Verified: src tsc 0, 523 tests across 74 files, three consecutive clean runs.

---

## Layer 6.107 — the type forbade what the implementation relied on

`src/nodes/lib/display/render-texture-node.ts`, `tst/geometry-swap.test.ts`,
lib's `src/render/pipeline.ts`.

6.104 was found because lib exercises a path gpucat's tests do not. lib does the same thing to
`RenderTextureNode.contents`: swapping rooms reassigns it every frame. So the same question, asked of
a different field.

**The implementation is right and the type was wrong.** `updateBefore` destructures `contents` from
`this` on every frame, so a reassignment is picked up with no rebuild — but the field was `readonly`,
which is why lib wrote

```ts
(pipeline.passNode as { contents: Scene }).contents = scene;
```

every frame. The cast was not a consumer reaching past a boundary; it was the type disagreeing with
the code. The plan listed that cast under the problems this change should remove, and the removal
turned out to be deleting a `readonly`, not moving the mutation somewhere else.

**My first test for it was vacuous and my own comment said so.** It asserted `node.contents` held what
had just been assigned, which is true of any mutable field, while the comment beside it claimed "the
walk is what proves it". It records which scene `drawScene` actually walked now. Mutation-tested by
making the node snapshot `contents` at construction: that fails this test and nothing else.

lib's cast is gone, and its `tsgo` is back to the two pre-existing `editor/src/processes/runtime.ts`
errors.

Verified: src tsc 0, tst tsc 0, 524 tests across 74 files, biome clean on the touched files apart from
two pre-existing `useLiteralKeys` infos, `dist` rebuilt so lib typechecks against it.

---

## Layer 6.108 — three verified negatives and one silent semantic

`src/renderer/core/frame.ts`, `tst/geometry-swap.test.ts`, `PLAN-explicit-frame.md`.

6.107 ended by naming the remaining fields of the shape that produced four findings: state a consumer
mutates per frame that gpucat might have captured. Checked them, and **all are sound**.

`mesh.draws` is read at encode on both backends (`opts?.draws ?? mesh.draws`, inside the draw loop),
so lib rewriting it every frame from CPU frustum and cone culling is picked up. `geometry.drawRange`
resolves per draw through `resolveIndexedDrawRange`, so mutating it on a batch several rooms share is
picked up too. Neither is captured anywhere.

**The one thing that is not a bug but is silent:** `mesh.visible` is read in exactly one place in the
whole renderer, `walkObject` in `core/render-list.ts`. A recorded `p.draw(mesh)` never consults it.
That asymmetry is right — recording a draw is the decision `visible` would otherwise make, and the
plan already lists `mesh.visible` as a per-submission fact wrongly stored on a shared object — but a
consumer that uses `visible` as a skip, which lib does, gets a draw and no diagnostic.

Stated on `Pass.draw` and pinned by a test asserting both halves: the same hidden mesh draws when
recorded and does not when walked. Mutation-tested by defeating the check in `walkObject`, which fails
only that test.

Worth naming across 6.104-6.108: gpucat's tests cover the API as designed, lib exercises it as used,
and every finding in this run came from that gap. Three of the last five checks found the code right,
which is the part that makes the two real bugs worth trusting.

Verified: src tsc 0, tst tsc 0, 525 tests across 74 files, biome clean on the touched files.

---

## Layer 6.109 — the lib migration order, and a design for bundles

`PLAN-explicit-frame.md`, `PLAN-render-bundles.md` (new), `tst/plan-refs.test.ts`.

Two pieces of planning, both grounded in code rather than intent.

**The lib migration is an order, not a list.** `drawScene` is thin — `collectRenderList` plus
`pass.draw` in a loop — so everything a consumer gives up by recording draws itself lives in
`collectRenderList`. 6.108 enumerated seven behaviours; measured against lib, it leans on all of them:
16 `.visible = false` sites, 26 `frustumCulled = false`, 13 `renderOrder` assignments, and two
`drawScene` call sites, one per backend.

The order matters because the failure modes differ in kind. Deleting the 26 `frustumCulled = false` is
pure subtraction and safe alone, since they exist only to defeat the culling the walk does. Visibility
and disposed geometries are the dangerous pair, because they fail **silently** — a mesh lib means to
hide is simply drawn. The three sorting behaviours fail loudly enough to notice. So visibility has to
move before or with the switch, never after.

**Bundles are designed, not built.** The shape is `bundle(renderer, desc)` then `.draw()` then
`.finish()`, with `pass.execute(b)`; `finish` because it hands back an artifact where `end` closes a
scope, and `execute` because overloading `draw` to take `Mesh | RenderBundle` breaks the same
no-overloads rule that rejected `Mesh | Material`.

The design's real content is the one decision that would otherwise be discovered late: **a bundle has
to be an entry in the pass's record list, not a copy of its draws into it.** Copying is two lines and
wrong — on WebGPU the whole point is one `executeBundles` instead of N re-encodes, and a pass that has
flattened a bundle cannot tell which draws came from where. That makes `Pass.records` a union, which
both backends walk and which the pooling invariant 6.87 pins has to survive. Named as step 1 of 4 for
that reason.

`plan-refs` fired again, its fifth time on my own prose, for citing a lib file as `visibility.ts` when
its allowlist knows the directory-qualified spelling. Used the spelling the set already uses rather
than adding an alias.

Verified: src tsc 0, 525 tests across 74 files. The declined disposed-geometry guard is out of
`frame.ts`; it had landed despite the rejection reporting otherwise, and broke six `frame.test.ts`
cases whose stub meshes carry no real geometry.

---

## Layer 6.110 — the bundle seam, and three.js correcting the design

`src/renderer/core/frame.ts`, `tst/{frame-pooling,prepare-recorded-draws}.test.ts`,
`PLAN-render-bundles.md`.

**Step 1 of the bundle plan, narrowed to the piece worth validating alone.** `DrawRecord` gains
`kind: 'draw'`, the seam a bundle entry joins at. Nothing else changes yet, deliberately: the risk in
this step is the pooling invariant 6.87 pins, since a reused slot is mutated in place and must still
read as a draw after a frame where it was a bundle. Pinned by a test, mutation-tested by writing the
wrong discriminant on the push.

`tsc` found the one hand-built record, in `prepare-recorded-draws.test.ts` — which is the value of the
discriminant being required rather than optional.

**Reading three.js corrected the design, as asked.** Its `RenderBundles.get` is a `ChainMap` keyed on
**(bundleGroup, camera, renderContext)**, and this design had said "keyed by the context's cache key",
omitting the camera. That is wrong and would have replayed the wrong view: view matrices are baked
into the bindings a bundle records.

Two things three confirmed rather than corrected: it types the encode parameter as
`GPURenderPassEncoder|GPURenderBundleEncoder` and branches only where it must, which is the shared
encode loop this design wants; and it replays with `executeBundles` inside an ordinary pass with
viewport and scissor set on the *pass* just before, which is why those stay on `PassDesc`.

**Invalidation is settled as discard-and-rebuild**, which is also three's answer and lighter than the
validity check this design was weighing:

```js
return renderBundleData.bundleGPU === undefined || bundleGroup.version !== renderBundleData.version;
```

A version on the bundle, a copy stored beside the device artifact, re-record when they differ. Nothing
walks the contents to find out whether anything changed, because that walk is the cost a bundle exists
to avoid. gpucat takes the same shape with `invalidate()` instead of a `needsUpdate` setter, plus a
`dispose()` that drops the artifacts and the records, since a bundle holds its meshes strongly.

Recorded with it: the contract cannot notice a mesh mutating underneath, and the meshes that do that
in lib are the overlay ones that swap geometry every frame. Those are exactly what must not go in a
bundle, which is worth writing down now rather than discovering.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 526 tests across 74 files, 54/54 WebGPU pixels, biome
clean on the touched files.

---

## Layer 6.111 — bundles record and replay, and step 1 was half wrong

`src/renderer/core/{bundle.ts (new),frame.ts,renderer-ops.ts}`, both backends' seams, `src/index.ts`,
`tst/render-bundle.test.ts` (new), `PLAN-render-bundles.md`.

```ts
const b = bundle('chunks');
b.draw(chunkA);
b.draw(chunkB);
const chunks = b.finish();

const pass = frame(renderer).pass({ target, camera });
pass.execute(chunks);
pass.draw(player);
pass.end();
```

**Step 1's second half was wrong and reversing it is most of the value here.** The design said
`encodeDraws` should be driven by the records rather than a flat prepared array, so a bundle could
stay whole. True for `executeBundles` — and not needed for replay, which is what steps 1 and 2 build.
Expanding a bundle at *prepare* time instead means `prepareRecordedDraws` recurses into its entries
and **neither backend learns bundles exist**: no change to either draw loop, no second encode path to
drift. Driving the encode from records belongs to step 3, where it has a reason.

**`bundle()` takes no target**, which the design had wrong by implication. The attachment shape a
bundle must match is the shape of the pass that executes it, so naming one at record time would be a
second source of truth to validate against. Step 3 validates against the executing pass instead.

The pooling hazard 6.110 anticipated was real: a slot that last held a bundle has no `mesh` to
overwrite, so `recordDraw` replaces the entry whole when the kind differs and mutates in place when it
does not, keeping 6.87's invariant for the common case.

Tests assert the thing worth asserting until a device bundle exists: a replayed bundle issues **the
same draws as recording them directly**, and interleaves with direct draws in order. Mutation-tested
by making the expansion a no-op, which fails exactly those two.

`public-api` caught `BundleRecord` unexported, which is the ratchet doing its job on a type that
reached the public surface through a union member rather than a direct export.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 530 tests across 75 files, 54/54 WebGPU pixels, all
WebGL pixels, 2/2 tree-shake bundles, biome clean on the touched files apart from a pre-existing
`useTemplate` and format complaint in `renderer-ops.ts`'s device-loss logger, forty lines from the edit.

---

## Layer 6.112 — the net before the change it guards

`tst/webgpu-render/{cases.ts,case-names.mjs}`, `PLAN-render-bundles.md`.

Step 3 is where WebGPU stops replaying a bundle's records and records a real `GPURenderBundle`. The
only thing that can show a replay and a device bundle agree is pixels, so step 4's comparison case is
built first — a net written before the change it catches rather than after.

`bundle-replay` draws two overlapping fullscreen meshes, red then green, once directly and once
through `pass.execute`, and compares the centre pixel of each target. Overlapping is what makes order
observable: the visible pixel is whichever drew last.

**Checked that it can fail**, because both paths currently share the expansion and would agree
trivially. Reversing the replay order gives `direct=0,255,0 bundled=255,0,0`, caught. It is a net, not
a tautology.

The harness reported 55/55 while the task reported failure — that was `grep -c "✗"` exiting 1 on zero
matches at the end of my own command, not the run. Worth recording because the same shape will
misreport again.

Verified: src tsc 0, tst tsc 0, 530 tests across 75 files, 55/55 WebGPU pixels including the new case.

---

## Layer 6.113 — the encode loop, sliceable, and WebGL excused from bundles entirely

`src/renderer/webgpu/render-pass.ts`, `PLAN-render-bundles.md`.

Step 3 records a real `GPURenderBundle`, and the piece it needs first is that the draw loop can run
over a *slice* of the prepared objects — because a bundle is a contiguous slice, and recording one
means running the same loop against a `GPURenderBundleEncoder` instead of a pass encoder. Extracted as
`encodeDrawRange(..., from, to, ...)`, with `encodeDraws` now a call over the whole range. Pure
refactor, no new data, and the 55 pixel cases are what says so.

Doing it first was the point: the alternative is one cycle that restructures the hot loop *and*
introduces bundle encoders and caching, where a pixel regression could be either.

**WebGL turns out to need none of this, which is worth more than the extraction.** Prepare-time
expansion already hands it the flat list in the right order, and that *is* the replay — so
`webgl/render-pass.ts` is untouched by the whole feature. An earned API difference under
`PLAN-backend-symmetry.md` rule 4, WebGPU having render bundles where WebGL2 does not, rather than
decomposition drift. Practically it also saves a bad change: WebGL's loop carries per-pass GL state
set up before it — `establishPassBaseline`, the state cache, the current program and VAO — so slicing
it would mean threading that through for no gain.

Verified: src tsc 0, 530 tests across 75 files, 55/55 WebGPU pixels, biome clean on the touched file.

---

## Layer 6.114 — bundles stay whole through prepare

`src/renderer/core/{render-types.ts,renderer-ops.ts}`, both frame backends,
`tst/prepare-recorded-draws.test.ts`.

6.111 expanded bundles at prepare time, which is right for replay and wrong for the acceleration:
once a bundle's draws are indistinguishable from the ones around them, WebGPU cannot record one
device bundle per run. `prepareRecordedDraws` now emits `PreparedSegment[]` alongside the flat
prepared array — a run per bundle, and a run for the direct draws between them.

A bundle's draws are **still prepared**, because a bundle has to be prepared before it can be
recorded. So a segment is a range over the same array rather than a parallel list, which is what keeps
`encodeDrawRange` from 6.113 able to serve both cases unchanged.

The segments pool joins the per-depth pools beside `preparedByDepth` and `preparedOptsByDepth`, so
the steady-state frame still allocates nothing.

**WebGL takes the argument and ignores it**, which 6.113 established is correct rather than lazy: the
flat list in order already is the replay there. It threads the pool only because the two backends
share `prepareRecordedDraws`.

Behaviour is unchanged by this layer — the segments have no consumer until the bundle encoder lands —
so it is pinned by structure rather than by pixels: a bundle between two direct draws prepares four
objects in recorded order and yields exactly three segments, the middle one carrying the bundle.

Verified: src tsc 0, tst tsc 0, 531 tests across 75 files, biome clean on the touched files.

---

## Layer 6.115 — WebGPU records a real device bundle

`src/renderer/webgpu/render-pass.ts`, `{backend-state,webgpu-backend}.ts`, `tst/stub-gpu.ts`,
`tst/render-bundle.test.ts`.

A bundle run no longer replays its draws into the pass. `getOrRecordBundle` builds a
`GPURenderBundleEncoder` with the executing pass's attachment signature
(`getRenderContextColorFormats` / `getRenderContextDepthFormat` / `sampleCount`), records the run
through the same `encodeDrawRange` the direct path uses, and the pass issues one `executeBundles`.
The cache lives on the backend — bundle, then camera, then pass-context id — because core may name no
device object. Version compare decides a re-record, so `invalidate()` is the whole invalidation
story.

**There is no attachment-shape mismatch to report, and the plan was wrong to reserve an error for
it.** A bundle carries no target; it is recorded *from* the pass that executes it, so its signature
is that pass's by construction. Using one bundle under two different attachment shapes records twice
against the same `RenderBundle`, keyed apart by pass-context id, which is correct rather than an
error. What a bundle genuinely cannot do is set a stencil reference, and that throws by name.

**The camera is part of the key and can be absent.** `RenderContext.camera` is `View | null` and a
camera-less pass is ordinary — the `bundle-replay` pixel case is one. A `passCtx.camera!` there
throws `Invalid value used as weak map key` on a real device, which is exactly what that case caught;
camera-less passes now share one sentinel key.

The stub grew the device path it was missing: a bundle encoder that records draws into the same
counter, plus `bundleRecordings` and `bundleExecutions` so a test can see recording happen once and
replay happen every frame. It omits `setStencilReference` because a real one lacks it. The old stub
returned `{}` and swallowed `executeBundles`, so every bundle draw vanished — the unit tests passed
only because the lowered path never reached the device.

Mutation-tested four ways: ignoring the version, never reading the cache, never calling
`executeBundles`, and restoring the `camera!` assertion each fail exactly one assertion.

`encodeDraws` now builds an `EncodeContext` once per pass instead of threading nine invariant
arguments into every range and recording; `encodeDrawRange` loses its export, having never had a
caller outside the file.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 533 tests across 75 files, 55/55 WebGPU pixels,
WebGL pixels pass, 48/48 GLSL link, 38 naga, 2/2 tree-shake, docs build, biome clean on the touched
files.

---

## Layer 6.116 — the bundles documentation, and two loops that recursed

`docs/README.template.md`, `tst/doc-code-blocks.test.ts`, `tst/render-bundle.test.ts`,
`PLAN-render-bundles.md`.

Render bundles are documented under **Drawing Many Things**, which already frames instancing and
indirect as "many copies of one thing". A bundle is the other axis and is introduced as such: many
*different* draws whose set does not change. The WebGL sentence is the honest one the plan asked for,
next to the WebGPU one rather than buried: it costs nothing and buys nothing there, and code written
against bundles runs correctly on both.

**Writing the docs found two broken snippets, and the fix found a bug class.** Both frame loops read
`function frame() { ... const f = frame(renderer); ... }` — after the rename from `renderer.frame()`,
the local shadows the import and the call recurses forever. The transform-feedback one also used an
`f` it never opened. The existing doc guard checks `renderer.x` members and ASCII, neither of which
can see this, so `no README block shadows a free function it also calls` is new. Shadowing alone is
legal and the guard says so: `const sampler = new GpuSampler(...)` never calls `sampler()`, and
`texture(tex, sampler)` really does take the raw sampler. The bug is declare-and-call, so that is the
rule, and reinstating `function frame()` fails it.

**A documented claim was checked rather than asserted, and the first test of it was wrong.** The docs
say one bundle under two attachment shapes records twice and caches both. The test used
`renderTarget(64, 64)` against an explicit `rgba16float` and saw one recording — but the default
*is* `rgba16float`, so both passes were the same shape and the single recording was correct. Logging
the context key showed it directly. The claim holds once the formats actually differ.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 535 tests across 75 files, 55/55 WebGPU pixels,
WebGL pixels pass, docs build, biome clean on the touched files.

---

## Layer 6.117 — `drawScene` takes a Renderer, not a list of the privates it uses

`src/scene/draw-scene.ts`, `src/camera/cube-camera.ts`, `src/index.ts`, `PLAN-explicit-frame.md`.

The scene walk is the layer lib is meant to keep calling, so its signature is public API. It read
`drawScene(gpu: SceneGpu, ...)`, where `SceneGpu` was a structural type of `_renderLists`, `_nodes`
and `inspector` — **exported from `index.ts`, so the public surface carried a type whose only content
is which of the renderer's privates this function reaches for.** It now takes `Renderer`. `SceneGpu`
is deleted; nothing but its own export line ever named it. There was no cycle forcing the structural
shape: `renderer/core/renderer.ts` does not import `scene/`.

Its doc line claimed the walk is "built on `pass.draw` and nothing private", which the `SceneGpu`
fields contradicted in the same file. It says what is true instead: the draws go through the public
`pass.draw`.

`CubeCamera.update` and the walk were the only two `gpu:` parameters left in `src`; both are
`renderer` now, matching the name the docs and examples use. The `{ gpu: GPURenderBundle }` fields in
the bundle cache keep the name, where it does mean a device object.

**Two plan corrections, from reading the code against it.** The planned signature carried an
`opts?: DrawSceneOpts` that the plan never defined, named a field of, or gave a consumer — dropped.
And the plan credits `DrawOpts.material` to the render list "resolving" each item's material;
`RenderItem.material` is a cache of `mesh.material` and never a substitution, so `pass.draw(item.mesh)`
is already equivalent and the walk passes no opts. `DrawOpts.material` stands on its own as a
caller's per-draw override, which `draw-material` covers.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 535 tests across 75 files, 55/55 WebGPU pixels,
WebGL pixels pass, biome clean on the touched files.

---

## Layer 6.118 — five inspector hooks took a frame id nothing read

`src/inspector/{inspector-base,inspector,renderer-inspector}.ts`, both frame backends,
`src/renderer/webgpu/compute.ts`, `src/scene/draw-scene.ts`, `tst/scene-layer-reach.test.ts`.

6.117 left `drawScene` reaching two privates: `_renderLists`, and `_nodes.nodeFrame.frameId` passed
to `beginRenderScene`. Following the second one found that `beginRenderScene`, `beginRender`,
`finishRender`, `beginCompute` and `finishCompute` all take a `frameId` **no implementation reads** —
`RendererInspector` names it `_frameId` in every one, and `Inspector` accepts it only to forward it
to a super that discards it. Five parameters, threaded from two frame backends and a compute pass,
carrying nothing. Removed.

**`begin(frameId)` keeps its parameter, against my first reading of this.** Its `void frameId;` in
`RendererInspector` looks identical to the dead ones, but `Inspector.begin` labels the timeline entry
with it. One real consumer is the difference between a dead parameter and a live one, and the check
is the subclass rather than the base.

`drawScene` now reaches exactly one private, the render-list cache, and `tst/scene-layer-reach.test.ts`
is the pair that holds it: the walk's private reach is exactly `_renderLists`, and
`collectRenderList` genuinely takes a `RenderListsState`, so the reach is a cache rather than a
convenience. Both halves mutation-tested.

This does not make the walk externally reconstructible — `collectRenderList` is not exported — so the
plan's "scene layer is a layer" claim is still in-package only. That is recorded in the plan rather
than papered over.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 537 tests across 76 files, 55/55 WebGPU pixels,
WebGL pixels pass, biome clean on the touched files.

---

## Layer 6.119 — the 6.104 bug class, made checkable

`tst/render-object-refresh.test.ts`, `src/renderer/core/render-object.ts`.

6.104 was a geometry swap that kept drawing the old geometry. The audit it deserved, done here:
**what else on a `RenderObject` can go stale the same way?** The cache is keyed
mesh, then material, then render context, so a swap of any of those three lands on a different entry
and cannot drift. `camera` is refreshed on every hit. Of the fields `createRenderObject` copies off
the mesh, `geometry` is the only one — which is exactly why it was the bug, and why nothing else
needs the same hand-invalidation. **Checked, not assumed: `material` needed no fix because it is part
of the key, not because anyone refreshes it.**

The knowledge was in a doc line calling `geometry` "cached for convenience", which reads identically
to the fields beside it that behave completely differently. It is a test now: the AST reads which
properties `createRenderObject` initialises from `mesh`, and which the cache-hit branch writes back,
and requires the first set to be inside the second. Adding `count: mesh.count` to the constructor
fails it, as does deleting the geometry refresh — 6.104 itself. The paired half pins the three-level
key, since that is the entire reason material is safe to leave alone.

`render-object.ts` also listed `scene` among its source references, a field the type has not had
since the walk went treeless.

Verified: src tsc 0, tst tsc 0, 539 tests across 77 files, 55/55 WebGPU pixels, WebGL pixels pass,
biome clean on the touched files.

---

## Layer 6.120 — the settled claims, re-checked against the code

`tst/side-effect-free.test.ts`.

The plan's "Resolved during design" section says outright that "settled" is a claim about the
implementation and that two of its entries had already drifted, so re-checking them is the plan's own
instruction rather than an aside. Four checked here.

**`sideEffects: false` holds, and now has the gate it was missing.** Zero module-scope expression
statements across `src`, so no module does work merely by being imported. This one was worth pinning
rather than just reading: the declaration licenses a bundler to drop any module a consumer takes no
binding from, and `tst/tree-shake` proves dropping *works* without proving it is *safe*. The pair is
the declaration plus the property, and adding a module-scope call to `frame.ts` or deleting the
`package.json` field each fails it.

**No `exports` map**, so "the consumer's own module boundary is the right split point" still holds by
construction. `"type": "module"` is set, so the bare `main: dist/index.js` with no `module` field is
consistent rather than the CJS/ESM mismatch it can look like.

**`overrideMaterial` is gone** — `tst/retired-names.test.ts` already carries it — and `DrawOpts.material`
survives as the per-submission form the plan distinguishes, covered by the `draw-material` pixel case.

Also confirmed `dist` is current with the 6.104 geometry fix and 6.118's signatures, so the linked
consumer is reading the fixed build rather than a stale one.

Verified: src tsc 0, tst tsc 0, 540 tests across 78 files, 2/2 tree-shake, 55/55 WebGPU pixels,
WebGL pixels pass, biome clean on the touched file.

---

## Layer 6.121 — replay skips the per-draw update, and 6.116's docs were wrong about it

`src/renderer/webgpu/{bindings,render-pass,backend-state,webgpu-backend}.ts`,
`tst/render-bundle-stale-bindings.test.ts`.

Chasing what a recorded bundle does when a render target it samples is resized found something
larger. **`prepareRenderObject` does not update anything.** It runs `initRenderObject` only; the
`updateRenderObject` call that uploads uniforms and rebuilds bind groups lives in
`uploadRenderObjectResources`, which only the pre-warm calls. Per frame that work happens at *encode*
time, inside `encodeDrawRange`.

A replayed bundle never runs `encodeDrawRange`. So it skips the per-draw update entirely, which has
two consequences 6.115 shipped without noticing:

1. **A rebuilt bind group is never picked up.** `setSize` on a sampled render target reallocates the
   texture and bumps its generation, which turns into a fresh `GPUBindGroup` — but the recorded
   `GPURenderBundle` has the old one baked in. `render-target.ts` documents this hazard class
   exactly ("another pass that already recorded a draw against it submits with a destroyed texture")
   and the lazy realloc closes that window *within* a frame. A bundle recorded on an earlier frame is
   a window it does not close.
2. **Per-object uniform data does not fully reach the GPU on replay.** Measured, not assumed: after
   changing a uniform, the direct path issues 4 buffer writes and the bundled path 2.

**So the docs written in 6.116 are wrong** where they say a bundle needs nothing from you when a
value changes. That is true of data written into a buffer the recorded group already points at, and
false of anything `updateRenderObject` would have done. Not corrected yet, because the right fix
changes what the sentence should say.

Landed here: `BindingsState.bindGroupRebuilds`, bumped at the single render-side
`rebuildGPUBindGroup` call, and stored with the recorded bundle so replay can compare it. That is the
mechanism the fix needs and it is **not sufficient on its own** — nothing bumps it for a bundled
draw, because the binding update is exactly what replay skips.
`tst/render-bundle-stale-bindings.test.ts` pins the defect with `test.fails`, so the suite stays green
and fixing the bug turns it red.

The shape of the real fix, for the next layer: bundled draws need `updateRenderObject` to run every
frame at prepare time, keeping the saving on the encode side where it actually is. Ground it in what
three.js does for a `BundleGroup` before deciding.

Verified: src tsc 0, tst tsc 0, 541 tests across 79 files, 55/55 WebGPU pixels, WebGL pixels pass,
biome clean on the touched files.

---

## Layer 6.122 — a replayed bundle owes its draws an update

`src/renderer/webgpu/render-pass.ts`, `docs/README.template.md`,
`tst/render-bundle-stale-bindings.test.ts`.

Grounded first, as the plan asked. three.js's `_renderBundle` has exactly this shape: when the bundle
does not need re-recording it walks the recorded render objects and runs `updateForRender` on nodes,
geometries and bindings before `addBundle`. **The saving is the encoding, not the update**, and 6.115
took both.

`refreshDraw` is that update, extracted from `encodeDrawRange`'s loop so the record path and the
replay path cannot drift: one is `refreshDraw` plus encoder calls, the other is `refreshDraw` alone.
It keeps the empty-draw check, so `instances === 0` still skips the work rather than uploading for a
draw that will not happen.

**Ordering is load-bearing and the first attempt had it wrong.** Refreshing after the cache check
reads `bindGroupRebuilds` before the refresh can bump it, so a resize replays the stale bundle for one
frame — with a texture that has been destroyed, which is a validation error rather than a stale
image. The refresh runs first. Both tests catch the inverted order, one as a missing re-record and the
other as three buffer writes where four are due.

Both halves measured rather than argued. A changed uniform now issues the same buffer writes through
a bundle as through a direct draw (4 and 4, against 2 and 4 before). A resized sampled render target
re-records, where before it did not.

**6.116's docs turn out to be right after all**, because the fix restores the semantics they
describe rather than changing them: a value change needs nothing from the caller. Added the honest
magnitude note beside it, since "the per-draw pipeline and binding calls stop happening" could be
read as claiming the update stops too.

Verified: src tsc 0, tst tsc 0, 542 tests across 79 files, 55/55 WebGPU pixels, WebGL pixels pass,
docs build, biome clean on the touched files.

---

## Layer 6.123 — the cross-backend claim, proven on the other backend

`tst/webgl-render/harness.ts`.

The README says code written against bundles runs correctly on both backends and only WebGPU gets
faster. Until now that was proven on one backend: `bundle-replay` existed in the WebGPU harness and
had no WebGL counterpart, so the half of the claim about the backend that does *less* was the
unproven half.

WebGL is correct by construction — its `encodeDraws` walks the flat prepared array and ignores the
segments entirely, so a bundled draw is an ordinary draw and 6.122's missing per-draw update could
not happen there. That is an argument, not a measurement, so the case now exists: two overlapping
fullscreen draws, recorded and replayed, against the same two drawn directly. Both read
`0,255,0,255`, so the second draw wins either way and order survives the lowering. Reversing the
expansion order in `prepareRecordedDraws` turns the bundled read red while the direct one stays
green.

No WebGL counterparts to 6.122's two unit tests, and deliberately: with no recorded device object
there is nothing to go stale, so they would assert a property that holds vacuously. The pixel case is
what carries the equivalence.

Also applied Biome's import sort to the harness, which had drifted on three imports unrelated to this
change.

Verified: src tsc 0, tst tsc 0, 542 tests across 79 files, 55/55 WebGPU pixels, WebGL pixels pass
(86 cases), biome clean on the touched file.

---

## Layer 6.124 — BackendState, finished rather than half-done

`src/renderer/webgpu/{render-objects,bindings,compute,geometries,prepare,render-pass,frame-backend}.ts`,
`tst/backend-state-boundary.test.ts`.

The backend had both conventions at once, and the seam between them was the worst place to be: call
sites that held `b: BackendState` and spread seven of its fields back into positional arguments.
That pays the aggregate's cost (the callee's real dependencies are invisible at the call site) *and*
the explosion's cost (every signature churns when one dependency moves), for no benefit either way.

Converted, with the parameter counts: `initRenderObject` 9 to 4, `updateRenderObject` 9 to 3,
`initRenderObjectWithPromises` 10 to 5, `updateRenderBindings` 8 to 3, `updateComputeBindings` 8 to
4, `encodeDispatches` 15 to 9, `Geometries.updateForRender` 4 to 2. Zero call sites now unpack the
aggregate. Seven type imports in `render-objects.ts` and two in `compute.ts` went with the
parameters they existed to declare, which is the clearest measure that the caches were being named
for no other reason.

**The line is at the module boundary, not everywhere.** `rebuildGPUBindGroup` and the other private
helpers in `bindings.ts` and `geometries.ts` keep naming the caches they use — handing them the whole
backend would be the over-abstraction, since a private helper's parameter list is the only statement
of what it touches. `updateBuffer`, `updateIndex` and `initGeometry` were exported without a single
caller outside their own module, so they are private now and the boundary is visible in the code
rather than inferred.

`tst/backend-state-boundary.test.ts` holds both halves: no exported function in the WebGPU backend may
name three or more of `BackendState`'s own members, and `rebuildGPUBindGroup` must still name its
own. Re-exporting a helper that spills three caches fails the first; collapsing the private helpers
onto `BackendState` fails the second.

Also collapsed an eight-line comment on `initRenderObjectWithPromises` that restated its name, and a
`// Update geometry if needed` above `updateGeometry(b, renderObject)`.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 544 tests across 80 files, 55/55 WebGPU pixels,
WebGL pixels pass, 2/2 tree-shake, biome clean on the touched files.

---

## Layer 6.125 — the same rule on the other backend

`src/renderer/webgl/{transform-feedback,webgl-backend}.ts`, `tst/backend-state-boundary.test.ts`,
`PLAN-backend-symmetry.md`.

6.124's guard only looked at `webgpu/`, which is the mistake `PLAN-backend-symmetry.md` exists to
prevent: a rule enforced on one side is not a rule. Run against `webgl/` it reported exactly one
offender, `runTransformFeedback` at 4 caches and 10 parameters — WebGL was nearly converted already,
where WebGPU had been half done.

Now 7 parameters and no individual caches; both call sites pass `this`, since `WebGLBackend
implements BackendState`. Three type imports went with the parameters. The guard scans both
directories under one rule, and reverting this conversion fails it.

**`gl` deliberately stays a separate first parameter.** WebGL's `BackendState` excludes it, and the
reason is already written where it belongs: it is nullable until `init` acquires it, and an
immediate-mode backend passes it explicitly at every call. That is the symmetry plan's
"unpaired needs a justification" rule satisfied rather than broken, so the rule is recorded there as
a sixth symmetry rather than left implicit in two guard tests.

Verified: src tsc 0, tst tsc 0, 544 tests across 80 files, 55/55 WebGPU pixels, WebGL pixels pass,
biome clean on the touched files.

---

## Layer 6.126 — pooling, checked for the things 6.114-6.122 added

`tst/frame-pooling.test.ts`.

Started as a scope audit of the guard tests, prompted by 6.125: a rule enforced on one directory is
not a rule, so which others only look at one? **None** — every backend-paired guard
(`backend-symmetry`, `cache-owns-its-stats`, `deferred-fields`, `renderer-backend-boundary`,
`backend-state-boundary`) already names both, and the single-directory ones are single by nature,
since scanning `src/renderer/core` *is* the core-has-no-device rule. A negative result, but the
question was worth asking once.

So instead: the pooling invariant, which the plan's performance section leans on as the answer to the
per-frame allocation this design introduces, and which had five tests written before bundles existed.
Two pooled arrays have been added since and neither was covered.

`PassEntry` is a union, so a pooled slot that last held a draw has no bundle field to overwrite and
`recordDraw` / `recordBundle` replace the slot whole when the kind differs. For a frame whose shape
is stable — the case pooling is for — the kinds line up and the slots are reused; that is now
asserted by identity across two frames of `draw`, `execute`, `draw`. Forcing either recorder to
allocate fails it.

The segments array pools through `preparedAt(s.segmentsByDepth, depth)` beside the prepared and
prepared-opts arrays, and is the same array on the second frame. Making `preparedAt` allocate fails
that one.

My first version of the second test expected three segments where two are right: a direct draw
followed by a bundle is one run each, not three.

Verified: src tsc 0, tst tsc 0, 546 tests across 80 files, 55/55 WebGPU pixels, WebGL pixels pass,
biome clean on the touched file.

---

## Layer 6.127 — a disposed bundle drew nothing, and the label was thrown away

`src/renderer/core/{bundle,frame}.ts`, `src/renderer/webgpu/render-pass.ts`, `tst/render-bundle.test.ts`,
`tst/stub-gpu.ts`, `docs/README.template.md`.

Two defects from reading `bundle.ts` against the conventions the rest of this API already holds.

**`dispose()` left no marker.** It cleared the records and bumped the version, so executing a
disposed bundle found nothing to draw and drew nothing — silently. Every other lifecycle mistake here
throws and names the thing: `draw after finish()`, `draw after end()`, `execute after end()`. This
one was the exception, and it is the worst kind to leave silent because the symptom is missing
geometry with no error to search for. `RenderBundle` now carries `disposed` and `execute` refuses.
`dispose()` is idempotent too, so a second call no longer moves the version.

**The label was accepted and discarded.** `bundle('static-props')` captured it for one error message
and nothing else: both device objects were hardcoded `'gpucat-bundle'`, so a capture in a debugger
showed every bundle under the same name. It is on `RenderBundle` now and reaches
`createRenderBundleEncoder` and `finish`. The stub records the labels it is handed, which is what
makes that checkable without a device.

Both mutation-tested: dropping the guard, and restoring the hardcoded label, each fail exactly one
test.

Verified: src tsc 0, tst tsc 0, 548 tests across 80 files, 55/55 WebGPU pixels, WebGL pixels pass,
docs build, biome clean on the touched files.

---

## Layer 6.128 — the lifecycle guards that nothing was checking

`tst/frame.test.ts`.

6.127 found a silent `dispose()` among a set of guards that otherwise all throw by name, which raised
the obvious follow-up: are the rest of them actually held? `frame.ts` has fifteen throws. Eleven had
a test. Four did not, and an unchecked guard is one that can be deleted without anything noticing.

Covered now: `execute after end()` (its sibling `draw after end()` was tested, it was not), `dispatch
after end()` on both a compute pass and a transform feedback pass, and `${verb} after the frame was
closed`, asserted through two different verbs so the message really is parameterised rather than
fixed. All four run against the fake backend already in the file, so none needs a device.

Mutation-tested by deleting each guard: `execute after end()` and the closed-frame check fail one
test each, `dispatch after end()` fails two, because one line guards both pass kinds.

Verified: src tsc 0, tst tsc 0, 552 tests across 80 files, biome clean on the touched file apart from
a pre-existing comma-operator warning on a line this layer did not touch.

---

## Layer 6.129 — a debugging field nothing debugged with

`src/renderer/core/render-object.ts`, both backends' `render-pass.ts`, `tst/pipeline-label.test.ts`.

`MaterialOptions.name` exists, is documented "for debugging", and is stored at construction.
**Nothing read it.** Both backends built the inspector's pipeline label as
`mesh.name || material.constructor.name`, reaching past the field meant for exactly this to the class
name instead — so every unnamed mesh reported `Material`, and the draw-calls tab was a column of
identical rows. One `pipelineLabel(mesh, material)` in core now, used by both, consulting the material
between the mesh and the class.

The mesh keeps priority, being the more specific of the two, and both orderings are pinned: dropping
`material.name` from the chain and promoting it above `mesh.name` each fail one test.

**6.126's "no scope gaps" was too quick.** That audit asked which guards scan one *backend* and
concluded none were missing a side. It should have asked which encode a general rule against a narrow
scope: `frame-record-is-read` is "a field written and never read is a second source of truth", scoped
to `FrameRecord` in `src/inspector`, and `material.name` is that same defect three directories away.
The rule's reach is the gap, not the backend coverage.

Verified: src tsc 0, tst tsc 0, 555 tests across 81 files, 55/55 WebGPU pixels, WebGL pixels pass,
biome clean on the touched files.

---

## Layer 6.130 — `create*` factories, and the casts they exposed

`src/{material/material,geometry/geometry,objects/mesh,core/object3d,scene/scene,index}.ts`,
43 files across `src` and `examples`, `docs/{README.template.md,snippets.ts}`,
`tst/resource-factories.test.ts`.

`createMaterial`, `createGeometry`, `createMesh`, `createObject3D`, `createScene`. The classes stay
exported; these are the preferred spelling.

**`create*` rather than the bare noun, and the codebase had already decided this.** gpucat splits its
factories cleanly: node/DSL factories are bare nouns (`texture`, `uniform`, `storage`, `attribute`,
`sampler`) and resource factories are `create*` (`createBoxGeometry`, `createStorageTexture`,
`createVertexBuffer`). `Material` and `Geometry` are resources, so `material()` would have been the
inconsistent one. The shadowing evidence agreed: 38 of the 60 files that build a material also bind a
local called `material`, and `frame()` — a bare noun for a recording context — had already caused
exactly that bug in the README at 6.116.

**Two self-inflicted errors, both caught by the gates.** The `new Material(` sweep rewrote the call
inside `createMaterial` itself, so the factory called itself; every test failed with a stack
overflow. And `example-webgpu-mipmaps.ts` already had a *local* `createMaterial(tex)`, which the new
import collided with — the very hazard the naming was chosen to avoid, just from the other side. The
local is `materialForTexture` now. `tst/resource-factories.test.ts` pins both: each factory builds the
class it names, and reintroducing the self-call fails it.

**All seven `as unknown as` casts in the examples are gone.** Four were `vUv as unknown as
Node<d.vec2f>` and simply unnecessary — `sample(vUv)` typechecks. The two `data as unknown as Mat4`
were real, and the fix was not a narrower cast: the examples were holding the light matrix as a raw
`Float32Array(16)` and pushing it into `mat4.mul`. They own a `mat4.create()` now and the uniform
references it, so no typed array reaches the math library.

**The underlying reason those casts existed is a library defect, not an example one.**
`Uniform.value` is typed `number[] | Float32Array | [16 numbers] | null` regardless of the schema, so
reading one back gives a union that nothing can consume without narrowing. Recorded here rather than
fixed: typing `Uniform<D>.value` by `D` is its own layer.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 557 tests across 82 files, 55/55 WebGPU pixels,
WebGL pixels pass, docs build, biome clean on the touched files.

---

## Layer 6.131 — the index-buffer cast, and a convention I overstated

`src/core/gpu-buffer.ts`, `tst/index-buffer-format.test.ts`, `PLAN-explicit-frame.md`.

`createIndexBuffer` laundered a `Uint16Array` through `as unknown as Uint32Array` under a comment
vouching for itself: "Cast is safe: we're storing uint16/uint32 indices, itemSize=1 matches".

**The cast is not laziness; there is no truthful schema to pick.** WGSL's scalars are `u32`, `i32`,
`f32` and `f16` — there is no `u16`. An index buffer is not WGSL-typed data at all: it is consumed by
the index stage as a `uint16`/`uint32` *format*, which `getIndexFormat` reads off the array at
runtime. `GpuBuffer<T>` requires a schema regardless, so the cast is where a type system that does
not model index buffers gets forced to produce one.

The comment's claim is a test now, which is where it belonged: a 16-bit buffer keeps its
`Uint16Array` and reports `uint16`, a 32-bit one reports `uint32`, and the placeholder schema does
not drive the element count — the `itemSize=1` half of the old comment. Making the schema drive the
count turns six indices into 1.5 and fails. The comment left behind is one line and says what is
true: the schema is a placeholder and the array is the source of truth. The double cast is a single
one, since `as unknown` was never needed.

**6.130's convention claim was too strong.** It said resource factories are `create*` and node
factories are bare nouns. `renderTarget`, `canvasTarget` and `cubeRenderTarget` are bare-noun
factories for resources, so the split is real but not clean, and the plan now says so rather than
overstating a rule that three public functions already break.

A `cube-mips` SIGSEGV appeared once in the WebGPU harness and did not reproduce in four further runs.
A native crash in a type-only change is not a result; recorded as the flake it is rather than chased.

Verified: src tsc 0, tst tsc 0, 560 tests across 83 files, 55/55 WebGPU pixels, WebGL pixels pass,
biome clean on the touched files apart from a pre-existing import sort this layer did not touch.

---

## Layer 6.132 — uniform values respect the schema, and the regression that cost

`src/core/uniform.ts`, `src/schema/pack.ts`, `src/renderer/webgpu/bindings.ts`,
`src/controls/transform-controls.ts`, `tst/uniform-value-type.test.ts`.

`UniformValue<T>` was `Infer<T> | number[] | TypedArrayFor<T>` for reads as well as writes, so every
caller reading a uniform back had to narrow. The clinching evidence was in the hot path:
`packToView(m.schema, view, m.offset, value as never, ...)` under a comment vouching for the cast.

Writes still take the wide union. **Reads are `UniformStored<T>` — no `number[]`** — because a flat
array is packed into the schema's own typed array on assignment. A typed array is adopted by
reference, which is what lets a caller keep a handle and write through it each frame, so the
efficient pattern is now the correctly typed one rather than a cast.

`packToView` declares `Infer<D> | TypedArrayFor<D>` now, which is what it always accepted: the
generated writer indexes positionally, so a typed array and a tuple are the same to it. `as never` is
gone.

**It found one real unsoundness immediately.** `transform-controls.ts` cloned a material's colour with
`srcColor.value as number[]).slice()`, where the source is a `Uniform<Any>` whose value can be a
number (no `.slice`) or an `Int32Array` (wrong element type for the `vec4f` being built). Both were
invisible under the cast; it narrows on `Float32Array` now and falls back to white.

**And it shipped a regression that the whole gate set missed.** `new ArrayCtor(next.length)` plus
`set(next)` is nonsense for an *array of vectors*: `sizedArray(vec3f, 2)` assigned
`[[1,2,3],[4,5,6]]` became `Float32Array(2)` of `NaN`. That value reaches the GPU as a silently wrong
uniform block, which is what broke bongle's sky — src tsc, 564 tests, 55/55 WebGPU pixels and the
WebGL harness were all green over it, because nothing in this repo has an array-of-vectors uniform.
Only flat runs of numbers pack now. The three shapes that were broken — array of vectors, array of
matrices, struct — are covered, and deleting the guard fails two of them.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 567 tests across 84 files, 55/55 WebGPU pixels,
WebGL pixels pass, biome clean on the touched files, `dist` rebuilt so the linked consumer has the fix.

---

## Layer 6.133 — a gate for the shapes, not just the one that broke

`tst/uniform-pack-round-trip.test.ts`.

6.132's regression was not caught by anything here, and patching the single case it broke would leave
the reason untouched: **no test asked what a uniform's value becomes for each shape the schema
language offers.** So the suite could only ever catch the shapes this repo happens to use.

The invariant is the strong one: however a value is spelled, it reaches the GPU as the same bytes.
Eight shapes assert that a plain array and the matching typed array pack identically — `f32`, `vec2f`,
`vec3f`, `vec4f`, `vec4i`, `vec4u`, `mat3x3f`, `mat4x4f` — which is exactly the equivalence
`UniformValue`'s three input forms promise and nothing checked. Three more cover the shapes with no
flat spelling at all: an array of vectors, an array of scalars, and a struct.

Both halves have teeth. Reintroducing 6.132's regression fails the array-of-vectors case; packing a
plain array one element short fails three of the equivalence cases with an out-of-bounds write rather
than a silent difference.

A second one-off SIGSEGV appeared in the WebGPU harness and again did not reproduce. Two flakes in
two days from the same native layer is worth watching, not chasing.

Verified: src tsc 0, tst tsc 0, 578 tests across 85 files, 55/55 WebGPU pixels, WebGL pixels pass,
biome clean on the touched file.

---

## Layer 6.134 — the consumer's sky shape, reproduced here

`tst/uniform-pack-round-trip.test.ts`.

bongle's sky was still reported broken after 6.132, so this traced it from the consumer's code rather
than from this end. `lib/src/render/environment/environment.ts` builds it as
`sizedArray(vec3f, SKY_STOPS * 3)` — twelve vec3 colours — fed from `buildSkyValue`, which returns
`[number, number, number][]`, and assigned through `envSky.value = env._sky` when the sky is dirty.
That is exactly the array-of-vectors shape 6.132 broke and fixed.

Reproduced here at the real size: stored as twelve tuples, packed to 192 bytes, a 16-byte stride
(vec3 padding in the uniform address space), no NaN, and the second element landing at float 4 rather
than float 3. It is a permanent case now, because a consumer's real shape is the kind this suite kept
missing.

**So the packing is correct in this tree, and the remaining suspects are outside it.** The symlink at
`lib/node_modules/gpucat` resolves to this working copy and its `dist` carries the fix, so the
gpucat half is current. lib's only calls into signatures this work changed are two `drawScene(r, pass,
scene, camera)` in the icon-tile paths, which match the 6.117 signature and are not on the sky path.
What has not been verified from here is whether lib's own build has been rerun against the updated
`dist`.

Verified: src tsc 0, tst tsc 0, 579 tests across 85 files, biome clean on the touched file.

---

## Layer 6.135 — two silent guesses in the vertex path, and a consumer uploading its whole capacity

`src/renderer/webgpu/pipelines.ts`, `tst/{vertex-format-sizes,partial-buffer-upload}.test.ts`,
and in the consumer `lib/src/render/overlay/{quads,lines}.ts`.

**The sky was a stale build.** 6.132's fix was right; it needed lib rebuilt against the new `dist` to
land. Recorded because the reproduction here was correct and the remaining variable was outside this
tree.

**Two guesses on the vertex-format path, both of the sky's kind.** `getBytesPerElement` returned 16
("default to vec4") for a format it could not derive, and again for a format missing from its size
table. Either produces a wrong stride with no error — bad geometry rather than a failure. Instrumented
first rather than assumed: the fallback is hit **zero** times across the unit suite and the pixel
harness, so nothing relied on the guess. Both refuse by name now, the caller's message carrying the
buffer name, its array type and its itemSize.

The pairing is a test: every format `deriveVertexFormat` emits has a size, and that size equals the
array's `BYTES_PER_ELEMENT` times its itemSize. The absences are asserted too — WebGPU has no 8- or
16-bit format at one or three components, so those `undefined`s are the deriver being right, not a
gap.

**And the 700 kB/frame the consumer was uploading.** `overlay/quads.ts` `end()` bumped the version on
all four of its batch buffers, which `planBufferUpload` correctly reads as "all of it changed": four
full capacities, 4096 quads' worth, every frame regardless of how few were drawn. The four reported
sizes are exactly `4096 * 4 * {3,2,2,4} * 4` bytes, which is what identified it. They register a dirty
range over the prefix actually written instead, so the upload follows the frame's content.
`overlay/lines.ts` had the same shape and the same fix.

`tst/partial-buffer-upload.test.ts` pins the contract that now depends on: a range plans a partial
upload whatever the version says, a bare version bump plans a full one, an untouched buffer plans
nothing, and ranges are flat component indices that merge before upload.

Verified: src tsc 0, tst tsc 0, 586 tests across 87 files, 55/55 WebGPU pixels, WebGL pixels pass,
biome clean on the touched files, `dist` rebuilt.

---

## Layer 6.136 — the last two open items in the symmetry plan were already done

`tst/webgl-buffer-ownership.test.ts`, `PLAN-backend-symmetry.md`.

A survey of what is actually left found `PLAN-backend-symmetry.md` still listing two consequences of
WebGL having no `GpuBuffer -> WebGLBuffer` owner: a standalone buffer's disposal releasing nothing,
and "one GpuBuffer = one GL buffer" being claimed but false. **Both were fixed by step 4's restructure
and the plan had not been told.** The second even cites `webgl/renderer.ts`, a file that no longer
exists.

Verified rather than read off: `webgl/buffers.ts` has `setupBufferDispose`, chained rather than
assigned so the storage-texture path's callback survives, and one `bufferMap` keyed by `GpuBuffer`
identity. Since the WebGL backend takes `gl` as a parameter, both are testable without a device —
a recording context counts `createBuffer` and `deleteBuffer` while the real cache runs against it.

Disposing a standalone buffer deletes exactly its GL object and decrements the count; uploading one
buffer twice under different names returns the same object and creates one. Removing the dispose hook
fails the first, keying the map by anything but the buffer fails both.

Verified: src tsc 0, tst tsc 0, 588 tests across 88 files, WebGL pixels pass, biome clean on the
touched file.

---

## Layer 6.137 — swept the silent-guess class rather than waiting to trip on it

`src/renderer/webgpu/pipelines.ts`, `tst/vertex-format-sizes.test.ts`.

Six defects this session shared a shape: a lookup that guesses on a miss instead of refusing. So this
swept for it rather than waiting for the next one. Every numeric `??` and `||` fallback in `src`,
every swallowed `catch`, every `return undefined`.

**Most are fine, and checking beat assuming.** `maxTextureSize ?? 2048` looks like a guess and is not:
2048 is WebGL2's guaranteed minimum for `MAX_TEXTURE_SIZE`, and a narrower mirror only makes the
storage texture taller, so the layout stays correct. The `|| 1` cases are divide-by-zero guards on
vector normalisation and canvas sizing. No `catch` in `src` swallows anything.

**One real find, in the sibling branch of the function 6.135 fixed.** `resolveVertexGroupStride` has
two paths: a named buffer, whose stride 6.135 stopped guessing, and an unnamed group sized from its
WGSL type through `wgslTypeItemSize`, which ended `default: return 4`. An attribute type outside the
twelve listed — `f16` and its vectors are declarable — silently got a four-component stride, which is
garbled geometry and no error. Instrumented first: zero hits across the unit suite and the pixel
harness, so nothing depended on it. It throws by name now, and the twelve counts are pinned, so a
wrong entry fails as loudly as a missing one.

That closes both halves of one stride calculation. Restoring either guess fails a test.

Verified: src tsc 0, tst tsc 0, 590 tests across 88 files, 55/55 WebGPU pixels, WebGL pixels pass,
biome clean on the touched files, `dist` rebuilt.

---

## Layer 6.138 — every resource factory is `create*`, and two decisions land

`src/core/{render-target,cube-render-target}.ts`, `src/renderer/core/canvas-target.ts`,
`src/renderer/webgl/geometries.ts`, 72 files across `src`, `tst`, `examples` and `docs`.

**`renderTarget` / `canvasTarget` / `cubeRenderTarget` are `createRenderTarget` /
`createCanvasTarget` / `createCubeRenderTarget`.** 6.130 claimed `create*` was already the rule for
resources and 6.131 had to correct it, because these three were bare nouns. They are not now, so the
split is real rather than aspirational: **a resource is `create*`, a node is a bare noun.** Three
files bound a local called `renderTarget` or `canvasTarget`, the same shadowing that decided
`createMaterial`.

The sweep needed three passes because one pattern cannot catch a name that is a call, an import
specifier, a namespace member and a `typeof` reference at once — the same lesson as the earlier
`frame` rename. Calls went first with a lookbehind so `ctx.renderTarget` and the local variables were
untouched, then import specifiers, then the handful `tsc` named.

**`Mesh` does not become `Draw`.** Decided against rather than deferred. The plan always said the
argument would be made by the code, and the code never made it.

**`glComponentType`'s `default: return gl.FLOAT` is exhaustive now, and was not a live bug.**
`glType` is a closed union of three and the default caught `'float'` correctly. What it would not
catch is a fourth variant, which would silently become `FLOAT`; the `never` binding makes that a
compile error instead. Checked before changing, as the sweep in 6.137 established.

One WebGPU pixel run failed and passed on re-run: the fourth such native flake, all non-reproducing.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 590 tests across 88 files, 55/55 WebGPU pixels,
WebGL pixels pass, 48/48 GLSL, 2/2 tree-shake, docs build, biome clean, `dist` rebuilt.

---

## Layer 6.139 — `backend.compute` killed, and lib never reaches `.backend` again

`src/renderer/webgpu/webgpu-backend.ts`, `src/renderer/webgl/state.ts`, three tst files, and in the
consumer `lib/src/render/{pipeline,webgpu,webgl}.ts`.

**Four dual-source blend factors silently rendered as factor one.** `blendFactor`'s
`default: return gl.ONE` covered `src1`, `one-minus-src1`, `src1-alpha` and `one-minus-src1-alpha` —
found by making the switch exhaustive and letting `tsc` name what was missing. WebGL2 has no
dual-source blending at all, so they cannot be approximated the way a missing format sometimes can;
they throw. The other three tables in the file were genuinely exhaustive, and are compile-checked now
so a future WebGPU spec addition is an error rather than a silent `ALWAYS`, `FUNC_ADD` or `KEEP`.

**`WebGPUBackend.compute` is gone rather than wrapped.** The first move here was a `submitCompute`
free function mirroring `readBuffer`, which was the wrong answer: the method was pure convenience
built on `frame` + `f.compute()` + `submit`, and wrapping it would have kept a second way to do the
same thing. Reverted and deleted.

**Its three call sites in lib now ride the frame that consumes them.** Each was
`backend.compute(dispatches)` immediately before a `frame(...)` that drew the results, so the voxel
cull and the draws reading its indirect args were two submissions. `recordDispatches(f, dispatches)`
records a compute pass on the frame that follows, which is the thing the README promises frames for:
one submission, no CPU sync point in between.

**lib no longer names `.backend` anywhere.** The last three were device handles, and free functions
already existed for them: `gpuDevice`, `gpuAdapter`, `glContext`. Each is typed on its own
`Renderer<B>`, so reaching for a WebGPU device on a WebGL renderer is a compile error.

Three tests went with the method. Two existed only to compare it against `f.compute()`; the third
asserted its mid-frame refusal. The remaining coverage of `f.compute()` is what they were really
guarding. The memory-stats test used it to build a pipeline and records a frame instead.

Verified: src tsc 0, tst tsc 0, 604 tests across 89 files, 55/55 WebGPU pixels, WebGL pixels pass,
biome clean on the touched files, `dist` rebuilt.

---

## Layer 6.140 — the rename that every gate passed and lib still broke

`lib/src/render/{webgpu,webgl}.ts`, `lib/tst/unit/render/overlay-probe.test.ts`,
`lib/src/render/draw-list.ts`, `lib/PLAN-explicit-passes.md`.

6.138 renamed `renderTarget` to `createRenderTarget` with every gpucat gate green: three typechecks,
604 tests, both pixel harnesses, docs, tree-shake. **lib was broken the whole time**, and said so as
`renderTarget is not a function` in a lib unit test, later.

Nothing in gpucat imports lib, so no gate here can see it, and `lib/node_modules/gpucat` is a symlink
to this working copy — the break lands the moment the rename does. Four call sites, now migrated. A
full `typecheck` in `lib/` is clean apart from two pre-existing errors in
`editor/src/processes/runtime.ts`, so nothing else this session has broken it. The practical rule is
saved where it will be read next time: a rename to gpucat's public surface is not done until lib
typechecks.

**Step 1 of the bongle port landed; the rest waits on review.** `lib/src/render/draw-list.ts` is
`recordDrawList`, which is the whole port in one function: skip `!mesh.visible`, stable-sort by
`order`, every opaque draw before every transparent one. It exists first because
**`pass.draw` is unconditional** — gpucat says so in `frame.ts`, and lib's dbvt culling runs entirely
through `visible`, so a naive port silently draws everything lib means to hide.

Mutation-tested against exactly that: dropping the `visible` check, and dropping the
opaque/transparent split, each fail one test. The measurements behind the plan are in
`lib/PLAN-explicit-passes.md` — 12 `visible` sites, 16 `renderOrder`, 26 `frustumCulled = false` that
exist only to defeat a cull lib already did.

Verified: lib typecheck clean but for two pre-existing errors, 1232 lib unit tests passing (one
pre-existing voxel failure, untouched by this), biome clean on the touched files.

---

## Layer 6.141 — the unconditional draw, documented

`docs/README.template.md`, `lib/PLAN-explicit-passes.md`.

The bongle port turns on one fact — `pass.draw` does not read `visible` — and the README never said
it. It documented the `Scene` path, used `reflector.visible = false` in the cube-camera example, and
left a consumer recording their own draws to discover the difference by having things not disappear.

`The tree is a layer, and you can skip it` now states what `drawScene` does that a recorded draw does
not: skips `visible` subtrees, frustum culls unless `frustumCulled = false`, and orders opaque before
transparent. Then it says the sharp part plainly: a draw you record is unconditional, and hiding
something with `visible = false` will do nothing and report nothing.

All three claims checked against the code rather than written from memory: `walkObject` returns early
on `!obj.visible`, `isMeshVisible` consults `frustumCulled`, and the two comparators are
`painterSortStable` and `reversePainterSortStable`.

**The bongle plan is rewritten to the reviewed shape.** Visuals present state; one module assembles
the passes; order is statement order. No `renderOrder`, no per-system order numbers, no sort — the
sky draws first because its line is first. `drawVisible` is the only automatic rule and it is culling
rather than ordering, since the dbvt toggles `visible` per object and the assembler cannot enumerate
what survived.

Checked before promising the sort could go: all five transparent materials are `depthWrite: false` —
sky, stars, voxel translucent, and the two screen-space overlay batches — so none needs back-to-front
ordering between objects.

Verified: 604 tests across 89 files, docs build, doc guards pass.

---

## Layer 6.142 — the helper the plan did not need

`lib/PLAN-explicit-passes.md`; `lib/src/render/draw-list.ts` removed.

The plan's one automatic rule was a `drawVisible` that skipped `!mesh.visible`, justified by lib's
dbvt culling running through that flag. **Challenged, checked, and wrong.**
`visibility/visibility.ts` toggles `cull.visible` on its own `CullEntry` — a record with
`worldAabb`, `leaf`, `wasVisible` and `distSq` — and `mesh-visuals.ts` reads it while packing
instances: a culled object is simply never written into a batch. No gpucat `Mesh` is involved
anywhere in it.

That collapses the remaining eight `mesh.visible` writes into two groups, neither needing the engine
to read the flag. The overlay batches set `visible = false` and `drawRange.count = 0` on the same
line, and a zero-count draw is issued and draws nothing — neither backend special-cases it — so the
flag guards a draw that is already a visual no-op. The four environment meshes come from one master
toggle via `syncEnvVisibility`, which is one `if` in the assembler and a function that deletes.

So the assembler applies no automatic rules at all, and `pass.draw` being unconditional stops being a
hazard once nothing relies on the flag. `draw-list.ts` and its five tests are gone rather than
reshaped; they were built on the premise that did not hold.

**The lesson is the one this session keeps relearning**: a plan resting on "system X works through
mechanism Y" is worth ten minutes of reading Y. Two greps would have shown `cull` was not a `Mesh`
before a helper, a type and five tests were written around it.

Verified: 93 lib render tests passing after the removal.

---

## Layer 6.143 — the sort that was already buying nothing

`lib/PLAN-explicit-passes.md`.

Dropping the walk's front-to-back opaque sort sounds like giving up early-z rejection, so it was
worth checking what that sort actually reached.

`VoxelPass` is `'opaque' | 'transparent' | 'translucent'`: voxels arrive as **three meshes**, each
spanning every chunk in the room, with chunks as indirect draws inside them. Mesh visuals are
instanced batches of the same shape. So the walk was sorting three world-spanning meshes by view-Z,
which cannot order anything for overdraw — **the sort was already inert for the geometry that would
benefit from it.**

Front-to-back chunk ordering is a property of the indirect args, written by the cull compute in
`VoxelResources.cullDispatches`, which is where the per-chunk distances exist; `visibility.ts` even
records `cull.distSq` during the dbvt pass. That is a real optimisation and a GPU-side one, untouched
either way by this refactor.

The assembler orders meshes, and there are few enough that the right order is the one written in the
file. Recorded in the plan so the question is not reopened on the assumption that a sort was lost.

---

## Layer 6.144 — the plan's first step was already done, and its ordering was wrong

`lib/PLAN-explicit-passes.md`.

Two corrections from reading the code the plan describes, before executing it.

**Step 1 was self-contradictory.** It said to expose each system's meshes as state *and* delete the
19 `scene.add` in the same step, while calling the step inert because "the scenes still exist and
still draw". Removing the registrations before the assembler exists empties the scene and draws
nothing — the opposite of inert. The deletions belong in step 3, after the switch, which is also the
only ordering where a fallback exists while the risky step is verified.

**Then step 1 turned out to be already done.** `RoomVisuals` exists in both backends' `mount` —
`{ voxel, voxelMesh, model, domUi, sprite, text, extrudedSprite, shadow, particle, env }` — and every
mesh the assembler needs is reachable today: `visuals.voxel.meshes[pass]`, `resources.<system>.batch.mesh`
(plus `.outlineMesh` for model and voxel-mesh), `resources.sprite.batches[occlusion].mesh`,
`visuals.env.skyMesh` and siblings, and `visuals.domUi.canvasStates.values()` for the CanvasTrait
panels. The systems already present their state; the plan asked for something the code had.

The inventory is in the plan as a table, which is the actual de-risking for the switch: the one step
that can fail invisibly now has every mesh it must draw named and located, so a missing row is a
reviewable omission rather than a black frame.

It also settles a shape question: the assembler reads `visuals` **and** `resources`, because batches
are client-global and survive room swaps while visuals are per-room.

The remaining work is two steps, not three.

---

## Layer 6.145 — the scene is a scripting API

`lib/PLAN-explicit-passes.md`.

Resolving the last unexplained `renderOrder` value found what the plan had missed entirely. `999` is
a debug contact marker in `builtins/player-controller.ts`, which reaches the scene through
`ctx.client?.render.scene` — and `ClientContext.render: RenderScenes` is documented as "the gpucat
render scenes this client renders into". **It is the scripting API.**

So the 19 `scene.add` calls are the engine's own systems and are not everything in the scene. A game
script can add a mesh, and step 3's "delete `Scene` from lib" would have stopped drawing it, silently,
with every test green.

It also invalidates two things this plan had already concluded. The `visible` skip and the sort were
argued away on the grounds that no engine system needs them — true, and irrelevant, because script
content goes through the walk and gets both. Under the option that keeps the scene, they stay
*because scripts rely on them*, not because the engine does.

Recorded as a fork rather than decided: either the scene survives as the script extension point and
`recordWorld` ends by walking it, or scripts get an explicit surface too and it goes. `AGENTS.md`
permits the second — no users, no compatibility — but it changes what a game can do rather than how
the engine draws, which is a bigger question than this refactor.

**This is the third correction to a plan that looked finished**, after the inert-step ordering and
step 1 already being done. Each came from reading the code the plan described rather than the plan.

---

## Layer 6.146 — bongle's frame is four explicit passes

`lib/src/render/{pipeline,webgpu,webgl}.ts` and the visual modules; `targetColor` / `targetDepth`
added to gpucat.

The earlier attempts at this were scatty because they never questioned the shape: **two of the four
passes were implicit.** `scenePass` and `overlayPass` were `RenderTextureNode`s that scheduled
themselves when the composite sampled their textures. Everything awkward fell out of that — a
`placeholderScene` that was "never rendered", `contents` mutated from outside each frame,
`recordDispatches` threaded as a *parameter* so compute could reach the same frame, and a comment
admitting "the scene and overlay passes schedule themselves from inside it".

Now the whole frame is one readable run: cull, world, overlay, composite, submit. The two offscreen
passes render into plain `RenderTarget`s and the composite samples them. **The post chain is
unchanged** — fxaa, tint, overlay-over and tonemap were always nodes on the composite mesh, not
passes, and still are. Only where `sceneColor` comes from changed.

**gpucat had no clean way to sample a plain render target**, which is what removing `RenderTextureNode`
exposed: the only sanctioned path was `getTextureNode()` on the node being removed, and reaching
`rt.texture!._gpuTexture` in lib is the same smell as reaching `.backend`. `targetColor(target)` and
`targetDepth(target)` are that API, named for what they do.

**The engine's 13 `scene.add` had to go with the switch, not after it.** Left in, `drawScene` would
have drawn every engine mesh a second time on top of its explicit draw. `VoxelVisuals.initRoomMeshes`
and `dispose` no longer take a `Scene` at all.

**Two things the plan called dead are not.** The 26 `frustumCulled = false` and `syncEnvVisibility`
stay: the offline icon renders build their own `Scene` from the same engine batch meshes and still go
through `drawScene`, so both are load-bearing there. Only the 7 `renderOrder` values were genuinely
dead, since nothing sorts any more — order is the order of the lines.

What stays in `pipeline.ts` is what is identical between backends: the post chain and the two
targets, 106 lines with no backend branch in it. The frame is inlined in each backend because the two
genuinely differ — WebGPU records a compute cull, WebGL culls on the CPU with no dispatch.

Verified: lib tsc clean but for two pre-existing editor errors, 1227 lib tests passing (one
pre-existing voxel failure), biome clean on the touched files.

---

## Layer 6.147 — `pass.scene()`

`src/renderer/core/frame.ts`, `tst/pass-scene.test.ts`, `docs/README.template.md`, and both lib
backends.

The walk is now a verb on the pass, beside `draw` and `execute`, which is what this API's own rule
already asked for: **the recording context keeps verbs; free functions are for operations that narrow
the renderer type.** `drawScene` narrows nothing — it is backend-neutral — so it had no business
being the only way in.

```ts
pass.scene(room.render.scene);
// was: drawScene(state.renderer, pass, room.render.scene, camera);
```

The camera defaults to the pass's own, so the common call takes a tree alone. `drawScene` stays as
the free form for a caller holding no pass.

**Kept small on purpose.** The first sketch threaded a renderer through `createFrame` into every
`Pass`, which meant changing a signature four tests use with fake backends. Instead `frame(renderer)`
records the renderer it already has on the frame it already owns — one line — and `createRenderPass`
already closes over the frame. A frame built straight from `createFrame` has no renderer and
`scene()` says so by name rather than throwing on a null read.

Verified: src tsc 0, 607 tests across 90 files, 55/55 WebGPU pixels, WebGL pixels pass, docs build,
lib tsc clean and its two backends converted.

---

## Layer 6.148 — one place knows the world draw order

`lib/src/render/{webgpu,webgl}.ts`.

The live frame listed its draws and `prewarm` listed them again for `compile`. Those two lists drift,
and had: when the visuals stopped mounting themselves into a scene, prewarm's copy silently lost the
voxel and environment meshes, so their pipelines were no longer warmed and the first frame would
hitch on them.

`drawWorld(into, voxel, env, res, environmentEnabled)` is the one place that knows, and `into` is
anything with a `draw` method. That keeps the sequence literal — no loop over an array, no order
numbers — while letting more than one caller record it.

**The prewarm collects rather than lists**, which is the part that removes the drift:

```ts
const drawables: Mesh[] = [];
drawWorld({ draw: (mesh) => drawables.push(mesh) }, voxel, env, res, true);
await state.renderer.compile(drawables, state.pipeline.sceneTarget, state.pipeline.camera);
```

**The first attempt used `bundle()` for this and was wrong.** A bundle is a replayable GPU recording;
building one only to read its records back and throw it away is using a feature for its side effect,
and it makes `prewarm` unreadable to anyone who does not already know what bundles are. A closure
pushing to an array says the same thing with nothing to learn.

`drawWorld` is duplicated between the two backends rather than shared, deliberately: the frames around
it genuinely differ — WebGPU records a compute cull, WebGL culls on the CPU — and a shared module
was tried and rejected earlier for putting the high-signal order one indirection away from the frame
that reads it.

The icon path keeps `pass.scene()`: its scene holds the objects being iconified, not the world.

Verified: lib tsc clean, 1227 lib tests passing (one pre-existing voxel failure), biome clean.

---

## Layer 6.149 — comment goblin over the port

`lib/src/render/{webgpu,webgl}.ts`, `lib/PLAN-explicit-passes.md`.

Four comments written during the port, three of them wrong by the time the port finished.

**One named a thing that no longer exists.** `DrawsInto`'s doc still said "a pass, or a bundle prewarm
reads back" after the bundle was replaced by a closure — a comment describing an approach that had
been abandoned two layers earlier.

**One had drifted away from what it described.** "The order these lines are in is the order they draw
in" sat above the world pass, but the draws had moved into `drawWorld`; the lines under it were a
pass, a call and an `end`. It says the same thing on `drawWorld` now, where the lines actually are.

**One restated its neighbour.** The prewarm's "collected from the same sequence, so the two cannot
disagree" repeats what `drawWorld`'s own line says. Deleted rather than reworded.

**One was a block where a line does.** `drawWorld`'s four-line header is now a single line carrying
the only fact that is not visible in the body: no `renderOrder`, no sort.

The one kept as written is "gpucat never updates matrices for you; anything posed since the last
render is stale until this" — non-obvious, unguessable from the call, and one line.

The plan now shows the code that exists rather than the code that was proposed.

Verified: lib tsc clean, 1227 tests passing, biome clean on the touched files.

---

## Layer 6.150 — the adapters came off

`lib/src/render/{webgpu,webgl}.ts`, `lib/src/render/voxels/voxel-visuals.ts`.

`drawWorld` had grown `Pick<Pass, 'draw'>`, `Pick<VoxelVisuals, 'meshes'>` and a caller building
`{ meshes: ... }` to satisfy the second one. Every one of those was an adapter for a single fact: one
function was serving two callers that want different things. **The dual use was the problem, not the
types.**

`drawWorld(pass: Pass, visuals: RoomVisuals, res, environmentEnabled)` now — concrete types, nothing
partial. The prewarm writes its own list of the same meshes, which is duplication accepted
deliberately over an abstraction that made both callers worse.

**Also removed: dispose calls that freed nothing.** `VoxelVisuals.dispose` had been rewritten to call
`geometry.dispose()` on `res.voxel.geometries` — **engine-global geometry shared by every room**, so a
room swap would have destroyed what the next room needed. `disposeEnvVisuals` was
`removeFromParent()` on meshes that no longer have a parent. Both gone, along with the `try/finally`
in prewarm that existed only to call them.

`createPassMeshes` splits the three voxel meshes out of `initRoomMeshes`, so the prewarm stops
allocating a room's dirty-chunk maps and starvation counters to get at them.

**An adversarial review of the compile API produced one correction.** The claim that prewarm works
because compiled node state is shared by cache key is **wrong**: `compileNodeState` has no lookup and
recompiles for every RenderObject. The saving is one level lower — `state.renderPipelines` is keyed
on `(material.version, geometry.version, sampleCount, formats)` and `createShaderModule` only runs on
a miss. So prewarm buys device-side shader and pipeline creation and re-pays CPU codegen, which is
still the right trade but not the mechanism claimed.

What a pipeline is actually keyed on is `(material, geometry, renderContext)`. `compile` taking a
`Mesh` is the API asking for more than it uses; the honest fix is to accept the pair and wrap it
internally, preserving the upload warm. Left as a proposal rather than built, because the two
complaints that motivated it — a room-lifecycle function misused, and dispose theatre — are fixed.

Verified: lib tsc clean, 1227 tests passing, biome clean on the touched files.

---

## Layer 6.151 — the icon path, fixed twice and then guarded

`lib/src/render/{webgpu,webgl}.ts`, `lib/tst/unit/render/offline-resources.test.ts`,
`src/renderer/core/{renderer,compile,read}.ts`, `*Opts` renamed throughout.

**The icon atlas came back transparent and the first fix could not have worked.** Removing the
engine's `scene.add` calls emptied the scene `composeSceneToTarget` walked, so the diagnosis was
right; the repair was not. It called `drawWorld(pass, ..., state.resources, ...)`, and the icons are
built in a **pipeline worker** whose backend never fills its `resources` slot. `res.model.batch.mesh`
threw mid-render, and a thrown icon render is indistinguishable from an empty one: a transparent
atlas and nothing said.

**It was also wrong in principle.** `RenderRoomDeps` carries `voxelResources`, `voxelMeshResources`,
`modelResources` and `cloudResources` — **no sprite, shadow, particle or extruded-sprite**. An
offline room cannot draw the world, so the world's draw order does not apply to it. The icon path
draws what an offline room holds, from `deps` rather than `state`.

`tst/unit/render/offline-resources.test.ts` is the guard the two attempts earned: `composeSceneToTarget`
may reach no `state.resources`, and `RenderRoomDeps` is asserted to carry exactly the four it does.
Reintroducing the `state.resources.model.batch.mesh` read fails it.

**`_compile` and `_readPixels` are gone rather than hidden.** Making them private left two methods
whose bodies were reachable from a `renderer` parameter — pure indirection behind the free functions.
The bodies moved into `compile` and `read`, and `renderer.ts` lost four imports with them.
`CompilableRenderer` and `ReadableRenderer` went too: once the methods were private, those structural
types described which privates a free function reaches for, which is the `SceneGpu` shape this plan
removed in 6.117.

**`*Opts` is `*Options`.** `DrawOptions`, `ReadOptions`, `DispatchOptions`, `DispatchIndirectOptions`,
`GlslOptions`, across src, tests, examples, docs and the plans.

Verified: src tsc 0, tst tsc 0, examples tsc 0, 607 tests across 90 files, 55/55 WebGPU pixels, WebGL
pixels pass, docs build; lib tsc clean, 1230 tests passing (one pre-existing voxel failure), dist
rebuilt both sides.

---

## Layer 6.152 — comment goblin, and the lesson into the plan

`lib/src/render/{webgpu,webgl}.ts`, `lib/tst/unit/render/offline-resources.test.ts`,
`lib/PLAN-explicit-passes.md`.

Two blocks from the icon fix cut to lines. The guard's four-line header said in prose what its two
test names already say; what survives is the one fact neither name carries — that a thrown icon
render and an empty one are indistinguishable, which is why the guard is structural rather than a
pixel check.

The plan gained the section the two wrong fixes earned: **the offline renderer is a different world.**
Its deps carry four resources, the live path's backend carries all of them, and reusing the world's
draw order across that line is what broke icons twice. Written down because the reuse looks right
every time you read it.

Verified: gpucat src tsc 0, 607 tests, 55/55 WebGPU pixels, WebGL pixels pass; lib tsc clean, 1229
tests passing with the two known failures (a pre-existing voxel case and the flaky multiplayer
handshake, which passes on re-run).
