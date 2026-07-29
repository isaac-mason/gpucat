/**
 * render-pass.ts (webgl) - the immediate-mode render pass + manual clear + draw loop.
 *
 * Mirrors `webgpu/render-pass.ts` in role (attachment binding + clear + draw loop) but in WebGL2's
 * immediate style: no command encoder, no attachment descriptors — bind the framebuffer, set the
 * viewport/scissor, clear, then draw. `WebGLRenderer.render()` calls `executeRenderPass`;
 * `WebGLRenderer.clear()` calls `clear`.
 *
 * The draw loop is the WebGL2 port of the WebGPU `draw()` loop: per prepared object it runs the
 * neutral per-object node update, `useProgram` (deduped), updates + binds each uniform group's UBO,
 * binds the geometry VAO, sets the GL fixed-function state from the material, and issues
 * `drawElementsInstanced` / `drawArraysInstanced` (mode = triangle list, index type + drawRange from
 * the geometry, instance count = `mesh.count`). Uniform values flow through the std140 UBO path
 * (never loose `glUniform*`).
 */
import type { InspectorBase } from '../../inspector/inspector-base';
import type { NodeManagerState } from '../core/node-manager';
import type { RenderContext } from '../core/pass-context';
import type { PreparedRenderObject, RenderPassParams } from '../core/render-types';
import * as Geometries from './geometries';
import { type RenderObjectGlCache } from './render-object-gl';
import { type GlRenderTargetsState } from './render-target';
import type { GlSamplersState } from './samplers';
import type { GlTexturesState } from './textures';
import * as Uniforms from './uniforms';
/**
 * Manually clear the current framebuffer (color and/or depth and/or stencil), ignoring autoClear and
 * viewport/scissor. The scissor test is disabled so the whole framebuffer clears.
 */
export declare function clear(gl: WebGL2RenderingContext, caches: DrawCaches, params: RenderPassParams, color: boolean, depth: boolean, stencil: boolean): void;
/** Caches the draw loop needs, bundled so `executeRenderPass` keeps a small signature. */
export type DrawCaches = {
    geometries: Geometries.GeometriesState;
    uniforms: Uniforms.UniformsState;
    renderObjectGl: RenderObjectGlCache;
    textures: GlTexturesState;
    samplers: GlSamplersState;
    renderTargets: GlRenderTargetsState;
};
/**
 * Run the whole render pass immediately: bind the framebuffer, apply viewport/scissor, clear on
 * autoClear, then draw the prepared objects.
 */
export declare function executeRenderPass(gl: WebGL2RenderingContext, caches: DrawCaches, nodes: NodeManagerState, passCtx: RenderContext, prepared: PreparedRenderObject[], params: RenderPassParams, inspector: InspectorBase | null): void;
