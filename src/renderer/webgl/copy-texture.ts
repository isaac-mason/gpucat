import type { GpuTexture } from '../../core/gpu-texture';
import type { TextureOrigin, TextureRegion } from '../../core/texture-region';
import { type TextureCache, updateTexture, withCopyFramebuffer } from './textures';

/**
 * `copyTexture` for WebGL2: the source level and layer attach to a read framebuffer, and
 * `copyTexSubImage` reads the box out of it into the destination. A 2D render-target texture is
 * rendered bottom-up while every other texture holds row 0 at the top, so between one of each the
 * rows go across one at a time, reversed.
 */
export function copyTextureRegion(
    gl: WebGL2RenderingContext,
    state: TextureCache,
    source: GpuTexture,
    region: TextureRegion,
    destination: GpuTexture,
    origin: TextureOrigin,
): void {
    const from = updateTexture(gl, state, source);
    const to = updateTexture(gl, state, destination);
    const fromHeight = Math.max(1, source.height >> region.level);
    const toHeight = Math.max(1, destination.height >> origin.level);
    const fromBottomUp = source.isRenderTargetTexture && from.target === gl.TEXTURE_2D;
    const toBottomUp = destination.isRenderTargetTexture && to.target === gl.TEXTURE_2D;
    /** the GL row a top-down row of `height` rows is stored at. */
    const glRow = (row: number, rows: number, height: number, bottomUp: boolean) => (bottomUp ? height - row - rows : row);

    withCopyFramebuffer(gl, state, () => {
        for (let layer = 0; layer < region.depth; layer++) {
            const fromZ = region.z + layer;
            if (from.target === gl.TEXTURE_2D_ARRAY || from.target === gl.TEXTURE_3D) {
                gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, from.texture, region.level, fromZ);
            } else {
                const face = from.target === gl.TEXTURE_CUBE_MAP ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + fromZ : gl.TEXTURE_2D;
                gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, face, from.texture, region.level);
            }
            if (gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
                throw new Error(
                    `[webgl] copyTexture: '${source.label ?? 'unlabelled'}' (${source.format}) can't be read as a ` +
                        'framebuffer on this device, which a copy reads it through.',
                );
            }
            const toZ = origin.z + layer;
            gl.bindTexture(to.target, to.texture);
            const copyRows = (fromRow: number, toRow: number, rows: number) => {
                if (to.target === gl.TEXTURE_2D_ARRAY || to.target === gl.TEXTURE_3D) {
                    gl.copyTexSubImage3D(to.target, origin.level, origin.x, toRow, toZ, region.x, fromRow, region.width, rows);
                } else {
                    const face = to.target === gl.TEXTURE_CUBE_MAP ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + toZ : gl.TEXTURE_2D;
                    gl.copyTexSubImage2D(face, origin.level, origin.x, toRow, region.x, fromRow, region.width, rows);
                }
            };
            if (fromBottomUp === toBottomUp) {
                copyRows(
                    glRow(region.y, region.height, fromHeight, fromBottomUp),
                    glRow(origin.y, region.height, toHeight, toBottomUp),
                    region.height,
                );
            } else {
                for (let row = 0; row < region.height; row++) {
                    copyRows(
                        glRow(region.y + row, 1, fromHeight, fromBottomUp),
                        glRow(origin.y + row, 1, toHeight, toBottomUp),
                        1,
                    );
                }
            }
        }
    });
}
