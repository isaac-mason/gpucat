import { div, Node } from '../core';
import { renderGroup, UniformNode, Uniform } from '../uniform';
import { fragCoord } from '../builtin';
import * as d from '../../schema';

/**
 * Screen coordinate — the current fragment's xy position in pixels.
 * Equivalent to @builtin(position).xy in WGSL.
 *
 * @example
 * // Get pixel position
 * const pixelPos = screenCoordinate;
 */
export const screenCoordinate = fragCoord.xy;

/**
 * Screen/viewport size in pixels. Updated per render by the renderer.
 * In renderGroup so it's shared across all objects in a frame.
 *
 * @example
 * // Get screen dimensions
 * const size = screenSize; // vec2f(width, height)
 */
export const screenSize: UniformNode<d.vec2f> = /*@__PURE__*/ new UniformNode(
    new Uniform(d.vec2f, undefined, renderGroup),
    'screenSize'
).onRenderUpdate(({ width, height }) => [width, height]);

/**
 * Normalized screen UV coordinates in [0, 1] range.
 * Computed as screenCoordinate / screenSize.
 *
 * (0, 0) is top-left, (1, 1) is bottom-right (following WebGPU conventions).
 *
 * @example
 * // Sample a texture using screen UV
 * const color = texture.sample(screenUV);
 *
 * // Use x component for horizontal effects
 * const x = screenUV.x;
 */

export const screenUV: Node<d.vec2f> = /*@__PURE__*/ (() => {
    return div(screenCoordinate, screenSize) as unknown as Node<d.vec2f>;
})();
