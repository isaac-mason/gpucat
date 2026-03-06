/**
 * render-objects.ts - RenderObject manager with ChainMap caching.
 *
 * Aligned with Three.js RenderObjects class:
 * - Creates and caches RenderObjects per (mesh, material, renderContext, passId) tuple
 * - Uses ChainMap for automatic garbage collection
 * - Coordinates initialization of NodeBuilderState, pipeline, bindings
 *
 * The RenderObjects manager is the central orchestrator that brings together:
 * - NodeManager (compilation)
 * - Geometries (attribute uploads)
 * - Bindings (bind group management)
 * - Pipeline cache (pipeline creation)
 */

import type { Mesh } from '../objects/mesh';
import type { Material } from '../material/material';
import type { Scene } from '../scene/scene';
import type { Camera } from '../camera/camera';
import type { RenderContext } from './render-context';
import type { NodeManagerState } from './node-manager';
import type { GeometriesState } from './geometries';
import type { BindingsState } from './bindings';
import type { PipelineCache } from './pipelines';
import type { RenderObject, GeometryGroup } from './render-object';

import { OutputStructNode, type Node, type WgslType } from '../nodes/nodes';
import { createRenderObject, disposeRenderObject, computeRenderObjectCacheKey } from './render-object';
import * as chainMap from './chain-map';
import { compileNodeState, needsNodeUpdate } from './node-manager';
import { updateForRender as updateGeometry } from './geometries';
import { updateBindings, initBindings, getBindGroupLayouts } from './bindings';

/**
 * RenderObjects state - manages RenderObject creation and caching.
 */
export type RenderObjectsState = {
    /** NodeManager for compilation. */
    nodes: NodeManagerState;

    /** Geometries system for attribute management. */
    geometries: GeometriesState;

    /** Bindings system for bind group management. */
    bindings: BindingsState;

    /** Pipeline cache for pipeline creation. */
    pipelines: PipelineCache;

    /** GPU device reference. */
    device: GPUDevice;

    /**
     * Per-pass ChainMaps for RenderObject caching.
     * Each passId (e.g., 'default', 'shadow', 'reflection') gets its own ChainMap.
     */
    chainMaps: Map<string, chainMap.ChainMap<RenderObject>>;

    /**
     * All active RenderObjects (for iteration/disposal).
     */
    renderObjects: Set<RenderObject>;
};

/**
 * Create a new RenderObjects state.
 */
export function createRenderObjectsState(deps: {
    nodes: NodeManagerState;
    geometries: GeometriesState;
    bindings: BindingsState;
    pipelines: PipelineCache;
    device: GPUDevice;
}): RenderObjectsState {
    return {
        nodes: deps.nodes,
        geometries: deps.geometries,
        bindings: deps.bindings,
        pipelines: deps.pipelines,
        device: deps.device,
        chainMaps: new Map(),
        renderObjects: new Set(),
    };
}

/**
 * Get or create the ChainMap for a pass.
 */
function getChainMap(state: RenderObjectsState, passId: string): chainMap.ChainMap<RenderObject> {
    let map = state.chainMaps.get(passId);
    if (!map) {
        map = chainMap.create<RenderObject>();
        state.chainMaps.set(passId, map);
    }
    return map;
}

/**
 * Get or create a RenderObject for the given parameters.
 *
 * This is the main entry point for obtaining a RenderObject. It:
 * 1. Looks up existing RenderObject in ChainMap cache
 * 2. Creates new RenderObject if not found
 * 3. Initializes NodeBuilderState, pipeline, bindings if needed
 *
 * @param state - The RenderObjects state
 * @param mesh - The mesh to render
 * @param material - The material to use
 * @param scene - The scene containing the mesh
 * @param camera - The camera for rendering
 * @param renderContext - The render context (framebuffer config)
 * @param passId - Pass identifier (e.g., 'default', 'shadow')
 * @param group - Optional geometry group for multi-material meshes
 */
export function getRenderObject(
    state: RenderObjectsState,
    mesh: Mesh,
    material: Material,
    scene: Scene,
    camera: Camera,
    renderContext: RenderContext,
    passId: string = 'default',
    group: GeometryGroup | null = null,
): RenderObject {
    const map = getChainMap(state, passId);
    const keys = [mesh, material, renderContext];

    // Try to get existing RenderObject
    let renderObject = chainMap.get(map, keys);

    if (!renderObject) {
        // Create new RenderObject
        renderObject = createRenderObject(mesh, material, scene, camera, renderContext, group);

        // Compute and store initial cache key
        renderObject.initialCacheKey = computeRenderObjectCacheKey(material, mesh.geometry, renderContext);

        // Set up disposal callback
        renderObject.onDispose = () => {
            chainMap.del(map, keys);
            state.renderObjects.delete(renderObject!);
        };

        // Cache it
        chainMap.set(map, keys, renderObject);
        state.renderObjects.add(renderObject);
    } else {
        // Update mutable references that may have changed
        renderObject.camera = camera;
        renderObject.scene = scene;
    }

    return renderObject;
}

/**
 * Initialize a RenderObject for rendering.
 *
 * This ensures the RenderObject has:
 * - NodeBuilderState (compiled shader)
 * - Pipeline
 * - Bindings
 * - Geometry attributes uploaded
 *
 * Call this before rendering with a RenderObject.
 *
 * @param state - The RenderObjects state
 * @param renderObject - The RenderObject to initialize
 * @param colorFormat - The color texture format for pipeline creation
 * @param depthFormat - The depth texture format for pipeline creation
 * @returns true if initialization succeeded
 */
export function initRenderObject(
    state: RenderObjectsState,
    renderObject: RenderObject,
    colorFormat: GPUTextureFormat,
    depthFormat: GPUTextureFormat | null,
): boolean {
    const material = renderObject.material;
    const geometry = renderObject.geometry;
    const renderContext = renderObject.renderContext;

    // Compute current cache key
    const cacheKey = computeRenderObjectCacheKey(material, geometry, renderContext);

    // Check if we need to (re)compile
    if (needsNodeUpdate(state.nodes, renderObject, cacheKey)) {
        // Compile node graph
        compileNodeState(state.nodes, renderObject, cacheKey);
    }

    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState) {
        console.warn('[RenderObjects] Failed to compile NodeBuilderState');
        return false;
    }

    // Initialize bindings (creates bind group layouts)
    initBindings(state.bindings, renderObject);

    // Get bind group layouts for pipeline creation
    const bindGroupLayouts = getBindGroupLayouts(state.bindings, renderObject);

    // Check if we need to create/update pipeline
    if (!renderObject.pipeline) {
        // Create pipeline using the pipeline cache
        // Note: This integrates with the existing pipeline system
        // The actual pipeline creation is delegated to pipelines.ts
        const pipeline = createPipelineForRenderObject(
            state,
            renderObject,
            nodeState.code,
            bindGroupLayouts,
            colorFormat,
            depthFormat,
        );
        renderObject.pipeline = pipeline;
    }

    // Update geometry attributes
    updateGeometry(state.geometries, renderObject);

    return true;
}

/**
 * Update a RenderObject for rendering.
 *
 * This is called each frame to:
 * - Update uniform buffers
 * - Rebuild bind groups if needed
 *
 * @param state - The RenderObjects state
 * @param renderObject - The RenderObject to update
 * @param camera - Current camera
 * @param elapsed - Elapsed time
 * @param delta - Delta time
 * @param width - Render width
 * @param height - Render height
 */
export function updateRenderObject(
    state: RenderObjectsState,
    renderObject: RenderObject,
    camera: Camera,
    elapsed: number,
    delta: number,
    width: number,
    height: number,
): void {
    // Update bindings (uniforms, bind groups)
    updateBindings(
        state.bindings,
        renderObject,
        camera,
        elapsed,
        delta,
        width,
        height,
    );

    // Update geometry if needed
    updateGeometry(state.geometries, renderObject);
}

/**
 * Initialize a RenderObject asynchronously for pre-warming.
 *
 * This is similar to initRenderObject but uses createRenderPipelineAsync()
 * for non-blocking pipeline compilation. Use this in renderer.compile() to
 * pre-warm all pipelines without blocking the main thread.
 *
 * @param state - The RenderObjects state
 * @param renderObject - The RenderObject to initialize
 * @param colorFormat - The color texture format for pipeline creation
 * @param depthFormat - The depth texture format for pipeline creation
 * @returns Promise that resolves to true if initialization succeeded
 */
export async function initRenderObjectAsync(
    state: RenderObjectsState,
    renderObject: RenderObject,
    colorFormat: GPUTextureFormat,
    depthFormat: GPUTextureFormat | null,
): Promise<boolean> {
    const material = renderObject.material;
    const geometry = renderObject.geometry;
    const renderContext = renderObject.renderContext;

    // Compute current cache key
    const cacheKey = computeRenderObjectCacheKey(material, geometry, renderContext);

    // Check if we need to (re)compile
    if (needsNodeUpdate(state.nodes, renderObject, cacheKey)) {
        // Compile node graph (sync - this is fast)
        compileNodeState(state.nodes, renderObject, cacheKey);
    }

    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState) {
        console.warn('[RenderObjects] Failed to compile NodeBuilderState');
        return false;
    }

    // Initialize bindings (creates bind group layouts)
    initBindings(state.bindings, renderObject);

    // Get bind group layouts for pipeline creation
    const bindGroupLayouts = getBindGroupLayouts(state.bindings, renderObject);

    // Check if we need to create/update pipeline
    if (!renderObject.pipeline) {
        // Create pipeline asynchronously
        const pipeline = await createPipelineForRenderObjectAsync(
            state,
            renderObject,
            nodeState.code,
            bindGroupLayouts,
            colorFormat,
            depthFormat,
        );
        renderObject.pipeline = pipeline;
    }

    // Update geometry attributes
    updateGeometry(state.geometries, renderObject);

    return true;
}

/**
 * Create a render pipeline for a RenderObject.
 *
 * This wraps the existing pipeline cache integration.
 * The actual pipeline creation logic lives in pipelines.ts.
 */
function createPipelineForRenderObject(
    state: RenderObjectsState,
    renderObject: RenderObject,
    shaderCode: string,
    bindGroupLayouts: GPUBindGroupLayout[],
    colorFormat: GPUTextureFormat,
    depthFormat: GPUTextureFormat | null,
): GPURenderPipeline {
    const material = renderObject.material;
    const geometry = renderObject.geometry;
    const renderContext = renderObject.renderContext;

    // Build vertex buffer layouts from geometry attributes
    const vertexBufferLayouts = buildVertexBufferLayouts(geometry, renderObject.nodeBuilderState!);

    // Create pipeline layout
    const pipelineLayout = state.device.createPipelineLayout({
        bindGroupLayouts,
    });

    // Create shader module
    const shaderModule = state.device.createShaderModule({
        code: shaderCode,
    });

    // Debug: log shader WGSL and compilation info (remove when blank-canvas is fixed)
    console.groupCollapsed('[gpucat] compiled shader source');
    console.log(shaderCode);
    console.groupEnd();
    shaderModule.getCompilationInfo().then((info) => {
        for (const msg of info.messages) {
            console.error(`[gpucat shader ${msg.type}] line ${msg.lineNum}: ${msg.message}`);
        }
        if (info.messages.length === 0) {
            console.log('[gpucat] shader compiled with no errors/warnings');
        }
    });

    // Build color targets (supports MRT)
    const targetCount = getTargetCount(material.fragmentNode);
    const colorTargets: GPUColorTargetState[] = [];
    for (let i = 0; i < targetCount; i++) {
        colorTargets.push({
            format: colorFormat,
            blend: material.transparent ? getDefaultBlendState() : undefined,
            writeMask: GPUColorWrite.ALL,
        });
    }

    // Build pipeline descriptor
    const descriptor: GPURenderPipelineDescriptor = {
        layout: pipelineLayout,
        vertex: {
            module: shaderModule,
            entryPoint: 'vs_main',
            buffers: vertexBufferLayouts,
        },
        fragment: {
            module: shaderModule,
            entryPoint: 'fs_main',
            targets: colorTargets,
        },
        primitive: {
            topology: 'triangle-list',
            cullMode: material.cullMode,
            frontFace: 'ccw',
        },
        depthStencil: depthFormat
            ? {
                  format: depthFormat,
                  depthWriteEnabled: material.depthWrite,
                  depthCompare: material.depthTest ? material.depthCompare : 'always',
              }
            : undefined,
        multisample: {
            count: renderContext.sampleCount,
            alphaToCoverageEnabled: material.alphaToCoverage,
        },
    };

    return state.device.createRenderPipeline(descriptor);
}

/**
 * Create a render pipeline asynchronously for a RenderObject.
 *
 * Uses createRenderPipelineAsync() for non-blocking pipeline compilation.
 * Used by compile() to pre-warm pipelines without blocking the main thread.
 */
async function createPipelineForRenderObjectAsync(
    state: RenderObjectsState,
    renderObject: RenderObject,
    shaderCode: string,
    bindGroupLayouts: GPUBindGroupLayout[],
    colorFormat: GPUTextureFormat,
    depthFormat: GPUTextureFormat | null,
): Promise<GPURenderPipeline> {
    const material = renderObject.material;
    const geometry = renderObject.geometry;
    const renderContext = renderObject.renderContext;

    // Build vertex buffer layouts from geometry attributes
    const vertexBufferLayouts = buildVertexBufferLayouts(geometry, renderObject.nodeBuilderState!);

    // Create pipeline layout
    const pipelineLayout = state.device.createPipelineLayout({
        bindGroupLayouts,
    });

    // Create shader module
    const shaderModule = state.device.createShaderModule({
        code: shaderCode,
    });

    // Build color targets (supports MRT)
    const targetCount = getTargetCount(material.fragmentNode);
    const colorTargets: GPUColorTargetState[] = [];
    for (let i = 0; i < targetCount; i++) {
        colorTargets.push({
            format: colorFormat,
            blend: material.transparent ? getDefaultBlendState() : undefined,
            writeMask: GPUColorWrite.ALL,
        });
    }

    // Build pipeline descriptor
    const descriptor: GPURenderPipelineDescriptor = {
        layout: pipelineLayout,
        vertex: {
            module: shaderModule,
            entryPoint: 'vs_main',
            buffers: vertexBufferLayouts,
        },
        fragment: {
            module: shaderModule,
            entryPoint: 'fs_main',
            targets: colorTargets,
        },
        primitive: {
            topology: 'triangle-list',
            cullMode: material.cullMode,
            frontFace: 'ccw',
        },
        depthStencil: depthFormat
            ? {
                  format: depthFormat,
                  depthWriteEnabled: material.depthWrite,
                  depthCompare: material.depthTest ? material.depthCompare : 'always',
              }
            : undefined,
        multisample: {
            count: renderContext.sampleCount,
            alphaToCoverageEnabled: material.alphaToCoverage,
        },
    };

    return state.device.createRenderPipelineAsync(descriptor);
}

/**
 * Build vertex buffer layouts from geometry and NodeBuilderState.
 */
function buildVertexBufferLayouts(
    geometry: import('../geometry/geometry').Geometry,
    nodeState: import('./node-builder-state').NodeBuilderState,
): GPUVertexBufferLayout[] {
    const layouts: GPUVertexBufferLayout[] = [];

    for (const attrEntry of nodeState.attributes) {
        if (attrEntry.kind === 'geometry') {
            // Geometry attribute (position, normal, uv, etc.)
            const attr = geometry.attributes.get(attrEntry.name);
            if (!attr) continue;

            const bytesPerElement = getBytesPerElement(attr.format);
            const arrayStride = attr.stride > 0 ? attr.stride : bytesPerElement;

            layouts.push({
                arrayStride,
                stepMode: 'vertex',
                attributes: [
                    {
                        format: attr.format!,
                        offset: attr.offset,
                        shaderLocation: attrEntry.location,
                    },
                ],
            });
        } else {
            // Buffer attribute (including instanced buffer attributes)
            const node = attrEntry.node;
            const format = wgslTypeToVertexFormat(attrEntry.type);
            const itemSize = wgslTypeItemSize(attrEntry.type);
            const arrayStride = node.stride > 0 ? node.stride : itemSize * 4;

            layouts.push({
                arrayStride,
                stepMode: node.instanced ? 'instance' : 'vertex',
                attributes: [
                    {
                        format,
                        offset: node.offset,
                        shaderLocation: attrEntry.location,
                    },
                ],
            });
        }
    }

    return layouts;
}

/**
 * Get bytes per element for a vertex format.
 */
function getBytesPerElement(format: GPUVertexFormat | undefined): number {
    if (!format) return 16; // Default to vec4

    const formatSizes: Record<string, number> = {
        float32: 4,
        float32x2: 8,
        float32x3: 12,
        float32x4: 16,
        sint32: 4,
        sint32x2: 8,
        sint32x3: 12,
        sint32x4: 16,
        uint32: 4,
        uint32x2: 8,
        uint32x3: 12,
        uint32x4: 16,
        sint16x2: 4,
        sint16x4: 8,
        uint16x2: 4,
        uint16x4: 8,
        sint8x2: 2,
        sint8x4: 4,
        uint8x2: 2,
        uint8x4: 4,
    };

    return formatSizes[format] ?? 16;
}

/**
 * Get the number of color targets for MRT support.
 * OutputStructNode (used for MRT) has multiple members; regular shaders have 1 target.
 */
function getTargetCount(fragmentNode: Node<WgslType>): number {
    if (fragmentNode instanceof OutputStructNode) {
        return Math.max(1, fragmentNode.members.length);
    }
    return 1;
}

/**
 * Convert WGSL type to GPU vertex format.
 */
function wgslTypeToVertexFormat(type: string): GPUVertexFormat {
    switch (type) {
        case 'f32':
            return 'float32';
        case 'vec2f':
            return 'float32x2';
        case 'vec3f':
            return 'float32x3';
        case 'vec4f':
            return 'float32x4';
        case 'i32':
            return 'sint32';
        case 'vec2i':
            return 'sint32x2';
        case 'vec3i':
            return 'sint32x3';
        case 'vec4i':
            return 'sint32x4';
        case 'u32':
            return 'uint32';
        case 'vec2u':
            return 'uint32x2';
        case 'vec3u':
            return 'uint32x3';
        case 'vec4u':
            return 'uint32x4';
        default:
            return 'float32x4';
    }
}

/**
 * Get the item size (number of components) for a WGSL type.
 */
function wgslTypeItemSize(type: string): number {
    switch (type) {
        case 'f32':
        case 'i32':
        case 'u32':
            return 1;
        case 'vec2f':
        case 'vec2i':
        case 'vec2u':
            return 2;
        case 'vec3f':
        case 'vec3i':
        case 'vec3u':
            return 3;
        case 'vec4f':
        case 'vec4i':
        case 'vec4u':
            return 4;
        default:
            return 4;
    }
}

/**
 * Get default blend state for transparent materials.
 */
function getDefaultBlendState(): GPUBlendState {
    return {
        color: {
            srcFactor: 'src-alpha',
            dstFactor: 'one-minus-src-alpha',
            operation: 'add',
        },
        alpha: {
            srcFactor: 'one',
            dstFactor: 'one-minus-src-alpha',
            operation: 'add',
        },
    };
}

/**
 * Dispose a specific RenderObject.
 */
export function disposeRenderObjectFromState(
    _state: RenderObjectsState,
    renderObject: RenderObject,
): void {
    disposeRenderObject(renderObject);
}

/**
 * Dispose all RenderObjects for a specific mesh.
 */
export function disposeRenderObjectsForMesh(
    state: RenderObjectsState,
    mesh: Mesh,
): void {
    for (const renderObject of state.renderObjects) {
        if (renderObject.mesh === mesh) {
            disposeRenderObject(renderObject);
        }
    }
}

/**
 * Dispose all RenderObjects for a specific material.
 */
export function disposeRenderObjectsForMaterial(
    state: RenderObjectsState,
    material: Material,
): void {
    for (const renderObject of state.renderObjects) {
        if (renderObject.material === material) {
            disposeRenderObject(renderObject);
        }
    }
}

/**
 * Dispose all RenderObjects.
 */
export function disposeAllRenderObjects(state: RenderObjectsState): void {
    for (const renderObject of state.renderObjects) {
        disposeRenderObject(renderObject);
    }
    state.renderObjects.clear();
    state.chainMaps.clear();
}

/**
 * Get statistics about RenderObjects.
 */
export function getRenderObjectsStats(state: RenderObjectsState): {
    total: number;
    perPass: Record<string, number>;
} {
    const perPass: Record<string, number> = {};

    // Count render objects per pass (approximate - we can't enumerate ChainMap)
    for (const passId of state.chainMaps.keys()) {
        perPass[passId] = 0;
    }

    // Count from the set
    for (const _ro of state.renderObjects) {
        // We don't track passId on RenderObject currently
        // This could be added if needed
    }

    return {
        total: state.renderObjects.size,
        perPass,
    };
}
