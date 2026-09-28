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
import { type UniformBinding } from '../core/bind-group';
import type { NodeFrame } from '../core/node-frame';
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
export type UniformCapture = {
    key: object;
    block: UniformGroupBlock;
    bindingPoint: number;
    bytes: Uint8Array<ArrayBuffer>;
};
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
export declare function createBindingsState(): BindingsState;
/**
 * Captures a uniform BindGroup's values for one recorded draw into `pool[index]`.
 *
 * Runs the same update gating as WebGPU: shared groups with a 'frame'/'render' updateType are evaluated
 * at most once per frameId/renderId, so every draw of a pass shares the pass's values; 'object'/'none'
 * groups evaluate per draw. The bytes are the group's persistent packed copy at this moment.
 */
export declare function captureUniformGroup(b: WebGLBackend, binding: UniformBinding, frame: NodeFrame, bindingPoint: number, material: Material | null, pool: UniformCapture[], index: number): void;
/**
 * Captures a STANDALONE kernel's uniform group (transform feedback) for one recorded dispatch into
 * `pool[index]`. There is no RenderObject/BindGroup and no per-frame gating: the group is keyed by its
 * block and re-packed on every dispatch, because a standalone kernel's uniforms (e.g. a `dt` timestep)
 * commonly change per invocation. Member update callbacks still run so `onFrame`/`onRender` uniforms
 * resolve. Values come from `m.node.uniform.value` (no material fallback).
 */
export declare function captureStandaloneUniformGroup(b: WebGLBackend, block: UniformGroupBlock, frame: NodeFrame, bindingPoint: number, pool: UniformCapture[], index: number): void;
/**
 * Uploads a captured group if its bytes differ from what its UBO holds, then binds the UBO to its
 * binding point. Runs as the pass executes, draw by draw, which GL orders for us.
 */
export declare function uploadAndBindCapture(gl: WebGL2RenderingContext, b: WebGLBackend, capture: UniformCapture, material: Material | null): void;
/**
 * What one recorded draw (or transform-feedback dispatch) binds, captured at the call that recorded it:
 * its uniform groups' bytes and the texture and sampler values it samples. Pooled per record.
 */
export type RecordCapture = {
    uniforms: UniformCapture[];
    uniformCount: number;
    textures: TextureCapture;
};
export declare function createRecordCapture(): RecordCapture;
export {};
