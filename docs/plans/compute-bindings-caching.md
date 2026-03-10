# Unified NodeBuilderState & Bindings System

## Goal

Fully align with three.js architecture:
1. **One `NodeBuilderState`** for both render and compute (like three.js)
2. **One `Bindings` system** that handles both render and compute
3. **Cached bind groups** for compute (not created per-dispatch)

## Three.js Pattern

Three.js uses a single monomorphic `NodeBuilderState` with all fields present:

```javascript
class NodeBuilderState {
    constructor(vertexShader, fragmentShader, computeShader, nodeAttributes, bindings, ...) {
        this.vertexShader = vertexShader;       // empty string for compute
        this.fragmentShader = fragmentShader;   // empty string for compute
        this.computeShader = computeShader;     // empty string for render
        this.nodeAttributes = nodeAttributes;   // empty array for compute
        this.bindings = bindings;               // populated for BOTH
        // ...
    }
}
```

No discriminator - just check which shader is non-null/non-empty.

## Implementation

### Phase 1: Unify NodeBuilderState

#### 1.1 Update `NodeBuilderState` type

**File: `src/renderer/node-builder-state.ts`**

```typescript
export type NodeBuilderState = {
    // === Render shaders (null for compute) ===
    vertexCode: string | null;
    fragmentCode: string | null;
    
    // === Compute shader (null for render) ===
    computeCode: string | null;
    workgroupSize: [number, number, number] | null;

    // === Shared (populated for both) ===
    attributes: AttributeEntry[];           // empty for compute
    uniformGroups: UniformGroupBlock[];
    storage: StorageEntry[];
    textures: TextureEntry[];
    samplers: SamplerEntry[];
    bindings: BindGroup[];
    updateBeforeNodes: UpdateBeforeNode[];
    updateAfterNodes: UpdateAfterNode[];
    updateNodes: UpdateNode[];
    cacheKey: string;                       // empty for compute

    readonly isNodeBuilderState: true;
};
```

#### 1.2 Update `createNodeBuilderState` for render

Keep existing function, but adapt to new shape.

#### 1.3 Add `createNodeBuilderStateForCompute`

```typescript
export function createNodeBuilderStateForCompute(
    compileResult: ComputeCompileResult,
): NodeBuilderState {
    const bindings = buildComputeBindGroups(compileResult);

    return {
        // Render fields null
        vertexCode: null,
        fragmentCode: null,
        
        // Compute fields
        computeCode: compileResult.code,
        workgroupSize: compileResult.workgroupSize,
        
        // Shared
        attributes: [],
        uniformGroups: compileResult.uniformGroups,
        storage: compileResult.storage,
        textures: [],
        samplers: [],
        bindings,
        updateBeforeNodes: [],
        updateAfterNodes: [],
        updateNodes: extractComputeUpdateNodes(compileResult),
        cacheKey: '',
        isNodeBuilderState: true,
    };
}
```

### Phase 2: Remove ComputeBuilderState

**File: `src/renderer/node-manager.ts`**

- Delete `ComputeBuilderState` type
- Update `computeStates: Map<string, NodeBuilderState>`
- Update `getForCompute` to return `NodeBuilderState`

### Phase 3: Extend Bindings for Compute

**File: `src/renderer/bindings.ts`**

Add `getForCompute`, `updateForCompute`, `deleteForCompute`.

### Phase 4: Refactor Renderer

**File: `src/renderer/renderer.ts`**

Update `_dispatchComputeNode` to use bindings system.

### Phase 5: Simplify ComputePipelineEntry

**File: `src/renderer/pipelines.ts`**

Remove redundant fields, bindings now come from `NodeBuilderState`.

## Files to Modify

| File | Changes |
|------|---------|
| `src/renderer/node-builder-state.ts` | Unify type, add `createNodeBuilderStateForCompute` |
| `src/renderer/node-manager.ts` | Remove `ComputeBuilderState`, update maps and functions |
| `src/renderer/bindings.ts` | Add compute functions |
| `src/renderer/pipelines.ts` | Simplify `ComputePipelineEntry`, update disposal |
| `src/renderer/renderer.ts` | Refactor `_dispatchComputeNode` |

## Implementation Order

1. Update `NodeBuilderState` type (add render/compute fields)
2. Update `createNodeBuilderState` for render
3. Add `createNodeBuilderStateForCompute`
4. Remove `ComputeBuilderState`, update `NodeManager`
5. Add compute functions to `bindings.ts`
6. Simplify `ComputePipelineEntry`
7. Refactor `_dispatchComputeNode`
8. Update disposal
9. Test
