/**
 * render-output.ts — renderOutput(): tone mapping + linear→sRGB conversion.
 *
 * This is a pure shader-level node — no render targets, no GPU passes, just
 * WGSL math inlined into the fragment shader.  It mirrors three's
 * RenderOutputNode.
 *
 * Usage
 * -----
 *
 *   // Default: ACES filmic tone mapping + automatic linear→sRGB conversion.
 *   const output = renderOutput(scenePass.getTextureNode());
 *   renderer.render(output);
 *
 *   // FXAA requires sRGB input, so place renderOutput() BEFORE fxaa():
 *   renderPipeline.outputColorTransform = false;          // three.js equivalent
 *   const tonemapped  = renderOutput(scenePass.getTextureNode());
 *   const antialiased = fxaa(tonemapped);
 *   renderer.render(antialiased);
 *
 *   // Disable tone mapping, keep gamma correction only:
 *   renderOutput(node, { toneMapping: 'none' });
 *
 *   // Disable everything (pass linear HDR straight to canvas):
 *   renderOutput(node, { toneMapping: 'none', colorSpace: 'linear' });
 *
 * Tone mapping operators
 * ----------------------
 *   'aces'     — ACES filmic (default, cinematic look)
 *   'reinhard' — classic Reinhard
 *   'linear'   — no tone mapping, just exposure scaling
 *   'none'     — identity (no tone mapping, no exposure)
 *
 * Color space
 * -----------
 *   'srgb'   — apply linear→sRGB gamma conversion (default)
 *   'linear' — no conversion (output stays in linear light)
 *
 * Implementation note
 * -------------------
 * The exposure uniform defaults to 1.0.  Pass a UniformNode<'f32'> (or just
 * konst(value)) to `exposure` to drive it from JavaScript.
 */

import { RawNode, type Node, konst } from './nodes';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
     * Pass a UniformNode<'f32'> to animate it.
     * @default konst(1.0)
     */
    exposure?: Node<'f32'>;
};

// ---------------------------------------------------------------------------
// renderOutput()
// ---------------------------------------------------------------------------

/**
 * Wrap `inputNode` in tone-mapping and color-space conversion.
 *
 * Returns a `Node<'vec4f'>` that can be used directly as
 * `renderer.render(renderOutput(scenePass.getTextureNode()))`.
 */
export function renderOutput(
    inputNode: Node<'vec4f'>,
    options: RenderOutputOptions = {},
): Node<'vec4f'> {
    const toneMapping = options.toneMapping ?? 'aces';
    const colorSpace  = options.colorSpace  ?? 'srgb';
    const exposure    = options.exposure    ?? konst('f32', 1.0);

    // Build the chain: input → exposure → tone map → gamma
    // Each step is a RawNode that substitutes $0 = previous step.

    // Step 1: apply exposure to RGB, preserve alpha.
    // $0 = inputNode (vec4f), $1 = exposure (f32)
    const exposed = new RawNode<'vec4f'>(
        'vec4f',
        'vec4f(($0).rgb * $1, ($0).a)',
        [inputNode, exposure],
    );

    // Step 2: tone mapping (operates on vec3f RGB only).
    const tonemapped = applyToneMapping(exposed, toneMapping);

    // Step 3: gamma / color space conversion.
    if (colorSpace === 'srgb') {
        return linearToSrgb(tonemapped);
    } else {
        return tonemapped;
    }
}

// ---------------------------------------------------------------------------
// Tone mapping implementations
// ---------------------------------------------------------------------------

function applyToneMapping(node: Node<'vec4f'>, mode: ToneMappingMode): Node<'vec4f'> {
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
 */
function acesToneMapping(node: Node<'vec4f'>): Node<'vec4f'> {
    // Inline ACES as a single WGSL expression — no helper function needed.
    // Let c = input.rgb
    // result = clamp((c * (2.51*c + 0.03)) / (c * (2.43*c + 0.59) + 0.14), 0.0, 1.0)
    return new RawNode<'vec4f'>(
        'vec4f',
        [
            '(func() -> vec4f {',
            '  let c = ($0).rgb;',
            '  let mapped = clamp((c * (2.51 * c + vec3f(0.03))) / (c * (2.43 * c + vec3f(0.59)) + vec3f(0.14)), vec3f(0.0), vec3f(1.0));',
            '  return vec4f(mapped, ($0).a);',
            '})()',
        ].join(' '),
        [node],
    );
}

/**
 * Reinhard tone mapping.
 * f(x) = x / (1 + x)  applied per-channel.
 * $0 = input vec4f
 */
function reinhardToneMapping(node: Node<'vec4f'>): Node<'vec4f'> {
    return new RawNode<'vec4f'>(
        'vec4f',
        [
            '(func() -> vec4f {',
            '  let c = ($0).rgb;',
            '  return vec4f(c / (vec3f(1.0) + c), ($0).a);',
            '})()',
        ].join(' '),
        [node],
    );
}

// ---------------------------------------------------------------------------
// Color space conversion
// ---------------------------------------------------------------------------

/**
 * Linear → sRGB conversion.
 * Uses the piecewise sRGB transfer function (exact IEC 61966-2-1):
 *   c <= 0.0031308  →  12.92 * c
 *   c >  0.0031308  →  1.055 * pow(c, 1/2.4) - 0.055
 *
 * Applied per-channel to RGB, alpha passed through.
 * $0 = input vec4f
 */
function linearToSrgb(node: Node<'vec4f'>): Node<'vec4f'> {
    return new RawNode<'vec4f'>(
        'vec4f',
        [
            '(func() -> vec4f {',
            '  let c = ($0).rgb;',
            '  let lo = c * 12.92;',
            '  let hi = pow(clamp(c, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.4)) * 1.055 - vec3f(0.055);',
            '  let srgb = select(hi, lo, c <= vec3f(0.0031308));',
            '  return vec4f(srgb, ($0).a);',
            '})()',
        ].join(' '),
        [node],
    );
}
