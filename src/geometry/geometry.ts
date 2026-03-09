import type { Box3, Sphere } from 'mathcat';
import { BufferAttribute, IndexAttribute, IndirectStorageBufferAttribute } from '../core/attribute';

export class Geometry {
    /** Named vertex buffer attributes. Standard names: position, normal, uv, tangent. */
    readonly attributes: Map<string, BufferAttribute> = new Map();

    /** Optional index buffer. */
    index: IndexAttribute | undefined = undefined;

    /** Number of vertices. Used for non-indexed draws. */
    vertexCount: number = 0;

    /**
     * Version counter. Auto-incremented when attributes are added/removed.
     * The renderer uses this to detect when shader recompilation is needed.
     */
    version: number = 0;

    /**
     * Optional indirect draw buffer. When set, the renderer calls
     * drawIndirect / drawIndexedIndirect using this buffer instead of
     * draw / drawIndexed. `mesh.count` is ignored when this is set.
     */
    indirect: IndirectStorageBufferAttribute | undefined = undefined;

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
     * Add or replace a vertex attribute.
     * Automatically bumps version when a new attribute name is added.
     *
     * @example
     * geo.setAttribute('position', new BufferAttribute(positions, 3))
     */
    setAttribute(name: string, attr: BufferAttribute): this {
        const isNew = !this.attributes.has(name);
        this.attributes.set(name, attr);
        if (isNew) {
            this.version++;
        }
        return this;
    }

    /**
     * Remove a vertex attribute by name.
     * Automatically bumps version when an attribute is removed.
     */
    deleteAttribute(name: string): this {
        if (this.attributes.delete(name)) {
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
