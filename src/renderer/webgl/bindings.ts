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
 *     uniforms, then packing it with `packToView(schema, view, offset, value, 'std140')`.
 * Per-group GL state (the latest packed values, what the UBO holds, change tracking) is cached in a
 * WeakMap keyed by the binding's `bufferKey`, the same key `buffers.ts` holds the UBO under, so shared
 * groups (camera) share one entry and per-object groups get their own, exactly as WebGPU.
 */

import type { Material } from '../../material/material';
import type { UniformGroupBlock } from '../../nodes/builder';
import { packToView } from '../../schema/pack';
import { invokeUniformGroupCallbacks, readBlockStamp, sameStamp, type UniformBinding } from '../core/bind-group';
import type { NodeFrame } from '../core/node-frame';
import * as Buffers from './buffers';
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
export type UniformCapture = { key: object; block: UniformGroupBlock; bindingPoint: number; bytes: Uint8Array<ArrayBuffer> };

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

    // Lazily claim the neutral key slot; `webgpu/bindings.ts` does the same, so both backends key a
    // uniform block's device buffer the same way.
    binding.bufferKey ??= {};
    const data = getUboData(b.uniforms, binding.bufferKey, block.totalBytes);

    // A per-object block whose versions all hold has the bytes it last packed: nothing to pack. A shared one packs at
    // each use its update type allows, and only changed bytes upload.
    let stamped = false;
    const info = b.renderer.info.state;
    if (!skipCallbacks) {
        stamped = !block.group.shared && readBlockStamp(block, frame, material, _stamp);
        if (stamped && sameStamp(_stamp, binding.stamp)) {
            skipCallbacks = true;
            info.kept++;
        } else {
            info.packed++;
        }
    }

    if (!skipCallbacks) {
        // Invoke each member node's update callback (assigns node.value, respects updateType).
        invokeUniformGroupCallbacks(block, frame);
        packGroup(block, new DataView(data.packed), material);
        if (stamped) copyStamp(binding.stamp, _stamp);
        else binding.stamp.length = 0;
    }
    captureInto(pool, index, binding.bufferKey, block, bindingPoint, data.packed);
}

/** `into` as a copy of `from`, filled index by index so it stays packed. */
function copyStamp(into: number[], from: readonly number[]): void {
    for (let index = 0; index < from.length; index++) into[index] = from[index]!;
    into.length = from.length;
}

/** The stamp a draw reads before deciding to pack, read before the next draw's. */
const _stamp: number[] = [];

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
    packGroup(block, new DataView(data.packed), null);
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
    bound: BoundUniforms,
): void {
    const { key, block, bytes } = capture;
    const data = getUboData(b.uniforms, key, block.totalBytes);
    const changedBytes = data.uploaded ? changedByteCount(bytes.buffer, data.staging) : block.totalBytes;
    if (changedBytes > 0) {
        new Uint8Array(data.staging).set(bytes);
        Buffers.uploadUniformBlock(gl, b.buffers, key, data.staging, uniformDetail(block, material, changedBytes));
        data.uploaded = true;
    }

    const ubo = Buffers.getRaw(b.buffers, key);
    if (ubo) bindUniformBuffer(gl, bound, capture.bindingPoint, ubo, -1, 0);
}

/**
 * What a pass has bound at each uniform buffer binding point, so a draw binds only what differs, as three.js's
 * `WebGLState` keeps its UBO bindings: a pass starts with none known and each binding point is set once until another
 * buffer or range takes it.
 */
export type BoundUniforms = { buffers: (WebGLBuffer | null)[]; offsets: number[] };

/** Binding points a pass tracks: the groups' and the multi-draw base table's (see programs.ts). */
const TRACKED_BINDING_POINTS = 24;

export function createBoundUniforms(): BoundUniforms {
    const bound: BoundUniforms = { buffers: [], offsets: [] };
    for (let point = 0; point < TRACKED_BINDING_POINTS; point++) {
        bound.buffers.push(null);
        bound.offsets.push(-1);
    }
    return bound;
}

/** Nothing known bound, as a pass begins. Emptied in place, its arrays' length and packing kept. */
export function resetBoundUniforms(bound: BoundUniforms): void {
    for (let point = 0; point < bound.buffers.length; point++) {
        bound.buffers[point] = null;
        bound.offsets[point] = -1;
    }
}

/** Binds `buffer` at `point`, whole for an `offset` of -1, else its `size` bytes from `offset`; skipped if bound so. */
export function bindUniformBuffer(
    gl: WebGL2RenderingContext,
    bound: BoundUniforms,
    point: number,
    buffer: WebGLBuffer,
    offset: number,
    size: number,
): void {
    if (bound.buffers[point] === buffer && bound.offsets[point] === offset) return;
    if (offset < 0) gl.bindBufferBase(gl.UNIFORM_BUFFER, point, buffer);
    else gl.bindBufferRange(gl.UNIFORM_BUFFER, point, buffer, offset, size);
    bound.buffers[point] = buffer;
    bound.offsets[point] = offset;
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
        capture = { key, block, bindingPoint, bytes: new Uint8Array(packed.byteLength) };
        pool[index] = capture;
    }
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
