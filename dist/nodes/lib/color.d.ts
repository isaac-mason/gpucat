import { type ColorInput } from 'gpucat/dist/utils/color';
/**
 * Convert any color input to a `vec3f` linear RGB node.
 *
 * This is the primary way to introduce a color into the node graph.
 * The resulting node has type `vec3f` so it can be used anywhere a `vec3f`
 * is expected — including as the first argument to `vec4(xyz, w)`.
 *
 * @example
 * import { rgb, vec4, f32 } from 'gpucat';
 *
 * const fragColor = vec4(rgb('#f00'), f32(1));
 *
 * // Other accepted forms:
 * rgb('hsl(200, 80%, 50%)');
 * rgb('deepskyblue');
 * rgb(0xff8800);
 * rgb([1, 0.5, 0]);
 */
export declare function rgb(input: ColorInput): import("gpucat/dist/nodes/lib/core").ConstructNode<import("gpucat/dist/schema/schema").vec3f>;
