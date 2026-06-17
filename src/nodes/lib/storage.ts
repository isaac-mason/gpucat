import { GpuBuffer } from '../../core/gpu-buffer';
import type { Any } from '../../schema/schema';
import { Node, NodeKind } from './core';
import { UniformGroup, objectGroup } from './uniform';

/**
 * StorageNode, declares a storage buffer binding in a shader.
 *
 * Two forms:
 * 1. **Named reference**: Resolved from `geometry.buffers` at render time
 * 2. **Value reference**: Buffer provided directly, can be swapped via `.value`
 *
 * Both are first-class features for different use cases:
 * - Named references enable buffer reuse across materials (same shader, different buffers per mesh)
 * - Value references enable compute-only workloads (no geometry) and explicit buffer swapping
 *
 * @example Named reference (resolved from geometry.buffers)
 * const particles = storage('particles', d.array(Particle), 'read_write');
 * // Later: geometry.setBuffer('particles', myParticleBuffer);
 *
 * @example Value reference (buffer provided directly, swappable)
 * const particles = storage(myBuffer, 'read_write');
 * particles.value = otherBuffer;  // swap buffers for double-buffering
 */
export class StorageNode<D extends Any> extends Node<D> {
    readonly kind = NodeKind.Storage;
    /** Buffer name (for geometry.buffers lookup), null if value-based */
    bufferName: string | null;

    /** Direct buffer reference, null if name-based */
    value: GpuBuffer<D> | null;

    /** The WGSL type string, e.g. 'array<mat4x4f>'. Emitted verbatim. */
    readonly storageType: string;

    /** Access mode for the storage buffer. */
    readonly access: 'read' | 'read_write';

    /** Whether the node is atomic or not. */
    isAtomic: boolean = false;

    /** Uniform group, determines @group index. Defaults to objectGroup. */
    group: UniformGroup;

    constructor(
        schema: D,
        nameOrBuffer: string | GpuBuffer<D>,
        access: 'read' | 'read_write' = 'read',
        group: UniformGroup = objectGroup
    ) {
        super(schema);

        if (typeof nameOrBuffer === 'string') {
            this.bufferName = nameOrBuffer;
            this.value = null;
        } else {
            this.bufferName = null;
            this.value = nameOrBuffer;
        }

        this.storageType = schema.wgslType;
        this.access = access;
        this.group = group;
    }

    /** Whether this is a named reference (resolved from geometry.buffers) */
    get isNamedReference(): boolean {
        return this.bufferName !== null;
    }

    /** Whether this is an indirect storage buffer (has 'indirect' usage) */
    get isIndirectStorageBuffer(): boolean {
        return this.value?.usage.has('indirect') ?? false;
    }

    /** Defines whether the node is atomic or not */
    setAtomic(value: boolean): this {
        this.isAtomic = value;
        return this;
    }

    /** Convenience method for making this node atomic */
    toAtomic(): this {
        return this.setAtomic(true);
    }

    /** Convenience method for configuring read-only access */
    toReadOnly(): StorageNode<D> {
        if (this.access === 'read') return this;
        if (this.bufferName !== null) {
            return new StorageNode(this.type, this.bufferName, 'read', this.group);
        } else {
            return new StorageNode(this.type, this.value!, 'read', this.group);
        }
    }
}

/**
 * Create a storage buffer node from a GpuBuffer (value-based).
 * Type is inferred from the buffer's schema.
 *
 * @param buffer - The GpuBuffer to bind
 * @param access - Storage access mode: 'read' (default) or 'read_write'
 *
 * @example
 * const particleBuffer = new GpuBuffer(d.array(Particle), { data: new Float32Array(1000 * stride), usage: 'storage' });
 * const particles = storage(particleBuffer, 'read_write');
 * particles.value = otherBuffer;  // swap buffers for double-buffering
 */
export function storage<D extends Any>(
    buffer: GpuBuffer<D>,
    access?: 'read' | 'read_write'
): StorageNode<D>;

/**
 * Create a storage buffer node by name (name-based).
 * Resolved from `geometry.buffers` at render time.
 *
 * @param name - Buffer name for geometry.buffers lookup
 * @param schema - The WGSL type descriptor (e.g., d.array(d.vec4f))
 * @param access - Storage access mode: 'read' (default) or 'read_write'
 *
 * @example
 * const particles = storage('particles', d.array(Particle), 'read_write');
 * // Different meshes can have different 'particles' buffers with the same material
 */
export function storage<D extends Any>(
    name: string,
    schema: D,
    access?: 'read' | 'read_write'
): StorageNode<D>;

export function storage<D extends Any>(
    nameOrBuffer: string | GpuBuffer<D>,
    schemaOrAccess?: D | 'read' | 'read_write',
    accessArg?: 'read' | 'read_write'
): StorageNode<D> {
    if (typeof nameOrBuffer === 'string') {
        // Name-based: storage(name, schema, access?)
        const schema = schemaOrAccess as D;
        const access = accessArg ?? 'read';
        return new StorageNode(schema, nameOrBuffer, access, objectGroup);
    } else {
        // Value-based: storage(buffer, access?)
        const buffer = nameOrBuffer;
        const access = (schemaOrAccess as 'read' | 'read_write' | undefined) ?? 'read';
        return new StorageNode(buffer.schema, buffer, access, objectGroup);
    }
}
