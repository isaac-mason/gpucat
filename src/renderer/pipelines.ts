/**
 * pipelines.ts — Unified async-aware pipeline cache (Three.js aligned).
 *
 * Functional API following the buffers.ts pattern:
 *   - createPipelineCache(device, format) → PipelineCache
 *   - getRender(cache, key, material, geometry, samples, format) → entry | undefined
 *   - getRenderAsync(cache, key, ...) → Promise<entry>
 *   - getCompute(cache, key, node) → entry | undefined
 *   - getComputeAsync(cache, key, node) → Promise<entry>
 *
 * Following Three.js's unified pattern:
 * - Single cache system for both render and compute pipelines
 * - Shared bind group layout cache for reusing layouts across all pipelines
 * - Pipeline layout built from only non-empty bind groups
 *
 * Two access patterns:
 *   get*(key)        — fire-and-forget (returns undefined while compiling).
 *                      Used by renderer for frame dispatch.
 *   get*Async(key)   — returns a Promise that resolves when the pipeline is
 *                      ready. Used by renderer.compile() to pre-warm.
 */

import { compile, type CompileResult } from '../nodes/compile';
import { compileCompute, type ComputeCompileResult } from '../nodes/compile';
import { OutputStructNode } from '../nodes/nodes';
import type { Node, WgslType, ComputeNode } from '../nodes/nodes';
import type { Material } from '../material/material';
import type { Geometry } from 'src/geometry/geometry';
import {
    buildBindGroupInfo,
    buildComputeBindGroupInfo,
    type BindGroupInfo,
    type BindGroupLayoutCache,
    createBindGroupLayoutCache,
} from './bindgroups';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RenderPipelineEntry = {
    pipeline: GPURenderPipeline;
    compileResult: CompileResult;
    bindGroupInfo: BindGroupInfo;
};

export type ComputePipelineEntry = {
    pipeline: GPUComputePipeline;
    compileResult: ComputeCompileResult;
    bindGroupInfo: BindGroupInfo;
};

export type PipelineCacheStats = {
    renderReadyCount: number;
    renderPendingCount: number;
    computeReadyCount: number;
    computePendingCount: number;
    bindGroupLayoutCount: number;
};

/**
 * Pipeline cache state object.
 * Holds all caches for render pipelines, compute pipelines, and bind group layouts.
 */
export type PipelineCache = {
    device: GPUDevice;
    format: GPUTextureFormat;
    depthFormat: GPUTextureFormat;

    /** Shared bind group layout cache for all pipelines. */
    bindGroupLayoutCache: BindGroupLayoutCache;

    /** Render pipelines. */
    renderReady: Map<string, RenderPipelineEntry>;
    renderPending: Map<string, Promise<RenderPipelineEntry>>;

    /** Compute pipelines. */
    computeReady: Map<string, ComputePipelineEntry>;
    computePending: Map<string, Promise<ComputePipelineEntry>>;
};

/**
 * Create a pipeline cache.
 */
export function createPipelineCache(device: GPUDevice, format: GPUTextureFormat): PipelineCache {
    return {
        device,
        format,
        depthFormat: 'depth24plus',
        bindGroupLayoutCache: createBindGroupLayoutCache(),
        renderReady: new Map(),
        renderPending: new Map(),
        computeReady: new Map(),
        computePending: new Map(),
    };
}

/**
 * Get cache statistics.
 */
export function getStats(cache: PipelineCache): PipelineCacheStats {
    return {
        renderReadyCount: cache.renderReady.size,
        renderPendingCount: cache.renderPending.size,
        computeReadyCount: cache.computeReady.size,
        computePendingCount: cache.computePending.size,
        bindGroupLayoutCount: cache.bindGroupLayoutCache.cache.size,
    };
}

// ---------------------------------------------------------------------------
// Render Pipeline API
// ---------------------------------------------------------------------------

/**
 * Returns the cached RenderPipelineEntry for `key`, or undefined if not ready.
 * Triggers async compilation on first call for a given key.
 */
export function getRender(
    cache: PipelineCache,
    key: string,
    material: Material,
    geometry: Geometry,
    samples: number,
    format: GPUTextureFormat = cache.format,
    depthFormat: GPUTextureFormat | undefined = cache.depthFormat,
): RenderPipelineEntry | undefined {
    if (cache.renderReady.has(key)) return cache.renderReady.get(key)!;

    if (!cache.renderPending.has(key)) {
        startRenderCompile(cache, key, material, geometry, samples, format, depthFormat);
    }

    return undefined;
}

/**
 * Returns the CompileResult for the given key if the pipeline is already
 * compiled, or null otherwise. Does NOT trigger compilation.
 */
export function getRenderCompileResult(cache: PipelineCache, key: string): CompileResult | null {
    return cache.renderReady.get(key)?.compileResult ?? null;
}

/**
 * Returns a Promise that resolves to the RenderPipelineEntry.
 * If already compiled, resolves immediately.
 * If compilation is in-flight, returns the same Promise (deduplicates).
 */
export function getRenderAsync(
    cache: PipelineCache,
    key: string,
    material: Material,
    geometry: Geometry,
    samples: number,
    format: GPUTextureFormat = cache.format,
    depthFormat: GPUTextureFormat | undefined = cache.depthFormat,
): Promise<RenderPipelineEntry> {
    if (cache.renderReady.has(key)) return Promise.resolve(cache.renderReady.get(key)!);
    if (cache.renderPending.has(key)) return cache.renderPending.get(key)!;
    return startRenderCompile(cache, key, material, geometry, samples, format, depthFormat);
}

function startRenderCompile(
    cache: PipelineCache,
    key: string,
    material: Material,
    geometry: Geometry,
    samples: number,
    format: GPUTextureFormat,
    depthFormat: GPUTextureFormat | undefined,
): Promise<RenderPipelineEntry> {
    const p = compileRender(cache, key, material, geometry, samples, format, depthFormat);
    cache.renderPending.set(key, p);
    p.then(() => {
        cache.renderPending.delete(key);
    }).catch((err) => {
        cache.renderPending.delete(key);
        console.error('[pipelines] render pipeline compilation failed:', err);
    });
    return p;
}

async function compileRender(
    cache: PipelineCache,
    key: string,
    material: Material,
    geometry: Geometry,
    samples: number,
    format: GPUTextureFormat,
    depthFormat: GPUTextureFormat | undefined,
): Promise<RenderPipelineEntry> {
    const vertex: Node<WgslType> = material.vertexNode;
    const fragment: Node<WgslType> = material.fragmentNode;

    const cr = compile({
        position: vertex,
        color: fragment,
        mask: material.maskNode,
        depth: material.depthNode,
    });

    const bindGroupInfo = buildBindGroupInfo(cache.device, cr, cache.bindGroupLayoutCache);
    const bindGroupLayouts = bindGroupInfo.bindGroups.map(bg => bg.layout);
    const pipelineLayout = cache.device.createPipelineLayout({ bindGroupLayouts });

    const shaderModule = cache.device.createShaderModule({ code: cr.code });
    const vertexBuffers = buildVertexBufferLayouts(cr, geometry);

    const targetCount = getTargetCount(material.fragmentNode);
    const colorTargets: GPUColorTargetState[] = [];
    for (let i = 0; i < targetCount; i++) {
        colorTargets.push({
            format,
            blend: material.blend,
            writeMask: GPUColorWrite.ALL,
        });
    }

    const depthCompare: GPUCompareFunction = !material.depthTest ? 'always' : material.depthCompare;

    const descriptor: GPURenderPipelineDescriptor = {
        layout: pipelineLayout,
        vertex: {
            module: shaderModule,
            entryPoint: 'vs_main',
            buffers: vertexBuffers,
        },
        fragment: {
            module: shaderModule,
            entryPoint: 'fs_main',
            targets: colorTargets,
        },
        primitive: {
            topology: 'triangle-list',
            cullMode: material.cullMode,
        },
        depthStencil: depthFormat !== undefined ? {
            format: depthFormat,
            depthWriteEnabled: material.depthWrite,
            depthCompare,
        } : undefined,
        multisample: samples > 1
            ? { count: samples, alphaToCoverageEnabled: material.alphaToCoverage }
            : undefined,
    };

    const pipeline = await cache.device.createRenderPipelineAsync(descriptor);

    const entry: RenderPipelineEntry = {
        pipeline,
        compileResult: cr,
        bindGroupInfo,
    };
    cache.renderReady.set(key, entry);
    return entry;
}

// ---------------------------------------------------------------------------
// Compute Pipeline API
// ---------------------------------------------------------------------------

/**
 * Returns the cached ComputePipelineEntry for `key`, or undefined if not ready.
 * Triggers async compilation on first call for a given key (fire-and-forget).
 */
export function getCompute(
    cache: PipelineCache,
    key: string,
    node: ComputeNode,
): ComputePipelineEntry | undefined {
    if (cache.computeReady.has(key)) return cache.computeReady.get(key)!;

    if (!cache.computePending.has(key)) {
        startComputeCompile(cache, key, node);
    }
    return undefined;
}

/**
 * Returns a Promise that resolves to the ComputePipelineEntry.
 * If already compiled, resolves immediately.
 * If compilation is in-flight, returns the same Promise.
 */
export function getComputeAsync(
    cache: PipelineCache,
    key: string,
    node: ComputeNode,
): Promise<ComputePipelineEntry> {
    if (cache.computeReady.has(key)) {
        return Promise.resolve(cache.computeReady.get(key)!);
    }
    if (cache.computePending.has(key)) {
        return cache.computePending.get(key)!;
    }
    return startComputeCompile(cache, key, node);
}

function startComputeCompile(
    cache: PipelineCache,
    key: string,
    node: ComputeNode,
): Promise<ComputePipelineEntry> {
    const p = compileComputePipeline(cache, key, node);
    cache.computePending.set(key, p);
    p.then(() => {
        cache.computePending.delete(key);
    }).catch((err) => {
        cache.computePending.delete(key);
        console.error('[pipelines] compute pipeline compilation failed:', err);
    });
    return p;
}

async function compileComputePipeline(
    cache: PipelineCache,
    key: string,
    node: ComputeNode,
): Promise<ComputePipelineEntry> {
    const cr = compileCompute(node);

    const bindGroupInfo = buildComputeBindGroupInfo(cache.device, cr, cache.bindGroupLayoutCache);
    const bindGroupLayouts = bindGroupInfo.bindGroups.map(bg => bg.layout);
    const pipelineLayout = cache.device.createPipelineLayout({ bindGroupLayouts });

    const shaderModule = cache.device.createShaderModule({ code: cr.code });
    const pipeline = await cache.device.createComputePipelineAsync({
        layout: pipelineLayout,
        compute: { module: shaderModule, entryPoint: 'cs_main' },
    });

    const entry: ComputePipelineEntry = {
        pipeline,
        compileResult: cr,
        bindGroupInfo,
    };
    cache.computeReady.set(key, entry);
    return entry;
}

// ---------------------------------------------------------------------------
// Vertex Buffer Layout Helpers
// ---------------------------------------------------------------------------

function getTargetCount(fragmentNode: Node<WgslType>): number {
    if (fragmentNode instanceof OutputStructNode) {
        return Math.max(1, fragmentNode.members.length);
    }
    return 1;
}

function buildVertexBufferLayouts(cr: CompileResult, geometry: Geometry): GPUVertexBufferLayout[] {
    const layouts: GPUVertexBufferLayout[] = [];

    for (const attrEntry of cr.attributes) {
        if (attrEntry.kind === 'geometry') {
            const bufAttr = geometry.attributes.get(attrEntry.name);
            if (!bufAttr) {
                throw new Error(
                    `[pipelines] geometry is missing required attribute '${attrEntry.name}' (expected by shader)`
                );
            }
            if (!bufAttr.format) {
                throw new Error(
                    `[pipelines] attribute '${attrEntry.name}' has no format — cannot derive from array type + itemSize`
                );
            }
            const stride = bufAttr.stride > 0 ? bufAttr.stride : gpuFormatByteSize(bufAttr.format);
            layouts.push({
                arrayStride: stride,
                stepMode: 'vertex',
                attributes: [
                    {
                        shaderLocation: attrEntry.location,
                        offset: bufAttr.offset,
                        format: bufAttr.format,
                    },
                ],
            });
        } else {
            const node = attrEntry.node;
            const format = wgslTypeToVertexFormat(attrEntry.type);
            const itemSize = wgslTypeItemSize(attrEntry.type);
            layouts.push({
                arrayStride: node.stride > 0 ? node.stride : itemSize * 4,
                stepMode: node.instanced ? 'instance' : 'vertex',
                attributes: [
                    {
                        shaderLocation: attrEntry.location,
                        offset: node.offset,
                        format,
                    },
                ],
            });
        }
    }

    return layouts;
}

function gpuFormatByteSize(format: GPUVertexFormat): number {
    switch (format) {
        case 'float32':
        case 'uint32':
        case 'sint32':
            return 4;
        case 'float32x2':
        case 'uint32x2':
        case 'sint32x2':
            return 8;
        case 'float32x3':
        case 'uint32x3':
        case 'sint32x3':
            return 12;
        case 'float32x4':
        case 'uint32x4':
        case 'sint32x4':
            return 16;
        case 'float16x2':
        case 'unorm16x2':
        case 'snorm16x2':
        case 'uint16x2':
        case 'sint16x2':
            return 4;
        case 'float16x4':
        case 'unorm16x4':
        case 'snorm16x4':
        case 'uint16x4':
        case 'sint16x4':
            return 8;
        case 'unorm8x2':
        case 'snorm8x2':
        case 'uint8x2':
        case 'sint8x2':
            return 2;
        case 'unorm8x4':
        case 'snorm8x4':
        case 'uint8x4':
        case 'sint8x4':
            return 4;
        default:
            return 4;
    }
}

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

// ---------------------------------------------------------------------------
// Cache Key Generation
// ---------------------------------------------------------------------------

/**
 * Stable cache key for a material + MSAA sample count + color format + optional depth format.
 * Pass `depthFormat = undefined` for pipelines that render without a depth attachment
 * (e.g. inspector preview canvases). This produces a distinct key from the depth-enabled
 * variant so the two never collide in the cache.
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

/**
 * Cache key for compute pipeline (just the node ID).
 */
export function makeComputePipelineKey(node: ComputeNode): string {
    return node.id;
}
