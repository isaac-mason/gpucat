/**
 * color.ts — Linear-sRGB color utilities.
 *
 * A Color is a 3-element tuple [r, g, b] of linear-sRGB floats in [0, 1].
 *
 * All CSS-style / gamma-sRGB inputs are converted to linear RGB via the
 * standard sRGB gamma-expansion formula.
 */
/** A linear-sRGB color: [r, g, b] floats in [0, 1]. */
export type Color = [r: number, g: number, b: number];
export type ColorInput = string | number | [number, number, number];
/** Create a new Color initialized to black [0, 0, 0]. */
export declare function create(): Color;
/** Create a new Color with the given linear r, g, b values. */
export declare function fromValues(r: number, g: number, b: number): Color;
/** Create a new Color that is a copy of `c`. */
export declare function clone(c: Color): Color;
/** Copy the values from `src` into `out`. Returns `out`. */
export declare function copy(out: Color, src: Color): Color;
/** Set the linear r, g, b components of `out` directly. Returns `out`. */
export declare function set(out: Color, r: number, g: number, b: number): Color;
/**
 * Set `out` from an sRGB gamma-encoded [r, g, b] array with values in [0, 1].
 * Converts from sRGB gamma space to linear. Returns `out`.
 */
export declare function setFromSRGB(out: Color, srgb: [number, number, number]): Color;
/** Create a new Color from an sRGB gamma-encoded [r, g, b] array with values in [0, 1]. */
export declare function fromSRGB(srgb: [number, number, number]): Color;
/**
 * Parse any supported color input and write the result into `out`. Returns `out`.
 *
 * Supported inputs:
 *   - CSS hex strings:       '#f00', '#ff0000'
 *   - CSS rgb():             'rgb(255, 0, 0)', 'rgb(100%, 0%, 0%)'
 *   - CSS hsl():             'hsl(0, 100%, 50%)'
 *   - 0xRRGGBB integers:     0xff0000 (sRGB gamma)
 *   - Named CSS colors:      'red', 'lime', 'deepskyblue', ...
 *   - [r, g, b] array:       treated as already-linear [0, 1]
 */
export declare function setFromColorInput(out: Color, input: ColorInput): Color;
/** Parse any supported color input into a new Color. */
export declare function fromColorInput(input: ColorInput): Color;
/**
 * Return a CSS `rgb(...)` string in sRGB gamma space (for HTML/canvas use).
 */
export declare function toCSS(c: Color): string;
