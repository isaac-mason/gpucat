/**
 * pipelines.ts — Unified async-aware pipeline cache (Three.js aligned).
 *
 * Functional API following the buffers.ts pattern:
 *   - createPipelineCache(device, format) → PipelineCache
 *   - getCompute(cache, key, node) → entry | undefined
 *   - getComputeAsync(cache, key, node) → Promise<entry>
 *
 * Following Three.js's unified pattern:
 * - Single cache system for compute pipelines
 * - Shared bind group layout cache for reusing layouts across all pipelines
 * - Pipeline layout built from only non-empty bind groups
 *
 * Two access patterns:
 *   get*(key)        — fire-and-forget (returns undefined while compiling).
 *                      Used by renderer for frame dispatch.
 *   get*Async(key)   — returns a Promise that resolves when the pipeline is
 *                      ready. Used by renderer.compile() to pre-warm.
 *
 * Note: Render pipelines are now managed by the RenderObjects system.
 * This module only handles compute pipelines.
 */

import { compileCompute, type ComputeCompileResult } from '../nodes/node-builder';
import { OutputStructNode } from '../nodes/nodes';
import type { Node, WgslType, ComputeNode } from '../nodes/nodes';
import type { Material } from '../material/material';
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
    pipeline: GPUComputePipeline;
    compileResult: ComputeCompileResult;
    bindGroupInfo: BindGroupInfo;
};

export type PipelineCacheStats = {
    computeReadyCount: number;
    computePendingCount: number;
    bindGroupLayoutCount: number;
};

/**
 * Pipeline cache state object.
 * Holds all caches for compute pipelines and bind group layouts.
 *
 * Note: Render pipelines are now managed by the RenderObjects system.
 */
export type PipelineCache = {
    device: GPUDevice;
    format: GPUTextureFormat;
    depthFormat: GPUTextureFormat;

    /** Shared bind group layout cache for all pipelines. */
    bindGroupLayoutCache: BindGroupLayoutCache;

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
        computeReady: new Map(),
        computePending: new Map(),
    };
}

/**
 * Get cache statistics.
 */
export function getStats(cache: PipelineCache): PipelineCacheStats {
    return {
        computeReadyCount: cache.computeReady.size,
        computePendingCount: cache.computePending.size,
        bindGroupLayoutCount: cache.bindGroupLayoutCache.cache.size,
    };
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
// Pipeline Key Helpers
// ---------------------------------------------------------------------------

/**
 * Get the number of render targets for a fragment node.
 */
function getTargetCount(fragmentNode: Node<WgslType>): number {
    if (fragmentNode instanceof OutputStructNode) {
        return Math.max(1, fragmentNode.members.length);
    }
    return 1;
}

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
