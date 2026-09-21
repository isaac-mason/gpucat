import type { Geometry } from '../../geometry/geometry';
import type { Material } from '../../material/material';
import type { VertexBufferGroup } from '../../nodes/builder';
import type { MRTNode } from '../../nodes/lib/mrt';
import { type ComputeNode, type Node, NodeKind, type OutputStructNode } from '../../nodes/nodes';
import type { Any } from '../../schema/schema';
import type { NodeBuilderState } from '../core/node-builder-state';
import { assertVertexBuffers } from '../core/node-builder-state';
import type { NodeManagerState } from '../core/node-manager';
import * as NodeManager from '../core/node-manager';
import type { ComputeContext, RenderContext } from '../core/pass-context';
import type { RenderObject } from '../core/render-object';
import * as RenderState from '../core/render-state';
import { type BindGroupLayoutCache, buildComputeBindGroupLayouts } from './bind-group-layout';

export type ComputePipelineEntry = {
    pipeline: GPUComputePipeline | null;
    nodeBuilderState: NodeBuilderState;
};

export type RenderPipelineEntry = {
    pipeline: GPURenderPipeline | null;
    cacheKey: string;
};

export type PipelinesStats = {
    renderCount: number;
    computeCount: number;
};

/**
 * Pipelines state object.
 * Holds all caches for render and compute pipelines.
 */
export type PipelinesState = {
    /**
     * Shared bind group layout cache. Owned by the backend and injected at creation so the same
     * value-keyed layouts are shared with the bindings layer (bindings + pipelines never create a
     * duplicate layout for the same entry shape).
     */
    bindGroupLayoutCache: BindGroupLayoutCache;

    /** Render pipelines - keyed by cache key. */
    renderPipelines: Map<string, RenderPipelineEntry>;

    /** Compute pipelines - keyed by node id. */
    computePipelines: Map<string, ComputePipelineEntry>;

    /**
     * Fallback color format used when rendering to the swapchain (renderTarget === null).
     * Set by the renderer once the canvas format is known.
     */
    canvasFormat: GPUTextureFormat;
};

/** Whether a depth format includes a stencil aspect (depth24plus-stencil8, depth32float-stencil8, stencil8). */
export function formatHasStencil(format: GPUTextureFormat): boolean {
    return format.includes('stencil');
}

/**
 * Build a per-face stencil state from a material. Back faces default to the front-face ops unless the
 * material sets `stencilBack`, in which case its provided fields override (missing ones fall back to front).
 */
function stencilFaceState(material: Material, back = false): GPUStencilFaceState {
    const b = back ? material.stencilBack : null;
    return {
        compare: b?.func ?? material.stencilFunc,
        failOp: b?.fail ?? material.stencilFail,
        depthFailOp: b?.zFail ?? material.stencilZFail,
        passOp: b?.zPass ?? material.stencilZPass,
    };
}

/**
 * Create a pipelines state. The shared bind group layout cache is owned by the backend and passed
 * in so the pipelines and bindings layers hit a single value-keyed layout cache.
 */
export function createPipelinesState(bindGroupLayoutCache: BindGroupLayoutCache): PipelinesState {
    return {
        bindGroupLayoutCache,
        renderPipelines: new Map(),
        computePipelines: new Map(),
        canvasFormat: 'bgra8unorm',
    };
}

/**
 * Per-attachment color formats for a render context.
 * Reads each `renderTarget.textures[i].format`; falls back to the canvas format for the swapchain.
 */
export function getRenderContextColorFormats(
    renderContext: { renderTarget: { textures: { format: GPUTextureFormat }[] } | null },
    canvasFormat: GPUTextureFormat,
): GPUTextureFormat[] {
    const rt = renderContext.renderTarget;
    if (rt === null) return [canvasFormat];
    const out: GPUTextureFormat[] = [];
    for (const tex of rt.textures) out.push(tex.format);
    return out;
}

/** The depth ATTACHMENT's format, not the sampling-gated `depthTexture` getter: a pipeline needs it
 *  whether or not the depth is sampled. */
export function getRenderContextDepthFormat(renderContext: RenderContext): GPUTextureFormat | null {
    const rt = renderContext.renderTarget;
    if (rt === null) return renderContext.canvasTarget!.depthFormat as GPUTextureFormat;
    return rt._depthAttachment ? rt._depthAttachment.format : null;
}

/**
 * Get cache statistics.
 */
export function getPipelineCacheStats(state: PipelinesState): PipelinesStats {
    return {
        renderCount: state.renderPipelines.size,
        computeCount: state.computePipelines.size,
    };
}

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
    device: GPUDevice,
    renderObject: RenderObject,
    bindGroupLayouts: GPUBindGroupLayout[],
    promises: Promise<void>[] | null = null,
): RenderPipelineEntry {
    const colorFormats = getRenderContextColorFormats(renderObject.renderContext, state.canvasFormat);
    const depthFormat = getRenderContextDepthFormat(renderObject.renderContext);
    const cacheKey = getCachedPipelineKey(renderObject, renderObject.renderContext.sampleCount, colorFormats, depthFormat);

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
        device,
        renderObject,
        nodeState,
        bindGroupLayouts,
        colorFormats,
        depthFormat,
    );

    if (promises === null) {
        // Sync compilation
        entry.pipeline = device.createRenderPipeline(descriptor);
    } else {
        // Async compilation
        const p = (async () => {
            try {
                entry!.pipeline = await device.createRenderPipelineAsync(descriptor);
            } catch (err) {
                console.error('[pipelines] render pipeline compilation failed:', err);
            }
        })();
        promises.push(p);
    }

    return entry;
}

function buildRenderPipelineDescriptor(
    device: GPUDevice,
    renderObject: RenderObject,
    nodeState: NodeBuilderState,
    bindGroupLayouts: GPUBindGroupLayout[],
    colorFormats: GPUTextureFormat[],
    depthFormat: GPUTextureFormat | null,
): GPURenderPipelineDescriptor {
    const material = renderObject.material;
    const geometry = renderObject.geometry;
    const renderContext = renderObject.renderContext;

    // Build vertex buffer layouts from geometry attributes
    const vertexBufferLayouts = buildVertexBufferLayouts(geometry, nodeState, renderObject.mesh.name || 'mesh');

    // Create pipeline layout
    const pipelineLayout = device.createPipelineLayout({
        bindGroupLayouts,
    });

    // Create shader module (vertexCode contains combined vertex+fragment shader)
    const shaderCode = nodeState.vertexCode!;
    const shaderModule = device.createShaderModule({
        code: shaderCode,
    });
    shaderModule.getCompilationInfo().then((info) => {
        for (const msg of info.messages) {
            if (msg.type === 'error') {
                console.error(`[gpucat shader error] line ${msg.lineNum}: ${msg.message}\n${shaderCode}`);
            }
        }
    });

    // Build color targets (supports MRT). Empty for depth-only pipelines. The blend each target gets
    // is decided by `core/render-state`, shared with the WebGL backend so the two cannot drift.
    const targetCount = getTargetCount(material.fragment);
    const textures = renderContext.renderTarget?.textures ?? null;
    const mrt: MRTNode | null = renderContext.mrt;
    const colorTargets: GPUColorTargetState[] = [];
    for (let i = 0; i < targetCount; i++) {
        const targetName = mrt !== null && textures !== null ? (textures[i]?.name ?? '') : null;
        colorTargets.push({
            format: colorFormats[i] ?? colorFormats[0],
            blend: RenderState.resolveTargetBlend(material, mrt, targetName),
            writeMask: material.colorWrite ? GPUColorWrite.ALL : 0,
        });
    }

    // Build pipeline descriptor.
    // For depth-only pipelines (no fragment node AND no frag_depth override), omit the fragment stage
    // entirely. WebGPU spec section 23.2.8 explicitly supports "No Color Output" mode: the pipeline
    // still rasterizes and produces depth values from vertex positions.
    // When the material sets a frag_depth override (material.depth) but has no color output, a fragment
    // stage MUST still run (to write @builtin(frag_depth)), with an empty `targets` array.
    const hasFragDepth = material.depth != null;
    const fragment: GPURenderPipelineDescriptor['fragment'] =
        targetCount > 0 || hasFragDepth
            ? {
                  module: shaderModule,
                  entryPoint: 'fs_main',
                  targets: colorTargets,
              }
            : undefined;

    return {
        layout: pipelineLayout,
        vertex: {
            module: shaderModule,
            entryPoint: 'vs_main',
            buffers: vertexBufferLayouts,
        },
        fragment,
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
                  depthBias: material.depthBias,
                  depthBiasSlopeScale: material.depthBiasSlopeScale,
                  depthBiasClamp: material.depthBiasClamp,
                  // Stencil state is only valid on a stencil-capable format; when the material doesn't
                  // opt in, the fields are omitted and WebGPU applies its no-op defaults (always/keep).
                  ...(formatHasStencil(depthFormat) && material.stencilTest
                      ? {
                            stencilFront: stencilFaceState(material),
                            stencilBack: stencilFaceState(material, true),
                            stencilReadMask: material.stencilReadMask,
                            stencilWriteMask: material.stencilWriteMask,
                        }
                      : {}),
              }
            : undefined,
        multisample: {
            count: renderContext.sampleCount >= 4 ? 4 : 1,
            alphaToCoverageEnabled: material.alphaToCoverage,
        },
    };
}

/**
 * Get or create a compute pipeline for a ComputeNode.
 *
 * @param state - The pipelines state
 * @param node - The ComputeNode
 * @param computeContext - The ComputeContext for bind group caching
 * @param promises - Optional array to collect async compilation promises (for compileAsync)
 * @returns The compute pipeline entry
 */
export function getForCompute(
    state: PipelinesState,
    device: GPUDevice,
    nodes: NodeManagerState,
    node: ComputeNode,
    computeContext: ComputeContext,
    promises: Promise<void>[] | null = null,
): ComputePipelineEntry {
    const key = node.id;

    let entry = state.computePipelines.get(key);
    if (entry) return entry;

    // Set up disposal callback if not already set
    if (!node._onDispose) {
        node._onDispose = () => {
            NodeManager.deleteForCompute(nodes, node);
            state.computePipelines.delete(node.id);
        };
    }

    // Use NodeManager to get compiled compute state (pass context for bind group caching)
    const nodeBuilderState = NodeManager.getForCompute(nodes, node, computeContext);

    // Build bind group layouts from NodeBuilderState bindings
    const bindGroupLayouts = buildComputeBindGroupLayouts(device, nodeBuilderState.bindings, state.bindGroupLayoutCache);
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts });

    const shaderModule = device.createShaderModule({ code: nodeBuilderState.computeCode! });

    entry = {
        pipeline: null,
        nodeBuilderState,
    };
    state.computePipelines.set(key, entry);

    const descriptor: GPUComputePipelineDescriptor = {
        layout: pipelineLayout,
        compute: { module: shaderModule, entryPoint: 'cs_main' },
    };

    if (promises === null) {
        // Sync compilation
        entry.pipeline = device.createComputePipeline(descriptor);
    } else {
        // Async compilation
        const p = (async () => {
            try {
                entry!.pipeline = await device.createComputePipelineAsync(descriptor);
            } catch (err) {
                console.error('[pipelines] compute pipeline compilation failed:', err);
            }
        })();
        promises.push(p);
    }

    return entry;
}

/**
 * Look up an existing compute pipeline entry without compiling.
 * Returns null if the pipeline hasn't been created yet.
 *
 * @param state - The pipelines state
 * @param node - The ComputeNode
 * @returns The compute pipeline entry, or null if not compiled yet
 */
export function lookupCompute(state: PipelinesState, node: ComputeNode): ComputePipelineEntry | null {
    return state.computePipelines.get(node.id) ?? null;
}

/**
 * Get the number of render targets for a fragment node.
 * Returns 0 for depth-only pipelines (null fragment node).
 */
function getTargetCount(fragmentNode: Node<Any> | undefined): number {
    if (!fragmentNode) return 0;
    // OutputStruct covers MRT too (MRTNode extends OutputStructNode)
    if (fragmentNode.kind === NodeKind.OutputStruct || fragmentNode.kind === NodeKind.MRT) {
        return Math.max(1, (fragmentNode as OutputStructNode).members.length);
    }
    return 1;
}

/**
 * Get or compute the cached pipeline key for a RenderObject.
 *
 * The pipeline key is used for:
 * 1. Pipeline cache lookup (avoid recomputing expensive key strings)
 * 2. Opaque sorting by pipeline (minimize setPipeline calls)
 *
 * The key is memoized on the RenderObject and invalidated when material.version
 * changes.
 *
 * @param renderObject - The RenderObject
 * @param samples - MSAA sample count
 * @param colorFormats - Color texture formats
 * @param depthFormat - Depth texture format (null for no depth)
 * @returns The cached or newly computed pipeline key
 */
function getCachedPipelineKey(
    renderObject: RenderObject,
    samples: number,
    colorFormats: GPUTextureFormat[],
    depthFormat: GPUTextureFormat | null,
): string {
    const currentVersion = renderObject.material.version;
    const geometryVersion = renderObject.geometry.version;

    if (
        renderObject._cachedPipelineKey !== null &&
        renderObject._pipelineKeyVersion === currentVersion &&
        renderObject._pipelineKeyGeometryVersion === geometryVersion
    ) {
        return renderObject._cachedPipelineKey;
    }

    const layout = vertexLayoutKey(renderObject.geometry, renderObject.nodeBuilderState!);
    const key = makeRenderPipelineKey(
        renderObject.material,
        layout,
        samples,
        colorFormats,
        depthFormat,
        renderObject.renderContext.mrt,
    );
    renderObject._cachedPipelineKey = key;
    renderObject._pipelineKeyVersion = currentVersion;
    renderObject._pipelineKeyGeometryVersion = geometryVersion;

    return key;
}

/** Drop every cached pipeline (called on renderer dispose; `device.destroy()` frees the GPU side). */
export function disposePipelines(state: PipelinesState): void {
    state.renderPipelines.clear();
    state.computePipelines.clear();
}

/**
 * Stable cache key for a material + vertex layout + MSAA sample count + color format + optional depth
 * format. `vertexLayout` comes from {@link vertexLayoutKey}; without it two geometries that supply the
 * same attribute name with different buffer formats share a pipeline whose arrayStride suits only one.
 */
export function makeRenderPipelineKey(
    material: Material,
    vertexLayout: string,
    samples: number,
    formats: GPUTextureFormat[],
    depthFormat: GPUTextureFormat | null,
    mrt: MRTNode | null,
): string {
    const posId = material.vertex ? material.vertex.id : '__default__';
    const colId = material.fragment ? material.fragment.id : '__depthOnly__';
    const depId = material.depth ? material.depth.id : '__none__';

    const rs = [
        material.transparent ? 1 : 0,
        material.colorWrite ? 1 : 0,
        material.depthWrite ? 1 : 0,
        material.depthTest ? 1 : 0,
        material.depthCompare,
        material.cullMode,
        material.alphaToCoverage ? 1 : 0,
        material.depthBias,
        material.depthBiasSlopeScale,
        material.depthBiasClamp,
        // Stencil state baked into the pipeline (stencilRef is dynamic, set via setStencilReference).
        material.stencilTest ? 1 : 0,
        material.stencilFunc,
        material.stencilReadMask,
        material.stencilWriteMask,
        material.stencilFail,
        material.stencilZFail,
        material.stencilZPass,
        material.stencilBack ? JSON.stringify(material.stencilBack) : 'none',
        getTargetCount(material.fragment),
        samples,
        formats.join(','),
        depthFormat ?? 'none',
        material.blend ? JSON.stringify(material.blend) : 'none',
        mrt ? `mrt${mrt.id}` : 'none',
        vertexLayout,
    ].join('|');

    return `${posId}::${colId}::${depId}::${rs}`;
}

/**
 * The arrayStride a vertex group resolves to, or null when it names a geometry buffer that is absent
 * and the group is skipped. Shared by the layout builder and the pipeline key: a stride that comes
 * from the geometry rather than the graph has to reach the key, or two geometries whose buffers have
 * different formats share one pipeline with the wrong stride.
 */
function resolveVertexGroupStride(group: VertexBufferGroup, geometry: Geometry): number | null {
    if (group.stride > 0) return group.stride;

    if (group.name !== null) {
        const buffer = geometry.buffers.get(group.name);
        if (!buffer) return null;
        if (!buffer.format) {
            throw new Error(
                `[pipeline] vertex buffer '${group.name}' has no vertex format: its usage must include 'vertex', and WebGPU has no format for ${buffer.array?.constructor.name ?? 'this array'} at itemSize ${buffer.itemSize}.`,
            );
        }
        return getBytesPerElement(buffer.format);
    }

    return wgslTypeItemSize(group.attributes[0].type) * 4;
}

/** The part of a pipeline's vertex layout that comes from the geometry, not from the node graph. */
export function vertexLayoutKey(geometry: Geometry, nodeState: NodeBuilderState): string {
    let key = '';

    for (const group of nodeState.vertexBufferGroups) {
        const stride = resolveVertexGroupStride(group, geometry);
        key += stride === null ? 'skip|' : `${stride}:${group.instanced ? 'i' : 'v'}|`;
    }

    return key;
}

/**
 * Build vertex buffer layouts from geometry and NodeBuilderState.
 * Uses vertexBufferGroups to produce one GPUVertexBufferLayout per unique buffer.
 */
export function buildVertexBufferLayouts(
    geometry: Geometry,
    nodeState: NodeBuilderState,
    label = 'geometry',
): GPUVertexBufferLayout[] {
    assertVertexBuffers(geometry, nodeState, label);
    const layouts: GPUVertexBufferLayout[] = [];

    for (const group of nodeState.vertexBufferGroups) {
        const gpuAttributes: GPUVertexAttribute[] = [];

        // Per-attribute format always comes from the WGSL type
        for (const attr of group.attributes) {
            const format = wgslTypeToVertexFormat(attr.type);
            gpuAttributes.push({
                format,
                offset: attr.offset,
                shaderLocation: attr.shaderLocation,
            });
        }

        const arrayStride = resolveVertexGroupStride(group, geometry);
        if (arrayStride === null) continue;

        layouts.push({
            arrayStride,
            stepMode: group.instanced ? 'instance' : 'vertex',
            attributes: gpuAttributes,
        });
    }

    return layouts;
}

/**
 * Get bytes per element for a vertex format.
 */
export function getBytesPerElement(format: GPUVertexFormat): number {
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

    const size = formatSizes[format];
    if (size === undefined) throw new Error(`[pipeline] no byte size recorded for vertex format '${format}'.`);
    return size;
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
export function wgslTypeItemSize(type: string): number {
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
            throw new Error(`[pipeline] no component count for attribute type '${type}'; its vertex stride cannot be derived.`);
    }
}
