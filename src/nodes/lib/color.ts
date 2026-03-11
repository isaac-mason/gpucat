import { type ColorInput, Color } from '../../utils/color';
import { vec3f } from './core';

/**
 * Convert any color input to a `vec3f` linear RGB color.
 *
 * This is the primary way to introduce a color into the node graph.
 * The resulting node has type `vec3f` so it can be used anywhere a `vec3f`
 * is expected — including as the first argument to `vec4(xyz, w)`.
 *
 * @example
 * import { color, vec4, f32 } from 'gpucat';
 *
 * // Build an opaque red vec4f for use as a fragment color
 * const fragColor = vec4(color('#f00'), f32(1));
 *
 * // Other accepted forms:
 * color('hsl(200, 80%, 50%)');
 * color('deepskyblue');
 * color(0xff8800);
 * color([1, 0.5, 0]);
 * color(new Color('red'));
 */

export function color(input: ColorInput) {
    const c = input instanceof Color ? input : new Color(input);
    return vec3f(c.r, c.g, c.b);
}
