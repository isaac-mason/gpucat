/**
 * render-target.ts (webgl) - FBO (framebuffer object) cache for render-to-texture.
 *
 * The GL analogue of the WebGPU render-target attachment path. When `renderer.renderTarget` is
 * non-null (a `PassNode` render-to-texture, a `CubeCamera` face, etc.), the pass must render into
 * the target's color texture(s) + depth instead of the default framebuffer. This module ports the
 * reference renderer's `setRenderTarget`: get/create one FBO per `RenderTarget`, allocate each color
 * `GpuTexture` at the target size/format (via `textures.ts`), attach it as
 * `COLOR_ATTACHMENT0 + i`, call `drawBuffers([...])` for MRT, and attach depth (a depth texture when
 * the target has one, else a depth renderbuffer). The rendered color textures then become
 * sampleable GL textures in a later pass — proving the FBO round-trip.
 *
 * The FBO is cached per RenderTarget and rebuilt when the target's color/depth GL texture generation
 * changes (size/format change → `textures.ts` recreates the GL texture and bumps `generation`).
 *
 * Cube render targets (`isCubeRenderTarget`): the single color texture is a `TEXTURE_CUBE_MAP`. The
 * FBO's color attachment is the selected face (`framebufferTexture2D(…, TEXTURE_CUBE_MAP_POSITIVE_X +
 * activeFace, …)`); the depth attachment is shared across all six faces. Changing `activeFace`
 * re-attaches the color face (a cheap `framebufferTexture2D`), reusing the same FBO + depth.
 *
 * MSAA render targets (`samples > 1`): the pass renders into a multisample renderbuffer FBO (color +
 * depth as `renderbufferStorageMultisample`) and the result is resolved into the target's texture FBO
 * via `resolveMsaa` (a `blitFramebuffer(… COLOR_BUFFER_BIT, NEAREST)`) at pass end. If the sample
 * count / multisample storage isn't supported the target degrades to single-sampled (a correct but
 * un-antialiased result) with a one-time warning.
 */

import type { RenderTarget } from '../../core/render-target';
import type { CubeRenderTarget } from '../../core/cube-render-target';
import { getGlTextureData, updateTexture, type GlTexturesState } from './textures';

/** Per-RenderTarget GL framebuffer + the color-texture generations it was built against. */
type FboData = {
    /** The GL framebuffer object (the resolve/texture FBO — its color attachments are the target's textures). */
    fbo: WebGLFramebuffer;
    /** Depth renderbuffer, when the target has no depth texture (renderbuffer-backed depth). */
    depthRenderbuffer: WebGLRenderbuffer | null;
    /** Color-attachment texture generations at last (re)build — a change forces a rebuild. */
    colorGenerations: number[];
    /** Depth-attachment texture generation at last rebuild (or -1 for renderbuffer/none). */
    depthGeneration: number;
    /** Last-built size (width, height) — a resize forces a renderbuffer reallocation. */
    width: number;
    height: number;
    /** For a cube target: which face the color attachment currently points at (-1 = not a cube / unset). */
    attachedFace: number;
    /** MSAA render FBO (multisample renderbuffers). Non-null only for a supported `samples > 1` target. */
    msaa: MsaaData | null;
};

/** MSAA render-side resources: the multisample FBO + its color/depth renderbuffers. */
type MsaaData = {
    fbo: WebGLFramebuffer;
    colorRenderbuffers: WebGLRenderbuffer[];
    depthRenderbuffer: WebGLRenderbuffer | null;
    samples: number;
};

/** Render-target FBO state: per-RenderTarget FBO data + a disposal set. */
export type GlRenderTargetsState = {
    data: WeakMap<RenderTarget, FboData>;
    fbos: Set<WebGLFramebuffer>;
    renderbuffers: Set<WebGLRenderbuffer>;
    /** Whether the MSAA-unsupported warning has been logged (log once). */
    msaaWarned: boolean;
    /**
     * The render target currently bound for an in-progress pass whose result must be resolved on pass
     * end (MSAA targets only). `resolveActiveRenderTarget` reads + clears this. Null between passes.
     */
    pendingResolve: RenderTarget | null;
};

/** Create an empty render-targets state. */
export function createGlRenderTargetsState(): GlRenderTargetsState {
    return { data: new WeakMap(), fbos: new Set(), renderbuffers: new Set(), msaaWarned: false, pendingResolve: null };
}

/** Whether the target's depth format carries a stencil aspect. */
function depthFormatHasStencil(format: string | undefined): boolean {
    return format === 'depth24plus-stencil8' || format === 'depth32float-stencil8';
}

/** Whether a render target is a cube render target. */
function isCube(rt: RenderTarget): rt is CubeRenderTarget {
    return rt.isCubeRenderTarget === true;
}

/**
 * Get (or create/rebuild) and bind the FBO for a render target, then return whether it carries a
 * stencil aspect (so the pass knows whether to clear stencil). Allocates the color + depth textures,
 * attaches them, sets `drawBuffers` for MRT, and leaves the FBO bound as `FRAMEBUFFER`.
 *
 * For an MSAA target the bound FBO is the multisample render FBO (drawn into); its result is resolved
 * into the texture FBO at pass end by `resolveActiveRenderTarget`. For a cube target the selected
 * `activeFace` is attached as the color attachment (re-attached cheaply when the face changes).
 */
export function bindRenderTargetFramebuffer(
    gl: WebGL2RenderingContext,
    state: GlRenderTargetsState,
    textures: GlTexturesState,
    renderTarget: RenderTarget,
): { hasStencil: boolean } {
    // Ensure each color texture's GL storage exists at the current size/format.
    const colorGenerations: number[] = [];
    for (const tex of renderTarget.textures) {
        const data = updateTexture(gl, textures, tex._gpuTexture);
        colorGenerations.push(data.generation);
    }

    // Ensure the depth texture's GL storage exists (if the target uses a depth texture).
    let depthGeneration = -1;
    if (renderTarget.depthTexture) {
        const data = updateTexture(gl, textures, renderTarget.depthTexture._gpuTexture);
        depthGeneration = data.generation;
    }

    let fboData = state.data.get(renderTarget);
    const sizeChanged = fboData ? fboData.width !== renderTarget.width || fboData.height !== renderTarget.height : true;
    const generationsChanged =
        fboData &&
        (fboData.depthGeneration !== depthGeneration ||
            fboData.colorGenerations.length !== colorGenerations.length ||
            fboData.colorGenerations.some((g, i) => g !== colorGenerations[i]));

    if (!fboData || sizeChanged || generationsChanged) {
        fboData = rebuildFbo(gl, state, textures, renderTarget, fboData, colorGenerations, depthGeneration);
    }

    // Cube target: (re)attach the selected face as the color attachment if it changed.
    if (isCube(renderTarget) && fboData.attachedFace !== renderTarget.activeFace) {
        attachCubeFace(gl, textures, renderTarget, fboData);
    }

    const hasStencil = depthFormatHasStencil(renderTarget.depthTexture?.format);

    // MSAA: render into the multisample FBO; remember the target so pass end resolves it.
    if (fboData.msaa) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboData.msaa.fbo);
        state.pendingResolve = renderTarget;
    } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboData.fbo);
        state.pendingResolve = null;
    }

    return { hasStencil };
}

/** Attach the cube target's `activeFace` as the FBO's `COLOR_ATTACHMENT0`. */
function attachCubeFace(gl: WebGL2RenderingContext, textures: GlTexturesState, renderTarget: CubeRenderTarget, fboData: FboData): void {
    const data = getGlTextureData(textures, renderTarget.texture._gpuTexture);
    if (!data) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboData.fbo);
    const faceTarget = gl.TEXTURE_CUBE_MAP_POSITIVE_X + renderTarget.activeFace;
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, faceTarget, data.texture, renderTarget.activeMipmapLevel);
    fboData.attachedFace = renderTarget.activeFace;
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
        console.error(`[WebGLRenderer] cube framebuffer incomplete (face ${renderTarget.activeFace}): 0x${status.toString(16)}`);
    }
}

/** (Re)build the FBO for a render target: attach color textures, drawBuffers, and depth. */
function rebuildFbo(
    gl: WebGL2RenderingContext,
    state: GlRenderTargetsState,
    textures: GlTexturesState,
    renderTarget: RenderTarget,
    existing: FboData | undefined,
    colorGenerations: number[],
    depthGeneration: number,
): FboData {
    // Reuse the existing FBO handle (and its depth renderbuffer) where possible.
    let fbo = existing?.fbo;
    if (!fbo) {
        const created = gl.createFramebuffer();
        if (!created) throw new Error('[WebGLRenderer] gl.createFramebuffer returned null.');
        fbo = created;
        state.fbos.add(fbo);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);

    const cube = isCube(renderTarget);
    let attachedFace = -1;

    // Color attachments.
    const drawBuffers: number[] = [];
    renderTarget.textures.forEach((tex, i) => {
        const data = getGlTextureData(textures, tex._gpuTexture);
        if (!data) return;
        const attachment = gl.COLOR_ATTACHMENT0 + i;
        if (cube) {
            // Attach the currently-selected cube face (attachment 0 only — a cube target has one color).
            const faceTarget = gl.TEXTURE_CUBE_MAP_POSITIVE_X + (renderTarget as CubeRenderTarget).activeFace;
            gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment, faceTarget, data.texture, (renderTarget as CubeRenderTarget).activeMipmapLevel);
            attachedFace = (renderTarget as CubeRenderTarget).activeFace;
        } else {
            gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment, gl.TEXTURE_2D, data.texture, 0);
        }
        drawBuffers.push(attachment);
    });
    if (drawBuffers.length > 0) {
        gl.drawBuffers(drawBuffers);
    } else {
        // Depth-only target: no color output.
        gl.drawBuffers([gl.NONE]);
    }

    // Depth attachment (shared across cube faces).
    let depthRenderbuffer = existing?.depthRenderbuffer ?? null;
    if (renderTarget.depthTexture) {
        // Depth texture attachment (sampleable, e.g. for shadow maps).
        if (depthRenderbuffer) {
            gl.deleteRenderbuffer(depthRenderbuffer);
            state.renderbuffers.delete(depthRenderbuffer);
            depthRenderbuffer = null;
        }
        const data = getGlTextureData(textures, renderTarget.depthTexture._gpuTexture);
        if (data) {
            const stencil = depthFormatHasStencil(renderTarget.depthTexture.format);
            const attachment = stencil ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_ATTACHMENT;
            gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment, gl.TEXTURE_2D, data.texture, 0);
        }
    } else {
        // Renderbuffer-backed depth (target requested a depth buffer without a sampleable texture).
        // Only allocate one if the target has no explicit depthTexture AND wants depth — RenderTarget
        // always creates a depthTexture unless depthBuffer:false, so this path handles the
        // no-depth-texture case by leaving depth unattached.
        if (depthRenderbuffer) {
            gl.deleteRenderbuffer(depthRenderbuffer);
            state.renderbuffers.delete(depthRenderbuffer);
            depthRenderbuffer = null;
        }
    }

    // Validate.
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
        console.error(`[WebGLRenderer] framebuffer incomplete: 0x${status.toString(16)}`);
    }

    // MSAA render FBO (multisample renderbuffers). Rebuilt whenever the texture FBO is; a cube target
    // never carries one (CubeRenderTarget forces samples:1).
    let msaa = existing?.msaa ?? null;
    if (msaa) {
        deleteMsaa(gl, state, msaa);
        msaa = null;
    }
    if (renderTarget.samples > 1 && !cube) {
        msaa = buildMsaaFbo(gl, state, textures, renderTarget);
    }

    const fboData: FboData = {
        fbo,
        depthRenderbuffer,
        colorGenerations,
        depthGeneration,
        width: renderTarget.width,
        height: renderTarget.height,
        attachedFace,
        msaa,
    };
    state.data.set(renderTarget, fboData);
    return fboData;
}

/**
 * Build the multisample render FBO for an MSAA target: one multisample color renderbuffer per color
 * attachment plus a multisample depth renderbuffer, matching the target's per-attachment formats. If
 * the requested sample count / multisample storage isn't available, degrade to single-sampled (return
 * null) with a one-time warning — the texture FBO still produces a correct, un-antialiased result.
 */
function buildMsaaFbo(
    gl: WebGL2RenderingContext,
    state: GlRenderTargetsState,
    textures: GlTexturesState,
    renderTarget: RenderTarget,
): MsaaData | null {
    const w = renderTarget.width;
    const h = renderTarget.height;

    // Clamp the requested sample count to what the driver supports for each color format; if the max
    // is < 2 for any attachment, MSAA isn't usable → degrade.
    let samples = renderTarget.samples;

    const colorRenderbuffers: WebGLRenderbuffer[] = [];
    const fbo = gl.createFramebuffer();
    if (!fbo) return null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);

    const drawBuffers: number[] = [];
    for (let i = 0; i < renderTarget.textures.length; i++) {
        const tex = renderTarget.textures[i];
        const data = getGlTextureData(textures, tex._gpuTexture);
        if (!data) continue;
        const internalFormat = data.fmt.internalFormat;
        const maxSamples = gl.getInternalformatParameter(gl.RENDERBUFFER, internalFormat, gl.SAMPLES) as Int32Array | null;
        const supported = maxSamples && maxSamples.length > 0 ? maxSamples[0] : 0;
        if (!supported || supported < 2) {
            // This format can't be multisampled here — degrade the whole target.
            gl.deleteFramebuffer(fbo);
            for (const rb of colorRenderbuffers) gl.deleteRenderbuffer(rb);
            warnMsaaFallback(state);
            return null;
        }
        samples = Math.min(samples, supported);

        const rb = gl.createRenderbuffer();
        if (!rb) {
            gl.deleteFramebuffer(fbo);
            for (const r of colorRenderbuffers) gl.deleteRenderbuffer(r);
            warnMsaaFallback(state);
            return null;
        }
        state.renderbuffers.add(rb);
        gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, internalFormat, w, h);
        const attachment = gl.COLOR_ATTACHMENT0 + i;
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, attachment, gl.RENDERBUFFER, rb);
        colorRenderbuffers.push(rb);
        drawBuffers.push(attachment);
    }
    if (drawBuffers.length > 0) gl.drawBuffers(drawBuffers);

    // Multisample depth renderbuffer, matching the target's depth format.
    let depthRenderbuffer: WebGLRenderbuffer | null = null;
    if (renderTarget.depthTexture) {
        const depthData = getGlTextureData(textures, renderTarget.depthTexture._gpuTexture);
        if (depthData) {
            const rb = gl.createRenderbuffer();
            if (rb) {
                state.renderbuffers.add(rb);
                gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
                gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, depthData.fmt.internalFormat, w, h);
                const stencil = depthFormatHasStencil(renderTarget.depthTexture.format);
                const attachment = stencil ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_ATTACHMENT;
                gl.framebufferRenderbuffer(gl.FRAMEBUFFER, attachment, gl.RENDERBUFFER, rb);
                depthRenderbuffer = rb;
            }
        }
    }
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
        // Multisample FBO incomplete — degrade to single-sampled.
        gl.deleteFramebuffer(fbo);
        for (const rb of colorRenderbuffers) {
            gl.deleteRenderbuffer(rb);
            state.renderbuffers.delete(rb);
        }
        if (depthRenderbuffer) {
            gl.deleteRenderbuffer(depthRenderbuffer);
            state.renderbuffers.delete(depthRenderbuffer);
        }
        warnMsaaFallback(state);
        return null;
    }

    state.fbos.add(fbo);
    return { fbo, colorRenderbuffers, depthRenderbuffer, samples };
}

/** Log the MSAA-unsupported fallback once. */
function warnMsaaFallback(state: GlRenderTargetsState): void {
    if (state.msaaWarned) return;
    console.warn('[WebGLRenderer] MSAA render target sample count/format unsupported; rendering single-sampled.');
    state.msaaWarned = true;
}

/** Delete an MSAA FBO + its renderbuffers. */
function deleteMsaa(gl: WebGL2RenderingContext, state: GlRenderTargetsState, msaa: MsaaData): void {
    gl.deleteFramebuffer(msaa.fbo);
    state.fbos.delete(msaa.fbo);
    for (const rb of msaa.colorRenderbuffers) {
        gl.deleteRenderbuffer(rb);
        state.renderbuffers.delete(rb);
    }
    if (msaa.depthRenderbuffer) {
        gl.deleteRenderbuffer(msaa.depthRenderbuffer);
        state.renderbuffers.delete(msaa.depthRenderbuffer);
    }
}

/**
 * Resolve the pending MSAA target (if any) at pass end: blit each color attachment from the
 * multisample render FBO into the target's texture FBO (`blitFramebuffer(… COLOR_BUFFER_BIT,
 * NEAREST)`), so the sampleable texture carries the antialiased result. A no-op when the last-bound
 * target wasn't MSAA. Clears `pendingResolve`.
 */
export function resolveActiveRenderTarget(gl: WebGL2RenderingContext, state: GlRenderTargetsState): void {
    const rt = state.pendingResolve;
    state.pendingResolve = null;
    if (!rt) return;
    const fboData = state.data.get(rt);
    if (!fboData || !fboData.msaa) return;

    const w = fboData.width;
    const h = fboData.height;
    const count = fboData.msaa.colorRenderbuffers.length;

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fboData.msaa.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fboData.fbo);

    // Resolve each color attachment independently: a blit resolves READ_BUFFER → the draw FBO's
    // drawBuffers, so point both at attachment i in turn (MRT-safe; single-attachment is the common case).
    for (let i = 0; i < count; i++) {
        gl.readBuffer(gl.COLOR_ATTACHMENT0 + i);
        gl.drawBuffers(
            Array.from({ length: count }, (_, j) => (j === i ? gl.COLOR_ATTACHMENT0 + i : gl.NONE)),
        );
        gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }

    // Restore the texture FBO's full drawBuffers set + default read buffer.
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboData.fbo);
    gl.drawBuffers(Array.from({ length: count }, (_, i) => gl.COLOR_ATTACHMENT0 + i));
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

/** Delete all FBOs + depth renderbuffers (called on renderer dispose). */
export function disposeGlRenderTargets(gl: WebGL2RenderingContext, state: GlRenderTargetsState): void {
    for (const fbo of state.fbos) gl.deleteFramebuffer(fbo);
    for (const rb of state.renderbuffers) gl.deleteRenderbuffer(rb);
    state.fbos.clear();
    state.renderbuffers.clear();
}

/** Framebuffer + depth-renderbuffer counts for the render-target cache. */
export function getGlRenderTargetsStats(state: GlRenderTargetsState): { fboCount: number; renderbufferCount: number } {
    return { fboCount: state.fbos.size, renderbufferCount: state.renderbuffers.size };
}
