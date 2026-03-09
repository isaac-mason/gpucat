import { StorageBufferAttribute, StorageInstancedBufferAttribute, type IndirectStorageBufferAttribute } from '../../core/attribute';
import { isStructDef, itemSizeOf, typedArrayCtorOf, type ArrayDesc, type StructSchema } from '../schema';
import { Node, nextId, type WgslType, type StructDef, type StructInstance } from './core';
import { UniformGroupNode, objectGroup } from './uniform';

/**
 * StorageNode — GPU storage buffer node.
 *
 * Holds a reference to a StorageBufferAttribute (the `value`).
 * Version and updateRanges are delegated to the attribute.
 */
export class StorageNode<T extends WgslType> extends Node<T> {
    /**
     * This flag can be used for type testing.
     */
    readonly isStorageBufferNode: true = true;

    /**
     * The buffer attribute holding the CPU-side data.
     */
    readonly value: StorageBufferAttribute;

    /**
     * The buffer type (element type), e.g. 'vec4f', 'mat4x4f'.
     * Same as node.type — provided for Three.js API compatibility.
     */
    readonly bufferType: T;

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
        /** Element type (e.g. 'mat4x4f') — used as the node's type for downstream indexing. */
        bufferType: T,
        /** Full WGSL array type string (e.g. 'array<mat4x4f>'). */
        storageType: string,
        /** Access mode for the storage buffer. Defaults to 'read_write'. */
        access: 'read' | 'read_write' = 'read_write',
        /** Uniform group — determines @group index. Defaults to objectGroup. */
        groupNode: UniformGroupNode = objectGroup
    ) {
        super(nextId(), 'storage', bufferType);
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
    toReadOnly(): StorageNode<T> {
        // Note: access is readonly after construction in gpucat.
        // This method is provided for API compatibility but requires
        // creating a new node if access needs to change.
        if (this.access === 'read') return this;
        return new StorageNode(this.value, this.bufferType, this.storageType, 'read');
    }
}
/**
 * Create a `StorageNode` backed by a `StorageBufferAttribute` (or subclass).
 *
 * `storage(bufferAttr, schema, access)`.
 * Accepts either an `ArrayDesc` (e.g. `S.array(S.vec4f())`) or a `StructDef`
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
 * const positions = storage(posAttr, S.array(S.vec4f()));
 *
 * @example — struct schema
 * const DrawBuffer = struct('DrawBuffer', { vertexCount: S.u32(), instanceCount: S.u32(), ... });
 * const drawAttr = new IndirectStorageBufferAttribute(false, 1);
 * const drawStorage = storage(drawAttr, DrawBuffer, 'read_write');
 */
export function storage<E extends WgslType>(
    attr: StorageBufferAttribute,
    schema: ArrayDesc<E>,
    access?: 'read' | 'read_write'
): StorageNode<E>;

export function storage<S extends StructSchema>(
    attr: StorageBufferAttribute,
    schema: StructDef<S>,
    access?: 'read' | 'read_write'
): StructInstance<S>;

export function storage(
    attr: StorageBufferAttribute,
    schema: ArrayDesc<WgslType> | StructDef<StructSchema>,
    access: 'read' | 'read_write' = 'read'
): StorageNode<WgslType> | StructInstance<StructSchema> {
    let elementType: WgslType;
    let storageType: string;
    if (isStructDef(schema)) {
        elementType = schema.wgslType;
        storageType = schema.wgslType;
    } else {
        const arrayDesc = schema as ArrayDesc<WgslType>;
        elementType = arrayDesc.elementDesc.wgslType;
        storageType = arrayDesc.wgslType;
    }

    const node = new StorageNode(attr, elementType, storageType, access);

    // When given a StructDef, instantiate a StructInstance so callers can do
    // drawStorage.instanceCount.assign(...)
    if (isStructDef(schema)) {
        return schema.instantiate(node);
    }

    return node;
}

/**
 * Create a `StorageNode` with a zero-initialised typed array allocated internally.
 *
 * The element type and TypedArray kind are derived from `arrayDesc`:
 * - `S.array(S.vec4f())`   → `Float32Array` of length `count * 4`
 * - `S.array(S.u32())`     → `Uint32Array`  of length `count * 1`
 * - `S.array(S.mat4x4f())` → `Float32Array` of length `count * 16`
 *
 * @example
 * import * as S from './schema'
 * const colors = storageArray(N, S.array(S.vec4f()), 'read_write')
 * // Modify colors.value.array, then: colors.value.needsUpdate = true
 */
export const storageArray = <E extends WgslType>(
    count: number,
    arrayDesc: ArrayDesc<E>,
    access: 'read' | 'read_write' = 'read'
): StorageNode<E> => {
    const itemSize = itemSizeOf(arrayDesc.elementDesc);
    const Ctor = typedArrayCtorOf(arrayDesc.elementDesc);
    const data = new Ctor(count * itemSize);
    const attr = new StorageBufferAttribute(data, itemSize);
    return new StorageNode(attr, arrayDesc.elementDesc.wgslType as E, arrayDesc.wgslType, access);
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
export const instancedArray = <E extends WgslType>(
    countOrData: number | Float32Array | Int32Array | Uint32Array,
    arrayDesc: ArrayDesc<E>,
    access: 'read' | 'read_write' = 'read'
): StorageNode<E> => {
    const itemSize = itemSizeOf(arrayDesc.elementDesc);
    const Ctor = typedArrayCtorOf(arrayDesc.elementDesc);

    let attr: StorageInstancedBufferAttribute;
    if (typeof countOrData === 'number') {
        // create new zeroed buffer
        attr = new StorageInstancedBufferAttribute(countOrData, itemSize, Ctor);
    } else {
        // use provided data
        attr = new StorageInstancedBufferAttribute(countOrData, itemSize);
    }

    return new StorageNode(attr, arrayDesc.elementDesc.wgslType as E, arrayDesc.wgslType, access);
};
