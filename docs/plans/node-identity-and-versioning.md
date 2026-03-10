# Node Identity and Versioning Refactor

## Summary

Replace gpucat's content-addressable node IDs (`computeId`) with Three.js-style sequential IDs, and add `version`/`needsUpdate` to the base `Node` class for cache invalidation.

## Motivation

### Current Architecture (Content-Addressable)

```typescript
// Current: hash-based identity
export function computeId(kind: string, fields: Record<string, unknown>): string {
    return 'n_' + djb2(stableStringify({ kind, ...fields })).toString(36);
}

class BinopNode extends Node {
    constructor(op, type, left, right) {
        super(computeId('binop', { type, op, a: left.id, b: right.id }), type);
    }
}
```

**Problems:**
1. **Unnecessary overhead** - Every node construction does JSON stringify + hash
2. **Solves a non-problem** - Auto-deduplication assumes users write duplicate node graphs (they don't)
3. **Silent merging** - If users accidentally create "duplicate" nodes, they get silently merged, which may cause confusing bugs
4. **Diverges from Three.js** - Three.js uses sequential IDs with optional hash-based dedup at build time

### Three.js Architecture

```javascript
// Three.js: sequential ID, optional hash for dedup
let _nodeId = 0;

class Node {
    constructor() {
        this.id = _nodeId++;
        this.version = 0;
    }
    
    set needsUpdate(value) {
        if (value === true) this.version++;
    }
    
    getHash(builder) {
        return String(this.id);  // default: instance identity
    }
}
```

**Key insight:** Most Three.js nodes use default `getHash()` (no dedup). Only specific nodes like `TextureNode` override it to deduplicate by texture UUID.

## Design

### 1. Node Identity: Sequential IDs

Replace `computeId` with simple sequential counter:

```typescript
let _nodeId = 0;

export class Node<D extends Any> {
    readonly id: number;
    readonly type: D;
    
    constructor(type: D) {
        this.id = _nodeId++;
        this.type = type;
    }
}
```

### 2. Node Versioning: `version` and `needsUpdate`

Add version tracking to base Node class:

```typescript
export class Node<D extends Any> {
    readonly id: number;
    readonly type: D;
    
    private _version: number = 0;
    
    get version(): number {
        return this._version;
    }
    
    set needsUpdate(value: boolean) {
        if (value === true) {
            this._version++;
        }
    }
    
    // ... rest of Node
}
```

### 3. Build-Time Deduplication via `getHash`

Add optional hash method for build-time deduplication:

```typescript
export class Node<D extends Any> {
    // Default: instance identity (no dedup)
    getHash(_builder: WgslBuilder): string {
        return String(this.id);
    }
}
```

Override in specific node types where deduplication makes sense:

```typescript
// TextureNode - same texture = same node
class TextureNode extends Node<d.vec4f> {
    getHash(_builder: WgslBuilder): string {
        return `texture_${this.textureId}`;
    }
}

// AttributeNode - same attribute name = same node  
class AttributeNode extends Node {
    getHash(_builder: WgslBuilder): string {
        return `attr_${this.name}`;
    }
}

// BuiltinNode - same builtin = same node
class BuiltinNode extends Node {
    getHash(_builder: WgslBuilder): string {
        return `builtin_${this.builtinKind}`;
    }
}
```

### 4. Cache Key Computation

Add lazy cache key computation that incorporates version:

```typescript
export class Node<D extends Any> {
    private _cacheKey: number | null = null;
    private _cacheKeyVersion: number = 0;
    
    getCacheKey(force = false): number {
        if (force || this._version !== this._cacheKeyVersion || this._cacheKey === null) {
            this._cacheKey = this.computeCacheKey();
            this._cacheKeyVersion = this._version;
        }
        return this._cacheKey;
    }
    
    protected computeCacheKey(): number {
        // Hash based on node type and child cache keys
        // Implementation depends on node structure
        return hashCombine(this.id, this._version);
    }
}
```

### 5. Consumer: WgslBuilder Deduplication

The builder uses `getHash` during the build process:

```typescript
class WgslBuilder {
    private hashNodes: Map<string, Node<Any>> = new Map();
    
    getNodeFromHash(hash: string): Node<Any> | undefined {
        return this.hashNodes.get(hash);
    }
    
    setHashNode(node: Node<Any>, hash: string): void {
        this.hashNodes.set(hash, node);
    }
    
    // Called during build
    getShared(node: Node<Any>): Node<Any> {
        const hash = node.getHash(this);
        const existing = this.getNodeFromHash(hash);
        if (existing) return existing;
        this.setHashNode(node, hash);
        return node;
    }
}
```

### 6. Consumer: Pipeline/Shader Invalidation

The `needsUpdate`/`version` system enables cache invalidation:

```typescript
// In node-manager.ts or similar
export function needsRecompilation(
    material: Material,
    cachedVersion: number
): boolean {
    // Material's output node tree has changed
    return material.outputNode.getCacheKey() !== cachedVersion;
}

// In render loop
if (material.needsUpdate) {
    // This was set by user, triggers recompilation
    invalidatePipeline(renderObject);
    material.needsUpdate = false;
}
```

### 7. Consumer: UniformNode Value Updates

Align with Three.js: **no version tracking for uniform values**. Instead, use value comparison.

```typescript
class UniformNode<D extends Any> extends Node<D> {
    value: number | number[] | Float32Array | null = null;
    // NO version property for values - inherits Node.version for structural changes only
    
    onUpdate(callback, updateType) {
        this.updateType = updateType;
        this.update = (frame) => {
            const value = callback(frame);
            if (value !== undefined) {
                this.value = value;
                // NO version bump - renderer compares values directly
            }
        };
        return this;
    }
}
```

The renderer detects changes by comparing packed uniform values against a cached copy:

```typescript
// bindings.ts
function updateUniformBinding(...) {
    const packed = packUniformGroup(block);
    
    if (!arraysEqual(packed, binding.cachedValues)) {
        uploadBuffer(packed);
        binding.cachedValues = packed.slice();
    }
}
```

This aligns with Three.js's `UniformsGroup.update()` approach. See "Analysis" section below for details.

## Migration Steps

### Phase 1: Add `version`/`needsUpdate` to Node + Rename UniformNode.version

1. Rename `UniformNode.version` → `UniformNode.valueVersion`
2. Update `bindings.ts` to use `valueVersion` instead of `version`
3. Add `_version`, `version` getter, and `needsUpdate` setter to `Node` class
4. No breaking changes for external users (UniformNode.version was internal)

### Phase 2: Add `getHash` Infrastructure  

1. Add `getHash()` method to `Node` base class (returns `String(this.id)`)
2. Add `getShared()` helper method
3. Add `hashNodes` map to `WgslBuilder`
4. Update build process to use `getShared()` for deduplication

### Phase 3: Remove `computeId`

1. Update `Node` constructor to use sequential ID
2. Update all node subclasses to remove `computeId` calls:
   - `ConstNode`
   - `BinopNode`
   - `CallNode`
   - `ConstructNode`
   - `FieldNode`
   - `ArrayNode`
   - `IndexNode`
   - `AssignNode`
   - `CondNode`
   - `StructConstructNode`
   - `UniformNode`
   - `BuiltinNode`
   - `ComputeIndexNode`
   - `TextureNode`
   - `SamplerNode`
   - `AttributeNode`
   - `WgslFunctionNode`
   - `VaryingNode`
   - `SubBuildNode`
   - `WgslNode`

3. Add `getHash()` overrides where deduplication is needed:
   - `TextureNode` - by texture ID
   - `SamplerNode` - by sampler ID  
   - `AttributeNode` - by attribute name
   - `BuiltinNode` - by builtin kind
   - `VaryingNode` - by varying name

4. Delete `computeId`, `stableStringify`, `djb2` functions

### Phase 4: Integrate with Pipeline Cache

1. Update `needsNodeUpdate()` to use `getCacheKey()` comparison
2. Store cache key version on `RenderObject`
3. Invalidate pipeline when cache key changes

### Phase 5: Clean Up

1. Remove any remaining references to old ID format (`n_xxx`, `s_xxx`)
2. Update tests
3. Update documentation

## Files to Modify

| File | Changes |
|------|---------|
| `src/nodes/lib/core.ts` | Add version/needsUpdate to Node, remove computeId, update all node constructors |
| `src/nodes/lib/uniform.ts` | Update UniformNode constructor |
| `src/nodes/lib/builtin.ts` | Update BuiltinNode, add getHash |
| `src/nodes/lib/texture.ts` | Update TextureNode/SamplerNode, add getHash |
| `src/nodes/lib/attribute.ts` | Update AttributeNode, add getHash |
| `src/nodes/lib/wgsl-fn.ts` | Update WgslFunctionNode |
| `src/nodes/lib/varying.ts` | Update VaryingNode, add getHash |
| `src/nodes/lib/sub-build.ts` | Update SubBuildNode |
| `src/nodes/lib/wgsl.ts` | Update WgslNode |
| `src/renderer/wgsl-builder.ts` | Add hashNodes map, getShared() |
| `src/renderer/node-manager.ts` | Update needsNodeUpdate to use getCacheKey |
| `src/renderer/render-object.ts` | Store cache key version |

## Benefits

1. **Simpler mental model** - Nodes are instances, not content-addressed values
2. **Faster construction** - No hashing on every node creation
3. **Explicit deduplication** - Only where it makes sense (textures, attributes)
4. **Three.js alignment** - Same patterns, easier to understand for Three.js users
5. **Cache invalidation** - `needsUpdate = true` triggers recompilation
6. **Future-proof** - Ready for dynamic node graph modifications

## Analysis: Three.js vs gpucat Uniform Update Systems

### Three.js Architecture

**Source:** [`three.js/src/renderers/common/UniformsGroup.js`](https://github.com/mrdoob/three.js/blob/dev/src/renderers/common/UniformsGroup.js)

Three.js has **two separate class hierarchies** for uniforms:

#### 1. Node Hierarchy (TSL/Shader Graph)
```
Node → InputNode → UniformNode
```
- `UniformNode` is a **shader graph node** that represents a uniform in the node system
- Has `Node.version` (inherited) for structural changes
- Has `value` property that holds the actual uniform value
- **Does NOT have its own version for value changes**

#### 2. Uniform Hierarchy (GPU Buffer Binding)
```
Uniform → NumberUniform, Vector4Uniform, Matrix4Uniform, etc.
NumberNodeUniform extends NumberUniform (bridges to UniformNode)
```
- `Uniform` is a **GPU buffer binding** class for packing/uploading
- Has `getValue()` that returns current value
- `NumberNodeUniform.getValue()` returns `this.nodeUniform.value` (pulls from UniformNode)

#### How Three.js Detects Uniform Value Changes

**Source:** `UniformsGroup.js` lines 119-157

The `UniformsGroup` class has:
- `this._buffer` (Float32Array) - the GPU buffer data
- `this._values` (Array) - **cached copy** of previous values for comparison

```javascript
// UniformsGroup.js - lines 75-85
get values() {
    if ( this._values === null ) {
        this._values = Array.from( this.buffer );  // Cache is copy of buffer
    }
    return this._values;
}
```

The `update*` methods compare current values against `this.values` (the cache):

```javascript
// UniformsGroup.js - lines 163-182
updateNumber( uniform ) {
    let updated = false;
    
    const a = this.values;        // Cached values (Array)
    const v = uniform.getValue(); // Current value from UniformNode
    const offset = uniform.offset;
    const type = uniform.getType();
    
    if ( a[ offset ] !== v ) {    // Compare against cache
        const b = this._getBufferForType( type );
        
        b[ offset ] = a[ offset ] = v;  // Update BOTH buffer and cache
        updated = true;
        
        this.addUniformUpdateRange( uniform );  // Track which range changed
    }
    
    return updated;
}
```

Key pattern: `b[ offset ] = a[ offset ] = v` updates both:
- `b` (the GPU buffer via `this.buffer`)
- `a` (the cache via `this.values`)

#### Key Insight: Three.js UniformNode Has NO Version for Value Changes

**Source:** [`three.js/src/nodes/core/UniformNode.js`](https://github.com/mrdoob/three.js/blob/dev/src/nodes/core/UniformNode.js) lines 108-120

```javascript
// UniformNode.js - no version bumping!
onUpdate( callback, updateType ) {
    callback = callback.bind( this );
    return super.onUpdate( ( frame ) => {
        const value = callback( frame, this );
        if ( value !== undefined ) {
            this.value = value;  // Just assigns, no version++
        }
    }, updateType );
}
```

**Three.js relies entirely on value comparison in `UniformsGroup.update()`.**

### gpucat Current Architecture

gpucat takes a different approach with **version-based tracking**:

```typescript
// gpucat UniformNode
class UniformNode<D extends Any> extends Node<D> {
    value: number | number[] | Float32Array | null = null;
    version: number = 0;  // gpucat-specific!
    
    onUpdate(callback, updateType) {
        this.update = (frame) => {
            const value = callback(frame);
            if (value !== undefined) {
                this.value = value;
                this.version++;  // gpucat bumps version
            }
        };
    }
}
```

And the renderer uses version sum:
```typescript
// bindings.ts
let versionSum = 0;
for (const m of block.members) {
    versionSum += m.node.version;
}
if (versionSum !== binding.versionSum) {
    uploadBuffer(...);
}
```

### The Problem

1. `UniformNode.version` would **shadow** `Node.version` if we add versioning to the base class
2. Same property name with different semantics = confusing API
3. gpucat's approach diverges from Three.js patterns

### Solution: Full Three.js UniformsGroup Alignment

Implement the complete Three.js pattern including partial buffer uploads via `updateRanges`:

#### Three.js UniformsGroup Deep Dive

**Source:** [`UniformsGroup.js`](https://github.com/mrdoob/three.js/blob/dev/src/renderers/common/UniformsGroup.js)

Three.js `UniformsGroup` has three key data structures:

```javascript
class UniformsGroup extends UniformBuffer {
    _values = null;           // Array - cached previous values for comparison
    _buffer = null;           // Float32Array - the actual GPU buffer data  
    _updateRanges = [];       // Array<{start, count}> - which byte ranges changed
    _updateRangeCache = new Map();  // Map<uniformIndex, range> - deduplicates ranges
}
```

**The `values` getter** lazily creates the cache from the buffer:
```javascript
get values() {
    if (this._values === null) {
        this._values = Array.from(this.buffer);  // Copy buffer to array
    }
    return this._values;
}
```

**Per-uniform update methods** compare against cache and track ranges:
```javascript
updateNumber(uniform) {
    let updated = false;
    const a = this.values;        // Cache (Array)
    const v = uniform.getValue(); // Current value
    const offset = uniform.offset;
    
    if (a[offset] !== v) {
        const b = this.buffer;    // GPU buffer (Float32Array)
        b[offset] = a[offset] = v;  // Update BOTH
        updated = true;
        this.addUniformUpdateRange(uniform);  // Track range
    }
    return updated;
}

updateVector4(uniform) {
    const a = this.values;
    const v = uniform.getValue();
    const offset = uniform.offset;
    
    if (a[offset+0] !== v.x || a[offset+1] !== v.y || 
        a[offset+2] !== v.z || a[offset+3] !== v.w) {
        const b = this.buffer;
        b[offset+0] = a[offset+0] = v.x;
        b[offset+1] = a[offset+1] = v.y;
        b[offset+2] = a[offset+2] = v.z;
        b[offset+3] = a[offset+3] = v.w;
        this.addUniformUpdateRange(uniform);
        return true;
    }
    return false;
}
```

**Range tracking** with deduplication:
```javascript
addUniformUpdateRange(uniform) {
    const index = uniform.index;
    if (!this._updateRangeCache.has(index)) {
        const range = { start: uniform.offset, count: uniform.itemSize };
        this.updateRanges.push(range);
        this._updateRangeCache.set(index, range);
    }
}
```

**Partial GPU upload** in `WebGPUBindingUtils.updateBinding()`:
```javascript
updateBinding(binding) {
    const array = binding.buffer;
    const buffer = backend.get(binding).buffer;  // GPUBuffer
    const updateRanges = binding.updateRanges;
    
    if (updateRanges.length === 0) {
        // Full upload (first frame or clearUpdateRanges was called)
        device.queue.writeBuffer(buffer, 0, array, 0);
    } else {
        // Partial uploads - only changed ranges
        for (const range of updateRanges) {
            const byteOffset = range.start * 4;  // Float32 = 4 bytes
            const byteSize = range.count * 4;
            device.queue.writeBuffer(buffer, byteOffset, array, range.start, range.count);
        }
    }
}
```

### gpucat Implementation Design

#### 1. UniformBinding Changes

```typescript
// bind-group.ts
export type UniformBinding = {
    readonly kind: 'uniform';
    block: UniformGroupBlock;
    bufferKey: object | null;
    
    // NEW: Three.js-style value tracking
    /** GPU buffer data (Float32Array) */
    buffer: Float32Array | null;
    /** Cached previous values for comparison (Array copy of buffer) */
    cachedValues: number[] | null;
    /** Ranges that changed this frame */
    updateRanges: Array<{ start: number; count: number }>;
    /** Deduplicates ranges by member index */
    updateRangeCache: Map<number, { start: number; count: number }>;
    
    // REMOVED: versionSum (replaced by value diffing)
    // KEPT: lastProcessedVersion (for shared group deduplication)
    lastProcessedVersion: number;
};
```

#### 2. Per-Type Update Functions

```typescript
// bindings.ts
function updateScalar(
    buffer: Float32Array,
    cache: number[],
    offset: number,
    value: number,
    binding: UniformBinding,
    memberIndex: number,
): boolean {
    if (cache[offset] !== value) {
        buffer[offset] = cache[offset] = value;
        addUniformUpdateRange(binding, memberIndex, offset, 1);
        return true;
    }
    return false;
}

function updateVec4(
    buffer: Float32Array,
    cache: number[],
    offset: number,
    value: Float32Array | number[],
    binding: UniformBinding,
    memberIndex: number,
): boolean {
    const v = value as number[] | Float32Array;
    if (cache[offset] !== v[0] || cache[offset+1] !== v[1] || 
        cache[offset+2] !== v[2] || cache[offset+3] !== v[3]) {
        buffer[offset] = cache[offset] = v[0];
        buffer[offset+1] = cache[offset+1] = v[1];
        buffer[offset+2] = cache[offset+2] = v[2];
        buffer[offset+3] = cache[offset+3] = v[3];
        addUniformUpdateRange(binding, memberIndex, offset, 4);
        return true;
    }
    return false;
}

function addUniformUpdateRange(
    binding: UniformBinding,
    memberIndex: number,
    offset: number,
    count: number,
): void {
    if (!binding.updateRangeCache.has(memberIndex)) {
        const range = { start: offset, count };
        binding.updateRanges.push(range);
        binding.updateRangeCache.set(memberIndex, range);
    }
}

function clearUpdateRanges(binding: UniformBinding): void {
    binding.updateRanges.length = 0;
    binding.updateRangeCache.clear();
}
```

#### 3. Partial Buffer Upload

```typescript
// buffers.ts
export function uploadPartial(
    cache: BufferCache,
    key: object,
    buffer: Float32Array,
    updateRanges: Array<{ start: number; count: number }>,
): void {
    const gpuBuffer = getRaw(cache, key);
    if (!gpuBuffer) return;
    
    if (updateRanges.length === 0) {
        // Full upload
        cache.device.queue.writeBuffer(gpuBuffer, 0, buffer);
    } else {
        // Partial uploads
        for (const range of updateRanges) {
            const byteOffset = range.start * 4;
            cache.device.queue.writeBuffer(
                gpuBuffer,
                byteOffset,
                buffer,
                range.start,
                range.count
            );
        }
    }
}
```

#### 4. Updated updateUniformBinding

```typescript
function updateUniformBinding(
    state: BindingsState,
    binding: UniformBinding,
    bindGroup: BindGroup,
    frame: NodeFrame,
    data: BindGroupData,
): void {
    const block = binding.block;
    
    // Shared group deduplication gate (unchanged)
    if (block.groupNode.shared) {
        const groupVersion = block.groupNode.version;
        if (binding.lastProcessedVersion === groupVersion) return;
        binding.lastProcessedVersion = groupVersion;
    }
    
    // Invoke update callbacks
    invokeUniformGroupCallbacks(block, frame);
    
    // Initialize buffer and cache lazily
    if (binding.buffer === null) {
        const floatCount = Math.ceil(block.totalBytes / 4);
        binding.buffer = new Float32Array(floatCount);
        binding.cachedValues = new Array(floatCount).fill(0);
    }
    
    // Clear previous frame's update ranges
    clearUpdateRanges(binding);
    
    // Per-uniform value diffing
    let updated = false;
    const buf = binding.buffer;
    const cache = binding.cachedValues!;
    
    for (let i = 0; i < block.members.length; i++) {
        const m = block.members[i];
        const value = m.node.value;
        if (value === null) continue;
        
        const offset = m.offset / 4;  // Convert bytes to floats
        
        // Dispatch by type
        if (m.type === 'f32' || m.type === 'i32' || m.type === 'u32') {
            updated = updateScalar(buf, cache, offset, value as number, binding, i) || updated;
        } else if (m.type === 'vec4f') {
            updated = updateVec4(buf, cache, offset, value as Float32Array, binding, i) || updated;
        }
        // ... other types: vec2f, vec3f, mat3x3f, mat4x4f
    }
    
    // Upload only if something changed
    if (updated) {
        if (!binding.bufferKey) binding.bufferKey = {};
        
        // Ensure GPU buffer exists
        const U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
        const result = ensureBuffer(state.bufferCache, binding.bufferKey, buf.byteLength, U);
        
        if (result.created) {
            // New buffer - full upload, mark bind group dirty
            uploadFull(state.bufferCache, binding.bufferKey, buf);
            data.needsUpdate = true;
        } else {
            // Existing buffer - partial upload
            uploadPartial(state.bufferCache, binding.bufferKey, buf, binding.updateRanges);
        }
    }
}
```

### Benefits of Full Three.js Alignment

1. **Clean inheritance** - `Node.version` means structural changes everywhere
2. **No shadowing** - UniformNode doesn't override version semantics  
3. **Partial uploads** - Only changed bytes are sent to GPU
4. **Per-uniform tracking** - Precise change detection, no false positives
5. **Three.js patterns** - Familiar to developers, battle-tested
6. **Memory efficient** - Cache is a plain Array (no Float32Array overhead for comparison)

### Migration Steps (Updated)

**Phase 1: Uniform Value Diffing with Partial Uploads**

1. Remove `UniformNode.version` property
2. Remove `version++` from `UniformNode.onUpdate`
3. Add to `UniformBinding`: `buffer`, `cachedValues`, `updateRanges`, `updateRangeCache`
4. Remove `versionSum` and `packedBuffer` from `UniformBinding`
5. Implement per-type update functions: `updateScalar`, `updateVec2`, `updateVec3`, `updateVec4`, `updateMat3`, `updateMat4`
6. Implement `addUniformUpdateRange` and `clearUpdateRanges`
7. Add `uploadPartial` to buffers.ts
8. Rewrite `updateUniformBinding` with per-uniform diffing
9. Keep `UniformGroupNode.version` for shared group deduplication gating

**Phase 2-5: Node versioning, getHash, computeId removal (unchanged)**

## Open Questions (Resolved)

### ~~1. UniformNode version unification~~

**Resolved:** Remove `UniformNode.version` entirely. Value changes are detected by comparing current values against `cachedValues` in `UniformBinding` (Three.js pattern). This gives clean semantics:
- `Node.version` (future) - structural changes, shader recompilation
- `UniformBinding.cachedValues` - value comparison for buffer upload (no version tracking needed)

### 2. Cache key computation

How deep should `getCacheKey()` traverse? 

**Answer (from Three.js):** Traverse all children, but cache the result and only recompute when version changes:

```javascript
// Three.js Node.getCacheKey()
getCacheKey(force = false) {
    force = force || this.version !== this._cacheKeyVersion;
    
    if (force || this._cacheKey === null) {
        const values = [];
        for (const { childNode } of this._getChildren()) {
            values.push(childNode.getCacheKey(force));
        }
        this._cacheKey = hash(values, this.customCacheKey());
        this._cacheKeyVersion = this.version;
    }
    return this._cacheKey;
}
```

### 3. Global nodes

How does `global: true` interact with the hash system?

**Answer:** `global` is about WGSL code generation (declare once at module scope), not about deduplication. The `getHash()` system handles deduplication. These are orthogonal:
- `global: true` → emit WGSL declaration once at top of shader
- `getHash()` → deduplicate equivalent nodes during build

### 4. nextId() usage

Should `nextId()` (used by `VarNode`) be unified with `_nodeId`?

**Answer:** Yes. Currently:
- `_nodeCounter` produces `s_X` strings for VarNode
- `computeId` produces `n_X` strings for other nodes

After refactor:
- Single `_nodeId` counter produces sequential numbers for all nodes
- `VarNode.varName` remains separate (it's the WGSL variable name, not the node ID)
