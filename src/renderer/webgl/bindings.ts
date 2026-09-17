/**
 * bindings.ts (webgl) - std140 UBO path, the GL sibling of `webgpu/bindings.ts`.
 *
 * Same resource (a `BindGroup` from `core/bind-group.ts`), same filename, different mechanism. WebGPU
 * builds a `GPUBindGroup` object that is created, cached, invalidated and bound as a unit, so its
 * surface is init/get/delete/invalidate. WebGL2 has no bind-group object at all: uniform buffers are
 * bound to numbered binding points per draw, so the surface is update-and-bind. Those names are not
 * drift; aligning them would misdescribe both.
 *
 * gpucat's GLSL emitter declares every uniform group as `layout(std140) uniform Uniforms_<group> {…}
 * uniforms_<group>;`, so uniform values MUST be delivered through uniform buffer objects
 * (`bindBufferBase(UNIFORM_BUFFER, …)`), never loose `glUniform*` calls. This module creates one GL
 * UBO per uniform BindGroup and writes the group's member values at the std140 byte offsets the
 * emitter already computed (`UniformGroupBlock.members[].offset`, `.totalBytes`).
 *
 * The value sourcing + update lifecycle matches `webgpu/bindings.ts`:
 *   - the RENDER/FRAME/OBJECT update gating (`block.group.updateType` + frameId/renderId dedup),
 *   - invoking each member node's `update` callback through `invokeUniformGroupCallbacks`, which both
 *     backends share from `core/bind-group.ts`,
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
import { invokeUniformGroupCallbacks, type UniformBinding } from '../core/bind-group';
import { type RendererInfo, recordBufferWrite } from '../core/info';
import type { NodeFrame } from '../core/node-frame';

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
export type BindingsState = {
    data: WeakMap<UniformBinding, UboData>;
    /**
     * Per-standalone-UniformGroupBlock GL UBO data. Standalone kernels (transform feedback) have no
     * RenderObject/BindGroup, so their uniform groups are keyed by the compiled `UniformGroupBlock`
     * itself rather than a `UniformBinding`.
     */
    standalone: WeakMap<UniformGroupBlock, UboData>;
    /** All created UBOs, for disposal. */
    all: Set<WebGLBuffer>;
};

/** Create an empty uniforms state. */
export function createBindingsState(): BindingsState {
    return { data: new WeakMap(), standalone: new WeakMap(), all: new Set() };
}

function getUboData(gl: WebGL2RenderingContext, state: BindingsState, binding: UniformBinding, byteLength: number): UboData {
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
/**
 * Bytes differing between two equally-sized packed blocks, or 0 when identical. Counted at 32-bit word
 * granularity because that is the comparison unit, matching the WebGPU backend's `packAndCompare`.
 * A count rather than a boolean so the upload can be attributed: a 64 kB block where four bytes moved
 * is a different problem from one where half of it did.
 */
function changedByteCount(a: ArrayBuffer, b: ArrayBuffer): number {
    const av = new Uint32Array(a);
    const bv = new Uint32Array(b);
    let changed = 0;
    for (let i = 0; i < av.length; i++) {
        if (av[i] !== bv[i]) changed += 4;
    }
    return changed;
}

/** Attribute one UBO upload. `full` is false: this path writes whole blocks, so flagging it would
 *  make the full-re-upload signal tautological. Identity is the material + the block's update scope. */
function recordUniformWrite(info: RendererInfo, block: UniformGroupBlock, material: Material | null, changedBytes: number): void {
    recordBufferWrite(info, block.totalBytes, 'uniform', false, undefined, material?.name, block.group?.updateType, changedBytes);
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
    state: BindingsState,
    binding: UniformBinding,
    frame: NodeFrame,
    bindingPoint: number,
    material: Material | null,
    info: RendererInfo,
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

        const changedBytes = data.uploaded ? changedByteCount(scratch, data.staging) : block.totalBytes;
        if (changedBytes > 0) {
            data.staging = scratch;
            gl.bindBuffer(gl.UNIFORM_BUFFER, data.ubo);
            if (!data.uploaded) {
                gl.bufferData(gl.UNIFORM_BUFFER, scratch, gl.DYNAMIC_DRAW);
                data.uploaded = true;
            } else {
                gl.bufferSubData(gl.UNIFORM_BUFFER, 0, scratch);
            }
            recordUniformWrite(info, block, material, changedBytes);
        }
    } else if (!data.uploaded) {
        // First time we see a skipped-shared group (already updated by another object this render):
        // still needs its bytes on the GPU. Pack + upload once.
        packGroup(block, new DataView(data.staging), material);
        gl.bindBuffer(gl.UNIFORM_BUFFER, data.ubo);
        gl.bufferData(gl.UNIFORM_BUFFER, data.staging, gl.DYNAMIC_DRAW);
        data.uploaded = true;
        recordUniformWrite(info, block, material, block.totalBytes);
    }

    // Bind the group's UBO to its program binding point.
    gl.bindBufferBase(gl.UNIFORM_BUFFER, bindingPoint, data.ubo);
}

function getStandaloneUboData(
    gl: WebGL2RenderingContext,
    state: BindingsState,
    block: UniformGroupBlock,
    byteLength: number,
): UboData {
    let data = state.standalone.get(block);
    if (!data || data.staging.byteLength !== byteLength) {
        const ubo = data?.ubo ?? gl.createBuffer();
        if (!ubo) throw new Error('[WebGLRenderer] gl.createBuffer returned null (standalone UBO).');
        if (!data) state.all.add(ubo);
        data = { ubo, staging: new ArrayBuffer(byteLength), uploaded: false };
        state.standalone.set(block, data);
    }
    return data;
}

/**
 * Update + bind a STANDALONE kernel's uniform group (transform-feedback) to `bindingPoint`.
 *
 * Unlike {@link updateAndBindUniformGroup}, there is no RenderObject/BindGroup and no per-frame update
 * gating: the group is keyed by its `UniformGroupBlock` and re-packed on every dispatch, because a
 * standalone kernel's uniforms (e.g. a `dt` timestep) commonly change per invocation and the caller
 * assigns them directly on each `uniform()` node's `.uniform.value`. Member update callbacks (if any)
 * are still invoked through the frame so `onFrame`/`onRender` uniforms resolve. Values are sourced from
 * `m.node.uniform.value` (no material fallback — standalone kernels have no material) and packed std140.
 *
 * @param bindingPoint the GL uniform-buffer binding point this group's block was bound to (from the program)
 */
export function updateAndBindStandaloneUniformGroup(
    gl: WebGL2RenderingContext,
    state: BindingsState,
    block: UniformGroupBlock,
    frame: NodeFrame,
    bindingPoint: number,
    info: RendererInfo,
): void {
    // Let any update callbacks (onFrame/onRender) assign node values; direct `.value` sets need nothing.
    invokeUniformGroupCallbacks(block, frame);

    const data = getStandaloneUboData(gl, state, block, block.totalBytes);

    // Re-pack every dispatch: standalone-kernel uniforms change per frame and there is no dedup key.
    const scratch = new ArrayBuffer(block.totalBytes);
    packGroup(block, new DataView(scratch), null);

    const changedBytes = data.uploaded ? changedByteCount(scratch, data.staging) : block.totalBytes;
    if (changedBytes > 0) {
        data.staging = scratch;
        gl.bindBuffer(gl.UNIFORM_BUFFER, data.ubo);
        if (!data.uploaded) {
            gl.bufferData(gl.UNIFORM_BUFFER, scratch, gl.DYNAMIC_DRAW);
            data.uploaded = true;
        } else {
            gl.bufferSubData(gl.UNIFORM_BUFFER, 0, scratch);
        }
        recordUniformWrite(info, block, null, changedBytes);
    }

    gl.bindBufferBase(gl.UNIFORM_BUFFER, bindingPoint, data.ubo);
}

/** Delete all GL UBOs (called on renderer dispose). */
export function disposeBindingsState(gl: WebGL2RenderingContext, state: BindingsState): void {
    for (const ubo of state.all) gl.deleteBuffer(ubo);
    state.all.clear();
}

/** Number of GL UBOs currently allocated. */
export function getBindingsStats(state: BindingsState): { uboCount: number } {
    return { uboCount: state.all.size };
}
