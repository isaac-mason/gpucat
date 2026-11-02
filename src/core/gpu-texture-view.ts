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
export class TextureViewRange {
    readonly baseMipLevel: number;
    readonly mipLevelCount: number | undefined;
    readonly baseArrayLayer: number;
    readonly arrayLayerCount: number | undefined;
    readonly dimension: GPUTextureViewDimension | undefined;
    readonly aspect: GPUTextureAspect;
    readonly key: string;
    /** how the range reads in a binding's name, e.g. `_mip3`; '' for the whole texture */
    readonly nameSuffix: string;

    constructor(init: TextureViewRangeInit) {
        this.baseMipLevel = init.baseMipLevel ?? 0;
        this.mipLevelCount = init.mipLevelCount;
        this.baseArrayLayer = init.baseArrayLayer ?? 0;
        this.arrayLayerCount = init.arrayLayerCount;
        this.dimension = init.dimension;
        this.aspect = init.aspect ?? 'all';
        const whole =
            this.baseMipLevel === 0 &&
            this.mipLevelCount === undefined &&
            this.baseArrayLayer === 0 &&
            this.arrayLayerCount === undefined &&
            this.dimension === undefined &&
            this.aspect === 'all';
        this.key = whole
            ? ''
            : `${this.baseMipLevel}+${this.mipLevelCount ?? '*'}:${this.baseArrayLayer}+${this.arrayLayerCount ?? '*'}:${this.dimension ?? ''}:${this.aspect}`;
        let suffix = '';
        if (this.baseMipLevel !== 0 || this.mipLevelCount !== undefined) {
            suffix += this.mipLevelCount === 1 ? `_mip${this.baseMipLevel}` : `_mips${this.baseMipLevel}`;
        }
        if (this.baseArrayLayer !== 0 || this.arrayLayerCount !== undefined) {
            suffix += this.arrayLayerCount === 1 ? `_layer${this.baseArrayLayer}` : `_layers${this.baseArrayLayer}`;
        }
        if (this.aspect !== 'all') suffix += this.aspect === 'depth-only' ? '_depth' : '_stencil';
        this.nameSuffix = suffix;
    }
}

/** The range covering the whole texture: a texture's default view. */
export const WHOLE_TEXTURE = /*@__PURE__*/ new TextureViewRange({});

/**
 * A view of a texture: the texture and the part of it a binding sees, as a `GPUTextureView` is. Made with
 * {@link GpuTexture.view}; a plain value, so views of the same range of one texture are the same binding whichever
 * object carries them. Make the views a frame needs once and keep them to make nothing per frame.
 */
export class GpuTextureView<D extends d.Texture = d.Texture> {
    readonly isGpuTextureView = true;
    readonly texture: GpuTexture<D>;
    readonly range: TextureViewRange;

    constructor(texture: GpuTexture<D>, range: TextureViewRange) {
        this.texture = texture;
        this.range = range;
    }
}

/** A texture or a view of one: what a texture binding binds. A texture means its default view, the whole of it. */
export type TextureSource<D extends d.Texture = d.Texture> = GpuTexture<D> | GpuTextureView<D>;

/** the texture and range `source` binds */
export function textureSourceParts<D extends d.Texture>(
    source: TextureSource<D>,
): { texture: GpuTexture<D>; range: TextureViewRange } {
    if ('isGpuTextureView' in source) return { texture: source.texture, range: source.range };
    return { texture: source, range: WHOLE_TEXTURE };
}
