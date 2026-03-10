import { GpuBuffer } from '../../core/buffer';
import { Node } from './core';
import type { Any, TypedArrayFor } from '../schema';
import * as d from '../schema';

/**
 * BufferAttributeNode — a vertex attribute backed by a GpuBuffer or raw TypedArray.
 *
 * This is for directly embedding buffer data in the node graph, as opposed to
 * AttributeNode which references buffers by name from geometry.
 *
 * Can be used for both regular vertex attributes and per-instance attributes
 * (stepMode: 'instance') by setting `instanced = true`.
 *
 * @example
 * // Instanced attribute:
 * const offsets = instancedBufferAttribute(new Float32Array([...]), d.vec3f);
 *
 * // Regular attribute:
 * const colors = bufferAttribute(new Float32Array([...]), d.vec3f);
 */
export class BufferAttributeNode<D extends Any> extends Node<D> {
    /** The underlying GpuBuffer. */
    readonly buffer: GpuBuffer<D>;
    /** Byte stride between consecutive elements. */
    readonly stride: number;
    /** Byte offset of this attribute within each element. */
    readonly offset: number;
    /** Whether this attribute is instanced (stepMode: 'instance'). */
    instanced: boolean;

    constructor(
        desc: D,
        value: GpuBuffer<D> | TypedArrayFor<D>,
        stride: number,
        offset: number,
        instanced: boolean
    ) {
        super(desc);

        // If passed a raw TypedArray, wrap it in a GpuBuffer
        if (ArrayBuffer.isView(value)) {
            this.buffer = new GpuBuffer(desc, { data: value, usage: 'vertex', instanced });
        } else {
            this.buffer = value;
        }

        this.stride = stride;
        this.offset = offset;
        this.instanced = instanced;
    }

    /** Set instanced flag (chainable). */
    setInstanced(value: boolean): this {
        this.instanced = value;
        return this;
    }
}

export class AttributeNode<D extends Any> extends Node<D> {
    constructor(
        desc: D,
        readonly name: string
    ) {
        super(desc);
    }
}

export const attribute = <D extends Any>(name: string, desc: D) => new AttributeNode<D>(desc, name);

/**
 * Create a BufferAttributeNode — a vertex attribute backed by a GpuBuffer or TypedArray.
 *
 * @param value   A GpuBuffer or raw TypedArray.
 * @param desc    WgslDesc for the attribute element type (e.g. d.vec3f, d.f32).
 * @param stride  Byte stride between consecutive elements (default: 0 = tightly packed).
 * @param offset  Byte offset within each element (default: 0).
 *
 * @example
 * const colors = bufferAttribute(new Float32Array([1,0,0, 0,1,0]), d.vec3f);
 */
export const bufferAttribute = <D extends Any>(
    value: GpuBuffer<D> | TypedArrayFor<D>,
    desc: D,
    stride = 0,
    offset = 0
): BufferAttributeNode<D> => new BufferAttributeNode(desc, value, stride, offset, false);

/**
 * Create an instanced BufferAttributeNode — a per-instance vertex attribute
 * uploaded by the renderer as a vertex buffer with stepMode: 'instance'.
 *
 * @param value   A GpuBuffer or raw TypedArray.
 * @param desc    WgslDesc for the attribute element type (e.g. d.vec3f, d.f32).
 * @param stride  Byte stride between consecutive instance records (default: 0 = tightly packed).
 * @param offset  Byte offset within each instance record (default: 0).
 *
 * @example
 * const colors = instancedBufferAttribute(new Float32Array([1,0,0, 0,1,0]), d.vec3f);
 */
export const instancedBufferAttribute = <D extends Any>(
    value: GpuBuffer<D> | TypedArrayFor<D>,
    desc: D,
    stride = 0,
    offset = 0
): BufferAttributeNode<D> => new BufferAttributeNode(desc, value, stride, offset, true);


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
export const uv = (index = 0): AttributeNode<d.vec2f> => new AttributeNode<d.vec2f>(d.vec2f, 'uv' + (index > 0 ? index : ''));
