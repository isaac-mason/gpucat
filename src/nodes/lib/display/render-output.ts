import { f32, vec4f, type Node } from '../core';
import * as d from '../../schema';
import {
    acesToneMapping as acesToneMappingFn,
    reinhardToneMapping as reinhardToneMappingFn,
    sRGBTransferOETF,
} from './color';

export type ToneMappingMode = 'aces' | 'reinhard' | 'linear' | 'none';
export type OutputColorSpace = 'srgb' | 'linear';

export type RenderOutputOptions = {
    /**
     * Tone mapping operator to apply.
     * @default 'aces'
     */
    toneMapping?: ToneMappingMode;

    /**
     * Output color space.  'srgb' applies the standard linear→sRGB
     * transfer function (IEC 61966-2-1).  'linear' skips it.
     * @default 'srgb'
     */
    colorSpace?: OutputColorSpace;

    /**
     * Scene exposure multiplier, applied before tone mapping.
     * Pass a UniformNode<d.f32> to animate it.
     * @default f32(1.0)
     */
    exposure?: Node<d.f32>;
};

/**
 * Wrap `inputNode` in tone-mapping and color-space conversion.
 *
 * Returns a `Node<d.vec4f>` suitable for final output:
 * `renderer.render(renderOutput(scenePass.getTextureNode()))`.
 */
export function renderOutput(
    inputNode: Node<d.vec4f>,
    options: RenderOutputOptions = {},
): Node<d.vec4f> {
    const toneMapping = options.toneMapping ?? 'aces';
    const colorSpace  = options.colorSpace  ?? 'srgb';
    const exposure    = options.exposure    ?? f32(1.0);

    const input = inputNode.toConst('input');
    const rgb   = (input.xyz as Node<d.vec3f>).mul(exposure);
    const alpha = input.w;

    const tonemapped = applyToneMapping(rgb, toneMapping);

    const finalRgb = colorSpace === 'srgb' ? sRGBTransferOETF(tonemapped) : tonemapped;

    return vec4f(finalRgb, alpha);
}

function applyToneMapping(rgb: Node<d.vec3f>, mode: ToneMappingMode): Node<d.vec3f> {
    switch (mode) {
        case 'aces':     return acesToneMappingFn(rgb);
        case 'reinhard': return reinhardToneMappingFn(rgb);
        case 'linear':   return rgb;
        case 'none':     return rgb;
    }
}
