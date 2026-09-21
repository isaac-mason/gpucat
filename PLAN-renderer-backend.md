# Renderer and backend

Status: **done** (layers 6.28-6.31). Open: whether the backends become State + free functions rather than classes.

## The ask

`init({ backend: webgpu() })` returns `WebGPURenderer`, a concrete class. `Renderer` is a TypeScript
interface, so there is no object you can point at and call *the renderer*. The expectation was
three.js's shape: one concrete `Renderer` fronting pluggable backends, which would also "bring the
renderer internals into check".

## What is actually duplicated

Measured against the code, not estimated.

| | gpucat | three.js |
|---|---|---|
| shared orchestration | `src/renderer/core/*`, **4870 lines** of neutral State + functions both call | `Renderer.js`, 3994 lines of methods |
| backend-specific | `webgl/renderer.ts` 534 + `webgpu/renderer.ts` 452 | `WebGLBackend` 2954 + `WebGPUBackend` 3281 + `Backend` ABC 841 |

The split is the same and gpucat shares more. The difference is packaging: modules rather than a class.

Method by method, across the two 500-line classes:

- **Identical**, pure duplication: `setInspector` (5 lines), `frame()` (7 lines, differing only in the
  backend-state factory and the error prefix). **~12 lines.**
- **Same skeleton, different middle**: `compile()` (guard, empty check, `resolvePassContext`,
  per-drawable loop, `yieldToMain` — WebGPU compiles pipelines in parallel, WebGL links serially) and
  `_beginInfoFrame()` (the buffers/geometries/textures/samplers half is written twice with different
  field paths, then each adds its own). **~50 lines of shape.**
- **Genuinely different**: `init`, `dispose`, `readPixels`, `hasFeature`, `compileCompute`.
- **Backend-only, no counterpart**: WebGL's `renderProbe`, `clearProbe`, `transformFeedback`,
  `getTransformFeedbackGlBuffer`, `readBufferAsync`; WebGPU's `getContext`, `compute`,
  `takeValidationErrors`.

So the duplication a fronting class would delete is roughly **60 lines**, not 1000. The rest of those
two files is device lifecycle that has nothing to share.

## "Backend" already means three things

This is the first thing to fix whichever option wins.

1. `Backend<R, DeviceTarget>` in `core/init.ts` — the **init factory**. `webgl()` / `webgpu()` return one.
2. `BackendState` in `webgpu/backend-state.ts` — WebGPU's **device handles plus caches**, as one
   argument. **WebGL has no counterpart**; its equivalent lives as fields on the renderer.
3. `FrameBackend` in `core/frame.ts` — the **six-method vtable** `Frame` dispatches through. Both
   backends implement it; it is the only polymorphic seam in the codebase today.

Adding a fourth meaning would be the worst outcome available.

## Option A — leave it

The interface stays, the two classes stay. Costs nothing, fixes nothing. The recurring price is the
cross-backend symmetry audits: pairing `samplers.ts` / `render-target.ts` / `buffers.ts` by hand and
checking a table of which cells exist on which side. That table is what a backend contract would be.

## Option B — one concrete `Renderer`, generic over its backend

```ts
class Renderer<B extends DeviceBackend = DeviceBackend> {
    readonly backend: B;
    frame(): Frame;
    compile(drawables, target, camera): Promise<void>;
    readPixels(target, attachment?, layer?): Promise<Uint8Array>;
    dispose(): void;
    readonly info: RendererInfo;
}

init({ backend: webgpu() })  // Renderer<WebGPUBackend>
gpu.backend.device           // GPUDevice, no cast
gpu.backend.gl               // does not typecheck here, which is the point
```

`FrameBackend` widens from six methods to the whole device surface and is renamed `DeviceBackend`;
`BackendState` becomes `WebGPUBackend`'s own fields; `Backend<R, T>` in `init.ts` is renamed
`BackendFactory` so the word means one thing.

**What it buys.** One place for orchestration. A *named, compile-checked contract* for what a backend
must provide — three's `Backend` ABC is ~80 methods and that list is exactly the checklist the
symmetry plan was maintaining by hand. A third backend becomes tractable rather than a third
500-line class.

**What it costs.**
- `gpu.device` becomes `gpu.backend.device`. lib touches escape hatches in **two places**
  (`render/webgl.ts` reads `.gl`, `render/webgpu.ts` reads `.device`), so this churn is cheap.
- The `Renderer` interface currently puts `info` on the contract **on purpose**, so a backend that
  does not feed it is a compile error rather than a silently empty debug panel. A concrete class with
  optional backend hooks loses that unless `DeviceBackend` keeps it required.
- Tree-shaking. `test:shake` proves a one-backend bundle drops the other. One concrete `Renderer`
  referencing both would break that unless it only ever reaches a backend through the factory the
  caller imported. **Held, and now pinned at the source**: `Renderer` imports no backend, and layer
  6.32 checks every `core/*` file's specifiers rather than waiting for a rollup build to notice.
- The backend-only methods have nowhere neutral to go. `transformFeedback` and `renderProbe` are
  WebGL's alone; `compute` and `takeValidationErrors` are WebGPU's. They stay on the concrete
  backends and are reached through `gpu.backend`, which is honest but means `Renderer` is not the
  whole API.

**Size**: it touches both renderer classes, `FrameBackend`, every `frameBackend()` caller, both
`prepare.ts` files, the inspector, and every `renderer.device` in tst and examples. Days, not hours.

## Option C — extract the shared skeletons, keep two classes

Move the ~60 duplicated lines into `core/`: `setInspector` and the `frame()` body become neutral
functions, `_beginInfoFrame`'s shared half becomes `readCommonMemoryStats(caches, info)`, and
`compile()`'s shell becomes `compileDrawables(r, drawables, target, camera, prepareOne)` with the
backend passing its own per-object step. Hours, no API change, no tree-shake risk.

It does not produce an object you can hold, and it does not produce a contract. It deletes the
duplication and nothing else.

## Decided: B

The recommendation below was **C**, and it was reasoning from the wrong measurement. Two arguments
settle it the other way, and neither is about line count.

**`init` has no purpose otherwise.** If `init({ backend: webgpu() })` returns `WebGPURenderer`, it is
`new WebGPURenderer(opts).init()` with extra ceremony, and the plainer spelling would be better. `init`
earns its existence exactly when it returns something the concrete classes are not. The fronting
object is the reason the entry point exists, so choosing C would mean deleting `init` to stay honest.

**A shared orchestration layer forces alignment; a convention does not.** The two classes have drifted
structurally before — that is what the cross-backend symmetry plan was for, and what
`WebGLRenderer.compile` being an empty stub against lib's measured 220 ms first frame looked like from
the inside. A contract turns that audit into a compile error.

The duplication measurement below stands and is still worth knowing: B is not being chosen to delete
60 lines. It is being chosen so there is one place the orchestration lives and one written-down
definition of what a backend owes.

## The recommendation this replaced

**C now; B only if a third backend is real.** B's main prize is the backend contract, and a contract
earns its keep when something has to satisfy it that does not exist yet. Against two backends whose
measured overlap is 60 lines, B spends days to delete what C deletes in hours, and puts the
tree-shake gate at risk to do it.

If the goal is instead *conceptual* — one name, one object, a place where "what a backend is" is
written down — then B is the honest way to get it and C will never provide it. That is a legitimate
reason to choose B, and it should be chosen for that reason rather than for the duplication.

## The two questions that decide it

1. **Is a third backend real?** If yes, B, now, before a third 500-line class exists.
2. **Should `Renderer` be the whole API, or a common floor?** B makes `gpu.backend.x` the route to
   everything backend-specific, and there is a lot of it. If `Renderer` being incomplete is
   unacceptable, neither option delivers, and the answer is a wider neutral contract instead.

---

# Part 2 — designing the split

Part 1 decided *that* there is a fronting `Renderer`. This part decides *how*, because the first
attempt went straight to editing and flip-flopped on state ownership halfway through. Every number
below is read off the code.

## What has to move

**Neutral, belongs to `Renderer`** (11): `_initialized`, `_isDeviceLost`, `inspector`, `onDeviceLost`,
`_renderContexts`, `_computeContext`, `_nodes`, `_renderObjects`, `_renderLists`, `_frameState`, `info`.

**Device, belongs to the backend.** WebGPU: `device`, `adapter`, `format`, eight caches,
`canvasContexts`, `swapchain`, `_currentEncoder`, `_pendingValidation`, `_validationErrors`, `_opts`,
`_deviceProvided`. WebGL: `gl`, `target`, nine caches, `_probe`, `_transformFeedback`,
`_maxTextureSize`, the two context-loss listeners, `_width`/`_height`, `_opts`.

The split is clean — no field is ambiguous. The cost is not in the fields, it is in the **reads**.

## Where the reads are

Only five sites outside the two class files name a concrete renderer: both `frame-backend.ts` files
(state type plus factory) and `webgpu/read-pixels.ts`. Everything else already takes `BackendState`
or explicit arguments. But inside the frame backends the two kinds of read are interleaved:

| | neutral reads | device reads |
|---|---|---|
| `webgpu/frame-backend.ts` | 24 (`r.inspector` 11, `r._nodes` 7, `r.info` 5, …) | 19 (`r.device` 7, `r._currentEncoder` 6, caches 6) |
| `webgl/frame-backend.ts` | 17 (`r.inspector` 7, `r._nodes` 6, `r.info` 3, …) | 19 (`r.gl` 6, caches 13) |

Two of those matter beyond their count. `usable(s)` guards on `r._isDeviceLost` **and** `r.gl`/device
in one expression, so the hot path reads both objects. And `r._beginInfoFrame()` is the frame backend
calling back into the renderer's frame boundary, which is an orchestration call, not a device one.

## Question 1 — how do backend internals reach neutral state?

**S1. The backend aliases it.** `init(renderer)` assigns `this._nodes = renderer._nodes` and so on.
Zero churn: every `r.` read keeps resolving. **Rejected, and now unreachable**: layer 6.32's
`renderer-backend-boundary` test fails on a backend declaring any of the eleven names the renderer
owns, so this cannot creep back in.** The backend still satisfies `RendererState`
and still looks like a renderer, so nothing is forced into alignment — which is the reason Part 1
chose a fronting class at all. It buys the API shape and none of the discipline.

**S2. The backend holds `renderer`; reads split at the call site.** `s.r` becomes `s.renderer` and
`s.backend`; ~41 edits in WebGPU, ~36 in WebGL, all mechanical and all inside two files. The backend
cannot masquerade as a renderer because it no longer has the fields. **Recommended.**

**S3. Free functions take both.** `encodePass(renderer, backend, desc, …)`. Most explicit, and it
makes the dependency visible in every signature rather than in a struct. Costs the same edits plus a
parameter on every internal. Worth it only if the state struct turns out to be the thing that drifts,
which there is no evidence for.

**S4. A per-pass context object.** Build `{ renderer, backend, ctx, params }` once per pass and thread
that. Tempting, but it is S2 with an allocation per pass, and the encode path is hot.

## Question 2 — one interface or two?

**F1. `DeviceBackend extends FrameBackend`.** `createFrame(backend)` then takes the backend directly.
One name for "what a backend is". **Recommended** — `FrameBackend` already exists as the only
polymorphic seam and already carries `name` and `deviceCanvasTarget`; extending it means the frame
path is unchanged and nothing is renamed.

**F2. Composition — `backend.frameBackend(): FrameBackend`.** Keeps frame encoding separable, which
would matter if something other than a device could encode frames. Nothing can. Extra indirection for
a generality with no consumer.

## Question 3 — the methods only one backend has

**Corrected after implementation (layer 6.30).** M1 below says backend-only work stays on the backend,
and `frame.compute()` already contradicted it before this refactor began: it is on the neutral `Frame`
and throws for WebGL at run time. There are three tiers, not two, and the rule that actually holds is
**in-frame work is neutral; out-of-frame device batches belong to the backend**. `backend.compute()`
and `backend.transformFeedback()` are the same shape as each other — a device batch that refuses while
a frame is open — so M1 is right for them and wrong as a general statement.


WebGL: `renderProbe`, `clearProbe`, `transformFeedback`, `getTransformFeedbackGlBuffer`,
`readBufferAsync`. WebGPU: `getContext`, `compute`, `takeValidationErrors`.

**M1. They stay on the concrete backend**, reached as `gpu.backend.transformFeedback(...)`, typed
because `Renderer<B>` keeps `B`. **Recommended.** It is honest: `Renderer` is the common floor, not
the whole API, and the type system says which backend you are holding.

**M2. Promote them to `Renderer` and throw on the wrong backend.** Turns a compile error into a
runtime one. The plan already rejected this shape for `hasFeature` in layer 4.41.

**M3. Promote only what both can answer.** That is the empty set here.

## Question 4 — construction order

`Buffers.createBufferCache(info)` **stores** the `RendererInfo` for push-style upload accounting, so
the caches cannot be built before the object that owns `info`. Today the renderer is both, so the
constructor works. After the split it does not.

**C1. Caches move into `backend.init(renderer)`.** They need a device anyway, so this is where they
belonged. Fields go from `readonly` to assigned-once. **Recommended.**

**C2. `Renderer` constructs the backend.** The factory would hand over options rather than an object,
which means `init({ backend: webgpu({ device }) })` no longer returns a thing that exists before
`init`. Loses the `BackendFactory` shape settled in 6.21.

**C3. Drop `info` from the cache and report pull-style.** A real simplification, but it changes upload
accounting, which is a separate change with its own risk. Not bundled here.

## Question 5 — the inspector

`InspectableRenderer = WebGPURenderer | WebGLRenderer` and the tabs read `renderer.device`,
`renderer.gl`, `renderer.bindings`, `renderer.buffers`, `renderer.pipelines`, `renderer.renderObjectGpu`,
`renderer.renderProbe`, `renderer.clearProbe`, `renderer.getContext` alongside neutral `info`,
`_renderObjects`, `_initialized`, `frame`. So it is the one consumer that genuinely needs both halves.

It becomes `Renderer<DeviceBackend>`, narrowing on `renderer.api` where it needs a backend's own
surface, and reaching it through `renderer.backend`. This is the largest single piece of churn in the
refactor and the one most likely to want its own pass.

## Question 6 — what `backend` means on the public object

`Renderer.backend` is the **object**; the string discriminant becomes `renderer.api`. The old
`renderer.backend === 'webgpu'` must not silently keep compiling against the object, so `api` is a new
name rather than a reuse. `Backend<R, DeviceTarget>` in `init.ts` renames to `BackendFactory` so the
word means one thing in each position: factory, object, contract.

## Migration order

Each step ends green; nothing is half-converted across a gate.

1. ~~`core/device-backend.ts` and `core/renderer.ts` land unused, plus `compileTargets` in
   `renderer-ops.ts`. Additive.~~ **Done, layer 6.28.** `Renderer.inspector` is a plain field until
   step 6, because attaching needs the inspector to accept a `Renderer`.
2. ~~`webgpu/frame-backend.ts`: `r` splits into `renderer` and `backend`, still typed as the existing
   class.~~ **Done for both backends, layer 6.29.** Behaviour-free by construction: both fields hold
   the same object until step 3. Deleting `r` rather than keeping it made every misclassification a
   compile error, which immediately caught `setNodeFrame`'s `frame.renderer = s.r` — the helper read
   the design flagged as the thing a grep cannot see.
3. ~~`WebGPURenderer` becomes `WebGPUBackend`~~ **Done, 6.30**: neutral fields deleted, caches move into
   `init(renderer)`, contract methods added, `frame`/`compile`/`_beginInfoFrame`/`dispose` orchestration
   removed.
4. ~~The same for WebGL.~~ **Done, 6.30.**
5. ~~`init.ts` returns `Renderer<B>`; `Backend` renames to `BackendFactory`.~~ **Done, 6.30 and 6.31.**
6. ~~Inspector.~~ **Done, 6.30.** `InspectableRenderer` is `Renderer<WebGPUBackend> | Renderer<WebGLBackend>`,
   which only discriminates because `Renderer.api` is typed `B['name']` rather than `RendererBackend`.
7. ~~`index.ts`, tests, examples, lib.~~ **Done, 6.30 and 6.31.** `webgl/renderer.ts` is `webgl-backend.ts`,
   and `WebGLContextOptions` names what `webgl()` takes.

**The risk to watch is step 2 landing green but step 3 revealing a read I classified wrong.** The
table above is a grep, not a proof; anything reading through a helper will only show up at step 3.

### Correction after step 2: steps 3-5 are one change, not three

The order above assumed every step could end green. It cannot. The moment a backend loses `frame()`,
`compile()` and `_beginInfoFrame()`, `init` has to already return a `Renderer`, and `init` returns one
type for both backends — so converting one backend forces the other and forces `init` with it. The
only ways to split it are a union return type or leaving delegating stubs on the old classes, and both
are the compatibility shims this codebase does not keep.

So the real order is **1, 2, [3+4+5], 6, 7**, with the middle step atomic and the tree red inside it.
The step-2 trick that made it safe — both fields holding the same object, so the split is behaviour-free
— is what keeps that middle step a type change rather than a rewrite of the encode path.
