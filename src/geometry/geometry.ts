import type { Box3, Sphere } from 'mathcat';
import type { GpuBuffer } from '../core/buffer';
import type { Any } from '../nodes/schema';

/**
 * Index buffer type - always uint16 or uint32.
 * Kept separate from GpuBuffer because index buffers have special semantics
 * (setIndexBuffer takes a format param, only uint16/uint32 allowed).
 */
export type IndexBuffer = {
    array: Uint16Array | Uint32Array;
    format: 'uint16' | 'uint32';
    version: number;
};

export function createIndexBuffer(array: Uint16Array | Uint32Array): IndexBuffer {
    return {
        array,
        format: array instanceof Uint16Array ? 'uint16' : 'uint32',
        version: 0,
    };
}

export class Geometry {
    /**
     * Named buffers — vertex attributes, storage buffers, anything.
     * The usage is determined by the buffer itself and how shaders reference it.
     * Standard vertex attribute names: position, normal, uv, tangent.
     */
    readonly buffers: Map<string, GpuBuffer<Any>> = new Map();

    /**
     * Optional index buffer. Kept separate because index buffers have special
     * semantics (only uint16/uint32, passed to setIndexBuffer with format).
     */
    index: IndexBuffer | undefined = undefined;

    /** Number of vertices. Used for non-indexed draws. */
    vertexCount: number = 0;

    /**
     * Version counter. Auto-incremented when buffers are added/removed.
     * The renderer uses this to detect when shader recompilation is needed.
     */
    version: number = 0;

    /**
     * Optional indirect draw buffer. When set, the renderer calls
     * drawIndirect / drawIndexedIndirect using this buffer instead of
     * draw / drawIndexed. `mesh.count` is ignored when this is set.
     * Must have 'indirect' usage.
     */
    indirect: GpuBuffer<Any> | undefined = undefined;

    /**
     * Byte offset into the indirect buffer where draw parameters begin.
     * Useful when non-indirect data precedes the DrawIndirect/DrawIndexedIndirect structs.
     * Defaults to 0.
     */
    indirectOffset: number = 0;

    /**
     * Axis-aligned bounding box in local space.
     * Set by createBoxGeometry / createSphereGeometry / createPlaneGeometry.
     * You may set this manually for custom geometry to enable frustum culling.
     */
    boundingBox: Box3 | undefined = undefined;

    /**
     * Bounding sphere in local space.
     * Set by createBoxGeometry / createSphereGeometry / createPlaneGeometry.
     * You may set this manually for custom geometry to enable frustum culling.
     */
    boundingSphere: Sphere | undefined = undefined;

    /**
     * Set to true after dispose() is called.
     * The renderer checks this flag to skip rendering and clean up GPU resources.
     */
    disposed: boolean = false;

    /**
     * Internal callback set by the renderer to clean up GPU resources.
     * @internal
     */
    _onDispose: (() => void) | null = null;

    /**
     * Set a named buffer.
     * Works for vertex attributes, storage buffers, or any buffer type.
     * Automatically bumps version when a new buffer name is added.
     *
     * @example Vertex attribute
     * geometry.setBuffer('position', new GpuBuffer(d.vec3f, { data: positions, usage: 'vertex' }));
     *
     * @example Storage buffer
     * geometry.setBuffer('particles', new GpuBuffer(d.array(Particle), { data: 1000, usage: 'storage' }));
     */
    setBuffer(name: string, buffer: GpuBuffer<Any>): this {
        const isNew = !this.buffers.has(name);
        this.buffers.set(name, buffer);
        if (isNew) {
            this.version++;
        }
        return this;
    }

    /**
     * Get a named buffer with optional type narrowing.
     */
    getBuffer<T extends Any = Any>(name: string): GpuBuffer<T> | undefined {
        return this.buffers.get(name) as GpuBuffer<T> | undefined;
    }

    /**
     * Remove a buffer by name.
     * Automatically bumps version when a buffer is removed.
     */
    deleteBuffer(name: string): this {
        if (this.buffers.delete(name)) {
            this.version++;
        }
        return this;
    }

    /**
     * Frees GPU-related resources allocated for this geometry.
     * Call this method when the geometry is no longer used.
     */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this._onDispose?.();
    }
}
