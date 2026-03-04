/**
 * wgsl-utils.ts — Pure WGSL code-generation helpers.
 *
 * No imports from nodes.ts or compile.ts. Safe to import from either.
 */

import type { ScalarType, Node, WgslType, ForRange } from './nodes.js';

// ---------------------------------------------------------------------------
// std140 layout helpers
// ---------------------------------------------------------------------------

export function std140Size(type: string): number {
    switch (type) {
        case 'f32': case 'i32': case 'u32': case 'bool': return 4;
        case 'vec2f': case 'vec2i': case 'vec2u': case 'vec2b': return 8;
        case 'vec3f': case 'vec3i': case 'vec3u': case 'vec3b': return 12;
        case 'vec4f': case 'vec4i': case 'vec4u': case 'vec4b': return 16;
        case 'mat2x2f': return 32;
        case 'mat2x3f': case 'mat2x4f': return 32;
        case 'mat3x2f': return 48;
        case 'mat3x3f': case 'mat3x4f': return 48;
        case 'mat4x2f': return 64;
        case 'mat4x3f': case 'mat4x4f': return 64;
        default: return 16;
    }
}

export function std140Align(type: string): number {
    switch (type) {
        case 'f32': case 'i32': case 'u32': case 'bool': return 4;
        case 'vec2f': case 'vec2i': case 'vec2u': case 'vec2b': return 8;
        case 'vec3f': case 'vec3i': case 'vec3u': case 'vec3b': return 16;
        case 'vec4f': case 'vec4i': case 'vec4u': case 'vec4b': return 16;
        default: return 16;
    }
}

export function alignUp(offset: number, align: number): number {
    return Math.ceil(offset / align) * align;
}

// ---------------------------------------------------------------------------
// WGSL type name normalization
// ---------------------------------------------------------------------------

export function wgslTypeName(type: string): string {
    if (type === 'vec2b') return 'vec2<bool>';
    if (type === 'vec3b') return 'vec3<bool>';
    if (type === 'vec4b') return 'vec4<bool>';
    return type;
}

// ---------------------------------------------------------------------------
// Constant literal emitters
// ---------------------------------------------------------------------------

export function constLiteral(type: string, value: number | number[] | string): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') {
        switch (type) {
            case 'f32': return Number.isInteger(value) ? `${value}.0` : `${value}`;
            case 'i32': return `${Math.trunc(value)}i`;
            case 'u32': return `${Math.trunc(value)}u`;
            case 'bool': return value !== 0 ? 'true' : 'false';
            default: return `${value}`;
        }
    }
    const components = (value as number[]).map((v) => {
        if (type.startsWith('vec') && type.endsWith('f')) return Number.isInteger(v) ? `${v}.0` : `${v}`;
        if (type.startsWith('vec') && type.endsWith('i')) return `${Math.trunc(v)}i`;
        if (type.startsWith('vec') && type.endsWith('u')) return `${Math.trunc(v)}u`;
        if (type.startsWith('vec') && type.endsWith('b')) return v !== 0 ? 'true' : 'false';
        if (type.startsWith('mat')) return Number.isInteger(v) ? `${v}.0` : `${v}`;
        return `${v}`;
    });
    if (components.length === 0) return `${wgslTypeName(type)}()`;
    return `${wgslTypeName(type)}(${components.join(', ')})`;
}

// ---------------------------------------------------------------------------
// For-loop header builder
// ---------------------------------------------------------------------------

export function buildUpdateSnippet(
    update: ForRange['update'],
    iName: string,
    type: ScalarType,
    defaultOp: '++' | '--',
): string {
    if (update === undefined || update === null) return `${iName}${defaultOp}`;
    if (typeof update === 'number') {
        const delta = constLiteral(type, Math.abs(update));
        const op = defaultOp.includes('+') ? '+=' : '-=';
        return `${iName} ${op} ${delta}`;
    }
    return `${iName}${defaultOp}`;
}

export function buildForHeader(
    range: ForRange,
    iName: string,
    getScalarExpr: (v: Node<WgslType> | number, type: ScalarType) => string,
): string {
    const type: ScalarType = range.type ?? 'u32';

    const rawStart = range.start !== undefined
        ? (typeof range.start === 'number' ? constLiteral(type, range.start) : getScalarExpr(range.start, type))
        : undefined;
    const rawEnd = range.end !== undefined
        ? (typeof range.end === 'number' ? constLiteral(type, range.end) : getScalarExpr(range.end, type))
        : undefined;

    let startSnippet: string;
    let endSnippet: string;
    let condition: string;
    let updateSnippet: string;

    if (rawStart !== undefined && rawEnd === undefined) {
        startSnippet = `${rawStart} - ${constLiteral(type, 1)}`;
        endSnippet = constLiteral(type, 0);
        condition = range.condition ?? '>=';
        const defaultUpdate = condition.includes('<') ? '++' : '--';
        updateSnippet = buildUpdateSnippet(range.update, iName, type, defaultUpdate);
    } else {
        startSnippet = rawStart ?? constLiteral(type, 0);
        endSnippet = rawEnd ?? constLiteral(type, 0);

        if (range.condition !== undefined) {
            condition = range.condition;
        } else {
            const numStart = typeof range.start === 'number' ? range.start : 0;
            const numEnd = typeof range.end === 'number' ? range.end : undefined;
            condition = (numEnd !== undefined && numStart > numEnd) ? '>=' : '<';
        }

        const defaultUpdate = condition.includes('<') ? '++' : '--';
        updateSnippet = buildUpdateSnippet(range.update, iName, type, defaultUpdate);
    }

    return `for (var ${iName} : ${type} = ${startSnippet}; ${iName} ${condition} ${endSnippet}; ${updateSnippet})`;
}
