# Two things called `pass`

Status: proposed, not started. Open item 1 in `PLAN-explicit-frame.md`, measured so it can be decided.

## The collision

`pass(contents, camera)` is a **node** that schedules itself and hands back a texture.
`frame.pass(desc)` is a **method** that opens a pass you place. No symbol clash, since one is a method
on an object, so this is reader confusion rather than a compile problem. Both appear in the same file
constantly:

```ts
const scenePass = pass(scene, camera);
const compositePass = gpuFrame.pass({ target: view });
```

## The measurement, which changes the question

The plan says the ambiguity is "in 46 files and a rename is a second sweep rather than a free one",
which suggests one cost. There are two, and they differ by 4x:

| | call sites | where |
|---|---|---|
| **node** `pass(scene, camera)` | **50** | 34 examples, 11 tst, 4 lib, **1 src** |
| **method** `frame.pass(desc)` | **203** | spread through src, both harnesses, every example |

So "rename `pass`" is not one decision. Renaming the **node** touches 50 sites, almost all of them
mechanical and most of them examples. Renaming the **method** touches 203 and changes the central verb
of the API this whole plan exists to introduce.

## What the name is worth keeping for

`pass(scene, camera)` is **three.js's TSL name**, verbatim: `src/nodes/display/PassNode.js:1085`, and
70 of three's own examples call it. gpucat's node DSL is TSL-shaped throughout, and a reader arriving
from three already knows what `pass(scene, camera)` returns. Its siblings are named off it —
`depthPass`, and gpucat's own `depthPass` matches.

`frame.pass(desc)` is the obvious verb for "open a pass on this frame", and is what vgpu calls the
same thing (`Frame.pass(target, body)`).

Both names are the right name for their own thing. That is why the collision is uncomfortable rather
than obviously wrong.

## Options

**A. Keep both.** Costs nothing, and the ambiguity stays: `scenePass` and `compositePass` next to each
other, one a node and one a pass. The mitigation is naming at the call site, which every existing use
already does.

**B. Rename the node.** 50 sites, one of them in `src`. Candidates:
- `renderTexture(scene, camera)` — says what you get back, which is the thing you use. Not three's
  name, and three's `rtt()` is a different concept, so nothing is borrowed wrongly.
- `scenePass(scene, camera)` — reads well at the call site, but is still `…Pass`, so the confusion it
  is meant to remove survives in the suffix.
- `renderPass(scene, camera)` — worse: it sounds more like `frame.pass` than `pass` does.

**C. Rename the method.** `frame.begin(desc)`, `frame.open(desc)`, `frame.target(desc)`. 203 sites, and
every one of them is in the plan's own examples and prose. `begin` pairs badly with `end()` on the
returned object rather than on the frame.

## Recommendation

**B, to `renderTexture`, or A.** Not C: it is four times the churn to rename the better-fitting name.

The case for **B/`renderTexture`** is that the node's value *is* its texture — every call site does
`.getTextureNode()` or passes it straight to `renderOutput`, so naming it after the output rather than
the mechanism describes what the reader actually does with it.

The case for **A** is that it is three's TSL name and this DSL is TSL-shaped, so breaking from it costs
recognition for everyone arriving from three, which is most people who will read this code.

**This is a judgement about audience, not about cost**, which is why the measurement does not settle
it: 50 mechanical sites is cheap either way. If gpucat's node DSL is "TSL, ported", keep `pass`. If it
is "our DSL, TSL-influenced", `renderTexture` is the better name and 50 sites is the price.

## If B is chosen

The rename is mechanical and guarded: `retired-names.test.ts` would take `pass` as a retired export
name only if the node factory is the one renamed, since the method is a property and the test matches
whole words in source text. Worth checking that the guard does not fire on `frame.pass` before relying
on it.
