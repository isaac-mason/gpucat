/**
 * render-target.ts (webgl) - FBO (framebuffer object) cache for render-to-texture.
 *
 * The GL analogue of the WebGPU render-target attachment path. When a pass names a `RenderTarget`
 * (a `RenderTextureNode` render-to-texture, a `CubeCamera` face, etc.), it renders into that target's color
 * texture(s) + depth instead of the default framebuffer. One FBO per `RenderTarget`: allocate each color
 * `GpuTexture` at the target size/format (via `textures.ts`), attach it as
 * `COLOR_ATTACHMENT0 + i`, call `drawBuffers([...])` for MRT, and attach depth. Depth is always a
 * sampleable depth *texture*: `RenderTarget` auto-creates a `depthTexture` unless `depthBuffer:false`,
 * so a non-MSAA target either has a depth-texture attachment or (depthBuffer:false) intentionally no
 * depth at all — there is no depth-renderbuffer path for the single-sampled FBO. (MSAA targets carry
 * their own separate multisample depth renderbuffer on the render-side FBO; see `buildMsaaFbo`.) The
 * rendered color textures then become sampleable GL textures in a later pass — proving the round-trip.
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

import type { CubeRenderTarget } from '../../core/cube-render-target';
import type { RenderTarget } from '../../core/render-target';
import { formatHasStencil } from '../core/render-types';
import { getTextureData, type TextureCache, updateTexture } from './textures';
import type { WebGLBackend } from './webgl-backend';

/** Per-RenderTarget GL framebuffer + the color-texture generations it was built against. */
type FboData = {
    /** The GL framebuffer object (the resolve/texture FBO — its color attachments are the target's textures). */
    fbo: WebGLFramebuffer;
    /**
     * Depth renderbuffer for the single-sampled FBO. Non-null when the target has depth that isn't
     * sampled (`depthSampled === false`): a renderbuffer is leaner than a sampleable depth texture and
     * more broadly FBO-complete (three.js parity). Null when depth is a sampled texture, or no depth.
     */
    depthRenderbuffer: WebGLRenderbuffer | null;
    /** Whether the depth was built as a sampled texture (vs a renderbuffer); a change forces a rebuild. */
    depthSampled: boolean;
    /** Color-attachment texture generations at last (re)build — a change forces a rebuild. */
    colorGenerations: number[];
    /** Depth-attachment texture generation at last rebuild (or -1 for renderbuffer/none). */
    depthGeneration: number;
    /** Last-built size (width, height) — a resize forces a renderbuffer reallocation. */
    width: number;
    height: number;
    /** For a cube target: which face the color attachment currently points at (-1 = not a cube / unset). */
    attachedFace: number;
    attachedMip: number;
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
/** Sized GL internal format for a depth (/stencil) renderbuffer of the given depth-texture format. */
function depthRenderbufferInternalFormat(gl: WebGL2RenderingContext, format: GPUTextureFormat | undefined): number {
    switch (format) {
        case 'depth16unorm':
            return gl.DEPTH_COMPONENT16;
        case 'depth32float':
            return gl.DEPTH_COMPONENT32F;
        case 'depth24plus-stencil8':
            return gl.DEPTH24_STENCIL8;
        case 'depth32float-stencil8':
            return gl.DEPTH32F_STENCIL8;
        // A target with no depth attachment asks for none; `depth24plus` is the one that maps here.
        case undefined:
        case 'depth24plus':
            return gl.DEPTH_COMPONENT24;
        default:
            throw new Error(
                `[webgl] '${format}' is not a depth format; a renderbuffer allocated as depth24 would ` +
                    'silently drop its stencil aspect.',
            );
    }
}

/**
 * A float/half-float color attachment is only framebuffer-renderable in WebGL2 with the matching
 * extension (`EXT_color_buffer_float` for 32-bit and 16-bit float; `EXT_color_buffer_half_float` for
 * the half-float-only fallback). context.ts requests these on init; when neither is present for a
 * float color target the FBO would be incomplete, so throw a clear error naming the requirement.
 */
function ensureColorRenderable(gl: WebGL2RenderingContext, format: string): void {
    const is16f = format.includes('16float');
    const is32f = format.includes('32float');
    if (!is16f && !is32f) return;

    // EXT_color_buffer_float makes both 16F and 32F renderable; the half-float ext covers 16F only.
    const hasFloat = !!gl.getExtension('EXT_color_buffer_float');
    const hasHalfFloat = !!gl.getExtension('EXT_color_buffer_half_float');
    if (hasFloat) return;
    if (is16f && hasHalfFloat) return;

    const ext = is32f ? 'EXT_color_buffer_float' : 'EXT_color_buffer_float / EXT_color_buffer_half_float';
    throw new Error(
        `[webgl] float render target format '${format}' requires ${ext}, which is not available; ` +
            `float-renderable render targets are not supported on the WebGL2 backend without it.`,
    );
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
    b: WebGLBackend,
    renderTarget: RenderTarget,
    layer: number,
    mipLevel: number,
): { hasStencil: boolean } {
    // Ensure each color texture's GL storage exists at the current size/format.
    const colorGenerations: number[] = [];
    for (const tex of renderTarget.textures) {
        const data = updateTexture(gl, b.textures, tex._gpuTexture);
        colorGenerations.push(data.generation);
    }

    // Ensure the depth texture's GL storage exists ONLY when depth is sampled (attached as a texture).
    // Unsampled depth uses a renderbuffer (allocated in rebuildFbo), so skip the depth texture entirely;
    // leaner on the weaker devices the WebGL fallback runs on.
    let depthGeneration = -1;
    if (renderTarget._depthAttachment && renderTarget.depthSampled) {
        const data = updateTexture(gl, b.textures, renderTarget._depthAttachment._gpuTexture);
        depthGeneration = data.generation;
    }

    let fboData = b.renderTargets.data.get(renderTarget);
    const sizeChanged = fboData ? fboData.width !== renderTarget.width || fboData.height !== renderTarget.height : true;
    const depthModeChanged = fboData ? fboData.depthSampled !== renderTarget.depthSampled : false;
    const generationsChanged =
        fboData &&
        (fboData.depthGeneration !== depthGeneration ||
            fboData.colorGenerations.length !== colorGenerations.length ||
            fboData.colorGenerations.some((g, i) => g !== colorGenerations[i]));

    if (!fboData || sizeChanged || depthModeChanged || generationsChanged) {
        fboData = rebuildFbo(gl, b.renderTargets, b.textures, renderTarget, fboData, colorGenerations, depthGeneration);
    }

    // A level change needs the same re-attach as a face change: the level is baked into the attachment.
    if (isCube(renderTarget) && (fboData.attachedFace !== layer || fboData.attachedMip !== mipLevel)) {
        attachCubeFace(gl, b.textures, renderTarget, fboData, layer, mipLevel);
    }

    const hasStencil = formatHasStencil(renderTarget._depthAttachment?.format);

    // MSAA: render into the multisample FBO; remember the target so pass end resolves it.
    if (fboData.msaa) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboData.msaa.fbo);
        b.renderTargets.pendingResolve = renderTarget;
    } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboData.fbo);
        b.renderTargets.pendingResolve = null;
    }

    return { hasStencil };
}

/** Attach one face at one level as the FBO's `COLOR_ATTACHMENT0`. */
function attachCubeFace(
    gl: WebGL2RenderingContext,
    textures: TextureCache,
    renderTarget: CubeRenderTarget,
    fboData: FboData,
    layer: number,
    mipLevel: number,
): void {
    const data = getTextureData(textures, renderTarget.texture._gpuTexture);
    if (!data) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboData.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + layer, data.texture, mipLevel);
    fboData.attachedFace = layer;
    fboData.attachedMip = mipLevel;
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(
            `[webgl] cube framebuffer is incomplete (face ${layer} level ${mipLevel}, status 0x${status.toString(16)}); ` +
                `rendering into an incomplete framebuffer is not supported on the WebGL2 backend.`,
        );
    }
}

/** (Re)build the FBO for a render target: attach color textures, drawBuffers, and depth. */
function rebuildFbo(
    gl: WebGL2RenderingContext,
    state: GlRenderTargetsState,
    textures: TextureCache,
    renderTarget: RenderTarget,
    existing: FboData | undefined,
    colorGenerations: number[],
    depthGeneration: number,
): FboData {
    // Reuse the existing FBO handle (and its depth renderbuffer) where possible.
    let fbo = existing?.fbo;
    if (!fbo) {
        const created = gl.createFramebuffer();
        if (!created) throw new Error('[webgl] gl.createFramebuffer returned null.');
        fbo = created;
        state.fbos.add(fbo);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);

    const cube = isCube(renderTarget);

    // Color attachments.
    const drawBuffers: number[] = [];
    renderTarget.textures.forEach((tex, i) => {
        const data = getTextureData(textures, tex._gpuTexture);
        if (!data) return;
        ensureColorRenderable(gl, tex.format);
        const attachment = gl.COLOR_ATTACHMENT0 + i;
        // A cube's colour attachment is `attachCubeFace`'s, and the sentinels below make it run.
        if (!cube) gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment, gl.TEXTURE_2D, data.texture, 0);
        drawBuffers.push(attachment);
    });
    if (drawBuffers.length > 0) {
        gl.drawBuffers(drawBuffers);
    } else {
        // Depth-only target: no color output.
        gl.drawBuffers([gl.NONE]);
    }

    // Depth attachment (shared across cube faces). A sampled depth is attached as a texture; an
    // unsampled depth uses a renderbuffer (leaner and more broadly FBO-complete, three.js parity); no
    // depthTexture at all means the caller opted out (depthBuffer:false).
    let depthRenderbuffer = existing?.depthRenderbuffer ?? null;
    const freeDepthRenderbuffer = () => {
        if (depthRenderbuffer) {
            gl.deleteRenderbuffer(depthRenderbuffer);
            state.renderbuffers.delete(depthRenderbuffer);
            depthRenderbuffer = null;
        }
    };
    if (renderTarget._depthAttachment && renderTarget.depthSampled) {
        // Sampleable depth texture (e.g. shadow maps, depth-of-field, scene-depth occlusion).
        freeDepthRenderbuffer();
        const data = getTextureData(textures, renderTarget._depthAttachment._gpuTexture);
        if (data) {
            const stencil = formatHasStencil(renderTarget._depthAttachment.format);
            const attachment = stencil ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_ATTACHMENT;
            gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment, gl.TEXTURE_2D, data.texture, 0);
        }
    } else if (renderTarget._depthAttachment) {
        // Unsampled depth uses a renderbuffer (reused across rebuilds; re-specified at the current size).
        const stencil = formatHasStencil(renderTarget._depthAttachment.format);
        const internalFormat = depthRenderbufferInternalFormat(gl, renderTarget._depthAttachment.format);
        if (!depthRenderbuffer) {
            const created = gl.createRenderbuffer();
            if (!created) throw new Error('[webgl] gl.createRenderbuffer returned null (depth).');
            depthRenderbuffer = created;
            state.renderbuffers.add(depthRenderbuffer);
        }
        gl.bindRenderbuffer(gl.RENDERBUFFER, depthRenderbuffer);
        gl.renderbufferStorage(gl.RENDERBUFFER, internalFormat, renderTarget.width, renderTarget.height);
        const attachment = stencil ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_ATTACHMENT;
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, attachment, gl.RENDERBUFFER, depthRenderbuffer);
    } else {
        // depthBuffer:false means no depth. Free any renderbuffer carried over from a previous build.
        freeDepthRenderbuffer();
    }

    // Validate. A lost context makes every GL query return null/default and reports the framebuffer
    // as UNSUPPORTED (0x8cdd), so check for loss FIRST, or a dead context masquerades as a format bug.
    if (gl.isContextLost()) {
        throw new Error(
            '[webgl] WebGL2 context is lost; cannot build a framebuffer. This is usually too many ' +
                'live WebGL contexts on the page (each canvas/renderer holds one; the browser evicts the oldest) ' +
                'or a GPU-process crash, not a render-target format problem. See the `webglcontextlost` reason.',
        );
    }
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
        // Enumerate each attachment's logical (RenderTarget) size vs actual GL-allocated size + format,
        // so the culprit is visible (WebGL2 allows mixed-size color attachments, so 0x8CD6 usually means
        // an attachment has no/stale storage — an allocW×allocH that lags the logical size, or 0×0).
        const describe = (
            label: string,
            tex: { _gpuTexture: Parameters<typeof getTextureData>[1]; format: string } | null | undefined,
        ) => {
            if (!tex) return `${label}: (none)`;
            const d = getTextureData(textures, tex._gpuTexture);
            const gl_ = d ? `${d.allocW}x${d.allocH} allocated=${d.allocated}` : 'no GL texture';
            return `${label}: format=${tex.format} logical=${tex._gpuTexture.width}x${tex._gpuTexture.height} gl=${gl_}`;
        };
        // Diagnostics: the GL renderer string (reveals a software/blocklisted context) + any accumulated
        // GL error + the depth attachment mode + a LIVE dump of what the FBO actually holds (asks GL,
        // not our bookkeeping; this is authoritative when our view of the attachments disagrees).
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        const rendererStr = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        const glErr = gl.getError();
        const depthMode = !renderTarget._depthAttachment ? 'none' : renderTarget.depthSampled ? 'texture' : 'renderbuffer';
        const TYPE_NAME: Record<number, string> = { [gl.NONE]: 'none', [gl.TEXTURE]: 'tex', [gl.RENDERBUFFER]: 'rbo' };
        const liveAttachment = (label: string, point: number): string => {
            const type = gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, point, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE);
            if (type === gl.NONE) return `${label}=none`;
            const sz = (p: number) => gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, point, p);
            const bits = `r${sz(gl.FRAMEBUFFER_ATTACHMENT_RED_SIZE)}g${sz(gl.FRAMEBUFFER_ATTACHMENT_GREEN_SIZE)}b${sz(gl.FRAMEBUFFER_ATTACHMENT_BLUE_SIZE)}a${sz(gl.FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE)}d${sz(gl.FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE)}s${sz(gl.FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE)}`;
            gl.getError(); // some size queries are invalid per attachment type; clear the flag
            return `${label}=${TYPE_NAME[type as number] ?? type}(${bits})`;
        };
        const parts = [
            `target=${renderTarget.width}x${renderTarget.height}`,
            ...renderTarget.textures.map((t, i) => describe(`color[${i}]`, t)),
            `depth[${depthMode}]: ${describe('', renderTarget._depthAttachment)}`,
            `renderer=${rendererStr}`,
            `glError=0x${glErr.toString(16)}`,
            `LIVE ${liveAttachment('color0', gl.COLOR_ATTACHMENT0)} ${liveAttachment('depth', gl.DEPTH_ATTACHMENT)} ${liveAttachment('stencil', gl.STENCIL_ATTACHMENT)} ${liveAttachment('depthStencil', gl.DEPTH_STENCIL_ATTACHMENT)}`,
        ];
        throw new Error(
            `[webgl] framebuffer is incomplete (status 0x${status.toString(16)}); ` +
                `rendering into an incomplete framebuffer is not supported on the WebGL2 backend. ` +
                `${parts.join(' | ')}`,
        );
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
        depthSampled: renderTarget.depthSampled,
        colorGenerations,
        depthGeneration,
        width: renderTarget.width,
        height: renderTarget.height,
        attachedFace: -1,
        attachedMip: -1,
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
    textures: TextureCache,
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
        const data = getTextureData(textures, tex._gpuTexture);
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
    if (renderTarget._depthAttachment) {
        const depthData = getTextureData(textures, renderTarget._depthAttachment._gpuTexture);
        if (depthData) {
            const rb = gl.createRenderbuffer();
            if (rb) {
                state.renderbuffers.add(rb);
                gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
                gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, depthData.fmt.internalFormat, w, h);
                const stencil = formatHasStencil(renderTarget._depthAttachment.format);
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
    console.warn('[webgl] MSAA render target sample count/format unsupported; rendering single-sampled.');
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

    // blitFramebuffer is subject to the scissor test (the only fragment op besides pixel-ownership
    // that affects a blit, per GLES3). The draw loop leaves SCISSOR_TEST enabled for a partial-viewport
    // pass (e.g. a studio grid cell), which would clip the resolve to the scissor rect and leave the
    // rest of the texture holding unresolved garbage. Disable it for the resolve; the next pass sets
    // its own scissor state via applyViewportScissor.
    gl.disable(gl.SCISSOR_TEST);

    // Resolve each color attachment independently: a blit resolves READ_BUFFER → the draw FBO's
    // drawBuffers, so point both at attachment i in turn (MRT-safe; single-attachment is the common case).
    for (let i = 0; i < count; i++) {
        gl.readBuffer(gl.COLOR_ATTACHMENT0 + i);
        gl.drawBuffers(Array.from({ length: count }, (_, j) => (j === i ? gl.COLOR_ATTACHMENT0 + i : gl.NONE)));
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
