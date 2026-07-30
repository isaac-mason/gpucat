/**
 * uniforms.ts (webgl) - std140 UBO path. The GL sibling of `webgpu/bindings.ts`'s uniform handling.
 *
 * gpucat's GLSL emitter declares every uniform group as `layout(std140) uniform Uniforms_<group> {…}
 * uniforms_<group>;`, so uniform values MUST be delivered through uniform buffer objects
 * (`bindBufferBase(UNIFORM_BUFFER, …)`), never loose `glUniform*` calls. This module creates one GL
 * UBO per uniform BindGroup and writes the group's member values at the std140 byte offsets the
 * emitter already computed (`UniformGroupBlock.members[].offset`, `.totalBytes`).
 *
 * The value sourcing + update lifecycle is a faithful port of `webgpu/bindings.ts`:
 *   - the RENDER/FRAME/OBJECT update gating (`block.group.updateType` + frameId/renderId dedup),
 *   - invoking each member node's `update` callback through the `NodeFrame` (which assigns
 *     `node.value` and respects updateType),
 *   - reading each member's value from `m.node.uniform.value`, falling back to the material's named
 *     uniforms, then packing it with `packToView(schema, view, offset, value, 'std140')`.
 * We deliberately reuse that value logic rather than the reference renderer's per-name loose-uniform
 * path.
 *
 * Per-BindGroup GL state (the UBO + a CPU staging buffer + change tracking) is cached in a WeakMap
 * keyed by the `UniformBinding` object, which lives on the RenderObject's cloned bind groups — so
 * shared groups (camera) share one entry and per-object groups get their own, exactly as WebGPU.
 */

import type { Material } from '../../material/material';
import type { UniformGroupBlock } from '../../nodes/builder';
import { packToView } from '../../schema/pack';
import type { UniformBinding } from '../core/bind-group';
import type { NodeFrame } from '../core/node-frame';
import { invokeUniformGroupCallbacks } from '../webgpu/bindings';

/** Per-uniform-BindGroup GL resources + change-tracking state. */
type UboData = {
    /** The GL uniform buffer object. */
    ubo: WebGLBuffer;
    /** CPU staging buffer (std140-packed). Compared against the last upload to skip redundant writes. */
    staging: ArrayBuffer;
    /** Whether the UBO has ever been uploaded. */
    uploaded: boolean;
};

/** Uniforms state: per-UniformBinding GL UBO data. */
export type UniformsState = {
    data: WeakMap<UniformBinding, UboData>;
    /** All created UBOs, for disposal. */
    all: Set<WebGLBuffer>;
};

/** Create an empty uniforms state. */
export function createUniformsState(): UniformsState {
    return { data: new WeakMap(), all: new Set() };
}

function getUboData(gl: WebGL2RenderingContext, state: UniformsState, binding: UniformBinding, byteLength: number): UboData {
    let data = state.data.get(binding);
    if (!data || data.staging.byteLength !== byteLength) {
        const ubo = data?.ubo ?? gl.createBuffer();
        if (!ubo) throw new Error('[WebGLRenderer] gl.createBuffer returned null (UBO).');
        if (!data) state.all.add(ubo);
        data = { ubo, staging: new ArrayBuffer(byteLength), uploaded: false };
        state.data.set(binding, data);
    }
    return data;
}

/**
 * Pack a uniform group's current member values into `view` at their std140 offsets. Mirrors
 * `webgpu/bindings.ts` `packAndCompare`'s value sourcing: `m.node.uniform.value`, else the material's
 * named uniform, then `packToView(..., 'std140')`.
 */
function packGroup(block: UniformGroupBlock, view: DataView, material: Material | null): void {
    for (const m of block.members) {
        let value = m.node.uniform.value;
        if (value === null && material) {
            const matUniform = material.uniforms.get(m.node.name);
            if (matUniform) value = matUniform.value;
        }
        if (value === null || value === undefined) continue;
        // Cast: UniformValue is broader than Infer<schema> but matches at runtime. std140 for UBOs.
        packToView(m.schema, view, m.offset, value as never, 'std140');
    }
}

/** True if two ArrayBuffers of equal length differ in any 32-bit word. */
function bytesDiffer(a: ArrayBuffer, b: ArrayBuffer): boolean {
    const av = new Uint32Array(a);
    const bv = new Uint32Array(b);
    for (let i = 0; i < av.length; i++) {
        if (av[i] !== bv[i]) return true;
    }
    return false;
}

/**
 * Update a single uniform BindGroup for the current draw and bind its UBO to `bindingPoint`.
 *
 * Runs the same update gating as WebGPU: shared groups with a 'frame'/'render' updateType are
 * processed at most once per frameId/renderId; 'object'/'none' groups always process. Then invokes
 * member update callbacks, packs into a scratch buffer, uploads to the GL UBO if changed, and binds.
 *
 * @param bindingPoint the GL uniform-buffer binding point this group's block was bound to (from the program)
 */
export function updateAndBindUniformGroup(
    gl: WebGL2RenderingContext,
    state: UniformsState,
    binding: UniformBinding,
    frame: NodeFrame,
    bindingPoint: number,
    material: Material | null,
): void {
    const block = binding.block;

    // Update-type gate (identical to webgpu/bindings.ts updateUniformBinding).
    let skipCallbacks = false;
    if (block.group.shared) {
        const updateType = block.group.updateType;
        if (updateType === 'frame') {
            if (binding.lastFrameId === frame.frameId) skipCallbacks = true;
            else binding.lastFrameId = frame.frameId;
        } else if (updateType === 'render') {
            if (binding.lastRenderId === frame.renderId) skipCallbacks = true;
            else binding.lastRenderId = frame.renderId;
        }
        // 'object' / 'none' always process.
    }

    const data = getUboData(gl, state, binding, block.totalBytes);

    if (!skipCallbacks) {
        // Invoke each member node's update callback (assigns node.value, respects updateType).
        invokeUniformGroupCallbacks(block, frame);

        // Pack current values into a fresh scratch buffer, compare against the staging buffer.
        const scratch = new ArrayBuffer(block.totalBytes);
        packGroup(block, new DataView(scratch), material);

        if (!data.uploaded || bytesDiffer(scratch, data.staging)) {
            data.staging = scratch;
            gl.bindBuffer(gl.UNIFORM_BUFFER, data.ubo);
            if (!data.uploaded) {
                gl.bufferData(gl.UNIFORM_BUFFER, scratch, gl.DYNAMIC_DRAW);
                data.uploaded = true;
            } else {
                gl.bufferSubData(gl.UNIFORM_BUFFER, 0, scratch);
            }
        }
    } else if (!data.uploaded) {
        // First time we see a skipped-shared group (already updated by another object this render):
        // still needs its bytes on the GPU. Pack + upload once.
        packGroup(block, new DataView(data.staging), material);
        gl.bindBuffer(gl.UNIFORM_BUFFER, data.ubo);
        gl.bufferData(gl.UNIFORM_BUFFER, data.staging, gl.DYNAMIC_DRAW);
        data.uploaded = true;
    }

    // Bind the group's UBO to its program binding point.
    gl.bindBufferBase(gl.UNIFORM_BUFFER, bindingPoint, data.ubo);
}

/** Delete all GL UBOs (called on renderer dispose). */
export function disposeUniforms(gl: WebGL2RenderingContext, state: UniformsState): void {
    for (const ubo of state.all) gl.deleteBuffer(ubo);
    state.all.clear();
}

/** Number of GL UBOs currently allocated. */
export function getUniformsStats(state: UniformsState): { uboCount: number } {
    return { uboCount: state.all.size };
}
