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
     * Optional indirect draw buffer. When set, the renderer calls
     * drawIndirect / drawIndexedIndirect using this buffer instead of
     * draw / drawIndexed. `mesh.count` is ignored when this is set.
     */
    indirect: IndirectStorageBufferAttribute | undefined = undefined;

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
     * Convenience alias for `this.attributes.set(name, attr)`.
     *
     * @example
     * geo.setAttribute('position', new BufferAttribute(positions, 3))
     */
    setAttribute(name: string, attr: BufferAttribute): this {
        this.attributes.set(name, attr);
        return this;
    }

    /**
     * Frees GPU-related resources allocated for this geometry.
     * Call this method when the geometry is no longer used.
     * Mirrors Three.js BufferGeometry.dispose().
     */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this._onDispose?.();
    }
}
