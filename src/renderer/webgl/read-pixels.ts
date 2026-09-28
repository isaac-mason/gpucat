/**
 * read-pixels.ts (webgl) - render-target pixel readback.
 *
 * The GL analogue of `webgpu/read-pixels.ts`. Binds a RenderTarget's texture FBO and reads its color
 * attachment back to a tightly-packed, top-to-bottom RGBA8 `Uint8Array`, the identical output contract
 * to the WebGPU `readPixels`, so an offline/headless bake gets the same bytes on either backend.
 *
 * The read goes into a pixel-pack buffer, which only queues the copy, and the bytes are fetched once a
 * fence says the GPU has written them, polled across event-loop ticks like `readBufferAsync`. A plain
 * `readPixels` into client memory would stall the thread until everything before it has drawn.
 *
 * GL `readPixels` returns rows bottom-to-top (GL's origin is lower-left), so the rows are flipped to
 * top-to-bottom to match the WebGPU convention. The public entry is the `WebGLBackend.readPixels`; this
 * is the free-function impl it delegates to.
 */

import type { CubeRenderTarget } from '../../core/cube-render-target';
import type { RenderTarget } from '../../core/render-target';
import { resolveActiveRenderTarget } from './render-target';
import { getTextureData } from './textures';
import { clientWaitAsync } from './transform-feedback';
import type { WebGLBackend } from './webgl-backend';

/**
 * Read a RenderTarget color attachment back to a tightly-packed, top-to-bottom RGBA8 `Uint8Array`
 * (length `width * height * 4`), matching the WebGPU `readPixels` output. The target's color format
 * must be `rgba8unorm` / `rgba8unorm-srgb` (WebGL2 has no BGRA render format). `attachmentIndex`
 * selects an MRT color attachment; `layer` selects a cube face (0..5). Throws if the target has not
 * been rendered to yet. The copy is queued before this returns, so the target can be drawn into again
 * at once; the promise settles when the bytes are back.
 */
export async function readPixels(
    gl: WebGL2RenderingContext,
    b: WebGLBackend,
    renderTarget: RenderTarget,
    attachmentIndex = 0,
    layer = 0,
    mipLevel = 0,
): Promise<Uint8Array> {
    const tex = renderTarget.textures[attachmentIndex];
    if (!tex) {
        throw new Error(`[readPixels] no color attachment at index ${attachmentIndex}.`);
    }
    const fmt = tex.format;
    if (fmt !== 'rgba8unorm' && fmt !== 'rgba8unorm-srgb') {
        throw new Error(
            `[readPixels] unsupported attachment format '${fmt}' at index ${attachmentIndex}; ` +
                `the WebGL2 backend reads back only rgba8unorm / rgba8unorm-srgb targets ` +
                `(render through an rgba8unorm RenderTarget first).`,
        );
    }

    const fboData = b.renderTargets.data.get(renderTarget);
    if (!fboData) {
        throw new Error('[readPixels] render target has not been rendered to yet; render() into it first.');
    }

    // MSAA target: resolve the multisample result into the texture FBO before reading it.
    if (b.renderTargets.pendingResolve === renderTarget) {
        resolveActiveRenderTarget(gl, b.renderTargets);
    }

    const width = Math.max(1, renderTarget.width >> mipLevel);
    const height = Math.max(1, renderTarget.height >> mipLevel);
    const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;

    if (renderTarget.isCubeRenderTarget === true) {
        // Cube target: point the read FBO's color attachment at the requested face.
        const cube = renderTarget as CubeRenderTarget;
        const data = getTextureData(b.textures, cube.texture._gpuTexture);
        if (!data) {
            throw new Error('[readPixels] cube render target has no GL texture; render() into it first.');
        }
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fboData.fbo);
        gl.framebufferTexture2D(
            gl.READ_FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_CUBE_MAP_POSITIVE_X + layer,
            data.texture,
            mipLevel,
        );
        fboData.attachedFace = layer;
        fboData.attachedMip = mipLevel;
    } else {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fboData.fbo);
    }

    gl.readBuffer(gl.COLOR_ATTACHMENT0 + attachmentIndex);

    const byteLength = width * height * 4;
    const pack = gl.createBuffer();
    if (!pack) throw new Error('[readPixels] gl.createBuffer returned null (pixel pack buffer).');
    const prevPack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) as WebGLBuffer | null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, byteLength, gl.STREAM_READ);
    // with a pack buffer bound, the last argument is a byte offset into it and the call only queues the copy.
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, prevPack);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);

    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) {
        gl.deleteBuffer(pack);
        throw new Error('[readPixels] gl.fenceSync returned null.');
    }
    gl.flush();
    const raw = new Uint8Array(byteLength);
    try {
        await clientWaitAsync(gl, sync, 'readPixels');
        const packBinding = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) as WebGLBuffer | null;
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, raw);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, packBinding);
    } finally {
        gl.deleteSync(sync);
        gl.deleteBuffer(pack);
    }

    // GL reads bottom-to-top; flip to top-to-bottom to match the WebGPU readPixels contract.
    const out = new Uint8Array(byteLength);
    const rowBytes = width * 4;
    for (let y = 0; y < height; y++) {
        const src = (height - 1 - y) * rowBytes;
        out.set(raw.subarray(src, src + rowBytes), y * rowBytes);
    }
    return out;
}
