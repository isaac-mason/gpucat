# Migration Plan: Node<T> to Node<D extends WgslDesc>

## Overview

Migrate gpucat's type system from `Node<T extends WgslType>` (string-literal type parameters) to `Node<D extends WgslDesc>` (descriptor objects as type parameters).

**Goal:** Enable typed `.element()` and `.field()` access on nodes without runtime string parsing.

## Current State

- **schema.ts** ✅ DONE - packcat-style discriminated union with explicit types for all WGSL primitives
- **Phase 1** ✅ DONE - All 69 downstream errors fixed, codebase compiles clean

## Phase 1: Fix Downstream Type Errors ✅ COMPLETE

All files now use non-generic `WgslDesc`:
- buffer-layout.ts ✅ (31 errors fixed)
- core.ts ✅ (7 errors fixed)
- storage.ts ✅ (7 errors fixed)
- attribute.ts ✅ (4 errors fixed)
- wgsl.ts ✅ (1 error fixed) - added overloads for proper type inference
- viewer.ts ✅ (13 errors fixed)
- render-output.ts ✅ (4 errors fixed)
- renderer.ts ✅ (2 errors fixed)

## Phase 2: Migrate Node<T> to Node<D> (CURRENT)

### Strategy: Clean Break

No backwards compat. Direct migration:
- `node.type` becomes the full `WgslDesc` object
- Add `node.wgslType` convenience getter for the WGSL type string
- All places using `node.type` for WGSL string generation use `node.wgslType` instead

### 2.1 Define Helper Types (in schema.ts)

Already done:
- `DescElement<D>` — extracts element descriptor from array descriptors
- `DescFields<D>` — extracts fields record from struct descriptors  
- `Infer<D>` — maps descriptor to JS value type

Need to add:
- `WgslDescFor<T extends WgslType>` — reverse lookup type (WgslType string → descriptor)
- Runtime descriptor lookup map

### 2.2 Update Node Base Class

```ts
// Before
export class Node<T extends WgslType> {
    readonly id: string;
    readonly type: T;
    constructor(id: string, type: T) {
        this.id = id;
        this.type = type;
    }
}

// After (CLEAN BREAK)
export class Node<D extends WgslDesc> {
    readonly id: string;
    readonly type: D;  // Full descriptor object
    
    constructor(id: string, type: D) {
        this.id = id;
        this.type = type;
    }
    
    // Convenience getter for WGSL string
    get wgslType(): D['wgslType'] { 
        return this.type.wgslType; 
    }
}
```

### 2.3 Update Node Methods

**Typed element access:**
```ts
element(idx: Node<WgslDesc>): Node<DescElement<D>> {
    // Uses desc.element at type level
    // Runtime still uses parseArrayElementType or desc.element
}
```

**Typed field access:**
```ts
field<K extends keyof DescFields<D>>(name: K): Node<DescFields<D>[K]> {
    // Uses desc.fields[name] at type level
    // Returns never for non-structs
}
```

### 2.4 Update All Node Subclasses (35 total)

Each subclass changes from `extends Node<T>` to `extends Node<D>`:

**Core Node classes (core.ts):**
- ConstNode<D> — literal values
- VarNode<D> — mutable variables
- BinopNode<D> — binary operations (+, -, *, /, etc.)
- CallNode<D> — function calls
- ConstructNode<D> — type constructors (vec3f(), mat4x4f())
- FieldNode<D> — struct field access
- IndexNode<D> — array index access
- ArrayNode<D> — array construction
- FnNode<D> — function definitions
- ParamNode<D> — function parameters
- ReturnNode<D> — return statements
- CondNode<D> — ternary conditionals
- IfNode — if statements (uses void descriptor)
- LoopNode — loops (uses void descriptor)
- StackNode — statement blocks
- StructNode<D> — struct definitions
- AssignNode — assignment statements
- InspectorNode<D> — debugging

**External Node classes:**
- WgslNode<D> (wgsl.ts)
- BufferAttributeNode<D> (attribute.ts)
- AttributeNode<D> (attribute.ts)
- StorageNode<D> (storage.ts)
- VaryingNode<D> (varying.ts)
- UniformNode<D> (uniform.ts)
- TextureNode (texture.ts) — uses TextureDesc
- SamplerNode (texture.ts) — uses SamplerDesc
- BuiltinNode<D> (builtin.ts)
- SubBuildNode<D> (sub-build.ts)
- PassNode (pass-node.ts)
- OutputStructNode (mrt.ts)
- WgslFunctionNode (wgsl-fn.ts)

### 2.5 Update Factory Functions

**Primitive constructors:**
```ts
// Before
export function f32(v: Scalar): Node<'f32'>

// After
export function f32(v: Scalar): Node<F32Desc>
```

**Math operations:**
```ts
// Before
export const add = <A extends WgslType, B extends WgslType>(a: Node<A>, b: Node<B>): Node<ArithResult<A, B>>

// After — need ArithResultDesc<DA, DB> that returns descriptor
export const add = <DA extends WgslDesc, DB extends WgslDesc>(a: Node<DA>, b: Node<DB>): Node<ArithResultDesc<DA, DB>>
```

### 2.6 Update builder.ts

The WGSL code generator uses `node.type` extensively for emitting type names.
Since `type` is now the full descriptor, all places need to use `node.wgslType` instead.

Places that need updating:
- All `node.type` references for WGSL string output → `node.wgslType`
- `constLiteral(node.wgslType, node.value)`
- `${node.wgslType}(${args.join(', ')})`
- `type: node.wgslType`

### 2.7 Descriptor Construction at Runtime

When we only have a wgslType string (like from parsed WGSL), we need to construct a descriptor:

```ts
// Add to schema.ts
const descriptorByType: Record<string, WgslDesc> = {
    'f32': f32,
    'i32': i32,
    'vec3f': vec3f,
    // ... etc
};

export function descFromWgslType(wgslType: string): WgslDesc {
    return descriptorByType[wgslType] ?? { type: wgslType, wgslType } as WgslDesc;
}
```

## Phase 2 Execution Order

The order matters to minimize cascading errors:

1. **2.1-2.2**: Node base class changes
2. **2.8-2.19**: All Node subclasses in core.ts 
3. **2.33-2.34**: Standalone functions and constructors in core.ts
4. **2.20-2.31**: External Node subclasses
5. **2.32**: builder.ts updates
6. **2.35**: StructDef updates
7. **2.39**: Final error sweep
8. **2.40**: Test typed access

## Phase 3: Update Dependent Systems

### 3.1 Update storage buffer system
- `StorageBufferAttribute` creation from descriptors
- Array element access with typed return

### 3.2 Update uniform system
- Struct field access with typed return

### 3.3 Update renderer
- Node type checking in render pipeline

## Testing Strategy

- Run `npx tsc --noEmit` after each sub-phase
- Test examples after Phase 2 complete
- No runtime behavior should change

## Files by Impact

| File | Lines | Node Classes | Functions | Priority |
|------|-------|--------------|-----------|----------|
| core.ts | 1109 | 20 | 100+ | Critical |
| builder.ts | 1765 | 0 | many | High |
| wgsl.ts | 57 | 1 | 1 | Medium |
| attribute.ts | 159 | 2 | 3 | Medium |
| storage.ts | 259 | 1 | 3 | Medium |
| varying.ts | 67 | 1 | 0 | Medium |
| uniform.ts | 154 | 1 | many | Medium |
| texture.ts | 141 | 2 | many | Medium |
| builtin.ts | 47 | 1 | 1 | Low |
| mrt.ts | 159 | 1 | many | Low |
| pass-node.ts | 479 | 1 | many | Low |
| wgsl-fn.ts | 203 | 1 | 1 | Low |
| sub-build.ts | 34 | 1 | 0 | Low |
