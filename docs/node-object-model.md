# Node object model: pure-data nodes with factory functions

## Summary

Kill the `Node<T>` base class entirely. Replace subclasses with factory
functions. Keep the chaining API via a shared prototype object. Nodes are
pure data records — no compiler logic, no traits, no virtual methods.
All compilation behaviour lives in `compile.ts`'s `compilerDefs` map
(see `node-defs-plan.md`).

---

## Three-layer model (revised)

```
Layer 1 — nodeProto             shared prototype object carrying the chaining API
Layer 2 — factory functions     create plain objects + attach runtime state fields
```

No class hierarchy. No inheritance. No `extends` anywhere. No traits.
Compiler behaviour is declared entirely in `compile.ts` — see `node-defs-plan.md`.

---

## Core types

`Node<T>` is composed from two pieces, each with a single source of truth:

```ts
// 1. chaining<T> — a generic function whose return type IS the typed API.
//    No separate interface needed; TypeScript infers T-parameterised
//    signatures directly from this function definition.
function chaining<T extends WgslType>(self: Node<T>) {
    return {
        add:       (b: Node<T>):         Node<T>         => binopNode('+', self.type, self, b),
        sub:       (b: Node<T>):         Node<T>         => binopNode('-', self.type, self, b),
        div:       (b: Node<T>):         Node<T>         => binopNode('/', self.type, self, b),
        mul:       (b: Node<WgslType>):  Node<WgslType>  => binopNode('*', mulResultType(self.type, b.type), self, b),
        normalize: ():                   Node<T>         => callNode(self.type, 'normalize', [self]),
        abs:       ():                   Node<T>         => callNode(self.type, 'abs', [self]),
        length:    ():                   Node<'f32'>     => callNode('f32' as const, 'length', [self]),
        // … all math / comparison / toVar / assign / field / swizzles
        get x()   { return fieldNode(vecElementTypeOrSelf(self.type), self, 'x') },
        get xyz()  { return fieldNode(vec3TypeOf(self.type), self, 'xyz') },
        get rgb()  { return fieldNode(vec3TypeOf(self.type), self, 'xyz') },
        // …
    }
}

// 2. Chaining<T> — derived, not declared.
//    TypeScript resolves the generic; T flows through automatically.
type Chaining<T extends WgslType> = ReturnType<typeof chaining<T>>

// 3. Node<T> — identity fields + chaining API.
//    No method bodies, no duplication.
type Node<T extends WgslType> = {
    readonly id:     string
    readonly kind:   NodeKind
    readonly type:   T
    readonly traits: ReadonlyArray<NodeTrait>
} & Chaining<T>
```

`chaining<T>` is the **single source of truth** for both the implementation
and the type signatures. `Chaining<T>` is derived from it — no hand-written
interface, no `satisfies` check needed. Adding or changing a method means
editing exactly one place.

---

## `nodeProto` — the shared prototype

`chaining<T>` above is the **type-level** definition. At runtime, a single
shared `nodeProto` object carries the same methods via `this`, avoiding
per-instance allocation:

```ts
// nodes.ts — runtime implementation, shared across all node instances
const nodeProto = {
    add(this: Node<WgslType>, b: Node<WgslType>)    { return binopNode('+', this.type, this, b) },
    sub(this: Node<WgslType>, b: Node<WgslType>)    { return binopNode('-', this.type, this, b) },
    div(this: Node<WgslType>, b: Node<WgslType>)    { return binopNode('/', this.type, this, b) },
    mul(this: Node<WgslType>, b: Node<WgslType>)    { return binopNode('*', mulResultType(this.type, b.type), this, b) },
    normalize(this: Node<WgslType>)                 { return callNode(this.type, 'normalize', [this]) },
    abs(this: Node<WgslType>)                       { return callNode(this.type, 'abs', [this]) },
    length(this: Node<WgslType>)                    { return callNode('f32' as const, 'length', [this]) },
    // … rest of math / comparison / toVar / assign / field

    get x(this: Node<WgslType>)                     { return fieldNode(vecElementTypeOrSelf(this.type), this, 'x') },
    get xyz(this: Node<WgslType>)                   { return fieldNode(vec3TypeOf(this.type), this, 'xyz') },
    get rgb(this: Node<WgslType>)                   { return fieldNode(vec3TypeOf(this.type), this, 'xyz') },
    // … all swizzles
}
```

Factory functions spread `nodeProto` into each new node object:
`Object.assign({}, nodeProto, { id, kind, type, traits, ...ownFields })`.
Same prototype depth as a class — zero per-instance method allocation.

The relationship between the two:

| | `chaining<T>` | `nodeProto` |
|---|---|---|
| Purpose | Type-level source of truth | Runtime source of truth |
| Where used | `type Chaining<T> = ReturnType<typeof chaining<T>>` | `Object.assign({}, nodeProto, ...)` in every factory |
| Method style | Arrow functions closing over `self` | Regular functions using `this` |
| Allocation | Never called at runtime | Defined once, shared across all nodes |

---

## Node-specific types as intersection types

Where a node carries runtime state (CPU data, GPU resources), that state is
expressed as a type intersection rather than a subclass:

```ts
// UniformNode — carries CPU-side value for upload
type UniformNode<T extends WgslType> = Node<T> & {
    value:   number | number[] | Float32Array | null
    version: number
}

// StorageNode — carries GPU buffer data alongside the node identity
type StorageNode<T extends WgslType> = Node<T> & {
    data:            GpuTypedArray | null
    version:         number
    updateRanges:    UpdateRange[]
    _indirectOwner?: IndirectBuffer
    needsUpdate:     boolean   // setter
    addUpdateRange(start: number, count: number): void
    clearUpdateRanges(): void
    release(): void
}

// TextureNode — holds the GPU texture resource
type TextureNode = Node<TextureType> & {
    resource: GPUTexture | GPUTextureView | null
}

// SamplerNode — holds the GPU sampler resource
type SamplerNode = Node<SamplerType> & {
    resource: GPUSampler | null
}

// VarNode — mutable local variable; the compiler reads varName + init
type VarNode<T extends WgslType> = Node<T> & {
    readonly varName: string
    readonly init:    Node<T>
}
```

Pure expression/statement nodes (`BinopNode`, `AssignNode`, `IfNode`, etc.)
carry no extra runtime state and need no intersection — `Node<T>` with their
kind-specific fields stored as plain own properties is sufficient.

---

## Factory functions — three representative examples

Each factory constructs the object directly — no `makeNode` helper. The
chaining methods come in via `Object.assign({}, nodeProto, { ... })`, spreading
the prototype's methods onto the instance as own properties. This is the
simplest starting point; switching to `Object.create(nodeProto)` later for
memory efficiency is a one-line change per factory and does not affect
any callers.

### `uniformNode` — leaf resource node with runtime state

```ts
function uniformNode<T extends WgslType>(
    type:      T,
    uniformId: string,
    group:     'material' | 'frame' = 'material',
): UniformNode<T> {
    return Object.assign({}, nodeProto, {
        id:      computeId('uniform', { type, uniformId, group }),
        kind:    'uniform' as const,
        type,
        // compiler-relevant fields — read directly by compilerDefs['uniform']
        uniformId,
        group,
        // runtime state
        value:   null as number | number[] | Float32Array | null,
        version: 0,
    }) as UniformNode<T>
}
```

The object is fully self-contained. No base class, no `super()`, no
`makeNode`. The `nodeProto` spread brings in `.add()`, `.mul()`, `.x`, etc.
`uniformId` and `group` are plain own fields — the compiler reads them
directly via `compilerDefs['uniform'].setup` and `.generate`.

### `binopNode` — pure expression, no runtime state

```ts
function binopNode<T extends WgslType>(
    op:    BinopOp,
    type:  T,
    left:  Node<WgslType>,
    right: Node<WgslType>,
): Node<T> {
    return Object.assign({}, nodeProto, {
        id:     computeId('binop', { type, op, a: left.id, b: right.id }),
        kind:   'binop' as const,
        type,
        // node-specific fields — read by compilerDefs['binop'].generate
        op,
        left,
        right,
    }) as Node<T>
}
```

No runtime state, no resource. `compilerDefs['binop']` handles all
compilation behaviour — the node itself knows nothing about it.

### `storageNode` — heavy runtime state + compiler traits

```ts
function storageNode<T extends WgslType>(
    type:        T,
    storageType: string,
    data:        GpuTypedArray | null,
    access:      'read' | 'read_write' = 'read',
): StorageNode<T> {
    const node = Object.assign({}, nodeProto, {
        id:           nextId(),
        kind:         'storage' as const,
        type,
        // compiler-relevant fields — read by compilerDefs['storage']
        storageType,
        access,
        // runtime state
        data,
        version:      0,
        updateRanges: [] as UpdateRange[],

        addUpdateRange(start: number, count: number) {
            if (node.data === null) throw new Error('[gpucat] StorageNode released')
            node.updateRanges.push({ start, count })
        },
        clearUpdateRanges() { node.updateRanges.length = 0 },
        release()           { node.data = null },
    }) as StorageNode<T>

    Object.defineProperty(node, 'needsUpdate', {
        set(_: true) {
            if (node.data === null) throw new Error('[gpucat] StorageNode released')
            node.version++
        },
    })

    return node
}
```

The runtime methods (`addUpdateRange`, `clearUpdateRanges`, `release`) close
over `node` — same pattern as a class method closing over `this`, but
explicit. The `needsUpdate` setter stays as `defineProperty` because it is
write-only.

---

## Compilation behaviour

All compilation behaviour — setup handlers (binding registration), generate
handlers (WGSL emission), `isStatement`/`isLeaf` flags — lives entirely in
`compile.ts`'s `compilerDefs` map. See `node-defs-plan.md` for the full
design. Nodes have no awareness of compilation.

---

## The one migration: `instanceof Node`

There is exactly one `instanceof Node` in the codebase — `wrapScalar` in
`nodes.ts:1645`. It becomes:

```ts
// before
if (v instanceof Node) return v

// after
if (isNode(v)) return v

function isNode(v: unknown): v is Node<WgslType> {
    return v !== null && typeof v === 'object' && 'kind' in v && 'id' in v
}
```

No other `instanceof` checks exist. This is the complete migration cost.

---

## Advantages over keeping `class Node<T>`

| | `class Node<T>` | Object-based |
|---|---|---|
| Can future code write `extends Node`? | Yes — temptation exists | No — `Node` is a type alias, not a class |
| Subtype hierarchy for runtime state? | Implied by `extends` | Explicit intersection type |
| `instanceof` narrowing? | Works | Replaced by `isNode()` predicate |
| Prototype chain for chaining methods? | One level (`Node.prototype`) | One level (`nodeProto`) — identical |
| Per-instance memory for methods? | Zero (on prototype) | Zero (on prototype) — identical |
| Serialisable to JSON? | No (class instance) | Yes — plain object with no non-serialisable prototype methods |

The core advantage is **structural**: `Node<T>` as a type alias cannot be
extended. The architecture is enforced by the language, not by convention.

---

## What stays the same

- All chaining method signatures — identical to today, just defined on `nodeProto`
  instead of `class Node<T>`
- All 30 "node kinds" — same `NodeKind` union, same factory function per kind
- `collect.ts` — unchanged, switches on `node.kind`
- All 82 tests — untouched; they use the DSL surface which is identical

---

## Files touched

| File | Change |
|---|---|
| `src/nodes/nodes.ts` | replace `class Node<T>` with `type Node<T>` + `chaining<T>` + `nodeProto`; replace all subclasses with factory functions; replace `StorageNode`/`UniformNode`/etc. class declarations with intersection type aliases; remove all `extends`, `constructor`, `override` keywords; remove `setup()`/`generate()` overrides; remove `import type { WgslBuilder }` |
| `src/nodes/compile.ts` | add `compilerDefs` map; replace `isStatement`/`isLeafIdentifier` sets and `node.generate(this)` calls with `def.generate(node, this)`; replace `node.setup(this)` with `def.setup?.(node, this)` |

One new helper needed anywhere `instanceof Node` was used:

| File | Change |
|---|---|
| `src/nodes/nodes.ts` | add `export function isNode(v: unknown): v is Node<WgslType>` |
