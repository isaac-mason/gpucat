import { wgsl } from '../wgsl';
import { ConstNode, type Node } from '../core';
import * as d from '../../schema';

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
     * gamma curve (approximately pow(c, 1/2.2)).  'linear' skips it.
     * @default 'srgb'
     */
    colorSpace?: OutputColorSpace;

    /**
     * Scene exposure multiplier, applied before tone mapping.
     * Pass a UniformNode<d.F32Desc> to animate it.
     * @default konst(1.0)
     */
    exposure?: Node<d.f32>;
};

/**
 * Wrap `inputNode` in tone-mapping and color-space conversion.
 *
 * Returns a `Node<d.Vec4fDesc>` that can be used directly as
 * `renderer.render(renderOutput(scenePass.getTextureNode()))`.
 */
export function renderOutput(
    inputNode: Node<d.vec4f>,
    options: RenderOutputOptions = {},
): Node<d.vec4f> {
    const toneMapping = options.toneMapping ?? 'aces';
    const colorSpace  = options.colorSpace  ?? 'srgb';
    const exposure    = options.exposure    ?? new ConstNode(d.f32, 1.0);

    // Build the chain: input → exposure → tone map → gamma
    // Each step is a RawNode that substitutes $0 = previous step.

    // Step 1: apply exposure to RGB, preserve alpha.
    const exposed = wgsl(d.vec4f)`vec4f((${ inputNode }).rgb * ${ exposure }, (${ inputNode }).a)`;

    // Step 2: tone mapping (operates on vec3f RGB only).
    const tonemapped = applyToneMapping(exposed, toneMapping);

    // Step 3: gamma / color space conversion.
    if (colorSpace === 'srgb') {
        return linearToSrgb(tonemapped);
    } else {
        return tonemapped;
    }
}

function applyToneMapping(node: Node<d.vec4f>, mode: ToneMappingMode): Node<d.vec4f> {
    switch (mode) {
        case 'aces':     return acesToneMapping(node);
        case 'reinhard': return reinhardToneMapping(node);
        case 'linear':   return node; // exposure already applied — nothing more
        case 'none':     return node;
    }
}

/**
 * ACES filmic tone mapping.
 * Source: https://knarkowicz.wordpress.com/2016/01/06/aces-filmic-tone-mapping-curve/
 *
 * f(x) = clamp( (x*(2.51x + 0.03)) / (x*(2.43x + 0.59) + 0.14), 0, 1 )
 *
 * Applied per-channel to RGB, alpha passed through.
 * $0 = input vec4f
 *
 * Rewritten as a single expression to avoid WGSL IIFE (not supported).
 * We inline c = ($0).rgb and compute the result directly.
 */
function acesToneMapping(node: Node<d.vec4f>): Node<d.vec4f> {
    return wgsl(d.vec4f)`vec4f(clamp(((${ node }).rgb * (2.51 * (${ node }).rgb + vec3f(0.03))) / ((${ node }).rgb * (2.43 * (${ node }).rgb + vec3f(0.59)) + vec3f(0.14)), vec3f(0.0), vec3f(1.0)), (${ node }).a)`;
}

/**
 * Reinhard tone mapping.
 * f(x) = x / (1 + x)  applied per-channel.
 * $0 = input vec4f
 *
 * Rewritten as a single expression to avoid WGSL IIFE (not supported).
 */
function reinhardToneMapping(node: Node<d.vec4f>): Node<d.vec4f> {
    return wgsl(d.vec4f)`vec4f((${ node }).rgb / (vec3f(1.0) + (${ node }).rgb), (${ node }).a)`;
}

/**
 * Linear → sRGB conversion.
 * Uses the piecewise sRGB transfer function (exact IEC 61966-2-1):
 *   c <= 0.0031308  →  12.92 * c
 *   c >  0.0031308  →  1.055 * pow(c, 1/2.4) - 0.055
 *
 * Applied per-channel to RGB, alpha passed through.
 * $0 = input vec4f
 *
 * Rewritten as a single expression to avoid WGSL IIFE (not supported).
 * The select() picks between lo and hi based on the threshold.
 */
function linearToSrgb(node: Node<d.vec4f>): Node<d.vec4f> {
    return wgsl(d.vec4f)`vec4f(select(pow(clamp((${ node }).rgb, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.4)) * 1.055 - vec3f(0.055), (${ node }).rgb * 12.92, (${ node }).rgb <= vec3f(0.0031308)), (${ node }).a)`;
}
