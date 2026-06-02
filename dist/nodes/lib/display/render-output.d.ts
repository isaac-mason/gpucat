import * as d from 'gpucat/dist/schema/schema';
import { type Node } from 'gpucat/dist/nodes/lib/core';
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
export declare function renderOutput(inputNode: Node<d.vec4f>, options?: RenderOutputOptions): Node<d.vec4f>;
