import type { Box3, Sphere } from 'mathcat';
import type { GpuBuffer } from '../core/gpu-buffer';
import type { Any } from '../schema/schema';

/**
 * Subset of geometry to draw.
 * - `start` maps to `firstVertex` (non-indexed) or `firstIndex` (indexed).
 * - `count` is the number of vertices/indices to draw. `Infinity` means the full buffer.
 */
export type DrawRange = {
    start: number;
    count: number;
};

export class Geometry {
    /** Buffers mapped by name. Can be vertex attributes, storage buffers, or any buffer type. @see setBuffer() @see removeBuffer() */
    buffers: Map<string, GpuBuffer<Any>> = new Map();

    /** Optional index buffer. Must have 'index' usage. @see setIndex(). */
    index: GpuBuffer<Any> | undefined = undefined;

    /**
     * Range of vertices/indices to draw.
     * `start` maps to `firstVertex` (non-indexed) or `firstIndex` (indexed).
     * `count` is the number of vertices/indices. Defaults to `Infinity` (full buffer).
     */
    drawRange: DrawRange = { start: 0, count: Infinity };

    /** Geometry ersion counter. Auto-incremented when buffers are added/removed */
    version: number = 0;

    /**
     * Optional indirect draw buffer. When set, the renderer calls
     * drawIndirect / drawIndexedIndirect using this buffer instead of
     * draw / drawIndexed. `mesh.count` is ignored when this is set.
     * Must have 'indirect' usage.
     * @see setIndirect
     */
    indirect: GpuBuffer<Any> | undefined = undefined;

    /**
     * Byte offset into the indirect buffer where draw parameters begin.
     * Useful when non-indirect data precedes the DrawIndirect/DrawIndexedIndirect structs.
     * Defaults to 0.
     */
    indirectOffset: number = 0;

    /**
     * Number of indirect draws to issue from `indirect`. Defaults to `undefined`,
     * meaning "use the full buffer" (`indirect.count`). Set this when the buffer
     * is pre-sized to a capacity and only a prefix of entries are active —
     * avoids padding unused slots with zero-instance entries.
     *
     * When stable WebGPU multi-draw lands, this is the natural place to map to
     * the native `drawCount` parameter — same semantics, same field.
     */
    indirectDrawCount: number | undefined = undefined;

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
     * Get a named buffer with optional type narrowing.
     */
    getBuffer<T extends Any = Any>(name: string): GpuBuffer<T> | undefined {
        return this.buffers.get(name) as GpuBuffer<T> | undefined;
    }

    /**
     * Set a named buffer.
     * Works for vertex attributes, storage buffers, or any buffer type.
     * Automatically bumps version when a new buffer name is added.
     * For REF_COUNTED buffers, increments usage count.
     *
     * @example Vertex attribute
     * geometry.setBuffer('position', new GpuBuffer(d.vec3f, { data: positions, usage: 'vertex' }));
     *
     * @example Storage buffer
     * geometry.setBuffer('particles', new GpuBuffer(d.array(Particle), { data: new Float32Array(1000 * stride), usage: 'storage' }));
     */
    setBuffer(name: string, buffer: GpuBuffer<Any>): this {
        const existing = this.buffers.get(name);

        if (existing && existing !== buffer) {
            existing.decreaseUsages();
        }

        const isNew = !existing;
        this.buffers.set(name, buffer);

        if (existing !== buffer) {
            buffer.increaseUsages();
        }

        if (isNew) {
            this.version++;
        }
        return this;
    }

    /**
     * Remove a buffer by name.
     * Automatically bumps version when a buffer is removed.
     * For REF_COUNTED buffers, decrements usage count.
     */
    removeBuffer(name: string): this {
        const buffer = this.buffers.get(name);
        if (buffer) {
            buffer.decreaseUsages();
            this.buffers.delete(name);
            this.version++;
        }
        return this;
    }

    /**
     * Set the indirect draw buffer.
     * For REF_COUNTED buffers, manages usage count properly.
     * @param buffer The indirect buffer, or undefined to clear.
     * @param offset Byte offset into the buffer where draw parameters begin.
     */
    setIndirect(buffer: GpuBuffer<Any> | undefined, offset: number = 0): this {
        const existing = this.indirect;

        if (existing && existing !== buffer) {
            existing.decreaseUsages();
        }

        this.indirect = buffer;
        this.indirectOffset = offset;

        if (buffer && existing !== buffer) {
            buffer.increaseUsages();
        }

        return this;
    }

    /**
     * Set the index buffer.
     * For REF_COUNTED buffers, manages usage count properly.
     * @param buffer The index buffer, or undefined to clear. Must have 'index' usage.
     */
    setIndex(buffer: GpuBuffer<Any> | undefined): this {
        const existing = this.index;

        if (existing && existing !== buffer) {
            existing.decreaseUsages();
        }

        this.index = buffer;

        if (buffer && existing !== buffer) {
            buffer.increaseUsages();
        }

        return this;
    }

    /**
     * Frees GPU-related resources allocated for this geometry.
     * For REF_COUNTED buffers, decrements usage count (may trigger buffer disposal).
     * Call this method when the geometry is no longer used.
     */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;

        for (const buffer of this.buffers.values()) {
            buffer.decreaseUsages();
        }

        this.index?.decreaseUsages();
        this.indirect?.decreaseUsages();

        this._onDispose?.();
    }
}
