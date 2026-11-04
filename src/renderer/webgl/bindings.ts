/**
 * bindings.ts (webgl) - std140 UBO path, the GL sibling of `webgpu/bindings.ts`.
 *
 * Same resource (a `BindGroup` from `core/bind-group.ts`), same filename, different mechanism. WebGPU
 * builds a `GPUBindGroup` object that is created, cached, invalidated and bound as a unit, so its
 * surface is init/get/delete/invalidate. WebGL2 has no bind-group object at all: uniform buffers are
 * bound to numbered binding points per draw, so the surface is capture (when a draw is recorded, so it
 * uses the values set before it) and upload-and-bind (when its pass executes). Those names are not
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
 *     uniforms, then packing it in std140 through `packUniformMembers` (`core/uniform-use.ts`), as WebGPU does.
 * Per-group GL state (the latest packed values, what the UBO holds, change tracking) is cached in a
 * WeakMap keyed by the binding's `bufferKey`, the same key `buffers.ts` holds the UBO under, so shared
 * groups (camera) share one entry and per-object groups get their own, exactly as WebGPU.
 */

import type { Material } from '../../material/material';
import type { UniformGroupBlock } from '../../nodes/builder';
import { invokeUniformGroupCallbacks, type UniformBinding } from '../core/bind-group';
import type { NodeFrame } from '../core/node-frame';
import { syncSharedBlock } from '../core/shared-blocks';
import {
    changedByteCount,
    checkUniformStamp,
    commitUniformStamp,
    packUniformMembers,
    resolvedThisScope,
} from '../core/uniform-use';
import * as Buffers from './buffers';
import * as PassUniforms from './pass-uniforms';
import { bindUniformBuffer, type GlState } from './state';
import type { TextureCapture } from './texture-bindings';
import type { WebGLBackend } from './webgl-backend';

/** Per-uniform-BindGroup GL resources + change-tracking state. */
type UboData = {
    /**
     * The latest values packed, when a draw was recorded. Persistent, so a member with no value keeps its
     * last one, as on WebGPU.
     */
    packed: ArrayBuffer;
    /** What the UBO holds (std140-packed). Compared against a draw's bytes to skip redundant uploads. */
    staging: ArrayBuffer;
    /** Whether the UBO has ever been uploaded. */
    uploaded: boolean;
};

/**
 * One uniform group's bytes as a draw or dispatch recorded them, and where they bind. Captured at the
 * call so it uses the values set before it, uploaded when its pass executes. Pooled per record.
 */
/**
 * A recorded use of a uniform block: its bytes as packed for the draw, or for a shared block's, `shared`, whose buffer
 * is already up to date and binds alone. `scope` names what the bytes hold for (a render id, or the frame) when the
 * block resolves once per scope, -1 when per use; such a use binds the pass's `slot` for its scope (`pass-uniforms.ts`).
 */
export type UniformCapture = {
    key: object;
    block: UniformGroupBlock;
    bindingPoint: number;
    bytes: Uint8Array<ArrayBuffer>;
    shared: boolean;
    scope: number;
    slot: number;
};

/** The scope of a block resolved once per frame: below every render id. */
const FRAME_SCOPE = -2;

/**
 * Bindings state: the CPU half of a uniform binding.
 *
 * The UBOs themselves belong to `buffers.ts`, keyed through the neutral `UniformBinding.bufferKey`
 * slot, exactly as `webgpu/bindings.ts` routes its uniform blocks through `webgpu/buffers.ts`. What
 * stays here is the staging copy and the change detection that decides whether an upload is needed.
 */
export type BindingsState = {
    /**
     * Per-uniform-group state, keyed by what keys its GL buffer in `buffers.ts`: a binding's neutral
     * `bufferKey`, or a standalone kernel's (transform feedback) compiled block, since that has no
     * binding. Shared groups (camera) share one entry and per-object groups get their own, as on WebGPU.
     */
    byKey: WeakMap<object, UboData>;
};

/** Create an empty bindings state. */
export function createBindingsState(): BindingsState {
    return { byKey: new WeakMap() };
}

function getUboData(state: BindingsState, key: object, byteLength: number): UboData {
    let data = state.byKey.get(key);
    if (!data || data.staging.byteLength !== byteLength) {
        data = { packed: new ArrayBuffer(byteLength), staging: new ArrayBuffer(byteLength), uploaded: false };
        state.byKey.set(key, data);
    }
    return data;
}

/** Identity for a uniform-block upload: the material it belongs to and the block's update scope. */
function uniformDetail(block: UniformGroupBlock, material: Material | null, changedBytes: number): Buffers.RawWriteDetail {
    return { material: material?.name, updateType: block.group?.updateType, changedBytes };
}

/**
 * Captures a uniform BindGroup's values for one recorded draw into `pool[index]`.
 *
 * Runs the same update gating as WebGPU: shared groups with a 'frame'/'render' updateType are evaluated
 * at most once per frameId/renderId, so every draw of a pass shares the pass's values; 'object'/'none'
 * groups evaluate per draw. The bytes are the group's persistent packed copy at this moment.
 */
export function captureUniformGroup(
    b: WebGLBackend,
    binding: UniformBinding,
    frame: NodeFrame,
    bindingPoint: number,
    material: Material | null,
    pool: UniformCapture[],
    index: number,
): void {
    const block = binding.block;

    // A shared block's members are synced by the block itself, once a frame and again after one joins, and what moved
    // uploads now, which GL orders before the draws that read it: the use binds its one buffer
    const sharedBlock = binding.sharedBlock;
    if (sharedBlock !== null) {
        syncSharedBlock(sharedBlock, frame);
        Buffers.uploadSharedBlock(b.gl!, b.buffers, sharedBlock);
        let capture = pool[index];
        if (capture === undefined) {
            capture = { key: sharedBlock, block, bindingPoint, bytes: new Uint8Array(0), shared: true, scope: -1, slot: -1 };
            pool[index] = capture;
        }
        capture.key = sharedBlock;
        capture.block = block;
        capture.bindingPoint = bindingPoint;
        capture.shared = true;
        capture.scope = -1;
        return;
    }

    // a shared frame or render block already resolved in this scope captures the bytes that resolve packed
    const resolved = resolvedThisScope(binding, frame);

    // Lazily claim the neutral key slot; `webgpu/bindings.ts` does the same, so both backends key a
    // uniform block's device buffer the same way.
    binding.bufferKey ??= {};
    const data = getUboData(b.uniforms, binding.bufferKey, block.totalBytes);

    // A per-object block whose versions all hold has the bytes it last packed: nothing to pack. A shared one packs at
    // each use its update type allows, and only changed bytes upload.
    if (!resolved) {
        const info = b.renderer.info.state;
        const stamp = block.group.shared ? 'unstamped' : checkUniformStamp(binding, frame, material, info);
        if (stamp !== 'kept') {
            info.packed++;
            invokeUniformGroupCallbacks(block, frame);
            packUniformMembers(block, new DataView(data.packed), material, 'std140');
            commitUniformStamp(binding, stamp);
        }
    }
    captureInto(pool, index, binding.bufferKey, block, bindingPoint, data.packed);
    const updateType = block.group.updateType;
    if (block.group.shared)
        pool[index]!.scope = updateType === 'render' ? frame.renderId : updateType === 'frame' ? FRAME_SCOPE : -1;
}

/**
 * Captures a STANDALONE kernel's uniform group (transform feedback) for one recorded dispatch into
 * `pool[index]`. There is no RenderObject/BindGroup and no per-frame gating: the group is keyed by its
 * block and re-packed on every dispatch, because a standalone kernel's uniforms (e.g. a `dt` timestep)
 * commonly change per invocation. Member update callbacks still run so `onFrame`/`onRender` uniforms
 * resolve. Values come from `m.node.uniform.value` (no material fallback).
 */
export function captureStandaloneUniformGroup(
    b: WebGLBackend,
    block: UniformGroupBlock,
    frame: NodeFrame,
    bindingPoint: number,
    pool: UniformCapture[],
    index: number,
): void {
    invokeUniformGroupCallbacks(block, frame);
    const data = getUboData(b.uniforms, block, block.totalBytes);
    packUniformMembers(block, new DataView(data.packed), null, 'std140');
    captureInto(pool, index, block, block, bindingPoint, data.packed);
}

/**
 * Uploads a captured group if its bytes differ from what its UBO holds, then binds the UBO to its
 * binding point. Runs as the pass executes, draw by draw, which GL orders for us.
 */
export function uploadAndBindCapture(
    gl: WebGL2RenderingContext,
    b: WebGLBackend,
    capture: UniformCapture,
    material: Material | null,
    state: GlState,
): void {
    const { key, block, bytes } = capture;
    if (capture.shared) {
        const ubo = Buffers.getRaw(b.buffers, key);
        if (ubo) bindUniformBuffer(gl, state, capture.bindingPoint, ubo, -1, 0);
        return;
    }
    if (capture.scope !== -1) {
        PassUniforms.bindCaptureSlot(gl, b._passUniforms!, state, capture);
        return;
    }
    const data = getUboData(b.uniforms, key, block.totalBytes);
    const changedBytes = data.uploaded ? changedByteCount(bytes.buffer, data.staging) : block.totalBytes;
    if (changedBytes > 0) {
        new Uint8Array(data.staging).set(bytes);
        Buffers.uploadUniformBlock(gl, b.buffers, key, data.staging, uniformDetail(block, material, changedBytes));
        data.uploaded = true;
    }

    const ubo = Buffers.getRaw(b.buffers, key);
    if (ubo) bindUniformBuffer(gl, state, capture.bindingPoint, ubo, -1, 0);
}

/** Fills the pooled capture at `index`, creating it on first use. */
function captureInto(
    pool: UniformCapture[],
    index: number,
    key: object,
    block: UniformGroupBlock,
    bindingPoint: number,
    packed: ArrayBuffer,
): void {
    let capture = pool[index];
    if (capture === undefined) {
        capture = { key, block, bindingPoint, bytes: new Uint8Array(packed.byteLength), shared: false, scope: -1, slot: -1 };
        pool[index] = capture;
    }
    capture.shared = false;
    capture.scope = -1;
    capture.key = key;
    capture.block = block;
    capture.bindingPoint = bindingPoint;
    if (capture.bytes.byteLength !== packed.byteLength) capture.bytes = new Uint8Array(packed.byteLength);
    capture.bytes.set(new Uint8Array(packed));
}

/**
 * What one recorded draw (or transform-feedback dispatch) binds, captured at the call that recorded it:
 * its uniform groups' bytes and the texture and sampler values it samples. Pooled per record.
 */
export type RecordCapture = { uniforms: UniformCapture[]; uniformCount: number; textures: TextureCapture };

export function createRecordCapture(): RecordCapture {
    return { uniforms: [], uniformCount: 0, textures: { textures: [], ranges: [], samplers: [] } };
}
