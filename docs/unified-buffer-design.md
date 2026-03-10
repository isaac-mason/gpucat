# Unified Buffer Design

*Redesigning gpucat's buffer system to decouple storage buffers from shader nodes, enable buffer reuse across materials, and align naming with WebGPU.*

---

## Problem Statement

### Storage Buffer Coupling

Currently, `StorageNode` holds a direct reference to a `StorageBufferAttribute`:

```ts
// storage.ts line 26
export class StorageNode<D extends Any> extends Node<D> {
    readonly value: StorageBufferAttribute;
    // ...
}
```

This creates tight coupling:
- The buffer IS the node — can't swap buffers without mutating the node
- Different meshes using the same material can't have different storage buffers
- Double-buffering requires node mutation between frames
- Resizing a buffer requires creating a new node

**Goal**: Storage buffers should be owned by `Geometry` (like vertex attributes), and shader nodes should reference them by name.

### `instancedArray()` is Redundant

`instancedArray()` creates a `StorageInstancedBufferAttribute`, but the `isInstancedBufferAttribute` flag is **never checked for storage buffers** — only for vertex attributes (where it affects `stepMode`).

Storage buffers don't have a "step mode" concept in WebGPU. They're just buffers bound to a bind group, accessed via indexing. The `instancedArray()` name is misleading — it implies per-instance behavior, but storage access ignores the instanced flag entirely.

**Goal**: Remove `instancedArray()`. For buffers used as both storage AND per-instance vertex attributes, the `instanced` flag on `GpuBuffer` handles vertex layout generation.

---

## Current Architecture

### Class Hierarchy

```
BufferAttribute (base class)
├── StorageBufferAttribute
│   └── IndirectStorageBufferAttribute
└── InstancedBufferAttribute
    └── StorageInstancedBufferAttribute
```

### Key Files

| File | Purpose |
|------|---------|
| `src/core/attribute.ts` | Buffer classes (BufferAttribute, StorageBufferAttribute, etc.) |
| `src/geometry/geometry.ts` | Geometry class with `attributes: Map<string, BufferAttribute>` |
| `src/nodes/lib/storage.ts` | StorageNode — holds StorageBufferAttribute reference |
| `src/nodes/lib/attribute.ts` | AttributeNode, BufferAttributeNode |
| `src/renderer/buffers.ts` | GPU buffer upload (uploadVertex, uploadStorage, uploadIndex) |
| `src/renderer/bindings.ts` | Bind group creation, storage buffer binding |
| `src/renderer/geometries.ts` | Geometry initialization and attribute upload |
| `src/renderer/renderer.ts` | Draw call issuance, vertex buffer binding |

### How Storage Buffers Flow Today

1. **Creation**: User creates `StorageBufferAttribute` + `StorageNode`
   ```ts
   const attr = new StorageBufferAttribute(data, 4);
   const particles = storage(attr, d.array(d.vec4f), 'read_write');
   ```

2. **Compilation**: `builder.ts` compiles the node graph, extracts `StorageEntry[]`:
   ```ts
   // builder.ts output
   storageEntries: [
     { group: 1, binding: 0, name: 'particles', type: 'array<vec4f>', node: StorageNode }
   ]
   ```

3. **Binding**: `bindings.ts` builds bind groups, calls `uploadStorage(node)`:
   ```ts
   // bindings.ts line 490
   case 'storage': {
       const buf = uploadStorage(state.bufferCache, binding.entry.node);
       entries.push({ binding: binding.entry.binding, resource: { buffer: buf } });
       break;
   }
   ```

4. **Upload**: `buffers.ts` gets data from `node.value.array`:
   ```ts
   // buffers.ts line 168
   export function uploadStorage(cache: BufferCache, node: StorageNode<Any>): GPUBuffer {
       const arr = node.value.array;  // <-- coupling: node holds the buffer
       // ...
   }
   ```

### How Vertex Attributes Flow Today

1. **Geometry owns the buffers**:
   ```ts
   geometry.setAttribute('position', new BufferAttribute(positions, 3));
   geometry.setAttribute('normal', new BufferAttribute(normals, 3));
   ```

2. **Shader declares by name**:
   ```ts
   const position = attribute('position', d.vec3f);
   ```

3. **Renderer resolves at draw time**:
   ```ts
   // renderer.ts line 644
   const bufAttr = geometry.attributes.get(attrEntry.name);
   buffers.uploadVertex(this.buffers, bufAttr);
   ```

4. **Vertex buffers bound to slots**:
   ```ts
   // renderer.ts line 1698
   pass.setVertexBuffer(slot, buffer);
   ```

**Key insight**: Vertex attributes are already decoupled — the shader says "I need position", the geometry provides it. Storage buffers should work the same way.

---

## Proposed Design

### 1. Unified `GpuBuffer<T>` Class

Replace the `BufferAttribute` hierarchy with a single typed buffer class.

```ts
// src/core/buffer.ts

import type { Any } from '../nodes/schema';

export type BufferUsage = 'vertex' | 'index' | 'storage' | 'uniform' | 'indirect';

export type GpuBufferOptions<T extends Any> = {
    /** Initial data (TypedArray) or element count (number) */
    data?: GpuTypedArray | number;
    /** Allowed usages for this buffer */
    usage?: BufferUsage | BufferUsage[];
    /** For vertex buffers: byte stride between elements (0 = tightly packed) */
    stride?: number;
    /** For vertex buffers: byte offset within each element */
    offset?: number;
    /** For vertex buffers: whether this is per-instance data */
    instanced?: boolean;
    /** TypedArray constructor when data is a count */
    arrayType?: new (length: number) => GpuTypedArray;
};

export class Buffer<T extends Any> {
    /** Type descriptor (d.vec3f, d.array(Particle), etc.) */
    readonly schema: T;
    
    /** Allowed usages */
    readonly usage: Set<BufferUsage>;
    
    /** CPU-side typed array (nullable after GPU upload) */
    array: GpuTypedArray | null;
    
    /** Number of elements */
    readonly count: number;
    
    /** Components per element (e.g., 3 for vec3f) */
    readonly itemSize: number;
    
    /** Version for dirty tracking */
    version: number = 0;
    
    /** Pending partial-upload ranges */
    readonly updateRanges: UpdateRange[] = [];
    
    /** Callback after GPU upload (e.g., release CPU memory) */
    onUpload: (() => void) | null = null;
    
    // Vertex-specific fields
    readonly stride: number;
    readonly offset: number;
    readonly format?: GPUVertexFormat;
    readonly instanced: boolean;
    
    constructor(schema: T, options: BufferOptions<T> = {}) {
        this.schema = schema;
        this.usage = normalizeUsage(options.usage);
        this.stride = options.stride ?? 0;
        this.offset = options.offset ?? 0;
        this.instanced = options.instanced ?? false;
        
        // Derive itemSize from schema
        this.itemSize = itemSizeOf(schema);
        
        // Create or use provided array
        const ArrayCtor = options.arrayType ?? Float32Array;
        if (typeof options.data === 'number') {
            this.array = new ArrayCtor(options.data * this.itemSize);
            this.count = options.data;
        } else if (options.data) {
            this.array = options.data;
            this.count = options.data.length / this.itemSize;
        } else {
            this.array = null;
            this.count = 0;
        }
        
        // Derive vertex format from schema
        if (this.usage.has('vertex')) {
            this.format = deriveVertexFormat(this.array, this.itemSize);
        }
    }
    
    /** Mark buffer as needing re-upload */
    set needsUpdate(v: true) {
        this.version++;
    }
    
    /** Register a dirty range for partial re-upload */
    addUpdateRange(start: number, count: number): void {
        this.updateRanges.push({ start, count });
    }
    
    /** Clear pending update ranges (called by renderer after upload) */
    clearUpdateRanges(): void {
        this.updateRanges.length = 0;
    }
}

function normalizeUsage(usage?: BufferUsage | BufferUsage[]): Set<BufferUsage> {
    if (!usage) return new Set(['vertex']);
    if (Array.isArray(usage)) return new Set(usage);
    return new Set([usage]);
}
```

### 2. Geometry with Unified Buffer Map

```ts
// src/geometry/geometry.ts

export class Geometry {
    /**
     * Named buffers — vertex attributes, storage buffers, anything.
     * The usage is determined by the buffer itself and how shaders reference it.
     */
    readonly buffers: Map<string, Buffer<Any>> = new Map();
    
    /** Index buffer (special case — always uint16/uint32, separate from buffers map) */
    index?: Buffer<d.u16 | d.u32>;
    
    /** Indirect draw buffer */
    indirect?: Buffer<Any>;
    
    // ... existing fields (boundingBox, boundingSphere, etc.)
    
    /**
     * Set a named buffer.
     * Replaces setAttribute() for vertex data and adds storage buffer support.
     */
    setBuffer(name: string, buffer: Buffer<Any>): this {
        const isNew = !this.buffers.has(name);
        this.buffers.set(name, buffer);
        if (isNew) this.version++;
        return this;
    }
    
    /**
     * Get a named buffer with type checking.
     */
    getBuffer<T extends Any>(name: string): Buffer<T> | undefined {
        return this.buffers.get(name) as Buffer<T> | undefined;
    }
    
    /**
     * Remove a named buffer.
     */
    deleteBuffer(name: string): this {
        if (this.buffers.delete(name)) {
            this.version++;
        }
        return this;
    }
}
```

### 3. Storage Node: Two Forms

The storage node supports two explicit forms:

1. **Named reference**: Resolved from `geometry.buffers` at render time
2. **Value reference**: Buffer provided directly on the node (mutable via `.value`)

Both are first-class features, not "legacy" vs "new".

```ts
// src/nodes/lib/storage.ts

/**
 * StorageNode — declares a storage buffer binding.
 * 
 * Two forms:
 * 1. Named reference: resolved from geometry.buffers at render time
 * 2. Value reference: buffer provided directly, can be swapped via .value
 */
export class StorageNode<D extends Any> extends Node<D> {
    /** Buffer name (for geometry.buffers lookup) — null if value-based */
    readonly bufferName: string | null;
    
    /** Direct buffer reference — null if name-based */
    private _value: Buffer<D> | null;
    
    /** WGSL array type string */
    readonly storageType: string;
    
    /** Access mode */
    readonly access: 'read' | 'read_write';
    
    /** Uniform group for @group index */
    groupNode: UniformGroupNode;
    
    constructor(
        schema: D,
        nameOrBuffer: string | Buffer<D>,
        access: 'read' | 'read_write' = 'read',
        groupNode: UniformGroupNode = objectGroup
    ) {
        super(schema);
        
        if (typeof nameOrBuffer === 'string') {
            this.bufferName = nameOrBuffer;
            this._value = null;
        } else {
            this.bufferName = null;
            this._value = nameOrBuffer;
        }
        
        this.storageType = schema.wgslType;
        this.access = access;
        this.groupNode = groupNode;
    }
    
    /** Whether this is a named reference (vs value-based) */
    get isNamedReference(): boolean {
        return this.bufferName !== null;
    }
    
    /** Get the current buffer value (for value-based nodes) */
    get value(): Buffer<D> | null {
        return this._value;
    }
    
    /** Set a new buffer value (for value-based nodes). Allows swapping buffers. */
    set value(buffer: Buffer<D> | null) {
        if (this.bufferName !== null) {
            throw new Error('[gpucat] Cannot set .value on a name-based storage node');
        }
        this._value = buffer;
    }
}

/**
 * Create a storage buffer node.
 * 
 * @example Named reference (resolved from geometry.buffers)
 * const particles = storage('particles', d.array(Particle), 'read_write');
 * 
 * @example Value reference (buffer provided directly, swappable)
 * const particles = storage(myBuffer, d.array(Particle), 'read_write');
 * particles.value = otherBuffer;  // swap buffers
 */
export function storage<D extends Any>(
    nameOrBuffer: string | Buffer<D>,
    schema: D,
    access: 'read' | 'read_write' = 'read'
): StorageNode<D> {
    return new StorageNode(schema, nameOrBuffer, access, objectGroup);
}
```

### 4. Updated Renderer Resolution

The upload path is always initiated by nodes. The renderer walks the node graph, encounters storage nodes, and resolves buffers either from geometry (named) or from the node itself (value).

```ts
// src/renderer/buffers.ts

/**
 * Get or create a GPUBuffer for a StorageNode.
 * 
 * For named references, the buffer is resolved from geometry.buffers.
 * For value references, the buffer is taken from node.value.
 */
export function uploadStorage(
    cache: BufferCache,
    node: StorageNode<Any>,
    geometry: Geometry  // <-- geometry context for name resolution
): GPUBuffer {
    // Resolve the actual buffer
    let buffer: Buffer<Any> | undefined;
    
    if (node.isNamedReference) {
        buffer = geometry.buffers.get(node.bufferName!);
        if (!buffer) {
            throw new Error(
                `[gpucat] uploadStorage: buffer '${node.bufferName}' not found in geometry.buffers`
            );
        }
    } else {
        buffer = node.value ?? undefined;
        if (!buffer) {
            throw new Error('[gpucat] uploadStorage: node.value is null');
        }
    }
    
    // Validate usage
    if (!buffer.usage.has('storage')) {
        throw new Error(
            `[gpucat] uploadStorage: buffer '${node.bufferName ?? '(value)'}' does not have 'storage' usage`
        );
    }
    
    const arr = buffer.array;
    if (!arr) {
        // CPU memory released — return existing GPU buffer
        const entry = cache.storageMap.get(buffer);
        if (!entry) {
            throw new Error('[gpucat] uploadStorage: buffer.array is null but GPU buffer was never created');
        }
        return entry.buf;
    }
    
    // ... rest of upload logic, keyed by Buffer (not node)
}
```

### 5. Bindings Update

```ts
// src/renderer/bindings.ts

function rebuildGPUBindGroup(
    state: BindingsState,
    bindGroup: BindGroup,
    data: BindGroupData,
    geometry: Geometry  // <-- geometry context
): void {
    // ...
    
    for (const binding of bindGroup.bindings) {
        switch (binding.kind) {
            case 'storage': {
                const buf = uploadStorage(
                    state.bufferCache,
                    binding.entry.node,
                    geometry  // <-- pass geometry for resolution
                );
                entries.push({ binding: binding.entry.binding, resource: { buffer: buf } });
                break;
            }
            // ...
        }
    }
}
```

---

## Usage Examples

### Basic Storage Buffer (Named)

```ts
// Create typed buffer
const particleBuffer = new Buffer(d.array(Particle, 10000), {
    usage: 'storage',
});

// Initialize data
const arr = particleBuffer.array as Float32Array;
for (let i = 0; i < 10000; i++) {
    arr[i * 8 + 0] = Math.random() * 10 - 5;  // position.x
    arr[i * 8 + 1] = Math.random() * 10;       // position.y
    // ...
}

// Attach to geometry
geometry.setBuffer('particles', particleBuffer);

// Shader references by name
const particles = storage('particles', d.array(Particle), 'read_write');
```

### Same Material, Different Buffers

```ts
const material = new Material();
material.computeNode = myComputeShader;  // uses storage('particles', ...)

// Mesh A with its own particles
const geometryA = new Geometry();
geometryA.setBuffer('particles', particleBufferA);
const meshA = new Mesh(geometryA, material);

// Mesh B with different particles — same material!
const geometryB = new Geometry();
geometryB.setBuffer('particles', particleBufferB);
const meshB = new Mesh(geometryB, material);
```

### Double-Buffering (Named)

```ts
const bufferA = new Buffer(d.array(Particle, N), { usage: 'storage' });
const bufferB = new Buffer(d.array(Particle, N), { usage: 'storage' });

let current = bufferA;
let next = bufferB;

function update() {
    // Swap buffers by updating geometry
    geometry.setBuffer('particlesIn', current);
    geometry.setBuffer('particlesOut', next);
    
    renderer.compute(updateParticles);
    
    [current, next] = [next, current];
}
```

### Double-Buffering (Value-Based)

```ts
const bufferA = new Buffer(d.array(Particle, N), { usage: 'storage' });
const bufferB = new Buffer(d.array(Particle, N), { usage: 'storage' });

// Value-based storage nodes — swappable
const particlesIn = storage(bufferA, d.array(Particle), 'read');
const particlesOut = storage(bufferB, d.array(Particle), 'read_write');

function update() {
    renderer.compute(updateParticles);
    
    // Swap by reassigning .value
    const temp = particlesIn.value;
    particlesIn.value = particlesOut.value;
    particlesOut.value = temp;
}
```

### Dual-Use Buffer (Storage + Vertex)

```ts
// Buffer usable as both storage and vertex attribute
const transforms = new Buffer(d.array(d.mat4x4f, 1000), {
    usage: ['storage', 'vertex'],
    instanced: true,
});

geometry.setBuffer('transforms', transforms);

// Compute shader writes to it
const transformsStorage = storage('transforms', d.array(d.mat4x4f), 'read_write');

// Vertex shader reads from it as instanced attribute
const instanceMatrix = attribute('transforms', d.mat4x4f);  // instanced auto-detected
```

---

## Implementation Plan

This is a big-bang change — we replace the old buffer classes entirely.

### Step 1: Create `Buffer<T>` Class

Create `src/core/buffer.ts`:
- `Buffer<T>` class with schema, usage, array, version, etc.
- `BufferUsage` type
- `BufferOptions<T>` type
- Helper functions (normalizeUsage, deriveVertexFormat)

### Step 2: Update Geometry

Update `src/geometry/geometry.ts`:
- Replace `attributes: Map<string, BufferAttribute>` with `buffers: Map<string, Buffer<Any>>`
- Add `setBuffer()`, `getBuffer()`, `deleteBuffer()` methods
- Keep `index` separate (special uint16/uint32 handling)
- Update `indirect` to use `Buffer<Any>`

### Step 3: Update StorageNode

Update `src/nodes/lib/storage.ts`:
- `StorageNode` accepts `string | Buffer<D>`
- Add `bufferName` and `_value` fields
- Add `.value` getter/setter for swappable value-based nodes
- Update `storage()` function signature

### Step 4: Update AttributeNode / BufferAttributeNode

Update `src/nodes/lib/attribute.ts`:
- Update to work with `Buffer<T>` instead of `BufferAttribute`
- Keep `attribute('name', schema)` API unchanged (WGSL emission differs from storage)

### Step 5: Update BufferCache

Update `src/renderer/buffers.ts`:
- Change `storageMap` key from `StorageNode` to `Buffer`
- Change `vertexMap` key from `BufferAttribute` to `Buffer`
- Update `uploadStorage()` to accept geometry, resolve named/value references
- Update `uploadVertex()` to work with `Buffer`
- Update `uploadIndex()` to work with `Buffer`

### Step 6: Update Bindings

Update `src/renderer/bindings.ts`:
- Pass geometry to `rebuildGPUBindGroup()`
- Pass geometry to `uploadStorage()` calls

### Step 7: Update Geometries System

Update `src/renderer/geometries.ts`:
- Work with `geometry.buffers` instead of `geometry.attributes`
- Upload all buffers based on their usage flags

### Step 8: Update Renderer

Update `src/renderer/renderer.ts`:
- Pass geometry context through binding calls
- Update vertex buffer binding to use `Buffer`

### Step 9: Delete Old Classes

Remove from `src/core/attribute.ts`:
- `BufferAttribute`
- `StorageBufferAttribute`
- `InstancedBufferAttribute`
- `StorageInstancedBufferAttribute`
- `IndirectStorageBufferAttribute`

Keep only:
- `IndexAttribute` (or fold into `Buffer` with index usage)
- Type helpers (`GpuTypedArray`, `UpdateRange`, `deriveVertexFormat`)

### Step 10: Update Examples

Update all examples to use the new API.

---

## Renderer Changes Summary

### buffers.ts

| Function | Change |
|----------|--------|
| `uploadStorage()` | Add `geometry` param, resolve named/value references |
| `uploadVertex()` | Work with `Buffer` instead of `BufferAttribute` |
| `uploadIndex()` | Work with `Buffer` instead of `IndexAttribute` |
| `BufferCache.storageMap` | Key by `Buffer` instead of `StorageNode` |
| `BufferCache.vertexMap` | Key by `Buffer` instead of `BufferAttribute` |

### bindings.ts

| Function | Change |
|----------|--------|
| `updateBindings()` | Pass geometry to `rebuildGPUBindGroup()` |
| `rebuildGPUBindGroup()` | Add `geometry` param, pass to `uploadStorage()` |

### geometries.ts

| Function | Change |
|----------|--------|
| `initGeometry()` | Work with `geometry.buffers`, upload based on usage flags |
| `updateForRender()` | Work with `geometry.buffers` |

### renderer.ts

| Function | Change |
|----------|--------|
| Binding calls | Pass `renderObject.geometry` to binding functions |

---

## Builder Changes

The builder (`builder.ts`) compiles the node graph to WGSL and extracts binding metadata. Changes needed:

1. **StorageEntry** — add `bufferName` field:
   ```ts
   export type StorageEntry = {
       group: number;
       binding: number;
       name: string;
       type: string;
       node: StorageNode<Any>;
       bufferName: string | null;  // <-- for named references
   };
   ```

2. **WGSL emission** — no change (still emits `@group(N) @binding(M) var<storage> name: type`)

3. **Binding metadata** — the renderer uses `StorageEntry` to build bind groups. It will now use `bufferName` to resolve from geometry.

---

## Design Decisions

### Index Buffer: Keep Separate

`geometry.index` stays separate from `geometry.buffers` because:
- Index buffers have special semantics (`setIndexBuffer` takes a format param)
- Only uint16/uint32 allowed
- Single index buffer per geometry (not named)

### Attribute vs Storage: Keep Separate

`attribute()` and `storage()` remain separate functions because:
- Different WGSL emission (vertex inputs vs bind group resources)
- Different shader stages (vertex stage inputs vs any stage bindings)
- Different resolution paths (vertex buffer slots vs bind groups)

### Compute-Only Storage

For compute shaders that don't render (no geometry), use value-based storage:

```ts
const dataIn = storage(inputBuffer, d.array(d.f32), 'read');
const dataOut = storage(outputBuffer, d.array(d.f32), 'read_write');

renderer.compute(myComputeShader);  // no geometry needed
```

The value-based form doesn't require geometry resolution.

Future consideration: `renderer.compute()` could accept an optional `buffers` map for more explicit control.

---

## Type Safety Considerations

### Schema Matching

When `geometry.setBuffer('particles', buffer)` is called, there's no compile-time check that the buffer's schema matches what the shader expects.

Options:
1. **Runtime check**: Compare `buffer.schema.wgslType` with `node.storageType` at bind time
2. **Type-safe wrapper** (future): Typed geometry that enforces schema matching

For now, runtime checks are acceptable — this matches how vertex attributes work.

### Buffer Usage Validation

When uploading, validate that the buffer has the required usage:
```ts
if (!buffer.usage.has('storage')) {
    throw new Error(`[gpucat] Buffer '${name}' is not configured for storage usage`);
}
```

---

## Summary

| Before | After |
|--------|-------|
| `BufferAttribute` | `Buffer<T>` with `usage: 'vertex'` |
| `StorageBufferAttribute` | `Buffer<T>` with `usage: 'storage'` |
| `InstancedBufferAttribute` | `Buffer<T>` with `instanced: true` |
| `StorageInstancedBufferAttribute` | `Buffer<T>` with `usage: ['storage', 'vertex'], instanced: true` |
| `IndirectStorageBufferAttribute` | `Buffer<T>` with `usage: ['storage', 'indirect']` |
| `geometry.attributes` | `geometry.buffers` |
| `storage(attr, schema)` | `storage('name', schema)` or `storage(buffer, schema)` |
| Buffer coupled to node | Buffer owned by geometry OR swappable via `.value` |

This design:
- **Decouples** storage buffers from shader nodes
- **Enables** buffer reuse across materials
- **Provides** two explicit forms: named (geometry-owned) and value (node-owned, swappable)
- **Aligns** with WebGPU concepts (one `Buffer` class for all usages)
- **Simplifies** the class hierarchy (one class instead of five)
