import type * as d from '../schema/schema';
import type { GpuTexture } from './gpu-texture';
/**
 * Which part of a texture a view covers, as `GPUTextureViewDescriptor` says it. An omitted count covers the rest of the
 * texture from the base, and an omitted dimension is the one the binding declares.
 */
export type TextureViewRangeInit = {
    baseMipLevel?: number;
    mipLevelCount?: number;
    baseArrayLayer?: number;
    arrayLayerCount?: number;
    dimension?: GPUTextureViewDimension;
    aspect?: GPUTextureAspect;
};
/**
 * A view's range, normalised. `key` names it: two ranges with the same key are the same range, and the whole texture's
 * key is ''. Counts stay unresolved, so a range covering "the rest" still does after the texture is resized.
 */
export declare class TextureViewRange {
    readonly baseMipLevel: number;
    readonly mipLevelCount: number | undefined;
    readonly baseArrayLayer: number;
    readonly arrayLayerCount: number | undefined;
    readonly dimension: GPUTextureViewDimension | undefined;
    readonly aspect: GPUTextureAspect;
    readonly key: string;
    /** how the range reads in a binding's name, e.g. `_mip3`; '' for the whole texture */
    readonly nameSuffix: string;
    constructor(init: TextureViewRangeInit);
}
/** The range covering the whole texture: a texture's default view. */
export declare const WHOLE_TEXTURE: TextureViewRange;
/**
 * A view of a texture: the texture and the part of it a binding sees, as a `GPUTextureView` is. Made with
 * {@link GpuTexture.view}; a plain value, so views of the same range of one texture are the same binding whichever
 * object carries them. Make the views a frame needs once and keep them to make nothing per frame.
 */
export declare class GpuTextureView<D extends d.Texture = d.Texture> {
    readonly isGpuTextureView = true;
    readonly texture: GpuTexture<D>;
    readonly range: TextureViewRange;
    constructor(texture: GpuTexture<D>, range: TextureViewRange);
}
/** A texture or a view of one: what a texture binding binds. A texture means its default view, the whole of it. */
export type TextureSource<D extends d.Texture = d.Texture> = GpuTexture<D> | GpuTextureView<D>;
/** the texture and range `source` binds */
export declare function textureSourceParts<D extends d.Texture>(source: TextureSource<D>): {
    texture: GpuTexture<D>;
    range: TextureViewRange;
};
