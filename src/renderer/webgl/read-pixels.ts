/**
 * read-pixels.ts (webgl) - render-target pixel readback.
 *
 * The GL analogue of `webgpu/read-pixels.ts`. Binds a RenderTarget's texture FBO and reads its color
 * attachment back to a tightly-packed, top-to-bottom RGBA8 `Uint8Array`, the identical output contract
 * to the WebGPU `readPixels`, so an offline/headless bake gets the same bytes on either backend.
 *
 * GL `readPixels` returns rows bottom-to-top (GL's origin is lower-left), so the rows are flipped to
 * top-to-bottom to match the WebGPU convention. The public entry is the
 * `WebGLRenderer.readRenderTargetPixels` method; this is the free-function impl it delegates to
 * (mirroring `readBufferAsync`).
 */

import type { CubeRenderTarget } from '../../core/cube-render-target';
import type { RenderTarget } from '../../core/render-target';
import { resolveActiveRenderTarget, type GlRenderTargetsState } from './render-target';
import { getGlTextureData, type GlTexturesState } from './textures';

/**
 * Read a RenderTarget color attachment back to a tightly-packed, top-to-bottom RGBA8 `Uint8Array`
 * (length `width * height * 4`), matching the WebGPU `readPixels` output. The target's color format
 * must be `rgba8unorm` / `rgba8unorm-srgb` (WebGL2 has no BGRA render format). `attachmentIndex`
 * selects an MRT color attachment; `layer` selects a cube face (0..5). Throws if the target has not
 * been rendered to yet.
 */
export function readRenderTargetPixels(
    gl: WebGL2RenderingContext,
    state: GlRenderTargetsState,
    textures: GlTexturesState,
    renderTarget: RenderTarget,
    attachmentIndex = 0,
    layer = 0,
): Uint8Array {
    const tex = renderTarget.textures[attachmentIndex];
    if (!tex) {
        throw new Error(`[readRenderTargetPixels] no color attachment at index ${attachmentIndex}.`);
    }
    const fmt = tex.format;
    if (fmt !== 'rgba8unorm' && fmt !== 'rgba8unorm-srgb') {
        throw new Error(
            `[readRenderTargetPixels] unsupported attachment format '${fmt}' at index ${attachmentIndex}; ` +
                `the WebGL2 backend reads back only rgba8unorm / rgba8unorm-srgb targets ` +
                `(render through an rgba8unorm RenderTarget first).`,
        );
    }

    const fboData = state.data.get(renderTarget);
    if (!fboData) {
        throw new Error('[readRenderTargetPixels] render target has not been rendered to yet; render() into it first.');
    }

    // MSAA target: resolve the multisample result into the texture FBO before reading it.
    if (state.pendingResolve === renderTarget) {
        resolveActiveRenderTarget(gl, state);
    }

    const { width, height } = renderTarget;
    const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;

    if (renderTarget.isCubeRenderTarget === true) {
        // Cube target: point the read FBO's color attachment at the requested face.
        const cube = renderTarget as CubeRenderTarget;
        const data = getGlTextureData(textures, cube.texture._gpuTexture);
        if (!data) {
            throw new Error('[readRenderTargetPixels] cube render target has no GL texture; render() into it first.');
        }
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fboData.fbo);
        gl.framebufferTexture2D(
            gl.READ_FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_CUBE_MAP_POSITIVE_X + layer,
            data.texture,
            cube.activeMipmapLevel,
        );
        fboData.attachedFace = layer;
    } else {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fboData.fbo);
    }

    gl.readBuffer(gl.COLOR_ATTACHMENT0 + attachmentIndex);

    const raw = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);

    // GL reads bottom-to-top; flip to top-to-bottom to match the WebGPU readPixels contract.
    const out = new Uint8Array(width * height * 4);
    const rowBytes = width * 4;
    for (let y = 0; y < height; y++) {
        const src = (height - 1 - y) * rowBytes;
        out.set(raw.subarray(src, src + rowBytes), y * rowBytes);
    }

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
    return out;
}
