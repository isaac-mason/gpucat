import type { GpuTexture } from '../../core/gpu-texture';
import type { InspectorBase } from '../../inspector/inspector-base';
import type { ComputeNode } from '../../nodes/nodes';
import type * as d from '../../schema/schema';
import type { DispatchRecord } from '../core/frame';
import type { NodeManagerState } from '../core/node-manager';
import * as NodeManager from '../core/node-manager';
import type { ComputeContext } from '../core/pass-context';
import type { BackendState } from './backend-state';
import * as Bindings from './bindings';
import * as Buffers from './buffers';
import * as Pipelines from './pipelines';
import * as Textures from './textures';

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

/** An inspector splits the batch one pass per entry: `timestampWrites` is a pass-descriptor field. */
export function encodeDispatches(
    b: BackendState,
    nodes: NodeManagerState,
    computeContext: ComputeContext,
    encoder: GPUCommandEncoder,
    entries: readonly DispatchRecord[],
    count: number,
    label: string,
    inspector: InspectorBase | null,
    mipDirty: Set<GpuTexture<d.StorageTexture>>,
): void {
    const { device, pipelines, buffers } = b;
    const frame = nodes.nodeFrame;
    const sharedPass = inspector === null ? encoder.beginComputePass({ label }) : null;
    let currentPipeline: GPUComputePipeline | null = null;

    for (let i = 0; i < count; i++) {
        const entry = entries[i];
        const { node } = entry;
        const pipelineEntry = Pipelines.getForCompute(pipelines, device, nodes, node, computeContext);
        const { nodeBuilderState } = pipelineEntry;
        const entryBuffers = entry.buffers ?? null;

        // Track written storage textures (with mips + auto-update) for post-submit mip regen.
        for (const bg of nodeBuilderState.bindings) {
            for (const b of bg.bindings) {
                if (b.kind !== 'storageTexture' || b.entry.access === 'read') continue;
                const tex = b.entry.node.value;
                if (tex && tex.mipmapsAutoUpdate && tex.mipLevelCount > 1) mipDirty.add(tex);
            }
        }

        if (inspector) {
            inspector.perf.start(`compute: ${node.id}`);
            inspector.perf.start('updateForCompute');
        }
        NodeManager.updateForCompute(nodes, node);
        if (inspector) inspector.perf.end('updateForCompute');

        const gpuBindGroups = Bindings.updateComputeBindings(b, nodeBuilderState, frame, entryBuffers);

        // Notify inspector before creating pass (so timestamp writes are available)
        let timestampWrites: GPUComputePassTimestampWrites | undefined;
        if (inspector) {
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

        if (currentPipeline !== pipelineEntry.pipeline) {
            currentPipeline = pipelineEntry.pipeline!;
            computePass.setPipeline(currentPipeline);
        }

        for (let group = 0; group < gpuBindGroups.length; group++) {
            computePass.setBindGroup(group, gpuBindGroups[group]);
        }

        if (entry.indirect) {
            const gpuBuf = Buffers.ensureUploaded(buffers, device, entry.indirect, 'indirect');
            computeDispatchWorkgroupsIndirect(computePass, inspector, gpuBuf, entry.indirectOffset ?? 0);
        } else {
            const [dx, dy, dz] = entry.counts!;
            computeDispatchWorkgroups(computePass, inspector, dx, dy, dz);
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
): void {
    for (const tex of mipDirty) {
        if (isFilterableStorageFormat(tex.format)) {
            Textures.generateTextureMipmaps(textures, device, tex as unknown as GpuTexture);
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
