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
import type { PassOrder } from '../core/pass-order';
import { getBindings, pipelineLabel } from '../core/render-object';
import * as RenderState from '../core/render-state';
import { formatHasStencil, type PreparedRenderObject, type RenderPassParams } from '../core/render-types';
import * as Bindings from './bindings';
import * as DrawBases from './draw-bases';
import * as Geometries from './geometries';
import * as PassUniforms from './pass-uniforms';
import { getRenderObjectGl } from './render-object-gl';
import { bindRenderTargetFramebuffer, resolveActiveRenderTarget } from './render-target';
import * as State from './state';
import { bindTextures, captureTextures } from './texture-bindings';
import { isIntegerTextureFormat } from './textures';
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

/** The resolved (physical-pixel) rects a run of draws is drawn under. */
type Rects = Pick<RenderPassParams, 'viewport' | 'viewportValue' | 'scissor' | 'scissorValue'>;

/** Apply a run's resolved (physical-pixel) viewport + scissor to GL state, over a `width` x `height` framebuffer. */
function applyViewportScissor(
    gl: WebGL2RenderingContext,
    state: State.GlState,
    width: number,
    height: number,
    rects: Rects,
): void {
    if (rects.viewport) {
        const v = rects.viewportValue;
        // WebGPU's viewport origin is top-left; GL's is bottom-left. Flip Y against the framebuffer height
        // so a top-left rect (e.g. the studio grid's per-card cells, sourced from DOM coordinates) lands in
        // the right place. A full-framebuffer viewport is unchanged by the flip.
        State.setViewport(gl, state, v.x, height - v.y - v.height, v.width, v.height);
        // Honor the viewport's depth range (defaults 0,1). Threaded through per pass so a prior pass's
        // custom range never leaks into this one.
        State.setDepthRange(gl, state, v.minDepth, v.maxDepth);
    } else {
        // No explicit viewport for this pass → cover the full framebuffer at its own size. `params.width`
        // / `.height` are the physical framebuffer dimensions (the render target's size, or the canvas
        // drawing buffer). Setting this every pass (rather than relying on the last gl.viewport) is what
        // lets a render target larger than the canvas draw correctly — e.g. a headless 1x1 OffscreenCanvas
        // rendering into a full-size target. Also restore the default full depth range so a preceding
        // pass's custom depthRange doesn't persist as stale state.
        State.setViewport(gl, state, 0, 0, width, height);
        State.setDepthRange(gl, state, 0, 1);
    }
    if (rects.scissor) {
        const s = rects.scissorValue;
        State.setCapability(gl, state, 'scissorTest', true);
        // Same top-left to bottom-left Y flip as the viewport above.
        State.setScissor(gl, state, s.x, height - s.y - s.height, s.width, s.height);
    } else {
        State.setCapability(gl, state, 'scissorTest', false);
    }
}

const clearColorValue: number[] = [0, 0, 0, 0];

function hasIntegerAttachment(textures: readonly { format: string }[]): boolean {
    for (let i = 0; i < textures.length; i++) if (isIntegerTextureFormat(textures[i].format)) return true;
    return false;
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
    state: State.GlState,
    params: RenderPassParams,
    color: boolean,
    depth: boolean,
    stencil: boolean,
    hasStencil: boolean,
): void {
    let mask = 0;
    if (color) {
        const { r, g, b, a } = params.clearColor;
        State.setColorMask(gl, state, true);
        const textures = params.renderTarget?.textures;
        if (textures && hasIntegerAttachment(textures)) {
            // `gl.clear` on an integer draw buffer is INVALID_OPERATION, which drops the depth and stencil clear too:
            // each attachment is cleared by its own type, as WebGPU's clearValue converts to the attachment's
            clearColorValue[0] = r;
            clearColorValue[1] = g;
            clearColorValue[2] = b;
            clearColorValue[3] = a;
            for (let i = 0; i < textures.length; i++) {
                const format = textures[i].format;
                if (format.endsWith('uint')) gl.clearBufferuiv(gl.COLOR, i, clearColorValue);
                else if (format.endsWith('sint')) gl.clearBufferiv(gl.COLOR, i, clearColorValue);
                else gl.clearBufferfv(gl.COLOR, i, clearColorValue);
            }
        } else {
            State.setClearColor(gl, state, r, g, b, a);
            mask |= gl.COLOR_BUFFER_BIT;
        }
    }
    if (depth) {
        State.setClearDepth(gl, state, params.clearDepthValue);
        State.setDepthMask(gl, state, true);
        mask |= gl.DEPTH_BUFFER_BIT;
    }
    // Stencil only clears on a stencil-capable attachment.
    if (stencil && hasStencil) {
        State.setClearStencil(gl, state, params.clearStencilValue);
        State.setStencilWriteMask(gl, state, 0xff);
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
    const names = passCtx.colorNames;
    if (!mrt || names.length === 0) return { targetName: null, opaqueOnly: false };

    const targetName = names[0] ?? '';
    if (names.length < 2) return { targetName, opaqueOnly: false };

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
        State.setCapability(gl, caches.glState, 'scissorTest', false);
        clearBuffers(gl, caches.glState, params, params.clearsColor, params.clearsDepth, params.clearsStencil, targetStencil);
    }

    // each run of draws sets the rects it was recorded under (`encodeDraws`)
    return { passBlend };
}

/**
 * Invalidates the depth and stencil the pass doesn't store, then resolves an MSAA target (its colour alone, so they can
 * go first). The VAO stays bound: index uploads unbind it through `glState` first.
 */
export function endPass(caches: WebGLBackend, params: RenderPassParams): void {
    const gl = caches.gl!;
    invalidateUnstored(gl, params);
    resolveActiveRenderTarget(gl, caches.renderTargets, caches.glState);
}

// the default framebuffer names its buffers, a framebuffer object its attachment points
function invalidateUnstored(gl: WebGL2RenderingContext, params: RenderPassParams): void {
    const rt = params.renderTarget;
    const stencil = rt === null ? params.swapchainStencil : formatHasStencil(rt._depthAttachment?.format);
    const attachments: GLenum[] = [];
    if (!params.storesDepth) attachments.push(rt === null ? gl.DEPTH : gl.DEPTH_ATTACHMENT);
    if (stencil && !params.storesStencil) attachments.push(rt === null ? gl.STENCIL : gl.STENCIL_ATTACHMENT);
    if (attachments.length > 0) gl.invalidateFramebuffer(gl.FRAMEBUFFER, attachments);
}

/**
 * Runs a draw's node updates and captures its uniforms and textures into `out`, at the call that
 * recorded it, so the draw uses the values set before that call.
 */
export function captureDraw(
    caches: WebGLBackend,
    nodes: NodeManagerState,
    renderObject: PreparedRenderObject,
    out: Bindings.RecordCapture,
): void {
    const frame = nodes.nodeFrame;
    frame.object = renderObject.mesh;
    frame.material = renderObject.material;
    frame.camera = renderObject.camera;
    NodeManager.updateForRender(nodes, renderObject);

    const programInfo = getRenderObjectGl(caches.renderObjectGl, renderObject).program;
    if (!programInfo) {
        throw new Error(`[webgl] '${renderObject.mesh.name || 'mesh'}' was recorded with no linked program.`);
    }

    out.uniformCount = 0;
    for (const bindGroup of getBindings(renderObject)) {
        for (const binding of bindGroup.bindings) {
            if (binding.kind !== 'uniform') continue;
            const bindingPoint = programInfo.uboBindingPoints.get(binding.block.groupName);
            if (bindingPoint === undefined) continue; // block optimized out / unused
            Bindings.captureUniformGroup(
                caches,
                binding,
                frame,
                bindingPoint,
                renderObject.material,
                out.uniforms,
                out.uniformCount++,
            );
        }
    }
    captureTextures(renderObject, out.textures);
}

/** Where each of a pass's draws' multi-draw tables starts, by draw, or -1 for a draw that reads none. */
const _tableStarts: number[] = [];

export function encodeDraws(
    gl: WebGL2RenderingContext,
    caches: WebGLBackend,
    nodes: NodeManagerState,
    passCtx: RenderContext,
    params: RenderPassParams,
    prepared: readonly PreparedRenderObject[],
    preparedOpts: readonly (DrawOptions | null)[],
    captures: readonly Bindings.RecordCapture[],
    count: number,
    order: PassOrder,
    inspector: InspectorBase | null,
    info: RendererInfo,
    { passBlend }: PassScope,
): void {
    const hasStencil = !!passCtx.stencil;
    // The program, VAO and uniform buffers carry over from the last pass in `glState`; these are for the inspector,
    // which reports switches within the pass.
    let passProgram: WebGLProgram | null = null;
    let currentVao: WebGLVertexArrayObject | null = null;
    const glState = caches.glState;

    // Every draw list's table is in the pass's buffer before the first draw reads one.
    const drawBases = caches._drawBases;
    if (drawBases !== null) {
        DrawBases.beginPassTables(drawBases);
        for (let i = 0; i < count; i++) {
            const draws = preparedOpts[i]?.draws ?? prepared[i].mesh.draws;
            const program = getRenderObjectGl(caches.renderObjectGl, prepared[i]).program;
            _tableStarts[i] = draws !== undefined && program?.drawBases ? DrawBases.addListTable(drawBases, draws) : -1;
        }
        DrawBases.uploadPassTables(gl, drawBases, info);
    }

    // Each scope's shared view and frame blocks into the pass's slots, in recorded order, ahead of every draw: a draw
    // then binds its scope's slot wherever its bin put it
    const passUniforms = caches._passUniforms!;
    PassUniforms.beginPassUniforms(passUniforms);
    for (let i = 0; i < count; i++) {
        const capture = captures[i];
        for (let u = 0; u < capture.uniformCount; u++) {
            const uniform = capture.uniforms[u];
            if (uniform.scope !== -1) PassUniforms.placeCapture(passUniforms, uniform);
        }
    }
    PassUniforms.uploadPassUniforms(gl, passUniforms, info);

    // The target's FBO draws to every attachment; a draw whose fragment leaves one unwritten sets it to NONE for its
    // turn, as WebGPU masks it off (`writesTarget`), and the pass puts them all back after its last draw.
    const attachments = params.renderTarget?.textures.length ?? 0;
    const allWritten = '1'.repeat(attachments);
    let drawBuffers = allWritten;

    let currentView = -1;
    for (let blockIndex = 0; blockIndex < order.blockCount; blockIndex++) {
        const block = order.blocks[blockIndex]!;
        for (let at = 0; at < block.count; at++) {
            const i = block.draws[at]!;
            const view = order.drawViews[i]!;
            if (view !== currentView) {
                currentView = view;
                applyViewportScissor(gl, caches.glState, params.width, params.height, order.views[view]!);
            }
            const renderObject = prepared[i];
            const { mesh, material, geometry } = renderObject;
            const nodeState = renderObject.nodeBuilderState!;

            const opts = preparedOpts[i];
            const draws = opts?.draws ?? mesh.draws;
            const instances = opts?.instances ?? mesh.count;
            const range = opts?.range;

            const capture = captures[i];

            const payload = getRenderObjectGl(caches.renderObjectGl, renderObject);
            const programInfo = payload.program;
            if (!programInfo) {
                throw new Error(`[webgl] '${mesh.name || 'mesh'}' reached the draw loop with no linked program.`);
            }

            // Program (deduped). Inspector: a program switch is the WebGL analogue of a pipeline switch.
            State.useProgram(gl, glState, programInfo.program);
            if (attachments > 0) {
                const written = RenderState.writtenTargets(material.fragment, attachments);
                if (written !== drawBuffers) {
                    setDrawBuffers(gl, written);
                    drawBuffers = written;
                }
            }
            // gl_FragCoord Y-flip height: @builtin(position)/screenUV lower to a flip against the framebuffer height so
            // they match WebGPU's top-left origin. A uniform keeps its value with its program, which passes share, so it
            // is written when this pass's height differs. null location = program doesn't use the builtin.
            if (programInfo.fragCoordFlipHeightLocation != null && programInfo.fragCoordFlipHeight !== params.height) {
                gl.uniform1f(programInfo.fragCoordFlipHeightLocation, params.height);
                programInfo.fragCoordFlipHeight = params.height;
            }
            if (passProgram !== programInfo.program) {
                passProgram = programInfo.program;
                if (inspector) inspector.setPipeline(pipelineLabel(mesh, material));
            }

            // Uniform groups → std140 UBOs: each group's bytes as the draw recorded them, uploaded if they
            // differ from what its UBO holds and bound to its program binding point.
            for (let u = 0; u < capture.uniformCount; u++) {
                Bindings.uploadAndBindCapture(gl, caches, capture.uniforms[u], material, glState);
            }
            if (inspector) {
                const groupCount = getBindings(renderObject).length;
                for (let g = 0; g < groupCount; g++) inspector.setBindGroup(g, mesh.name || '');
            }

            // Texture + sampler bindings → GL texture units + combined-sampler uniforms, as recorded.
            bindTextures(gl, caches, renderObject, programInfo, capture.textures);

            // Geometry VAO (uploads buffers + builds/reuses the VAO for this program, unbinding through `glState` to upload
            // safely); `currentVao` is the VAO the draws switched to, for the inspector.
            const drawInfo = Geometries.prepareGeometry(
                gl,
                caches,
                geometry,
                nodeState,
                programInfo.program,
                renderObject.mesh.name || 'mesh',
            );
            State.bindVertexArray(gl, glState, drawInfo.vao);
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
            State.applyMaterialState(gl, caches.glState, material, hasStencil, blend);

            // Draw. Topology is a triangle list (the GLSL render path targets triangles).
            // `u_drawBase` feeds instanceIndex's base-inclusive lowering (`u_drawBase + gl_InstanceID`).
            const drawBaseLoc = programInfo.drawBaseLocation ?? null;

            if (draws !== undefined && drawBases !== null) {
                // Batched under WEBGL_multi_draw: the list as one call, each entry's base from the pass's table
                if (geometry.index && drawInfo.indexType !== null) {
                    const bytesPerIndex =
                        drawInfo.indexType === gl.UNSIGNED_BYTE ? 1 : drawInfo.indexType === gl.UNSIGNED_SHORT ? 2 : 4;
                    const list = draws as IndexedMeshDraw[];
                    DrawBases.drawIndexedList(gl, drawBases, glState, list, drawInfo.indexType, bytesPerIndex, _tableStarts[i]!);
                    for (const d of list) {
                        if (d.instanceCount <= 0) continue;
                        if (inspector) inspector.drawIndexed(d.indexCount, d.instanceCount);
                        countDraw(info, d.indexCount, d.instanceCount);
                    }
                } else {
                    const list = draws as NonIndexedMeshDraw[];
                    DrawBases.drawList(gl, drawBases, glState, list, _tableStarts[i]!);
                    for (const d of list) {
                        if (d.instanceCount <= 0) continue;
                        if (inspector) inspector.draw(d.vertexCount, d.instanceCount);
                        countDraw(info, d.vertexCount, d.instanceCount);
                    }
                }
            } else if (draws !== undefined) {
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
                // firstInstance into instanceIndex here; under multi-draw, its base is the zero table's entry 0.
                if (drawBaseLoc !== null) gl.uniform1ui(drawBaseLoc, 0);
                else if (drawBases !== null && programInfo.drawBases) DrawBases.bindZeroTable(gl, drawBases, glState);

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
    if (drawBuffers !== allWritten) setDrawBuffers(gl, allWritten);
}

/** Draw buffers by attachment: `COLOR_ATTACHMENTi` where `written` has a `1`, `NONE` where it has a `0`. */
function setDrawBuffers(gl: WebGL2RenderingContext, written: string): void {
    const buffers: GLenum[] = [];
    for (let i = 0; i < written.length; i++) buffers.push(written[i] === '1' ? gl.COLOR_ATTACHMENT0 + i : gl.NONE);
    gl.drawBuffers(buffers);
}
