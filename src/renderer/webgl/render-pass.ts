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
import * as NodeManager from '../core/node-manager';
import type { RenderContext } from '../core/pass-context';
import { getBindings } from '../core/render-object';
import type { PreparedRenderObject, RenderPassParams } from '../core/render-types';
import * as Geometries from './geometries';
import { getRenderObjectGl, type RenderObjectGlCache } from './render-object-gl';
import { bindRenderTargetFramebuffer, resolveActiveRenderTarget, type GlRenderTargetsState } from './render-target';
import type { GlSamplersState } from './samplers';
import { applyMaterialState, createGlStateCache } from './state';
import { bindTextures } from './texture-bindings';
import type { GlTexturesState } from './textures';
import * as Uniforms from './uniforms';

/**
 * Bind the target framebuffer for a pass: the render target's FBO (allocating + attaching its color
 * textures + depth) when `params.renderTarget` is set, else the default framebuffer (`null`).
 * Returns whether the bound target carries a stencil aspect (drives stencil clears).
 */
function bindFramebuffer(gl: WebGL2RenderingContext, caches: DrawCaches, params: RenderPassParams): { hasStencil: boolean } {
    if (params.renderTarget) {
        return bindRenderTargetFramebuffer(gl, caches.renderTargets, caches.textures, params.renderTarget);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { hasStencil: params.swapchainStencil };
}

/** Apply the pass context's resolved (physical-pixel) viewport + scissor to GL state. */
function applyViewportScissor(gl: WebGL2RenderingContext, passCtx: RenderContext): void {
    if (passCtx.viewport) {
        const v = passCtx.viewportValue;
        gl.viewport(v.x, v.y, v.width, v.height);
        // Honor the viewport's depth range (defaults 0,1). Threaded through per pass so a prior pass's
        // custom range never leaks into this one.
        gl.depthRange(v.minDepth, v.maxDepth);
    } else {
        // No explicit viewport for this pass → restore the default full depth range so a preceding
        // pass's custom depthRange doesn't persist as stale state.
        gl.depthRange(0, 1);
    }
    if (passCtx.scissor) {
        const s = passCtx.scissorValue;
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(s.x, s.y, s.width, s.height);
    } else {
        gl.disable(gl.SCISSOR_TEST);
    }
}

/**
 * Clear the currently-bound framebuffer per the color/depth/stencil flags, using
 * `params.clearColor` / `params.clearStencilValue`. Assumes the framebuffer is already bound.
 *
 * Depth/stencil clears require the write masks be enabled, or `gl.clear` is a no-op for that aspect;
 * the draw loop may have left `depthMask`/`stencilMask` disabled, so we force them on here.
 */
function clearBuffers(
    gl: WebGL2RenderingContext,
    params: RenderPassParams,
    color: boolean,
    depth: boolean,
    stencil: boolean,
    hasStencil: boolean,
): void {
    let mask = 0;
    if (color) {
        const { r, g, b, a } = params.clearColor;
        gl.clearColor(r, g, b, a);
        gl.colorMask(true, true, true, true);
        mask |= gl.COLOR_BUFFER_BIT;
    }
    if (depth) {
        gl.clearDepth(1.0);
        gl.depthMask(true);
        mask |= gl.DEPTH_BUFFER_BIT;
    }
    // Stencil only clears on a stencil-capable attachment.
    if (stencil && hasStencil) {
        gl.clearStencil(params.clearStencilValue);
        gl.stencilMask(0xff);
        mask |= gl.STENCIL_BUFFER_BIT;
    }
    if (mask !== 0) gl.clear(mask);
}

/**
 * Manually clear the current framebuffer (color and/or depth and/or stencil), ignoring autoClear and
 * viewport/scissor. The scissor test is disabled so the whole framebuffer clears.
 */
export function clear(
    gl: WebGL2RenderingContext,
    caches: DrawCaches,
    params: RenderPassParams,
    color: boolean,
    depth: boolean,
    stencil: boolean,
): void {
    const { hasStencil } = bindFramebuffer(gl, caches, params);
    gl.disable(gl.SCISSOR_TEST);
    clearBuffers(gl, params, color, depth, stencil, hasStencil);
    // If the cleared target is MSAA, resolve the cleared multisample buffer into its texture.
    resolveActiveRenderTarget(gl, caches.renderTargets);
}

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
 * Detect an MRT that requests *differing* blend modes across its color targets. WebGL2 applies one
 * global blend state to all draw buffers (no per-attachment blend), so a single uniform blend across
 * all targets is fine, but distinct per-target blends can't be honored — throw rather than silently
 * blending every attachment the same. Mirrors the WebGPU pipeline's per-target `mrt.getBlendMode`.
 */
function assertUniformMrtBlend(passCtx: RenderContext): void {
    const mrt = passCtx.mrt;
    const textures = passCtx.renderTarget?.textures;
    if (!mrt || !textures || textures.length < 2) return;

    // Reduce each target's blend to a comparable key. 'material' and 'no' compare by their tag;
    // explicit blend specs compare by their factor/equation fields (a custom per-target spec).
    const keyOf = (name: string): string => {
        const b = mrt.getBlendMode(name);
        if (b.blending === 'material' || b.blending === 'no') return b.blending;
        return `${b.blending}:${b.blendSrc},${b.blendDst},${b.blendEquation},${b.blendSrcAlpha},${b.blendDstAlpha},${b.blendEquationAlpha}`;
    };

    const first = keyOf(textures[0]?.name ?? '');
    for (let i = 1; i < textures.length; i++) {
        if (keyOf(textures[i]?.name ?? '') !== first) {
            throw new Error('[WebGLRenderer] per-attachment blend modes are not supported on the WebGL2 backend.');
        }
    }
}

/**
 * Run the whole render pass immediately: bind the framebuffer, apply viewport/scissor, clear on
 * autoClear, then draw the prepared objects.
 */
export function executeRenderPass(
    gl: WebGL2RenderingContext,
    caches: DrawCaches,
    nodes: NodeManagerState,
    passCtx: RenderContext,
    prepared: PreparedRenderObject[],
    params: RenderPassParams,
    inspector: InspectorBase | null,
): void {
    // Reject an MRT that asks for differing per-attachment blends (WebGL2 has one global blend state).
    assertUniformMrtBlend(passCtx);

    const { hasStencil: targetStencil } = bindFramebuffer(gl, caches, params);
    applyViewportScissor(gl, passCtx);

    if (params.autoClear) {
        // A loadOp:'load' equivalent would skip color/depth clears; autoClear=true clears them.
        clearBuffers(gl, params, true, true, params.autoClearStencil, targetStencil);
    }

    if (prepared.length === 0) {
        // An MSAA target still needs its (cleared) multisample buffer resolved into the texture.
        resolveActiveRenderTarget(gl, caches.renderTargets);
        return;
    }

    const hasStencil = !!passCtx.stencil;
    const stateCache = createGlStateCache();
    let currentProgram: WebGLProgram | null = null;
    let currentVao: WebGLVertexArrayObject | null = null;

    const frame = nodes.nodeFrame;

    for (const { renderObject, item } of prepared) {
        const mesh = item.mesh!;
        const material = item.material!;
        const geometry = item.geometry!;
        const nodeState = renderObject.nodeBuilderState!;

        if (mesh.count === 0) continue;

        // Per-object node frame context + neutral updates (matches the WebGPU draw loop).
        frame.object = mesh;
        frame.material = material;
        frame.camera = renderObject.camera;
        frame.scene = renderObject.scene;
        NodeManager.updateForRender(nodes, renderObject);

        const payload = getRenderObjectGl(caches.renderObjectGl, renderObject);
        const programInfo = payload.program;
        if (!programInfo) continue;

        // Program (deduped). Inspector: a program switch is the WebGL analogue of a pipeline switch.
        if (currentProgram !== programInfo.program) {
            gl.useProgram(programInfo.program);
            currentProgram = programInfo.program;
            if (inspector) inspector.setPipeline(mesh.name || material.constructor.name);
        }

        // Uniform groups → std140 UBOs. Each of the RenderObject's uniform bind groups is updated and
        // bound to its program binding point.
        const bindGroups = getBindings(renderObject);
        let bindGroupIndex = 0;
        for (const bindGroup of bindGroups) {
            for (const binding of bindGroup.bindings) {
                if (binding.kind !== 'uniform') continue;
                const bindingPoint = programInfo.uboBindingPoints.get(binding.block.groupName);
                if (bindingPoint === undefined) continue; // block optimized out / unused
                Uniforms.updateAndBindUniformGroup(gl, caches.uniforms, binding, frame, bindingPoint, material);
            }
            if (inspector) inspector.setBindGroup(bindGroupIndex, mesh.name || '');
            bindGroupIndex++;
        }

        // Texture + sampler bindings → GL texture units + combined-sampler uniforms.
        bindTextures(gl, caches.textures, caches.samplers, renderObject, programInfo);

        // Geometry VAO (uploads buffers + builds/reuses the VAO for this program).
        const drawInfo = Geometries.prepareGeometry(gl, caches.geometries, geometry, nodeState, programInfo.program);
        if (currentVao !== drawInfo.vao) {
            gl.bindVertexArray(drawInfo.vao);
            currentVao = drawInfo.vao;
            // Inspector: a VAO carries all vertex (+index) buffer bindings; log it as a single
            // vertex-buffer bind (slot 0) plus an index bind when the geometry is indexed.
            if (inspector) {
                inspector.setVertexBuffer(0);
                if (geometry.index && drawInfo.indexType !== null) inspector.setIndexBuffer();
            }
        }

        // Fixed-function GL state from the material (depth/cull/blend/colorMask/stencil).
        applyMaterialState(gl, stateCache, material, hasStencil);

        // Draw. Topology is a triangle list (the GLSL render path targets triangles); instance count
        // is `mesh.count` (defaults to 1). drawRange gives first + count.
        const instances = mesh.count;
        const start = geometry.drawRange.start;

        if (geometry.index && drawInfo.indexType !== null) {
            const indexArray = geometry.index.array!;
            const count = Math.min(geometry.drawRange.count, indexArray.length);
            // firstIndex is a byte offset for drawElements; each index is 1 (uint8), 2 (uint16) or
            // 4 (uint32) bytes.
            const bytesPerIndex = drawInfo.indexType === gl.UNSIGNED_BYTE ? 1 : drawInfo.indexType === gl.UNSIGNED_SHORT ? 2 : 4;
            gl.drawElementsInstanced(gl.TRIANGLES, count, drawInfo.indexType, start * bytesPerIndex, instances);
            if (inspector) inspector.drawIndexed(count, instances);
        } else {
            const position = geometry.buffers.get('position');
            const vertexCount =
                geometry.drawRange.count === Infinity
                    ? (position?.count ?? 3)
                    : Math.min(geometry.drawRange.count, position?.count ?? geometry.drawRange.count);
            gl.drawArraysInstanced(gl.TRIANGLES, start, vertexCount, instances);
            if (inspector) inspector.draw(vertexCount, instances);
        }

        NodeManager.updateAfter(nodes, renderObject);
    }

    // Leave the VAO unbound so subsequent buffer mutations don't accidentally record into it.
    gl.bindVertexArray(null);

    // MSAA target: resolve the multisample render FBO into the sampleable texture FBO (blit). A no-op
    // for non-MSAA targets / the default framebuffer.
    resolveActiveRenderTarget(gl, caches.renderTargets);
}
