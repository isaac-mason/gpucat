import { type Node, type ComputeNode, OutputStructNode, NodeKind } from '../nodes/nodes';
import type { Any } from '../schema/schema';
import type { Material } from '../material/material';
import type { Geometry } from '../geometry/geometry';
import type { RenderObject } from './render-object';
import type { NodeBuilderState } from './node-builder-state';
import type { NodeManagerState } from './node-manager';
import type { ComputeContext } from './pass-context';
import type { MRTNode } from '../nodes/lib/mrt';
import { BlendMode } from '../material/blend-mode';
import * as NodeManager from './node-manager';
import {
    type BindGroupLayoutCache,
    createBindGroupLayoutCache,
    buildComputeBindGroupLayouts,
} from './bind-group-layout';

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
    bindGroupLayoutCount: number;
};

/**
 * Pipelines state object.
 * Holds all caches for render and compute pipelines.
 */
export type PipelinesState = {
    /** Shared bind group layout cache for all pipelines. */
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

    /**
     * Fallback depth format used when rendering to the swapchain (renderTarget === null).
     * Set by the renderer to match the swapchain depth texture format.
     */
    canvasDepthFormat: GPUTextureFormat;
};

export const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';

/** Depth format carrying a stencil aspect. Used when a target requests a stencil buffer. */
export const DEPTH_STENCIL_FORMAT: GPUTextureFormat = 'depth24plus-stencil8';

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
 * Create a pipelines state.
 */
export function createPipelinesState(): PipelinesState {
    return {
        bindGroupLayoutCache: createBindGroupLayoutCache(),
        renderPipelines: new Map(),
        computePipelines: new Map(),
        canvasFormat: 'bgra8unorm',
        canvasDepthFormat: DEPTH_FORMAT,
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

/**
 * Depth-stencil format for a render context, or null if the target has no depth attachment.
 * Reads `renderTarget.depthTexture?.format`; falls back to the swapchain depth format.
 */
export function getRenderContextDepthFormat(
    renderContext: { renderTarget: { depthTexture: { format: GPUTextureFormat } | null } | null },
    canvasDepthFormat: GPUTextureFormat,
): GPUTextureFormat | null {
    const rt = renderContext.renderTarget;
    if (rt === null) return canvasDepthFormat;
    return rt.depthTexture ? rt.depthTexture.format : null;
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
    const depthFormat = getRenderContextDepthFormat(renderObject.renderContext, state.canvasDepthFormat);
    const cacheKey = getCachedPipelineKey(
        renderObject,
        renderObject.renderContext.sampleCount,
        colorFormats,
        depthFormat,
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

/**
 * Check if a render pipeline is ready for rendering.
 */
export function isReady(state: PipelinesState, renderObject: RenderObject): boolean {
    const colorFormats = getRenderContextColorFormats(renderObject.renderContext, state.canvasFormat);
    const depthFormat = getRenderContextDepthFormat(renderObject.renderContext, state.canvasDepthFormat);
    const cacheKey = getCachedPipelineKey(
        renderObject,
        renderObject.renderContext.sampleCount,
        colorFormats,
        depthFormat,
    );
    const entry = state.renderPipelines.get(cacheKey);
    return entry !== undefined && entry.pipeline !== null;
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
    const vertexBufferLayouts = buildVertexBufferLayouts(geometry, nodeState);

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

    // Material-level blend (applied to attachments tagged 'material' or non-MRT pipelines).
    const materialBlending: GPUBlendState | undefined = material.transparent
        ? (material.blend ?? getDefaultBlendState())
        : undefined;

    // Build color targets (supports MRT). Empty for depth-only pipelines.
    const targetCount = getTargetCount(material.fragment);
    const textures = renderContext.renderTarget?.textures ?? null;
    const mrt: MRTNode | null = renderContext.mrt;
    const colorTargets: GPUColorTargetState[] = [];
    for (let i = 0; i < targetCount; i++) {
        let blend: GPUBlendState | undefined;
        if (mrt !== null && textures !== null) {
            const blendMode = mrt.getBlendMode(textures[i]?.name ?? '');
            if (blendMode.blending === 'material') {
                blend = materialBlending;
            } else if (blendMode.blending !== 'no') {
                blend = _getBlending(blendMode);
            }
        } else {
            blend = materialBlending;
        }
        colorTargets.push({
            format: colorFormats[i] ?? colorFormats[0],
            blend,
            writeMask: material.colorWrite ? GPUColorWrite.ALL : 0,
        });
    }

    // Build pipeline descriptor
    // For depth-only pipelines (no fragment node), omit the fragment stage entirely.
    // WebGPU spec section 23.2.8 explicitly supports "No Color Output" mode:
    // the pipeline still rasterizes and produces depth values from vertex positions.
    const fragment: GPURenderPipelineDescriptor['fragment'] = targetCount > 0
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
    const bindGroupLayouts = buildComputeBindGroupLayouts(
        device,
        nodeBuilderState.bindings,
        state.bindGroupLayoutCache,
    );
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
 * Check if a compute pipeline is ready.
 */
export function isComputeReady(state: PipelinesState, node: ComputeNode): boolean {
    const entry = state.computePipelines.get(node.id);
    return entry !== undefined && entry.pipeline !== null;
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

    if (
        renderObject._cachedPipelineKey !== null &&
        renderObject._pipelineKeyVersion === currentVersion
    ) {
        return renderObject._cachedPipelineKey;
    }

    const key = makeRenderPipelineKey(
        renderObject.material,
        samples,
        colorFormats,
        depthFormat,
        renderObject.renderContext.mrt,
    );
    renderObject._cachedPipelineKey = key;
    renderObject._pipelineKeyVersion = currentVersion;

    return key;
}

/**
 * Stable cache key for a material + MSAA sample count + color format + optional depth format.
 */
export function makeRenderPipelineKey(
    material: Material,
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
    ].join('|');

    return `${posId}::${colId}::${depId}::${rs}`;
}

/**
 * Build vertex buffer layouts from geometry and NodeBuilderState.
 * Uses vertexBufferGroups to produce one GPUVertexBufferLayout per unique buffer.
 */
export function buildVertexBufferLayouts(
    geometry: Geometry,
    nodeState: NodeBuilderState,
): GPUVertexBufferLayout[] {
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

        // Compute arrayStride, use explicit stride if set, otherwise derive from buffer or first attribute
        let arrayStride: number;
        if (group.stride > 0) {
            arrayStride = group.stride;
        } else if (group.name !== null) {
            const buffer = geometry.buffers.get(group.name);
            if (!buffer) continue;
            arrayStride = getBytesPerElement(buffer.format);
        } else {
            const firstAttr = group.attributes[0];
            arrayStride = wgslTypeItemSize(firstAttr.type) * 4;
        }

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

// (srcRGB, dstRGB, srcAlpha, dstAlpha) → GPUBlendState with 'add' for both ops.
const _add = (
    srcRGB: GPUBlendFactor,
    dstRGB: GPUBlendFactor,
    srcA: GPUBlendFactor,
    dstA: GPUBlendFactor,
): GPUBlendState => ({
    color: { srcFactor: srcRGB, dstFactor: dstRGB, operation: 'add' },
    alpha: { srcFactor: srcA, dstFactor: dstA, operation: 'add' },
});

/**
 * Translate a BlendMode into a GPUBlendState for pipeline creation. Only runs on pipeline
 * cache miss, so the state is built on demand rather than precomputed.
 *
 * subtractive/multiply are only defined for premultiplied alpha; the non-premultiplied
 * combinations are unsupported and rejected.
 */
function _getBlending(blendMode: BlendMode): GPUBlendState {
    const { blending, premultiplyAlpha: pm } = blendMode;

    if (blending === 'custom') {
        const { blendSrc, blendDst, blendEquation } = blendMode;
        return {
            color: { srcFactor: blendSrc, dstFactor: blendDst, operation: blendEquation },
            alpha: {
                srcFactor: blendMode.blendSrcAlpha ?? blendSrc,
                dstFactor: blendMode.blendDstAlpha ?? blendDst,
                operation: blendMode.blendEquationAlpha ?? blendEquation,
            },
        };
    }

    switch (blending) {
        case 'normal':
            return pm
                ? _add('one', 'one-minus-src-alpha', 'one', 'one-minus-src-alpha')
                : _add('src-alpha', 'one-minus-src-alpha', 'one', 'one-minus-src-alpha');
        case 'additive':
            return pm
                ? _add('one', 'one', 'one', 'one')
                : _add('src-alpha', 'one', 'one', 'one');
        case 'subtractive':
            if (pm) return _add('zero', 'one-minus-src', 'zero', 'one');
            break;
        case 'multiply':
            if (pm) return _add('dst', 'one-minus-src-alpha', 'zero', 'one');
            break;
    }

    console.error(
        `[pipelines] ${blending} blending requires premultiplyAlpha=true.`,
    );
    return getDefaultBlendState();
}
