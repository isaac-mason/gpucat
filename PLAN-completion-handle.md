# The completion handle

Status: **option B built in layer 6.68**; the delete queue (option C) is deferred, not rejected.
The remaining half of Open item 7 in `PLAN-explicit-frame.md`.

## What is already done

Layer 6.11 closed the half that needed no new API. Disposing a target between its pass and the submit
gives, on a real device, `Destroyed texture used in a submit`: Dawn drops the frame, nothing throws in
JS, and the error arrives asynchronously with no route back to the pass that named it. So `Frame`
keeps `targets: RenderTarget[]`, `endPass` pushes each render target it encoded into, and `submitFrame`
throws naming the attachment if one has been disposed since. Opening a pass on an already-disposed
target throws too. `dispose-in-flight` in the WebGPU harness holds both.

That makes the hazard **loud**. It does not make it **avoidable**: the only way to dispose safely is
still to not have a frame open, which a room swap cannot always promise.

## What is missing

A consumer wants to destroy a resource *while* a frame that used it is still in flight, and have the
destruction happen once the GPU is finished with it. Today that is either a throw or a crash.

## Prior art, read rather than recalled

**vgpu** puts `done: Promise<void>` on the frame as a property, keeps `submit(): void`, and adds
`cancel(): void`. Two things in its changelog are worth more than the shape:

- *"`Frame.done` is resolve-only. `try/catch` around `await frame.done` is dead code; keep it for
  readbacks, benchmarks, completion pacing outside RAF loops, and deterministic tests."*
- *"`gpu.settled()` and `frame.done` remain resolve-only completion signals, not success checks."*
  Asynchronous execution errors go to a separate `gpu.onError`.

They separated **completion** from **success**, and the changeset says they arrived there by changing
it. A handle that rejects invites `await frame.done` to be read as "it worked", which it cannot mean:
the errors that matter arrive from the device after the promise would already have resolved.

**NoGraphicsAPI** takes a `TimelinePoint` and ships a `DeleteQueue`, which is the other half of the
same idea: the handle is not for awaiting, it is for *attaching destruction to*.

## The options

### A. `submit()` returns a promise

`submit(): Promise<void>`. Smallest diff, and wrong in two ways. It changes a call every consumer
makes, for a value almost none of them want, and an un-awaited promise is a floating one — which is
exactly the pattern lint rules exist to flag, on the hottest line in the API.

### B. `frame.done: Promise<void>`, resolve-only

vgpu's shape. `submit()` stays `void`, and the promise is there for whoever wants it. Costs nothing at
the call site and nothing at runtime if the property is lazy: `queue.onSubmittedWorkDone()` is only
called when something reads `done`.

Resolve-only, explicitly, with the reason written where it will be read. Errors keep going where they
already go — `onDeviceLost`, and the validation scopes from 6.25 and 6.35.

WebGL2 has no equivalent signal. `gl.fenceSync` plus a non-blocking poll is what
`readBufferAsync` already does, so the primitive exists; whether `done` on WebGL2 resolves on the fence
or on the next macrotask is the one real design question in this option.

### C. A delete queue, and no promise at all

`gpu.destroyAfterFrame(resource)`, or a `DeleteQueue` the renderer drains once a frame's work is
known complete. This is what the *use case* actually wants: nobody wants to await a frame, they want
their texture to go away safely. It hides the timeline entirely.

It is also the largest: it needs a queue, a drain point, and a decision about what happens to a
resource queued while two frames are in flight.

### D. B and C, with C built on B

`done` is the primitive; the delete queue is a small consumer of it. This is how the two pieces of
prior art relate, and it means the queue can land later without changing `done`.

## Recommendation

**B now, shaped so C can be built on it later, which is D.**

`done` is small, matches the one codebase that has already iterated on this exact API, and is testable
without a consumer. The delete queue is the thing a room swap actually wants, but it is a policy —
when to drain, how many frames deep, what to do about a resource queued twice — and policies are worth
deferring until something real is asking.

**Resolve-only is the part not to compromise on**, because it is the part vgpu had to correct. The
name `done` helps; `frame.completed` or `frame.finished` would help more if `done` reads as success to
anyone.

## What was proven

All three, in layer 6.68. `done` resolving after the GPU work is a case on both backends: green drawn
over a red clear, `await frame.done`, then read — a wait that resolves early reads red. WebGL's fence
signals in about 26 ms, which is the number that says it is really waiting. Memoisation, laziness and
the per-frame reset are unit tests, since none of them needs a device.

## What would need proving

- `done` resolves after the GPU work, not after the submit call: a case that writes a target, awaits
  `done`, and reads back without an explicit `read()` round-trip.
- Reading `done` twice returns the same promise, and never reading it costs nothing — the WebGPU
  harness can assert the second by counting `onSubmittedWorkDone` calls.
- On WebGL2, whatever `done` means there is written down and tested, rather than resolving immediately
  and being quietly useless.
