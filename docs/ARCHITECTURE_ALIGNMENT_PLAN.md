# Architecture Alignment Plan: Three.js TSL Node System

## Executive Summary

This document outlines the plan to align gpucat's node compilation system with Three.js TSL architecture **EXACTLY**. The goal is to:
1. Use Three.js method names exactly: `setup()`, `analyze()`, `generate()`, `build()`
2. Merge `CompilerState` into `NodeBuilder` (Three.js has one class, not two)
3. Move setup/generate logic onto Node classes
4. Eliminate the centralized `compilerDefs` switch pattern
5. Adopt `TempNode` for automatic CSE

**Key principle**: Match Three.js naming and structure exactly to eliminate unanticipated bugs.

## Current Architecture (gpucat)

### Pain Points

1. **Centralized `compilerDefs` object** (`compile.ts:1964-2540`)
   - Giant `Record<NodeKind, NodeCompilerDef>` mapping node kinds to handlers
   - `setup: null` on most nodes, actual setup logic scattered
   - Adding a new node requires touching multiple files

2. **Centralized `getChildren()` switch** (`collect.ts:22-268`)
   - Exhaustive switch statement for every node kind
   - Must be updated for each new node type

3. **`NodeStageData` grab-bag** (`compile.ts:385-391`)
   - Per-node state stored in a generic object
   - No structure, easy to have naming collisions

4. **No `TempNode` pattern**
   - CSE logic is inline in `generateNode()` (`compile.ts:1211-1231`)
   - Every expression node manually checked for `usageCount > 1`

5. **Deferred execution fighting architecture**
   - `LoopNode` callback execution in `setupNodeRecursive()` is a special case
   - Not a general pattern

### Current Flow

```
Node construction
    │
    ├── collectGraph() - walks nodes, builds Map<id, node>
    │
    ├── setupNode() - calls compilerDefs[kind].setup()
    │
    ├── analyzeNode() - increments usageCount via getChildren()
    │
    └── generateNode() - calls compilerDefs[kind].generate()
```

## Target Architecture (Three.js Aligned)

### Core Patterns to Adopt (Three.js exact)

1. **Methods on Node classes** (exact Three.js names)
   - `setup(builder)` - prepare node, return outputNode if transforming
   - `analyze(builder, output)` - increment usage, build children if first usage
   - `generate(builder, output)` - emit WGSL code string
   - `build(builder, output)` - orchestrates setup/analyze/generate based on buildStage
   - `getNodeType(builder)` - compute/cache result type

2. **`TempNode` base class**
   - Extends `Node`
   - Override `build()` to auto-create temp variable when `usageCount > 1`
   - Most expression nodes extend `TempNode`

3. **Reflection-based `_getChildren()`**
   - Iterate object properties, find `isNode === true`
   - No switch statement needed

4. **`builder.getNodeProperties(node)`**
   - Per-node mutable state that persists across build stages
   - Structured storage instead of grab-bag

5. **Stack-based control flow**
   - `builder.addStack()` / `removeStack()` for scoped code blocks
   - `StackNode` contains ordered statements

6. **Single NodeBuilder class** (not CompilerState + NodeBuilder)
   - Three.js has ONE class that holds all state AND methods
   - Merge gpucat's `CompilerState` into `NodeBuilder`

7. **Naming conflicts resolution**
   - `MRTNode.setup(getTextureIndex)` → rename to `resolveOutputs(getTextureIndex)`
   - Reserve `setup()` for Three.js build system method

### Target Flow

```
node.build(builder, output)
    │
    ├── Check/force parent stages (setup before analyze before generate)
    │
    ├── builder.buildStage === 'setup'
    │   ├── properties = builder.getNodeProperties(this)
    │   ├── properties.outputNode = this.setup(builder)
    │   └── Recursively build children from properties
    │
    ├── builder.buildStage === 'analyze'
    │   ├── builder.increaseUsage(this)
    │   └── Build children if first usage
    │
    └── builder.buildStage === 'generate'
        ├── TempNode: create var if usageCount > 1
        └── return this.generate(builder, output)
```

## Migration Plan

### Phase 1: Infrastructure (Non-Breaking)

Add new base class methods and builder methods without removing old code.

#### 1.1 Add `NodeBuilder` class

Create a proper `NodeBuilder` class (or rename `CompilerState`) with:

```typescript
class NodeBuilder {
  // Existing state from CompilerState
  buildStage: 'setup' | 'analyze' | 'generate' | null;
  shaderStage: 'vertex' | 'fragment' | 'compute' | null;
  
  // Per-node properties (structured, not grab-bag)
  getNodeProperties(node: Node<WgslType>): NodeProperties;
  getDataFromNode(node: Node<WgslType>): NodeData;
  
  // Usage tracking
  increaseUsage(node: Node<WgslType>): number;
  
  // Stack management
  addStack(): StackNode;
  removeStack(): StackNode;
  
  // Flow code
  addFlowCode(code: string): this;
  addLineFlowCode(code: string): this;
  
  // Variable management
  getVarFromNode(node: Node<WgslType>, name: string | null, type: string): string;
  
  // Type formatting
  format(snippet: string, fromType: string, toType: string): string;
}
```

#### 1.2 Add methods to `Node` base class

```typescript
class Node<T extends WgslType> {
  // Existing fields...
  
  /** Build this node for the current stage. */
  build(builder: NodeBuilder, output?: string): string | null {
    // Default: delegate to legacy compilerDefs (for migration)
    return defaultBuild(builder, this, output);
  }
  
  /** Setup phase: register resources, return outputNode if transforming. */
  setup(builder: NodeBuilder): Node<WgslType> | null {
    // Default: use reflection to find children
    const properties = builder.getNodeProperties(this);
    for (const child of this._getChildren()) {
      properties[`node${i++}`] = child;
    }
    return null;
  }
  
  /** Generate phase: emit WGSL code. */
  generate(builder: NodeBuilder, output?: string): string | null {
    // Default: delegate to outputNode
    const { outputNode } = builder.getNodeProperties(this);
    if (outputNode) return outputNode.build(builder, output);
    return null;
  }
  
  /** Get children via reflection (Three.js pattern). */
  _getChildren(): Array<{ property: string; childNode: Node<WgslType> }> {
    const children = [];
    for (const key of Object.getOwnPropertyNames(this)) {
      if (key.startsWith('_')) continue;
      const val = this[key];
      if (val && typeof val === 'object' && 'kind' in val) {
        children.push({ property: key, childNode: val });
      } else if (Array.isArray(val)) {
        for (const item of val) {
          if (item && typeof item === 'object' && 'kind' in item) {
            children.push({ property: key, childNode: item });
          }
        }
      }
    }
    return children;
  }
}
```

#### 1.3 Add `TempNode` base class

```typescript
class TempNode<T extends WgslType> extends Node<T> {
  readonly isTempNode = true;
  
  hasDependencies(builder: NodeBuilder): boolean {
    return builder.getDataFromNode(this).usageCount > 1;
  }
  
  build(builder: NodeBuilder, output?: string): string | null {
    if (builder.buildStage === 'generate') {
      const type = this.type;
      const nodeData = builder.getDataFromNode(this);
      
      // Already cached?
      if (nodeData.propertyName !== undefined) {
        return builder.format(nodeData.propertyName, type, output);
      }
      
      // Need temp var?
      if (type !== 'void' && output !== 'void' && this.hasDependencies(builder)) {
        const snippet = super.build(builder, type);
        const varName = builder.getVarFromNode(this, null, type);
        builder.addLineFlowCode(`let ${varName} = ${snippet}`);
        nodeData.propertyName = varName;
        return builder.format(varName, type, output);
      }
    }
    
    return super.build(builder, output);
  }
}
```

### Phase 2: Migrate Nodes (Incremental)

Migrate nodes one-by-one from `compilerDefs` to class methods.

#### Migration order (by complexity):

1. **Leaf nodes** (simplest, no children)
   - `ConstNode` - just returns literal
   - `ExpressionNode` - returns snippet
   - `BuiltinNode` - returns builtin reference

2. **Simple expression nodes** (extend TempNode)
   - `BinopNode` - binary operations
   - `ConstructNode` - type constructors
   - `FieldNode` - field access
   - `IndexNode` - array indexing
   - `CallNode` - function calls
   - `CondNode` - ternary select

3. **Resource nodes** (setup registers bindings)
   - `UniformNode`
   - `AttributeNode`
   - `BufferAttributeNode`
   - `StorageNode`
   - `TextureNode`
   - `SamplerNode`
   - `VaryingNode`

4. **Statement nodes** (emit flow code)
   - `AssignNode`
   - `VarNode`
   - `IfNode`
   - `LoopNode`
   - `BreakNode`
   - `ContinueNode`
   - `ReturnNode`

5. **Complex nodes** (custom setup/generate)
   - `FnNode`
   - `WgslFnNode`
   - `StackNode`
   - `StructNode`

#### Per-node migration pattern:

```typescript
// Before (in compilerDefs):
binop: {
  isStatement: false,
  isLeaf: false,
  setup: null,
  generate: (node, state) => {
    const l = generateNode(state, node.left);
    const r = generateNode(state, node.right);
    return `(${l} ${node.op} ${r})`;
  },
},

// After (on class):
class BinopNode<T extends WgslType> extends TempNode<T> {
  // ... existing fields ...
  
  generate(builder: NodeBuilder, output?: string): string {
    const l = this.left.build(builder) ?? '/* missing */';
    const r = this.right.build(builder) ?? '/* missing */';
    return `(${l} ${this.op} ${r})`;
  }
  
  // No setup override needed - base class reflection finds left/right
}
```

### Phase 3: Remove Legacy Code

Once all nodes are migrated:

1. Delete `compilerDefs` object
2. Delete `getChildren()` switch in `collect.ts` (use reflection)
3. Simplify `generateNode()` to just call `node.build()`
4. Rename `CompilerState` to `NodeBuilder` (or keep both temporarily)

### Phase 4: Advanced Patterns

After core migration:

1. **Node transformation via `setup()`**
   - `MathNode.ONE_MINUS` → returns `sub(1.0, aNode)`
   - Allows node graph rewriting during setup

2. **`isolate()` for control flow**
   - Prevents code sharing between if/else branches
   - Used by `ConditionalNode`

3. **`context()` for scoped properties**
   - `builder.addContext({ uniformFlow: true })`
   - Affects generation behavior in subtrees

## File Changes Summary

| File | Changes |
|------|---------|
| `nodes.ts` | Add `build()`, `setup()`, `generate()`, `_getChildren()` to `Node`. Add `TempNode` class. Move generate logic into node classes. |
| `compile.ts` | Add `NodeBuilder` class (or extend `CompilerState`). Simplify `generateNode()`. Eventually delete `compilerDefs`. |
| `collect.ts` | Replace switch with call to `node._getChildren()`. Eventually just re-export from `Node`. |

## Risks & Mitigations

1. **Risk**: Breaking existing functionality during migration
   - **Mitigation**: Keep `compilerDefs` working, migrate nodes incrementally, test each

2. **Risk**: Performance regression from method dispatch
   - **Mitigation**: Unlikely significant; Three.js uses this pattern at scale

3. **Risk**: Circular import issues
   - **Mitigation**: Per instructions, accept circular imports initially

4. **Risk**: Large PR / hard to review
   - **Mitigation**: Phase 1 is purely additive, Phase 2 can be multiple PRs

## Success Criteria

- [ ] All node kinds have `setup()` and `generate()` methods on their classes
- [ ] `compilerDefs` object is deleted
- [ ] `collect.ts` switch statement is deleted
- [ ] `TempNode` handles CSE automatically
- [ ] Existing tests pass
- [ ] Fluid particles example works
