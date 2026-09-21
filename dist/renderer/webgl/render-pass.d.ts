/**
 * render-pass.ts (webgl) - the immediate-mode render pass + manual clear + draw loop.
 *
 * Mirrors `webgpu/render-pass.ts` in role (attachment binding + clear + draw loop) but in WebGL2's
 * immediate style: no command encoder, no attachment descriptors — bind the framebuffer, set the
 * viewport/scissor, clear, then draw.
 *
 * The draw loop is the WebGL2 port of the WebGPU `draw()` loop: per prepared object it runs the
 * neutral per-object node update, `useProgram` (deduped), updates + binds each uniform group's UBO,
 * binds the geometry VAO, sets the GL fixed-function state from the material, and issues
 * `drawElementsInstanced` / `drawArraysInstanced` (mode = triangle list, index type + drawRange from
 * the geometry, instance count = `mesh.count`). Uniform values flow through the std140 UBO path
 * (never loose `glUniform*`).
 */
import type { InspectorBase } from '../../inspector/inspector-base';
import type { DrawOptions } from '../core/frame';
import type { RendererInfo } from '../core/info';
import type { NodeManagerState } from '../core/node-manager';
import type { RenderContext } from '../core/pass-context';
import type { PreparedRenderObject, RenderPassParams } from '../core/render-types';
import type { BackendState } from './backend-state';
/**
 * How the pass's single GL blend state is chosen.
 *
 * WebGL2 applies one global blend state to all draw buffers (there is no per-attachment blend), so an
 * MRT whose targets resolve to different blends cannot be honored. `targetName` is the target the
 * global state follows; the others are proven to resolve identically, either unconditionally or
 * (`opaqueOnly`) for as long as the material is opaque.
 */
type PassBlend = {
    targetName: string | null;
    opaqueOnly: boolean;
};
/**
 * Run the whole render pass immediately: bind the framebuffer, apply viewport/scissor, clear on
 * autoClear, then draw the prepared objects.
 */
export type PassScope = {
    passBlend: PassBlend;
};
export declare function beginPass(gl: WebGL2RenderingContext, caches: BackendState, passCtx: RenderContext, params: RenderPassParams): PassScope;
/** Unbinds the VAO so later buffer mutations cannot record into it, then resolves an MSAA target. */
export declare function endPass(gl: WebGL2RenderingContext, caches: BackendState): void;
export declare function encodeDraws(gl: WebGL2RenderingContext, caches: BackendState, nodes: NodeManagerState, passCtx: RenderContext, prepared: readonly PreparedRenderObject[], preparedOpts: readonly (DrawOptions | null)[], count: number, inspector: InspectorBase | null, info: RendererInfo, { passBlend }: PassScope): void;
export {};
