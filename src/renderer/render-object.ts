/**
 * render-object.ts - Per-draw-call state container.
 *
 * Aligned with Three.js RenderObject:
 * - Central hub owning all per-draw-call state
 * - One RenderObject per unique (mesh, material, renderContext, passId) tuple
 * - Caches nodeBuilderState, pipeline, bindings, attributes
 * - Lazily initialized - starts empty, populated on first render
 *
 * Key Three.js pattern:
 * - _bindings is lazily created via getBindings()
 * - getBindings() calls NodeBuilderState.createBindings() which clones non-shared groups
 * - This ensures shared groups (camera, time) are reused across all RenderObjects
 *
 * Unlike Three.js, we use a plain object type with factory function
 * rather than a class.
 */

import type { Geometry } from '../geometry/geometry';
import { getIndexFormat, type GpuBuffer } from '../core/gpu-buffer';
import type { Any } from '../schema/schema';
import type { Material } from '../material/material';
import type { Mesh } from '../objects/mesh';
import type { Camera } from '../camera/camera';
import type { Object3D } from '../core/object3d';
import type { RenderContext } from './pass-context';
import type { NodeBuilderState } from './node-builder-state';
import type { BindGroup } from './bind-group';
import { createBindings } from './node-builder-state';

let renderObjectIdCounter = 0;

/**
 * RenderObject - Per-draw-call state container.
 *
 * This is the central hub that owns all state needed to execute a draw call:
 * - Source references (mesh, material, geometry, camera, scene, renderContext)
 * - Compiled state (nodeBuilderState, pipeline, bindings)
 * - Attribute state (vertex buffers, index buffer)
 * - Draw parameters
 *
 * RenderObjects are cached by (mesh, material, renderContext, passId) in RenderObjects manager.
 */
export type RenderObject = {
    /** Unique identifier. */
    readonly id: number;

    // -------------------------------------------------------------------------
    // Source References
    // -------------------------------------------------------------------------

    /** The mesh being rendered. */
    mesh: Mesh;

    /** The material to render with. */
    material: Material;

    /** The geometry (from mesh.geometry, cached for convenience). */
    geometry: Geometry;

    /** The camera for this render pass. */
    camera: Camera;

    /** The scene/object containing the mesh. */
    scene: Object3D;

    /** The render context (framebuffer config). */
    renderContext: RenderContext;

    /** The render pass this RenderObject belongs to (e.g. 'default', 'shadow'). */
    passId: string;

    // -------------------------------------------------------------------------
    // Compiled State (lazily initialized)
    // -------------------------------------------------------------------------

    /**
     * Compiled shader state.
     * null until first compilation.
     */
    nodeBuilderState: NodeBuilderState | null;

    /**
     * GPU render pipeline.
     * null until pipeline is created.
     */
    pipeline: GPURenderPipeline | null;

    /**
     * GPU bind groups [render, object, storage].
     * null until bindings are created.
     */
    bindGroups: GPUBindGroup[] | null;

    /**
     * BindGroup instances for this RenderObject.
     * Lazily created via getBindings() from NodeBuilderState.createBindings().
     * Shared groups are reused across all RenderObjects, non-shared are cloned.
     * null until first access.
     */
    _bindings: BindGroup[] | null;

    // -------------------------------------------------------------------------
    // Buffer State
    // -------------------------------------------------------------------------

    /**
     * Vertex buffers used by this draw.
     * null until buffers are resolved.
     */
    vertexBuffers: GpuBuffer<Any>[] | null;

    /**
     * Index buffer (if indexed draw).
     * null for non-indexed draws.
     */
    indexBuffer: GpuBuffer<Any> | null;

    // -------------------------------------------------------------------------
    // Cache Keys & Version Tracking
    // -------------------------------------------------------------------------

    /**
     * Initial cache key computed when RenderObject was created.
     * Used to detect when recompilation is needed.
     */
    initialCacheKey: string;

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

    // -------------------------------------------------------------------------
    // Pipeline Key Cache
    // -------------------------------------------------------------------------

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

    // -------------------------------------------------------------------------
    // Disposal
    // -------------------------------------------------------------------------

    /**
     * Callback to clean up GPU resources when disposed.
     */
    onDispose: (() => void) | null;

    /**
     * Whether this RenderObject has been disposed.
     */
    disposed: boolean;

    // -------------------------------------------------------------------------
    // Type Flag
    // -------------------------------------------------------------------------

    readonly isRenderObject: true;
};

/**
 * Create a new RenderObject.
 *
 * @param mesh - The mesh to render
 * @param material - The material to use
 * @param scene - The scene/object containing the mesh
 * @param camera - The camera for rendering
 */
export function createRenderObject(
    mesh: Mesh,
    material: Material,
    scene: Object3D,
    camera: Camera,
    renderContext: RenderContext,
): RenderObject {
    return {
        id: renderObjectIdCounter++,

        // Source references
        mesh,
        material,
        geometry: mesh.geometry,
        camera,
        scene,
        renderContext,
        passId: '',

        // Compiled state (lazy)
        nodeBuilderState: null,
        pipeline: null,
        bindGroups: null,
        _bindings: null,

        // Attribute state (lazy)
        vertexBuffers: null,
        indexBuffer: null,

        // Cache keys
        initialCacheKey: '',
        version: 0,
        materialVersion: 0,
        geometryVersion: 0,

        // Pipeline key cache
        _cachedPipelineKey: null,
        _pipelineKeyVersion: 0,

        // Disposal
        onDispose: null,
        disposed: false,

        // Type flag
        isRenderObject: true,
    };
}

/**
 * Check if the RenderObject has been initialized with compiled state.
 */
export function isInitialized(renderObject: RenderObject): boolean {
    return renderObject.nodeBuilderState !== null && renderObject.pipeline !== null;
}

/**
 * Dispose a RenderObject and clean up GPU resources.
 */
export function disposeRenderObject(renderObject: RenderObject): void {
    if (renderObject.disposed) return;

    renderObject.disposed = true;
    renderObject.onDispose?.();

    // Clear references
    renderObject.nodeBuilderState = null;
    renderObject.pipeline = null;
    renderObject.bindGroups = null;
    renderObject._bindings = null;
    renderObject.vertexBuffers = null;
    renderObject.indexBuffer = null;
    renderObject.onDispose = null;
}

/**
 * Get the BindGroups for a RenderObject, lazily creating them.
 *
 * Three.js pattern (RenderObject.getBindings):
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
): string {
    // Build cache key from material render state
    const parts: string[] = [];

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

/**
 * Get or compute the cached pipeline key for a RenderObject.
 *
 * The pipeline key is used for:
 * 1. Pipeline cache lookup (avoid recomputing expensive key strings)
 * 2. Opaque sorting by pipeline (minimize setPipeline calls)
 *
 * The key is invalidated when material.version changes.
 *
 * @param renderObject - The RenderObject
 * @param samples - MSAA sample count
 * @param colorFormat - Color texture format
 * @param depthFormat - Depth texture format (undefined for no depth)
 * @param makeKeyFn - Function to compute the pipeline key (from pipelines.ts)
 * @returns The cached or newly computed pipeline key
 */
export function getCachedPipelineKey(
    renderObject: RenderObject,
    samples: number,
    colorFormat: GPUTextureFormat,
    depthFormat: GPUTextureFormat | undefined,
    makeKeyFn: (material: Material, samples: number, format: GPUTextureFormat, depthFormat?: GPUTextureFormat) => string,
): string {
    const currentVersion = renderObject.material.version;

    // Check if cache is valid
    if (
        renderObject._cachedPipelineKey !== null &&
        renderObject._pipelineKeyVersion === currentVersion
    ) {
        return renderObject._cachedPipelineKey;
    }

    // Recompute and cache
    const key = makeKeyFn(renderObject.material, samples, colorFormat, depthFormat);
    renderObject._cachedPipelineKey = key;
    renderObject._pipelineKeyVersion = currentVersion;

    return key;
}
