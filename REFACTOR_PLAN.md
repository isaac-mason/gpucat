# Shader Node System Refactor Plan

## Goal

Completely refactor the shader node system for WebGPU WGSL code generation:

1. **Kill `node-builder.ts`** (~2460 lines) - The Three.js-aligned multi-stage builder
2. **Simplify `nodes.ts`** (~4637 lines) - Remove codegen from node classes, make them pure data
3. **Create new `builder.ts`** - Concrete WGSL-only code generation with direct logic

## Philosophy

- **Keep**: The DSL API (`Fn()`, `If()`, `Loop()`, swizzling, chaining), `Node` base class, `getChildren()` traversal
- **Kill**: The `setup`/`analyze`/`generate` build stages, `TempNode` pattern, `CodeNode` abstraction, putting codegen inside node classes
- Nodes are a **fixed set of primitives** the compiler knows everything about (not user-authored)
- No abstract patterns - just direct concrete logic with `instanceof`/`kind` checks

---

## Node Kinds: Final Decisions

### Keep List (27 kinds)

| Kind | Node Class | Purpose |
|------|-----------|---------|
| `const` | `ConstNode` | Literal values |
| `uniform` | `UniformNode` | Uniform bindings |
| `attribute` | `AttributeNode` | Vertex attributes |
| `buffer_attribute` | `BufferAttributeNode` | Storage-as-attribute |
| `storage` | `StorageNode` | Storage buffers |
| `texture` | `TextureNode` | Texture bindings |
| `sampler` | `SamplerNode` | Sampler bindings |
| `varying` | `VaryingNode` | Vertex→Fragment interpolation |
| `binop` | `BinopNode` | Binary operations |
| `call` | `CallNode` | All function calls (built-in + user-defined) |
| `wgsl` | `WgslNode` | Inline WGSL snippet |
| `wgsl_fn` | `WgslFnNode` | Raw WGSL function definition |
| `fn` | `FnNode` | DSL-defined function |
| `assign` | `AssignNode` | Assignment statement |
| `construct` | `ConstructNode` | vec/mat construction |
| `struct` | `StructNode` | Struct type definitions |
| `field` | `FieldNode` | Struct field access |
| `index` | `IndexNode` | Array/buffer indexing |
| `builtin` | `BuiltinNode` | WGSL builtins (globalId, vertexIndex, etc.) |
| `stack` | `StackNode` | Statement list container |
| `cond` | `CondNode` | Ternary/select expression |
| `var` | `VarNode` | Local variable declaration |
| `if` | `IfNode` | If statement |
| `loop` | `LoopNode` | For/while loop |
| `expression` | `ExpressionNode` | Wraps expression as statement |
| `break` | `BreakNode` | Break statement |
| `continue` | `ContinueNode` | Continue statement |
| `param` | `ParamNode` | Function parameter |
| `return` | `ReturnNode` | Return statement |
| `output_struct` | `OutputStructNode` | MRT outputs |
| `convert` | `ConvertNode` | Type conversions |
| `inspector` | `InspectorNode` | Debug wrapper (keep for discoverability) |

### Kill List (5 kinds)

| Kind | Current Class | Reason |
|------|--------------|--------|
| `subBuild` | `SubBuildNode` | Three.js multi-backend cruft - handle varying building directly |
| `code` | `CodeNode` | Fold into `wgsl_fn` - just a base class |
| `function` | `FunctionNode` | Rename to `WgslFnNode`, use kind `wgsl_fn` |
| `functionCall` | `FunctionCallNode` | Merge into `CallNode` |

### The Three Function/Snippet Patterns

**(a) `wgsl` - Inline WGSL snippet**
```typescript
const expr = new WgslNode('f32', 'dot($0, $1)', [a, b]);
// generates: dot(a_expr, b_expr)
```

**(b) `wgsl_fn` - Raw WGSL function definition**
```typescript
const noiseHash = wgslFn<'u32'>(`
fn noiseHash(n: i32) -> u32 {
    var v = u32(n);
    return v * (v * v * 15731u + 789221u) + 1376312589u;
}
`);
// Usage: noiseHash(someNode) creates a CallNode
```

**(c) `fn` - DSL function**
```typescript
const updateParticles = Fn(() => {
    const idx = Var(globalId.x, 'idx');
    If(condition, () => { ... });
}).compute({ ... });
```

---

## Unified Compile Architecture (Render + Compute)

The key insight: **render and compute share 90% of codegen logic**. The only differences:

| Aspect | Render | Compute |
|--------|--------|---------|
| Entry points | `@vertex` + `@fragment` | `@compute` |
| Inputs | Attributes, varyings | None (just builtins) |
| Outputs | Position, color, varyings | None (writes to storage) |
| Builtins | `vertex_index`, `instance_index`, `position` | `global_invocation_id`, `local_invocation_id`, etc. |
| Storage access | `read` only | `read`, `write`, `read_write` |

### Shared Core Functions

```typescript
// These work identically for render and compute:
generateExpr(ctx, node)      // Expression codegen
generateStmt(ctx, node)      // Statement codegen  
collectBindings(ctx, roots)  // Uniforms, storage, textures, samplers
collectFunctions(roots)      // FnNode + WgslFnNode discovery
emitFunctionDefs(defs)       // WGSL function emission
countUsages(roots)           // CSE usage counting
```

### Stage-Specific Entry Points

```typescript
function compile(slots: CompileSlots): CompileResult {
    // Render: vertex + fragment stages
    const vertexCode = generateVertexShader(slots);
    const fragmentCode = generateFragmentShader(slots);
    return { vertexCode, fragmentCode, bindings };
}

function compileCompute(node: ComputeNode): ComputeCompileResult {
    // Compute: single compute stage
    const computeCode = generateComputeShader(node);
    return { computeCode, bindings, workgroupSize, dispatch };
}
```

### BuildContext is Stage-Agnostic

```typescript
interface BuildContext {
    stage: 'vertex' | 'fragment' | 'compute';
    
    // All stages collect these:
    uniforms: Map<string, UniformEntry>;
    storages: Map<string, StorageEntry>;
    textures: Map<string, TextureEntry>;
    samplers: Map<string, SamplerEntry>;
    
    // Render-only (ignored in compute):
    attributes: Map<string, AttributeEntry>;
    varyings: Map<string, VaryingEntry>;
    
    // Shared codegen state:
    usageCount: Map<string, number>;
    nodeVars: Map<string, string>;
    code: string[];
    fnDefs: Map<string, string>;
}
```

### Node Behavior by Stage

Most nodes behave identically. Only a few care about stage:

| Node | Vertex | Fragment | Compute |
|------|--------|----------|---------|
| `VaryingNode` | Generate source, output to struct | Read from input struct | ❌ Error |
| `AttributeNode` | Read from vertex input | ❌ Error | ❌ Error |
| `BuiltinNode` | `vertex_index`, `instance_index` | `position` (frag input) | `global_invocation_id`, etc. |
| `StorageNode` | `read` only | `read` only | `read`/`write`/`read_write` |

The builder handles this with simple stage checks:

```typescript
function generateStorage(ctx: BuildContext, node: StorageNode): string {
    const access = ctx.stage === 'compute' ? node.access : 'read';
    // ...
}

function generateVarying(ctx: BuildContext, node: VaryingNode): string {
    if (ctx.stage === 'compute') {
        throw new Error('Varyings not allowed in compute shaders');
    }
    // ...
}
```

---

## Phase 1: Backup & Scaffolding

### 1.1 Backup old builder
```bash
mv src/nodes/node-builder.ts src/nodes/node-builder.ts.bak
```

### 1.2 Create stub `builder.ts`
Create `src/nodes/builder.ts` with:
- `compile(slots: CompileSlots): CompileResult`
- `compileCompute(node: ComputeNode): ComputeCompileResult`
- Re-export necessary types from `.bak` initially

### 1.3 Update imports
Any file importing from `node-builder.ts` should import from `builder.ts` instead.

---

## Phase 2: Simplify `nodes.ts`

### 2.1 Kill TempNode base class
- Remove `TempNode` class entirely
- `FunctionCallNode` → merge into `CallNode`
- CSE will be handled by builder via usage counting

### 2.2 Kill CodeNode/FunctionNode hierarchy
- Remove `CodeNode` class
- Rename `FunctionNode` → `WgslFnNode` with kind `wgsl_fn`
- `WgslFnNode` stores:
  - `source: string` (raw WGSL)
  - `name: string` (parsed function name)
  - `inputs: { name: string, type: string, pointer?: boolean }[]`
  - `returnType: string`
  - `includes: WgslFnNode[]` (dependencies)

### 2.3 Kill SubBuildNode
- Remove `SubBuildNode` class and `subBuild()` factory
- Simplify `VaryingNode` to not wrap source in SubBuildNode
- Builder handles varying's vertex-stage building directly

### 2.4 Consolidate CallNode
- `CallNode` handles calls to:
  - Built-in WGSL functions (fn name as string)
  - `FnNode` references (DSL functions)
  - `WgslFnNode` references (raw WGSL functions)
- Remove `FunctionCallNode` entirely

### 2.5 Strip codegen methods from all nodes
- Remove `setup()`, `analyze()`, `generate()` from all node classes
- Remove `build()` method that dispatches based on build stage
- Keep only:
  - Constructor with data fields
  - `getChildren(): Node[]` method (for traversal)
  - Swizzling properties (`.x`, `.xy`, `.rgb`, etc.)
  - Chain methods (`.add()`, `.mul()`, etc.) that create new nodes

### 2.6 Update NodeKind type
```typescript
export type NodeKind =
    | 'const' | 'uniform' | 'attribute' | 'buffer_attribute'
    | 'storage' | 'texture' | 'sampler' | 'varying'
    | 'binop' | 'call' | 'wgsl' | 'wgsl_fn' | 'fn'
    | 'assign' | 'construct' | 'struct' | 'field' | 'index'
    | 'builtin' | 'stack' | 'cond' | 'var' | 'if' | 'loop'
    | 'expression' | 'break' | 'continue' | 'param' | 'return'
    | 'output_struct' | 'convert' | 'inspector';
```

---

## Phase 3: New `builder.ts` - Concrete WGSL Codegen

### 3.1 Core Architecture

```typescript
type ShaderStage = 'vertex' | 'fragment' | 'compute';

interface BuildContext {
    stage: ShaderStage;
    
    // Collected during traversal
    uniforms: Map<string, UniformEntry>;
    storages: Map<string, StorageEntry>;
    textures: Map<string, TextureEntry>;
    samplers: Map<string, SamplerEntry>;
    attributes: Map<string, AttributeEntry>;
    varyings: Map<string, VaryingEntry>;
    
    // CSE: node id → variable name (for nodes used multiple times)
    nodeVars: Map<string, string>;
    
    // Usage counting for CSE
    usageCount: Map<string, number>;
    
    // Generated code accumulator
    code: string[];
    
    // Function definitions to emit
    fnDefs: Map<string, string>; // fn name → WGSL code
}
```

### 3.2 Build Pipeline (No Abstract Stages)

```typescript
function compile(slots: CompileSlots): CompileResult {
    // 1. Collect all nodes via DFS from roots
    const vertexRoots = [slots.position, ...slots.varyings];
    const fragmentRoots = [slots.fragment];
    
    // 2. Count usages for CSE
    const usages = countUsages([...vertexRoots, ...fragmentRoots]);
    
    // 3. Discover all FnNode/WgslFnNode definitions
    const fnDefs = collectFunctionDefs([...vertexRoots, ...fragmentRoots]);
    
    // 4. Generate vertex shader
    const vertexCtx = createContext('vertex', usages);
    const vertexCode = generateShader(vertexCtx, slots.position, slots.varyings);
    
    // 5. Generate fragment shader  
    const fragmentCtx = createContext('fragment', usages);
    const fragmentCode = generateShader(fragmentCtx, slots.fragment);
    
    // 6. Build bind group layouts from collected bindings
    const bindGroups = buildBindGroups(vertexCtx, fragmentCtx);
    
    return { vertexCode, fragmentCode, bindGroups, ... };
}
```

### 3.3 Code Generation - Direct `instanceof` Dispatch

```typescript
function generateExpr(ctx: BuildContext, node: Node<any>): string {
    // CSE: if already computed and multi-use, return variable name
    if (ctx.nodeVars.has(node.id)) {
        return ctx.nodeVars.get(node.id)!;
    }
    
    let expr: string;
    
    if (node instanceof ConstNode) {
        expr = generateConst(node);
    } else if (node instanceof UniformNode) {
        expr = generateUniform(ctx, node);
    } else if (node instanceof BinopNode) {
        const left = generateExpr(ctx, node.left);
        const right = generateExpr(ctx, node.right);
        expr = `(${left} ${node.op} ${right})`;
    } else if (node instanceof CallNode) {
        expr = generateCall(ctx, node);
    } else if (node instanceof FieldNode) {
        const obj = generateExpr(ctx, node.object);
        expr = `${obj}.${node.fieldName}`;
    } else if (node instanceof IndexNode) {
        const arr = generateExpr(ctx, node.array);
        const idx = generateExpr(ctx, node.index);
        expr = `${arr}[${idx}]`;
    } else if (node instanceof ConstructNode) {
        const args = node.args.map(a => generateExpr(ctx, a));
        expr = `${node.type}(${args.join(', ')})`;
    } else if (node instanceof VaryingNode) {
        expr = generateVarying(ctx, node);
    } else if (node instanceof BuiltinNode) {
        expr = generateBuiltin(ctx, node);
    }
    // ... etc for all node kinds
    
    // CSE: if multi-use, extract to variable
    if (ctx.usageCount.get(node.id)! > 1) {
        const varName = `_v${ctx.nodeVars.size}`;
        ctx.code.push(`let ${varName} = ${expr};`);
        ctx.nodeVars.set(node.id, varName);
        return varName;
    }
    
    return expr;
}
```

### 3.4 Statement Generation

```typescript
function generateStmt(ctx: BuildContext, node: Node<any>): void {
    if (node instanceof VarNode) {
        const init = generateExpr(ctx, node.init);
        if (node.isConst) {
            ctx.code.push(`let ${node.varName} = ${init};`);
        } else {
            ctx.code.push(`var ${node.varName} = ${init};`);
        }
        ctx.nodeVars.set(node.id, node.varName);
    } else if (node instanceof AssignNode) {
        const target = generateExpr(ctx, node.target);
        const value = generateExpr(ctx, node.value);
        ctx.code.push(`${target} = ${value};`);
    } else if (node instanceof IfNode) {
        generateIf(ctx, node);
    } else if (node instanceof LoopNode) {
        generateLoop(ctx, node);
    } else if (node instanceof BreakNode) {
        ctx.code.push(`break;`);
    } else if (node instanceof ContinueNode) {
        ctx.code.push(`continue;`);
    } else if (node instanceof ReturnNode) {
        if (node.value) {
            const val = generateExpr(ctx, node.value);
            ctx.code.push(`return ${val};`);
        } else {
            ctx.code.push(`return;`);
        }
    } else if (node instanceof ExpressionNode) {
        const expr = generateExpr(ctx, node.expr);
        ctx.code.push(`${expr};`);
    } else if (node instanceof StackNode) {
        for (const child of node.nodes) {
            generateStmt(ctx, child);
        }
    }
}
```

### 3.5 Varying Handling (No SubBuildNode)

```typescript
function generateVarying(ctx: BuildContext, node: VaryingNode<any>): string {
    if (ctx.stage === 'vertex') {
        // In vertex: generate the source expression, output to varying struct
        const sourceExpr = generateExpr(ctx, node.source);
        const varyingName = node.name ?? `v_${node.id}`;
        ctx.varyings.set(varyingName, { type: node.type, interpolation: node.interpolation });
        // Will be assigned: output.varyingName = sourceExpr;
        return sourceExpr;
    } else {
        // In fragment: read from varying input
        const varyingName = node.name ?? `v_${node.id}`;
        return `input.${varyingName}`;
    }
}
```

### 3.6 Function Definition Collection & Generation

```typescript
function collectFunctionDefs(roots: Node<any>[]): Map<string, FnDef> {
    const defs = new Map<string, FnDef>();
    
    visit(roots, (node) => {
        if (node instanceof FnNode) {
            const { params, body, output } = node.trace();
            defs.set(node.fnName, { kind: 'dsl', node, params, body, output });
        } else if (node instanceof WgslFnNode) {
            defs.set(node.name, { kind: 'wgsl', node, source: node.source });
            // Also collect includes recursively
            for (const inc of node.includes) {
                defs.set(inc.name, { kind: 'wgsl', node: inc, source: inc.source });
            }
        }
    });
    
    return defs;
}

function emitFunctionDefs(ctx: BuildContext, defs: Map<string, FnDef>): string {
    const code: string[] = [];
    
    for (const [name, def] of defs) {
        if (def.kind === 'wgsl') {
            code.push(def.source);
        } else {
            // Generate from DSL FnNode
            const fnCtx = createFunctionContext(ctx);
            generateStmt(fnCtx, def.body);
            const returnExpr = generateExpr(fnCtx, def.output);
            
            const params = def.params.map(p => `${p.name}: ${p.type}`).join(', ');
            code.push(`fn ${name}(${params}) -> ${def.node.type} {`);
            code.push(...fnCtx.code);
            code.push(`    return ${returnExpr};`);
            code.push(`}`);
        }
    }
    
    return code.join('\n');
}
```

### 3.7 Binding Collection

```typescript
function generateUniform(ctx: BuildContext, node: UniformNode<any>): string {
    const name = node.name;
    if (!ctx.uniforms.has(name)) {
        ctx.uniforms.set(name, {
            name,
            type: node.type,
            group: node.group,
            binding: ctx.uniforms.size,
        });
    }
    return `uniforms.${name}`;
}

function generateStorage(ctx: BuildContext, node: StorageNode<any>): string {
    const name = node.name;
    if (!ctx.storages.has(name)) {
        ctx.storages.set(name, {
            name,
            type: node.elementType,
            access: node.access,
            binding: ctx.storages.size,
        });
    }
    return name;
}
```

---

## Phase 4: Wire Up & Test

### 4.1 Update module exports
- `src/nodes/index.ts` exports from `builder.ts` instead of `node-builder.ts`
- Ensure `compile` and `compileCompute` are exported

### 4.2 Update renderer integration
- `WebGPURenderer` calls `compile()` / `compileCompute()` from new builder
- Verify bind group creation works with new format

### 4.3 Test against all examples
```bash
# Run each example and verify output
pnpm dev  # then test each example manually
```

Examples to verify:
- `example-compute-particles.ts` - compute + render, storage buffers, If/Else
- `example-raging-sea.ts` - wgslFn with includes, Fn with params
- `example-mrt.ts` - MRT, wgslFn
- `example-basic-cube.ts` - basic render
- `example-instances.ts` - instancing, instanceIndex
- `example-texture.ts` - texture sampling
- All other examples in `examples/src/`

### 4.4 Run tests
```bash
pnpm test
```

---

## Phase 5: Cleanup

### 5.1 Delete backup
```bash
rm src/nodes/node-builder.ts.bak
```

### 5.2 Remove dead code from nodes.ts
- Any remaining references to old builder patterns
- Unused helper functions
- Dead imports

### 5.3 Final line count check
Goal: `nodes.ts` < 2500 lines, `builder.ts` < 1500 lines

---

## File Summary

| File | Before | After | Change |
|------|--------|-------|--------|
| `node-builder.ts` | 2460 lines | 0 (deleted) | -2460 |
| `nodes.ts` | 4637 lines | ~2500 lines | -2137 |
| `builder.ts` | 0 | ~1200 lines | +1200 |
| **Total** | 7097 lines | ~3700 lines | **-3397 (-48%)** |

---

## Key Principles

1. **No abstract dispatch** - use `instanceof` checks directly
2. **No build stages** - single pass with usage counting for CSE
3. **Nodes are data** - no codegen methods, just `getChildren()`
4. **Direct WGSL** - no backend abstraction, concrete WGSL generation
5. **Compiler knows all node types** - fixed set of primitives, not extensible
