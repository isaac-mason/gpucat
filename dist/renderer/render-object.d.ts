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
import { type GpuBuffer } from '../core/gpu-buffer';
import type { Any } from '../schema/schema';
import type { Material } from '../material/material';
import type { Mesh } from '../objects/mesh';
import type { Camera } from '../camera/camera';
import type { Object3D } from '../core/object3d';
import type { RenderContext } from './pass-context';
import type { NodeBuilderState } from './node-builder-state';
import type { BindGroup } from './bind-group';
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
    /**
     * Callback to clean up GPU resources when disposed.
     */
    onDispose: (() => void) | null;
    /**
     * Whether this RenderObject has been disposed.
     */
    disposed: boolean;
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
export declare function createRenderObject(mesh: Mesh, material: Material, scene: Object3D, camera: Camera, renderContext: RenderContext): RenderObject;
/**
 * Check if the RenderObject has been initialized with compiled state.
 */
export declare function isInitialized(renderObject: RenderObject): boolean;
/**
 * Dispose a RenderObject and clean up GPU resources.
 */
export declare function disposeRenderObject(renderObject: RenderObject): void;
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
export declare function getBindings(renderObject: RenderObject): BindGroup[];
/**
 * Compute the cache key for a RenderObject based on material and geometry.
 *
 * This is used to detect when recompilation is needed.
 * The key includes render state, geometry attributes, and context configuration.
 */
export declare function computeRenderObjectCacheKey(material: Material, geometry: Geometry, renderContext: RenderContext): string;
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
export declare function getCachedPipelineKey(renderObject: RenderObject, samples: number, colorFormat: GPUTextureFormat, depthFormat: GPUTextureFormat | undefined, makeKeyFn: (material: Material, samples: number, format: GPUTextureFormat, depthFormat?: GPUTextureFormat) => string): string;
