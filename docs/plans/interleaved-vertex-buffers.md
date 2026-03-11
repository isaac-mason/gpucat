# Interleaved Vertex Buffer Support

## Goal

Enable multiple attributes to share a single vertex buffer (interleaved data) with proper grouping in the renderer - one `GPUVertexBufferLayout` and one `setVertexBuffer()` call per unique buffer.

## User-Facing API (already works)

```ts
// Interleaved data: [pos.xyz, norm.xyz, uv.xy] per vertex = 32 bytes stride
const interleavedData = new Float32Array([...]);
const interleavedBuffer = new GpuBuffer(d.f32, { data: interleavedData, usage: 'vertex' });

// Option A: Geometry-based (by name)
geometry.setBuffer('interleaved', interleavedBuffer);
const pos = attribute('interleaved', d.vec3f, { stride: 32, offset: 0 });
const norm = attribute('interleaved', d.vec3f, { stride: 32, offset: 12 });
const uv = attribute('interleaved', d.vec2f, { stride: 32, offset: 24 });

// Option B: Direct buffer reference
const pos = attribute(interleavedBuffer, d.vec3f, { stride: 32, offset: 0 });
const norm = attribute(interleavedBuffer, d.vec3f, { stride: 32, offset: 12 });
const uv = attribute(interleavedBuffer, d.vec2f, { stride: 32, offset: 24 });
```

## Current Behavior (wasteful)

Each attribute gets its own vertex buffer slot:
```
pos  → slot 0 → setVertexBuffer(0, buf)
norm → slot 1 → setVertexBuffer(1, buf)  // same buf!
uv   → slot 2 → setVertexBuffer(2, buf)  // same buf!
```

## Desired Behavior

Attributes sharing a buffer get grouped into one slot:
```
pos  ─┐
norm ─┼→ slot 0 → setVertexBuffer(0, buf)
uv   ─┘
```

With one `GPUVertexBufferLayout`:
```ts
{
    arrayStride: 32,
    stepMode: 'vertex',
    attributes: [
        { format: 'float32x3', offset: 0,  shaderLocation: 0 },  // pos
        { format: 'float32x3', offset: 12, shaderLocation: 1 },  // norm
        { format: 'float32x2', offset: 24, shaderLocation: 2 },  // uv
    ]
}
```

## Implementation

### 1. Introduce `VertexBufferGroup` type

A structure that groups attributes by their underlying buffer:

```ts
// In node-builder-state.ts or builder.ts
type VertexBufferGroup = {
    // For geometry-based: the buffer name. For direct buffer: null.
    name: string | null;
    // For direct buffer: the GpuBuffer. For geometry-based: null (resolved at render time).
    buffer: GpuBuffer | null;
    // Shared properties (must match across grouped attributes)
    stride: number;
    instanced: boolean;
    // The attributes in this group
    attributes: {
        type: string;           // WGSL type
        offset: number;         // byte offset within stride
        shaderLocation: number; // @location(N)
    }[];
};
```

### 2. Update `NodeBuilderState`

Add grouped structure alongside or replacing flat `attributes` array:

```ts
type NodeBuilderState = {
    // ... existing fields ...
    
    // Grouped for efficient vertex buffer binding
    vertexBufferGroups: VertexBufferGroup[];
};
```

### 3. Update `builder.ts` compile function

After collecting all attributes, group them:

```ts
function groupAttributesByBuffer(entries: AttributeEntry[]): VertexBufferGroup[] {
    const groups = new Map<string, VertexBufferGroup>();
    
    for (const entry of entries) {
        // Key: buffer id for direct, name for geometry-based
        const key = entry.kind === 'geometry' 
            ? `name:${entry.name}` 
            : `buffer:${entry.node.buffer!.id}`;
        
        let group = groups.get(key);
        if (!group) {
            group = {
                name: entry.kind === 'geometry' ? entry.name : null,
                buffer: entry.kind === 'buffer' ? entry.node.buffer : null,
                stride: entry.stride,
                instanced: entry.instanced,
                attributes: [],
            };
            groups.set(key, group);
        }
        
        // Validate stride/instanced match
        if (group.stride !== entry.stride || group.instanced !== entry.instanced) {
            throw new Error(`Interleaved attributes must have matching stride and instanced values`);
        }
        
        group.attributes.push({
            type: entry.type,
            offset: entry.offset,
            shaderLocation: entry.location,
        });
    }
    
    return Array.from(groups.values());
}
```

### 4. Update `pipelines.ts` buildVertexBufferLayouts

Iterate groups instead of flat entries:

```ts
function buildVertexBufferLayouts(
    geometry: Geometry,
    nodeState: NodeBuilderState,
): GPUVertexBufferLayout[] {
    const layouts: GPUVertexBufferLayout[] = [];

    for (const group of nodeState.vertexBufferGroups) {
        // Resolve format for each attribute
        const attributes: GPUVertexAttribute[] = group.attributes.map(attr => ({
            format: wgslTypeToVertexFormat(attr.type),
            offset: attr.offset,
            shaderLocation: attr.shaderLocation,
        }));

        // Calculate arrayStride - use group.stride if set, otherwise derive from first attribute
        const arrayStride = group.stride > 0 
            ? group.stride 
            : wgslTypeItemSize(group.attributes[0].type) * 4;

        layouts.push({
            arrayStride,
            stepMode: group.instanced ? 'instance' : 'vertex',
            attributes,
        });
    }

    return layouts;
}
```

### 5. Update `renderer.ts` vertex buffer binding

Iterate groups, one `setVertexBuffer` per group:

```ts
let slot = 0;
for (const group of nodeState.vertexBufferGroups) {
    let gpuBuf: GPUBuffer;
    
    if (group.name !== null) {
        // Geometry-based: lookup by name
        const bufAttr = geometry.buffers.get(group.name);
        if (!bufAttr) { slot++; continue; }
        gpuBuf = buffers.ensureUploaded(this._buffers, this._device, bufAttr);
    } else {
        // Direct buffer reference
        const buffer = group.buffer!;
        const arr = buffer.array;
        if (!arr) {
            throw new Error(`[gpucat] Interleaved buffer has no array data`);
        }
        gpuBuf = buffers.uploadRaw(
            this._buffers,
            this._device,
            buffer,
            arr,
            GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        ).buffer;
    }
    
    if (currentSets.attributes[slot] !== gpuBuf) {
        passSetVertexBuffer(gpuPass, this.inspector, slot, gpuBuf);
        currentSets.attributes[slot] = gpuBuf;
    }
    slot++;
}
```

### 6. Update `inspector.ts`

Same pattern as renderer - iterate groups instead of flat entries.

## Validation

- All attributes in a group must have matching `stride` and `instanced` values
- Offsets must not overlap (optional: warn if they do)

## Files to Modify

1. `src/nodes/builder.ts` - Add grouping logic, update `NodeBuilderState`
2. `src/renderer/pipelines.ts` - Update `buildVertexBufferLayouts` to use groups
3. `src/renderer/renderer.ts` - Update vertex buffer binding loop
4. `src/inspector/inspector.ts` - Same update as renderer

## Out of Scope

- Auto-interleaving (user must explicitly share buffers)
- Geometry helpers that produce interleaved data (future convenience)
