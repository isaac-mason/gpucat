/**
 * render-target.ts (webgl) - FBO (framebuffer object) cache for render-to-texture.
 *
 * The GL analogue of the WebGPU render-target attachment path. When `renderer.renderTarget` is
 * non-null (a `PassNode` render-to-texture, a `CubeCamera` face, etc.), the pass must render into
 * the target's color texture(s) + depth instead of the default framebuffer. This module ports the
 * reference renderer's `setRenderTarget`: get/create one FBO per `RenderTarget`, allocate each color
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
import type { RenderTarget } from '../../core/render-target';
import { type GlTexturesState } from './textures';
/** Per-RenderTarget GL framebuffer + the color-texture generations it was built against. */
type FboData = {
    /** The GL framebuffer object (the resolve/texture FBO — its color attachments are the target's textures). */
    fbo: WebGLFramebuffer;
    /**
     * Depth renderbuffer slot for the single-sampled FBO. In practice always null: depth is a
     * sampleable depth texture when the target has one, else (depthBuffer:false) there is no depth.
     * Kept so a carried-over renderbuffer from an earlier build is freed on rebuild.
     */
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
export declare function createGlRenderTargetsState(): GlRenderTargetsState;
/**
 * Get (or create/rebuild) and bind the FBO for a render target, then return whether it carries a
 * stencil aspect (so the pass knows whether to clear stencil). Allocates the color + depth textures,
 * attaches them, sets `drawBuffers` for MRT, and leaves the FBO bound as `FRAMEBUFFER`.
 *
 * For an MSAA target the bound FBO is the multisample render FBO (drawn into); its result is resolved
 * into the texture FBO at pass end by `resolveActiveRenderTarget`. For a cube target the selected
 * `activeFace` is attached as the color attachment (re-attached cheaply when the face changes).
 */
export declare function bindRenderTargetFramebuffer(gl: WebGL2RenderingContext, state: GlRenderTargetsState, textures: GlTexturesState, renderTarget: RenderTarget): {
    hasStencil: boolean;
};
/**
 * Resolve the pending MSAA target (if any) at pass end: blit each color attachment from the
 * multisample render FBO into the target's texture FBO (`blitFramebuffer(… COLOR_BUFFER_BIT,
 * NEAREST)`), so the sampleable texture carries the antialiased result. A no-op when the last-bound
 * target wasn't MSAA. Clears `pendingResolve`.
 */
export declare function resolveActiveRenderTarget(gl: WebGL2RenderingContext, state: GlRenderTargetsState): void;
/** Delete all FBOs + depth renderbuffers (called on renderer dispose). */
export declare function disposeGlRenderTargets(gl: WebGL2RenderingContext, state: GlRenderTargetsState): void;
/** Framebuffer + depth-renderbuffer counts for the render-target cache. */
export declare function getGlRenderTargetsStats(state: GlRenderTargetsState): {
    fboCount: number;
    renderbufferCount: number;
};
export {};
