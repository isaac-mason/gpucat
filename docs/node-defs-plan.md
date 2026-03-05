# Node architecture: pure-data nodes + compiler-owned defs

## Design in one sentence

Nodes are **pure data records** — no compiler logic, no traits, no virtual
methods. `compile.ts` owns a `compilerDefs` map keyed by `NodeKind` that
declares all compilation behaviour. Transient compilation state lives in the
builder's own WeakMap, never on nodes.

---

## The three-way split

```
nodes.ts          pure data records + user-facing runtime-state management only
                  (value, version, needsUpdate, addUpdateRange, release, …)
                  zero knowledge of compilation

compile.ts        compilerDefs map: one entry per NodeKind
                  setup handlers    — binding registration
                  generate handlers — WGSL expression/statement emission
                  isStatement flag  — controls flow vs. expression context
                  isLeaf flag       — suppresses CSE for identifier-producing nodes

                  NodeData WeakMap  — all transient compilation state
                  (usageCount, propertyName, …) lives here, never on nodes
```

No `import type { WgslBuilder }` in `nodes.ts`. No `setup()` or `generate()`
on node classes. No traits array. The circular dependency between the two files
is broken structurally — nodes cannot reach the compiler at all.

---

## `compilerDefs` — shape and location

```ts
// compile.ts

type NodeCompilerDef<K extends NodeKind = NodeKind> = {
    /** True for var/assign/if/for/while/break/continue/return/stack.
     *  These are emitted as statements; _generateNode returns null. */
    isStatement: boolean

    /** True for leaf nodes that produce a bare identifier (const, uniform,
     *  storage, attribute, …). Re-emitting "camera" or "in.position" is free;
     *  CSE would produce confusing output. */
    isLeaf: boolean

    /** Called once per node in the setup pass to register resource bindings.
     *  null for pure expression/statement nodes with nothing to register. */
    setup: ((node: NodeOf<K>, builder: WgslBuilder) => void) | null

    /** Called in the generate pass. Returns a WGSL expression string, or null
     *  for statement nodes that accumulate output via addLineFlowCode. */
    generate: (node: NodeOf<K>, builder: WgslBuilder) => string | null
}

// NodeOf<K> is the specific node type for kind K — e.g. NodeOf<'uniform'> is
// UniformNode<WgslType>. Defined as a conditional type over the NodeKind union.
// Lets each handler receive the correctly-typed node without casting.

const compilerDefs = {
    // ── expression nodes ─────────────────────────────────────────────────

    binop: {
        isStatement: false, isLeaf: false,
        setup: null,
        generate(node, builder) {
            return `(${builder._gen(node.left)} ${node.op} ${builder._gen(node.right)})`
        },
    },

    call: {
        isStatement: false, isLeaf: false,
        setup: null,
        generate(node, builder) {
            return `${node.fnName}(${node.args.map(a => builder._gen(a)).join(', ')})`
        },
    },

    // ── leaf / resource nodes ─────────────────────────────────────────────

    uniform: {
        isStatement: false, isLeaf: true,
        setup(node, builder) {
            if (node.group === 'material' && !builder.uniformNodes.has(node.uniformId)) {
                builder.uniformNodes.set(node.uniformId, node)
            }
            const structDef = lookupStructDefByName(node.type)
            if (structDef) builder._registerStructDef(structDef)
        },
        generate(node, builder) {
            return node.group === 'material'
                ? `materialUniforms.${node.uniformId}`
                : node.uniformId
        },
    },

    storage: {
        isStatement: false, isLeaf: true,
        setup(node, builder) {
            if (!builder.storageNodes.has(node.id)) {
                const name = `storage_${builder.storageNodes.size}`
                builder.storageNodes.set(node.id, node)
                builder.storageNames.set(node.id, name)
            }
        },
        generate(node, builder) {
            return builder.storageNames.get(node.id) ?? '_missingStorage'
        },
    },

    // … all 30 kinds …

    // ── statement nodes ───────────────────────────────────────────────────

    assign: {
        isStatement: true, isLeaf: false,
        setup: null,
        generate(node, builder) {
            builder.addLineFlowCode(
                `${builder._gen(node.target)} = ${builder._gen(node.value)};`
            )
            return null
        },
    },

    var: {
        isStatement: true, isLeaf: false,
        setup: null,
        generate(node, builder) {
            const init = node.init ? ` = ${builder._gen(node.init)}` : ''
            builder.addLineFlowCode(`var ${node.varName} : ${node.type}${init};`)
            return null
        },
    },

} satisfies Record<NodeKind, NodeCompilerDef>
```

`satisfies Record<NodeKind, NodeCompilerDef>` ensures exhaustiveness at the
definition site — a missing kind is a compile error, not a silent runtime gap.

---

## How the three passes use `compilerDefs`

### Setup pass

```ts
_setupNode(node: Node<WgslType>): void {
    if (this.setupVisited.has(node.id)) return
    this.setupVisited.add(node.id)

    // Walk children first (depth-first)
    for (const child of getChildren(node)) {
        this._setupNode(child)
    }

    // Invoke the kind's setup handler, if any
    compilerDefs[node.kind].setup?.(node as never, this)
}
```

No `node.setup(builder)`. No virtual dispatch. The compiler drives everything.

### Analyze pass

```ts
_analyzeNode(node: Node<WgslType>): void {
    const data = this.getDataFromNode(node)
    data.usageCount = (data.usageCount ?? 0) + 1
    if (data.usageCount > 1) return  // children already counted

    for (const child of getChildren(node)) {
        this._analyzeNode(child)
    }
}
```

No per-kind special-casing needed here — `getChildren` already handles the
`varying` vertex-stage child and `stack` body children via `collect.ts`.

### Generate pass

```ts
_generateNode(node: Node<WgslType>): string | null {
    const data   = this.getDataFromNode(node)
    const def    = compilerDefs[node.kind]

    // CSE hit
    if (data.propertyName !== undefined) return data.propertyName

    // Statements and leaves bypass CSE
    if (def.isStatement || def.isLeaf) {
        return def.generate(node as never, this)
    }

    // CSE: emit let-binding on second+ reference
    if ((data.usageCount ?? 0) > 1) {
        const snippet = def.generate(node as never, this)!
        const varName = `_v${this.varCounter++}`
        this.addLineFlowCode(`let ${varName} = ${snippet};`)
        data.propertyName = varName
        return varName
    }

    return def.generate(node as never, this)
}
```

---

## Transient compilation state: NodeData

All per-node state that exists only during a single compilation lives in the
builder's WeakMap. Nodes are never mutated by the compiler.

```ts
// compile.ts — owned entirely by WgslBuilder

type NodeData = {
    usageCount?:    number     // incremented in analyze pass
    propertyName?:  string     // set when CSE emits a let-binding
    // any future per-node transient state goes here
}

// WgslBuilder field:
private readonly _nodeData = new WeakMap<Node<WgslType>, NodeData>()

getDataFromNode(node: Node<WgslType>): NodeData {
    let d = this._nodeData.get(node)
    if (!d) { d = {}; this._nodeData.set(node, d) }
    return d
}
```

A node object carries only the data the user or the renderer ever needs to
read. The compiler's view of that node (how many times it's referenced, what
variable name it was CSE'd to) is stored separately and discarded when the
builder is garbage-collected.

---

## Node types: pure data records

Each node type is either a plain type alias (for expression/statement nodes
with no mutable state) or an intersection type (for nodes carrying runtime
state). No methods except user-facing data management.

```ts
// nodes.ts — no imports from compile.ts, ever

// Pure expression — just the data the compiler needs to generate WGSL
type BinopNode<T extends WgslType> = Node<T> & {
    readonly op:    BinopOp
    readonly left:  Node<WgslType>
    readonly right: Node<WgslType>
}

// Leaf with runtime state — user-facing methods only
type UniformNode<T extends WgslType> = Node<T> & {
    readonly uniformId: string
    readonly group:     'material' | 'frame'
    value:              number | number[] | Float32Array | null
    version:            number
    // no setup(), no generate(), no traits
}

type StorageNode<T extends WgslType> = Node<T> & {
    readonly storageType:    string
    readonly access:         'read' | 'read_write'
    data:                    GpuTypedArray | null
    version:                 number
    updateRanges:            UpdateRange[]
    _indirectOwner?:         IndirectBuffer
    needsUpdate:             boolean        // setter only — increments version
    addUpdateRange(start: number, count: number): void
    clearUpdateRanges(): void
    release(): void
}
```

The compiler reads `node.uniformId`, `node.group`, `node.storageType`, etc.
directly from the node's own fields — the same fields the user also reads and
writes. No indirection through a traits array, no duplication.

---

## NodeOf<K> — typed access in compilerDefs

To avoid `as never` casts in each handler, a conditional type maps each kind
to its concrete node type:

```ts
// compile.ts (or a shared types file)

type NodeOf<K extends NodeKind> =
    K extends 'uniform'   ? UniformNode<WgslType>   :
    K extends 'storage'   ? StorageNode<WgslType>   :
    K extends 'texture'   ? TextureNode             :
    K extends 'sampler'   ? SamplerNode             :
    K extends 'binop'     ? BinopNode<WgslType>     :
    K extends 'call'      ? CallNode<WgslType>      :
    K extends 'assign'    ? AssignNode              :
    K extends 'var'       ? VarNode<WgslType>       :
    // … all 30 kinds …
    Node<WgslType>
```

Each handler in `compilerDefs` is then typed as
`(node: NodeOf<K>, builder: WgslBuilder) => ...` — no casting at the callsite.

---

## Compiler def table for all 30 node kinds

| Kind | isStatement | isLeaf | setup | notes |
|---|---|---|---|---|
| `const` | false | true | null | emits literal value |
| `param` | false | true | null | emits `paramName ?? 'p' + paramIndex` |
| `uniform` | false | true | registers into `uniformNodes` | emits `materialUniforms.id` or `frameUniforms.id` |
| `attribute` | false | true | registers into `attributes` | emits `in.name` |
| `instanced_buffer_attribute` | false | true | registers into `instancedAttrs` | emits `in.name` |
| `storage` | false | true | registers into `storageNodes` | emits storage variable name |
| `texture` | false | true | registers into `textureNodes` | emits `textureId_tex` |
| `sampler` | false | true | registers into `samplerNodes` | emits `samplerId_samp` |
| `builtin` | false | true | marks `builtinsUsed` | emits builtin accessor expression |
| `varying` | false | true | registers varying + walks vertex source | emits `in.name` (fragment) or `out.name` (vertex) |
| `struct` | false | true | registers struct def | emits struct type name |
| `fn` | false | true | registers fn + traces body | emits fn name |
| `binop` | false | false | null | emits `(left op right)` |
| `call` | false | false | null | emits `fnName(args…)` |
| `construct` | false | false | null | emits `type(args…)` |
| `field` | false | false | null | emits `base.field` |
| `index` | false | false | null | emits `base[index]` |
| `cond` | false | false | null | emits `select(f, t, cond)` |
| `raw` | false | false | null | emits raw string |
| `var` | true | false | null | emits `var name : type = init;` |
| `assign` | true | false | null | emits `target = value;` |
| `if` | true | false | null | emits `if (cond) { … } else { … }` |
| `for` | true | false | null | emits `for (…) { … }` |
| `while` | true | false | null | emits `while (cond) { … }` |
| `break` | true | false | null | emits `break;` |
| `continue` | true | false | null | emits `continue;` |
| `return` | true | false | null | emits `return expr;` |
| `stack` | true | false | null | iterates body, emits each statement |

---

## Why this is better than traits

| | Traits on nodes | compilerDefs in compiler |
|---|---|---|
| Where does compiler knowledge live? | Split: trait types in `node-traits.ts`, handlers in `compile.ts` | Entirely in `compile.ts` |
| Can nodes.ts import compile.ts? | No — but traits still encode compiler concepts | No — nodes have no compiler concepts at all |
| Redundant data? | Yes — binding fields duplicated into traits | No — compiler reads fields directly |
| Adding a new node kind | Create node type + add trait, add system handlers | Create node type + add entry to `compilerDefs` |
| Exhaustiveness checking | Manual (trait map doc) | `satisfies Record<NodeKind, NodeCompilerDef>` |
| Extensibility for new cross-cutting concern | New trait type + new system | New field on `NodeCompilerDef` + update all entries |

The `satisfies` check on `compilerDefs` gives exhaustiveness that the
traits approach never had — the TypeScript compiler rejects a missing kind
at build time.

---

## Files touched

| File | Change |
|---|---|
| `src/nodes/nodes.ts` | remove `setup()`/`generate()` overrides; remove `import type { WgslBuilder }`; remove `traits` field (never added); node types become pure data records |
| `src/nodes/compile.ts` | add `compilerDefs` map; replace `isStatement`/`isLeafIdentifier` sets with `def.isStatement`/`def.isLeaf`; replace `node.generate(this)` with `def.generate(node, this)`; replace `node.setup(this)` with `def.setup?.(node, this)` |
| `src/nodes/node-traits.ts` | **not created** — this file does not exist in this architecture |
| `src/nodes/collect.ts` | unchanged |
