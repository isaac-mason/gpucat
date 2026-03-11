import { Fn, vec3f, f32 } from '../core';
import * as d from '../../schema';

/**
 * ACES filmic tone mapping (Narkowicz 2015).
 * f(x) = clamp((x * (2.51x + 0.03)) / (x * (2.43x + 0.59) + 0.14), 0, 1)
 */
export const acesToneMapping = Fn(
    (color) => {
        const c = color.toConst('c');
        const a = c.mul(c.mul(f32(2.51)).add(vec3f(0.03))).toVar('a');
        const b = c.mul(c.mul(f32(2.43)).add(vec3f(0.59))).add(vec3f(0.14)).toVar('b');
        const result = a.div(b).clamp(vec3f(0), vec3f(1)).toVar('result');
        return result;
    },
    { name: 'acesToneMapping', params: [{ name: 'color', type: d.vec3f }] as const },
);

/**
 * Reinhard tone mapping.
 * f(x) = x / (1 + x)
 */
export const reinhardToneMapping = Fn(
    (color) => {
        const result = color.div(vec3f(1).add(color)).toVar('result');
        return result;
    },
    { name: 'reinhardToneMapping', params: [{ name: 'color', type: d.vec3f }] as const },
);

/**
 * sRGB EOTF (electro-optical transfer function).
 * Converts sRGB gamma-encoded values to linear-sRGB.
 */
export const sRGBTransferEOTF = Fn(
    (color) => {
        const a = color.mul(f32(0.9478672986)).add(f32(0.0521327014)).pow(vec3f(2.4)).toVar('a');
        const b = color.mul(f32(0.0773993808)).toVar('b');
        const factor = color.lessThanEqual(vec3f(0.04045)).toVar('factor');
        const result = factor.select(b, a).toVar('result');
        return result;
    },
    { name: 'sRGBTransferEOTF', params: [{ name: 'color', type: d.vec3f }] as const },
);

/**
 * sRGB OETF (opto-electronic transfer function).
 * Converts linear-sRGB values to sRGB gamma-encoded.
 */
export const sRGBTransferOETF = Fn(
    (color) => {
        const a = color.pow(vec3f(0.41666)).mul(f32(1.055)).sub(f32(0.055)).toVar('a');
        const b = color.mul(f32(12.92)).toVar('b');
        const factor = color.lessThanEqual(vec3f(0.0031308)).toVar('factor');
        const result = factor.select(b, a).toVar('result');
        return result;
    },
    { name: 'sRGBTransferOETF', params: [{ name: 'color', type: d.vec3f }] as const },
);
