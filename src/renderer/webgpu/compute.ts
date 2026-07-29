import type { GpuTexture } from '../../core/gpu-texture';
import type { InspectorBase } from '../../inspector/inspector-base';
import type { ComputeNode } from '../../nodes/nodes';
import type * as d from '../../schema/schema';
import type { NodeManagerState } from '../core/node-manager';
import * as NodeManager from '../core/node-manager';
import type { ComputeContext } from '../core/pass-context';
import type { BackendComputeEntry } from '../core/render-types';
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

/**
 * Encode and submit a batch of compute dispatches in one command encoder + one submit, then
 * regenerate mips for any written storage textures that opted in. Each entry gets its own compute
 * pass so per-node inspector hooks still work. Compute is a self-contained top-level op — it owns
 * a local encoder rather than the render-frame encoder, so it never interferes with an in-flight
 * render.
 */
export function dispatchCompute(
    device: GPUDevice,
    bindings: Bindings.BindingsState,
    buffers: Buffers.BufferCache,
    textures: Textures.TextureCache,
    pipelines: Pipelines.PipelinesState,
    nodes: NodeManagerState,
    computeContext: ComputeContext,
    entries: BackendComputeEntry[],
    inspector: InspectorBase | null,
): void {
    const frame = nodes.nodeFrame;

    const encoder = device.createCommandEncoder();

    // Storage textures written this batch that want their mips regenerated after submit.
    const mipDirty = new Set<GpuTexture<d.StorageTexture>>();

    for (const entry of entries) {
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
        // Update node uniforms
        NodeManager.updateForCompute(nodes, node);
        if (inspector) inspector.perf.end('updateForCompute');

        // Update all bindings and get GPUBindGroups
        const gpuBindGroups = Bindings.updateComputeBindings(
            bindings,
            nodeBuilderState,
            frame,
            device,
            buffers,
            textures,
            entryBuffers,
        );

        // Notify inspector before creating pass (so timestamp writes are available)
        let timestampWrites: GPUComputePassTimestampWrites | undefined;
        if (inspector) {
            inspector.beginCompute(node, frame.frameId);
            // key must match beginCompute's entry name (node.name ?? id) so the
            // timestamp writes land on the right slot for labelled compute nodes.
            timestampWrites = inspector.getTimestampWrites(node.name ?? node.id);
        }

        const computePass = encoder.beginComputePass({ timestampWrites });
        computePass.setPipeline(pipelineEntry.pipeline!);

        for (let i = 0; i < gpuBindGroups.length; i++) {
            computePass.setBindGroup(i, gpuBindGroups[i]);
        }

        if (entry.indirect) {
            const gpuBuf = Buffers.ensureUploaded(buffers, device, entry.indirect);
            computeDispatchWorkgroupsIndirect(computePass, inspector, gpuBuf, entry.indirectOffset ?? 0);
        } else {
            const [dx, dy, dz] = entry.dispatch!;
            computeDispatchWorkgroups(computePass, inspector, dx, dy, dz);
        }

        computePass.end();
        if (inspector) {
            inspector.finishCompute(node.name ?? node.id, frame.frameId);
            inspector.perf.end(`compute: ${node.id}`);
        }
    }

    device.queue.submit([encoder.finish()]);

    // Regenerate mips for written storage textures so a later render pass can sample
    // them mipmapped. Render-pass mip-gen samples through a filtering sampler, so only
    // filterable renderable formats are supported (others would need a compute downsample).
    for (const tex of mipDirty) {
        if (isFilterableStorageFormat(tex.format)) {
            Textures.generateTextureMipmaps(textures, device, tex as unknown as GpuTexture);
        } else {
            console.warn(
                `[WebGPURenderer] mipmapsAutoUpdate skipped: storage format '${tex.format}' is not ` +
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
