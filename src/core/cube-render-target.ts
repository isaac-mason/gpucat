import { RenderTarget } from './render-target';
import { CubeTexture } from '../texture/cube-texture';
import type { DepthTextureFormat } from '../texture/depth-texture';

export type CubeRenderTargetOptions = {
    /** Color format of the cube faces. Default: 'rgba8unorm'. */
    colorFormat?: GPUTextureFormat;

    /** Wrap mode U. Default: 'clamp-to-edge'. */
    wrapS?: GPUAddressMode;

    /** Wrap mode V. Default: 'clamp-to-edge'. */
    wrapT?: GPUAddressMode;

    /** Magnification filter. Default: 'linear'. */
    magFilter?: GPUFilterMode;

    /** Minification filter. Default: 'linear'. */
    minFilter?: GPUFilterMode;

    /** Mipmap filter. Default: 'linear'. */
    mipmapFilter?: GPUMipmapFilterMode;

    /** Flip source images on upload. Default: false. */
    flipY?: boolean;

    /** Whether to allocate a depth attachment (reused across faces). Default: true. */
    depthBuffer?: boolean;

    /** Depth format. Default: 'depth24plus'. */
    depthFormat?: DepthTextureFormat;

    /** Generate mipmaps for the cube (for rough reflections). Default: false. */
    generateMipmaps?: boolean;
};

/**
 * A render target whose color attachment is a cube texture. Render each of the
 * six faces (set `activeFace` and call `renderer.render(scene, faceCamera)`),
 * then sample the result as an environment map via `cubeTexture(rt.texture)`.
 *
 * Usually driven by a `CubeCamera`, which sets up the six face cameras and loops
 * the faces for you.
 *
 * Extends `RenderTarget`: the inherited 2D color texture carries the face format
 * for pipeline creation, and the inherited 2D depth texture is reused across all
 * six faces. The renderer attaches the cube face selected by `activeFace`.
 */
export class CubeRenderTarget extends RenderTarget {
    readonly isCubeRenderTarget = true;

    /** Face size in pixels (width = height). */
    size: number;

    /** Which cube face the next `render()` targets: 0..5 = +X, -X, +Y, -Y, +Z, -Z. */
    activeFace = 0;

    /** Which mip level the next `render()` targets. */
    activeMipmapLevel = 0;

    /** The cube texture rendered into and sampled by materials. */
    readonly _texture: CubeTexture;

    constructor(size: number, opts: CubeRenderTargetOptions = {}) {
        const format = opts.colorFormat ?? 'rgba8unorm';
        super(size, size, {
            colorFormat: format,
            depthBuffer: opts.depthBuffer,
            depthFormat: opts.depthFormat,
            // Cube faces are sampled directly as an environment map; MSAA (which would
            // need a per-face resolve) is not supported.
            samples: 1,
        });
        this.size = size;
        this._texture = new CubeTexture([], {
            size,
            format,
            wrapS: opts.wrapS,
            wrapT: opts.wrapT,
            magFilter: opts.magFilter,
            minFilter: opts.minFilter,
            mipmapFilter: opts.mipmapFilter,
            flipY: opts.flipY,
            generateMipmaps: opts.generateMipmaps ?? false,
        });
        this._texture.name = 'output';
        this._texture._gpuTexture.renderTarget = this;
        this.textures[0] = this._texture;
    }

    override get texture(): CubeTexture {
        return this._texture;
    }

    /** Resize all six faces (and the shared depth). */
    setSize(size: number): void {
        if (this.size === size) return;
        super.setSize(size, size);
        this.size = size;
    }
}
