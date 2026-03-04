/**
 * color.ts — Color class for linear-sRGB color storage.
 *
 * Color stores linear-sRGB r/g/b floats in [0, 1].
 *
 * Accepted inputs for new Color(input):
 *   - CSS hex strings:       '#f00', '#ff0000', '#FF0000'
 *   - CSS rgb():             'rgb(255, 0, 0)', 'rgb(100%, 0%, 0%)'
 *   - CSS hsl():             'hsl(0, 100%, 50%)'
 *   - 0xRRGGBB integers:     0xff0000
 *   - Float [r, g, b] array: [1, 0, 0]
 *   - Named CSS colors:      'red', 'lime', 'deepskyblue', … (full CSS4 set)
 *   - Another Color:         new Color(existingColor)
 *
 * All channel values are expected / stored as linear [0, 1] floats.
 * CSS-style inputs that traditionally live in gamma space are converted to
 * linear RGB via the standard sRGB gamma-expansion formula so WGSL receives
 * physically-correct values.
 *
 * @example
 * const c = new Color('hsl(200, 80%, 50%)');
 * c.r; c.g; c.b;  // linear floats
 */

// ---------------------------------------------------------------------------
// CSS named color table (subset — the 148 CSS4 named colors)
// Values are 0xRRGGBB integers in sRGB gamma space.
// ---------------------------------------------------------------------------

/* eslint-disable sort-keys */
const CSS_COLORS: Record<string, number> = {
    aliceblue: 0xf0f8ff,
    antiquewhite: 0xfaebd7,
    aqua: 0x00ffff,
    aquamarine: 0x7fffd4,
    azure: 0xf0ffff,
    beige: 0xf5f5dc,
    bisque: 0xffe4c4,
    black: 0x000000,
    blanchedalmond: 0xffebcd,
    blue: 0x0000ff,
    blueviolet: 0x8a2be2,
    brown: 0xa52a2a,
    burlywood: 0xdeb887,
    cadetblue: 0x5f9ea0,
    chartreuse: 0x7fff00,
    chocolate: 0xd2691e,
    coral: 0xff7f50,
    cornflowerblue: 0x6495ed,
    cornsilk: 0xfff8dc,
    crimson: 0xdc143c,
    cyan: 0x00ffff,
    darkblue: 0x00008b,
    darkcyan: 0x008b8b,
    darkgoldenrod: 0xb8860b,
    darkgray: 0xa9a9a9,
    darkgreen: 0x006400,
    darkgrey: 0xa9a9a9,
    darkkhaki: 0xbdb76b,
    darkmagenta: 0x8b008b,
    darkolivegreen: 0x556b2f,
    darkorange: 0xff8c00,
    darkorchid: 0x9932cc,
    darkred: 0x8b0000,
    darksalmon: 0xe9967a,
    darkseagreen: 0x8fbc8f,
    darkslateblue: 0x483d8b,
    darkslategray: 0x2f4f4f,
    darkslategrey: 0x2f4f4f,
    darkturquoise: 0x00ced1,
    darkviolet: 0x9400d3,
    deeppink: 0xff1493,
    deepskyblue: 0x00bfff,
    dimgray: 0x696969,
    dimgrey: 0x696969,
    dodgerblue: 0x1e90ff,
    firebrick: 0xb22222,
    floralwhite: 0xfffaf0,
    forestgreen: 0x228b22,
    fuchsia: 0xff00ff,
    gainsboro: 0xdcdcdc,
    ghostwhite: 0xf8f8ff,
    gold: 0xffd700,
    goldenrod: 0xdaa520,
    gray: 0x808080,
    green: 0x008000,
    greenyellow: 0xadff2f,
    grey: 0x808080,
    honeydew: 0xf0fff0,
    hotpink: 0xff69b4,
    indianred: 0xcd5c5c,
    indigo: 0x4b0082,
    ivory: 0xfffff0,
    khaki: 0xf0e68c,
    lavender: 0xe6e6fa,
    lavenderblush: 0xfff0f5,
    lawngreen: 0x7cfc00,
    lemonchiffon: 0xfffacd,
    lightblue: 0xadd8e6,
    lightcoral: 0xf08080,
    lightcyan: 0xe0ffff,
    lightgoldenrodyellow: 0xfafad2,
    lightgray: 0xd3d3d3,
    lightgreen: 0x90ee90,
    lightgrey: 0xd3d3d3,
    lightpink: 0xffb6c1,
    lightsalmon: 0xffa07a,
    lightseagreen: 0x20b2aa,
    lightskyblue: 0x87cefa,
    lightslategray: 0x778899,
    lightslategrey: 0x778899,
    lightsteelblue: 0xb0c4de,
    lightyellow: 0xffffe0,
    lime: 0x00ff00,
    limegreen: 0x32cd32,
    linen: 0xfaf0e6,
    magenta: 0xff00ff,
    maroon: 0x800000,
    mediumaquamarine: 0x66cdaa,
    mediumblue: 0x0000cd,
    mediumorchid: 0xba55d3,
    mediumpurple: 0x9370db,
    mediumseagreen: 0x3cb371,
    mediumslateblue: 0x7b68ee,
    mediumspringgreen: 0x00fa9a,
    mediumturquoise: 0x48d1cc,
    mediumvioletred: 0xc71585,
    midnightblue: 0x191970,
    mintcream: 0xf5fffa,
    mistyrose: 0xffe4e1,
    moccasin: 0xffe4b5,
    navajowhite: 0xffdead,
    navy: 0x000080,
    oldlace: 0xfdf5e6,
    olive: 0x808000,
    olivedrab: 0x6b8e23,
    orange: 0xffa500,
    orangered: 0xff4500,
    orchid: 0xda70d6,
    palegoldenrod: 0xeee8aa,
    palegreen: 0x98fb98,
    paleturquoise: 0xafeeee,
    palevioletred: 0xdb7093,
    papayawhip: 0xffefd5,
    peachpuff: 0xffdab9,
    peru: 0xcd853f,
    pink: 0xffc0cb,
    plum: 0xdda0dd,
    powderblue: 0xb0e0e6,
    purple: 0x800080,
    rebeccapurple: 0x663399,
    red: 0xff0000,
    rosybrown: 0xbc8f8f,
    royalblue: 0x4169e1,
    saddlebrown: 0x8b4513,
    salmon: 0xfa8072,
    sandybrown: 0xf4a460,
    seagreen: 0x2e8b57,
    seashell: 0xfff5ee,
    sienna: 0xa0522d,
    silver: 0xc0c0c0,
    skyblue: 0x87ceeb,
    slateblue: 0x6a5acd,
    slategray: 0x737373,
    slategrey: 0x737373,
    snow: 0xfffafa,
    springgreen: 0x00ff7f,
    steelblue: 0x4682b4,
    tan: 0xd2b48c,
    teal: 0x008080,
    thistle: 0xd8bfd8,
    tomato: 0xff6347,
    turquoise: 0x40e0d0,
    violet: 0xee82ee,
    wheat: 0xf5deb3,
    white: 0xffffff,
    whitesmoke: 0xf5f5f5,
    yellow: 0xffff00,
    yellowgreen: 0x9acd32,
};
/* eslint-enable sort-keys */

// ---------------------------------------------------------------------------
// sRGB ↔ linear conversion helpers
// ---------------------------------------------------------------------------

/**
 * Convert a single sRGB gamma-encoded channel [0, 1] to linear light [0, 1].
 * Uses the IEC 61966-2-1 piecewise formula.
 */
function srgbToLinear(c: number): number {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// ---------------------------------------------------------------------------
// Internal parser helpers
// ---------------------------------------------------------------------------

/** Expand a 3-digit hex string to [r, g, b] linear floats. */
function parseHex3(hex: string): [number, number, number] {
    const r = parseInt(hex[1] + hex[1], 16) / 255;
    const g = parseInt(hex[2] + hex[2], 16) / 255;
    const b = parseInt(hex[3] + hex[3], 16) / 255;
    return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}

/** Expand a 6-digit hex string to [r, g, b] linear floats. */
function parseHex6(hex: string): [number, number, number] {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}

/** Parse an `rgb(r, g, b)` or `rgb(r%, g%, b%)` string. */
function parseRgb(str: string): [number, number, number] | null {
    const m = str.match(/^rgb\(\s*([^,]+),\s*([^,]+),\s*([^)]+)\)$/i);
    if (!m) return null;
    const parse = (s: string): number => {
        s = s.trim();
        if (s.endsWith('%')) return parseFloat(s) / 100;
        return parseFloat(s) / 255;
    };
    const r = srgbToLinear(parse(m[1]));
    const g = srgbToLinear(parse(m[2]));
    const b = srgbToLinear(parse(m[3]));
    return [r, g, b];
}

/** Parse an `hsl(h, s%, l%)` string. Returns linear [r, g, b]. */
function parseHsl(str: string): [number, number, number] | null {
    const m = str.match(/^hsl\(\s*([^,]+),\s*([^,]+),\s*([^)]+)\)$/i);
    if (!m) return null;
    const h = parseFloat(m[1]) / 360;
    const s = parseFloat(m[2]) / 100;
    const l = parseFloat(m[3]) / 100;
    return hslToLinear(h, s, l);
}

/** HSL → sRGB → linear. h/s/l all in [0, 1]. */
function hslToLinear(h: number, s: number, l: number): [number, number, number] {
    let r: number, g: number, b: number;
    if (s === 0) {
        r = g = b = l;
    } else {
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1 / 3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1 / 3);
    }
    return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}

function hue2rgb(p: number, q: number, t: number): number {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
}

// ---------------------------------------------------------------------------
// Color — accepted input types
// ---------------------------------------------------------------------------

export type ColorInput =
    | string          // '#f00', '#ff0000', 'red', 'rgb(255,0,0)', 'hsl(0,100%,50%)'
    | number          // 0xff0000 integer (sRGB)
    | [number, number, number]  // [r, g, b] linear floats [0, 1]
    | Color;          // copy constructor

// ---------------------------------------------------------------------------
// Color class
// ---------------------------------------------------------------------------

/**
 * A linear-sRGB color with r/g/b channels in [0, 1].
 *
 * All CSS-style inputs are converted from gamma-sRGB to linear RGB on construction.
 *
 * @example
 * new Color('#f00')                     // red
 * new Color('#ff6600')                  // orange
 * new Color('hsl(200, 80%, 50%)')       // steel-ish blue
 * new Color('rgb(255, 128, 0)')         // orange
 * new Color(0x00ff00)                   // green
 * new Color([1, 0.5, 0])               // linear orange
 * new Color('deepskyblue')             // named CSS color
 */
export class Color {
    /** Linear red channel [0, 1]. */
    r: number;
    /** Linear green channel [0, 1]. */
    g: number;
    /** Linear blue channel [0, 1]. */
    b: number;

    constructor(input: ColorInput = 0x000000) {
        [this.r, this.g, this.b] = Color._parse(input);
    }

    /** Set all channels from any accepted input, mutating this Color. Returns `this`. */
    set(input: ColorInput): this {
        [this.r, this.g, this.b] = Color._parse(input);
        return this;
    }

    /** Return a new Color that is a copy of this one. */
    clone(): Color {
        return new Color([this.r, this.g, this.b]);
    }

    /**
     * Return a CSS `rgb(…)` string in gamma-sRGB space (for HTML/canvas use).
     * Applies the inverse gamma from linear → sRGB.
     */
    toCSS(): string {
        const toGamma = (v: number) => Math.round((v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255);
        return `rgb(${toGamma(this.r)}, ${toGamma(this.g)}, ${toGamma(this.b)})`;
    }

    /** Return a `[r, g, b]` float array (linear). */
    toArray(): [number, number, number] {
        return [this.r, this.g, this.b];
    }

    // ---------------------------------------------------------------------------
    // Internal parser — resolves any ColorInput to [r, g, b] linear floats
    // ---------------------------------------------------------------------------

    private static _parse(input: ColorInput): [number, number, number] {
        // Copy constructor
        if (input instanceof Color) return [input.r, input.g, input.b];

        // Float array — treated as already-linear
        if (Array.isArray(input)) {
            return [input[0] ?? 0, input[1] ?? 0, input[2] ?? 0];
        }

        // Integer 0xRRGGBB
        if (typeof input === 'number') {
            const r = ((input >> 16) & 0xff) / 255;
            const g = ((input >> 8) & 0xff) / 255;
            const b = (input & 0xff) / 255;
            return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
        }

        // String forms
        const s = input.trim().toLowerCase();

        // #rgb
        if (/^#[0-9a-f]{3}$/i.test(s)) return parseHex3(s);

        // #rrggbb
        if (/^#[0-9a-f]{6}$/i.test(s)) return parseHex6(s);

        // rgb(...)
        if (s.startsWith('rgb(')) {
            const result = parseRgb(s);
            if (result) return result;
        }

        // hsl(...)
        if (s.startsWith('hsl(')) {
            const result = parseHsl(s);
            if (result) return result;
        }

        // CSS named color
        const hex = CSS_COLORS[s];
        if (hex !== undefined) {
            return parseHex6('#' + hex.toString(16).padStart(6, '0'));
        }

        throw new Error(`[gpucat] Color: unrecognised color input: "${input}"`);
    }
}
