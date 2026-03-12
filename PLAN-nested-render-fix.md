# Nested Render Camera Uniform Bug - Fix Plan

## Problem

In `example-render-to-texture`, when PassNode renders an inner scene to a texture, the outer scene's cube renders with the wrong camera's projection matrix (uses inner camera's aspect ratio instead of outer camera's).

## Root Cause

**Shared BindGroups are cached per RenderContext, not globally.**

In `node-builder-state.ts`, the `_bindingGroupsCache` is keyed by `RenderContext`:

```typescript
const _bindingGroupsCache = new WeakMap<BindingContext, Map<string, BindGroup>>();
```

This means:
- Inner render (PassNode's RenderTarget) → RenderContext A → BindGroup instance X
- Outer render (screen) → RenderContext B → BindGroup instance Y

Even though both use the same `cameraProjectionMatrix` singleton node from `renderGroup`, they get **different BindGroup instances** because they have different RenderContexts.

Each BindGroup has its own `binding.lastRenderId`, so:
1. Inner render updates its BindGroup X with inner camera, sets `lastRenderId = 2`
2. Outer render updates its BindGroup Y with outer camera, sets `lastRenderId = 1`
3. Next frame: each skips update because `lastRenderId` matches their respective `renderId`

The GPU buffer is shared (same uniform nodes), but the deduplication logic thinks each context's binding was already updated for that renderId.

## Three.js Approach

In Three.js's `NodeBuilderState.createBindings()`:
- Shared groups reuse the **same BindGroup instance** across all RenderObjects
- The shared BindGroup is created once during node compilation and stored in `this.bindings`
- `createBindings()` just returns the same reference for shared groups

The key difference: Three.js doesn't cache shared BindGroups per context - they're global to the NodeBuilderState (which is shared across RenderObjects with the same material).

## Fix Options

### Option 1: Global Cache for Shared BindGroups (Recommended)

Change `_bindingGroupsCache` from per-context to global:

```typescript
// Before: per-context
const _bindingGroupsCache = new WeakMap<BindingContext, Map<string, BindGroup>>();

// After: global (no context key)
const _sharedBindGroupsCache = new Map<string, BindGroup>();
```

**Pros:**
- Matches Three.js semantics exactly
- Single BindGroup instance for all renders using same shared uniforms
- `lastRenderId` correctly tracks when uniform was last updated

**Cons:**
- Need to handle cleanup when BindGroups are no longer used (memory leak potential)
- Could use WeakRef + FinalizationRegistry, or just accept small leak for global singletons

### Option 2: Remove Per-Context Caching, Store on GroupNode

Store the shared BindGroup directly on the `UniformGroupNode`:

```typescript
// In buildTemplateBindGroups:
if (shared) {
    let bindGroup = uniformGroup.groupNode._cachedBindGroup;
    if (!bindGroup) {
        bindGroup = createUniformBindGroup(uniformGroup);
        uniformGroup.groupNode._cachedBindGroup = bindGroup;
    }
    bindGroups.push(bindGroup);
}
```

**Pros:**
- BindGroup lifetime tied to GroupNode lifetime (natural GC)
- Very simple implementation

**Cons:**
- Slightly pollutes the node types with renderer-specific state

### Option 3: Don't Deduplicate by renderId for Shared Groups

Remove the `lastRenderId` check entirely for shared render groups, always update:

```typescript
if (block.groupNode.shared) {
    const updateType = block.groupNode.updateType;
    if (updateType === 'frame') {
        // Keep frame deduplication
        if (binding.lastFrameId === frame.frameId) return;
        binding.lastFrameId = frame.frameId;
    }
    // Remove 'render' deduplication - always update shared render groups
}
```

**Pros:**
- Simplest fix
- No caching changes needed

**Cons:**
- Slightly less efficient - updates camera uniforms for every mesh instead of once per render
- Doesn't address the root issue of multiple BindGroup instances

## Recommended Fix: Option 2

Option 2 is the cleanest because:
1. It aligns with how Three.js conceptually handles this (BindGroup tied to the shared group identity)
2. Natural memory management via GC
3. Minimal code changes
4. Doesn't require changing the deduplication logic

### Implementation Steps

1. Add `_cachedBindGroup?: BindGroup` field to `UniformGroupNode` type
2. In `buildTemplateBindGroups`, for shared uniform-only groups:
   - Check if `uniformGroup.groupNode._cachedBindGroup` exists
   - If not, create and cache it
   - Push the cached instance
3. Remove the per-context caching logic for shared groups
4. Test with `example-render-to-texture`

### Files to Modify

- `src/nodes/lib/uniform.ts` - Add optional `_cachedBindGroup` to UniformGroupNode
- `src/renderer/node-builder-state.ts` - Update `buildTemplateBindGroups` to use node-level cache

## Verification

After fix, `example-render-to-texture` should show:
- Inner cube rendered to texture with square aspect ratio (1:1)
- Outer cube rendered to screen with window aspect ratio (e.g., 16:9)
- Outer cube should NOT appear stretched/squashed based on window size
