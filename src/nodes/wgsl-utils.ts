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
export function constLiteral(type: string, value: number | number[] | string): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') {
        switch (type) {
            case 'f32':
                return Number.isInteger(value) ? `${value}.0` : `${value}`;
            case 'f16':
                return Number.isInteger(value) ? `${value}.0h` : `${value}h`;
            case 'i32':
                return `${Math.trunc(value)}i`;
            case 'u32':
                return `${Math.trunc(value)}u`;
            case 'bool':
                return value !== 0 ? 'true' : 'false';
            default:
                return `${value}`;
        }
    }
    const components = (value as number[]).map((v) => {
        if (type.startsWith('vec') && type.endsWith('f')) return Number.isInteger(v) ? `${v}.0` : `${v}`;
        if (type.startsWith('vec') && type.endsWith('h')) return Number.isInteger(v) ? `${v}.0h` : `${v}h`;
        if (type.startsWith('vec') && type.endsWith('i')) return `${Math.trunc(v)}i`;
        if (type.startsWith('vec') && type.endsWith('u')) return `${Math.trunc(v)}u`;
        if (type === 'vec2<bool>' || type === 'vec3<bool>' || type === 'vec4<bool>') return v !== 0 ? 'true' : 'false';
        if (type.startsWith('mat') && type.endsWith('h')) return Number.isInteger(v) ? `${v}.0h` : `${v}h`;
        if (type.startsWith('mat')) return Number.isInteger(v) ? `${v}.0` : `${v}`;
        return `${v}`;
    });
    if (components.length === 0) return `${type}()`;
    return `${type}(${components.join(', ')})`;
}
