/**
 * compute-pipeline.ts — Async-aware GPUComputePipeline cache.
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

import { compileCompute, type ComputeCompileResult } from '../nodes/compile.js';
import type { ComputeNode } from '../nodes/nodes.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ComputePipelineEntry = {
    pipeline: GPUComputePipeline;
    compileResult: ComputeCompileResult;
    /** Bind group layout for group 0 (storage buffers). */
    layout0: GPUBindGroupLayout;
    /** Bind group layout for group 1 (time uniforms), or null if not used. */
    layout1: GPUBindGroupLayout | null;
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
        const layout0 = this._buildLayout0(cr);
        const layout1 = cr.builtinsUsed.has('time') ? this._buildLayout1() : null;
        const bindGroupLayouts: GPUBindGroupLayout[] = layout1 ? [layout0, layout1] : [layout0];
        const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts });
        const shaderModule = this.device.createShaderModule({ code: cr.code });
        const pipeline = await this.device.createComputePipelineAsync({
            layout: pipelineLayout,
            compute: { module: shaderModule, entryPoint: 'cs_main' },
        });
        const entry: ComputePipelineEntry = { pipeline, compileResult: cr, layout0, layout1 };
        this.ready.set(key, entry);
        return entry;
    }

    // -----------------------------------------------------------------------
    // Bind group layout builders
    // -----------------------------------------------------------------------

    /**
     * Group 0: storage buffers, one entry per StorageNode in storage order.
     * read_write → type: 'storage'
     * read       → type: 'read-only-storage'
     */
    private _buildLayout0(cr: ComputeCompileResult): GPUBindGroupLayout {
        return this.device.createBindGroupLayout({
            entries: cr.storage.map((s) => ({
                binding: s.binding,
                visibility: GPUShaderStage.COMPUTE,
                buffer: {
                    type: s.access === 'read_write'
                        ? ('storage' as GPUBufferBindingType)
                        : ('read-only-storage' as GPUBufferBindingType),
                },
            })),
        });
    }

    /**
     * Group 1: time uniforms — binding 0 = timeElapsed, binding 1 = timeDelta.
     * Only created when the compute shader references timeElapsed or timeDelta.
     */
    private _buildLayout1(): GPUBindGroupLayout {
        return this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' as GPUBufferBindingType } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' as GPUBufferBindingType } },
            ],
        });
    }
}
