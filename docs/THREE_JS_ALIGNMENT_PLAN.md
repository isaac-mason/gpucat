# Three.js WebGPU Renderer Alignment Plan

## Executive Summary

gpucat currently has ad-hoc solutions (`_renderGroupKeys`, `_renderGroupVersionSums`, `_outputMaterialCache`) that solve real problems but don't align with Three.js's architecture. This plan details how to introduce Three.js's core rendering subsystems while maintaining gpucat's functional style preference.

## Current State vs Three.js

| System | Three.js | gpucat Current | Gap |
|--------|----------|----------------|-----|
| **RenderObjects** | Full caching system with `RenderObject` class + `ChainMap` | No equivalent - pipelines cached by key, but no per-object state | **Major** |
| **Bindings** | `Bindings` class with per-RenderObject bind group management | Per-pipeline render group buffers (`_renderGroupKeys`) + per-mesh object groups | **Major** |
| **RenderLists** | `RenderList` class with object pooling, cached per scene/camera | Stateless `collectDraws()` rebuilt each frame | **Medium** |
| **RenderContexts** | `RenderContext` class, cached by framebuffer config | No equivalent - render target state in renderer | **Medium** |
| **Attributes** | `Attributes` class with version tracking, deduplication | `BufferCache` with version tracking | **Minor** |
| **Geometries** | `Geometries` class coordinating attribute updates | Ad-hoc in renderer `_prepareMesh()` | **Minor** |
| **NodeManager** | Manages node compilation, caching, update scheduling | Ad-hoc update arrays from compile result | **Medium** |

## Design Decisions

Based on discussion:
- **Lighting**: Defer entirely - don't include lights in cache key yet
- **RenderList pooling**: Use object pooling (Three.js style) to avoid GC pressure
- **Disposal**: Explicit `dispose()` methods (not EventDispatcher pattern)
- **Multi-pass**: Full passId-based ChainMap system for shadow maps, reflection probes, etc.

## Alignment Architecture

Following gpucat's preference for functional style, each system uses a **state object + functions** pattern:

```typescript
// Pattern example
export type RenderObjectsState = { /* state */ };
export function createRenderObjectsState(deps: Deps): RenderObjectsState;
export function getRenderObject(state: RenderObjectsState, ...args): RenderObject;
export function disposeRenderObject(state: RenderObjectsState, ro: RenderObject): void;
```

---

## 1. ChainMap Utility

### Purpose
Hierarchical WeakMap-based cache supporting composite keys. Foundation for RenderObjects and RenderLists caching.

### File
`src/renderer/chain-map.ts`

### API

```typescript
export type ChainMap<T> = {
  weakMaps: Map<number, WeakMap<object, any>>;
};

export function createChainMap<T>(): ChainMap<T>;
export function chainMapGet<T>(map: ChainMap<T>, keys: object[]): T | undefined;
export function chainMapSet<T>(map: ChainMap<T>, keys: object[], value: T): void;
export function chainMapDelete<T>(map: ChainMap<T>, keys: object[]): boolean;
```

---

## 2. RenderContext + RenderContexts

### Purpose
Manage render pass configuration state. Cache contexts by framebuffer configuration.

### Files
- `src/renderer/render-context.ts`
- `src/renderer/render-contexts.ts`

### RenderContext Type

```typescript
export type RenderContext = {
  readonly id: number;
  
  // MRT configuration
  mrt: MRTNode | null;
  
  // Clear state
  clearColor: boolean;
  clearColorValue: { r: number; g: number; b: number; a: number };
  clearDepth: boolean;
  clearDepthValue: number;
  clearStencil: boolean;
  clearStencilValue: number;
  
  // Attachment configuration
  color: boolean;
  depth: boolean;
  stencil: boolean;
  
  // Viewport/scissor
  viewport: boolean;
  viewportValue: { x: number; y: number; width: number; height: number; minDepth: number; maxDepth: number };
  scissor: boolean;
  scissorValue: { x: number; y: number; width: number; height: number };
  
  // Dimensions
  width: number;
  height: number;
  
  // Render target
  renderTarget: RenderTarget | null;
  textures: GPUTexture[] | null;
  depthTexture: GPUTexture | null;
  
  // MSAA
  sampleCount: number;
  
  // Camera (for uniforms)
  camera: Camera | null;
};
```

### RenderContexts Manager

```typescript
export type RenderContextsState = {
  contexts: Map<string, RenderContext>;
};

export function createRenderContextsState(): RenderContextsState;

export function getRenderContext(
  state: RenderContextsState,
  renderTarget: RenderTarget | null,
  mrt: MRTNode | null,
  callDepth: number,
): RenderContext;

export function buildRenderPassDescriptor(
  context: RenderContext,
): GPURenderPassDescriptor;
```

---

## 3. Attributes System

### Purpose
Manage GPU buffer creation and updates for BufferAttributes with per-frame deduplication.

### File
`src/renderer/attributes.ts` (refactor from buffers.ts)

### API

```typescript
export type AttributeType = 'vertex' | 'index' | 'storage' | 'indirect';

export type AttributesState = {
  device: GPUDevice;
  data: WeakMap<BufferAttribute, AttributeData>;
  updateCalls: WeakMap<BufferAttribute, number>;
  currentCallId: number;
};

export type AttributeData = {
  buffer: GPUBuffer;
  version: number;
};

export function createAttributesState(device: GPUDevice): AttributesState;
export function updateAttribute(state: AttributesState, attribute: BufferAttribute, type: AttributeType): void;
export function getAttribute(state: AttributesState, attribute: BufferAttribute): GPUBuffer | undefined;
export function deleteAttribute(state: AttributesState, attribute: BufferAttribute): void;
export function incrementCallId(state: AttributesState): void;
```

---

## 4. Geometries System

### Purpose
Coordinate geometry/attribute state for RenderObjects. Handle wireframe index generation.

### File
`src/renderer/geometries.ts`

### API

```typescript
export type GeometriesState = {
  attributes: AttributesState;
  data: WeakMap<Geometry, GeometryData>;
  wireframes: WeakMap<Geometry, BufferAttribute>;
};

export type GeometryData = {
  initialized: boolean;
};

export function createGeometriesState(attributes: AttributesState): GeometriesState;
export function updateForRender(state: GeometriesState, renderObject: RenderObject): void;
export function getIndex(state: GeometriesState, renderObject: RenderObject): BufferAttribute | null;
export function initGeometry(state: GeometriesState, renderObject: RenderObject): void;
```

---

## 5. NodeBuilderState + NodeManager

### Purpose
Formalize compile result caching. Manage node compilation and update scheduling.

### Files
- `src/renderer/node-builder-state.ts`
- `src/renderer/node-manager.ts`

### NodeBuilderState Type

```typescript
export type NodeBuilderState = {
  // Compiled shader code
  vertexShader: string;
  fragmentShader: string;
  
  // Binding metadata
  uniformGroups: UniformGroup[];
  storageBindings: StorageBinding[];
  textureBindings: TextureBinding[];
  samplerBindings: SamplerBinding[];
  
  // Attribute metadata
  attributes: AttributeInfo[];
  
  // Update nodes
  updateNodes: Node<any>[];
  updateBeforeNodes: Node<any>[];
  updateAfterNodes: Node<any>[];
  
  // Cache key
  cacheKey: string;
};
```

### NodeManager API

```typescript
export type NodeManagerState = {
  nodeStates: WeakMap<RenderObject, NodeBuilderState>;
  environmentCacheKey: number;
};

export function createNodeManagerState(): NodeManagerState;
export function getNodeBuilderState(state: NodeManagerState, renderObject: RenderObject): NodeBuilderState;
export function needsNodeUpdate(state: NodeManagerState, renderObject: RenderObject): boolean;
export function getCacheKey(state: NodeManagerState, scene: Scene, camera: Camera): number;
export function updateBefore(state: NodeManagerState, renderObject: RenderObject, frame: RenderFrame): void;
export function updateForRender(state: NodeManagerState, renderObject: RenderObject, context: RenderUpdateContext): void;
export function updateAfter(state: NodeManagerState, renderObject: RenderObject, frame: RenderFrame): void;
export function deleteNode(state: NodeManagerState, renderObject: RenderObject): void;
```

---

## 6. Bindings System

### Purpose
Manage GPU bind groups for RenderObjects. Create, update, and cache bind groups with dirty tracking.

### File
`src/renderer/bindings.ts`

### API

```typescript
export type BindingsState = {
  device: GPUDevice;
  bindingData: WeakMap<RenderObject, BindingData>;
};

export type BindingData = {
  bindGroups: GPUBindGroup[];
  uniformBuffers: Map<string, GPUBuffer>;
  versions: Map<string, number>;
};

export function createBindingsState(device: GPUDevice): BindingsState;
export function initBindings(state: BindingsState, renderObject: RenderObject): void;
export function updateBindings(state: BindingsState, renderObject: RenderObject, bufferCache: BufferCache, textureCache: TextureCache): void;
export function getBindGroups(state: BindingsState, renderObject: RenderObject): GPUBindGroup[];
export function deleteBindings(state: BindingsState, renderObject: RenderObject): void;
```

---

## 7. RenderList + RenderLists

### Purpose
Organize scene objects into sorted lists for rendering. Cache lists per scene/camera. Use object pooling.

### Files
- `src/renderer/render-list.ts`
- `src/renderer/render-lists.ts`

### RenderItem Type

```typescript
export type RenderItem = {
  id: number;
  mesh: Mesh;
  geometry: Geometry;
  material: Material;
  groupOrder: number;
  renderOrder: number;
  z: number;
  group: GeometryGroup | null;
};
```

### RenderList Type

```typescript
export type RenderList = {
  scene: Scene;
  camera: Camera;
  
  // Object pool
  renderItems: RenderItem[];
  renderItemsIndex: number;
  
  // Sorted lists
  opaque: RenderItem[];
  transparent: RenderItem[];
  
  // Statistics
  occlusionQueryCount: number;
};
```

### RenderLists API

```typescript
export type RenderListsState = {
  lists: ChainMap<RenderList>;
};

export function createRenderListsState(): RenderListsState;
export function getRenderList(state: RenderListsState, scene: Scene, camera: Camera): RenderList;
export function beginRenderList(list: RenderList): void;
export function pushRenderItem(list: RenderList, mesh: Mesh, geometry: Geometry, material: Material, groupOrder: number, z: number, group: GeometryGroup | null): void;
export function finishRenderList(list: RenderList): void;
export function sortRenderList(list: RenderList, customOpaqueSort?: SortFn, customTransparentSort?: SortFn): void;

// Sorting functions
export function painterSortStable(a: RenderItem, b: RenderItem): number;
export function reversePainterSortStable(a: RenderItem, b: RenderItem): number;
```

---

## 8. RenderObject + RenderObjects

### Purpose
Central hub that owns all per-draw-call state. Each unique `(mesh, material, renderContext)` tuple gets a `RenderObject` that caches its pipeline, bindings, and attributes.

### Files
- `src/renderer/render-object.ts`
- `src/renderer/render-objects.ts`

### RenderObject Type

```typescript
export type RenderObject = {
  readonly id: number;
  
  // Source references
  mesh: Mesh;
  material: Material;
  geometry: Geometry;
  camera: Camera;
  scene: Scene;
  renderContext: RenderContext;
  
  // Compiled state (lazy-initialized)
  nodeBuilderState: NodeBuilderState | null;
  pipeline: GPURenderPipeline | null;
  bindings: GPUBindGroup[] | null;
  
  // Attribute state
  attributes: BufferAttribute[] | null;
  vertexBuffers: BufferAttribute[] | null;
  
  // Draw parameters
  drawParams: DrawParams | null;
  
  // Cache keys for invalidation detection
  initialCacheKey: string;
  version: number;
  
  // Disposal callback
  onDispose: (() => void) | null;
};

export type DrawParams = {
  vertexCount: number;
  firstVertex: number;
  instanceCount: number;
  firstInstance: number;
};
```

### RenderObjects API

```typescript
export type RenderObjectsState = {
  nodes: NodeManagerState;
  geometries: GeometriesState;
  pipelines: PipelineCache;
  bindings: BindingsState;
  chainMaps: Map<string, ChainMap<RenderObject>>;
};

export function createRenderObjectsState(deps: {
  nodes: NodeManagerState;
  geometries: GeometriesState;
  pipelines: PipelineCache;
  bindings: BindingsState;
}): RenderObjectsState;

export function getRenderObject(
  state: RenderObjectsState,
  mesh: Mesh,
  material: Material,
  scene: Scene,
  camera: Camera,
  renderContext: RenderContext,
  passId: string,
): RenderObject;

export function disposeRenderObject(state: RenderObjectsState, renderObject: RenderObject): void;

// Cache key computation
export function computeMaterialCacheKey(material: Material, geometry: Geometry): string;
export function computeRenderObjectCacheKey(renderObject: RenderObject): string;
```

---

## Implementation Order

### Phase 1: Foundation (No Breaking Changes) ✅ COMPLETE
1. ✅ **ChainMap utility** - `src/renderer/chain-map.ts`
2. ✅ **RenderContext + RenderContexts** - `src/renderer/render-context.ts`, `src/renderer/render-contexts.ts`
3. ✅ **Attributes refactor** - `src/renderer/attributes.ts`

### Phase 2: Core Systems ✅ COMPLETE
4. ✅ **Geometries** - `src/renderer/geometries.ts`
5. ✅ **NodeBuilderState** - `src/renderer/node-builder-state.ts`
6. ✅ **NodeManager** - `src/renderer/node-manager.ts`
7. ✅ **Bindings** - `src/renderer/bindings.ts`

### Phase 3: Lists and Objects ✅ COMPLETE
8. ✅ **RenderObject** - `src/renderer/render-object.ts`
9. ✅ **RenderObjects** - `src/renderer/render-objects.ts`
10. ✅ **RenderList** - `src/renderer/render-list.ts`
11. ✅ **RenderLists** - `src/renderer/render-lists.ts`

### Phase 4: Renderer Refactor (TODO)
12. **Refactor WebGPURenderer** - Use new systems, remove old ad-hoc code
13. **Remove deprecated code** - `_renderGroupKeys`, `_outputMaterialCache`, etc.

---

## Files Created

| File | Description |
|------|-------------|
| `src/renderer/chain-map.ts` | Hierarchical WeakMap for composite key caching |
| `src/renderer/render-context.ts` | RenderContext type + factory |
| `src/renderer/render-contexts.ts` | RenderContexts manager |
| `src/renderer/attributes.ts` | Attributes system with per-frame deduplication |
| `src/renderer/geometries.ts` | Geometry state coordination, wireframe index generation |
| `src/renderer/node-builder-state.ts` | Formalized compile result type |
| `src/renderer/node-manager.ts` | Node compilation and update lifecycle management |
| `src/renderer/bindings.ts` | Per-RenderObject bind group management |
| `src/renderer/render-object.ts` | Per-draw-call state container |
| `src/renderer/render-objects.ts` | RenderObject manager with ChainMap caching |
| `src/renderer/render-list.ts` | Sorted render item list with object pooling |
| `src/renderer/render-lists.ts` | RenderList manager with scene collection |

---

## Migration Impact

When complete, the following will be removed from `WebGPURenderer`:
- `_renderGroupKeys: Map<string, object>`
- `_renderGroupVersionSums: Map<string, number>`
- `_objectGroupKeys: WeakMap<Mesh, object>`
- `_objectGroupVersionSums: WeakMap<Mesh, number>`
- `_outputMaterialCache: Map<string, { mat: Material; pipelineKey: string }>`
- `_uploadRenderGroup()` method
- `_uploadObjectGroup()` method
- `collectDraws()` function (replaced by RenderLists)

These responsibilities move to the new systems:
- **Bindings**: Uniform buffer management, version tracking, dirty checking
- **RenderObjects**: Per-mesh state caching, disposal coordination
- **RenderLists**: Draw call collection, sorting, object pooling
- **RenderContexts**: Render pass configuration caching

---

# Alignment Audit (March 2026)

## Executive Summary

After implementing Phases 1-3, gpucat's renderer architecture is **substantially aligned** with Three.js WebGPURenderer. The core patterns match: ChainMap caching, DataMap pattern, BindGroup-keyed bindings, RenderObject-centric state management, and functional state objects.

## Alignment Status by System

### ✅ Fully Aligned

| System | Three.js | gpucat | Status |
|--------|----------|--------|--------|
| **DataMap pattern** | `class DataMap { get() auto-creates }` | WeakMap with auto-create `getData()` | ✅ Identical |
| **ChainMap** | `ChainMap` for composite key caching | `chain-map.ts` - same pattern | ✅ Identical |
| **BindGroup** | `class BindGroup { name, bindings[], id }` | `type BindGroup { name, bindings[], id, groupIndex, shared }` | ✅ Aligned (gpucat has extra fields) |
| **NodeBuilderState** | Holds compiled shaders + `createBindings()` clones non-shared groups | Same pattern - `bindings` array + `createBindings()` | ✅ Aligned |
| **RenderObject** | Per-draw state, lazy `getBindings()` calls `createBindings()` | Same - `_bindings` field, `getBindings()` function | ✅ Aligned |
| **RenderObjects** | ChainMap keyed by `[object, material, renderContext, lightsNode]` | ChainMap keyed by `[mesh, material, renderContext]` + passId | ✅ Aligned |
| **Bindings** | Keys BindGroupData by BindGroup identity (shared groups share data) | Same - `WeakMap<BindGroup, BindGroupData>` | ✅ Aligned |
| **RenderList** | Object pooling, opaque/transparent sorting | Same pattern | ✅ Aligned |
| **RenderLists** | ChainMap per scene/camera | Same pattern | ✅ Aligned |
| **RenderContext** | Render pass configuration container | Same type structure | ✅ Aligned |
| **RenderContexts** | Cached by framebuffer config | Same pattern | ✅ Aligned |
| **Attributes** | Version tracking, per-frame deduplication | Same pattern with `callId` | ✅ Aligned |
| **Geometries** | Coordinates attribute updates for RenderObjects | Same pattern | ✅ Aligned |
| **Textures** | WeakMap caching, version/generation tracking | Same pattern | ✅ Aligned |
| **Render Target Texture Tracking** | `generation` field for detecting texture changes | `lastGpuTexture` field for render targets + `generation` for user textures | ✅ Aligned |

### ⚠️ Minor Differences (Acceptable)

| System | Three.js | gpucat | Notes |
|--------|----------|--------|-------|
| **Functional vs OOP** | Class-based (`class Bindings extends DataMap`) | Functional (`type BindingsState` + functions) | ✅ Deliberate choice |
| **Backend abstraction** | Full Backend interface (WebGPU/WebGL) | WebGPU-only, direct GPU calls | ✅ Deliberate - no WebGL fallback |
| **LightsNode in cache key** | Included in ChainMap key | Not included - deferred | ✅ Documented future work |
| **ClippingContext** | Full clipping plane system | Not implemented | ⚠️ Future work |
| **RenderBundles** | Bundle caching system | Not implemented | ⚠️ Future work |
| **NodeMaterialObserver** | Monitors material for cache invalidation | Not implemented | ⚠️ Future work |

### 🔴 Not Yet Implemented (Future Work)

| Feature | Three.js | gpucat | Priority |
|---------|----------|--------|----------|
| **Lighting** | `LightsNode` in cache key, `Lighting` class | No lighting system | Medium |
| **Shadows** | `ShadowNode`, shadow pass rendering | No shadows | Medium |
| **Clipping Planes** | `ClippingContext` | Not implemented | Low |
| **XR/VR** | `XRManager` | Not implemented | Low |
| **Render Bundles** | `RenderBundles` | Not implemented | Low |
| **Background** | `Background` class | Not implemented | Low |
| **Info/Stats** | `Info` class with memory/render stats | Partial in buffers.ts | Low |

---

## Detailed System Comparison

### 1. Bindings System

**Three.js (`Bindings.js`):**
```javascript
class Bindings extends DataMap {
  getForRender(renderObject) {
    const bindings = renderObject.getBindings();
    for (const bindGroup of bindings) {
      const groupData = this.get(bindGroup);  // DataMap pattern
      if (groupData.bindGroup === undefined) {
        this._init(bindGroup);
        this.backend.createBindings(bindGroup, bindings, 0);
        groupData.bindGroup = bindGroup;
      }
    }
    return bindings;
  }
  
  _update(bindGroup, bindings) {
    // Check each binding for updates
    // Set needsBindingsUpdate = true if texture generation changed
    // Call backend.updateBindings() if needed
  }
}
```

**gpucat (`bindings.ts`):**
```typescript
function getData(state: BindingsState, bindGroup: BindGroup): BindGroupData {
  let data = state.data.get(bindGroup);
  if (!data) {
    data = { bindGroup: null, bindGroupLayout: null, needsUpdate: true };
    state.data.set(bindGroup, data);
  }
  return data;
}

function updateBindings(state, renderObject, ...) {
  const bindGroups = getRenderObjectBindings(renderObject);
  for (const bindGroup of bindGroups) {
    _initBindGroup(state, bindGroup, nodeState);
    _updateBindGroup(state, bindGroup, ...);
    if (data.needsUpdate) {
      _rebuildGPUBindGroup(state, bindGroup, data);
    }
  }
}
```

**Assessment:** ✅ Functionally identical. Both key by BindGroup identity, use DataMap/auto-create pattern.

---

### 2. RenderObject System

**Three.js (`RenderObject.js`):**
```javascript
class RenderObject {
  constructor(nodes, geometries, renderer, object, material, ...) {
    this._bindings = null;  // Lazy
  }
  
  getBindings() {
    return this._bindings || (this._bindings = this.getNodeBuilderState().createBindings());
  }
  
  getNodeBuilderState() {
    return this._nodeBuilderState || (this._nodeBuilderState = this._nodes.getForRender(this));
  }
}
```

**gpucat (`render-object.ts`):**
```typescript
type RenderObject = {
  _bindings: BindGroup[] | null;
  nodeBuilderState: NodeBuilderState | null;
  // ...
};

function getBindings(renderObject: RenderObject): BindGroup[] {
  if (!renderObject._bindings) {
    renderObject._bindings = createBindings(renderObject.nodeBuilderState!);
  }
  return renderObject._bindings;
}
```

**Assessment:** ✅ Identical pattern - lazy initialization via `getBindings()`.

---

### 3. NodeBuilderState.createBindings()

**Three.js (`NodeBuilderState.js`):**
```javascript
createBindings() {
  const bindings = [];
  for (const instanceGroup of this.bindings) {
    const shared = instanceGroup.bindings[0].groupNode.shared;
    if (shared !== true) {
      const bindingsGroup = new BindGroup(instanceGroup.name, []);
      for (const instanceBinding of instanceGroup.bindings) {
        bindingsGroup.bindings.push(instanceBinding.clone());
      }
      bindings.push(bindingsGroup);
    } else {
      bindings.push(instanceGroup);  // Reuse shared group
    }
  }
  return bindings;
}
```

**gpucat (`node-builder-state.ts`):**
```typescript
function createBindings(state: NodeBuilderState): BindGroup[] {
  const result: BindGroup[] = [];
  for (const templateGroup of state.bindings) {
    if (templateGroup.shared) {
      result.push(templateGroup);  // Reuse shared
    } else {
      result.push(cloneBindGroup(templateGroup));  // Clone non-shared
    }
  }
  return result;
}
```

**Assessment:** ✅ Identical - shared groups reused, non-shared cloned.

---

### 4. Texture/Sampler Change Detection

**Three.js (`Bindings.js`):**
```javascript
if (binding.isSampledTexture) {
  const texture = binding.texture;
  const texturesTextureData = this.textures.get(texture);
  
  // generation: update bindings if texture object changed
  if (binding.generation !== texturesTextureData.generation) {
    binding.generation = texturesTextureData.generation;
    needsBindingsUpdate = true;
  }
}
```

**gpucat (`bindings.ts`):**
```typescript
// For user textures
if (binding.generation !== texData.generation) {
  binding.generation = texData.generation;
  data.needsUpdate = true;
}

// For render target textures
const gpuTexture = value.gpuTexture;
if (gpuTexture !== binding.lastGpuTexture) {
  binding.lastGpuTexture = gpuTexture;
  data.needsUpdate = true;
}
```

**Assessment:** ✅ Aligned - gpucat uses `lastGpuTexture` for render targets (which Three.js handles via generation tracking in Textures module).

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        WebGPURenderer                           │
│  - Frame loop                                                   │
│  - Coordinates all subsystems                                   │
└───────────────────────────────┬─────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
        ▼                       ▼                       ▼
┌───────────────┐      ┌───────────────┐      ┌───────────────┐
│  RenderLists  │      │ RenderObjects │      │   Pipelines   │
│  (ChainMap)   │      │  (ChainMap)   │      │    (Cache)    │
└───────┬───────┘      └───────┬───────┘      └───────────────┘
        │                      │
        ▼                      ▼
┌───────────────┐      ┌───────────────┐
│  RenderList   │      │ RenderObject  │
│  - opaque[]   │      │ - mesh        │
│  - transp[]   │      │ - material    │
└───────────────┘      │ - _bindings ──┼──────────┐
                       └───────┬───────┘          │
                               │                  │
                               ▼                  ▼
                       ┌───────────────┐  ┌───────────────┐
                       │NodeBuilderState│  │   Bindings    │
                       │ - bindings[]   │  │ (WeakMap by   │
                       │ - createBindings()│ BindGroup)    │
                       └───────────────┘  └───────────────┘
                                                  │
                       ┌──────────────────────────┼──────────┐
                       │                          │          │
                       ▼                          ▼          ▼
               ┌───────────────┐          ┌───────────┐ ┌─────────┐
               │   BindGroup   │          │ Buffers   │ │Textures │
               │ (shared=true) │          │ (WeakMap) │ │(WeakMap)│
               │   REUSED      │          └───────────┘ └─────────┘
               └───────────────┘
               ┌───────────────┐
               │   BindGroup   │
               │ (shared=false)│
               │   CLONED      │
               └───────────────┘
```

---

## Remaining Work (Phase 4)

### Completed
- ✅ **Consolidated update deduplication** - Removed duplicate `_updateBeforeMap`, `_updateAfterMap`, `_updateMap` from renderer.ts. Now using `updateBefore()`, `updateForRender()`, `updateAfter()` from node-manager.ts with synced frameId/renderId.
- ✅ **7 of 8 old ad-hoc patterns removed** - `_renderGroupKeys`, `_objectGroupKeys`, `collectDraws`, etc.

### Acceptable Exceptions
- **`_outputMaterialCache`** - Keeps Material instances for fullscreen output passes to prevent stack overflow from rebuilding node subgraphs every frame. This is not a duplicate of any Three.js pattern; it's needed for gpucat's `render(outputNode)` API.

### Medium Priority
1. **Lighting system** - Add `LightsNode` to cache key
2. **Shadows** - Implement shadow pass rendering

### Low Priority
3. **ClippingContext** - Clipping plane support
4. **Info/Stats** - Memory and render statistics
5. **RenderBundles** - Bundle caching for static scenes

---

## Conclusion

gpucat's renderer is now **architecturally aligned** with Three.js WebGPURenderer. The core caching and state management patterns match:

- ✅ ChainMap for composite key caching (RenderObjects, RenderLists)
- ✅ DataMap pattern (WeakMap with auto-create)
- ✅ BindGroup-keyed bindings (shared groups reused, non-shared cloned)
- ✅ RenderObject as central per-draw-call state
- ✅ Lazy initialization via `getBindings()`/`getNodeBuilderState()`
- ✅ Version/generation tracking for dirty detection
- ✅ Render target texture change detection (fixed resize bug)

The main differences are:
1. **Functional style** (deliberate choice)
2. **WebGPU-only** (deliberate - no WebGL fallback)
3. **No lighting/shadows** (future work)
4. **No clipping/XR** (future work)
