/**
 * wgsl-utils.ts, WGSL code generation utilities shared across node compilation.
 *
 * These are pure functions that convert JavaScript values to WGSL syntax strings.
 */

import { floatLiteral, i32LiteralWgsl, u32Literal } from './backend/print';

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
                return floatLiteral(value);
            case 'f16':
                return `${floatLiteral(value, 'f16')}h`;
            case 'i32':
                return i32LiteralWgsl(value);
            case 'u32':
                return u32Literal(value);
            case 'bool':
                return value !== 0 ? 'true' : 'false';
            default:
                return `${value}`;
        }
    }
    const components = (value as number[]).map((v) => {
        if (type.startsWith('vec') && type.endsWith('f')) return floatLiteral(v);
        if (type.startsWith('vec') && type.endsWith('h')) return `${floatLiteral(v, 'f16')}h`;
        if (type.startsWith('vec') && type.endsWith('i')) return i32LiteralWgsl(v);
        if (type.startsWith('vec') && type.endsWith('u')) return u32Literal(v);
        if (type === 'vec2<bool>' || type === 'vec3<bool>' || type === 'vec4<bool>') return v !== 0 ? 'true' : 'false';
        if (type.startsWith('mat') && type.endsWith('h')) return `${floatLiteral(v, 'f16')}h`;
        if (type.startsWith('mat')) return floatLiteral(v);
        return `${v}`;
    });
    if (components.length === 0) return `${type}()`;
    return `${type}(${components.join(', ')})`;
}
