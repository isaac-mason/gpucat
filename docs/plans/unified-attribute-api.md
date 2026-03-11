# Plan: Unified `attribute()` API

## Summary

Merge `attribute()`, `bufferAttribute()`, and `instancedBufferAttribute()` into a single unified `attribute()` function. View info (`stride`, `offset`, `instanced`) lives on the `AttributeNode`, not on `GpuBuffer`.

Interleaved buffer grouping (renderer optimization) is out of scope and will be a follow-up.

## Motivation

- Three separate functions for the same concept is confusing
- View info (`stride`, `offset`) belongs on the node (how you read), not the buffer (the data)
- Aligns with Three.js TSL pattern where `BufferAttributeNode` carries view info
- `GpuBuffer` should just be a buffer - no view semantics

## API After Changes

```ts
// By-name (geometry lookup)
const pos = attribute('position', d.vec3f);
const uv = attribute('uv', d.vec2f);

// By-name with view options
const pos = attribute('position', d.vec3f, { stride: 32, offset: 0 });

// Direct GpuBuffer (schema from buffer)
const colors = attribute(colorBuffer);

// Direct GpuBuffer with view options
const position = attribute(interleavedBuffer, { stride: 32, offset: 0 });
const normal = attribute(interleavedBuffer, { stride: 32, offset: 12 });

// Raw TypedArray (auto-wrapped in GpuBuffer)
const offsets = attribute(offsetData, d.vec3f);
const offsets = attribute(offsetData, d.vec3f, { stride: 32, offset: 0 });

// Instanced
const instanceMatrix = attribute(matricesBuffer, { stride: 64, offset: 0, instanced: true });

// uv() helper unchanged
const texCoord = uv();
const lightmapUV = uv(1);
```

## Type Signatures

```ts
type AttributeOptions = {
    stride?: number;     // byte stride between elements (default: 0 = tightly packed)
    offset?: number;     // byte offset within stride (default: 0)
    instanced?: boolean; // stepMode: 'instance' (default: false)
};

// Overload 1: By name (geometry lookup)
function attribute<D extends Any>(
    name: string,
    schema: D,
    options?: AttributeOptions
): AttributeNode<D>;

// Overload 2: Direct GpuBuffer (schema inferred from buffer)
function attribute<D extends Any>(
    buffer: GpuBuffer<D>,
    options?: AttributeOptions
): AttributeNode<D>;

// Overload 3: Raw TypedArray (requires schema, creates GpuBuffer internally)
function attribute<D extends Any>(
    data: TypedArrayFor<D>,
    schema: D,
    options?: AttributeOptions
): AttributeNode<D>;
```

**No `instancedAttribute()` convenience** - `{ instanced: true }` is simple enough. The old `instancedBufferAttribute` was just sugar for setting a boolean flag.

## Files to Modify

### 1. `src/nodes/lib/attribute.ts` — Major Rewrite

**Remove:**
- `BufferAttributeNode` class
- `bufferAttribute()` function  
- `instancedBufferAttribute()` function

**Modify `AttributeNode`:**
```ts
class AttributeNode<D extends Any> extends Node<D> {
    /** Either a name (geometry lookup) or direct GpuBuffer reference */
    readonly source: string | GpuBuffer<D>;
    
    /** Byte stride between elements. 0 = tightly packed. */
    readonly stride: number;
    
    /** Byte offset within each stride. */
    readonly offset: number;
    
    /** Whether this is per-instance data (stepMode: 'instance'). */
    readonly instanced: boolean;

    /** Whether this is a name-based lookup */
    get isNamedReference(): boolean {
        return typeof this.source === 'string';
    }

    /** Get the name, or null if buffer-based */
    get name(): string | null {
        return typeof this.source === 'string' ? this.source : null;
    }

    /** Get the buffer, or null if name-based */
    get buffer(): GpuBuffer<D> | null {
        return typeof this.source === 'string' ? null : this.source;
    }
}
```

**Add unified `attribute()` function** with three overloads.

**Keep `uv()` unchanged.**

### 2. `src/core/buffer.ts` — Remove View Fields

**Remove from `GpuBufferOptions`:**
- `stride?: number`
- `offset?: number`
- `instanced?: boolean`

**Remove from `GpuBuffer` class:**
- `readonly stride: number`
- `readonly offset: number`
- `readonly instanced: boolean`
- Related constructor logic

### 3. `src/nodes/builder.ts` — Unify Code Generation

**Update imports:**
- Remove `BufferAttributeNode` import
- Keep only `AttributeNode`

**Update `AttributeEntry` type:**
```ts
export type AttributeEntry = {
    kind: 'geometry' | 'buffer';
    name: string;           // attribute name in shader
    type: string;           // WGSL type string
    location: number;       // @location index
    node: AttributeNode<d.Any>;  // always have the node reference
    stride: number;         // view info from node
    offset: number;
    instanced: boolean;
};
```

**Merge `generateAttribute()` and `generateBufferAttribute()`:**
```ts
function generateAttribute(ctx: BuildContext, node: AttributeNode<d.Any>): string {
    if (ctx.stage !== 'vertex') {
        throw new Error(`[builder] AttributeNode can only be used in vertex stage.`);
    }

    if (node.isNamedReference) {
        // By-name: geometry lookup
        const name = node.name;
        if (!ctx.attributes.has(name)) {
            ctx.attributes.set(name, {
                kind: 'geometry',
                name,
                type: node.type.wgslType,
                location: ctx.attributes.size,
                node,
                stride: node.stride,
                offset: node.offset,
                instanced: node.instanced,
            });
        }
        return `input.${name}`;
    } else {
        // Buffer-based: direct reference
        let name = ctx.bufferAttrNames.get(node.id);
        if (name) {
            return `input.${name}`;
        }
        
        name = `_buf${ctx.bufferAttributes.length}`;
        ctx.bufferAttrNames.set(node.id, name);
        ctx.bufferAttributes.push(node);
        
        return `input.${name}`;
    }
}
```

**Update `generateExpr()`:**
- Remove `BufferAttributeNode` case
- Keep only `AttributeNode` case (now handles both)

**Update compile output:**
- `allAttributes` construction includes stride/offset/instanced from nodes

### 4. `src/renderer/pipelines.ts` — Read View Info from Entry

**Update `buildVertexBufferLayouts()`:**

```ts
export function buildVertexBufferLayouts(
    geometry: Geometry,
    nodeState: NodeBuilderState,
): GPUVertexBufferLayout[] {
    const layouts: GPUVertexBufferLayout[] = [];

    for (const attrEntry of nodeState.attributes) {
        if (attrEntry.kind === 'geometry') {
            const buffer = geometry.buffers.get(attrEntry.name);
            if (!buffer) continue;

            const bytesPerElement = getBytesPerElement(buffer.format);
            // Read stride/offset from entry (node), not buffer
            const arrayStride = attrEntry.stride > 0 ? attrEntry.stride : bytesPerElement;

            layouts.push({
                arrayStride,
                stepMode: attrEntry.instanced ? 'instance' : 'vertex',
                attributes: [{
                    format: buffer.format!,
                    offset: attrEntry.offset,
                    shaderLocation: attrEntry.location,
                }],
            });
        } else {
            // Buffer-based attribute
            const node = attrEntry.node;
            const format = wgslTypeToVertexFormat(attrEntry.type);
            const itemSize = wgslTypeItemSize(attrEntry.type);
            const arrayStride = attrEntry.stride > 0 ? attrEntry.stride : itemSize * 4;

            layouts.push({
                arrayStride,
                stepMode: attrEntry.instanced ? 'instance' : 'vertex',
                attributes: [{
                    format,
                    offset: attrEntry.offset,
                    shaderLocation: attrEntry.location,
                }],
            });
        }
    }

    return layouts;
}
```

### 5. `src/renderer/renderer.ts` — Update Attribute Binding

**Update attribute binding loop (~line 909):**

The loop iterates `nodeState.attributes`. For each entry:
- If `kind === 'geometry'`: lookup buffer from `geometry.buffers.get(entry.name)`
- If `kind === 'buffer'`: use buffer from `entry.node.buffer`

No changes to the actual `setVertexBuffer` calls - they just bind the GPUBuffer.

### 6. `examples/src/example-indirect-batched.ts` — Update API Usage

**Before:**
```ts
const col0 = g.instancedBufferAttribute(instanceMatrices, d.vec4f, stride, 0);
const col1 = g.instancedBufferAttribute(instanceMatrices, d.vec4f, stride, 16);
```

**After:**
```ts
const col0 = g.attribute(instanceMatrices, d.vec4f, { stride, offset: 0, instanced: true });
const col1 = g.attribute(instanceMatrices, d.vec4f, { stride, offset: 16, instanced: true });
```

### 7. Exports — Update `src/index.ts` (or main export)

**Add:**
- `attribute` (unified)
- `AttributeNode` (class)

**Remove:**
- `bufferAttribute`
- `instancedBufferAttribute`
- `BufferAttributeNode`

## Gotchas / Edge Cases

1. **TypedArray overload requires schema** - Unlike `GpuBuffer` which has `.schema`, raw TypedArray needs explicit type.

2. **Buffer-based attributes still need to track the node** - For accessing stride/offset at render time.

3. **`instanced` flag meaning** - For name-based attributes, `instanced` affects the `stepMode` in pipeline layout. For buffer-based, same thing. The buffer in geometry.buffers doesn't know about instancing - the node does.

4. **Existing `GpuBuffer` usages** - Code that creates `GpuBuffer` with `stride`/`offset`/`instanced` will break. Need to audit:
   - `geometry-helpers.ts` - should be fine (doesn't use these options)
   - Any user code - breaking change, but "no users yet"

5. **`uv()` helper** - Currently returns `AttributeNode<d.vec2f>`. This is fine, it's name-based.

## Out of Scope (Follow-up)

- **Interleaved buffer grouping in renderer** - Detecting same underlying buffer and emitting single `GPUVertexBufferLayout` with multiple attributes
- **Buffer identity via WeakMap** - Not doing this; GpuBuffer is simple

## Testing

- Run existing examples after changes
- Verify `example-indirect-batched.ts` renders correctly with new API
- Manual test interleaved case works (even if not optimally grouped yet)

## Migration Notes

Since there are no external users, this is not a breaking change concern. Just update internal usages.
