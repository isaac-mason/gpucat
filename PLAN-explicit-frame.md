# Explicit frame plan

Status: through layer 6.95, tracked in `WORKLOG-explicit-frame.md`. One change, not a sequence.
Uncommitted on purpose; delete it when the work lands.

**The API is done and the two open items below both need a decision from Isaac, not more design.**
Everything since roughly 6.66 has been consequences and verification rather than the change itself.

The frame API itself is built and proven on both backends. What the worklog has been doing since is
the consequences: layers 6.27-6.32 replaced the two concrete renderers with one `Renderer` over a
`DeviceBackend` (`PLAN-renderer-backend.md`), and 6.23-6.43 grew the real-device WebGPU harness from
26 cases to 53 by porting from the WebGL one, which found seven bugs — the last two being a
`CubeCamera` that allocated no mip chain on either backend, and the allocation check beside it that
reallocated a cube target under the frame encoding into it. The decisions still open are all
listed under **Open** below.

## The problem

The renderer owns the frame, and the target is ambient state. Everything else follows from that.

`Renderer` carries three mutable fields that are really a calling convention:

```ts
renderTarget: RenderTarget | null
mrt: MRTNode | null
clearColor: [number, number, number, number]
```

`PassNode.updateBefore` drives the renderer by saving them, setting them, calling
`renderer.render(scene, camera, passId)`, and restoring them. That nested `render()` is a second
top-level call, which is why `_renderCallDepth` and `beginRender`/`endRender` exist to keep renderIds
from colliding. `saveRendererState()` and `restoreRendererState()` are public API that exist for the
same reason.

The consumer pays for this. In makecat.io's `lib`:

- `setActiveScene` casts away `readonly` every frame to swap the room:
  `(pipeline.passNode as { scene: Scene }).scene = scene`.
- `rebuildRenderPipelineIfStale` rebuilds the whole driver because the driver owns the graph.
- 26 sites set `frustumCulled = false`. In `src/render` not one mesh leaves it on. The render list's
  frustum culler runs for zero meshes; culling is upstream in `visibility/dbvt.ts`.
- Draw order is a hand-maintained global integer scale spread over ten files:
  `-1000`, `-999`, `-998`, `1`, `999`, `SPRITE_ON_TOP_RENDER_ORDER`, `Infinity`.
- Two per-submission facts live on shared long-lived objects: `mesh.visible`, which means "skip this",
  and `geometry.drawRange` on client-global batches that several rooms share. Not `mesh.draws` or
  `mesh.count`, which describe what the mesh is rather than how one submission of it differs.
  `DrawOptions` (`instances`, `range`, `draws`, `material`) is the replacement, and it overrides the
  mesh and geometry per submission rather than shadowing them.

## Resources stay declarative

**Resources are constructed with no device and wired up on first use. Only operations take the gpu.**

This is the three.js paradigm and it is the thing not to lose. A Mesh, a Material, a RenderTarget can
be built at module scope before anything is initialized, and the backend materializes device objects
lazily, keyed by the neutral object. The alternative, threading a device through every constructor,
is a PlayCanvas-shaped API and is explicitly not wanted.

| declarative, no gpu | operations, take gpu |
| --- | --- |
| `Material`, `Geometry`, `Mesh` | `init( { backend } )` |
| `RenderTarget`, `CanvasTarget` | `frame( gpu )` |
| `Texture`, `GpuBuffer`, `GpuSampler` | `compile( gpu, drawables, target )`, `read( gpu, target )` |
| cameras, `pingPong` | |

The backends hold to it internally too, as of layer 6.94: every device resource cache they own is
built at construction, and the only fields deferred to `init` are the ones that arrive with the
renderer or the device. `tst/deferred-fields.test.ts` keeps it that way, after the count of `= null!`
fields reached 24 without anyone noticing.

This is already how gpucat works and it constrains several decisions below. `CanvasTarget` is already
documented as "Backend-agnostic ... The graphics context is acquired and owned by the backend, not by
this class", with the backend holding a `WeakMap<CanvasTarget, GPUCanvasContext>`. `RenderTarget`
needs no device either. Disposal already runs the inverse way: the renderer attaches `_onDispose` to
the neutral object and keys its caches weakly.

So `gpu.dispose()` tears down the device and its caches. It does not own resources, and there is no
`surface(gpu, canvas)` or `target(gpu, opts)`. Those were drafted from vgpu and would have broken
this for no gain. What did land is the gpu-free half of that idea: `canvasTarget( canvas, opts )`,
`renderTarget( w, h, opts )` and `cubeRenderTarget( size, opts )`, one-line factories beside their
classes, so a target is constructed the way every node is. **Done.**

## The shape

One entry point. The target is an argument. The frame is flat.

```ts
const renderer = await init( webgpu() )
const view = canvasTarget( canvas, { dpr: [ 1, 2 ] } )
const world = renderTarget( w, h, { colorFormat: 'rgba16float', depthFormat: 'depth24plus' } )

const f = frame(renderer)

const cullPass = f.compute( { label: 'voxel-cull' } )
cullPass.dispatch( cullNode, [ x, y, z ], { buffers: { srcKeys, dstKeys } } )
cullPass.end()

const scenePass = f.pass( { target: world, camera, clear: [ 0.02, 0.02, 0.04, 1 ] } )
scenePass.draw( voxels )
scenePass.draw( meshes )
scenePass.end()

const compositePass = f.pass( { target: view } )
compositePass.draw( composite )
compositePass.end()

f.submit()
```

~~`compile`, `compileCompute` and `read` take a structural minimum (`CompilableRenderer`,
`ReadableRenderer`) rather than `Renderer`.~~ **Both deleted, 6.151.** They named methods that are
now `_compile` and `_readPixels`, so the minimum they described had become a list of which privates a
free function reaches for — the `SceneGpu` shape this plan already removed once. All three take
`Renderer`. `Drawable` was drafted as an alias for `Mesh` and never created: an alias with exactly
one member is a second name for the same thing.

**The methods went private so there is one spelling.** `renderer.compile` and `renderer.readPixels`
were public beside the free functions that wrapped them, which is two ways to do one thing on the
surface this plan exists to make consistent.

**The public API is methods; the code behind it is State plus standalone functions.** Those are
different questions and conflating them cost a detour: the house style note was about orchestration
and backend state, and it got applied to the front-facing surface as well, which turned `f.pass(...)`
into `beginPass(f, ...)` for several cycles. `Frame`, `Pass` and `ComputePass` are context handles
with verbs on them, which is what `f.pass()` returning something you then `.draw()` into is for. The
pools, the records and the backend vtable stay plain state operated on by module functions.

```ts
init<B extends DeviceBackend>( backend: B ): Promise<Renderer<B>>
frame( renderer: Renderer ): Frame
compile( renderer: Renderer, drawables: Mesh | Mesh[], target: Target, camera: View ): Promise<void>
compileCompute( renderer: Renderer, nodes: ComputeNode | ComputeNode[] ): Promise<void>
read( renderer: Renderer, target: RenderTarget, opts?: ReadOptions ): Promise<Uint8Array>

f.pass( desc: PassDesc ): Pass
f.compute( desc?: ComputePassDesc ): ComputePass                                  // webgpu only
f.transformFeedback( desc?: TransformFeedbackPassDesc ): TransformFeedbackPass    // webgl2 only
f.submit(): void
f.abandon(): void

p.draw( mesh: Mesh, opts?: DrawOptions ): void
p.end(): void

c.dispatch( node: ComputeNode, counts: [ number, number, number ], opts?: DispatchOptions ): void
c.dispatchIndirect( node: ComputeNode, indirect: GpuBuffer<d.Any>, opts?: DispatchIndirectOptions ): void
t.dispatch( node: TransformFeedbackNode, opts: TransformFeedbackDispatch ): void
readBuffer( renderer: Renderer<WebGLBackend>, buffer: GpuBuffer ): Promise<Float32Array | Int32Array | Uint32Array>
c.end(): void

type DispatchOptions         = { buffers?: Record<string, GpuBuffer<d.Any>> }   // named storage rebind, see below
type DispatchIndirectOptions = DispatchOptions & { offset?: number }

type PassDesc = {
    target: Target                   // a bundle: colors + depth + stencil + samples
    camera?: View
    clear?: [ number, number, number, number ] | false   // omitted clears with the target's own colour
    clearDepth?: number | false    // 0 with a 'greater' compare is reversed-Z
    clearStencil?: number | false
    layer?: number                   // cube face; a non-cube target throws (6.7)
    mipLevel?: number                // cube level; a non-cube target throws (6.7)
    mrt?: MRTNode
    viewport?: Rect & { minDepth?: number; maxDepth?: number }
    scissor?: Rect
    label?: string
}

type Rect = { x?: number; y?: number; width: number; height: number }

type Target = RenderTarget | CanvasTarget
type DrawOptions = {
    instances?: number
    range?: { start: number; count: number }
    draws?: MeshDraw[]      // CPU multi-draw, overriding mesh.draws for this submission
}
```

`mesh.draws` stays on `Mesh` and is load-bearing. It is a list of `IndexedMeshDraw` /
`NonIndexedMeshDraw` mirroring `GPUDrawIndexedIndirect` / `GPUDrawIndirect`, and when set the encode
loop iterates it instead of the single `drawRange` plus `count` draw (`Mesh.draws` in
`objects/mesh.ts`, `encodeDraws` in `webgpu/render-pass.ts`). lib drives its whole batched voxel and
mesh path through it:
`mesh.draws = draws` shared by identity between a mesh and its outline in lib's `mesh-resources.ts`,
rewritten by CPU frustum and cone culling each frame. `DrawOptions.draws` exists to override it per
submission, not to replace it.

**A target is a bundle, not one texture.** Colour count, depth, stencil, sample count and store
behaviour are declared when the target is constructed; the pass names the target and adds only what
varies per pass. A depth-only shadow pass is a `RenderTarget` with no colour format, so it needs no
special case in `PassDesc`. Cube face and array layer are bind-time arguments, the way three does it
with `setRenderTarget( rt, activeCubeFace, activeMipmapLevel )`.

An earlier draft had `color?: Attachment | Attachment[]` with per-attachment `load` / `store` /
`clear` / `resolve`, taken from NoGraphicsAPI. That was the wrong altitude: NoGraphicsAPI is a thin
Vulkan wrapper where attachments genuinely are the unit, while gpucat already abstracts a target as
a set. `resolveRenderTargetAttachments` returns colour and depth from one `RenderTarget` today, and
`CanvasTarget` is inherently a bundle (swapchain colour plus depth), which is exactly where the
attachment form broke: `{ color: view }` had nowhere to put depth.

three puts all of it on the resource, and gpucat is already shaped that way:

```js
// three.js src/core/RenderTarget.js
count: 1,                          // number of colour attachments
depthBuffer: true, stencilBuffer: false, depthTexture: null, samples: 0,
resolveColorBuffer / resolveDepthBuffer / resolveStencilBuffer,
storeMultisampledColorBuffer / ...Depth... / ...Stencil...   // storeOp: 'discard', per aspect
```

What the bundle form genuinely gives up is a `load` that differs between two colours of one MRT, and
attaching colour from one target with depth from another. three cannot do either, and nothing in lib
or the 46 examples wants them. If one appears it can be an escape hatch without disturbing the common
form.

`View` is a plain shape: projection, view, world, near, far, **and `coordinateSystem`**. That last one
is not optional, because WebGPU's NDC depth range is `[0,1]` and WebGL's is `[-1,1]`. **Landed as
`alignCameraToBackend` in `core/pass-desc.ts`**, called once per pass from each backend's
`encodePass` rather than from a `render()` on either renderer, which is where the two copies used to
be. `core/render-list.ts` reads it for frustum extraction and so does `Camera.unproject`. A
`View` without it silently moves the depth-range convention onto the caller, so the plan has to say
who builds the projection for which backend.

`PerspectiveCamera` satisfies `View`. Core should not depend on `Object3D`, which `Camera` currently
extends, but note `cameraPosition` calls `frame.camera!.getWorldPosition(...)`, an `Object3D` method
(`cameraPosition` in `nodes/lib/camera.ts`, `Object3D.getWorldPosition`). That node has to read
`world[12..14]` instead.

What a pass can draw is `Mesh` and nothing else. An earlier draft had `Mesh | Material`, where a bare Material
meant "fullscreen, no geometry". The mesh slot is load-bearing all the way down (`RenderObject.mesh`
is non-null, the cache is `WeakMap<Mesh, WeakMap<Material, ...>>`, `modelWorldMatrix` does
`frame.object!.matrixWorld`, the draw loop does `item.mesh!`), so drawing a bare Material would fill
that slot with a hidden dummy. The dummy already exists as `QuadMesh`/`__quadMesh__`, so that route
hides a class rather than deleting one. `fullscreen(node)` returns a real `Mesh` instead, and
`QuadMesh` is deleted.

**`mesh.visible` gates the scene walk, not a recorded draw.** `walkObject` in `core/render-list.ts`
is the only reader of it in the whole renderer, so `p.draw(mesh)` draws whatever you hand it: the
recording *is* the decision `visible` would otherwise make. Deliberate, and stated on `Pass.draw`
since 6.108 because it is otherwise a silent surprise for a consumer using `visible` as a skip, which
is what lib does today.

Matrix management is DIY by design. `p.draw(mesh)` reads `mesh.matrixWorld` and never updates it. A
lazy recompose on draw was considered and rejected: it would be the library doing magic behind a
contract that deliberately does not.

## Pass identity comes first

This is the thing to settle before anything else, because every cache, the inspector, the pre-warm
keying and lib's whole WebGPU frame key off it, and the rest of this plan currently leaves it
undefined.

`RenderObjectsState.passCaches` **was** a `Map<string, RenderObjectCache>` keyed by `passId`, and
`PassNode` minted a stable one at construction (`_passCount` in `render-texture-node.ts`). `f.pass(desc)` runs
every frame and carries only an optional `label`. If identity is per call, every frame allocates
fresh RenderObjects and recompiles every material. If identity derives from the target, `passCaches`
is redundant. It was: the keying below landed and `passCaches` no longer exists.

**Identity is the attachment shape, not the target object.** A `WeakMap<Target, RenderContext>` was
proposed and is wrong. `buildCacheKey` hashes `{count}:{formats}:{samples}:{depth}:{stencil}` plus the
MRT id plus `callDepth` (`buildCacheKey` in `core/pass-context.ts`), so two different `RenderTarget` objects with
identical configuration deliberately share one context, and therefore share pipelines and
RenderObjects. Keying by object identity would split all of that per target for no gain, which for
lib's per-room targets is a real regression.

So: **keep shape keying, drop `callDepth`, and drop `passId` from the RenderObject cache key.**
`RenderObjectsState.cache` is one `mesh -> material -> renderContext` chain now, and `passId` survives
only as an inspector label built from `PassDesc.label`. Its file header still described the deleted
per-pass structure until 6.80, two screens above the field that says the opposite.
`callDepth` exists only because a nested render into a same-shaped target would otherwise collide with
its parent, and nesting goes away with the explicit frame.

### A latent bug this uncovered

`context.renderTarget` is assigned **once, at creation**, so a context shared by several same-shaped
targets points at whichever one created it. Two of its three readers are safe:
`getRenderContextColorFormats` and `getRenderContextDepthFormat` read formats the cache key already
guarantees are identical, and actual attachment resolution uses `params.renderTarget`.

The third is not. `node-manager.ts` resolves MRT output names to attachment indices:

```ts
const renderTarget = renderObject.renderContext.renderTarget;
if ( renderTarget !== null ) {
    ( fragmentNode as MRTNode ).resolveOutputs( ( name ) => renderTarget.getTextureIndex( name ) );
}
```

The cache key hashes `{count}:{formats}:{samples}:{depth}:{stencil}`. It does **not** hash texture
names. So two targets with identical formats but differently named textures share a context, and an
MRT material resolves its output names against whichever target created it. That is the
"MRT names must match the target's texture names" contract failing silently.

Refreshing `context.renderTarget` per call only half-fixes it, because `node-manager` resolves at
compile time and the compile is cached on the RenderObject.

**Fixed.** `buildAttachmentState` now hashes `${name}:${format}` per texture, so differently named
attachments no longer share. Pinned by `tst/pass-context.test.ts`, which asserts both directions:
same-shaped targets still share, and a gbuffer named `albedo`/`normal` no longer shares with one named
`colour`/`motion`. Texture names default to `output`, `output1`, ... and are mutable, so this fires
exactly when someone names a gbuffer's attachments, which is the case MRT exists for.

**`p.end()` opens a render scope.** `renderId` is not only a re-entrancy artefact: it is the
RENDER-scope update key, so camera uniforms in `renderGroup` are re-uploaded once per render and
skipped thereafter (`nodes/lib/camera.ts`, `NodeFrame` in `core/node-frame.ts`, and the
`binding.lastRenderId === frame.renderId` gate in `bindings.ts`). An earlier draft put
`beginRender`/`endRender` in "what goes away" on the grounds that they exist to stop renderIds
colliding. They do, but the renderId has a job of its own, and without a fresh scope per pass two
passes with different cameras would share a stale camera UBO.

## The shape of the code, not just the API

**State types plus standalone functions, with methods as the front door. No classes, no
factory-plus-closures.**

The backends are a state bag per concern and free functions over it, and orchestration follows: the
pools, the records and the `FrameBackend` vtable are plain inspectable data with no privates.
`Frame`, `Pass` and `ComputePass` are object literals over that state whose methods delegate to the
module's own functions, so the data stays operable directly and the surface a consumer touches reads
as `f.pass( … ).draw( mesh )`.

The distinction matters because conflating the two cost a detour. "Functional TS" was guidance about
the internals; applying it to the public surface produced `beginPass( f, desc )` and
`endPass( f, pass )`, which is more to type, loses the handle-returns-a-handle shape, and reintroduced
the `pass` naming collision below. The internals never changed; only the door did.

`FrameBackend` stays a record of functions, because it is a vtable core calls through. What it must
not be is a closure over hidden state.

### What is public

`Frame`, `Pass`, `ComputePass` and their methods, plus the descs and options: `PassDesc`,
`ComputePassDesc`, `DrawOptions`, `DispatchOptions`, `DispatchIndirectOptions`, `Rect`, `Target`, `View`.

Not public: `createFrame` and `beginFrame`, which `frame(renderer)` owns so a consumer cannot double-begin
a frame; `FrameBackend` and the backend states, which are implementation; the `pass-desc` resolvers;
and the module functions the methods delegate to.

The test that this surface is sufficient is that `tst/webgl-render/harness.ts` drives every frame case
through `../../src/index` alone. An incomplete export stops it compiling.

## The rule

**One call signature per function. No overloads. Shorthands only inside fields.**

An overload makes a reader learn several call forms. A field accepting `T | T[]`, or
`Target | { view, load }`, is one form with a normalization. Only the first is a cost.

Casualties, all drafted then cut: positional `f.pass(target, camera, cb)`, bare-drawable bodies
`f.pass(target, drawable)`, `clear?: boolean | Color`, a separate `mrt` field, `target: null`,
`frame()` accepting either a callback or nothing, an ordered-array `backend`, and
`setViewport` / `setScissor`'s rect-or-components overloads.

## Flat, not callbacks

`f.pass(desc)` returns a Pass you drive and `end()`. That is what sokol, NoGraphicsAPI and raw WebGPU
all do. At five or more passes the flat form reads better than nested closures, and the callback's
scoping benefit is small once the frame is a straight line.

Both silent failure modes get a loud guard:

- **A forgotten `end()`** makes `f.submit()` throw. Two-phase recording means the frame already knows
  which passes were never prepared.
- **A forgotten `submit()`** makes the next `frame(gpu)` throw. You find out one frame later rather
  than never.

An exception between `f.pass()` and `p.end()` leaves a dangling pass. That exception propagates
normally, so nothing is masked, but the renderer is left with an open encoder. So the second guard is
stated as **recovery, not just detection**: `frame(gpu)` finding an unsubmitted previous frame drops
its encoder, ends any open pass, reports it, and proceeds with the new frame. A mid-frame throw
becomes recoverable instead of wedging the renderer.

`using` with `[Symbol.dispose]` was considered for this and rejected. Disposal is LIFO at scope exit,
so two sequential passes declared in one scope would open the second while the first is still open and
end them in the wrong order. Making it correct needs a block per pass, which is a callback with worse
syntax plus a language feature. It is also opt-in, so it guarantees nothing that `end()` does not.

## Recording is two phase

`p.draw(x)` appends to a list and encodes nothing. **`p.end()` prepares the whole list, opens the
GPU pass, encodes it, and closes it.** Nothing is deferred to `f.submit()`; that only finishes the
encoder and queues it. All four steps are one backend call, `encodePass`, because prepare has to
complete before the GPU pass opens; see "The backend interface".

That matters because an earlier draft had `submit()` doing the preparing, which contradicts this and
breaks the WebGL mapping below, where a pass is a real state scope that has to open and close in
place. It also fixes where `PassNode` lands: `updateBefore` runs inside prepare
(`prepareRecordedDraws` in `core/renderer-ops.ts`), so the composite pass's `end()` triggers graph evaluation, which opens
and closes the beauty passes on the same encoder before the composite's own GPU pass opens. Dependency
order still lands in the command stream by construction, but the nesting is real and the "forgotten
`end()`" guard has to tolerate a pass beginning while another is mid-`end()`.

Strictly the existing shape is three phase, not two: prepare the list, open the pass, then per draw do
update plus upload plus encode inside it (`encodeDraws` in `webgpu/render-pass.ts`, `bindings.ts`). The
backend interface has to say which of those `encodeDraws` owns.

An earlier draft claimed the backends force this, because mipmap generation and MSAA resolve need
their own encoder scopes. **That was checked and is false**, though the first statement of it was also
imprecise. Mip generation does run inside the draw loop, reached through `updateTextureBinding` when a
texture uploads, but it records and submits its **own** encoder (`mipmap-utils.ts`), so it never
touches the open pass. Render-target mips run at
render-finish after submit, per the comment there: "mip generation records + submits its own encoder,
so it must run after this pass's work is queued". MSAA resolve is not a forcing function either:
WebGPU declares `resolveTarget` at pass open and WebGL's `resolveActiveRenderTarget` is a blit at pass
end.

The real reason is that **two phase is the status quo**. `ops.prepareRenderObjects(...)` already runs
before `executeRenderPass(... preparedObjects ...)`, so keeping the split changes nothing and going
per-draw would be the restructure. It also preserves update-range merging across draws that share a
buffer, which instanced batches do, and knowing the full draw list before the pass opens is what makes
the ordering check possible.

Uploads themselves would be legal inside a pass either way, since gpucat uses `queue.writeBuffer` and
`queue.writeTexture` exclusively with no staging copies, and queue operations are unordered with
respect to the encoder.

## Compute is a pass on the same encoder

Today `compute(entries: ComputeDispatch[])` is a sibling of `render()`, and its own comment says the
device work "owns its own command stream (a local encoder), independent of the render frame". So a
frame that culls on the GPU and then draws indirect is two submits with a sync point between. lib does
exactly that: `webgpu.ts` builds `dispatches: ComputeDispatch[]` in three places and then renders.

`f.compute()` puts it on the frame's encoder, so cull-then-indirect-draw is one submit.

It also dissolves `ComputeDispatch`, which was a discriminated union with `never` fields on both
branches. The first attempt made it one `c.dispatch( node, opts )` with both fields optional and a
runtime "exactly one of" throw, which moves the problem out of the type system rather than solving
it. vgpu types the same choice as two overloads; gpucat splits it into `dispatch` and
`dispatchIndirect`, matching WebGPU's own `dispatchWorkgroups` / `dispatchWorkgroupsIndirect` and the
names gpucat's compute encoder already uses. The compiler enforces the choice and no check runs.

`BackendComputeEntry` was already structurally the same record, so it is deleted rather than adapted,
which renamed its `dispatch` field to `counts` in seven examples. **Those seven have since moved off
the batch form entirely** (6.78): each opens one frame, records a `frame.compute()` pass and its
render pass on it, and submits once. `example-webgpu-indirect-compute.ts` is the motivating case made
literal, since the GPU writes `instanceCount` and the `drawIndirect` that reads it is now on the same
encoder. What is left on `WebGPUBackend.compute` is lib's three call sites in `src/render/webgpu.ts` and
two tests that exercise the wrapper as a wrapper.

**`renderer.compute()` is a wrapper over `frame()`.** It was not, and the reason was sound: a
`compute()` call between a caller's `f.pass()` and `f.submit()` would silently abandon their in-flight
encoder. Guarding every out-of-band encoder on `isFrameOpen` turned that case into a loud error, which
removed the objection, so `compute()` now opens a frame, records one `f.compute()` pass and submits.
`dispatchCompute` is deleted; mipmap generation is the only thing left owning an encoder.

Compute-written storage textures defer their mip regeneration to `submitFrame`, next to the
render-target mips already deferred there, since generation needs an encoder of its own.

**`buffers` is not optional and must not be dropped.** It is the named-storage rebind that lets one
`ComputeNode` be reused across dispatches with different buffers, and lib's whole GPU voxel path is
built on it: the cull chain reuses one `emit` node across passes with different maps, and the radix
sort ping-pongs `srcKeys` / `dstKeys` / `radixHist` by rebinding per dispatch across a dozen
dispatches (`lib/src/render/voxels/voxel-resources-gpu.ts`, nine `buffers:` sites in that file alone).
The render-side equivalent is `geometry.setBuffer(name)`, resolved by
`buffers?.[name] ?? geometry?.buffers.get(name)` in `webgpu/buffers.ts`, and a compute node has no
geometry. An earlier draft said this "should route through one mechanism" without naming one, which
would have silently broken lib's WebGPU frame.

`f.compute()` throws on WebGL2, at open rather than at `end()`, so no dispatch is ever recorded
into a pass that cannot run. It pivots on `FrameBackend.name`, the same `'webgl' | 'webgpu'` tag the
renderers already carry as `renderer.backend`, rather than a `supportsCompute` capability bit: there are
two backends, not an open capability set, and a second vocabulary for one call site earns nothing.

Frame bodies are therefore not portable across backends. lib already
branches on `gpu.backend`; nothing regresses, but "same code, both backends" stops being true at the
frame level.

## Bindings resolve late

**A TextureNode's binding is resolved when the bind group is packed, not when the node is built.**

**Only needed for ping-pong, so unscheduled with it.** An earlier draft claimed resize forces this.
It does not. `RenderTarget.setSize` mutates `tex._gpuTexture.width/height` in place and sets
`needsUpdate` (`RenderTarget.setSize` in `core/render-target.ts`), so the `GpuTexture` identity a binding holds stays
valid and `updateTextureBinding` reallocates and bumps the generation into a bind-group rebuild
(`webgpu/bindings.ts`). `PassNode` says so itself: "The pass's depth attachment is a stable
reference (RenderTarget.setSize mutates in place), so the binding's `value` is set once at
construction and never needs to be refreshed" (`render-texture-node.ts`).

What `_updateTextureResources()` actually serves is `toggleTexture`, swapping whole `Texture` objects
for previous-frame data, and `getPreviousTextureNode` / `toggleTexture` have no callers outside
`render-texture-node.ts` in src, examples or lib. So this section exists only to support ping-pong, and moves
with it.

## Ping-pong is a parity bit

Temporal effects (TAA, motion blur, feedback, iterative solvers) sample the previous result while
writing the next one, so they alternate between two targets. The graph is compiled once and must keep
reading the right half.

```ts
const history = pingPong( { colorFormat: 'rgba16float' }, w, h )

const resolved = taa( world.color, history.readColor )     // compiled once

const a = f.pass( { color: history.write, camera } )
a.draw( accumulate )
a.end()
history.swap()
```

The helper owns the parity bit and the lifetime of its two halves and nothing else, following vgpu's
`pingPong`, whose docs are explicit that it "does not cache bind groups, infer pipeline layouts, or
preserve contents across resize". Resizing reallocates both halves, resets parity and loses contents,
so a resize has to signal the caller to re-seed.

Rules that fall out: `swap()` exactly once per encoded step, display `read` *after* the swap, and
`read` may never be an attachment of the pass that samples it.

`pingPong` is a convenience for the symmetric case, not a requirement. three.js has no such helper and
sixteen of its TSL display nodes each roll their own pair, swap and rebind; `TRAANode` needs a depth
texture on the history half and `GaussianBlurNode` uses differently sized halves, so a single
symmetric helper would not have covered them anyway.

Not scheduled. Nothing in lib needs it today.

## PassNode stays

An earlier draft deleted `PassNode` and made the post chain app-ordered. That was wrong.

What it provides that nothing else does is **the ordering proof**: the graph guarantees a pass ran
before anything samples its texture. The replacement was a runtime warning, which is strictly weaker,
and whose failure mode on WebGL is silently reading last frame. It also owns sizing, resolution scale,
viewZ and linear depth nodes, `passId` for inspector timing and ID namespacing, MRT and previous
textures, none of which need moving if it stays.

The problem was never that it is a node. It is that it drives the renderer by mutating ambient state.
Two changes fix that:

1. It takes contents rather than only a `Scene`:
   `pass( contents: PassContents, camera, opts? )` where
   `PassContents = Object3D | ( ( pass: Pass ) => void )`. A union parameter that hides no
   machinery: the Scene form is literally `drawScene( gpu, pass, scene, camera )`, and it serves every
   one of the 46 examples plus the editor.
2. Its `updateBefore` opens an ordinary `f.pass()` on the already-open frame instead of
   save-set-render-restore.

**Both are done, and doing them forced `render()` onto the frame API.** A `PassNode` records on
`renderer._frameState`, which the old `render()` never opened. So `render( scene, camera )` is now one
`frame(renderer)`, one `f.pass()`, one `drawScene`, one `p.end()`, one `f.submit()` on both backends. The
plan wanted that as a *test* of the scene layer; it turned out to be a prerequisite. It deleted
`prepareRenderObjects`, `resolveViewportScissor` and both `executeRenderPass` implementations.

See "Recording is two phase" for how this lands: the composite pass's `end()` triggers prepare, which
evaluates the graph, which opens and closes the beauty passes on the same encoder before the
composite's own GPU pass opens. Dependency order reaches the command stream by construction, and the
nesting is real rather than eliminated.

So `pass()` is a pass that schedules itself from its dependencies and hands you a texture node, and
`f.pass()` is a pass you place yourself. Only the first takes contents up front, because it runs
itself and there is no moment where you hold it. That asymmetry is real, not an oversight.

The slogan "nodes never render" is false and was driving the design; the accurate version is "nodes
never mutate renderer state".

## fullscreen() replaces RenderPipeline

`RenderPipeline` is 114 lines that do three things: build a fullscreen `Material` from an output node,
hold a `QuadMesh`, and drive the frame. Only the first is worth keeping.

```ts
export function fullscreenPosition(): Node<Any> {
    const x = select( f32( -1 ), f32( 3 ), equal( vertexIndex, u32( 1 ) ) )
    const y = select( f32( -1 ), f32( 3 ), equal( vertexIndex, u32( 2 ) ) )
    return vec4f( x, y, f32( 0 ), f32( 1 ) )
}

export function vertexCountGeometry( count: number ): Geometry
export function fullscreen( fragment: Node<Any> ): Mesh
```

**`fullscreenPosition` is a function, not a constant, and that is load-bearing.** Written first as a
module-level `/*@__PURE__*/` constant, exporting it from the index broke five golden snapshots across
`wgsl-golden`, `glsl-golden` and `struct-texture-decode-golden`. Node ids come from a global counter
and emitted shader identifiers derive from them, so building nodes at module scope renumbers every
node created afterwards and rewrites identifiers in unrelated shaders. The existing module-level nodes
are safe only because the goldens were recorded with them present.

So: **any new DSL constant must be built on call.** This is also the golden invariant working exactly
as the plan claims it would.

`select` plus `equal` rather than the canonical `(vid << 1) & 2`, because the DSL exports `shiftLeft`
and `shiftRight` but no bitwise AND.

Proven by a pixel case: `fullscreen(vec4(0.2, 0.7, 0.4, 1))` drawn through the frame API with no
vertex buffer bound lands on `[51, 179, 102, 255]`.

A plain `Mesh` and no dummy camera. It does carry a position+uv triangle: see "fullscreen() needs uvs"
below, where the bufferless version turned out to break every `TextureNode`, which samples with
`varying(uv())` unless told otherwise. `fullscreenPosition` and `vertexCountGeometry` remain exported
for a fragment that genuinely samples nothing.

It goes because `Material` already has the mechanism `RenderPipeline` reimplements: `version` plus the
`needsUpdate` setter, with `version` in the RenderObject cache key. Swapping the post chain is
`composite.material.fragment = next; composite.material.needsUpdate = true`.

Blast radius, corrected: **39 of the 46 `examples/src/*.ts` use `RenderPipeline`.** An earlier draft
said zero, from grepping `examples/*.html`, which are only loaders. None use `QuadMesh` directly, and
only 6 call `renderer.render(` directly. In gpucat's tests only 4 files construct a renderer at all
(`render-encoder`, `stencil`, `viewport-scissor`, `uniform-dedup`); the golden tests never touch it.
In lib it is 5 files with 4 `.render()` call sites.

So the example churn is the largest single piece of mechanical work in this change, not a rounding
error. Examples also depend on `autoClear = false` plus `renderer.clear()`
(`example-webgl-stencil.ts`, `example-webgpu-stencil.ts`) and `setScissorTest`
(`example-webgpu-viewports.ts`), all of which this plan removes, so their migration is not a
find-and-replace.

### fullscreen() needs uvs, and that is why QuadMesh existed

`fullscreen()` first shipped on a geometry with **no vertex buffers**, positions derived from
`vertexIndex`. That is correct for a fragment that samples nothing, and wrong for the thing
`RenderPipeline` is for. A `TextureNode` defaults its coordinate to `varying(uv())`, the uv **vertex
attribute**, so `pass.getTextureNode().rgb` in a post chain sampled an unbound attribute and returned
one texel for the whole screen. `pass-occlude` caught it; a constant-colour fullscreen case cannot.
**Named at the source in layer 6.39**: `assertVertexBuffers` is neutral and both backends call it, so
an unbound attribute now reports the buffer and its shader locations rather than leaving Dawn to blame
an anonymous vertex slot and WebGL to draw silently from whatever that attribute last held.

So `QuadMesh`'s value was never the triangle, it was the triangle **with uvs**. `fullscreen()` now
carries position and uv. `fullscreenPosition` and `vertexCountGeometry` remain exported as the
bufferless primitives for a fragment that never samples by uv.

### A bufferless geometry already works

Verified, no new backend capability needed:

- `resolveVertexDrawRange` sizes a non-indexed draw from the `position` buffer, and with no position it
  uses `drawRange.count` directly. Its own comment calls the `Infinity` case's fallback of 3 "the
  historical fallback rather than a meaningful answer", so an explicit `count: 3` is the meaningful one.
- Both backends iterate `nodeState.vertexBufferGroups`, which comes from the compiled node state, so a
  material whose vertex node reads only `vertexIndex` declares zero attributes and both attribute loops
  are no-ops. WebGL2 still creates and binds a VAO; one with zero enabled attributes is legal.
- The only place that requires a `position` buffer is wireframe index generation, which is opt-in.

This also serves a case unrelated to composites: lib already has four files in `src/render` driving
vertices from `vertexIndex` rather than attributes. Clouds pull position, normal and index from storage
buffers, and `Geometry.buffers` is already documented as holding "vertex attributes, storage buffers,
or any buffer type". A `Geometry` that carries bindings and a count but no attributes is an existing
pattern, not a new one.

Needs a smoke test rather than design work.

## MRT

gpucat already has three's model, and it is the reason the bundle form costs less than it looks.

```ts
export class MRTNode extends OutputStructNode {
    outputNodes: Record<string, Node<d.Any>>;
    blendModes: Record<string, BlendMode> = { output: _materialBlending };
    /** Resolved output names in order. Populated during setup() when render target is known.
     *  Used by the compiler to emit correct @location indices. */
    _resolvedNames: string[] = [];
    setBlendMode( name: string, blend: BlendMode ): this
}
```

Outputs are a **named dictionary**, not an indexed array, and the names resolve to `@location` indices
by matching the render target's texture names. So `mrt({ output, normal })` only works against a target
whose textures are named `output` and `normal`. That is a real contract between two objects, and it is
now written down in `tst/pass-desc.test.ts` rather than nowhere.

`encodePass` resolves the names, and only against a `RenderTarget`: a pass carrying `mrt` with a canvas
target throws, because the swapchain has one attachment. An unmatched name still warns and skips inside
`resolveOutputs`, which is weaker than it should be; see Open.

**Per-attachment blend lives here, keyed by output name.** Which retires the objection to the bundle
form: attachments do not need to be individually addressable in `PassDesc` for per-attachment blend to
work, because it was never on the attachment.

`mrt?: MRTNode` on `PassDesc` is therefore the faithful home for what is `renderer.mrt` and
`PassNode._mrt` today.

Two known extensions, both additive, neither needed by lib:

- **`clearColors` on the MRT node.** three has it, gpucat does not. That is where per-attachment clear
  belongs if it is ever wanted.
- **Merging a material's MRT over the pass one.** gpucat already resolves a material's own MRT
  fragment per compile (`core/node-manager.ts`) and keys on it via `getTargetCount(material.
  fragment)` in the pipeline key, so it is not true that only the pass half exists. What is missing is
  three's `merge`: `renderer.getMRT()` then `mrt.merge( materialMRT )` with the material winning on
  key collision, so a pass declares the gbuffer slots and a material adds its own.

vgpu does the opposite and it is instructive about why gpucat does not: its MRT is indexed, with
`target(gpu, { colors: [...] })` and per-attachment blend on the draw "aligned by index", because its
shaders are hand-written WGSL where `@location(n)` is already explicit. A node DSL has no user-visible
locations, so names are the only handle.

## Targets, canvases and resize

`RenderTarget` and `CanvasTarget` both become `Target`, which is what makes `f.pass( { target: view } )`
work without a special canvas case. Whether the classes themselves take vgpu's names (`Surface` and
`Target`, with no union, per `vgpu/src/target.ts:43` and `vgpu/src/surface.ts:37`) is open; the factories
`canvasTarget()` and `renderTarget()` landed first because they are what a rename would have to
preserve either way. There is no null target and no `renderer.canvasTarget`. A canvas
whose drawable extent is zero skips that pass rather than failing the frame.

`renderer.setSize` and `renderer.setPixelRatio` split three ways:

- `CanvasTarget` already has `setPixelRatio`, `setSize` and `getDrawingBufferSize`. It gains vgpu's two
  good ideas: `dpr` as `number | [ min, max ]` so a clamp needs no app-side `devicePixelRatio`
  tracking, and `onResize( cb ): () => void` firing immediately on subscribe and then on change.
  It also gained `depthFormat`, `samples`, `alphaMode` and `clearColor`, which used to live on
  `WebGPUBackendOptions` and `SwapchainState`, without which it is not the bundle this plan claims.
  Its colour format is device-dependent (`getPreferredCanvasFormat`), so the backend stamps
  `colorFormat` when it configures the context. **Done.**
- `autoResize`, reading `clientWidth`/`clientHeight` before each pass, default on for layout-backed
  canvases (`'clientWidth' in canvas`, so off for an `OffscreenCanvas`). A canvas's size is a DOM fact,
  so reading it is not magic. It resizes with `updateStyle: false`, since writing CSS back would fight
  the layout it just read. **Done.**
- Offscreen `RenderTarget`s are resized by the application and never automatically. Resolution scale
  becomes a handler rather than a renderer setting:
  `view.onResize( e => world.setSize( e.width * scale, e.height * scale ) )`.

`readPixels(renderTarget, attachmentIndex, layer)` is now `read( gpu, target, opts )`, **not**
`target.read(opts)`. **Done.** It also closed a leak: `index.ts` had been exporting the WebGPU-only
`readPixels`, whose first parameter was the concrete WebGPU renderer, from a backend-neutral package. vgpu puts it on the target, but vgpu's targets are created with a gpu and hold a
device back-pointer. Ours are device-free, so a method on the target would need exactly the
back-pointer the declarative rule exists to avoid. It is an operation, so it takes the gpu, like
`compile`. The contract needs stating either way: read after submit, awaits the queue.

## Headless

gpucat needs nothing node-specific.

`webgpu({ device })` accepts a pre-made device, which was already decided for the probe case. That is
the headless story:

```ts
import { create, globals } from 'webgpu'       // the npm package that bundles Dawn
const device = await ( await navigator.gpu.requestAdapter() ).requestDevice()

const renderer = await init( webgpu( { device } ) )
const output   = renderTarget( 512, 512, { colorFormat: 'rgba8unorm' } )

const f = frame(renderer)
const pass  = f.pass( { target: output, camera } )
pass.draw( mesh )
pass.end()
f.submit()

const pixels = await output.read()
```

No `gpucat/node`, no adapter abstraction, no second package. vgpu needs `@vgpu/adapter-node` because
its `init()` owns adapter selection; ours does not, because you chose the backend and can hand it a
device. `CanvasTarget` simply never gets constructed.

Most of this already existed as a `headless` flag on the WebGPU options, which required a pre-created
`device` and left `_canvasTarget` null. **Done**: headless is not a flag any more, it is the ordinary
case of never constructing a canvas target, and `WebGPUBackendOptions` has no such field.

The one thing to check is whether anything in gpucat touches `document`, `window` or `navigator` at
module scope rather than inside a canvas path. That breaks the import in Node regardless of API shape,
and it is the same class of blocker as lib's `EngineClient.init` DOM coupling, one layer down.

## Backend selection is the caller's

```ts
import { init, webgpu, webgl } from 'gpucat'

const renderer = await init( webgpu( { powerPreference: 'high-performance' } ) )
```

`backend` is required. No default, no `'auto'`, no ordered array. Probing, the fallback and any
software-adapter judgement are the caller's, which is what lib wants anyway: its own comment on
`webgpuAvailable()` says the adapter probe is "not proof the device works".

A backend is a factory so its device options travel with it: `webgpu({ device, powerPreference,
adapterOptions, deviceDescriptor })`, `webgl({ ...contextAttributes })`. The target is not device
options and stays on `init`. Today those live on `WebGPUBackendOptions`; with a factory, `init` never
carries a union of both backends' config. **Done.**

**`webgl` takes a `target` and `webgpu` does not, and that asymmetry is load-bearing.** A WebGL2
context is a canvas's context, so that backend's device cannot exist before its canvas; WebGPU
acquires a context per target inside the pass that names it, so it needs none. The signatures say
which is which rather than pretending they are the same shape.

**`BackendFactory` is generic, which is why no union type is needed.** Its second parameter is what the
backend's device needs in order to exist, and `init` overloads on it.

```ts
type BackendFactory<B extends DeviceBackend = DeviceBackend, DeviceTarget extends CanvasTarget | undefined = CanvasTarget | undefined>
    = { readonly name: B['name']; create( target: DeviceTarget ): B }

function init<B extends DeviceBackend>( opts: { backend: BackendFactory<B, undefined> } ): Promise<Renderer<B>>
function init<B extends DeviceBackend>( opts: { backend: BackendFactory<B, CanvasTarget>; target: CanvasTarget } ): Promise<Renderer<B>>
```

**A factory makes a backend, not a renderer (layer 6.91), and then stopped being a factory type at
all (6.93).** `webgl()` and `webgpu()` returned `new Renderer( new XBackend( opts ) ).init()` until
6.91, which left `init` as a one-line forward and put the only `new Renderer` in the codebase in two
places instead of none. It also ran the dependency backwards: both backend modules imported
`core/renderer`, the layer that sits on top of them.

`BackendFactory` itself went next, because once the factories returned backends it was carrying
nothing. Its `name` was read by no code in `src` (every discriminant reads `backend.name` off the
constructed object), and its `create( target )` parameter was used by one of the two backends, since
`webgpu()`'s ignored it. What it bought was the overload pair that made `target` required for WebGL
and impossible for WebGPU without `init` naming a concrete backend, and **that asymmetry belongs to
the backend, not to `init`**: `WebGLBackendOptions.target` is already documented as "the device, not
just a target: a WebGL2 context IS this canvas's context". So the canvas is a constructor argument,
`init` has one signature and no overloads as the rule above requires, and the two lowercase factories
are one-line constructors kept for spelling consistency with `canvasTarget()` and `renderTarget()`.

**The target is `init`'s argument, not the factory's.** `init({ backend: webgl(), target: view })`,
not `init({ backend: webgl({ target: view }) })` — a target is the thing being drawn to, not device
config, and nesting it said otherwise. The asymmetry between the backends is real and not a split
artifact: a WebGL2 device *is* a canvas's context, and that canvas's `samples`/`depthFormat` become
immutable context attributes, whereas WebGPU acquires a device with no canvas in sight. The overloads
make omitting a WebGL target and supplying a WebGPU one both compile errors; `tst/init.test.ts` pins
all three shapes with `@ts-expect-error`. Settled, layer 6.21.

**WebGL is single-canvas, and now says so. Settled, layer 6.22.** `WebGLBackend.target` is one
constructor-set field because a WebGL2 context belongs to one canvas for its lifetime. `FrameBackend`
carries `deviceCanvasTarget` (WebGL's own canvas, `null` on WebGPU, which acquires a context per
target), and `openRenderPass` throws on any other canvas rather than drawing to the first one
silently. **N views is the supported shape, not N canvases**: one pass per `PassDesc.viewport` on one
canvas, identical on both backends. That is three's own answer too
(`examples/webgl_multiple_views.html:268`), and its `setCanvasTarget` path leaves the WebGL fallback's
context on the first canvas with no blit and no error. A renderer-owned offscreen canvas plus a
per-target blit is the only alternative and charges a full-surface copy per frame; not taken.

**`init` creates no canvas.** three's `Backend.getDomElement` manufactures one when you pass none,
which forces `renderer.domElement` to hand it back — ambient target state renamed. Passes here name
their target, and `init` touching the DOM would break the headless path.

`init(webgpu())` is `Promise<Renderer<WebGPUBackend>>` statically, so the concrete backend is known
without a cast; `init(runtimeChoice)` is `Promise<Renderer>` and
the caller branches on `gpu.api`. `Renderer` is the one name for the thing you hold, and since layer
6.30 it is a class rather than an interface — see `PLAN-renderer-backend.md`.

**One entry point, named exports, no subpaths.** `import { webgpu, webgl } from 'gpucat'`, exactly as
the concrete renderer classes were imported before `init` existed. A static choice tree-shakes once
`"sideEffects": false` exists. A consumer wanting to avoid *fetching* the loser on a runtime choice puts
the dynamic import at its own module boundary, which lib already has as `src/render/webgpu.ts` and
`src/render/webgl.ts`.

What matters for size is `"sideEffects": false` in `package.json`, which is absent. That is why the
1.7MB dist does not shake, not the import structure.

**Added and verified, layer 5.3.** `pnpm run test:shake` bundles a one-backend app against `dist` and
asserts the other backend is absent: webgpu-only is 525 KB with no `compileGlsl`, no
`'webglcontextlost'`, no `precision highp float`; webgl-only is 646 KB with no `compileWgsl`, no
`requestAdapter`, no `createRenderPipeline`. The two sum to 1171 KB against a 1630 KB dist, so ~460 KB
is the shared node DSL, scene and math — which is the number this decision actually turns on. The
module-level state in `render-texture-node.ts` and the PURE-annotated singletons do not block it.

`gpu.backend` stays a `'webgpu' | 'webgl'` string. Selecting automatically would not remove the need to
branch on it afterwards for compute and indirect draws, and lib already does.

### How three.js does it, for comparison

`WebGPURenderer.js` statically imports both backends, so both are always bundled and always fetched.
Selection is `forceWebGL ? WebGLBackend : WebGPUBackend` plus a `getFallback` closure, and
`Renderer.init()` is a try/catch that calls the fallback on any init error.

The try/catch shape is the right one and worth copying in the caller: it catches more than a probe
does, including `requestDevice` rejecting and feature negotiation failing. The rest is not. There is no
software-adapter check at all, so a SwiftShader adapter is accepted silently. `forceWebGL: boolean` can
only force the fallback, never name a backend. And `WebGPUBackend.init` requests *every* feature the
adapter reports, with no opt-out, which turns a driver that over-reports into a device-creation failure
and a silent downgrade.

## The backend interface

Today's duplication is the sequence, not the state. `render-objects.ts` is labelled "neutral
RenderObject cache", and `render-list.ts`, `pass-context.ts`, `node-frame.ts`, `node-manager.ts`,
`draw-range.ts`, `update-ranges.ts` and `buffer-upload.ts` are already in `core/`. Each backend owns
only its device caches.

The interface falls out of intersecting the two `executeRenderPass` signatures. WebGPU takes
`contexts, device, bindings, geometries, buffers, textures, samplers, renderObjectGpu, sc, format,
encoder, nodes, passCtx, prepared, params, inspector, info`; WebGL takes `gl, caches, nodes, passCtx,
prepared, params, inspector, info`. The common ones are all core-owned already.

As built in `renderer/core/frame.ts`:

```ts
type FrameBackend = {
  name: BackendName
  beginFrame(): void
  encodePass( desc: PassDesc, records: readonly DrawRecord[], count: number ): void
  encodeComputePass( desc: ComputePassDesc, records: readonly DispatchRecord[], count: number ): void
  submitFrame(): void
  discardFrame(): void
}

type DrawRecord = { mesh: Mesh; material: Material; opts: DrawOptions | null }
```

Three things this settles that the sketch above left open.

**Encoding a pass is atomic, and that is forced.** An earlier version of this section had core call
`beginPass`, then one `encodeDraws` owning prepare and encode, then `endPass`, on the grounds that the
prepare/encode split is already per-backend. That contradicted "Recording is two phase" directly:
prepare evaluates the node graph, `PassNode.updateBefore` runs inside it, and a nested pass cannot be
opened on an encoder that already has one open. So the backend resolves context, prepares, *then*
opens its GPU pass, encodes and closes it, all inside `encodePass`. Core gained nothing from the
three-call split, since it only ever called them in fixed sequence.

Two consequences worth naming. `endPass` clears `frame.open` **before** calling the backend, which is
what lets a nested `beginPass` run during prepare. And `abandonFrame` no longer closes a backend pass,
because there is never one open outside `encodePass`.

**`frame()` and `_frameState` are different capabilities.** The node-facing contract carries both:
`frame()` opens the renderer's one reusable frame, for top-level work like `CubeCamera.update`;
`_frameState` is that frame while it is open, which is what a node records into from `updateBefore`.
A node calling `frame()` would abandon the frame it is running inside.

**A `CanvasTarget` owns its own attachments.** Swapchain depth and MSAA were one shared pair on
`SwapchainState`, and attachment resolution opened its context against `sc.canvasTarget` rather than
the pass's target, so `PassDesc.target` was ignored for canvases entirely. They are now keyed by
`CanvasTarget`, driven by that target's own `samples` and `depthFormat`. Without this, "the target is
an argument" is only true for `RenderTarget`, and a frame drawing to several canvases (an inspector
with previews, a multi-view editor) either draws to the wrong one or thrashes one shared depth
texture between sizes.

**`DrawOptions` needs a parallel array, not a field on `RenderObject`.** Render objects are cached by
(mesh, material, camera, passCtx, passId), so one mesh drawn twice in a pass is one object. Opts live
beside the prepared list at the same index, per nesting depth. Sharing the render object is right:
opts change no pipeline and no bind group, only the draw-call arguments, which are read at encode.

**A pass with no draws is a clear.** `renderer.clear()` used to own an encoder and a second
implementation of clear semantics, resolving attachments as if `autoClear` were true and then
overriding each load op. Once `clear` / `clearDepth` / `clearStencil` are independent it is just a
desc with no draws, so both `RenderPass.clear` implementations are deleted. Mipmap generation is then
the only thing left owning an encoder, and it defers to `submitFrame` by design.

**Anything owning its own encoder refuses to run inside a frame.** `readPixels`, `clear` and
`compute()` each build and submit their own command buffer, so between `frame(renderer)` and `f.submit()`
their work lands ahead of everything recorded. `readPixels` fails silently that way, returning the
previous frame's pixels. All three now check `isFrameOpen` and throw, naming the alternative. This
hazard is created by handing submission to the caller, so it belongs to this design rather than
predating it.

**A pre-warm must resolve its context the way a pass does.** `compile()` built a swapchain
`RenderContext` and took a `samples` hint, but a pipeline is keyed by sample count, colour formats,
depth format and MRT, which come from the target. Warming a scene later drawn to a `RenderTarget`
compiled a key that pass never looked up, so the pass rebuilt it synchronously. `compile` now takes
the target and calls `resolvePassContext`, so the key matches by construction. Same reasoning applies
to anything else that pre-computes against a guessed context.

**Everything `render()` guarded, a pass guards.** The frame path was built beside `render()` rather
than under it, so for several cycles it silently lacked every protection `render()` had: a fresh
renderId per pass, MRT resolution, the geometry call id, `info` counters, a validation error scope,
camera alignment, device-loss no-ops, an init guard, the zero-sized-canvas skip, and Safari's context
reconfigure. All of them now live in `encodePass`, which is the one place every caller funnels
through, and `render()` keeps none of its own copies. The general rule: if `render()` did it, it was
never about scenes, it was about passes.

**A pass aligns its own camera.** A camera's projection is built for one clip convention and
`Camera` defaults to WebGPU's, so a pass on the other backend rebuilds it. `View` carries an optional
`updateProjectionMatrix?()` for exactly this; a view without it is the caller's to keep consistent.
Both backends call `alignCameraToBackend` at the top of `encodePass`, which is the one place every
path passes through.

**Device loss belongs on the frame phases, not on `render()`.** `render()` early-returned while the
device was lost; a host driving the frame API itself got nothing. Every phase of both backends now
no-ops while lost, so a lost device makes a frame silently do nothing, which is what an animation loop
needs. `frame(renderer)` throws the same "called before init" error `render()` does, since otherwise an
uninitialised renderer fails as a `TypeError` inside the backend.

**`clear`, `clearDepth` and `clearStencil` are independent.** The desc resolved them separately from
the start, but both backends combined them (`autoClear && autoClearDepth`), so `clear: false` meant
"preserve everything" and a depth-only clear could not be expressed. `render()`'s single `autoClear`
switch now maps onto all three explicitly, which is what keeps several viewport views compositing
into one canvas.

**One shape per fact.** `resolvePassContext` used to parse the desc into `RenderContext` clear fields
*and* `resolvePassParams` into `RenderPassParams`; only the latter was read. Duplicated state is how
`clearDepth` shipped dead with a passing test asserting on the copy nobody consumed. `RenderContext`
carries what the draw loop needs (size, camera, sample count, viewport, scissor); `RenderPassParams`
carries what attachment resolution needs. No fact lives in both.

**`PassDesc` fields are not free.** Five of them shipped declared-but-unread: `layer` and `mipLevel`
(the backends take the face and level off `CubeRenderTarget` directly), and the target's own
`viewport` / `scissor`, which the frame path ignored entirely. Anything added to the desc needs a
consumer in `resolvePassContext` in the same change, or it is documentation of a feature that does not
exist. Scissor clamping lives there too, since it is the only step that knows the target's size.

**A pass is a render scope, not just a GPU pass.** `encodePass` has to do everything
`renderer.render()` did around the draws, at pass granularity: mint a fresh `renderId` via
`nodeFrame.beginRender()` and restore it after, resolve `desc.mrt` against the target's attachment
names, advance the geometry call id, count the render in `info`, and wrap the whole thing in a
validation error scope. None of these were in the first build of the frame path, and the one that
matters most is `renderId`: RENDER-scope node updates key off it, so sharing one across a frame means
a uniform refreshes for the first pass only. Nothing in the harness could see it, because every pixel
case is single-pass.

**One prepared list per nesting depth.** A single shared `prepared` array on the backend state is an
aliasing bug the moment a pass nests: the nested prepare clobbers the outer pass's list mid-fill.
`preparedByDepth` plus a depth counter keeps the steady-state frame at one array and zero allocation.

**`(records, count)`, never a slice.** The pool is handed over with a live count so a steady-state
frame allocates nothing.

**`discardFrame` is separate from `submitFrame`.** `abandon()` needs to drop a partially recorded
frame rather than queue half a frame's work.

State is closed over by the backend rather than threaded as a first argument, so core never names
`BackendState`. The non-frame surface (`init`, `resize`, `readPixels`, `dispose`) stays on the backend
and is not part of this interface.

`BackendState` is opaque to core. `resolveAttachments` stays per backend, since a
`GPURenderPassDescriptor` and `bindFramebuffer` plus `drawBuffers` have nothing in common.

**The `RenderItem` leak is closed, and it cost nothing.** `PreparedRenderObject` was
`{ renderObject, item }`, but both draw loops took only `mesh`, `material` and `geometry` from `item`,
all three of which `RenderObject` already carries. So it is now `type PreparedRenderObject =
RenderObject`, `render-types.ts` no longer imports `RenderItem`, and one wrapper object per draw per
frame stopped being allocated. `RenderItem` is now `drawScene`'s own input and reaches nothing else.

One behaviour the split has to preserve: WebGL's `executeRenderPass` early-returns on an empty draw
list but still MSAA-resolves first (`webgl/render-pass.ts`). A pass with no draws is not a
pass with no work.

So the work is: `core/frame.ts` owning the frame and pass lifecycle, the recorded draw list and the
prepare-then-encode order; both backends' `executeRenderPass` splitting into `beginPass` /
`encodeDraws` / `endPass` and no longer owning sequencing.

WebGL's split is done and cost less than expected: exactly one value, `passBlend`, crosses a phase
boundary, carried in a small `PassScope`. `executeRenderPass` survives as a wrapper over the three, so
no caller changed and the pixel harness proved the refactor byte-for-byte behaviourally identical.

What remains is the adapter: turning a `PassDesc` into the `RenderContext` plus `RenderPassParams` the
phases take, and a `DrawRecord[]` into the `PreparedRenderObject[]` `encodeDraws` consumes.

The second half turned out to be nearly free. `PreparedRenderObject` is now just `RenderObject`, and
`getRenderObject` no longer takes a `scene`, because **`NodeFrame.scene` was never read** — six writes
across both backends, `node-manager` and the pre-warm path, and zero reads in `src`, `tst` or
`examples`. `RenderObject.scene` existed only to feed it. Both are deleted, which takes a scene-layer
type out of two core structures.

So a recorded draw needs `getRenderObject(state, mesh, material, camera, passCtx, passId)` and
nothing it does not already have. `prepareRenderObjects` still takes a `scene`, but only for
`collectRenderList`, which is precisely the tree walk a recorded list replaces.

**Done**, as `prepareRecordedDraws(r, records, count, camera, passCtx, passId, prepare, out): number`
in `renderer-ops.ts`. Twenty-five lines, five tests. It fills a caller-owned `out` and returns a count
instead of allocating, so the whole recording path is now allocation-free in steady state: no Frame,
no Pass, no DrawRecord, no prepared array.

The plan called this "the real work of this layer" and was wrong. The work was the two cycles before
it, which removed what would have made it hard: `PreparedRenderObject` collapsing to `RenderObject`
meant no synthetic `RenderItem`, and `scene` proving write-only meant no scene to invent. Both were
deletions.

The other half is also done, as `resolvePassContext(state, desc)` and `resolvePassParams(desc)` in
`core/pass-desc.ts`, mirroring what both renderers do inline today. It takes `(state, desc)` and no
renderer state, because a `CanvasTarget` now carries its own `samples` and `depthFormat`: layer 0
paying off.

Two things it surfaced.

**`clearColor` had no home.** The `clear?: Color | false` semantics, settled several cycles back as
"omitted clears with the target's own clear colour", assumed a `clearColor` on targets that did not
exist; it lived on the renderer. Both `RenderTarget` and `CanvasTarget` now carry one, defaulting to
`[0, 0, 0, 1]` and writable, as vgpu does.

Its depth and stencil siblings outlived it by fifty layers. `RenderContextsState.defaultClearDepth`
and `defaultClearStencil` sat initialised and unread until 6.86, because the depth and stencil
fallbacks are literals in `pass-desc.ts` and always were. `clearColor` was found because it was on the
renderer, where this plan was looking; these two were on a state bag nobody had reason to open.

**Viewport units were never stated.** `resolveViewportScissor` multiplies by the canvas pixel ratio
for the swapchain but not for a render target, because `renderer.setViewport` took logical pixels.
`PassDesc.viewport` and `scissor` are **physical pixels of the target, uniformly**. The logical-pixel
behaviour belonged to `setViewport`, which this work deletes.

**WebGL is wired and it draws.** `webgl/frame-backend.ts` is `WebGLFrameBackendState` plus
module-level phase functions, with one `frameBackend(s)` binding them into the vtable.
`Renderer.frame()` hands out its one reusable `FrameState`, whichever backend is underneath.

Proven, not asserted. A harness case draws the same geometry through `frame(renderer)` plus
`beginPass` / `draw` / `endPass` / `submitFrame` that `solid` draws through `render(scene, camera)`,
and both land on `[230, 77, 153, 255]` through a real WebGL2 context.

**WebGPU is wired too.** `draw` split the same way, with a `PassScope` carrying the
`GPURenderPassEncoder` and `currentSets` (more crosses the boundary than WebGL's single `passBlend`,
because the GPU pass object itself is the scope), and a `frame-backend.ts` mirroring WebGL's.

The no-harness risk stopped being theoretical immediately. My first `submitFrame` read the
mip-regeneration targets from `s.inFlight`, which `endPass` has already nulled, so mip chains would
never have been rebuilt. On WebGL `cube-mips` and the MRT cases would have gone red at once; on
WebGPU tsc passes, the unit tests pass, and the mips are just silently missing. Found by reading.
Fixed with a pooled `mipTargets` filled in `endPass` and drained after submit.

Both now have `frame(renderer)`, and the WebGPU path is exercised through the stub GPU in
`tst/frame-encoder.test.ts`: one encoder and one submit per frame with a non-vacuous draw count, no
leakage between frames, and an empty pass still bracketing its GPU pass. That is the same invariant
`render-encoder.test.ts` locks for `render(scene, camera)`, so both paths are pinned while both exist.

**Layer 2 is done.** What remains is the standing asymmetry: WebGL regressions surface as wrong
pixels, WebGPU ones only as type errors or stub assertions.

Two ways to close it were tried and ruled out, so they are not worth retrying:

- **A browser harness is impossible here.** Playwright's bundled Chromium has no `navigator.gpu` at
  all, not merely no adapter, across every flag combination tried including
  `--enable-unsafe-webgpu` with Vulkan and SwiftShader.
- **The stub cannot guard the mip-regeneration bug class.** `generateTextureMipmaps` returns early
  when `mipLevelCount <= 1` and render-target textures are created with `generateMipmaps = false`,
  so the extra encoder that mip generation would create never appears. WebGL only catches this class
  because `cube-mips` uses a `CubeRenderTarget`, which does get a chain.

Which leaves **Node plus Dawn via the `webgpu` npm package**, the same route the Headless section
describes for shipping. A native devDependency is a decision to take deliberately rather than
mid-stream, but the case for it is now concrete: a bug that silently removes mip regeneration on
WebGPU passes tsc, passes 403 unit tests, and ships.

## The inspector

`inspector-base.ts` documents the whole coupling, and it is about twenty hooks rather than 11.5k lines
of entanglement: frame (`begin`, `finish`), pass (`beginRender`, `finishRender`, `getTimestampWrites`),
compute (`beginCompute`, `finishCompute`, `dispatchWorkgroups`, `dispatchWorkgroupsIndirect`), scene
(`beginRenderScene`), per-draw (`setPipeline`, `setBindGroup`, `setVertexBuffer`, `setIndexBuffer`,
`draw`, `drawIndexed`, `drawIndirect`, `drawIndexedIndirect`), plus `inspect(node)`, `perf` and `log`.

Three groups get better rather than worse:

- `begin` / `finish` fired from both `render()` and `compute()`, gated on `_renderCallDepth === 0`,
  the re-entrancy guard doubling as a frame boundary. `frame(renderer)` and `f.submit()` are an actual
  boundary, and the counter is deleted.
- `beginRender` / `finishRender` currently fire from `_renderPassNode`, so only graph passes get them.
  Under `f.pass` / `p.end()` every pass gets them uniformly, including explicit ones. **Done, and the
  pairing was the real work.** The two halves fired from different places in each backend (WebGPU from
  `RenderPass.endPass`, WebGL from the bottom of `encodePass`) and neither was balanced: `beginRender`
  runs before prepare, prepare evaluates the node graph, and a throw there left the inspector's pass
  and the render-id nesting open for the rest of the frame. Both are now one `try`/`finally` in
  `encodePass`, and `endPass(scope)` ends the GPU pass and nothing else.
- `getTimestampWrites(passId)` therefore covers explicit passes too, which closes the per-pass GPU
  timing question without new API.

Per-draw hooks are unaffected. They sit at the encoder call sites (`passSetPipeline(pass, inspector,
...)`) and stay in each backend.

`FrameRecord` lost four fields in layer 6.85: `bufferStats`, `pipelineStats`, `bindGroupLayoutStats`
and `renderObjectStats` were built every frame into the inspector's ring and read nowhere, duplicating
what the Memory tab already reads from `renderer.info.memory` on demand. `tst/frame-record-is-read.test.ts`
holds the rest, because `tsc` treats an object property as used when it is written, which is how four
of them survived.

Two things are real:

**`beginRenderScene(passId, scene, samples, colorFormat, frameId)` takes a `Scene`, and an explicitly
recorded pass has none.** Resolved by moving the call into `drawScene`, the only place that knows a
pass draws a tree. It fires for `render()`, `PassNode`'s scene form and `CubeCamera`, and does not
fire for a hand-recorded pass, so "a pass with no tree shows no tree" falls out of where the call
lives rather than being a policy the tab has to implement. Showing the flat draw list instead stays
open as a tab feature, not an API question.

`CanvasTarget` gained `colorFormat` for this, stamped by the backend where it configures the context,
which is the same move as its `depthFormat`, `samples`, `clearColor` and dpr clamp: swapchain
configuration lives on the target, the backend owns only the texture.

`_renderCallDepth` is gone. It was the re-entrancy guard doubling as a frame boundary; with `PassNode`
recording rather than re-entering `render()`, `beginFrame` and `submitFrame` are the boundary.

**`InspectableRenderer` was the union of the two concrete renderers, and this is bigger than the hook
list makes it look.** (Since layer 6.30 it is `Renderer<WebGPUBackend> | Renderer<WebGLBackend>`, and
every one of the reaches below goes through `renderer.backend`.) Nine inspector files reach into renderer internals directly, not through `InspectorBase`:
`renderer.device` about thirteen times, `_renderObjects` six, `setCanvasTarget` five, `pipelines`
three, plus `buffers`, `bindings`, `renderObjectGpu`, `render(`, `gl`, `clearColor` and
`renderTarget`. Every one of those either becomes internal to `BackendState` or is deleted outright.

**Re-measured after layer 4.41:** `device` 13, `_renderObjects` 6, `buffers` 7, `pipelines` 3,
`bindings` and `renderObjectGpu` once each. `setCanvasTarget`, `render(`, `clearColor` and
`renderTarget` are **gone** — every remaining textual match was in a doc comment describing the
deleted save-set-restore ritual, and those comments are deleted too. So the count that made this look
like a rewrite was partly counting prose.

So the viewer and preview path is a rewrite, not a handle swap. A dev tool can keep concrete coupling
and be handed the backend state explicitly rather than growing a neutral inspection interface for one
consumer, but the work is real and an earlier draft understated it.

**Correction, layer 5.2: `BackendState` names the surface, it does not hide it.** "Becomes internal to
`BackendState`" contradicts the sentence above it: making the caches `private` would break the
concrete coupling this same paragraph says a dev tool should keep. What the type is actually for is
the call sites — `encodeDraws` took fifteen parameters with seven caches among them,
`prepareRenderObject` eight with six, `resolveAttachments` six with five, `disposeDevice` nine with
eight; twenty-six became four. `WebGPUBackend implements BackendState` with no field changes, which
is both the evidence that the grouping describes what was already there and the only check that keeps
the two in step.

Neither changes the shape of the design.

## This is the shared orchestration layer

`PLAN-backend-symmetry.md` rejects a shared orchestrator, citing three.js's `common/Renderer.js` plus
`Backend.js` costing a 4000-line Renderer to unify a sequence already 85% identical by convention.
That holds for a shared *Renderer*. It does not hold for a shared *frame*.

`executeRenderPass` exists in both backends with the same name, the same arguments and the same job.
That is an orchestrator held together by convention, which is the same failure mode as the duplicated
blend resolution that motivated the symmetry plan. What is shared here is a sequence, not a policy.

## How it maps to the backends

| `f.pass` | WebGPU | WebGL2 |
| --- | --- | --- |
| open | `encoder.beginRenderPass({ colorAttachments, depthStencilAttachment, label })` | `bindFramebuffer` + `gl.drawBuffers` + `applyViewportScissor` + `establishPassBaseline` + fresh `createGlStateCache()` |
| `clear: c` | `loadOp: 'clear'` + `clearValue` | `gl.clearColor/clearDepth/clearStencil` then `gl.clear(mask)` |
| `clear: false` | `loadOp: 'load'` | nothing, contents persist |
| target's store-multisampled flags | `storeOp: 'discard'` | `gl.invalidateFramebuffer` at pass end |
| target with more than one colour | multiple `colorAttachments` | FBO attachments + `gl.drawBuffers([...])` |
| target with `samples > 1` | `resolveTarget` on the attachment | `resolveActiveRenderTarget`, a blit at pass end |
| `target: CanvasTarget` | `context.getCurrentTexture().createView()` | `gl.bindFramebuffer(gl.FRAMEBUFFER, null)` |
| `p.end()` | `pass.end()` | resolve, invalidate |
| `f.submit()` | `encoder.finish()` + `queue.submit` | nothing |

Both backends already have a standalone `clear(...)` that opens an empty pass. That becomes a pass with
`load: 'clear'` and no draws, and both go.

Two asymmetries worth stating rather than hiding:

- `frame()` is real on WebGPU and nominal on WebGL2, where it is bookkeeping only (frameId, inspector
  bracketing, stats reset). gpucat already does this, gated on `_renderCallDepth === 0`.
- A pass is a genuine state scope on WebGL2. `establishPassBaseline` plus a fresh `createGlStateCache()`
  per pass is already the shape, so `f.pass` is not sugar there.

Viewport Y is already normalized: `applyViewportScissor` flips to GL's bottom-left origin, so the public
convention stays WebGPU's top-left.

Per-attachment blend stays WebGPU-only and already rejected. `planPassBlend` refuses an MRT asking for
differing per-attachment blends because WebGL2 has one global blend state. Blend lives on Material, one
per draw, so nothing changes.

## Performance: this is an ownership change, not a speed change

**Pooling now covers what the bundle work added** (6.126). The five pooling tests predate
`PassEntry` and `PreparedSegment`, so neither pooled array was checked. Both are, by identity across
frames: the union slot is reused when the entry kinds line up, and `segmentsByDepth` hands back the
same array.

Worth stating plainly so nobody expects otherwise. Per-draw cost is
`updateRenderObject` then `updateRenderBindings` then `packAndCompare`, plus upload checks, all inside
the open GPU pass (`encodeDraws` in `webgpu/render-pass.ts`, `bindings.ts`). The frame
API does not touch any of it.

Two concrete wins, both from ownership:

- One `queue.submit` instead of two when compute precedes render, since compute currently owns its own
  command stream (`compute.ts`, `renderer.ts`).
- One fewer `pushErrorScope` / `popErrorScope` pair per nested render (now once per `encodePass`).
  Pulling on this in 6.88 found the pair **unbalanced**: `encodePass` pushed its scope and reached the
  pop past three statements that can throw, including the node-graph evaluation inside
  `prepareRecordedDraws` where `assertVertexBuffers` throws on purpose. A skipped pop leaves a
  device-level scope pushed for good, so every later pop reports its error against the wrong pass.
  `submitFrame` had the same shape around `encoder.finish()`. Both pop from a `finally` now, held by
  `tst/error-scope-balance.test.ts` against a counter added to the stub device. **Compute had no scope
  at all** (6.89), so a bad binding surfaced only at submit and against the whole frame, while a render
  pass in the same frame would have named itself; `encodeComputePass` also left the inspector's perf
  span open on a throw. Both closed, and a compute validation error names its pass now.

And one concrete regression to design against: **per-frame allocation**. Today a frame allocates a
`preparedObjects` array plus one `{ renderObject, item }` per draw (`preparedAt` and
`prepareRecordedDraws` in `core/renderer-ops.ts`), a
`gpuBindGroups` array per draw, a RenderContext string key per render call
(`getRenderContext` in `pass-context.ts`), pass params and clear-colour objects, and a fresh `createGlStateCache()`
per pass on WebGL. This plan adds a `PassDesc` literal per pass (an inline `clear: [r,g,b,a]`
allocates), a `Pass` object, and a recorded draw list. It also removes the one pool on lib's path,
since `RenderList` pools its items (`core/render-list.ts`) and a consumer recording draws
directly no longer goes through it.

lib is roughly four passes and a few dozen Mesh draws, so this is moderate, not a cliff. What was
built: **`Frame` owns a pool of `Pass` objects, each with a pooled `DrawRecord` array read as
`(records, count)` so a shorter frame reuses the longer one's slots**, and the same for compute
dispatches, per nesting depth. **Held by `tst/frame-pooling.test.ts` since layer 6.87**, against
object identity rather than heap size: same `Frame`, same `Pass` objects, slots surviving a shorter
frame, and the pool growing to the deepest frame and staying. It was a performance claim in a type
doc with no gate under it for sixty layers.

Two further prescriptions here were written before the code and did not survive it. `PassDesc` **is**
retained, by reference, until `end()` reads it; copying its eleven fields to release a literal the
caller allocated anyway is more work, not less. And "`RenderContext` keyed by WeakMap" contradicts
"Pass identity comes first", which settled that identity is the attachment *shape* and that a
`WeakMap<Target, RenderContext>` is wrong because it splits pipelines and RenderObjects per target.
Shape keying won, so the per-pass key is still a string build. It no longer allocates an intermediate
array, and memoizing it needs a shape version on `RenderTarget` that nothing currently maintains, so
it waits for a measurement rather than a guess.

### Do not preclude render bundles

The recorded draw list is the natural place for `GPURenderBundle`, which is the actual state-of-the-art
answer to encode cost on low-end hardware for a mostly static chunk set. three has `RenderBundle`
already. Deferring is fine; the record format must stay replayable across frames so that deferring
does not become precluding.

**Taken up, and the record format held: `PLAN-render-bundles.md`.** `DrawRecord` is neutral and
already replayed at `end()`, and the attachment signature a `GPURenderBundleEncoder` needs is the pass
context's own cache key, so validating a bundle against the pass executing it is a key comparison. The
cost the design names is that `Pass.records` has to become a union of draw and bundle entries — a
bundle must be an *entry*, not a copy of its draws, or WebGPU cannot call `executeBundles` once
instead of re-encoding — and the pooling invariant 6.87 pins has to survive that.

## Compilation stays lazy, with an optional pre-warm

Lazy by default is the position. A two-line example must work without a compile step, and the node graph
handing you a pipeline for free is the point of the library.

What breaks is the pre-warm entry point, `compile(scene, camera, samples?)`, which walks a scene's render
list. The pipeline cache key tells us the replacement shape:

```ts
makeRenderPipelineKey( renderObject.material, samples, colorFormats, depthFormat, mrt )
```

No mesh, no geometry in the key. But the **descriptor** the key caches does read geometry:
`buildVertexBufferLayouts(geometry, nodeState)` takes `arrayStride` from
`geometry.buffers.get(group.name)` and silently skips the whole layout when the buffer is absent
(`webgpu/pipelines.ts`). So pre-warming with no geometry would cache a pipeline with missing layouts
under a key the first real draw then hits. The RenderObject cache key already carries
`${name}:${buffer.format}` (`core/render-object.ts`); the pipeline key does not, which means
either the pipeline key is already incomplete (two geometries with different strides for the same
attribute name share one pipeline today) or pre-warm cannot be per material.

Confirmed by reading `buildVertexBufferLayouts`:

```ts
if ( group.stride > 0 )        arrayStride = group.stride;                        // from the node
else if ( group.name !== null ) {
    const buffer = geometry.buffers.get( group.name );
    if ( ! buffer ) continue;                                                     // drops the layout
    arrayStride = getBytesPerElement( buffer.format );                            // from the geometry
} else                         arrayStride = wgslTypeItemSize( firstAttr.type ) * 4;
```

`group.stride` comes from `a.node.stride` (`builder.ts`), set for interleaved attributes and zero
otherwise. So `attribute('position', d.vec3f)` on a named buffer, the common case, takes its stride
from the geometry, and that stride is not in the pipeline key. Two consequences: a latent bug today
(two geometries with different buffer formats for one attribute name under one material share a
pipeline with the wrong stride, not firing because materials are normally paired with consistent
geometry), and pre-warm cannot be per material.

**A src-only sweep cannot see the public surface.** `info.memory.texturesSize`,
`info.memory.texturesByFormat` and `BufferWrite.full` all look write-only inside gpucat and are read
by `lib/src/render/gpu-stats.ts`. `info` is on the contract precisely so hosts can read it. Anything
reachable from `index.ts` or hanging off a public object needs the consumer checked before it is
called dead.

**Write-only is a defect class, not an untidiness.** `PassDesc.layer`, `PassDesc.clearDepth`,
`DrawOptions` entire, `RenderObject.passId`, `RenderObject.initialCacheKey`, `RenderObjectGpu`'s
`vertexBuffers` and `indexBuffer`, `RenderList.occlusionQueryCount`: each compiled, several were
assigned on a hot path, and none were read. A type-checker cannot see it and a green test suite does
not either. Comparing reads against writes per field is the sweep that does.

**Every cache states what it watches.** Audited across five: the FBO cache tracks a generation per
attached texture, bind groups track texture generations plus buffer identity, and programs key on
source. Those three are right. The pipeline cache and the WebGL VAO cache each watched less than the
thing they cached depended on, and both were wrong. The rule that falls out: a cache's invalidation
must name every input of its key, and if it cannot, the key is in the wrong place.

**Geometry has two versions, and conflating them is a bug either way.** `version` is the shape (a new
or removed buffer name, or a changed format) and forces a node-graph recompile. `bindingsVersion` is
the bindings (any set or remove) and forces a rebind, including dropping every WebGL VAO built against
the old buffers, since a VAO bakes in the GL buffer it was bound to. One counter cannot serve both: a
same-format swap must rebind without paying for a recompile.

**A cache invalidated on less than it depends on.** Putting the vertex layout into the pipeline key
was necessary and not sufficient. `getCachedPipelineKey` memoized that key against `material.version`
alone, and `initRenderObject` resolved a RenderObject's pipeline behind `if (!gpu.pipeline)`, once and
never again. So neither a geometry buffer swap **nor a material change** rebuilt a pipeline after the
first draw, and the node graph recompiled while the pipeline state it bakes into did not. Fixed at all
three levels, with tests that fail on the old code.

**Resolution: pre-warm takes drawables, and the vertex layout signature goes into the pipeline key.**
The key half is **done** and pinned: `vertexLayoutKey` is part of `makeRenderPipelineKey`, and a test
draws one material over a `vec3f` and a `vec4f` position buffer and asserts two pipelines. The
drawables half is not: `compile` still takes `(scene, camera, target?)`, and changing it touches four
example call sites.

```ts
compile( gpu: Renderer, drawables: Mesh | Mesh[], target: Target, camera: View ): Promise<void>
compileCompute( gpu: Renderer, nodes: ComputeNode | ComputeNode[] ): Promise<void>
```

Subject then context, gpu first like every other operation. The camera is not in the sketch above and
is required: `getRenderObject` takes a `View` to construct with, so a pre-warm without one cannot
build the object a pass will reuse. The node-graph `compile` from `nodes/builder` was renamed
**`compileWgsl`** to free the name, which also makes it consistent with `compileGlsl` and
`compileCompute`. The array form is not sugar:
`renderer.compile` collects `pipelinePromises` across all items and awaits them together, so a
per-drawable `await` in a loop would serialize what is parallel today.

Taking drawables also closes what was a separate open question. Phase two, `uploadRenderObjectResources`
for bind groups and uploads, is per drawable, so one call now covers both phases, which is exactly what
`renderer.compile` already runs.

**Done.** `compileCompute` throws on WebGL2 rather than no-opping, since a backend that cannot run
compute at all is a mistake to warm for; `compile` no-ops there because GL programs are cached by
source. Two examples were awaiting three compute pre-warms in sequence and are now one call, which is
the array-form argument holding in practice.

`compileCompute` stays separate rather than becoming an overload: a compute pipeline keys on the node
alone and has no target, so a unified signature would carry an argument that is meaningless for half
its inputs. Batching across both is the caller's `Promise.all`. gpucat already has one entry point per
pipeline kind (`compile`, `compileCompute`, `compileGlsl`, `compileTransformFeedback`), so this is
consistent rather than novel.

Rejected: always deriving stride from the node so geometry drops out. Better end state, but it changes
stride for every packed-format buffer, which is a behaviour change that does not belong in this one.

No `compileSync`. vgpu has it because it chooses between `createRenderPipeline` and
`createRenderPipelineAsync`; gpucat already uses the async one and WebGL is synchronous regardless.

`renderer.compile` has a second phase, `uploadRenderObjectResources`, which pre-uploads buffers, textures
and bind groups. That half is per drawable rather than per material, since bind groups are per
RenderObject, so it needs its own entry or a combined call taking drawables. Open.

Backend asymmetry: WebGPU has `createRenderPipelineAsync` (already used in `webgpu/pipelines.ts`) so
pre-warm genuinely overlaps with other load work. WebGL2 has no async link and gpucat does not use
`KHR_parallel_shader_compile`, so pre-warm there only moves the stall off the frame. **That is worth
doing anyway** (layer 6.12): the consumer has a loading screen, and 220 ms of linking belongs on it.

Rejected: NoGraphicsAPI's model, where every PSO is created explicitly and there is no lazy path or cache
at all. Deleting the cache is appealing and makes a mid-frame hitch impossible by construction, but it
taxes every simple case and surfaces vertex layout as a user concept.

## The scene tree becomes a layer

`p.draw(mesh)` is public, so the tree walk is an ordinary function using only public API:

```ts
export function drawScene( renderer: Renderer, pass: Pass, scene: Object3D, camera: View ): void
```

It takes the renderer, which an earlier draft omitted on the grounds that the walk uses only public
API. `collectRenderList` needs `RenderListsState`, the per-(scene, camera) cache that stops a
steady-state frame reallocating its lists, and a pass carries no renderer. A module-scope side map or
a per-call rebuild were the alternatives. Taking the renderer is this plan's own rule: operations
take the renderer.

**The `opts?: DrawSceneOpts` in an earlier draft of this signature is dropped** (6.117). Nothing in
this plan ever defined it or named a field for it, and a parameter with no consumer is the thing this
plan refuses elsewhere.

**It takes `Renderer`, not a structural type naming what it reaches for.** 6.117 found it typed as a
`SceneGpu` of `_renderLists`, `_nodes` and `inspector`, exported from `index.ts` — a public type whose
only content is which privates this function uses. Deleted; nothing outside its own export line named
it.

~~`DrawOptions` gained `material` to carry it, since the render list resolves each item's material and
`draw` otherwise reads `mesh.material`.~~ **The reason is wrong** (6.117). `RenderItem.material` is a
cache of `mesh.material`, never a substitution, so `pass.draw(item.mesh)` is already equivalent and
the walk passes no opts. `DrawOptions.material` is real and earns its place as a caller's per-draw
override, which is what the `draw-material` pixel case covers.

`renderer.render(scene, camera)` being writable on top of `frame` + `pass` + `drawScene` is the test that
the scene layer is a layer and not a privileged path. Note this test is weaker than it sounds while core
knows what a `Mesh` is: the dependency runs core to Mesh, so a scene helper can always be built on core.
It is a constraint worth holding, not a proof.

**And it is weaker in a second way this plan had not named** (6.118). The walk is reconstructible
*in-package*, not by a consumer: `collectRenderList` and `RenderListsState` are not exported, so an
outside caller cannot write their own `drawScene` however public `pass.draw` is. The honest claim is
that the walk draws through public API and holds no privileged path into the backends, which is what
`tst/scene-layer-reach.test.ts` pins: its entire reach into the renderer is `_renderLists`, the
per-(scene, camera) cache `collectRenderList` takes.

Exporting the render list is **not** proposed here. lib already defeats the walk's culling with 26
`frustumCulled = false` rather than wanting its own list, so there is no consumer for that surface
yet, and this plan does not add one on spec.

`renderOrder` and `frustumCulled` stay on `Mesh` as inputs to `drawScene`, not to the renderer. A consumer
that records its own passes never sets them.

## What goes away

`QuadMesh`, `__quadCamera__`, the module-level shared geometry it owned, and
`saveRendererState` / `restoreRendererState` on both renderers are **deleted**. `RenderPipeline` keeps
its public API but internally records one pass and draws one `fullscreen()` mesh, so the examples were
untouched and its own deletion is now a pure API swap.

The node contract has lost `render` and `mrt`: nothing in src drives the renderer any more. What
remained on it (`renderTarget`, `clearColor`, `autoClear`) went with `renderer.render()`; only
`getCanvasTarget()` stays, because a pass over the canvas has to name it. **Done.**

`RenderPass.clear` on both backends is **deleted**, and so is `renderer.clear()`: an empty pass is the
clear. Its `color` / `depth` / `stencil` flags were the pass desc's per-attachment load ops with the
ambient fields supplying the values, so once those went it was an alias. **Done.**

`RenderPipeline`, `QuadMesh`, the module-level shared fullscreen triangle geometry, `__quadCamera__`,
`renderer.render`, `renderer.renderTarget` / `.mrt` / `.clearColor`, the save-set-restore block in
`PassNode.updateBefore`, `saveRendererState` / `restoreRendererState`, the `_renderCallDepth`
re-entrancy guard, both backends' standalone `clear(...)`, `autoClear` / `autoClearStencil` /
`clearStencilValue` **as ambient renderer fields** (the last two live on as derived
`RenderPassParams`, computed from `PassDesc.clearStencil` in `resolvePassParams`, which is the point
rather than a leftover), `setViewport` / `getViewport` / `setScissor` / `getScissor` / `setScissorTest`,
`overrideMaterial`, `RenderTarget.viewport` / `scissor` / `scissorTest` (which lib mutates today and
which would otherwise leave viewport state in two places), `passId` from the RenderObject cache key
and `callDepth` from the RenderContext key, and the ten public `readonly` cache fields (`buffers`,
`textures`, `samplers`, `pipelines`, `bindings`, `geometries`, `renderObjectGpu`,
`bindGroupLayoutCache`, `canvasContexts`, `swapchain`) which are gathered into `BackendState` and
passed as one argument. **Done** — see the correction under The inspector: gathered and named, not
made private. Re-audited in 6.95 and it holds: six functions across `webgpu/prepare.ts` and
`webgpu/render-pass.ts` take `b: BackendState`.

**That audit counted the functions converted and not the ones left behind** (6.124). Eight functions
took `BackendState` while fourteen still took the caches individually, and the seam between them was
the worst of both: call sites holding `b` and spreading seven of its fields back into positional
arguments, paying the aggregate's cost and the explosion's cost at once. Finished now, down to
`initRenderObject` 9 params to 4, `updateRenderObject` 9 to 3, `encodeDispatches` 15 to 9, and zero
call sites that unpack.

The boundary is the module, not the file: a **cross-module** entry point takes `BackendState`, a
**private helper** keeps naming the caches it uses, because its parameter list is the only statement
of what it touches. `tst/backend-state-boundary.test.ts` holds both directions, so neither "convert
everything" nor "convert nothing" passes. **WebGL now has the same type in the same place**,
where it had a `DrawCaches` declared inside `render-pass.ts` and, worse, a second object literal
copying seven backend fields at frame-backend construction, which is the copy WebGPU's doc exists to
say it does not keep.

`RenderTarget.viewport` / `scissor` / `scissorTest` are **deleted**. `PassDesc.viewport` and
`PassDesc.scissor` are the one place; a target holding a second copy is the duplication that made
`clearDepth` and the clear flags go wrong. lib's per-tile mutation becomes
`f.pass({ target, viewport: tile.rect, scissor: tile.rect })`.

`passId` and `callDepth` are **gone from both cache keys**, and the doc comment still describing the
old `{attachmentState}-{mrtId}-{callDepth}` format went with them in layer 6.15. `callDepth` was a constant `0` at every
call site. `passId` was `desc.label ?? 'render'`, so labelling a pass created a separate RenderObject
universe: three labels over one mesh built three RenderObjects, and `compile()`'s pre-warm filed its
objects under `'compile'` where no pass would look. A label survives as `RenderObject.lastPassLabel`,
written only when an inspector is attached, for the draw-calls tab.

**Removing `passId` from the key also removed what was hiding a bug in it** (6.104, recorded in the
worklog but not here until 6.119). The cache is mesh, then material, then render context. `geometry`
is a source reference on the `RenderObject` and is in none of those, so swapping `mesh.geometry`
found the old entry and kept drawing the old geometry — and the pipeline-key cache was blind to the
same swap, since both caches version the geometry they were built from and a fresh one can carry the
version the stale entry was built at. This is the editor brush and lasso bug. It predates this plan:
the behaviour at `HEAD` is the same, and the partitioning `passId` used to create only ever made it
intermittent.

The audit that belongs with the fix is in `tst/render-object-refresh.test.ts`: of the fields
`createRenderObject` copies off the mesh, `geometry` is the only one, and every such field must be
refreshed on a cache hit. **`material` is safe because it is part of the key, not because anything
refreshes it** — a distinction the type did not make, which is how the two came to look alike.

`overrideMaterial` is **deleted**, and deserves a note: an earlier section argued override materials are unnecessary, citing
three.js's being broken for skinning, instancing, morph targets and displacement, without noticing gpucat
already has one. lib uses it zero times, so the conclusion holds, but this is a deliberate deletion rather
than a feature that was never wanted.

In lib: the `readonly` cast in `setActiveScene`, `rebuildRenderPipelineIfStale`, 26
`frustumCulled = false`, and the renderOrder sentinels.

## What lib actually touches

Corrected, after an earlier draft used a grep that required a literal `renderer.` prefix and missed
every site where lib aliases it to `r`:

lib uses `setSize`, `setPixelRatio`, `info`, `readPixels`, `device`, `adapter`, `gl`, and 18 calls to
`compileCompute`. (Since layer 6.30 the last three are `renderer.backend.device` / `.adapter` / `.gl`,
which is two lines in lib: its WebGPU render module reads the device and adapter, its WebGL one reads
the context.) It **does** mutate clear state: `r.autoClear = tile.clear` and
`r.clearColor = [0, 0, 0, 0]` in the icon-tile path of both backends
(the icon-tile path in both `webgpu.ts` and `webgl.ts`). It also mutates
`RenderTarget.viewport` / `scissor` / `scissorTest` directly.

**Ported, and the icon-tile prediction held.** Six mutations plus a save and a restore became one
`f.pass({ target, camera, viewport: rect, scissor: rect, clear, clearDepth })`, in both backends.
What the survey missed: `renderer.compile(scene, camera)` (now `compile(drawables, target, camera)`,
so the prewarm walks its scene and names the pass's own target), `ComputeDispatch` (renamed
`DispatchRecord`, and `.dispatch` renamed `counts`), and `PassNode.scene` (now `contents`).

**Four more export-list holes surfaced the moment a consumer compiled:** `Renderer`,
`RendererBackend`, `DispatchRecord` and `DrawRecord` were all missing from `index.ts`. Seven rounds of
this defect in total, now closed by two gates that answer different questions:

- `tst/public-api.test.ts` (6.1) asks **did the surface change**: each name-listed re-export is
  resolved through the compiler and any export in neither the list nor `DELIBERATELY_INTERNAL` fails.
  A blanket "export everything" rule was tried first and rejected on evidence, since 197 omissions
  were deliberate curation.
- `tst/public-reach.test.ts` (6.10) asks **is the surface usable**: no public signature may name a
  type the package does not export. This is the one that would have caught all seven without a
  consumer tripping over them, because it compares against a property rather than a snapshot. A
  ratchet freezes whatever it starts from, and 6.1's baseline had `ComputeNode` inside it.

Zero uses of `overrideMaterial`, the cache fields or the save/restore pair.

The files that construct a renderer or call `render()` are `webgpu.ts`, `webgl.ts`, `offline.ts`,
`pipeline.ts` and a couple of others, not all 70 files that import gpucat; the overwhelming majority
import `Material`, `Geometry`, `Mesh` and DSL nodes, none of which change.

### The migration order, and why it is an order

`drawScene` is thin — it is `collectRenderList` plus `pass.draw` in a loop, "built on `pass.draw` and
nothing private". So everything lib gives up by recording draws itself lives in `collectRenderList`,
and layer 6.108 enumerated it. **Seven things, and lib leans on all of them** (counts measured in lib,
not estimated):

1. **`!visible` subtrees are skipped.** 16 `.visible = false` sites, in `visibility/visibility.ts`, both overlay
   builders, and four editor visuals. A recorded draw ignores `visible` entirely.
2. **Disposed geometries are skipped.** `isMeshVisible` returns false for them. Recording draws one.
3. **Frustum culling.** 26 `frustumCulled = false`, which exist to *defeat* this because lib culls
   upstream in `visibility/dbvt.ts`. These are the cheapest to delete and the only ones that are pure
   subtraction.
4. **Opaque sorted by pipeline key**, to minimise state changes.
5. **Transparent sorted back-to-front by view Z.**
6. **Opaque drawn before transparent.**
7. **The scene reported to the inspector** via `beginRenderScene`, which is the scene-hierarchy tab's
   only input. 6.103 gave treeless passes a leaf row, so this degrades rather than vanishing.

The order matters because the failure modes are not alike. **3 is safe to do first and alone**: those
26 sites only turn culling off, so deleting them alongside the walk changes nothing. **1 and 2 are the
dangerous ones**, because they fail silently — a mesh lib means to hide is simply drawn, with no error
and no diagnostic, and 2 draws through freed buffers. **4, 5 and 6 are visible but not silent**:
wrong-order transparency looks wrong immediately.

So: recorded draws must take over visibility and disposal *before or with* the switch, never after.
lib has only two `drawScene` call sites, one per backend, which is what makes this tractable at all.

`CubeCamera.update` also drives `renderer.render` six times with renderTarget save and restore
(`CubeCamera.update`). Under this plan that becomes six `f.pass` calls with
`layer: face`, which is the generalization `layer` / `mipLevel` exist for, but it is a real migration
the plan had not named.

## One change, not a sequence

There are no increments and nothing ships in between. Four compromises in earlier drafts existed only
because of phasing and are gone: `renderer.render` surviving as sugar, the ambient fields surviving as
what it reads, `renderer.canvasTarget` versus a `color: null` convention, and `frame(renderer)` as a
method rather than `frame(gpu)`.

Build order is not the same thing, and it is derived from what depends on what rather than grouped by
theme. Nothing ships between layers; no intermediate state has to be coherent or compatible.

**Layer 0, no dependencies, unblocks everything after.** Can start immediately and in parallel.

- **Targets.** `Target = RenderTarget | CanvasTarget`. `CanvasTarget` gains `depthFormat`, `samples`,
  `alphaMode`, `dpr` clamping and `onResize`, and the backends read the first two from it rather than
  from `WebGPUBackendOptions` and `SwapchainState`. `PassDesc` cannot be written until a `Target` is
  a bundle.

  `RenderTarget` losing `viewport` / `scissor` / `scissorTest` **moves to layer 1**, not here. Its
  only reader picked between the target's values and the renderer's ambient ones, and both sides are
  replaced by `PassDesc.viewport` / `PassDesc.scissor`. Removing them before `PassDesc` exists leaves
  nothing to read and costs the green test suite for the whole of the keystone layer. Big bang means
  no intermediate state has to be coherent; it does not mean a removal should precede its replacement
  while there is still a suite worth running. **Done**, and the ambient readers went with
  `renderer.render()` in layer 4.38.
- **`View`.** The shape including `coordinateSystem`, and `cameraPosition` reading `world[12..14]`
  instead of calling `Object3D.getWorldPosition`.
- **The pipeline key.** Add the vertex layout signature, which fixes a latent bug independently and is
  what makes `compile( gpu, drawables, target )` sound.

**Layer 1, the keystone.**

- **Pass identity.** Keyed by attachment *shape*, not object identity: `passId` out of the RenderObject
  cache, `callDepth` out of the context key. Needs Targets.

  **Correction, layer 4.39.** The shape key had a hole: its canvas branch returned the literal
  `'default'`, so every `CanvasTarget` shared one RenderContext however it was configured, and
  `pipelines.canvasDepthFormat` was a single renderer-global feeding every canvas pass's depth-stencil
  state. Two canvases of differing samples or depth format in one frame drew with each other's
  pipelines. The key now carries the canvas's own `samples` and `depthFormat`, `getRenderContext`
  takes a `Target` and records `canvasTarget` beside `renderTarget`, and the pipeline reads the format
  off the context. This blocked layer 4: while the renderer's own canvas is privileged, `init` cannot
  stop creating one, because the swapchain configuration has nowhere else to live. **Done.**
- **`core/frame.ts`.** Done. Frame, Pass, `PassDesc`, `DrawOptions`, `DrawRecord`, `FrameBackend`,
  pooling, open-encode-close, abandoned-frame recovery. One file, not two: `Pass` is meaningless apart
  from the `Frame` that owns its pool, so splitting them would have been a file boundary with no
  seam behind it. 11 tests, no backend needed.

  **A `Frame` is reused, not constructed per frame.** `FrameState` holds one for the life of the
  renderer and `beginFrame` resets it, so steady state allocates no Frame, no Pass and no DrawRecord.
  The pooling test caught this: the pool was on `Frame`, which throws it away every frame if a Frame
  is constructed per frame.

  Still outstanding here: a render scope per `p.end()`, which needs `NodeFrame` and therefore lands
  with the backend wiring, and `render-encoder.test.ts` rewritten against the new invariant.

**Layer 2.** `executeRenderPass` splitting into `beginPass` / `encodeDraws` / `endPass` behind the
`FrameBackend` interface. Needs layer 1, because the interface is what layer 1 calls.

**WebGL first, WebGPU second**, which is not arbitrary. `tst/webgl-render/run.mjs` renders real pixels
through headless Chromium on SwiftShader and compares centre pixels within ±3 per channel across clear,
MRT, cubemaps, array layers, instancing, blending, batched `mesh.draws` and transform feedback. There
is **no WebGPU equivalent**. So a regression in the WebGL wiring shows up as a wrong pixel, while the
same regression in the WebGPU wiring would only surface as a type error or a unit-test failure. Do the
side with the net first, and let what it teaches carry over to the side without one.

Run all four at every layer boundary, not just the unit tests:

```
npx vitest run tst                # includes the public-surface ratchet
node tst/wgsl-validate/run.mjs    # 38 shaders under naga
node tst/glsl-compile/run.mjs     # 48 compiled + linked
node tst/webgl-render/run.mjs     # real pixels, headless Chromium on SwiftShader
node tst/webgpu-render/run.mjs    # real pixels, Node on Dawn, one process per case
node tst/tree-shake/run.mjs       # one-backend bundles drop the other
pnpm run typecheck:tst            # tst/ is NOT in the root tsconfig
pnpm run typecheck:examples       # builds dist first; examples are not either
```

The last two exist because `tsconfig.json` has `"include": ["./src"]` and neither `tst/` nor
`examples/` is in it. `npx tsc --noEmit` is a src-only check and always was. Both gates found real
public-API holes on their first run, six cycles apart (layers 4.35 and 4.40).

The two shader harnesses never go through the renderer, so like the golden snapshots they must stay
untouched throughout. That is a second independent check on the claim that neither the graph nor
either emitter is involved in this work.

**Layer 3, all three need layers 1 and 2 and are independent of each other.**

- `PassNode` taking contents and opening an `f.pass` in `updateBefore`.
- `fullscreen()`, deleting `RenderPipeline`, `QuadMesh`, the shared triangle geometry and
  `__quadCamera__`.
- Compute as a pass on the frame encoder, `dispatch( node, opts )` with `buffers`, and deferring
  storage-texture mip regeneration to post-submit.

**Layer 4, the context reshape.** `init( { backend } )` returning `Renderer`, backend factories,
`frame(renderer)`, `read( gpu, target )`, deleting the ambient fields and `renderer.render`, moving
`renderScene` to the scene layer, `"sideEffects": false`. This has to come after layer 3, not
alongside it: `PassNode`, `RenderPipeline` and `compute` all still go through `renderer.render` and
the ambient fields while layer 3 is being written. **Done.**

**And `init` creating no canvas had a prerequisite of its own**, found only when it was written:
while one canvas was privileged (layer 4.39), the swapchain's samples and depth format had nowhere
to live except the renderer, so `init` could not stop making the target that carried them. Ordering
inside a layer is still derived from what depends on what.

The renderer's canvas surface (`canvas`, `domElement`, `setSize`, `setPixelRatio`,
`getCanvasTarget`, `setCanvasTarget`, `samples`, `stencil`, `headless`) is **deleted** with it: the
caller makes the canvas and its `CanvasTarget`, and `headless` becomes the absence of one rather than
a flag. `setSize` turned out to be redundant before it was removed, because a pass already syncs
`autoResize` and reallocates attachments on a size mismatch.

**Layer 5, the inspector.** Frame and pass hooks re-pointed at the new boundaries, and the nine files
reaching into renderer internals re-pointed at `BackendState`. Needs layers 2 and 4.

**Layer 6, consumers.** lib first, then the 46 examples. Examples last because they are the largest
mechanical batch, they depend on every decision above being final, and nothing depends on them.
**Done**, in the other order as it turned out: the examples went with layer 4.41 because `init` could
not land without them, and lib followed.

**lib constructs rather than calling `init({ backend })`**, and that is not a shortcut. Its boot is
deliberately two-phase: sync construction so the render pipeline can be wired against GPU buffers
before any device exists, then the async handshake. Since layer 6.30 that spelling is
`new Renderer(new WebGPUBackend(opts))` then `await renderer.init()`; both stay exported for exactly
this, and `init({ backend })` is sugar over them rather than a replacement.

The three remaining renderer-constructing tests (`stencil`, `viewport-scissor`, `uniform-dedup`) ride
with layer 4. The golden snapshots must stay byte identical throughout.

### The regression net

An earlier draft claimed the 46 examples were the only net. That was wrong and it was load-bearing for
the increment structure.

Measured now, not estimated: `tst/` has **61 vitest files and 492 tests**, `stub-gpu.ts` with
`createStubGPU` and `installWebGPUPolyfills` so tests run with no device, golden snapshots of emitted
WGSL and GLSL (1051 lines), and five standalone harnesses (`glsl-compile`, `tf-probe`, `webgl-render`,
`webgpu-render`, `wgsl-validate`), the pixel two now at **86 WebGL and 54 WebGPU cases**.

Six of them construct a renderer: `render-encoder`, `frame-encoder`, `compute-pass`, `stencil`,
`viewport-scissor`, `uniform-dedup`. That was four when this was written; the two new ones are where
the frame API's own invariants live. Test churn stayed small and example churn is still ahead.

The golden snapshots are the strongest invariant available, and exactly two have moved: layer 3.1's
node-id renumbering, and layer 6.20's removal of a `uv` attribute a load-only graph never read. They drive `compile` / `compileGlsl` /
`compileCompute` straight from node graphs and never touch the renderer, and this change touches
neither the graph nor either emitter, so **they must come out byte identical**. They have, through
every layer, with one instructive exception: exporting a module-scope DSL constant renumbered node ids
and rewrote five of them (layer 3.1). That is the invariant working.

`render-encoder.test.ts` was expected to need a rewrite and **did not need one**. Its invariant, "one
frame owns one encoder and one submit, including a `PassNode`'s pass", is the frame API's invariant,
written as a net for a previous refactor of this same code. Every layer beneath it changed; it went on
passing. Only its wording needed fixing, since "a nested render reuses the parent's encoder" names a
mechanism that no longer exists.

That gap is closed as of layer 5.4: WebGL2 is proven in pixels, WebGPU is proven in pixels on Dawn,
the node graph is proven by GLSL linking and naga validation, and the one-entry-point decision is
proven by a tree-shaking harness. Six gates.

**The docs were outside all of them, and that is where the API drifted furthest.** `docs/snippets.ts`
is typechecked, but it held exactly one snippet, so every other code block in `README.template.md` was
hand-maintained prose. The frame port updated them all except compute, which by 6.78 was two APIs
behind: `renderer.compute([{ node, dispatch: [...] }])`, on a receiver that had moved to
`renderer.backend` and with a field that had been renamed `counts`, next to a `renderPipeline.render()`
that no longer exists. A second snippet now covers the compute path, and `docs/build.js` exits 1 on a
snippet group it cannot resolve rather than warning and shipping the raw tag. The examples got their
own gate too, since `vite build` transpiles without typechecking and so passed CI regardless.

Checking the remaining 47 hand-written blocks (6.79) found three more references to members this plan
deleted or moved: `renderer.domElement`, `renderer.inspector.domElement` and
`renderer.transformFeedback`. `tst/doc-code-blocks.test.ts` now reads `Renderer`'s members off the type
checker and fails on any the README reaches for that do not exist, which is the gate that was missing
rather than three more edits.

Three more gates followed from the same reasoning, all cheap because the codebase is mostly accurate
and the next rename is what breaks it. 6.82 mechanised `PLAN-backend-symmetry.md`'s rules 1 and 4,
which had been audited by hand in 6.3 and 6.72 while the plan's own module table went stale between
the two; it also withdrew a violation 6.72 had recorded, since every importer of
`render-object-gl.ts` or its WebGPU sibling also holds `core/render-object` in scope, so the suffix
disambiguates symbols rather than just filenames. 6.80 widened `tst/retired-names.test.ts` past `src`, which
found a deleted class named in each pixel harness. 6.81 added `tst/cited-files.test.ts`, which
resolves every backticked module path in every comment; it found one pointing at the WebGL renderer
module this plan deleted, and another naming a module by a name it lost two renames ago.

## Resource constructors are `create*` (6.130)

gpucat has two factory conventions and they divide cleanly: **node/DSL factories are bare nouns**
(`texture`, `uniform`, `storage`, `attribute`, `sampler`), **resource factories are `create*`**
(`createBoxGeometry`, `createStorageTexture`, `createVertexBuffer`). `createMaterial`,
`createGeometry`, `createMesh`, `createObject3D` and `createScene` join the second group; the classes
stay exported and the factories are the preferred spelling.

**Settled in 6.138: every resource factory is `create*`.** 6.130 claimed this was already the rule
and 6.131 corrected it, because `renderTarget`, `canvasTarget` and `cubeRenderTarget` were bare
nouns. They are `createRenderTarget`, `createCanvasTarget` and `createCubeRenderTarget` now, so the
split the plan described is real rather than aspirational: **a resource is `create*`, a node is a
bare noun.** Three files bound a local called `renderTarget` or `canvasTarget`, which is the same
shadowing that decided `createMaterial`.

`frame()` and `bundle()` are bare nouns outside the DSL too, and they earn it by being recording
contexts rather than resources. `frame` is also the one that proved the cost of the noun form: a
local of the same name shadowed the import in both README loops (6.116). 38 of the 60 files that
build a material bind a local called `material`, so `material()` would have repeated it at scale.

~~**Open, found while doing this**: `Uniform.value` is typed
`number[] | Float32Array | [16 numbers] | null` whatever the schema says.~~ **Done in 6.132.** Writes
keep the wide union; reads are `UniformStored<T>`, with `number[]` packed into the schema's own typed
array on assignment and typed arrays adopted by reference. `packToView` declares
`Infer<D> | TypedArrayFor<D>` rather than taking `as never`.

**The gates did not catch the regression it shipped**, and that is the lesson worth keeping: packing
a flat run of numbers is wrong for an *array of vectors*, which is already `Infer<T>`. Every gate in
this repo passed because nothing here declares an array-of-vectors uniform — the consumer found it.

6.133 fixed the reason rather than the case. `tst/uniform-pack-round-trip.test.ts` carries one case
per shape the schema language offers, asserting the equivalence `UniformValue`'s three input forms
promise: however a value is spelled, it packs to the same bytes. A shape with no case there is a
shape nothing checks, which is the state the whole file exists to prevent.

## Guess-on-miss is the defect this work keeps finding (6.137)

Six defects this session were one shape: a lookup with no entry returning a plausible default instead
of refusing. The geometry-swap brush bug, the stale bundle, the sky's NaN uniform block, the
overlay's whole-capacity upload, and both halves of the vertex stride. None raised an error; each
reached the GPU as wrong data.

The rule the code now follows on that path: **a table that cannot answer says so.** `deriveVertexFormat`
returning `undefined` is fine, because the caller turns it into a named error; what is not fine is
`return 16` or `return 4` standing in for an answer. The practical test before changing one is to
instrument rather than reason: every guess removed so far had zero hits across the suite and the pixel
harness, which is what made removing it safe.

A sweep of `src` for the remaining shapes — numeric `??`/`||` fallbacks, swallowed `catch`, bare
`return undefined` — found no others. `maxTextureSize ?? 2048` is the one that looks like a guess and
is not: 2048 is WebGL2's guaranteed floor, and a narrower mirror only makes the texture taller.

## Deliberately deferred

~~Whether `Mesh` should become a `Draw` (geometry plus material, no transform, no tree).~~
**Decided against, 6.138.** `Mesh` stays. The argument was always going to be made by the code rather
than by taste, and the code never made it.

Also deferred until something wants them: `pingPong`, the ordering check, the pre-warm second phase, the
completion handle plus delete queue.

## Resolved during design, recorded so it is not relitigated

Re-checked against the code each time one of these is touched. "Settled" is a claim about the
implementation, not just about the argument, and two of them had already drifted: the override-material
decision below was contradicted by code shipped while reading this section, and the note that
`renderer.compute()` must keep its own encoder outlived the hazard it was protecting against.

**Override materials are not needed.** three.js's `scene.overrideMaterial` replaces the vertex stage too,
so it breaks on skinning, instancing, morph targets and vertex displacement. three's own shadow map does
not use it; it derives a depth material per source material carrying `alphaTest`, displacement and
skinning across, with `Object3D.customDepthMaterial` as a further escape hatch. Unity, Unreal, Godot and
Filament all share the vertex stage and vary only the fragment stage. gpucat already expresses that,
better: two `Material`s over one shared vertex node, with `fragment` omitted for depth-only, which is
what `MaterialOptions.fragment` already documents. It cannot drift because it is the same node object.
lib already does this for mesh and outline pairs.

The machinery was in the code anyway: `overrideMaterial` on both renderers, in `RendererState` and
threaded through the render-list walk, with no users. **Deleted.** What survives is
`DrawOptions.material`, the per-submission form, which is not the same thing: the argument above is
against an ambient scene-wide switch, and its own alternative needs a submission to be able to pick
which of the two materials to draw with.

**`sideEffects: false` is declared.** Nothing in `src` mutates anything outside its own module: every
module-scope binding is a scratch buffer, a constant or a pure factory result. The one consequence to
know is that a bundler may now drop an unused module, and module-scope DSL constants draw ids from a
global counter, so the set of modules a consumer imports decides the emitted shader identifiers. Same
behaviour, different text; the golden snapshots run against `src` and are unaffected.

**This was declared but not checked until 6.120.** `tst/side-effect-free.test.ts` pairs the
declaration with the property it asserts: `src` has zero module-scope expression statements. The
existing `tst/tree-shake` gate proves a module *can* be dropped and says nothing about whether
dropping it is safe, which is the half that bites.

**No subpath entry points.** Considered for lazy backend loading and rejected: the consumer's own module
boundary is the right split point, and lib already has one. `package.json` has no `exports` map at all,
so this holds by construction rather than by discipline. Re-checked in 6.120, with the related fact
that makes the bare `main: dist/index.js` correct rather than a mismatch: `"type": "module"` is set,
so the dist bundle is read as the ESM it is without a `module` field to say so.

**No `surface(gpu, canvas)` or `target(gpu, opts)`.** Drafted from vgpu and rejected: `CanvasTarget` and
`RenderTarget` are already device-free, and threading a gpu into resource construction is the paradigm
this library exists not to have. The factories that did land take no gpu for exactly that reason; the
rejection was of the parameter, never of the call shape.

**A pass names one target, it does not assemble attachments.** Drafted from NoGraphicsAPI and rejected
on altitude: colour count, depth, stencil, samples and store behaviour belong on the resource, as they
do in three, and per-attachment blend already lives on the MRT node keyed by output name. See the MRT
section.

## Prior art

- **ogl.** `Renderer.render` is `getRenderList(...)` then `renderList.forEach(n => n.draw({camera}))`, and
  `Mesh.draw` is public. The renderer's walk is not privileged. That is the whole idea.
- **vgpu.** `frame(gpu, f => f.pass(target, effect))`. Geometry optional on a draw: "Omit for generated
  vertex-index drawing", default 3 vertices. Layouts are reflected from WGSL, never declared, with
  `claimGroup` as a six-line escape hatch. Uniform struct members are set by name.
  `await draw.compile(target)` is an optional pre-warm over a lazy default. `pingPong` is a parity bit
  and nothing else. `Surface` has `dpr` clamping, `autoResize` at the frame boundary and `onResize`.
- **luma.gl v9.** Cross-backend WebGPU and WebGL2 with an explicit `RenderPass`. Proof the shape ports.
  Also the warning: their docs say a raw `RenderPipeline` "requires a substantial amount of boilerplate",
  so most applications use `Model` instead. A low layer not good enough to be the default will wither.
- **NoGraphicsAPI.** No canvas target; you `acquire()` a swapchain `RenderView*` and it is a view like any
  other, and acquire can return nothing. Its attachments carry their own `load`/`store`/`clear`, which is
  right at its altitude and wrong at gpucat's: it is a thin Vulkan wrapper where attachments are the unit,
  while gpucat already abstracts a target as a set. Its deferred example's lighting pass
  is literally `draw(commands, root, 3)` with no geometry. Frames are flat. Camera is data in the per-draw
  root, not an API concept. Resize is the application's, checked against the acquired extent.
- **regl.** A command is a compiled recipe invoked with per-call props. No scene graph. A decade of
  evidence for recipe plus arguments.
- **three.js.** Three things to keep. The declarative resource model: nothing takes a device at
  construction and the renderer materializes device objects lazily. `RenderTarget` as a bundle that owns
  colour count, depth, stencil, samples and per-aspect resolve and store behaviour, with cube face and
  mip as bind-time arguments. And `mrt({ output, normal })` as a named dictionary carrying its own
  per-output blend and clear, present on both the renderer and the material and merged with the material
  winning. The thing not to keep is its ping-pong story: no helper, sixteen TSL nodes each rolling their
  own pair, swap and rebind.

## Not taken

- Typed `.wgsl` module imports (vgpu). Needs a bundler plugin per host, which fights the browser rolldown
  editor. The node DSL already gives typed composition with no build integration.
- Explicit bind group layouts. Both gpucat and vgpu generate them, from graph traversal and from WGSL
  reflection respectively. Declaring them by hand is the one thing this library exists not to make you do.
  vgpu's `claimGroup` middle ground is worth having eventually and costs nothing to leave out now.
- Bindless: GPU pointers replacing buffer objects, application-owned descriptor heaps, push-data roots
  (NoGraphicsAPI). Needs Vulkan 1.4 extensions and does not survive WebGL2.
- Depth and stencil as command state rather than pipeline state (NoGraphicsAPI). WebGPU bakes them into
  the pipeline. Stays on `Material`.
- Multiple command buffers per frame. One `queue.submit` per frame is enough; a frame may draw to
  several canvases (attachments are per `CanvasTarget`), and they still share one command buffer.
- Explicit pipeline binding separate from draw. The WebGL loop already tracks `currentProgram` and
  `currentVao` to skip redundant binds, and WebGPU caches the same.
- Automatic backend selection inside `init`, with software-adapter rejection and ordered fallback.

## Risks

1. ~~**WebGPU is validated by a stub, not by a device.**~~ **Closed, layers 5.4 and 5.5**, with one
   case still missing (below). `pnpm run
   test:webgpu` renders eleven cases on a real device through Dawn (`webgpu`, already a dependency of
   lib) and compares centre pixels: clear, a solid fullscreen draw, a uniform through the UBO path, a
   camera-transformed box through the scene walk, two targets on one frame and one submit, a scissor
   rect that must keep the draw out of the centre, a named MRT output on attachment 1, six cube faces
   through `PassDesc.layer` on one frame, a 4-sample resolve, the per-submission `DrawOptions.material`
   override, and a compute pass feeding a draw on the same frame.

   **Each case runs in its own process, and that is not paranoia.** Dawn in Node dies after roughly
   eight cases whatever their order, and a `setTimeout` between them makes it die on the first;
   `msaa` and `compute` both passed alone and aborted in a full run, which reads exactly like a real
   resolve or ordering bug and is not one. Each child also bundles for itself, because esbuild forks
   (which segfaults with Dawn loaded) and importing the bundle into a process that never ran esbuild
   segfaults too: bundle, then Dawn, then import, in one process.

   ~~**A `PassNode` case does not fit in that harness.**~~ **Diagnosed and fixed, layer 6.5.** It was
   not composition: Dawn segfaults once the module its process imports passes roughly 530 KB, proven
   by padding a working bundle with 20 KB of inert characters. The child minifies now (534 KB to
   254 KB) and `pass-node` runs on a real device, so the nested-pass ordering this design turns on is
   proven on both backends. Every case targets a `RenderTarget` and
   reads back with `read(gpu, target)`, because Node has no canvas, so the headless story is exercised
   for real rather than asserted.

   **Forty-nine cases as of layer 6.43, and porting from the WebGL harness is what pays** — though
   6.42 counted the seam: of the 44 cases still WebGL-only, 24 have no WebGPU counterpart and 6 are
   already covered by a ported sibling, leaving 14 that are worth porting at all; 6.43 took the three that mattered. 6.50 then found `cube-mips` had never tested a mip: flat faces make every level identical, so it was `cube-rtt` under another name until the faces became two-tone and the sample read the 1x1 level. 6.50 then found  had never tested a mip: flat faces make every level identical, so it was  under another name until the faces became two-tone and the sample read the 1x1 level. Four ported
   parity cases have found three real bugs (`info.memory.buffers` counting destroyed buffers, a
   double-registered dispose hook, and `PassDesc.clearDepth` ignored on every WebGPU render target);
   the rest, written from scratch or ported clean, found none. Ported anyway: a green parity case turns
   an assumption into a fact, and layout cases (`storage-mat4`, `storage-mixed-align`) are the ones
   where being wrong is silent — naga checks that WGSL parses, not that the packer's bytes land on the
   offsets the shader reads. `uniform-struct-align` (6.17) does the same for UBOs, using the
   `{ enabled: u32, tint: vec3f }` shape whose offsets once produced lib's black sky. A pattern is visible by 6.34, and 6.35 used it to pick a port that then found a bug
   (`cubemap`: `uploadCubeTextureData` had only an `isExternalImage` branch, so a cube built from raw
   typed arrays was created and never written; fixed in 6.37). That is now four real bugs from the
   target-kind ports against none from the shared-code ports. Layer 6.38 turned that one into a
   structural test instead of a single case: the three full-upload paths must handle the same source
   kinds, checked by parsing `textures.ts`, because the defect was a missing branch rather than a
   broken one and would recur in the next view dimension. The ports that find bugs touch a
   *path* only one backend had — a target kind, a lifecycle hook, a graph walk — while ports of shared
   encoder and packer code (`struct-texture`, `storage` layout, vertex layout) come back green. Layer 6.23
   finished the packed-decode family (`snorm8x4`, `half2x16`, `mat4`, `bits` beside the `unorm8x4`
   already there) and found nothing, which is the point: the packer and WGSL now provably agree on
   every packed field kind rather than on the one that had a case. Note also that a case is only
   parity if it covers the same *target kind*: WebGL's `clear-depth` renders to the canvas, which was
   the one WebGPU depth path that was already correct. Layer 6.24 ported that case's two siblings,
   `clear-selective` (the empty pass as a clear, read twice because a preserved colour and a skipped
   clear look identical) and `depth-load-read` (a `count: 0` depth-only target, the target kind the
   `clearDepth` bug lived in); both green first run. Layer 6.25 took `depth-bias` and `pass-occlude`, the family's last two,
   and both earned their keep: `depth-bias` was **vacuous on both backends** (`less-equal` on coplanar
   quads wins with or without a bias) and is now `less` at z 0.5, mutation-checked; `pass-occlude`
   found a real graph bug and is tracked in `KNOWN_FAILURES`.

   **The runner now has a tracked-failure set**, copied from the naga gate: a listed case may fail, and
   the runner fails if a listed case starts *passing*, so the set cannot rot. It holds `pass-occlude`
   and its 40-line reduction `chained-pass-nodes`, which keeps the repro executable rather than prose.

   **And the runner now surfaces Dawn's reason.** `popErrorScope().then(console.error)` was
   fire-and-forget, so a case that finished before the scope resolved lost the explanation;
   `WebGPUBackend.takeValidationErrors()` awaits them and `runCase` fails the case with the message,
   which names the pass. Four rounds of probing on `pass-occlude` were spent on that defect rather than
   on the bug, and a diagnosis written from the silence was wrong.

   The browser route is closed and not worth retrying: playwright's Chromium (151) and the installed
   Chrome (153) both report no `navigator.gpu` headlessly, under every combination of
   `--enable-unsafe-webgpu`, `--enable-features=WebGPU,Vulkan`, `--use-webgpu-adapter=swiftshader` and
   `--use-vulkan=swiftshader`. The stub stays: it runs in vitest with no device and enforces
   attachment agreement, which the pixel harness does not.
2. **Timing against the WebGL backend. Checked, and much lower than feared.** The tree is clean; the
   only untracked files are these two plans. The blend fix landed (`75c42a4 fix(renderer): share
   blend-state policy between backends so webgl honors transparent materials`). The last eight commits
   are the symmetry plan executing, and they close exactly the cells its table marked missing (webgl
   `buffers`, webgpu `samplers`, webgpu `render-target`), with the head commit moving shared
   draw-range and mip-count decisions into core. That is the same direction as this plan, so this is a
   continuation rather than a collision.

   **Audited in layer 6.3: discharged.** Steps 1-4 are done (both backends have `samplers.ts`,
   `render-target.ts`, `buffers.ts`, `bindings.ts`; zero cross-backend imports remain), its open
   question about `renderer-interface.ts` was answered the widening way by layer 4.41, and step 5's
   parity job now runs on both backends. It found a real bug on its first run: WebGPU's buffer
   `_onDispose` destroyed the GPU buffer without decrementing `bufferCount` or clearing the map, so
   `info.memory.buffers` counted dead buffers forever. Nothing in that doc is outstanding.
3. **luma.gl's warning applies here.** If `f.pass` plus explicit targets is annoying, lib accretes helpers
   and the low layer withers. lib is the only consumer with a real reason to want the low layer, so it
   cannot tell us whether the API is good in general.

## Open

1. ~~**Two things are called `pass`.**~~ **Resolved, layer 6.102.** The node is `renderTexture`, the
   class is `RenderTextureNode`, and `pass` now means exactly one thing: `f.pass(desc)`, a recording
   scope on a frame. `PLAN-pass-node-naming.md` has the reasoning.

   The deciding evidence was in the code rather than in taste: `pass` and `depthPass` constructed the
   **same class** with a different first argument, and that argument was read in exactly three places,
   all the same branch. They were one node behind two names, so they are one factory now with
   `read: 'color' | 'depth'` in the options, which is what the plan's own "shorthands only inside
   fields" rule asks for.

   This unblocked the rest: the collision had already forced `dispatchTransformFeedback` to an awkward
   name, was the recorded objection to a free `beginPass`, and ruled out the fully-free-function form.

2. ~~**An unmatched MRT output name warns and skips.**~~ **Fixed, layer 6.2.** It throws, naming the
   attachments the target does have. What parked this was "a semantics change for existing users",
   and that premise did not survive checking: `AGENTS.md` says there are no users yet and no
   compatibility to keep, and lib uses no MRT at all. A blocked item is worth re-testing against the
   reason it was blocked.
3. ~~**A PassNode drags its canonical texture node's uv into any consumer.**~~ **Fixed, layer 6.26.**
   `PassNode`'s colour, previous and depth nodes set `uvNode = screenUV` rather than inheriting
   `TextureNode`'s `varying(uv())` default, so no consuming mesh owes a `uv` it never declared. The two
   edges `getChildren` reaches a `PassNode` by — value (`renderOutput(scenePass)`) and ordering
   (`TextureBinding.passSource`) — wanted different children, and a parent-aware walker or a childless
   ordering node were both considered; correcting the default served both. A pass fills its whole
   target, so reading it by screen position is what it always meant. `pass-as-value`,
   `chained-pass-nodes`, `two-pass-nodes` and `pass-colour-and-depth` hold it.

4. ~~**The scene-hierarchy tab's input for treeless passes.**~~ **Built, layer 6.103**, as the leaf
   row `PLAN-hierarchy-treeless.md` recommends: the pass's label, its draw count, and a pointer to
   Draw Calls, which already lists those draws under the same label with bindings and layouts.

   The bug was worse than "shows nothing". `inspector.ts` gated the whole tab on
   `record.scenes.length > 0`, so a frame of only recorded draws left it **hidden entirely**, not
   merely empty. Both halves are fixed: the tab renders a leaf per treeless pass, and it is fed
   whenever either kind of pass ran.

   Draw counts come from grouping live RenderObjects by `lastPassLabel`, which is what `draw-calls.ts`
   already does, so the two tabs agree by construction rather than by a second count.

5. ~~**Storage-texture mip regeneration after compute.**~~ **Done.** `regenerateComputeMips` is split out
   of `dispatchCompute`; the frame backend collects written storage textures into `mipTextures` and flushes
   them in `submitFrame`, next to the render-target mips already deferred there.
6. ~~**Pre-warm phase two.**~~ **Settled by the consumer, layer 6.12: one call taking drawables.** lib
   awaits `prewarm()` once at the end of boot and calls `compile` once, wanting both phases; the
   two-call split has no consumer. Reading that path also found `WebGLRenderer.compile` to be an empty
   stub claiming "GL programs are cached by source, so there is nothing to warm", against lib's
   measured 220 ms first frame. Implemented; it moves the link onto load rather than overlapping with
   anything, which is all WebGL2 can do.
7. ~~**The completion handle.**~~ **Built as `frame.done`, layer 6.68.** `f.submit()` should eventually return something a delete queue can defer
   against, since destruction during an in-flight frame is a live hazard for room swaps. NoGraphicsAPI
   takes a `TimelinePoint` and ships a `DeleteQueue`; vgpu has `frame.done: Promise<void>`.

   **The hazard is confirmed and half of it is closed (layer 6.11).** Asked of a real device, disposing
   a target between its pass and the submit gives `Destroyed texture used in a submit`: Dawn drops the
   frame, nothing throws in JS, and the error arrives asynchronously with no route back to the pass.
   `submitFrame` now checks the targets the frame encoded into and throws naming the attachment, and
   opening a pass on a disposed target throws too. What a completion handle would still buy is
   destroying *without* abandoning the frame. **Designed in
   `PLAN-completion-handle.md` (layer 6.67) and built in 6.68**: `frame.done` is a resolve-only,
   lazily-memoised promise on the frame, with the delete queue still deferred because it is policy —
   when to drain, how deep, what a twice-queued resource does — and no consumer is asking yet. vgpu's changelog is the reason for resolve-only —
   they shipped it the other way and corrected it, because the errors that matter arrive from the
   device after any promise would have resolved.
8. ~~**Transform feedback**, WebGL-only, the mirror of compute being WebGPU-only.~~ **A pass, layer
   6.97.** `frame.transformFeedback()` gives `.dispatch(kernel, opts)` and `.end()`, throwing on
   WebGPU exactly as `frame.compute()` throws on WebGL2.

   6.14 placed it *outside* the frame on the grounds that WebGL2 has no encoder, so the kernel runs on
   call while the frame's passes encode at each `end()`, landing between them instead of before them.
   **That reasoning does not survive reading what `tf-ordering` asserts**: it calls the kernel while a
   render pass is open, which argues against an out-of-band method rather than against a pass. WebGL's
   `encodePass` does its GL draws at `end()` too, so a transform-feedback pass ending in sequence with
   the render passes lands in sequence with them. `assertCanOpen` then gives the mid-frame protection
   6.14 hand-rolled, for every pass kind.

   It is a capability gain rather than a rename: render, simulate, render could not be written in one
   frame while the kernel had to sit outside it. `tf-pass` in the WebGL harness holds that sequence,
   and `tf-ordering` still holds the out-of-band method's refusal, which remains correct for it.

   **The guards themselves are held now** (6.128). Eleven of `frame.ts`'s fifteen throws had a test;
   four did not, including `dispatch after end()` on both pass kinds and the parameterised
   `${verb} after the frame was closed`. An unchecked guard can be deleted without anything noticing,
   which is the same failure this plan keeps finding elsewhere.
9. ~~**`hasFeature(feature: GPUFeatureName)`.** A backend-specific type on a neutral `Renderer`.~~
   **Settled by construction, layer 4.41.** It is not on the `Renderer` contract, so it stays on each
   concrete class with that backend's own argument type, reachable through the generic `init`.
   **Reversed by layer 6.30 and restored in 6.48**: the `Renderer` rebuild put `hasFeature(string)` on
   `DeviceBackend` and forwarded it, widening away the `GPUFeatureName` union this decision exists to
   keep. Off the contract again, with the backend's own type. 6.96 made `backend` internal, which broke the
   "reach it at `gpu.backend.hasFeature`" answer. **Rebuilt in 6.99** as
   `hasFeature( renderer, feature )` in `webgpu/device-api.ts`, typed on `Renderer<WebGPUBackend>`:
   the `GPUFeatureName` union survives and asking a WebGL2 renderer is a compile error, with no
   backend type on the neutral surface.
10. ~~**`device` / `adapter` / `format`** escape hatches must survive somewhere; lib uses `device`.~~
   **Settled, layer 4.41.** `BackendFactory` is generic, so `init({ backend: webgpu() })` is
   `Promise<Renderer<WebGPUBackend>>` and all three are reachable with no cast. They are also named as
   a surface: `BackendState` (layer 5.2). **Answered by the rebuild, layers 6.27-6.32**
   (`PLAN-renderer-backend.md`): they are reached through `gpu.backend.device`. That design measured
   the duplication a fronting class would delete at 60 lines, and that measurement was answering the
   wrong question: `init` returning a concrete class makes `init` itself pointless, and a shared
   orchestration layer forces the alignment a convention cannot. Built in 6.28-6.32. **Rebuilt in 6.99
   for the same reason as 9**: `gpuDevice`, `gpuAdapter` and `canvasFormat` in `webgpu/device-api.ts`,
   `glContext` in `webgl/device-api.ts`. Same filename on both sides, so the symmetry guard pairs them
   rather than needing two justifications. The names are explicit because `device` and `format` are
   too generic for a package export. lib's two call sites are the only migration.
11. ~~**`isSoftwareAdapter(adapter): boolean`** as a pure helper.~~ **Left to consumers, layer 6.13,
   on measurement.** `forceFallbackAdapter: true` returns *no adapter* on Dawn/Metal, so the spec's own
   knob cannot be used as a probe; `isFallbackAdapter` is not exposed; what remains is
   `adapter.info`, which is vendor-shaped (`apple / metal-3 / apple-m1-pro`). On WebGL a SwiftShader
   context reports a masked `"WebKit WebGL"`, and the real string needs `WEBGL_debug_renderer_info`,
   gated or removed by browsers. A helper would be string-matching descriptions gpucat cannot validate
   against a software adapter it cannot reach.
12. ~~**Whether `init` should ever verify a device with a trial render.**~~ **No, layer 6.13.** It would
   only catch a driver that survives `requestDevice` and all of `init` and then fails the first draw,
   and the consumer already handles that shape: lib probes for a hint and then
   `try { createAndLoad('webgpu') } catch { createAndLoad('webgl') }`, the three.js try/catch this plan
   recommends. Costing every user a frame at init for the residue is a bad trade. The property that
   fallback rests on — `init` rejects rather than resolving something half-built — is now tested.

## From the review against three.js, vgpu and WebGPU itself

Read after the compute pass landed, so these are grounded in what those codebases do rather than what
they are said to do.

**One GPU compute pass per batch, not per dispatch. Done.** three's `Renderer.compute()` calls
`backend.beginCompute( computeNodes )` **once**, loops the nodes issuing `backend.compute(...)` into
that single pass, then `backend.finishCompute( computeNodes )`
(`common/Renderer.js:2920-2965`). `WebGPUBackend.beginCompute` opens one `beginComputePass` and
`compute()` skips `setPipeline` when the pipeline is unchanged (`WebGPUBackend.js:1855-1899`).

gpucat opened **one GPU compute pass per entry**, paying a begin/end per dispatch. The reason was real:
`timestampWrites` is a field on the *pass descriptor*, so per-node inspector timings are impossible
inside a shared pass. But every consumer paid that cost whether or not an inspector was attached, and
lib's radix sort is a dozen dispatches in a row.

`encodeDispatches` now shares one pass across the batch and skips `setPipeline` while it is unchanged,
splitting one pass per entry only when an inspector is attached. Pinned by three tests against
`computePasses` and `computeSetPipelines` counters in the stub.

**The frame encoder for compute is ahead of three, not catching up.** three still gives each compute
group its own encoder and submits it immediately in `finishCompute`. So the "cull then indirect-draw in
one submit" property this plan is built on does not exist upstream. Good to know the plan is not
re-treading a solved problem, and that there is no upstream implementation to copy.

**`depthReadOnly` is missing from `PassDesc`.** vgpu's `FramePassOptions` has it: open the pass with a
read-only depth attachment so depth can be both tested against and sampled as a texture in the same
pass, with the stencil aspect read-only too for combined formats. gpucat has no equivalent, so that
pattern currently needs two passes. Not scheduled, but it belongs in `PassDesc` rather than anywhere
else, and adding it later is additive.

**Errors are strings, not codes.** vgpu throws `VGPUError` with a stable `code` and a `where`
(`VGPU-FRAME-REENTRANT`, `VGPU-COMPUTE-PASS-ASYNC`). gpucat's frame errors are template strings, which
tests match with regexes. Fine for now; it stops being fine the moment a consumer wants to branch on a
failure rather than surface it.

**The callback form of `frame` stays rejected, with a better reason than before.** vgpu has both:
`frame( gpu, cb )` submits when `cb` returns and *cancels* when it throws, and `frame( gpu )` with no
callback is flat and yours to finish. The flat form was chosen here on taste. The callback's real
argument is not nesting, it is that cancel-on-throw is automatic, where gpucat needs `abandonFrame` in
a `catch` or a later `beginFrame` to recover. That recovery already exists and is tested, so this is
sugar, not a correctness gap. Noted so the option is not rediscovered as if it were one.
