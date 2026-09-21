# Naming the pass node

Status: **decided and built, layer 6.102** — one factory, `renderTexture`, class `RenderTextureNode`. The open `pass` collision in `PLAN-explicit-frame.md` is the reason
this exists; resolving it unblocks naming everywhere else, because three separate decisions have
already bent around it.

## The collision

`pass` means two things.

```ts
const scenePass = pass(scene, camera)              // a node: schedules a render, yields samplers
const compositePass = frame.pass({ target: view }) // a method: opens a recording scope
```

No symbol clash, since one is a module export and one is a method, so this is reader confusion rather
than a compile problem. It has cost real decisions three times: it forced `dispatchTransformFeedback`
to an awkward name in 6.96, it is the plan's recorded objection to a free `beginPass`, and it rules
out the fully-free-function form where `pass(f, desc)` would be a third meaning.

Measured: the node has **37 call sites in examples** plus 4 `depthPass`; the method has 203. Renaming
the node is the cheap direction and always was.

## What the node actually is

Not a frame-graph task. Granite, Frostbite, Babylon and Bevy all name a *scheduling* unit — `Pass`,
`Subpass`, `FrameGraphTask`, `RenderNode` — and gpucat has no such layer. This is a node in the
**material** graph whose value is a texture and whose side effect is scheduling a render.

Boringly: *a render of some contents, from a camera, into an offscreen target, executed before the
frame that samples it, exposed as a node.*

It yields more than a colour texture: `getTextureNode`, `getDepthTextureNode`, `getPreviousTextureNode`
(ping-pong), `getViewZNode`, `getLinearDepthNode`, plus MRT and its own sizing (`setSize`,
`setPixelRatio`, `setResolutionScale`). In practice the tail is thin — **57 `getTextureNode` against
10 `getDepthTextureNode`**, and zero uses of viewZ, linear depth or previous outside `src`.

## The two forms

### A. Two factories: `renderTexture` / `renderDepth`

```ts
const scene = renderTexture(contents, camera)
const depth = renderDepth(contents, camera)
```

### B. One factory with a field: `renderTexture(contents, camera, { read: 'depth' })`

```ts
const scene = renderTexture(contents, camera)
const depth = renderTexture(contents, camera, { read: 'depth' })
```

## What the code says

`pass` and `depthPass` construct **the same class** with a different first argument:

```ts
export const pass      = (contents, camera, options?) => new PassNode('fragment', contents, camera, options);
export const depthPass = (contents, camera, options?) => new PassNode('depth',    contents, camera, options);
```

`scope` is stored once and read in exactly three places, all of them the same branch:

```ts
node.scope === 'fragment' ? node.getTextureNode() : node.getLinearDepthNode()
```

So the two names differ only in **which aspect the node reads when used as a value**. Everything else
— the render it schedules, the target it owns, the other accessors — is identical. `depthPass(...)`
and `pass(...).getLinearDepthNode()` produce the same thing.

## The argument

**For B, one factory.** The plan's own rule is "One call signature per function. No overloads.
Shorthands only inside fields." Two exported factories for one class, distinguished by a string, is
exactly the shorthand that rule exists to question. `scope` is already a field on the node; `read` in
the options makes the public surface match the shape underneath rather than papering two names over
it. It also scales: if a third aspect ever wants a default (`viewZ`), B takes a value and A takes
another export.

**For A, two factories.** `renderDepth(scene, camera)` is one identifier and reads at a glance;
`renderTexture(scene, camera, { read: 'depth' })` is a name that says "texture" while asking for depth,
which is mildly self-contradictory. Discoverability is better — autocomplete on `render` shows both.
And the 10 depth call sites get shorter rather than longer.

**Against A specifically:** the pairing only works because `renderDepth` exists as a sibling name. The
form I first proposed, `renderTexture` with `depthRenderTexture`, is worse than what we have.

## Decision

**B, one factory** (Isaac, layer 6.102), on the grounds that these are one node and the code says so in three places. The
self-contradiction in `renderTexture(..., { read: 'depth' })` is real but small, and it is the honest
kind: you are asking a render-to-texture node which texture to hand back.

If that reads badly enough in practice, A is a safe fallback and costs 4 call sites to switch to.

**Not recommended either way:** keeping `pass` for the node. Whatever is chosen, the bare `pass`
identifier should stop existing, because it is the thing blocking the rest.

## Cost

37 node sites plus 4 `depthPass`, all in examples and docs, plus the two factory declarations and the
`scope` field name. `src` reads `scope` in three places; under B the field and the option should share
a name so there is one word for one concept.
