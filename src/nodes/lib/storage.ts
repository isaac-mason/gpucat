import { StorageBufferAttribute, StorageInstancedBufferAttribute, type IndirectStorageBufferAttribute } from '../../core/attribute';
import { ArrayDesc, itemSizeOf, typedArrayCtorOf, wgslSizeOf, type Any, type StructSchema } from '../schema';
import { Node, type StructDef } from './core';
import { UniformGroupNode, objectGroup } from './uniform';

/** Type predicate for StructDef (from core.ts) */
function isStructDef(desc: unknown): desc is StructDef<StructSchema> {
    return (
        typeof desc === 'object' &&
        desc !== null &&
        'type' in desc &&
        (desc as { type: unknown }).type === 'struct'
    );
}

/**
 * StorageNode — GPU storage buffer node.
 *
 * Holds a reference to a StorageBufferAttribute (the `value`).
 * Version and updateRanges are delegated to the attribute.
 */
export class StorageNode<D extends Any> extends Node<D> {
    /**
     * The buffer attribute holding the CPU-side data.
     */
    readonly value: StorageBufferAttribute;

    /**
     * The buffer type descriptor (element type), e.g. vec4f, mat4x4f.
     * Same as node.type — provided for API compatibility.
     */
    readonly bufferType: D;

    /** The number of elements in the buffer. Derived from value.count */
    readonly bufferCount: number;

    /** The WGSL array type string, e.g. 'array<mat4x4f>'. Emitted verbatim. */
    readonly storageType: string;

    /** Access mode for the storage buffer. Defaults to 'read_write'. */
    readonly access: 'read' | 'read_write';

    /** Whether the node is atomic or not. */
    isAtomic: boolean = false;

    /** Uniform group — determines @group index. Defaults to objectGroup. */
    groupNode: UniformGroupNode;

    constructor(
        /** The buffer attribute holding the data. */
        value: StorageBufferAttribute,
        /** Element type descriptor (e.g. vec4f) — used as the node's type for downstream indexing. */
        bufferType: D,
        /** Full WGSL array type string (e.g. 'array<mat4x4f>'). */
        storageType: string,
        /** Access mode for the storage buffer. Defaults to 'read_write'. */
        access: 'read' | 'read_write' = 'read_write',
        /** Uniform group — determines @group index. Defaults to objectGroup. */
        groupNode: UniformGroupNode = objectGroup
    ) {
        super(bufferType);
        this.value = value;
        this.bufferType = bufferType;
        this.bufferCount = value.count;
        this.storageType = storageType;
        this.access = access;
        this.groupNode = groupNode;
    }

    /**
     * Check if this is an indirect storage buffer.
     */
    get isIndirectStorageBuffer(): boolean {
        return !!(this.value as IndirectStorageBufferAttribute).isIndirectStorageBufferAttribute;
    }

    /** defines whether the node is atomic or not */
    setAtomic(value: boolean): this {
        this.isAtomic = value;
        return this;
    }

    /**
     * Convenience method for making this node atomic.
     */
    toAtomic(): this {
        return this.setAtomic(true);
    }

    /** convenience method for configuring read-only access */
    toReadOnly(): StorageNode<D> {
        // Note: access is readonly after construction in gpucat.
        // This method is provided for API compatibility but requires
        // creating a new node if access needs to change.
        if (this.access === 'read') return this;
        return new StorageNode(this.value, this.bufferType, this.storageType, 'read', this.groupNode);
    }
}

/**
 * Create a `StorageNode` backed by a `StorageBufferAttribute` (or subclass).
 *
 * The schema type `D` becomes the node's type directly:
 * - `d.array(d.vec4f)` → `StorageNode<ArrayDesc>` (use `index()` to access elements)
 * - `MyStruct` (a StructDef) → `StorageNode<StructDef<S>>` (use `fields()` for field access)
 *
 * @example — array schema
 * const posAttr = new StorageBufferAttribute(posData, 4);
 * const positions = storage(posAttr, d.array(d.vec4f));
 * const pos0 = index(positions, u32(0)); // Node<vec4f>
 *
 * @example — struct schema
 * const DrawBuffer = struct('DrawBuffer', { vertexCount: d.u32, instanceCount: d.u32, ... });
 * const drawAttr = new IndirectStorageBufferAttribute(false, 1);
 * const drawStorage = storage(drawAttr, DrawBuffer, 'read_write');
 * const { vertexCount } = fields(drawStorage); // use fields() for access
 * vertexCount.assign(u32(6));
 */
export function storage<D extends Any>(
    attr: StorageBufferAttribute,
    schema: D,
    access: 'read' | 'read_write' = 'read'
): StorageNode<D> {
    const storageType = (schema as { wgslType: string }).wgslType;
    return new StorageNode(attr, schema, storageType, access, objectGroup);
}

/**
 * Return the number of f32-sized slots occupied by one element of `arrayDesc`.
 * For primitive/vector/matrix types this is the same as `itemSizeOf`.
 * For struct types it is `wgslSizeOf(element) / 4` (byte size divided by 4).
 */
function elementItemSize<E extends Any>(arrayDesc: { element: E }): number {
    const element = arrayDesc.element;
    if (isStructDef(element)) return wgslSizeOf(element as unknown as Any) / 4;
    return itemSizeOf(element);
}

/**
 *
 * The element type and TypedArray kind are derived from `arrayDesc`:
 * - `d.array(d.vec4f)`   → `Float32Array` of length `count * 4`
 * - `d.array(d.u32)`     → `Uint32Array`  of length `count * 1`
 * - `d.array(d.mat4x4f)` → `Float32Array` of length `count * 16`
 *
 * @example
 * import * as d from './schema'
 * const colors = storageArray(N, d.array(d.vec4f), 'read_write')
 * // Modify colors.value.array, then: colors.value.needsUpdate = true
 */
export const storageArray = <D extends ArrayDesc>(
    count: number,
    arrayDesc: D,
    access: 'read' | 'read_write' = 'read'
): StorageNode<D> => {
    if (arrayDesc.type !== 'array') {
        throw new Error(`[gpucat] storageArray only accepts array descriptors (type: 'array'), but got type '${arrayDesc.type}'.`);
    }

    const itemSize = elementItemSize(arrayDesc);
    const Ctor = isStructDef(arrayDesc.element) ? Float32Array : typedArrayCtorOf(arrayDesc.element);
    const data = new Ctor(count * itemSize);
    const attr = new StorageBufferAttribute(data, itemSize);

    return new StorageNode<D>(attr, arrayDesc, arrayDesc.wgslType, access, objectGroup)
};

/**
 * Create a storage buffer node backed by a StorageInstancedBufferAttribute.
 * Useful for per-instance data in compute and render shaders.
 *
 * Accepts either:
 * - A count (number) and an array descriptor — creates a zeroed buffer of that size
 * - A pre-filled TypedArray and an array descriptor — uses the provided data
 *
 * @param countOrData - Number of instances, or a pre-filled TypedArray
 * @param arrayDesc - Array type descriptor (e.g. `d.array(d.vec4f)`, or a StructDef)
 * @param access - Storage access mode: 'read' (default) or 'read_write'
 *
 * @example
 * // Create storage for 1024 particles with vec4f (position + w)
 * const particles = instancedArray(1024, d.array(d.vec4f), 'read_write');
 *
 * // With a struct type:
 * const ParticleStruct = struct('Particle', {
 *     position: d.vec3f,
 *     velocity: d.vec3f,
 *     C: d.mat3x3f,
 * });
 * const particleBuffer = instancedArray(maxParticles, d.array(ParticleStruct), 'read_write');
 *
 * // With pre-filled data:
 * const initialData = new Float32Array(1024 * 4);
 * // ... fill data ...
 * const particles = instancedArray(initialData, d.array(d.vec4f), 'read_write');
 */
export const instancedArray = <D extends ArrayDesc>(
    countOrData: number | Float32Array | Int32Array | Uint32Array,
    arrayDesc: D,
    access: 'read' | 'read_write' = 'read'
): StorageNode<D> => {
    const itemSize = elementItemSize(arrayDesc);
    const Ctor = isStructDef(arrayDesc.element) ? Float32Array : typedArrayCtorOf(arrayDesc.element);

    let attr: StorageInstancedBufferAttribute;
    if (typeof countOrData === 'number') {
        attr = new StorageInstancedBufferAttribute(countOrData, itemSize, Ctor as new (n: number) => Float32Array | Int32Array | Uint32Array);
    } else {
        attr = new StorageInstancedBufferAttribute(countOrData, itemSize);
    }

    return new StorageNode(attr, arrayDesc, arrayDesc.wgslType, access, objectGroup);
};
