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
import { type UniformBinding } from '../core/bind-group';
import { type RendererInfo } from '../core/info';
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
export declare function createBindingsState(): BindingsState;
/**
 * Update a single uniform BindGroup for the current draw and bind its UBO to `bindingPoint`.
 *
 * Runs the same update gating as WebGPU: shared groups with a 'frame'/'render' updateType are
 * processed at most once per frameId/renderId; 'object'/'none' groups always process. Then invokes
 * member update callbacks, packs into a scratch buffer, uploads to the GL UBO if changed, and binds.
 *
 * @param bindingPoint the GL uniform-buffer binding point this group's block was bound to (from the program)
 */
export declare function updateAndBindUniformGroup(gl: WebGL2RenderingContext, state: BindingsState, binding: UniformBinding, frame: NodeFrame, bindingPoint: number, material: Material | null, info: RendererInfo): void;
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
export declare function updateAndBindStandaloneUniformGroup(gl: WebGL2RenderingContext, state: BindingsState, block: UniformGroupBlock, frame: NodeFrame, bindingPoint: number, info: RendererInfo): void;
/** Delete all GL UBOs (called on renderer dispose). */
export declare function disposeBindingsState(gl: WebGL2RenderingContext, state: BindingsState): void;
/** Number of GL UBOs currently allocated. */
export declare function getBindingsStats(state: BindingsState): {
    uboCount: number;
};
export {};
