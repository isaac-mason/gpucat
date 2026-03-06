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
