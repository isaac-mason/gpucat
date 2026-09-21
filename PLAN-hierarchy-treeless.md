# The scene-hierarchy tab and passes with no tree

Status: **built, layer 6.103** — option B. Was open item 4 in `PLAN-explicit-frame.md`.

## Where the tab's input comes from

`drawScene()` calls `inspector.beginRenderScene(passId, scene, samples, colorFormat, frameId)`
(`src/scene/draw-scene.ts:21`), which pushes a `SceneRecord { passId, scene, samples, colorFormat }`.
The tab walks `record.scene` as an `Object3D` tree.

**That is the only producer.** A pass whose draws are recorded directly —

```ts
const p = frame.pass({ target });
p.draw(mesh);
p.end();
```

— never goes through `drawScene`, so it produces no `SceneRecord` and the tab does not know the pass
exists. Same for `pass(contents, camera)` when `contents` is a callback rather than an `Object3D`;
`PassContents` is `Object3D | ((pass: Pass) => void)` and only the first branch reaches the tab.

This is not a gap that appeared with the frame API. It is the frame API making a second way to draw
first-class, and the tab only ever knew the first.

## The thing that makes this easy

**The flat draw list already has a tab.** `draw-calls.ts` groups render objects under their pass via
`ro.lastPassLabel`, with bindings and bind group layouts per object. Every draw in a treeless pass is
already listed there, under the right pass, today.

So "show the recorded draw list flat in the hierarchy tab" is not filling a hole — it is a second copy
of a tab that exists, in a tab whose whole purpose is the thing these passes do not have.

## Options

**A. Show nothing.** What happens today. A treeless pass is invisible in this tab, and a reader who
knows the pass ran may reasonably wonder whether the tab is broken.

**B. Show the pass as a leaf, with no children and a reason.** One row per treeless pass: its label,
its draw count, and a line saying its draws are in **Draw Calls** because it has no tree. The tab stays
about hierarchy, the pass stops being invisible, and the reader is pointed at where the answer is.

**C. Show the draw list flat under the pass.** Duplicates `draw-calls.ts`, and the duplicate is worse:
no bindings, no layouts, and it drifts the moment either tab changes.

## Decision

**B**, built in 6.103. It costs one row and a sentence, and it fixes the actual failure of A — not that the information
is missing, but that the tab silently implies the pass did not happen.

The draw count is the part worth including: it is what tells a reader the pass did work, and it is
already on hand — the frame's records are `pass.count` at `end()`, and the inspector's own
`beginRender`/`finishRender` bracket each pass.

## What would need proving

- A frame with one `drawScene` pass and one recorded pass shows both, one with a tree and one without.
- The leaf row's draw count matches what **Draw Calls** lists under the same pass label, since two tabs
  disagreeing about the same pass is worse than one tab saying nothing.
