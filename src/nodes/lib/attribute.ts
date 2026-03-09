import { StorageBufferAttribute, InstancedBufferAttribute } from '../../core/attribute';
import { Node, computeId, nextId, type GpuTypedArray, type WgslType } from './core';
import { itemSizeOf, type WgslDesc } from '../schema';

/**
 * BufferAttributeNode — a vertex attribute backed by a BufferAttribute or raw TypedArray.
 *
 * Can be used for both regular vertex attributes and per-instance attributes (stepMode: 'instance') by setting `instanced = true`.
 *
 * When passed an InstancedBufferAttribute, `instanced` is auto-set to true.
 *
 * @example
 * // Instanced attribute with InstancedBufferAttribute:
 * const attr = new InstancedBufferAttribute(new Float32Array([...]), 3);
 * const offsets = bufferAttribute(attr, S.vec3f());  // instanced = true auto
 *
 * // Instanced attribute with raw TypedArray:
 * const offsets = instancedBufferAttribute(new Float32Array([...]), S.vec3f());
 *
 * // Regular attribute:
 * const colors = bufferAttribute(new Float32Array([...]), S.vec3f());
 */
export class BufferAttributeNode<T extends WgslType> extends Node<T> {
    /** The underlying BufferAttribute (StorageBufferAttribute/InstancedBufferAttribute). */
    readonly attribute: StorageBufferAttribute | InstancedBufferAttribute;
    /** Byte stride between consecutive elements. */
    readonly stride: number;
    /** Byte offset of this attribute within each element. */
    readonly offset: number;
    /** Whether this attribute is instanced (stepMode: 'instance'). */
    instanced: boolean;

    constructor(
        type: T,
        value: StorageBufferAttribute | InstancedBufferAttribute | GpuTypedArray,
        stride: number,
        offset: number,
        itemSize: number
    ) {
        // ID is NOT content-addressed on data (too expensive to hash large arrays).
        // Use a monotonic id so two separate bufferAttribute() calls are always distinct.
        super(nextId(), type);

        // If passed a raw TypedArray, wrap it in a StorageBufferAttribute
        if (ArrayBuffer.isView(value)) {
            this.attribute = new StorageBufferAttribute(value as GpuTypedArray, itemSize);
            this.instanced = false;
        } else {
            this.attribute = value;
            // Auto-detect instanced from attribute type
            this.instanced = 'isInstancedBufferAttribute' in value && value.isInstancedBufferAttribute === true;
        }

        this.stride = stride;
        this.offset = offset;
    }

    /** Set instanced flag (chainable). */
    setInstanced(value: boolean): this {
        this.instanced = value;
        return this;
    }
}

export class AttributeNode<T extends WgslType> extends Node<T> {
    constructor(
        type: T,
        readonly name: string
    ) {
        super(computeId('attribute', { type, name }), type);
    }
}

export const attribute = <T extends WgslType>(type: WgslDesc<T>, name: string) => new AttributeNode<T>(type.wgslType as T, name);

/**
 * Internal helper for creating buffer attribute nodes.
 * @param value     A BufferAttribute, InstancedBufferAttribute, or raw TypedArray.
 * @param desc      WgslDesc for the attribute element type.
 * @param stride    Byte stride between consecutive elements
 * @param offset    Byte offset within each element
 * @param instanced Whether this is an instanced attribute.
 */
function createBufferAttribute<T extends WgslType>(
    value: StorageBufferAttribute | InstancedBufferAttribute | GpuTypedArray,
    desc: WgslDesc<T>,
    stride: number,
    offset: number,
    instanced: boolean
): BufferAttributeNode<T> {
    const node = new BufferAttributeNode(desc.wgslType as T, value, stride, offset, itemSizeOf(desc));
    if (instanced) node.setInstanced(true);
    return node;
}

/**
 * Create a BufferAttributeNode — a vertex attribute backed by a BufferAttribute or TypedArray.
 *
 * @param value   A BufferAttribute, InstancedBufferAttribute, or raw TypedArray.
 * @param desc    WgslDesc for the attribute element type (e.g. `S.vec3f()`, `S.f32()`).
 * @param stride  Byte stride between consecutive elements (default: 0 = tightly packed).
 * @param offset  Byte offset within each element (default: 0).
 *
 * @example
 * const colors = bufferAttribute(new Float32Array([1,0,0, 0,1,0]), S.vec3f());
 */
export const bufferAttribute = <T extends WgslType>(
    value: StorageBufferAttribute | InstancedBufferAttribute | GpuTypedArray,
    desc: WgslDesc<T>,
    stride = 0,
    offset = 0
) => createBufferAttribute(value, desc, stride, offset, false);

/**
 * Create an instanced BufferAttributeNode — a per-instance vertex attribute
 * uploaded by the renderer as a vertex buffer with stepMode: 'instance'.
 *
 * @param value   An InstancedBufferAttribute, or a raw TypedArray.
 * @param desc    WgslDesc for the attribute element type (e.g. `S.vec3f()`, `S.f32()`).
 * @param stride  Byte stride between consecutive instance records (default: 0 = tightly packed).
 * @param offset  Byte offset within each instance record (default: 0).
 *
 * @example
 * // With InstancedBufferAttribute:
 * const attr = new InstancedBufferAttribute(new Float32Array([1,0,0, 0,1,0]), 3);
 * const colors = instancedBufferAttribute(attr, S.vec3f());
 *
 * // With raw TypedArray:
 * const colors = instancedBufferAttribute(new Float32Array([1,0,0, 0,1,0]), S.vec3f());
 */
export const instancedBufferAttribute = <T extends WgslType>(
    value: InstancedBufferAttribute | GpuTypedArray,
    desc: WgslDesc<T>,
    stride = 0,
    offset = 0
) => createBufferAttribute(value, desc, stride, offset, true);


/**
 * UV attribute node for texture coordinate access.
 *
 * Returns an AttributeNode that reads the 'uv' vertex attribute (or 'uv1', 'uv2', etc.
 * for additional UV channels).
 *
 * @param index - The UV channel index. Defaults to 0 (reads 'uv').
 *                Index 1 reads 'uv1', index 2 reads 'uv2', etc.
 * @returns An AttributeNode<'vec2f'> representing the UV coordinates.
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
export const uv = (index = 0): AttributeNode<'vec2f'> => new AttributeNode<'vec2f'>('vec2f', 'uv' + (index > 0 ? index : ''));
