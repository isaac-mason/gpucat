import { GpuBuffer } from '../../core/gpu-buffer';
import { Node, NodeKind } from './core';
import type { Any, TypedArrayFor } from '../../schema/schema';
import * as d from '../../schema/schema';

/**
 * Options for creating an AttributeNode with view semantics.
 */
export type AttributeOptions = {
    /** Byte stride between elements (0 = tightly packed). */
    stride?: number;
    /** Byte offset within each stride. */
    offset?: number;
    /** Whether this is per-instance data (stepMode: 'instance'). */
    instanced?: boolean;
};

/**
 * AttributeNode, a vertex attribute that reads from either:
 * 1. A named geometry buffer (looked up at render time by name)
 * 2. A direct GpuBuffer reference
 *
 * View info (stride, offset, instanced) lives on the node, not the buffer.
 * This follows the WebGPU pattern where GPUBuffer is bound separately from
 * the GPUVertexBufferLayout which specifies stride/offset.
 *
 * @example
 * // By-name (geometry lookup)
 * const pos = attribute('position', d.vec3f);
 * const uv = attribute('uv', d.vec2f);
 *
 * // By-name with view options
 * const pos = attribute('position', d.vec3f, { stride: 32, offset: 0 });
 *
 * // Direct GpuBuffer (schema from buffer)
 * const colors = attribute(colorBuffer);
 *
 * // Direct GpuBuffer with view options (interleaved)
 * const position = attribute(interleavedBuffer, { stride: 32, offset: 0 });
 * const normal = attribute(interleavedBuffer, { stride: 32, offset: 12 });
 *
 * // Raw TypedArray (auto-wrapped in GpuBuffer)
 * const offsets = attribute(offsetData, d.vec3f);
 *
 * // Instanced
 * const instanceMatrix = attribute(matricesBuffer, { stride: 64, offset: 0, instanced: true });
 */
export class AttributeNode<D extends Any> extends Node<D> {
    readonly kind = NodeKind.Attribute;
    /** Either a name (geometry lookup) or direct GpuBuffer reference */
    readonly source: string | GpuBuffer<D>;

    /** Byte stride between elements. 0 = tightly packed. */
    readonly stride: number;

    /** Byte offset within each stride. */
    readonly offset: number;

    /** Whether this is per-instance data (stepMode: 'instance'). */
    readonly instanced: boolean;

    constructor(
        desc: D,
        source: string | GpuBuffer<D>,
        options: AttributeOptions = {}
    ) {
        super(desc);
        this.source = source;
        this.stride = options.stride ?? 0;
        this.offset = options.offset ?? 0;
        this.instanced = options.instanced ?? false;
    }

    /** Whether this is a name-based lookup. */
    get isNamedReference(): boolean {
        return typeof this.source === 'string';
    }

    /** Get the name, or null if buffer-based. */
    get name(): string | null {
        return typeof this.source === 'string' ? this.source : null;
    }

    /** Get the buffer, or null if name-based. */
    get buffer(): GpuBuffer<D> | null {
        return typeof this.source === 'string' ? null : this.source;
    }
}

// Overload 1: By name (geometry lookup)
export function attribute<D extends Any>(
    name: string,
    schema: D,
    options?: AttributeOptions
): AttributeNode<D>;

// Overload 2: Direct GpuBuffer (schema inferred from buffer)
export function attribute<D extends Any>(
    buffer: GpuBuffer<D>,
    options?: AttributeOptions
): AttributeNode<D>;

// Overload 3: Raw TypedArray (requires schema, creates GpuBuffer internally)
export function attribute<D extends Any>(
    data: TypedArrayFor<D>,
    schema: D,
    options?: AttributeOptions
): AttributeNode<D>;

// Implementation
export function attribute<D extends Any>(
    nameOrBufferOrData: string | GpuBuffer<D> | TypedArrayFor<D>,
    schemaOrOptions?: D | AttributeOptions,
    maybeOptions?: AttributeOptions
): AttributeNode<D> {
    // Overload 1: attribute(name, schema, options?)
    if (typeof nameOrBufferOrData === 'string') {
        const name = nameOrBufferOrData;
        const schema = schemaOrOptions as D;
        const options = maybeOptions ?? {};
        return new AttributeNode(schema, name, options);
    }

    // Overload 2: attribute(buffer, options?)
    if (nameOrBufferOrData instanceof GpuBuffer) {
        const buffer = nameOrBufferOrData;
        const options = (schemaOrOptions as AttributeOptions) ?? {};
        return new AttributeNode(buffer.schema, buffer, options);
    }

    // Overload 3: attribute(data, schema, options?)
    // data is a TypedArray - wrap in GpuBuffer
    const data = nameOrBufferOrData;
    const schema = schemaOrOptions as D;
    const options = maybeOptions ?? {};
    const buffer = new GpuBuffer(schema, {
        data: data as TypedArrayFor<D>,
        usage: 'vertex',
    });
    return new AttributeNode(schema, buffer, options);
}

/**
 * UV attribute node for texture coordinate access.
 *
 * Returns an AttributeNode that reads the 'uv' vertex attribute (or 'uv1', 'uv2', etc.
 * for additional UV channels).
 *
 * @param index - The UV channel index. Defaults to 0 (reads 'uv').
 *                Index 1 reads 'uv1', index 2 reads 'uv2', etc.
 * @returns An AttributeNode<Vec2fDesc> representing the UV coordinates.
 *
 * @example
 * // Default UV channel
 * const texCoord = uv();
 *
 * // Second UV channel (e.g., for lightmaps)
 * const lightmapUV = uv(1);
 *
 * // Sample a texture with UVs
 * const color = myTexture.sample(uv());
 */
export const uv = (index = 0): AttributeNode<d.vec2f> =>
    new AttributeNode<d.vec2f>(d.vec2f, 'uv' + (index > 0 ? index : ''));
