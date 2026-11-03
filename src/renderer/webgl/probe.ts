/**
 * probe.ts (webgl) - render a single RenderObject with a PATCHED fragment shader into a tiny FBO and
 * read back the resulting color. Drives the Inspector's live-value shader probe on the WebGL backend.
 *
 * This is the GL sibling of the WebGPU probe re-render in inspector.ts. It reuses the SAME device
 * layer the normal draw uses — `programs.ts` to compile+link a patched program (real vertex GLSL +
 * the probe's patched fragment GLSL), `geometries.ts` to bind the object's VAO, `bindings.ts` to
 * update+bind its std140 UBOs (camera/model, already valid this frame), and `texture-bindings.ts`
 * for its textures — so the probe renders the same mesh with the same inputs, only the fragment
 * output changes. It renders to a 1×1 RGBA8 FBO and `gl.readPixels` the single pixel, returning the
 * decoded value.
 *
 * Nothing here touches WebGPU. The patched-program cache is keyed by the patched fragment source so
 * hovering the same expression across frames reuses one program.
 */

import type { Geometry } from '../../geometry/geometry';
import type { NodeFrame } from '../core/node-frame';
import { getBindings, type RenderObject } from '../core/render-object';
import * as Bindings from './bindings';
import { FRAGMENT_STAGE_MARKER } from './constants';
import * as DrawBases from './draw-bases';
import * as Geometries from './geometries';
import { bindDrawBases, bindUniformBlocks, type ProgramInfo, type TextureUniforms } from './programs';
import * as State from './state';
import { bindTextures } from './texture-bindings';
import { bindUploadTexture, deleteGlTexture, type TextureCache } from './textures';
import type { WebGLBackend } from './webgl-backend';

/** The probe uploads each group as soon as it captures it, so one slot serves every group. */
const _probeCaptures: Bindings.UniformCapture[] = [];
/** The probe binds outside any pass, so nothing is known bound: reset before each probe. */
const _probeBound = /*@__PURE__*/ Bindings.createBoundUniforms();

/** A cached probe program: the linked GL program + its UBO binding points, plus the 1×1 readback FBO. */
type ProbeGl = {
    program: WebGLProgram;
    uboBindingPoints: Map<string, number>;
    /** whether the instance index reads the multi-draw base table */
    drawBases: boolean;
    textureUniforms: Map<string, TextureUniforms>;
    fbo: WebGLFramebuffer;
    colorTex: WebGLTexture;
    depthRb: WebGLRenderbuffer;
    /** The patched fragment source this program was built from (cache key). */
    fragmentSrc: string;
};

/** Split the emitter's combined `code` into vertex + fragment; returns the VERTEX source only. */
function extractVertexSrc(code: string): string {
    const idx = code.indexOf(FRAGMENT_STAGE_MARKER);
    return (idx === -1 ? code : code.slice(0, idx)).trimEnd();
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('[webgl] createShader returned null.');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        const stage = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
        throw new Error(`[webgl] ${stage} shader compile failed:\n${log}\n---- source ----\n${source}`);
    }
    return shader;
}

/**
 * Build (or reuse) the probe program + 1×1 FBO. The probe program links the RenderObject's real
 * VERTEX GLSL with the caller's patched FRAGMENT GLSL, resolving the same std140 UBO binding points
 * the normal program does (so the object's uniform groups bind correctly).
 */
function buildProbeGl(
    gl: WebGL2RenderingContext,
    textures: TextureCache,
    ro: RenderObject,
    patchedFragment: string,
    previous: ProbeGl | null,
): ProbeGl {
    if (previous && previous.fragmentSrc === patchedFragment) return previous;
    if (previous) disposeProbeGl(gl, textures, previous);

    const nodeState = ro.nodeBuilderState;
    if (!nodeState || !nodeState.vertexCode) {
        throw new Error('[webgl] RenderObject has no compiled GLSL.');
    }

    const vertexSrc = extractVertexSrc(nodeState.vertexCode);

    const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSrc);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, patchedFragment);
    const program = gl.createProgram();
    if (!program) throw new Error('[webgl] createProgram returned null.');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program);
        gl.deleteProgram(program);
        throw new Error(`[webgl] program link failed:\n${log}`);
    }

    // the same binding points as the program the main draw uses
    const uboBindingPoints = bindUniformBlocks(gl, program, nodeState.uniformGroups);
    const drawBases = bindDrawBases(gl, program);

    // 1×1 RGBA8 color texture + depth renderbuffer FBO for the readback.
    const colorTex = gl.createTexture()!;
    bindUploadTexture(gl, textures, gl.TEXTURE_2D, colorTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    const depthRb = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, 1, 1);

    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return {
        program,
        uboBindingPoints,
        drawBases,
        textureUniforms: new Map(),
        fbo,
        colorTex,
        depthRb,
        fragmentSrc: patchedFragment,
    };
}

/** Free all GL resources of a probe program. */
function disposeProbeGl(gl: WebGL2RenderingContext, textures: TextureCache, p: ProbeGl): void {
    gl.deleteProgram(p.program);
    gl.deleteFramebuffer(p.fbo);
    deleteGlTexture(gl, textures, p.colorTex);
    gl.deleteRenderbuffer(p.depthRb);
}

/** The opaque state the renderer holds between probe frames (one active probe program). */
export type ProbeState = {
    gl: ProbeGl | null;
};

export function createProbeState(): ProbeState {
    return { gl: null };
}

export function disposeProbeState(gl: WebGL2RenderingContext | null, textures: TextureCache, state: ProbeState): void {
    if (gl && state.gl) disposeProbeGl(gl, textures, state.gl);
    state.gl = null;
}

/**
 * Render the RenderObject with the patched fragment into the 1×1 FBO and read back the pixel.
 *
 * Reuses the object's VAO / UBOs / textures via the shared device functions. Returns the RGBA bytes
 * (0..255) of the single rendered pixel, or null if the object has nothing to draw. Restores GL
 * bindings (framebuffer, VAO, program) to their defaults afterward so the main render loop is
 * unaffected — the probe runs after the main frame's draws, on a separate FBO.
 */
export function renderProbe(
    gl: WebGL2RenderingContext,
    state: ProbeState,
    caches: WebGLBackend,
    frame: NodeFrame,
    ro: RenderObject,
    patchedFragment: string,
): Uint8Array | null {
    const mesh = ro.mesh;
    if (mesh.count === 0) return null;
    const nodeState = ro.nodeBuilderState;
    if (!nodeState) return null;
    const geometry: Geometry = ro.geometry;

    // Build / reuse the probe program (compile errors surface as a thrown Error to the caller).
    const p = buildProbeGl(gl, caches.textures, ro, patchedFragment, state.gl);
    state.gl = p;

    // Wrap the program in a ProgramInfo so the shared texture-binding path can reuse its texture-uniform
    // cache. (bindTextures only reads `program` + `textureUniforms`.)
    const programInfo: ProgramInfo = {
        program: p.program,
        uboBindingPoints: p.uboBindingPoints,
        textureUniforms: p.textureUniforms,
    };

    // Bind the probe FBO + a 1×1 viewport and clear.
    gl.bindFramebuffer(gl.FRAMEBUFFER, p.fbo);
    const glState = caches.glState;
    State.setViewport(gl, glState, 0, 0, 1, 1);
    State.setCapability(gl, glState, 'scissorTest', false);
    State.setClearColor(gl, glState, 0, 0, 0, 1);
    State.setClearDepth(gl, glState, 1);
    State.setDepthMask(gl, glState, true);
    State.setColorMask(gl, glState, true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Depth test on, no culling (probe should show the value at the fragment under the mesh center).
    State.setCapability(gl, glState, 'depthTest', true);
    State.setDepthFunc(gl, glState, gl.LESS);
    State.setCapability(gl, glState, 'cullFace', false);
    State.setCapability(gl, glState, 'blend', false);
    State.setCapability(gl, glState, 'rasterizerDiscard', false);

    gl.useProgram(p.program);
    Bindings.resetBoundUniforms(_probeBound);

    // Capture + upload + bind each uniform group's std140 UBO as the normal draw does, but at once: the
    // probe draws now rather than in a recorded pass. The groups were already updated this frame by the
    // main render; the update-type gate keeps shared groups from re-running.
    const bindGroups = getBindings(ro);
    for (const bindGroup of bindGroups) {
        for (const binding of bindGroup.bindings) {
            if (binding.kind !== 'uniform') continue;
            const bindingPoint = p.uboBindingPoints.get(binding.block.groupName);
            if (bindingPoint === undefined) continue;
            Bindings.captureUniformGroup(caches, binding, frame, bindingPoint, ro.material, _probeCaptures, 0);
            Bindings.uploadAndBindCapture(gl, caches, _probeCaptures[0], ro.material, _probeBound);
        }
    }

    if (caches._drawBases !== null && p.drawBases) DrawBases.bindZeroTable(gl, caches._drawBases, _probeBound);

    // Textures + samplers → GL units + combined-sampler uniforms.
    bindTextures(gl, caches, ro, programInfo, null);

    // Geometry VAO (uploads buffers + builds/reuses the VAO for this program).
    const drawInfo = Geometries.prepareGeometry(gl, caches, geometry, nodeState, p.program);
    gl.bindVertexArray(drawInfo.vao);

    // Draw (triangle list, instance count = mesh.count), mirroring the render-pass draw selection.
    const instances = mesh.count;
    const start = geometry.drawRange.start;
    if (geometry.index && drawInfo.indexType !== null) {
        const count = Math.min(geometry.drawRange.count, geometry.index.count);
        const bytesPerIndex = drawInfo.indexType === gl.UNSIGNED_BYTE ? 1 : drawInfo.indexType === gl.UNSIGNED_SHORT ? 2 : 4;
        gl.drawElementsInstanced(gl.TRIANGLES, count, drawInfo.indexType, start * bytesPerIndex, instances);
    } else {
        const position = geometry.buffers.get('position');
        const vertexCount =
            geometry.drawRange.count === Infinity
                ? (position?.count ?? 3)
                : Math.min(geometry.drawRange.count, position?.count ?? geometry.drawRange.count);
        gl.drawArraysInstanced(gl.TRIANGLES, start, vertexCount, instances);
    }

    // Read back the single pixel.
    const pixel = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);

    // Restore default bindings so the next main-loop frame is unaffected.
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(null);

    return pixel;
}
