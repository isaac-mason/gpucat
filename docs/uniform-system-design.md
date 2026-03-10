# Uniform System Redesign

## Goal

Decouple uniform data ownership from the DSL node system, mirroring the `GpuBuffer` / `StorageNode` separation.

```
┌─────────────────────────────────────────────────────────────┐
│  Core (renderer, bindings, packing)                         │
│                                                             │
│  Uniform<T>  ←── owns data, version, set()                  │
│       ↑                                                     │
│       │ references                                          │
└───────┼─────────────────────────────────────────────────────┘
        │
┌───────┼─────────────────────────────────────────────────────┐
│  DSL (nodes)                                                │
│       │                                                     │
│  UniformNode<T>  ←── graph node, emits WGSL, refs Uniform   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

The renderer deals with `Uniform` objects for packing/uploading. The DSL deals with `UniformNode` for graph traversal and WGSL generation. Even though `Uniform` is lightweight, it establishes a clean architectural boundary.

## Current State

```typescript
// UniformNode does everything
class UniformNode<D> extends Node<D> {
    groupNode: UniformGroupNode;
    name: string;
    value: number | number[] | Float32Array | null;  // data ownership
    version: number;                                   // dirty tracking
    
    set(value): this { ... }
    onUpdate(callback, updateType): this { ... }
}
```

Problems:
1. `UniformNode` mixes graph concerns with data ownership
2. No `material.uniforms` map for named access
3. Renderer reaches directly into node internals

## New Architecture

### Core Class: `Uniform<T>`

```typescript
// src/core/uniform.ts

export type UniformValue = number | number[] | Float32Array;

export class Uniform<T extends Any = Any> {
    readonly schema: T;
    value: UniformValue | null = null;
    version: number = 0;
    
    constructor(schema: T, initialValue?: UniformValue) {
        this.schema = schema;
        if (initialValue !== undefined) {
            this.value = initialValue;
        }
    }
    
    set(value: UniformValue): this {
        this.value = value;
        this.version++;
        return this;
    }
    
    set needsUpdate(v: boolean) {
        if (v) this.version++;
    }
}
```

### DSL: `UniformNode<T>` Refactored

```typescript
// src/nodes/lib/uniform.ts

class UniformNode<T extends Any> extends Node<T> {
    groupNode: UniformGroupNode;
    name: string;
    
    // References external Uniform (value-based or resolved from material)
    uniform: Uniform<T> | null = null;
    
    // For callback-based uniforms (system uniforms like camera, time)
    private _callbackValue: UniformValue | null = null;
    private _callbackVersion: number = 0;
    
    get value(): UniformValue | null {
        return this.uniform?.value ?? this._callbackValue;
    }
    
    get version(): number {
        return this.uniform?.version ?? this._callbackVersion;
    }
    
    /** Set value — delegates to Uniform if present */
    set(value: UniformValue): this {
        if (this.uniform) {
            this.uniform.set(value);
        } else {
            this._callbackValue = value;
            this._callbackVersion++;
        }
        return this;
    }
    
    /** Register update callback (for system uniforms) */
    onUpdate(callback: (frame: NodeFrame) => unknown, updateType: NodeUpdateType): this {
        this.updateType = updateType;
        this.update = (frame: NodeFrame) => {
            const value = callback(frame);
            if (value !== undefined) {
                this._callbackValue = value as UniformValue;
                this._callbackVersion++;
            }
        };
        return this;
    }
}
```

### DSL Function Overloads

```typescript
// Value-based: node references the Uniform directly
export function uniform<T extends Any>(u: Uniform<T>): UniformNode<T>;

// Name-based: resolved from material.uniforms at render time  
export function uniform<T extends Any>(name: string, schema: T): UniformNode<T>;

// Inline: creates Uniform internally (current API, still works)
export function uniform<T extends Any>(init: ConstNode<T>, name?: string): UniformNode<T>;

// Struct forms
export function uniform<S extends StructSchema>(u: Uniform<StructDef<S>>): StructInstance<S>;
export function uniform<S extends StructSchema>(name: string, def: StructDef<S>): StructInstance<S>;
export function uniform<S extends StructSchema>(def: StructDef<S>, name: string): StructInstance<S>;
```

### Material API

```typescript
// src/material/material.ts

export class Material {
    // ... existing fields ...
    
    /**
     * Named uniforms for this material.
     * DSL nodes using `uniform('name', schema)` resolve from here.
     */
    uniforms: Map<string, Uniform> = new Map();
}
```

## Usage Patterns

### Pattern 1: Value-based (Uniform owned externally)

```typescript
const roughness = new Uniform(d.f32, 0.5);
const metalness = new Uniform(d.f32, 0.0);

const material = new Material({
    vertex: clipPos,
    fragment: vec4(
        baseColor.rgb.mul(uniform(roughness)),  // node refs Uniform
        f32(1)
    ),
});

// Update at runtime
roughness.set(0.8);
```

### Pattern 2: Name-based (resolved from material.uniforms)

```typescript
// In material definition
const material = new Material({
    vertex: clipPos,
    fragment: vec4(
        baseColor.rgb.mul(uniform('roughness', d.f32)),  // placeholder
        f32(1)
    ),
});

// Attach uniform to material
material.uniforms.set('roughness', new Uniform(d.f32, 0.5));

// Update at runtime
material.uniforms.get('roughness')!.set(0.8);
```

### Pattern 3: Inline (current API, unchanged)

```typescript
const roughness = uniform(f32(0.5), 'roughness');

// Update via node (delegates to internal Uniform)
roughness.set(0.8);
```

### Pattern 4: Shared uniform across materials

```typescript
// Same Uniform instance used by multiple materials
const roughness = new Uniform(d.f32, 0.5);

const materialA = new Material({ ... });
materialA.uniforms.set('roughness', roughness);

const materialB = new Material({ ... });
materialB.uniforms.set('roughness', roughness);

// Update once, affects both
roughness.set(0.8);
```

## Renderer Changes

### bindings.ts: Uniform Resolution

```typescript
function resolveUniformValue(
    node: UniformNode,
    frame: NodeFrame
): UniformValue | null {
    // 1. Node has direct Uniform reference
    if (node.uniform) {
        return node.uniform.value;
    }
    
    // 2. Callback-based (system uniforms)
    if (node._callbackValue !== null) {
        return node._callbackValue;
    }
    
    // 3. Name-based resolution from material
    if (node.name && frame.material) {
        const uniform = frame.material.uniforms.get(node.name);
        return uniform?.value ?? null;
    }
    
    return null;
}
```

### bindings.ts: Version Tracking

```typescript
function computeUniformGroupVersion(
    block: UniformGroupBlock,
    frame: NodeFrame
): number {
    let version = 0;
    
    if (block.groupName === 'object') {
        version = frame.object?.matrixVersion ?? 0;
    }
    
    for (const m of block.members) {
        const node = m.node;
        
        // Get version from Uniform or callback
        if (node.uniform) {
            version += node.uniform.version;
        } else {
            version += node._callbackVersion;
        }
        
        // Name-based: also check material uniform version
        if (node.name && !node.uniform && frame.material) {
            const uniform = frame.material.uniforms.get(node.name);
            if (uniform) version += uniform.version;
        }
    }
    
    return version;
}
```

## System Uniforms

System uniforms (camera, time, matrices) continue using callback pattern:

```typescript
// These don't use Uniform class — they pull from NodeFrame
export const cameraProjectionMatrix = uniform(d.mat4x4f, 'projectionMatrix')
    .onUpdate((frame) => frame.camera?.projectionMatrix, NodeUpdateType.RENDER);

export const timeElapsed = uniform(d.f32, 'elapsed')
    .onUpdate((frame) => frame.time.elapsed, NodeUpdateType.FRAME);

export const modelWorldMatrix = uniform(d.mat4x4f, 'modelMatrix')
    .onUpdate((frame) => frame.object?.worldMatrix, NodeUpdateType.OBJECT);
```

These are special — they read from `NodeFrame` rather than owned data. The `_callbackValue` / `_callbackVersion` path handles them.

## Implementation Plan

### Phase 1: Core Uniform Class
1. Create `src/core/uniform.ts` with `Uniform<T>` class
2. Export from `src/index.ts`

### Phase 2: UniformNode Refactor
1. Add `uniform: Uniform<T> | null` field to `UniformNode`
2. Add `_callbackValue` / `_callbackVersion` private fields
3. Update `value` and `version` getters to delegate
4. Update `set()` to delegate to Uniform if present
5. Keep `onUpdate()` working for system uniforms

### Phase 3: DSL Function Overloads
1. Add `uniform(u: Uniform<T>)` overload — creates node referencing Uniform
2. Add `uniform(name: string, schema: T)` overload — creates placeholder node
3. Keep existing `uniform(init: ConstNode<T>, name?)` working — creates Uniform internally
4. Handle struct forms

### Phase 4: Material Integration
1. Add `uniforms: Map<string, Uniform>` to `Material`

### Phase 5: Renderer Integration
1. Add `resolveUniformValue()` helper
2. Update `packUniformGroup()` to use resolution
3. Update version computation for name-based uniforms
4. Ensure `NodeFrame` has `material` and `object` refs where needed

### Phase 6: Update Examples
1. Update examples to demonstrate new patterns
2. Keep some using inline form to show it still works

## File Changes

| File | Changes |
|------|---------|
| `src/core/uniform.ts` | **NEW** — `Uniform<T>` class |
| `src/nodes/lib/uniform.ts` | Refactor `UniformNode`, add overloads |
| `src/material/material.ts` | Add `uniforms` map |
| `src/renderer/bindings.ts` | Add resolution logic, update packing |
| `src/renderer/node-frame.ts` | Ensure material ref available |
| `src/index.ts` | Export `Uniform` from core |

## API Summary

| Pattern | Storage | Uniform |
|---------|---------|---------|
| Value-based | `storage(buffer)` | `uniform(uniformObj)` |
| Name-based | `storage('name', schema)` | `uniform('name', schema)` |
| Inline | N/A | `uniform(f32(0.5), 'name')` |
| Data class | `GpuBuffer<T>` | `Uniform<T>` |
| Owner | `geometry.buffers` | `material.uniforms` |

## Open Questions

1. **Error handling for missing name-based uniforms**
   - Option A: Error at pack time if not found
   - Option B: Warn and use zero
   - **Recommendation**: Error — fail fast, easier to debug

2. **Struct uniform values**
   - `Uniform<StructDef<S>>` — what's the value type?
   - Could be `Record<string, UniformValue>` or packed `Float32Array`
   - **Recommendation**: Accept either, normalize internally

3. **Shared uniforms across materials**
   - With `Uniform` class, same instance can be in multiple materials
   - Version change updates all materials using it
   - This is a feature, not a bug
