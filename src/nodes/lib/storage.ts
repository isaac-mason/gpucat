import { StorageBufferAttribute, StorageInstancedBufferAttribute, type IndirectStorageBufferAttribute } from '../../core/attribute';
import { itemSizeOf, typedArrayCtorOf, wgslSizeOf, type ArrayDesc, type SizedArrayDesc, type WgslDesc, type StructSchema } from '../schema';
import { Node, nextId, type StructDef, type StructInstance } from './core';
import { UniformGroupNode, objectGroup } from './uniform';

// TODO: simplify, surely
/** Type predicate for StructDef (from core.ts, not StructDesc from schema.ts) */
function isStructDef(desc: unknown): desc is StructDef<StructSchema> {
    return (
        typeof desc === 'object' &&
        desc !== null &&
        'type' in desc &&
        (desc as { type: unknown }).type === 'struct' &&
        'fields' in desc &&
        'instantiate' in desc
    );
}

/**
 * StorageNode — GPU storage buffer node.
 *
 * Holds a reference to a StorageBufferAttribute (the `value`).
 * Version and updateRanges are delegated to the attribute.
 */
export class StorageNode<D extends WgslDesc> extends Node<D> {
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
        super(nextId(), bufferType);
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
        return new StorageNode(this.value, this.bufferType, this.storageType, 'read');
    }
}

/** Type predicate for ArrayDesc or SizedArrayDesc */
function isArrayLikeDesc(desc: WgslDesc): desc is ArrayDesc | SizedArrayDesc {
    return desc.type === 'array' || desc.type === 'sized-array';
}

/** Get the element descriptor from an array-like descriptor */
function getArrayElement(desc: ArrayDesc | SizedArrayDesc): WgslDesc {
    return desc.element;
}

/**
 * Create a `StorageNode` backed by a `StorageBufferAttribute` (or subclass).
 *
 * `storage(bufferAttr, schema, access)`.
 * Accepts either an `ArrayDesc` (e.g. `d.array(d.vec4f)`) or a `StructDef`
 * (from `struct(...)`) as the schema argument.
 *
 * When a `StructDef` is passed the node's element type and storage type are
 * both set to the struct name (e.g. `'DrawBuffer'`).
 *
 * If `attr` is an `IndirectStorageBufferAttribute`, `_indirectOwner` is wired
 * automatically so the renderer reuses the same `STORAGE | INDIRECT | COPY_DST`
 * GPUBuffer for both the compute binding and the `drawIndirect` call.
 *
 * @example — array schema
 * const posAttr = new StorageBufferAttribute(posData, 4);
 * const positions = storage(posAttr, d.array(d.vec4f));
 *
 * @example — struct schema
 * const DrawBuffer = struct('DrawBuffer', { vertexCount: d.u32, instanceCount: d.u32, ... });
 * const drawAttr = new IndirectStorageBufferAttribute(false, 1);
 * const drawStorage = storage(drawAttr, DrawBuffer, 'read_write');
 */
export function storage<S extends StructSchema>(
    attr: StorageBufferAttribute,
    schema: StructDef<S>,
    access?: 'read' | 'read_write'
): StructInstance<S>;

export function storage(
    attr: StorageBufferAttribute,
    schema: ArrayDesc | SizedArrayDesc,
    access?: 'read' | 'read_write'
): StorageNode<WgslDesc>;

export function storage(
    attr: StorageBufferAttribute,
    schema: ArrayDesc | SizedArrayDesc | StructDef<StructSchema>,
    access: 'read' | 'read_write' = 'read'
): StorageNode<WgslDesc> | StructInstance<StructSchema> {
    let elementDesc: WgslDesc;
    let storageType: string;
    if (isStructDef(schema)) {
        elementDesc = schema as unknown as WgslDesc;
        storageType = schema.wgslType;
    } else if (isArrayLikeDesc(schema)) {
        elementDesc = getArrayElement(schema);
        storageType = schema.wgslType;
    } else {
        throw new Error('[gpucat] storage: invalid schema — expected ArrayDesc, SizedArrayDesc, or StructDef');
    }

    const node = new StorageNode(attr, elementDesc, storageType, access);

    // When given a StructDef, instantiate a StructInstance so callers can do
    // drawStorage.instanceCount.assign(...)
    if (isStructDef(schema)) {
        return schema.instantiate(node);
    }

    return node;
}

/**
 * Return the number of f32-sized slots occupied by one element of `arrayDesc`.
 * For primitive/vector/matrix types this is the same as `itemSizeOf`.
 * For struct types it is `wgslSizeOf(element) / 4` (byte size divided by 4).
 */
function elementItemSize(arrayDesc: ArrayDesc | SizedArrayDesc): number {
    const element = getArrayElement(arrayDesc);
    if (isStructDef(element)) return wgslSizeOf(element as unknown as WgslDesc) / 4;
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
export const storageArray = (
    count: number,
    arrayDesc: ArrayDesc | SizedArrayDesc,
    access: 'read' | 'read_write' = 'read'
): StorageNode<WgslDesc> => {
    const itemSize = elementItemSize(arrayDesc);
    const element = getArrayElement(arrayDesc);
    const Ctor = isStructDef(element) ? Float32Array : typedArrayCtorOf(element);
    const data = new Ctor(count * itemSize);
    const attr = new StorageBufferAttribute(data, itemSize);
    return new StorageNode(attr, element, arrayDesc.wgslType, access);
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
export const instancedArray = (
    countOrData: number | Float32Array | Int32Array | Uint32Array,
    arrayDesc: ArrayDesc | SizedArrayDesc,
    access: 'read' | 'read_write' = 'read'
): StorageNode<WgslDesc> => {
    const itemSize = elementItemSize(arrayDesc);
    const element = getArrayElement(arrayDesc);
    const Ctor = isStructDef(element) ? Float32Array : typedArrayCtorOf(element);

    let attr: StorageInstancedBufferAttribute;
    if (typeof countOrData === 'number') {
        attr = new StorageInstancedBufferAttribute(countOrData, itemSize, Ctor as new (n: number) => Float32Array | Int32Array | Uint32Array);
    } else {
        attr = new StorageInstancedBufferAttribute(countOrData, itemSize);
    }

    return new StorageNode(attr, element, arrayDesc.wgslType, access);
};
