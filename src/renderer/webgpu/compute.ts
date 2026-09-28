import type { GpuBuffer } from '../../core/gpu-buffer';
import type { GpuTexture } from '../../core/gpu-texture';
import type { InspectorBase } from '../../inspector/inspector-base';
import type { ComputeNode } from '../../nodes/nodes';
import type * as d from '../../schema/schema';
import type { DispatchRecord } from '../core/frame';
import type { NodeManagerState } from '../core/node-manager';
import * as NodeManager from '../core/node-manager';
import type { ComputeContext } from '../core/pass-context';
import type { DrawBindings } from './bindings';
import * as Bindings from './bindings';
import * as Buffers from './buffers';
import * as Pipelines from './pipelines';
import * as Textures from './textures';
import type { WebGPUBackend } from './webgpu-backend';

/**
 * Storage formats whose mips can be auto-generated. Render-pass mip generation samples
 * the prior level through a filtering sampler, so only filterable renderable formats qualify
 * (8-bit unorm + 16-bit float). Integer and 32-bit-float storage formats are excluded.
 */
const FILTERABLE_STORAGE_FORMATS = new Set<string>(['rgba8unorm', 'rgba8snorm', 'bgra8unorm', 'rgba16float']);
function isFilterableStorageFormat(format: string): boolean {
    return FILTERABLE_STORAGE_FORMATS.has(format);
}

/**
 * Pre-compile a compute pipeline for the renderer's `compileCompute()`: build (or fetch) the compute
 * pipeline for `computeNode`, pushing any async compilation promise onto `promises`.
 */
export function compileComputePipeline(
    device: GPUDevice,
    pipelines: Pipelines.PipelinesState,
    nodes: NodeManagerState,
    computeNode: ComputeNode,
    computeContext: ComputeContext,
    promises: Promise<void>[],
): void {
    Pipelines.getForCompute(pipelines, device, nodes, computeNode, computeContext, promises);
}

/** One dynamic offset, reused so binding a uniform block at its offset allocates nothing. */
const _dynamicOffset = /*@__PURE__*/ new Uint32Array(1);

/** A recorded dispatch as it resolved when recorded: what it runs, what it binds, and how many workgroups. */
export type ResolvedDispatch = {
    node: ComputeNode;
    pipeline: GPUComputePipeline | null;
    bindings: DrawBindings;
    /** Copied at the call, so a counts array changed after `dispatch()` does not reach this dispatch. */
    workgroups: [number, number, number];
    /** Null for a direct dispatch. */
    indirect: GpuBuffer<d.Any> | null;
    indirectOffset: number;
};

export function createResolvedDispatch(node: ComputeNode): ResolvedDispatch {
    return {
        node,
        pipeline: null,
        bindings: { groups: [], offsets: [] },
        workgroups: [0, 0, 0],
        indirect: null,
        indirectOffset: 0,
    };
}

/**
 * Resolves a dispatch at the call that recorded it: its pipeline, its node updates, and its uniforms
 * and bind groups, so it runs with the values set before that call.
 */
export function resolveDispatch(
    b: WebGPUBackend,
    nodes: NodeManagerState,
    computeContext: ComputeContext,
    entry: DispatchRecord,
    out: ResolvedDispatch,
    inspector: InspectorBase | null,
    mipDirty: Set<GpuTexture<d.StorageTexture>>,
): void {
    const pipelineEntry = Pipelines.getForCompute(b.pipelines, b.device, nodes, entry.node, computeContext);
    const { nodeBuilderState } = pipelineEntry;

    // Track written storage textures (with mips + auto-update) for post-submit mip regen.
    for (const bg of nodeBuilderState.bindings) {
        for (const binding of bg.bindings) {
            if (binding.kind !== 'storageTexture' || binding.entry.access === 'read') continue;
            const tex = binding.entry.node.value;
            if (tex && tex.mipmapsAutoUpdate && tex.mipLevelCount > 1) mipDirty.add(tex);
        }
    }

    if (inspector) inspector.perf.start('updateForCompute');
    NodeManager.updateForCompute(nodes, entry.node);
    if (inspector) inspector.perf.end('updateForCompute');

    Bindings.updateComputeBindings(b, nodeBuilderState, nodes.nodeFrame, entry.buffers ?? null, out.bindings);
    out.node = entry.node;
    out.pipeline = pipelineEntry.pipeline;
    if (entry.indirect) {
        out.indirect = entry.indirect;
        out.indirectOffset = entry.indirectOffset ?? 0;
    } else {
        out.indirect = null;
        out.workgroups[0] = entry.counts[0];
        out.workgroups[1] = entry.counts[1];
        out.workgroups[2] = entry.counts[2];
    }
}

/** An inspector splits the batch one pass per entry: `timestampWrites` is a pass-descriptor field. */
export function encodeDispatches(
    b: WebGPUBackend,
    encoder: GPUCommandEncoder,
    resolved: readonly ResolvedDispatch[],
    count: number,
    label: string,
    inspector: InspectorBase | null,
): void {
    const { device, buffers } = b;
    const sharedPass = inspector === null ? encoder.beginComputePass({ label }) : null;
    let currentPipeline: GPUComputePipeline | null = null;

    for (let i = 0; i < count; i++) {
        const { node, pipeline, bindings, workgroups, indirect } = resolved[i];

        // Notify inspector before creating pass (so timestamp writes are available)
        let timestampWrites: GPUComputePassTimestampWrites | undefined;
        if (inspector) {
            inspector.perf.start(`compute: ${node.id}`);
            inspector.beginCompute(node);
            // key must match beginCompute's entry name (node.name ?? id) so the
            // timestamp writes land on the right slot for labelled compute nodes.
            timestampWrites = inspector.getTimestampWrites(node.name ?? node.id);
        }

        let computePass = sharedPass;
        if (computePass === null) {
            computePass = encoder.beginComputePass({ label, timestampWrites });
            currentPipeline = null;
        }

        if (currentPipeline !== pipeline) {
            currentPipeline = pipeline!;
            computePass.setPipeline(currentPipeline);
        }

        const { groups, offsets } = bindings;
        for (let group = 0; group < groups.length; group++) {
            const dynamicOffset = offsets[group];
            if (dynamicOffset < 0) {
                computePass.setBindGroup(group, groups[group]);
            } else {
                _dynamicOffset[0] = dynamicOffset;
                computePass.setBindGroup(group, groups[group], _dynamicOffset, 0, 1);
            }
        }

        if (indirect !== null) {
            const gpuBuf = Buffers.ensureUploaded(buffers, device, indirect, 'indirect');
            computeDispatchWorkgroupsIndirect(computePass, inspector, gpuBuf, resolved[i].indirectOffset);
        } else {
            computeDispatchWorkgroups(computePass, inspector, workgroups[0], workgroups[1], workgroups[2]);
        }

        if (sharedPass === null) computePass.end();
        if (inspector) {
            inspector.finishCompute(node.name ?? node.id);
            inspector.perf.end(`compute: ${node.id}`);
        }
    }

    sharedPass?.end();
}

export function regenerateComputeMips(
    device: GPUDevice,
    textures: Textures.TextureCache,
    mipDirty: Set<GpuTexture<d.StorageTexture>>,
    encoder: GPUCommandEncoder,
): void {
    for (const tex of mipDirty) {
        if (isFilterableStorageFormat(tex.format)) {
            Textures.generateTextureMipmaps(textures, device, tex as unknown as GpuTexture, encoder);
        } else {
            console.warn(
                `[webgpu] mipmapsAutoUpdate skipped: storage format '${tex.format}' is not ` +
                    `filterable, so render-pass mip generation can't sample it. Set mipmapsAutoUpdate=false ` +
                    `and generate mips manually, or use a filterable format (rgba8unorm/rgba16float).`,
            );
        }
    }
}

function computeDispatchWorkgroups(
    pass: GPUComputePassEncoder,
    inspector: InspectorBase | null,
    x: number,
    y: number,
    z: number,
): void {
    pass.dispatchWorkgroups(x, y, z);
    if (inspector) inspector.dispatchWorkgroups(x, y, z);
}

function computeDispatchWorkgroupsIndirect(
    pass: GPUComputePassEncoder,
    inspector: InspectorBase | null,
    indirectBuffer: GPUBuffer,
    offset: number,
): void {
    pass.dispatchWorkgroupsIndirect(indirectBuffer, offset);
    if (inspector) inspector.dispatchWorkgroupsIndirect(indirectBuffer, offset);
}
