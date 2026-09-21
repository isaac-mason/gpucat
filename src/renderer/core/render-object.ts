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

import { getIndexFormat } from '../../core/gpu-buffer';
import type { Geometry } from '../../geometry/geometry';
import type { Material } from '../../material/material';
import type { Mesh } from '../../objects/mesh';
import type { BindGroup } from './bind-group';
import type { NodeBuilderState } from './node-builder-state';
import { createBindings } from './node-builder-state';
import type { RenderContext } from './pass-context';
import type { View } from './view';

let renderObjectIdCounter = 0;

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
export function pipelineLabel(mesh: Mesh, material: Material): string {
    return mesh.name || material.name || material.constructor.name;
}

export function createRenderObject(mesh: Mesh, material: Material, camera: View, renderContext: RenderContext): RenderObject {
    return {
        id: renderObjectIdCounter++,

        // Source references
        mesh,
        material,
        geometry: mesh.geometry,
        camera,
        renderContext,
        lastPassLabel: '',

        // Compiled state (lazy)
        nodeBuilderState: null,
        _bindings: null,

        // Cache keys
        version: 0,
        materialVersion: 0,
        geometryVersion: 0,

        // Pipeline key cache
        _cachedPipelineKey: null,
        _pipelineKeyVersion: 0,
        _pipelineKeyGeometryVersion: -1,

        // Disposal
        onDispose: null,
        disposed: false,
    };
}

/**
 * Dispose a RenderObject and clean up GPU resources.
 */
export function disposeRenderObject(renderObject: RenderObject): void {
    if (renderObject.disposed) return;

    renderObject.disposed = true;
    renderObject.onDispose?.();

    // Clear references.
    // The WebGPU device payload (pipeline, bindGroups, resolved buffers) lives in
    // the RenderObjectGpu side table and is dropped when the RenderObject is GC'd
    // (WeakMap), or cleared explicitly by the WebGPU disposal path.
    renderObject.nodeBuilderState = null;
    renderObject._bindings = null;
    renderObject.onDispose = null;
}

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
export function getBindings(renderObject: RenderObject): BindGroup[] {
    if (renderObject._bindings !== null) {
        return renderObject._bindings;
    }

    if (renderObject.nodeBuilderState === null) {
        throw new Error('Cannot get bindings: nodeBuilderState is not set');
    }

    // Create bindings from NodeBuilderState (clones non-shared, reuses shared)
    renderObject._bindings = createBindings(renderObject.nodeBuilderState);
    return renderObject._bindings;
}

/**
 * Compute the cache key for a RenderObject based on material and geometry.
 *
 * This is used to detect when recompilation is needed.
 * The key includes render state, geometry attributes, and context configuration.
 */
export function computeRenderObjectCacheKey(
    material: Material,
    geometry: Geometry,
    renderContext: RenderContext,
    maxTextureSize?: number,
): string {
    // Build cache key from material render state
    const parts: string[] = [];

    // The storage() read-lowering bakes a MAX_TEXTURE_SIZE-derived texel-grid width into the GLSL, so a
    // shader compiled for one device's cap must not be reused on a smaller-cap context (belt-and-suspenders
    // — the program cache is per-renderer, but a RenderObject's compiled source can be shared).
    if (maxTextureSize !== undefined) parts.push(`m${maxTextureSize}`);

    // Material render state
    parts.push(material.transparent ? 't' : 'o');
    parts.push(material.depthTest ? 'd' : '');
    parts.push(material.depthWrite ? 'w' : '');
    parts.push(material.depthCompare);
    parts.push(material.cullMode);
    parts.push(material.alphaToCoverage ? 'a' : '');
    parts.push(`v${material.version}`);

    // Blend state (if present)
    if (material.blend) {
        parts.push('b');
        parts.push(material.blend.color?.operation ?? 'add');
        parts.push(material.blend.alpha?.operation ?? 'add');
    }

    // Geometry buffers (names and formats)
    const bufferKeys: string[] = [];
    for (const [name, buffer] of geometry.buffers) {
        bufferKeys.push(`${name}:${buffer.format ?? 'auto'}`);
    }
    bufferKeys.sort();
    parts.push(bufferKeys.join(','));

    // Index format
    if (geometry.index) {
        const fmt = getIndexFormat(geometry.index.array);
        if (fmt) parts.push(fmt);
    }

    // Render context (sample count, attachment config)
    parts.push(`s${renderContext.sampleCount}`);
    parts.push(renderContext.depth ? 'D' : '');
    parts.push(renderContext.stencil ? 'S' : '');

    return parts.join('|');
}
