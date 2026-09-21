# Render bundles

Status: designed, not built. Requested after the explicit-frame work landed, on the observation that
the frame API already records draws, so a bundle is "a recorded list you keep".

## Why it is close

`DrawRecord` is `{ mesh, material, opts }` — neutral, no device handle, already the thing a pass
replays at `end()`. A `Pass` records draws and encodes them in one go, so the recording half exists.

The attachment signature a WebGPU bundle must be created against is also already computed: a pass
context is keyed by `buildCacheKey(target, mrt)` = `${buildAttachmentState(target)}-${buildMrtState(mrt)}`,
which hashes colour count, formats, sample count, depth and stencil. That is exactly
`createRenderBundleEncoder`'s `{ colorFormats, depthStencilFormat, sampleCount }`, so a bundle can be
validated against the pass that executes it by comparing keys, and fail with the key it wanted against
the key it got.

## Shape

```ts
const terrain = bundle(renderer, { target: world, camera })   // outlives frames
terrain.draw(chunkA)
terrain.draw(chunkB)
const chunks = terrain.finish()                               // -> RenderBundle

const f = frame(renderer)
const pass = f.pass({ target: world, camera })
pass.execute(chunks)
pass.draw(player)                                             // interleaves, order preserved
pass.end()
```

`bundle( renderer, desc )` is a free function taking the renderer, like `frame`, because a bundle is
device-level and outlives any frame. `finish()` rather than `end()`, because `pass.end()` closes a
scope that already did its work while this closes *and hands back an artifact* — WebGPU draws the same
distinction with `commandEncoder.finish()`. `pass.execute(b)` rather than `pass.draw(b)`, because
`executeBundles` is WebGPU's own verb and overloading `draw` to take `Mesh | RenderBundle` breaks the
plan's "one call signature per function, no overloads" rule, the same rule that rejected `Mesh | Material`.

## The one structural decision

**A bundle must be an entry in the pass's record list, not a copy of its draws into it.**

Copying is a two-line change and is wrong: on WebGPU the whole point is to call `executeBundles` once
instead of re-encoding N draws, and a pass that has already flattened a bundle into its own records
cannot tell which of them came from where. Order with interleaved direct draws also has to survive.

So `Pass.records` stops being `DrawRecord[]` and becomes a list of entries:

```ts
type PassEntry =
    | { kind: 'draw'; mesh: Mesh; material: Material; opts: DrawOpts | null }
    | { kind: 'bundle'; bundle: RenderBundle };
```

That is the cost of the feature, and it is larger than one type: `DrawRecord` is public, both
backends' encode loops walk it, and the pooling invariant that 6.87 pins — a shorter frame reuses the
longer one's slots by mutating records in place — has to keep holding across a union.

**And the union has to survive two stages, not one.** The pipeline is
`records -> prepareRecordedDraws -> PreparedRenderObject[] -> encodeDraws`, and that middle step
*flattens*: it walks records and appends prepared objects. A bundle expanded there is a bundle
flattened, which is the thing this design exists to avoid, one stage later than expected.

**The answer is that a bundle owns its own prepared state**, which is also what makes it worth having:
prepare once, replay many. On `execute`, a bundle is prepared if it has not been prepared for that
pass context, and the result is cached on the bundle keyed by the context's cache key. So
`prepareRecordedDraws` skips bundle entries, the pass's prepared array holds only direct draws, and
`encodeDraws` walks the *records* to decide per entry whether to emit a draw or replay a bundle.

This is the part to build first and carefully, because everything else depends on it and the pooling
tests are the net.

## Lowering

**Proven on both backends since 6.123.** `bundle-replay` exists in the WebGL harness as well as the
WebGPU one, so "runs correctly on both, only WebGPU gets faster" is a measurement rather than an
argument from the lowering's shape.

**WebGPU.** At `finish()`, nothing device-side happens; the records are kept. The `GPURenderBundle` is
built lazily on first `execute` against a given pass context, because only then is the attachment
signature known, and cached on the bundle keyed by that context's cache key. `encodeDraws` needs to
accept a `GPURenderBundleEncoder` in place of a `GPURenderPassEncoder`: both implement the same draw
and bind methods, so the encode loop is shared and only the scope differs.

**WebGL2.** There are no bundles. `execute` replays the records through the same path a direct draw
takes, which is what the existing loop already does. Honest framing for the docs: on WebGL this costs
nothing and buys nothing, rather than implying a speedup.

**So the segment machinery is WebGPU-only, and WebGL needs no part of it** (found in 6.113).
Prepare-time expansion already hands WebGL the flat list in the right order, which *is* the replay, so
`webgl/render-pass.ts` is untouched by this feature. That is an earned API difference of exactly the
kind `PLAN-backend-symmetry.md` rule 4 allows — WebGPU has render bundles and WebGL2 does not — not a
decomposition drift. It also matters practically: WebGL's draw loop carries per-pass GL state set up
before it (`establishPassBaseline`, the state cache, the current program and VAO), so slicing it into
ranges would mean threading that state through for no gain.

## What a bundle cannot contain

A `GPURenderBundleEncoder` rejects `setViewport`, `setScissorRect`, `setBlendConstant` and
`setStencilReference`. Three of those cost nothing here: viewport and scissor are pass state already
(`PassDesc.viewport`, `PassDesc.scissor`, set on the pass before `executeBundles`), and gpucat never
calls `setBlendConstant` at all — `webgl/state.ts` already refuses a material that would want one.

**The fourth is not a desc field and cannot be excluded by omitting one**, which this design assumed
it could. A stencil reference comes from `material.stencilRef` on a pass with a stencil attachment,
so it is reachable from any mesh a bundle records. It throws by name at record time instead.

## How three.js orchestrates this

Read rather than assumed, in `~/Development/three.js`. Three things transfer and one corrects the
design above.

**The device artifact is cached per (bundle, camera, render context).** `RenderBundles.get` is a
`ChainMap` keyed on exactly those three (`common/RenderBundles.js`). **This design said "keyed by the
context's cache key" and omitted the camera**, which is wrong: view matrices are baked into the
bindings a bundle records, so a bundle replayed under a different camera replays the wrong view. The
key is the pair.

**The encode loop is shared between a pass encoder and a bundle encoder.** three types the parameter
as `GPURenderPassEncoder|GPURenderBundleEncoder` and branches only where it must
(`WebGPUBackend.js`, the `isBundleEncoder` check). That is the same conclusion this design reached for
`encodeDraws`, and it is load-bearing: two encode paths would drift, which is the failure
`PLAN-backend-symmetry.md` exists to prevent.

**Replay is `executeBundles([bundle])` inside an otherwise ordinary pass**, with viewport and scissor
set on the *pass* immediately before it — confirming that those stay on `PassDesc` and out of the
bundle, as above.

**`BundleGroup.static` is the contract, spelled as a property.** three states it as "the structure is
assumed to be static and does not change", and documents that a WebGL backend "can technically be
rendered but without any performance improvements" — the same honest framing this design wants for
its WebGL lowering.

## Correction (6.121): replay skips the per-draw update

This design assumed a bundle only freezes *structure*, and that values flow because the recorded bind
groups point at buffers the frame keeps writing. Half true, and the wrong half was shipped in 6.115.

`prepareRenderObject` runs `initRenderObject` only. The `updateRenderObject` that uploads uniforms and
rebuilds bind groups runs at **encode** time in `encodeDrawRange`, which a replayed bundle does not
run. So replay skips it, and two things follow: a bind group rebuilt after recording (a resized
sampled render target is the ordinary case) is never picked up, and per-object uniform writes do not
fully land — 4 buffer writes on the direct path against 2 on the bundled one.

**Fixed in 6.122**, and three.js settles the shape: `_renderBundle`'s replay branch walks the
recorded render objects and runs `updateForRender` on nodes, geometries and bindings before
`addBundle`. gpucat now does the same through a `refreshDraw` extracted from `encodeDrawRange`, so
record and replay share one update path.

It runs **before** the cache check, not after, which three's structure does not force but gpucat's
does: `bindGroupRebuilds` is what the check compares, and the refresh is what moves it. Checking
first replays a bundle holding a destroyed texture for one frame.

## Invalidation: throw it away and make a new one

**`dispose()` is a lifecycle end, not just a clear** (6.127). It marks the bundle disposed and
`execute` refuses it by name. Clearing the records alone made a disposed bundle draw nothing in
silence, which is the one failure mode this API otherwise never leaves quiet.

A bundle holds `mesh` and `material` by reference and will redraw whatever they have become. That is
fine for the static set bundles exist for, and wrong the moment a mesh's geometry is swapped — which
is exactly what 6.104 found lib doing for the brush. A recorded `GPURenderBundle` has baked those
decisions in and cannot notice.

**The answer is discard-and-rebuild, not a validity check**, and three arrives at the same place with
less machinery than expected:

```js
_bundleNeedsUpdate( bundleGroup, renderBundleData ) {
    return renderBundleData.bundleGPU === undefined || bundleGroup.version !== renderBundleData.version;
}
```

A version on the bundle, a copy of that version stored beside the device artifact, and a re-record
when they differ. `needsUpdate = true` bumps the version; nothing walks the contents to find out
whether anything changed, because that walk is the cost the bundle exists to avoid.

For gpucat that is:

- `RenderBundle.version`, bumped by an explicit `invalidate()` rather than a `needsUpdate` setter,
  since this codebase prefers verbs to flag properties.
- The cached `GPURenderBundle` stored per (camera, render context) with the version it was recorded
  at, and re-recorded when the versions differ.
- `dispose()` drops every cached artifact and the records, so a bundle whose meshes are gone releases
  them; the strong references a bundle holds are the reason it needs one at all.

What this does **not** do is notice a mesh mutating under it. That is the stated contract, and the
place it will bite is precisely lib's overlay meshes, which swap geometry every frame — so those are
exactly the meshes that must not go in a bundle.

## Order of work

1. ~~`PassEntry` union, pooling preserved, both backends walking it, and `encodeDraws` driven by the
   records rather than by a flat prepared array.~~ **Done in 6.110-6.111, and the second half was
   wrong.** Expanding a bundle at *prepare* time, not encode, is correct for replay and needs no
   change to the draw loop at all: `prepareRecordedDraws` recurses into a bundle's entries and the
   backends never learn bundles exist. Driving `encodeDraws` from the records is only required by
   step 3, where `executeBundles` needs the entry kept whole — so it belongs there, with a reason,
   rather than here as a restructure with none.
2. ~~`bundle()` / `finish()` / `pass.execute()`, lowered as replay on both backends.~~ **Done in
   6.111.** `bundle( label? )` takes no target, because the attachment shape it must match is the
   executing pass's; validating that is step 3's job, when a device bundle is actually built.
3. ~~WebGPU `GPURenderBundle` built per pass context, with the key mismatch as a loud error.~~
   **Done in 6.115, and the second half was wrong.** There is no key mismatch to report: a bundle
   carries no target, so it is recorded from the attachment signature of the pass executing it and
   cannot disagree with it. One bundle under two pass shapes simply records twice, keyed apart by
   pass-context id. The real refusal is narrower and is by name: a mesh that needs a stencil
   reference cannot go in a bundle, because the encoder has no `setStencilReference`.

   `RenderContext.camera` is `View | null`, so the camera level of the key needs a sentinel for
   camera-less passes rather than a non-null assertion.
4. ~~`invalidate()` and `dispose()`, the contract in the docs, and a pixel case that draws a bundle
   beside an equivalent set of direct draws and compares them.~~ **Built before step 3, on purpose**
   (6.111-6.112): `invalidate` and `dispose` landed with the type, and `bundle-replay` in the WebGPU
   harness is the net step 3 needs, so it exists before the change it guards. Two overlapping
   fullscreen draws make order observable; reversing the replay turns the read green to red.

   ~~Left for step 3: the docs paragraph, which should wait until there is an acceleration to
   describe and a WebGL "costs nothing, buys nothing" to state honestly beside it.~~ **Done in
   6.116**, under `Drawing Many Things` rather than in the frame section: instancing and indirect are
   already there as "many copies of one thing", and a bundle is the other axis.
