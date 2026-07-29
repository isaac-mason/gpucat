/**
 * probe-glsl.ts, GLSL ES 3.00 string patching for the shader value probe (WebGL backend).
 *
 * The GLSL parallel to probe-wgsl.ts. Given the emitted FRAGMENT GLSL (the section after the
 * `// ---- fragment stage ----` marker) and a target variable / expression the user hovered, it
 * produces a patched fragment that writes that value — coerced to a `vec4` — into the fragment
 * output, replacing the shader's real output assignment(s). The vertex GLSL is reused verbatim so
 * the probe renders the same mesh from the real camera's point of view.
 *
 * GLSL is simpler than WGSL for our purposes: the emitter declares every hoisted CSE var and local
 * as `<glslType> <name> = <expr>;` (see backend/glsl/emit.ts `glslLocalDecl`), so the target's type
 * can be read straight from its declaration line — no polymorphic-builtin type inference is needed.
 * The single-output fragment ends with `fragColor = <expr>;` (or, for MRT, several
 * `<name> = <expr>;` lines against `layout(location=N) out vec4 <name>;` globals). We keep the
 * `fragColor` (location 0) output and rewrite its assignment to the coerced probe value; any MRT
 * outputs are neutralised so only location 0 carries the probe result.
 */

// ---------------------------------------------------------------------------
// ProbeTarget, shared shape with the WGSL probe
// ---------------------------------------------------------------------------

import type { ProbeTarget } from './probe-wgsl';

// ---------------------------------------------------------------------------
// extractGlslProbeTarget, parse a hovered GLSL line into a ProbeTarget
// ---------------------------------------------------------------------------

/** GLSL type-token prefixes that begin a declaration line (so we can tell a decl from an assignment). */
const GLSL_TYPE_TOKEN =
    /^(?:float|int|uint|bool|vec[234]|ivec[234]|uvec[234]|bvec[234]|mat[234](?:x[234])?|[A-Z]\w*)\s+\w/;

/**
 * Parse a single emitted GLSL fragment line into a {@link ProbeTarget}, or null if it isn't probeable.
 *
 * The GLSL analogue of extractProbeTarget (WGSL). The emitter writes:
 *   <type> <name> = <expr>;      → probe <name>, anchor on the declaration ('let_var')
 *   <type> <name>[N] = <expr>;   → probe <name> (array elem type; coercion falls back to unknown)
 *   fragColor = <expr>;          → probe <expr>, anchor on this assignment line
 *   <mrtName> = <expr>;          → probe <expr>, anchor on this assignment line
 *   <lvalue> = <expr>;           → probe <expr>, anchor on this assignment line
 * Structural lines (main(), braces, control flow, `return;`, `discard;`) are skipped.
 */
export function extractGlslProbeTarget(line: string): ProbeTarget | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return null;
    if (
        trimmed.startsWith('void main') ||
        trimmed === '{' ||
        trimmed === '}' ||
        trimmed.startsWith('#') ||
        trimmed.startsWith('precision ') ||
        trimmed.startsWith('layout(') ||
        trimmed.startsWith('uniform ') ||
        trimmed.startsWith('in ') ||
        trimmed.startsWith('out ') ||
        trimmed.startsWith('struct ') ||
        trimmed.startsWith('if') ||
        trimmed.startsWith('} else') ||
        trimmed.startsWith('for') ||
        trimmed.startsWith('while') ||
        trimmed === 'discard;' ||
        trimmed === 'return;' ||
        trimmed.startsWith('break') ||
        trimmed.startsWith('continue')
    ) {
        return null;
    }

    // Declaration: `<type> <name> [ [N] ] = <expr>;`. Probe the declared variable.
    if (GLSL_TYPE_TOKEN.test(trimmed)) {
        const declMatch = trimmed.match(/^\w+\s+(\w+)\s*(?:\[[^\]]*\])?\s*=\s*[\s\S]+;?\s*$/);
        if (declMatch) {
            return { expr: declMatch[1], anchor: declMatch[1], anchorKind: 'let_var' };
        }
        // A bare declaration with no initializer isn't probeable.
        return null;
    }

    // Assignment: `<lvalue> = <expr>;`. Probe the RHS, anchor on the exact trimmed line.
    const assignMatch = trimmed.match(/^([\w.[\]]+)\s*=\s*([\s\S]+?)\s*;?\s*$/);
    if (assignMatch) {
        return { expr: assignMatch[2], anchor: trimmed, anchorKind: 'assignment' };
    }

    return null;
}

// ---------------------------------------------------------------------------
// GLSL type inference, read the target's type from its declaration
// ---------------------------------------------------------------------------

/** The GLSL component kinds the coercion understands. `unknown` falls back to a pass-through. */
export type GlslKind =
    | 'float'
    | 'vec2'
    | 'vec3'
    | 'vec4'
    | 'int'
    | 'uint'
    | 'ivec2'
    | 'ivec3'
    | 'ivec4'
    | 'uvec2'
    | 'uvec3'
    | 'uvec4'
    | 'bool'
    | 'bvec2'
    | 'bvec3'
    | 'bvec4'
    | 'unknown';

const KNOWN_KINDS = new Set<string>([
    'float',
    'vec2',
    'vec3',
    'vec4',
    'int',
    'uint',
    'ivec2',
    'ivec3',
    'ivec4',
    'uvec2',
    'uvec3',
    'uvec4',
    'bool',
    'bvec2',
    'bvec3',
    'bvec4',
]);

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Infer the GLSL type of a probe target from the fragment source.
 *
 * The primary path is a direct declaration lookup: the emitter writes every CSE var / local as
 * `<glslType> <name> = …;`, so for a bare identifier target (`_v3`, `scaled`, …) we scan for its
 * declaration and read the leading type token. Failing that (e.g. a selected sub-expression or a
 * swizzle), we fall back to lightweight structural inference: constructor prefixes, texture calls,
 * literals, and trailing swizzles. Unresolvable targets return 'unknown' → pass-through coercion.
 */
export function inferGlslType(expr: string, fragmentSrc: string): GlslKind {
    const e = expr.trim();

    // Bare identifier: look up its `<type> name = …;` (or `<type> name[N] = …;`) declaration.
    if (/^\w+$/.test(e)) {
        // Match a declaration of this name and capture the leading type token. Handles the array form
        // `float name[3] = …` too (we still read the element type; coercion treats it as unknown then).
        const declRe = new RegExp(`\\b(\\w+)\\s+${escapeRegex(e)}\\s*(?:\\[[^\\]]*\\])?\\s*=`, 'm');
        const m = fragmentSrc.match(declRe);
        if (m && KNOWN_KINDS.has(m[1])) return m[1] as GlslKind;
    }

    // Constructor prefix: vec4(...), ivec3(...), bvec2(...), float(...), etc.
    const ctor = e.match(/^(vec[234]|ivec[234]|uvec[234]|bvec[234]|float|int|uint|bool)\s*\(/);
    if (ctor && KNOWN_KINDS.has(ctor[1])) return ctor[1] as GlslKind;

    // texture*/texelFetch always return a 4-component sample (float/int/uint variant collapses to vec4
    // for probe purposes — the driver returns a vec4-shaped value we display directly).
    if (/^(texture|textureLod|textureGrad|texelFetch|textureProj)\b/.test(e)) return 'vec4';

    // Numeric literals.
    if (/^-?[0-9]*\.[0-9]+(?:[eE][+-]?[0-9]+)?$/.test(e)) return 'float';
    if (/^-?[0-9]+u$/.test(e)) return 'uint';
    if (/^-?[0-9]+$/.test(e)) return 'int';
    if (/^(true|false)$/.test(e)) return 'bool';

    // Trailing swizzle: `<base>.xyz`, `_v0.x`, `texture(...).rgb`. Resolve the base then size by the
    // swizzle length. Component of a float-family base is a float; ints/uints keep their family via a
    // simplifying assumption (probe values are overwhelmingly float — an int swizzle still coerces
    // through the numeric path below).
    const sw = e.match(/\.([xyzwrgba]{1,4})$/);
    if (sw) {
        const base = e.slice(0, e.length - sw[1].length - 1);
        if (base.length > 0) {
            const baseKind = inferGlslType(base, fragmentSrc);
            if (baseKind !== 'unknown') {
                const n = sw[1].length;
                const intFamily = baseKind.startsWith('ivec') || baseKind === 'int';
                const uintFamily = baseKind.startsWith('uvec') || baseKind === 'uint';
                if (n === 1) return intFamily ? 'int' : uintFamily ? 'uint' : 'float';
                const prefix = intFamily ? 'ivec' : uintFamily ? 'uvec' : 'vec';
                return `${prefix}${n}` as GlslKind;
            }
        }
    }

    return 'unknown';
}

// ---------------------------------------------------------------------------
// Coercion to vec4
// ---------------------------------------------------------------------------

/**
 * A GLSL expression that widens a value of `kind` to a `vec4` for the location-0 color output.
 *   float→vec4(v,0,0,1)   vec2→vec4(v,0,1)   vec3→vec4(v,1)   vec4→v
 *   int/uint→vec4(float(v),0,0,1)            bool→vec4(v?1:0,0,0,1)
 *   ivecN/uvecN→vec4(vec_of_floats, …)       bvecN→vec4 of floats
 * `unknown` passes the expression through unchanged (already a vec4, or the compiler surfaces a clear
 * type error — the same fallback the WGSL probe uses).
 */
export function coerceToVec4(expr: string, kind: GlslKind): string {
    switch (kind) {
        case 'vec4':
            return `(${expr})`;
        case 'vec3':
            return `vec4((${expr}), 1.0)`;
        case 'vec2':
            return `vec4((${expr}), 0.0, 1.0)`;
        case 'float':
            return `vec4(vec3(${expr}), 1.0)`;
        case 'int':
        case 'uint':
            return `vec4(vec3(float(${expr})), 1.0)`;
        case 'bool':
            return `vec4(vec3((${expr}) ? 1.0 : 0.0), 1.0)`;
        // Integer / bool vectors → cast each to a float vector of the same width, then widen.
        case 'ivec2':
        case 'uvec2':
            return `vec4(vec2(${expr}), 0.0, 1.0)`;
        case 'ivec3':
        case 'uvec3':
            return `vec4(vec3(${expr}), 1.0)`;
        case 'ivec4':
        case 'uvec4':
            return `vec4(${expr})`;
        case 'bvec2':
            return `vec4(vec2(${expr}), 0.0, 1.0)`;
        case 'bvec3':
            return `vec4(vec3(${expr}), 1.0)`;
        case 'bvec4':
            return `vec4(${expr})`;
        default:
            return `(${expr})`;
    }
}

/**
 * How many color components the coerced value meaningfully carries (drives readback decode). vec4
 * outputs carry 4, vec3/ivec3/… carry 3, and so on; scalars carry 1. `unknown` decodes as 4.
 */
export function componentCount(kind: GlslKind): number {
    switch (kind) {
        case 'float':
        case 'int':
        case 'uint':
        case 'bool':
            return 1;
        case 'vec2':
        case 'ivec2':
        case 'uvec2':
        case 'bvec2':
            return 2;
        case 'vec3':
        case 'ivec3':
        case 'uvec3':
        case 'bvec3':
            return 3;
        default:
            return 4;
    }
}

// ---------------------------------------------------------------------------
// buildProbeGLSL, patch the fragment to output the probe value
// ---------------------------------------------------------------------------

export type ProbeGlslResult = {
    /** The patched fragment GLSL source. */
    fragment: string;
    /** The inferred GLSL kind of the probed value (for readback decode). */
    kind: GlslKind;
};

/**
 * Patch the emitted fragment GLSL so that `layout(location = 0) out vec4 fragColor;` receives the
 * probed value (coerced to vec4), replacing the shader's real output assignment(s).
 *
 * Strategy (all inside `main()`):
 *  1. Keep every declaration/statement line verbatim UP TO the anchor that defines the target
 *     (for a `let_var` anchor, the `<type> _vN = …;` line). Variables are always declared before use,
 *     so truncating after the anchor never drops a dependency of the probed expression.
 *  2. Immediately after the anchor (or, for `return`/`assignment` anchors, in place of the shader's
 *     output write) emit `fragColor = <coerced>; return;` so nothing downstream runs.
 *  3. Ensure a `layout(location = 0) out vec4 fragColor;` global exists. The single-output emitter
 *     already declares it; the MRT emitter instead declares `layout(location = N) out vec4 <name>;`
 *     globals — for MRT we inject our own `fragColor` output and leave the MRT globals unassigned
 *     (unwritten fragment outputs are defined-but-unused, which links fine).
 *
 * Returns null if the fragment can't be parsed or the anchor isn't found.
 */
export function buildProbeGLSL(fragmentSrc: string, target: ProbeTarget): ProbeGlslResult | null {
    // Locate main().
    const mainMatch = fragmentSrc.match(/void\s+main\s*\(\s*\)\s*\{/);
    if (!mainMatch || mainMatch.index === undefined) return null;

    const beforeMain = fragmentSrc.slice(0, mainMatch.index);
    const bodyStart = mainMatch.index + mainMatch[0].length;

    // Walk to the matching closing brace of main() so trailing declarations (none, normally) aren't
    // swept into the body.
    let depth = 1;
    let i = bodyStart;
    while (i < fragmentSrc.length && depth > 0) {
        const ch = fragmentSrc[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    const body = fragmentSrc.slice(bodyStart, i - 1);
    const bodyLines = body.split('\n');

    // Infer the probed value's type from its declaration / structure.
    const kind = inferGlslType(target.expr, fragmentSrc);
    const coerced = coerceToVec4(target.expr, kind);
    const injected = `    fragColor = ${coerced};\n    return;`;

    // Determine whether the shader is single-output (has a `fragColor` out) or MRT. If MRT, we inject
    // our own fragColor output and strip the MRT out declarations' influence (they stay declared).
    const hasFragColorOut = /\blayout\s*\(\s*location\s*=\s*0\s*\)\s*out\s+vec4\s+fragColor\s*;/.test(beforeMain);

    // Header: keep everything before main() (varyings, UBOs, samplers, out decls, functions), then
    // guarantee a location-0 `out vec4 fragColor;`. For MRT there's no fragColor, so add one — but a
    // location-0 MRT output would collide, so rename any existing location-0 MRT out to a dummy.
    let header = beforeMain;
    if (!hasFragColorOut) {
        // Neutralise any existing location 0 output (MRT case) to free the slot, then add fragColor.
        header = header.replace(
            /\blayout\s*\(\s*location\s*=\s*0\s*\)\s*out\s+vec4\s+(\w+)\s*;/,
            'layout(location = 0) out vec4 fragColor; // probe (was: $1)',
        );
        if (!/\bout\s+vec4\s+fragColor\s*;/.test(header)) {
            // No location-0 output at all: append a fresh fragColor out.
            header = `${header.trimEnd()}\nlayout(location = 0) out vec4 fragColor;\n`;
        }
    }

    // Walk the body, truncating at the anchor and injecting the probe write.
    const kept: string[] = [];
    let found = false;

    for (const rawLine of bodyLines) {
        if (found) break;
        const trimmed = rawLine.trim();

        // Drop the shader's own output assignments — they conflict with the probe write. For a
        // `return`/`assignment` anchor the assignment line IS where we inject; for a `let_var` anchor
        // we inject after the declaration and stop, so we never reach these anyway.
        const isFragColorAssign = /^fragColor\s*=/.test(trimmed);
        const isMrtOutAssign = /^\w+\s*=\s*/.test(trimmed) && !/^(?:float|int|uint|bool|vec[234]|ivec[234]|uvec[234]|bvec[234]|mat[234])/.test(trimmed);

        switch (target.anchorKind) {
            case 'return': {
                // GLSL main() has no `return <expr>` for the color; the "return" anchor from the WGSL
                // shape maps to the final output assignment. Inject at the first output write.
                if (isFragColorAssign || (isMrtOutAssign && !hasFragColorOut)) {
                    kept.push(injected);
                    found = true;
                } else {
                    kept.push(rawLine);
                }
                break;
            }
            case 'let_var': {
                kept.push(rawLine);
                // Anchor identifier: `<type> <anchor> = …;` OR `<type> <anchor>[N] = …;`.
                const isTarget = new RegExp(`^\\w+\\s+${escapeRegex(target.anchor)}\\s*(?:\\[[^\\]]*\\])?\\s*=`).test(trimmed);
                if (isTarget) {
                    kept.push(injected);
                    found = true;
                }
                break;
            }
            case 'assignment': {
                // The anchor is the full trimmed source line. Replace it with the probe write when the
                // expression being probed is that line's RHS; otherwise keep the line and inject when we
                // reach it. Since the emitted GLSL uses `fragColor = <expr>;` / `<name> = <expr>;`, the
                // assignment target line matches by exact trimmed text.
                if (trimmed === target.anchor) {
                    kept.push(injected);
                    found = true;
                } else {
                    kept.push(rawLine);
                }
                break;
            }
        }
    }

    // Fallback: if the anchor was never matched but the target is a bare identifier that IS declared
    // in the body, inject right after its declaration (covers minor whitespace/format drift).
    if (!found && /^\w+$/.test(target.expr)) {
        const declRe = new RegExp(`^\\s*\\w+\\s+${escapeRegex(target.expr)}\\s*(?:\\[[^\\]]*\\])?\\s*=`);
        const rebuilt: string[] = [];
        for (const rawLine of bodyLines) {
            rebuilt.push(rawLine);
            if (!found && declRe.test(rawLine)) {
                rebuilt.push(injected);
                found = true;
            }
        }
        if (found) {
            kept.length = 0;
            for (const l of rebuilt) {
                kept.push(l);
                if (l === injected) break;
            }
        }
    }

    if (!found) return null;

    const patchedMain = ['void main() {', ...kept, '}'].join('\n');
    const fragment = `${header.trimEnd()}\n\n${patchedMain}\n`;

    return { fragment, kind };
}
