/**
 * pipelines.ts — Unified pipeline cache for render and compute pipelines.
 *
 * Aligned with Three.js Pipelines.js:
 * - Single cache system for both render and compute pipelines
 * - Uses NodeManager for node compilation (getForRender, getForCompute)
 * - Shared bind group layout cache
 *
 * Functional API:
 *   - createPipelinesState(device, format, nodes) → PipelinesState
 *   - getForRender(state, renderObject, ..., promises?) → GPURenderPipeline
 *   - getForCompute(state, computeNode, promises?) → ComputePipelineEntry
 *   - isReady(state, renderObject) → boolean
 */

import type { ComputeCompileResult } from '../nodes/builder';
import { type Node, type ComputeNode, OutputStructNode } from '../nodes/nodes';
import type { Any } from '../nodes/schema';
import type { Material } from '../material/material';
import type { Geometry } from '../geometry/geometry';
import type { RenderObject } from './render-object';
import { getCachedPipelineKey } from './render-object';
import type { NodeBuilderState } from './node-builder-state';
import type { NodeManagerState } from './node-manager';
import { getForCompute as nodeManagerGetForCompute } from './node-manager';
import {
    buildComputeBindGroupInfo,
    type BindGroupInfo,
    type BindGroupLayoutCache,
    createBindGroupLayoutCache,
} from './bindgroups';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ComputePipelineEntry = {
    pipeline: GPUComputePipeline | null;
    compileResult: ComputeCompileResult;
    bindGroupInfo: BindGroupInfo;
};

export type RenderPipelineEntry = {
    pipeline: GPURenderPipeline | null;
    cacheKey: string;
};

export type PipelinesStats = {
    renderCount: number;
    computeCount: number;
    bindGroupLayoutCount: number;
};

/**
 * Pipelines state object.
 * Holds all caches for render and compute pipelines.
 */
export type PipelinesState = {
    device: GPUDevice;
    format: GPUTextureFormat;
    depthFormat: GPUTextureFormat;

    /** NodeManager for node compilation. */
    nodes: NodeManagerState;

    /** Shared bind group layout cache for all pipelines. */
    bindGroupLayoutCache: BindGroupLayoutCache;

    /** Render pipelines - keyed by cache key. */
    renderPipelines: Map<string, RenderPipelineEntry>;

    /** Compute pipelines - keyed by node id. */
    computePipelines: Map<string, ComputePipelineEntry>;
};

/**
 * Create a pipelines state.
 */
export function createPipelinesState(
    device: GPUDevice,
    format: GPUTextureFormat,
    nodes: NodeManagerState,
): PipelinesState {
    return {
        device,
        format,
        depthFormat: 'depth24plus',
        nodes,
        bindGroupLayoutCache: createBindGroupLayoutCache(),
        renderPipelines: new Map(),
        computePipelines: new Map(),
    };
}

/**
 * Get cache statistics.
 */
export function getStats(state: PipelinesState): PipelinesStats {
    return {
        renderCount: state.renderPipelines.size,
        computeCount: state.computePipelines.size,
        bindGroupLayoutCount: state.bindGroupLayoutCache.cache.size,
    };
}

// ---------------------------------------------------------------------------
// Render Pipeline API
// ---------------------------------------------------------------------------

/**
 * Get or create a render pipeline for a RenderObject.
 *
 * @param state - The pipelines state
 * @param renderObject - The RenderObject (must have nodeBuilderState set)
 * @param bindGroupLayouts - The bind group layouts for the pipeline
 * @param colorFormat - The color texture format
 * @param depthFormat - The depth texture format (null for no depth)
 * @param promises - Optional array to collect async compilation promises (for compileAsync)
 * @returns The render pipeline entry
 */
export function getForRender(
    state: PipelinesState,
    renderObject: RenderObject,
    bindGroupLayouts: GPUBindGroupLayout[],
    colorFormat: GPUTextureFormat,
    depthFormat: GPUTextureFormat | null,
    promises: Promise<void>[] | null = null,
): RenderPipelineEntry {
    const cacheKey = getCachedPipelineKey(
        renderObject,
        renderObject.renderContext.sampleCount,
        colorFormat,
        depthFormat ?? undefined,
        makeRenderPipelineKey,
    );

    let entry = state.renderPipelines.get(cacheKey);
    if (entry) return entry;

    // Create new entry
    const nodeState = renderObject.nodeBuilderState!;
    entry = {
        pipeline: null,
        cacheKey,
    };
    state.renderPipelines.set(cacheKey, entry);

    // Build pipeline descriptor
    const descriptor = buildRenderPipelineDescriptor(
        state.device,
        renderObject,
        nodeState,
        bindGroupLayouts,
        colorFormat,
        depthFormat,
    );

    if (promises === null) {
        // Sync compilation
        entry.pipeline = state.device.createRenderPipeline(descriptor);
    } else {
        // Async compilation
        const p = (async () => {
            try {
                entry!.pipeline = await state.device.createRenderPipelineAsync(descriptor);
            } catch (err) {
                console.error('[pipelines] render pipeline compilation failed:', err);
            }
        })();
        promises.push(p);
    }

    return entry;
}

/**
 * Check if a render pipeline is ready for rendering.
 */
export function isReady(state: PipelinesState, renderObject: RenderObject, colorFormat: GPUTextureFormat, depthFormat: GPUTextureFormat | null): boolean {
    const cacheKey = getCachedPipelineKey(
        renderObject,
        renderObject.renderContext.sampleCount,
        colorFormat,
        depthFormat ?? undefined,
        makeRenderPipelineKey,
    );
    const entry = state.renderPipelines.get(cacheKey);
    return entry !== undefined && entry.pipeline !== null;
}

function buildRenderPipelineDescriptor(
    device: GPUDevice,
    renderObject: RenderObject,
    nodeState: NodeBuilderState,
    bindGroupLayouts: GPUBindGroupLayout[],
    colorFormat: GPUTextureFormat,
    depthFormat: GPUTextureFormat | null,
): GPURenderPipelineDescriptor {
    const material = renderObject.material;
    const geometry = renderObject.geometry;
    const renderContext = renderObject.renderContext;

    // Build vertex buffer layouts from geometry attributes
    const vertexBufferLayouts = buildVertexBufferLayouts(geometry, nodeState);

    // Create pipeline layout
    const pipelineLayout = device.createPipelineLayout({
        bindGroupLayouts,
    });

    // Create shader module
    const shaderModule = device.createShaderModule({
        code: nodeState.code,
    });
    shaderModule.getCompilationInfo().then((info) => {
        for (const msg of info.messages) {
            if (msg.type === 'error') {
                console.error(`[gpucat shader error] line ${msg.lineNum}: ${msg.message}\n${nodeState.code}`);
            }
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
    return {
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
            count: renderContext.sampleCount >= 4 ? 4 : 1,
            alphaToCoverageEnabled: material.alphaToCoverage,
        },
    };
}

// ---------------------------------------------------------------------------
// Compute Pipeline API
// ---------------------------------------------------------------------------

/**
 * Get or create a compute pipeline for a ComputeNode.
 *
 * @param state - The pipelines state
 * @param node - The ComputeNode
 * @param promises - Optional array to collect async compilation promises (for compileAsync)
 * @returns The compute pipeline entry
 */
export function getForCompute(
    state: PipelinesState,
    node: ComputeNode,
    promises: Promise<void>[] | null = null,
): ComputePipelineEntry {
    const key = node.id;

    let entry = state.computePipelines.get(key);
    if (entry) return entry;

    // Use NodeManager to get compiled compute state
    const computeState = nodeManagerGetForCompute(state.nodes, node);
    const cr = computeState.compileResult;

    const bindGroupInfo = buildComputeBindGroupInfo(state.device, cr, state.bindGroupLayoutCache);
    const bindGroupLayouts = bindGroupInfo.bindGroups.map((bg) => bg.layout);
    const pipelineLayout = state.device.createPipelineLayout({ bindGroupLayouts });

    const shaderModule = state.device.createShaderModule({ code: cr.code });

    entry = {
        pipeline: null,
        compileResult: cr,
        bindGroupInfo,
    };
    state.computePipelines.set(key, entry);

    const descriptor: GPUComputePipelineDescriptor = {
        layout: pipelineLayout,
        compute: { module: shaderModule, entryPoint: 'cs_main' },
    };

    if (promises === null) {
        // Sync compilation
        entry.pipeline = state.device.createComputePipeline(descriptor);
    } else {
        // Async compilation
        const p = (async () => {
            try {
                entry!.pipeline = await state.device.createComputePipelineAsync(descriptor);
            } catch (err) {
                console.error('[pipelines] compute pipeline compilation failed:', err);
            }
        })();
        promises.push(p);
    }

    return entry;
}

/**
 * Check if a compute pipeline is ready.
 */
export function isComputeReady(state: PipelinesState, node: ComputeNode): boolean {
    const entry = state.computePipelines.get(node.id);
    return entry !== undefined && entry.pipeline !== null;
}

// ---------------------------------------------------------------------------
// Pipeline Key Helpers
// ---------------------------------------------------------------------------

/**
 * Get the number of render targets for a fragment node.
 */
function getTargetCount(fragmentNode: Node<Any>): number {
    if (fragmentNode instanceof OutputStructNode) {
        return Math.max(1, fragmentNode.members.length);
    }
    return 1;
}

/**
 * Stable cache key for a material + MSAA sample count + color format + optional depth format.
 */
export function makeRenderPipelineKey(
    material: Material,
    samples: number,
    format: GPUTextureFormat,
    depthFormat: GPUTextureFormat | undefined = 'depth24plus',
): string {
    const posId = material.vertexNode ? material.vertexNode.id : '__default__';
    const colId = material.fragmentNode.id;
    const maskId = material.maskNode ? material.maskNode.id : '__none__';
    const depId = material.depthNode ? material.depthNode.id : '__none__';

    const rs = [
        material.transparent ? 1 : 0,
        material.depthWrite ? 1 : 0,
        material.depthTest ? 1 : 0,
        material.depthCompare,
        material.cullMode,
        material.alphaToCoverage ? 1 : 0,
        getTargetCount(material.fragmentNode),
        samples,
        format,
        depthFormat ?? 'none',
        material.blend ? JSON.stringify(material.blend) : 'none',
    ].join('|');

    return `${posId}::${colId}::${maskId}::${depId}::${rs}`;
}

// ---------------------------------------------------------------------------
// Vertex Buffer Layout Helpers
// ---------------------------------------------------------------------------

/**
 * Build vertex buffer layouts from geometry and NodeBuilderState.
 */
export function buildVertexBufferLayouts(
    geometry: Geometry,
    nodeState: NodeBuilderState,
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
