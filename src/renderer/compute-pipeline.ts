/**
 * compute-pipeline.ts — Async-aware GPUComputePipeline cache (Three.js aligned).
 *
 * Following Three.js's pattern:
 * - Pipeline layout is built from only non-empty bind groups
 * - Each bind group has a dynamic index based on which groups are present
 * - Empty bind groups are not included in the pipeline layout
 *
 * Cache key = ComputeNode.id (monotonic counter — each node is inherently unique).
 * On miss: compileCompute → build pipeline layout → createComputePipelineAsync.
 * On hit: return the cached entry.
 *
 * Two access patterns:
 *   get(key, node)        — fire-and-forget (returns undefined while compiling).
 *                           Used by renderer.compute() for frame dispatch.
 *   getAsync(key, node)   — returns a Promise that resolves when the pipeline is
 *                           ready. Used by renderer.compile() to pre-warm.
 */

import { compileCompute, type ComputeCompileResult } from '../nodes/compile';
import type { ComputeNode } from '../nodes/nodes';
import { buildComputeBindGroupInfo, type BindGroupInfo } from './bindgroups';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ComputePipelineEntry = {
    pipeline: GPUComputePipeline;
    compileResult: ComputeCompileResult;
    /** Bind group info (Three.js aligned - only non-empty groups). */
    bindGroupInfo: BindGroupInfo;
    /**
     * @deprecated Use bindGroupInfo.bindGroups to find storage group
     * Index of storage bind group in bindGroupInfo.bindGroups, or -1 if not present.
     */
    storageGroupIndex: number;
    /**
     * @deprecated Use bindGroupInfo.renderGroupIndex
     * Index of render (time) bind group in bindGroupInfo.bindGroups, or -1 if not present.
     */
    renderGroupIndex: number;
    /**
     * @deprecated Use bindGroupInfo.bindGroups[storageGroupIndex].layout
     * Bind group layout for storage buffers, or null if not present.
     */
    layout0: GPUBindGroupLayout | null;
    /**
     * @deprecated Use bindGroupInfo.bindGroups[renderGroupIndex].layout
     * Bind group layout for time uniforms, or null if not present.
     */
    layout1: GPUBindGroupLayout | null;
};

export type ComputePipelineCacheStats = {
    readyCount: number;
    pendingCount: number;
};

// ---------------------------------------------------------------------------
// ComputePipelineCache
// ---------------------------------------------------------------------------

export class ComputePipelineCache {
    private readonly device: GPUDevice;

    /** Resolved pipelines. */
    private readonly ready: Map<string, ComputePipelineEntry> = new Map();
    /** In-flight async requests. Key → the in-flight Promise. */
    private readonly pending: Map<string, Promise<ComputePipelineEntry>> = new Map();

    constructor(device: GPUDevice) {
        this.device = device;
    }

    /** Returns pipeline counts for the Inspector memory/performance tabs. */
    getStats(): ComputePipelineCacheStats {
        return {
            readyCount: this.ready.size,
            pendingCount: this.pending.size,
        };
    }

    /**
     * Returns the cached ComputePipelineEntry for `key`, or undefined if not ready.
     * Triggers async compilation on first call for a given key (fire-and-forget).
     * Used by renderer.compute() — skips the dispatch if the pipeline isn't ready yet.
     */
    get(key: string, node: ComputeNode): ComputePipelineEntry | undefined {
        if (this.ready.has(key)) return this.ready.get(key)!;
        // Kick off async compilation if not already in flight.
        if (!this.pending.has(key)) {
            this._startCompile(key, node);
        }
        return undefined;
    }

    /**
     * Returns a Promise that resolves to the ComputePipelineEntry.
     * If the pipeline is already compiled, resolves immediately.
     * If compilation is in-flight, returns the same Promise.
     * If not yet started, kicks off compilation and returns the Promise.
     * Used by renderer.compile() to pre-warm a pipeline before the frame loop.
     */
    getAsync(key: string, node: ComputeNode): Promise<ComputePipelineEntry> {
        if (this.ready.has(key)) {
            return Promise.resolve(this.ready.get(key)!);
        }
        if (this.pending.has(key)) {
            return this.pending.get(key)!;
        }
        return this._startCompile(key, node);
    }

    private _startCompile(key: string, node: ComputeNode): Promise<ComputePipelineEntry> {
        const p = this._compile(key, node);
        this.pending.set(key, p);
        p.then(() => {
            this.pending.delete(key);
        }).catch((err) => {
            this.pending.delete(key);
            console.error('[ComputePipelineCache] compilation failed:', err);
        });
        return p;
    }

    private async _compile(key: string, node: ComputeNode): Promise<ComputePipelineEntry> {
        const cr = compileCompute(node);

        // Build bind group info (Three.js aligned - only non-empty groups)
        const bindGroupInfo = buildComputeBindGroupInfo(this.device, cr);

        // Build pipeline layout from only the non-empty bind groups
        const bindGroupLayouts = bindGroupInfo.bindGroups.map(bg => bg.layout);
        const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts });

        const shaderModule = this.device.createShaderModule({ code: cr.code });
        const pipeline = await this.device.createComputePipelineAsync({
            layout: pipelineLayout,
            compute: { module: shaderModule, entryPoint: 'cs_main' },
        });

        // Find storage group index (it's the first group named 'storage')
        const storageGroupIndex = bindGroupInfo.bindGroups.findIndex(bg => bg.name === 'storage');
        const renderGroupIndex = bindGroupInfo.renderGroupIndex;

        // Build legacy layout0/layout1 for backwards compat
        const layout0 = storageGroupIndex >= 0
            ? bindGroupInfo.bindGroups[storageGroupIndex].layout
            : null;
        const layout1 = renderGroupIndex >= 0
            ? bindGroupInfo.bindGroups[renderGroupIndex].layout
            : null;

        const entry: ComputePipelineEntry = {
            pipeline,
            compileResult: cr,
            bindGroupInfo,
            storageGroupIndex,
            renderGroupIndex,
            layout0,
            layout1,
        };
        this.ready.set(key, entry);
        return entry;
    }
}
