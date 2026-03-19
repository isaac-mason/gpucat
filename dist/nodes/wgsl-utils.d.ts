/**
 * wgsl-utils.ts — WGSL code generation utilities shared across node compilation.
 *
 * These are pure functions that convert JavaScript values to WGSL syntax strings.
 */
/**
 * Generate a WGSL literal string for a constant value.
 *
 * @param type - The WGSL type (e.g., 'f32', 'vec3f', 'mat4x4f')
 * @param value - The value as a number, array of numbers, or string
 * @returns The WGSL literal string
 */
export declare function constLiteral(type: string, value: number | number[] | string): string;
