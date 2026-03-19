import * as d from '../../../schema/schema';
/**
 * ACES filmic tone mapping (Narkowicz 2015).
 * f(x) = clamp((x * (2.51x + 0.03)) / (x * (2.43x + 0.59) + 0.14), 0, 1)
 */
export declare const acesToneMapping: (args_0: import("../core").Node<d.vec3f>) => import("../core").CallNode<d.vec3f>;
/**
 * Reinhard tone mapping.
 * f(x) = x / (1 + x)
 */
export declare const reinhardToneMapping: (args_0: import("../core").Node<d.vec3f>) => import("../core").CallNode<d.vec3f>;
/**
 * sRGB EOTF (electro-optical transfer function).
 * Converts sRGB gamma-encoded values to linear-sRGB.
 */
export declare const sRGBTransferEOTF: (args_0: import("../core").Node<d.vec3f>) => import("../core").CallNode<d.vec3f>;
/**
 * sRGB OETF (opto-electronic transfer function).
 * Converts linear-sRGB values to sRGB gamma-encoded.
 */
export declare const sRGBTransferOETF: (args_0: import("../core").Node<d.vec3f>) => import("../core").CallNode<d.vec3f>;
