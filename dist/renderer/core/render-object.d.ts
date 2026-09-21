/**
 * render-object.ts - Per-draw-call state container.
 *
 * - Central hub owning all per-draw-call state
 * - One RenderObject per unique (mesh, material, renderContext) tuple
 * - Caches nodeBuilderState, pipeline, bindings, attributes
 * - Lazily initialized - starts empty, populated on first render
 *
 * Binding lifecycle:
 * - _bindings is lazily created via getBindings()
 * - getBindings() calls NodeBuilderState.createBindings() which clones non-shared groups
 * - This ensures shared groups (camera, time) are reused across all RenderObjects
 */
import type { Geometry } from '../../geometry/geometry';
import type { Material } from '../../material/material';
import type { Mesh } from '../../objects/mesh';
import type { BindGroup } from './bind-group';
import type { NodeBuilderState } from './node-builder-state';
import type { RenderContext } from './pass-context';
import type { View } from './view';
/**
 * RenderObject - Per-draw-call state container.
 *
 * This is the central hub that owns all state needed to execute a draw call:
 * - Source references (mesh, material, geometry, camera, renderContext)
 * - Compiled state (nodeBuilderState, pipeline, bindings)
 * - Attribute state (vertex buffers, index buffer)
 * - Draw parameters
 *
 * RenderObjects are cached by (mesh, material, renderContext) in the RenderObjects manager.
 */
export type RenderObject = {
    /** Unique identifier. */
    readonly id: number;
    /** The mesh being rendered. */
    mesh: Mesh;
    /** The material to render with. */
    material: Material;
    /** From `mesh.geometry`, and the one source reference the cache key does not cover. */
    geometry: Geometry;
    /** The camera for this render pass. */
    camera: View;
    /** The render context (framebuffer config). */
    renderContext: RenderContext;
    /** Label of the pass that last drew this, for the inspector only. Never part of the identity. */
    lastPassLabel: string;
    /**
     * Compiled shader state.
     * null until first compilation.
     */
    nodeBuilderState: NodeBuilderState | null;
    /**
     * BindGroup instances for this RenderObject.
     * Lazily created via getBindings() from NodeBuilderState.createBindings().
     * Shared groups are reused across all RenderObjects, non-shared are cloned.
     * null until first access.
     */
    _bindings: BindGroup[] | null;
    /**
     * Version counter - incremented when RenderObject state changes.
     */
    version: number;
    /**
     * Material version when last compiled.
     * Used to detect material changes.
     */
    materialVersion: number;
    /**
     * Geometry version when last updated.
     * Used to detect geometry changes.
     */
    geometryVersion: number;
    /**
     * Cached pipeline key to avoid recomputation every frame.
     * null until first computation.
     */
    _cachedPipelineKey: string | null;
    /**
     * Material version when pipeline key was last computed.
     * Used to invalidate cache when material changes.
     */
    _pipelineKeyVersion: number;
    /** Geometry version the cached key was built at; the key carries the vertex layout. @internal */
    _pipelineKeyGeometryVersion: number;
    /**
     * Callback to clean up GPU resources when disposed.
     */
    onDispose: (() => void) | null;
    /**
     * Whether this RenderObject has been disposed.
     */
    disposed: boolean;
};
/** What the inspector calls this draw: the mesh, else the material's own name, else its class. */
export declare function pipelineLabel(mesh: Mesh, material: Material): string;
export declare function createRenderObject(mesh: Mesh, material: Material, camera: View, renderContext: RenderContext): RenderObject;
/**
 * Dispose a RenderObject and clean up GPU resources.
 */
export declare function disposeRenderObject(renderObject: RenderObject): void;
/**
 * Get the BindGroups for a RenderObject, lazily creating them.
 *
 * - First access calls NodeBuilderState.createBindings()
 * - This clones non-shared groups, reuses shared groups
 * - Subsequent accesses return the cached bindings
 *
 * @param renderObject - The RenderObject
 * @returns Array of BindGroups for this RenderObject
 * @throws Error if nodeBuilderState is not set
 */
export declare function getBindings(renderObject: RenderObject): BindGroup[];
/**
 * Compute the cache key for a RenderObject based on material and geometry.
 *
 * This is used to detect when recompilation is needed.
 * The key includes render state, geometry attributes, and context configuration.
 */
export declare function computeRenderObjectCacheKey(material: Material, geometry: Geometry, renderContext: RenderContext, maxTextureSize?: number): string;
