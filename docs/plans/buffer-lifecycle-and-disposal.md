# Buffer Lifecycle and Disposal Plan

## Overview

Implement a proper GPU resource disposal system for gpucat, with explicit lifecycle management for `GpuBuffer`. The design is inspired by Babylon.js's `_ownsBuffer` pattern but adapted to gpucat's simpler architecture (no VertexBuffer wrapper layer).

## Core Concept

Each `GpuBuffer` has a `lifecycle` mode that determines how disposal is handled:

```ts
export enum BufferLifecycle {
  REF_COUNTED,  // Library tracks references, disposes when refCount hits 0
  MANUAL,       // User is responsible for calling buffer.dispose()
}
```

## Changes to GpuBuffer

### New Fields

```ts
class GpuBuffer<T extends Any> {
  // Existing fields...
  
  /** How this buffer's lifecycle is managed */
  readonly lifecycle: BufferLifecycle;
  
  /** Usage count (only used when lifecycle === REF_COUNTED) */
  _usages: number;
}
```

### Constructor Changes

```ts
export interface GpuBufferOptions<T extends Any> {
  data?: InferGpuBufferData<T> | number;
  usage?: BufferUsage;
  lifecycle?: BufferLifecycle;  // NEW - defaults to MANUAL
}

new GpuBuffer(schema, {
  data: positions,
  usage: 'vertex',
  lifecycle: BufferLifecycle.MANUAL,  // explicit
})
```

### New Methods

```ts
class GpuBuffer<T extends Any> {
  /** Increment usage count. Only valid for REF_COUNTED buffers. */
  increaseUsages(): this;
  
  /** Decrement usage count. Disposes if count reaches 0. Only valid for REF_COUNTED buffers. */
  decreaseUsages(): void;
  
  /** Existing dispose() - behavior depends on lifecycle */
  dispose(): void;
}
```

### Dispose Behavior

| Lifecycle | `dispose()` behavior |
|-----------|---------------------|
| `MANUAL` | Immediately destroys GPU buffer via `_onDispose()` |
| `REF_COUNTED` | Throws error - use `decreaseUsages()` instead |

| Lifecycle | `decreaseUsages()` behavior |
|-----------|---------------------|
| `MANUAL` | Throws error - use `dispose()` instead |
| `REF_COUNTED` | Decrements usages, disposes if 0 |

## Geometry Integration

### How RefCounting Works

When a `REF_COUNTED` buffer is added to a geometry:

```ts
geometry.setBuffer('position', buffer);
// If buffer.lifecycle === REF_COUNTED:
//   buffer._usages++
```

When geometry is disposed or buffer is removed:

```ts
geometry.dispose();
// For each buffer in geometry.buffers:
//   If buffer.lifecycle === REF_COUNTED:
//     buffer.decreaseUsages()  // decrements usages, may dispose
```

### Manual Buffers

Manual buffers are completely ignored by geometry disposal:

```ts
const sharedBuffer = new GpuBuffer(d.vec3f, {
  data: positions,
  usage: 'vertex',
  lifecycle: BufferLifecycle.MANUAL,
});

// Use in multiple geometries
geo1.setBuffer('position', sharedBuffer);
geo2.setBuffer('position', sharedBuffer);

// Disposing geometries does nothing to the buffer
geo1.dispose();
geo2.dispose();

// User must dispose manually when done
sharedBuffer.dispose();
```

## Factory Helper Functions

Create utility functions with sensible defaults:

### createVertexBuffer

```ts
export function createVertexBuffer<T extends Any>(
  schema: T,
  data: InferGpuBufferData<T>,
  opts?: { lifecycle?: BufferLifecycle }
): GpuBuffer<T>

// Defaults:
// - usage: 'vertex'
// - lifecycle: BufferLifecycle.MANUAL (shared buffers are common)
```

### createStorageBuffer

```ts
export function createStorageBuffer<T extends Any>(
  schema: T,
  data: InferGpuBufferData<T> | number,
  opts?: { lifecycle?: BufferLifecycle }
): GpuBuffer<T>

// Defaults:
// - usage: 'storage'
// - lifecycle: BufferLifecycle.REF_COUNTED (typically owned by one thing)
```

### createUniformBuffer

```ts
export function createUniformBuffer<T extends Any>(
  schema: T,
  data?: InferGpuBufferData<T>,
  opts?: { lifecycle?: BufferLifecycle }
): GpuBuffer<T>

// Defaults:
// - usage: 'uniform'
// - lifecycle: BufferLifecycle.REF_COUNTED
```

### createIndirectBuffer

```ts
export function createIndirectBuffer<T extends Any>(
  schema: T,
  data: InferGpuBufferData<T> | number,
  opts?: { lifecycle?: BufferLifecycle }
): GpuBuffer<T>

// Defaults:
// - usage: 'indirect' (maps to STORAGE | INDIRECT | COPY_DST)
// - lifecycle: BufferLifecycle.REF_COUNTED
```

## Geometry Factory Helpers

Update existing geometry factories to use REF_COUNTED buffers:

```ts
export function createBoxGeometry(width = 1, height = 1, depth = 1): Geometry {
  // ...
  const geom = new Geometry();
  
  geom.setBuffer('position', new GpuBuffer(d.vec3f, {
    data: new Float32Array(positions),
    usage: 'vertex',
    lifecycle: BufferLifecycle.REF_COUNTED,  // NEW
  }));
  
  // ... same for normal, uv buffers
  
  return geom;
}
```

Now `geometry.dispose()` automatically cleans up all buffers for factory-created geometries.

## Implementation Order

1. **Add BufferLifecycle enum** to `src/core/buffer.ts`

2. **Update GpuBuffer class:**
   - Add `lifecycle` field
   - Add `_usages` field
   - Add `increaseUsages()` and `decreaseUsages()` methods
   - Update `dispose()` to check lifecycle

3. **Update Geometry class:**
   - Track which buffers need usage management in `setBuffer()`
   - Call `increaseUsages()` when adding REF_COUNTED buffers
   - Call `decreaseUsages()` when removing/disposing REF_COUNTED buffers

4. **Create factory helpers:**
   - `createVertexBuffer()`
   - `createStorageBuffer()`
   - `createUniformBuffer()`
   - `createIndirectBuffer()`

5. **Update geometry helpers:**
   - `createBoxGeometry()` - use REF_COUNTED
   - `createSphereGeometry()` - use REF_COUNTED
   - `createPlaneGeometry()` - use REF_COUNTED
   - `createFullscreenTriangleGeometry()` - use REF_COUNTED

6. **Tests / Examples:**
   - Verify factory geometries clean up on dispose
   - Verify shared MANUAL buffers survive geometry disposal
   - Verify REF_COUNTED buffers dispose at correct time

## Open Questions

1. **What happens if a disposed buffer is added to a geometry?**
   - Probably should throw an error immediately

2. **What happens if increaseUsages() is called on a disposed REF_COUNTED buffer?**
   - Buffer is "revived" - `disposed` set back to false, `_usages` incremented
   - CPU-side data can be re-uploaded on next render
   - Enables buffer pooling/reuse patterns

3. **Should we warn in dev mode when MANUAL buffers are "orphaned"?**
   - Could track all MANUAL buffers and warn if they're never disposed
   - Nice for catching leaks, but adds overhead

4. **Texture lifecycle?**
   - Same pattern could apply to Texture
   - Defer for now, implement if needed
