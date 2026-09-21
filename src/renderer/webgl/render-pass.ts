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
import type { IndexedMeshDraw, NonIndexedMeshDraw } from '../../objects/mesh';
import { resolveIndexedDrawRange, resolveVertexDrawRange } from '../core/draw-range';
import type { DrawOptions } from '../core/frame';
import type { RendererInfo } from '../core/info';
import type { NodeManagerState } from '../core/node-manager';
import * as NodeManager from '../core/node-manager';
import type { RenderContext } from '../core/pass-context';
import { getBindings, pipelineLabel } from '../core/render-object';
import * as RenderState from '../core/render-state';
import type { PreparedRenderObject, RenderPassParams } from '../core/render-types';
import * as Bindings from './bindings';
import * as Geometries from './geometries';
import { getRenderObjectGl } from './render-object-gl';
import { bindRenderTargetFramebuffer, resolveActiveRenderTarget } from './render-target';
import { applyMaterialState, createGlStateCache, establishPassBaseline } from './state';
import { bindTextures } from './texture-bindings';
import type { WebGLBackend } from './webgl-backend';

/**
 * Bind the target framebuffer for a pass: the render target's FBO (allocating + attaching its color
 * textures + depth) when `params.renderTarget` is set, else the default framebuffer (`null`).
 * Returns whether the bound target carries a stencil aspect (drives stencil clears).
 */
function bindFramebuffer(gl: WebGL2RenderingContext, caches: WebGLBackend, params: RenderPassParams): { hasStencil: boolean } {
    if (params.renderTarget) {
        return bindRenderTargetFramebuffer(gl, caches, params.renderTarget, params.layer, params.mipLevel);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { hasStencil: params.swapchainStencil };
}

/** Apply the pass's resolved (physical-pixel) viewport + scissor to GL state. */
function applyViewportScissor(gl: WebGL2RenderingContext, params: RenderPassParams): void {
    if (params.viewport) {
        const v = params.viewportValue;
        // WebGPU's viewport origin is top-left; GL's is bottom-left. Flip Y against the framebuffer height
        // so a top-left rect (e.g. the studio grid's per-card cells, sourced from DOM coordinates) lands in
        // the right place. A full-framebuffer viewport is unchanged by the flip.
        gl.viewport(v.x, params.height - v.y - v.height, v.width, v.height);
        // Honor the viewport's depth range (defaults 0,1). Threaded through per pass so a prior pass's
        // custom range never leaks into this one.
        gl.depthRange(v.minDepth, v.maxDepth);
    } else {
        // No explicit viewport for this pass → cover the full framebuffer at its own size. `params.width`
        // / `.height` are the physical framebuffer dimensions (the render target's size, or the canvas
        // drawing buffer). Setting this every pass (rather than relying on the last gl.viewport) is what
        // lets a render target larger than the canvas draw correctly — e.g. a headless 1x1 OffscreenCanvas
        // rendering into a full-size target. Also restore the default full depth range so a preceding
        // pass's custom depthRange doesn't persist as stale state.
        gl.viewport(0, 0, params.width, params.height);
        gl.depthRange(0, 1);
    }
    if (params.scissor) {
        const s = params.scissorValue;
        gl.enable(gl.SCISSOR_TEST);
        // Same top-left to bottom-left Y flip as the viewport above.
        gl.scissor(s.x, params.height - s.y - s.height, s.width, s.height);
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
        gl.clearDepth(params.clearDepthValue);
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
 * Count one draw into `info`. Triangles come from the CPU-known vertex/index count, so like the WebGPU
 * backend this is a floor rather than a guess; nothing here reads a count back off the GPU.
 */
function countDraw(info: RendererInfo, elementCount: number, instanceCount: number): void {
    info.render.drawCalls++;
    info.render.triangles += (instanceCount * elementCount) / 3;
}

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
 * Resolve how blending works for this pass, throwing on an MRT WebGL2 cannot express.
 *
 * Targets fall into three categories (see `core/render-state`): 'material' inherits the material's
 * blend, 'no' disables blending for that attachment, and any explicit mode resolves the same way for
 * every material. All-'material', all-'no' and all-one-explicit-mode are uniform unconditionally. A
 * mix of 'material' and 'no' (the default MRT shape: a blended `output` plus unblended aux targets)
 * agrees only while the material is opaque, which the draw loop rechecks per material. Anything else
 * genuinely differs and throws.
 */
function planPassBlend(passCtx: RenderContext): PassBlend {
    const mrt = passCtx.mrt;
    const textures = passCtx.renderTarget?.textures;
    if (!mrt || !textures || textures.length === 0) return { targetName: null, opaqueOnly: false };

    const names = textures.map((t) => t.name ?? '');
    const targetName = names[0] ?? '';
    if (textures.length < 2) return { targetName, opaqueOnly: false };

    let sawMaterial = false;
    let sawNo = false;
    let explicitKey: string | null = null;
    for (const name of names) {
        const mode = mrt.getBlendMode(name);
        if (mode.blending === 'material') {
            sawMaterial = true;
        } else if (mode.blending === 'no') {
            sawNo = true;
        } else {
            const key = RenderState.blendStateKey(RenderState.blendModeState(mode));
            if (explicitKey !== null && explicitKey !== key) {
                throw new Error('[webgl] per-attachment blend modes are not supported on the WebGL2 backend.');
            }
            explicitKey = key;
        }
    }
    if (explicitKey !== null && (sawMaterial || sawNo)) {
        throw new Error('[webgl] per-attachment blend modes are not supported on the WebGL2 backend.');
    }

    return { targetName, opaqueOnly: sawMaterial && sawNo };
}

/**
 * Run the whole render pass immediately: bind the framebuffer, apply viewport/scissor, clear on
 * clearsColor, then draw the prepared objects.
 */
export type PassScope = { passBlend: PassBlend };

export function beginPass(caches: WebGLBackend, passCtx: RenderContext, params: RenderPassParams): PassScope {
    const gl = caches.gl!;
    const passBlend = planPassBlend(passCtx);
    const { hasStencil: targetStencil } = bindFramebuffer(gl, caches, params);

    // Before the scissor, not after: `gl.clear` obeys the scissor box and WebGPU's `loadOp` does not,
    // so clearing under it would make one `clear` mean two different regions on the two backends.
    if (params.clearsColor || params.clearsDepth || params.clearsStencil) {
        gl.disable(gl.SCISSOR_TEST);
        clearBuffers(gl, params, params.clearsColor, params.clearsDepth, params.clearsStencil, targetStencil);
    }

    applyViewportScissor(gl, params);

    return { passBlend };
}

/** Unbinds the VAO so later buffer mutations cannot record into it, then resolves an MSAA target. */
export function endPass(caches: WebGLBackend): void {
    const gl = caches.gl!;
    gl.bindVertexArray(null);
    resolveActiveRenderTarget(gl, caches.renderTargets);
}

export function encodeDraws(
    gl: WebGL2RenderingContext,
    caches: WebGLBackend,
    nodes: NodeManagerState,
    passCtx: RenderContext,
    params: RenderPassParams,
    prepared: readonly PreparedRenderObject[],
    preparedOpts: readonly (DrawOptions | null)[],
    count: number,
    inspector: InspectorBase | null,
    info: RendererInfo,
    { passBlend }: PassScope,
): void {
    const hasStencil = !!passCtx.stencil;
    // Pin the GL globals the fresh state cache assumes but the per-draw material state doesn't set
    // (winding, stencil write mask, rasterizer discard) — see establishPassBaseline.
    establishPassBaseline(gl);
    const stateCache = createGlStateCache();
    let currentProgram: WebGLProgram | null = null;
    let currentVao: WebGLVertexArrayObject | null = null;

    const frame = nodes.nodeFrame;

    for (let i = 0; i < count; i++) {
        const renderObject = prepared[i];
        const { mesh, material, geometry } = renderObject;
        const nodeState = renderObject.nodeBuilderState!;

        const opts = preparedOpts[i];
        const draws = opts?.draws ?? mesh.draws;
        const instances = opts?.instances ?? mesh.count;
        const range = opts?.range;

        if (instances === 0 && draws === undefined) continue;

        // Per-object node frame context + neutral updates (matches the WebGPU draw loop).
        frame.object = mesh;
        frame.material = material;
        frame.camera = renderObject.camera;
        NodeManager.updateForRender(nodes, renderObject);

        const payload = getRenderObjectGl(caches.renderObjectGl, renderObject);
        const programInfo = payload.program;
        if (!programInfo) {
            throw new Error(`[webgl] '${mesh.name || 'mesh'}' reached the draw loop with no linked program.`);
        }

        // Program (deduped). Inspector: a program switch is the WebGL analogue of a pipeline switch.
        if (currentProgram !== programInfo.program) {
            gl.useProgram(programInfo.program);
            currentProgram = programInfo.program;
            // gl_FragCoord Y-flip height: @builtin(position)/screenUV lower to a flip against the
            // framebuffer height so they match WebGPU's top-left origin. Constant per pass; set on
            // each program bind. null location = program doesn't use the builtin.
            if (programInfo.fragCoordFlipHeightLocation != null) {
                gl.uniform1f(programInfo.fragCoordFlipHeightLocation, params.height);
            }
            if (inspector) inspector.setPipeline(pipelineLabel(mesh, material));
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
                Bindings.updateAndBindUniformGroup(gl, caches, binding, frame, bindingPoint, material);
            }
            if (inspector) inspector.setBindGroup(bindGroupIndex, mesh.name || '');
            bindGroupIndex++;
        }

        // Texture + sampler bindings → GL texture units + combined-sampler uniforms.
        bindTextures(gl, caches, renderObject, programInfo);

        // Geometry VAO (uploads buffers + builds/reuses the VAO for this program).
        // `prepareGeometry` detaches the VAO to upload buffers safely (see its note), so the GL VAO
        // is unbound on return — always rebind the resolved one here rather than deduping the GL call.
        const drawInfo = Geometries.prepareGeometry(
            gl,
            caches,
            geometry,
            nodeState,
            programInfo.program,
            renderObject.mesh.name || 'mesh',
        );
        gl.bindVertexArray(drawInfo.vao);
        if (currentVao !== drawInfo.vao) {
            currentVao = drawInfo.vao;
            // Inspector: a VAO carries all vertex (+index) buffer bindings; log it as a single
            // vertex-buffer bind (slot 0) plus an index bind when the geometry is indexed.
            if (inspector) {
                inspector.setVertexBuffer(0);
                if (geometry.index && drawInfo.indexType !== null) inspector.setIndexBuffer();
            }
        }

        // Fixed-function GL state from the material (depth/cull/blend/colorMask/stencil).
        // A mixed 'material'/'no' MRT only agrees across attachments while the material is opaque.
        if (passBlend.opaqueOnly && material.transparent) {
            throw new Error('[webgl] per-attachment blend modes are not supported on the WebGL2 backend.');
        }
        const blend = RenderState.resolveTargetBlend(material, passCtx.mrt, passBlend.targetName);
        applyMaterialState(gl, stateCache, material, hasStencil, blend);

        // Draw. Topology is a triangle list (the GLSL render path targets triangles).
        // `u_drawBase` feeds instanceIndex's base-inclusive lowering (`u_drawBase + gl_InstanceID`).
        const drawBaseLoc = programInfo.drawBaseLocation ?? null;

        if (draws !== undefined) {
            // Batched: one instanced draw per entry, each with its own firstInstance base. The VAO is
            // already bound once above, so the loop only sets u_drawBase + issues the draw. The mesh's
            // geometry selects indexed (drawElements) vs non-indexed (drawArrays) draws.
            if (geometry.index && drawInfo.indexType !== null) {
                // firstIndex is a byte offset for drawElements; each index is 1 (uint8), 2 (uint16) or
                // 4 (uint32) bytes.
                const bytesPerIndex =
                    drawInfo.indexType === gl.UNSIGNED_BYTE ? 1 : drawInfo.indexType === gl.UNSIGNED_SHORT ? 2 : 4;
                for (const d of draws as IndexedMeshDraw[]) {
                    if (d.instanceCount <= 0) continue;
                    if (drawBaseLoc !== null) gl.uniform1ui(drawBaseLoc, d.firstInstance);
                    gl.drawElementsInstanced(
                        gl.TRIANGLES,
                        d.indexCount,
                        drawInfo.indexType,
                        d.firstIndex * bytesPerIndex,
                        d.instanceCount,
                    );
                    if (inspector) inspector.drawIndexed(d.indexCount, d.instanceCount);
                    countDraw(info, d.indexCount, d.instanceCount);
                }
            } else {
                for (const d of draws as NonIndexedMeshDraw[]) {
                    if (d.instanceCount <= 0) continue;
                    if (drawBaseLoc !== null) gl.uniform1ui(drawBaseLoc, d.firstInstance);
                    gl.drawArraysInstanced(gl.TRIANGLES, d.firstVertex, d.vertexCount, d.instanceCount);
                    if (inspector) inspector.draw(d.vertexCount, d.instanceCount);
                    countDraw(info, d.vertexCount, d.instanceCount);
                }
            }
        } else {
            // Reset u_drawBase to 0 so a prior batched draw sharing this program can't leak its
            // firstInstance into instanceIndex here.
            if (drawBaseLoc !== null) gl.uniform1ui(drawBaseLoc, 0);

            if (geometry.index && drawInfo.indexType !== null) {
                const { first, count } = resolveIndexedDrawRange(geometry, range);
                // firstIndex is a byte offset for drawElements; each index is 1 (uint8), 2 (uint16) or
                // 4 (uint32) bytes.
                const bytesPerIndex =
                    drawInfo.indexType === gl.UNSIGNED_BYTE ? 1 : drawInfo.indexType === gl.UNSIGNED_SHORT ? 2 : 4;
                gl.drawElementsInstanced(gl.TRIANGLES, count, drawInfo.indexType, first * bytesPerIndex, instances);
                if (inspector) inspector.drawIndexed(count, instances);
                countDraw(info, count, instances);
            } else {
                const { first, count } = resolveVertexDrawRange(geometry, range);
                gl.drawArraysInstanced(gl.TRIANGLES, first, count, instances);
                if (inspector) inspector.draw(count, instances);
                countDraw(info, count, instances);
            }
        }

        NodeManager.updateAfter(nodes, renderObject);
    }
}
