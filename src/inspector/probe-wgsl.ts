/**
 * probe-wgsl.ts — WGSL string patching helpers for the shader value probe.
 *
 * The probe re-uses the source mesh's vertex shader verbatim (including camera
 * transforms) so that the probe canvas renders the mesh from the real camera's
 * point of view.  Only fs_main is patched to output a single vec4f showing the
 * chosen intermediate variable.
 */

// ---------------------------------------------------------------------------
// ProbeTarget — what to probe from a hovered line
// ---------------------------------------------------------------------------

export type ProbeTarget = {
    /**
     * The WGSL expression to evaluate and display.
     * e.g. `_v3`, `textureSample(tex, samp, in.uv)`, `_v1 * 2.0`
     */
    expr: string;

    /**
     * The anchor identifier used to locate the cutoff line in the body.
     * For `let _vN = expr` lines this is `_vN`.
     * For assignment lines (`_out.color = expr`) this is the full trimmed line text
     * so the body walker can find the exact line.
     * For return-expression lines this is a sentinel `'__return__'`.
     */
    anchor: string;

    /** How to find the cutoff: 'let_var' | 'assignment' | 'return' */
    anchorKind: 'let_var' | 'assignment' | 'return';
};

// ---------------------------------------------------------------------------
// extractProbeTarget — parse a hovered WGSL line into a ProbeTarget
// ---------------------------------------------------------------------------

/**
 * Given the raw text of a single WGSL source line, return a ProbeTarget
 * describing what expression to probe and where to truncate the body,
 * or null if the line is not probeable.
 *
 * Supported patterns (all with optional leading whitespace):
 *   let _vN = <expr>;               → probe _vN, anchor on let line
 *   var name : type = <expr>;       → probe name, anchor on var line
 *   name = <expr>;                  → probe <expr>, anchor on this line
 *   _out.field = <expr>;            → probe <expr>, anchor on this line
 *   out.field = <expr>;             → probe <expr>, anchor on this line
 *   return <expr>;                  → probe <expr>, anchor on return
 */
export function extractProbeTarget(line: string): ProbeTarget | null {
    const trimmed = line.trim();

    // Skip blank / comments / structural lines
    if (!trimmed) return null;
    if (trimmed.startsWith('//') || trimmed.startsWith('/*')) return null;
    if (
        trimmed.startsWith('struct ') ||
        trimmed.startsWith('@') ||
        trimmed.startsWith('fn ') ||
        trimmed === '{' ||
        trimmed === '}'
    ) return null;

    // Skip lines that produce nothing useful to probe
    if (trimmed === 'discard;' || trimmed.startsWith('if (!(')) return null;
    if (/^var\s+\w+\s*:\s*FragmentOutput\s*;/.test(trimmed)) return null;
    if (/^var\s+\w+\s*:\s*VertexOutput\s*;/.test(trimmed)) return null;

    // `let identifier [: type] = <expr>;`
    const letMatch = trimmed.match(/^let\s+(\w+)\s*(?::\s*[\w<>, ]+\s*)?=\s*([\s\S]+?)\s*;?\s*$/);
    if (letMatch) {
        return { expr: letMatch[1], anchor: letMatch[1], anchorKind: 'let_var' };
    }

    // `var identifier [: type] [= <expr>];`  — only probe if there's an initialiser
    const varMatch = trimmed.match(/^var\s+(\w+)\s*(?::\s*[\w<>, ]+\s*)?=\s*([\s\S]+?)\s*;?\s*$/);
    if (varMatch) {
        return { expr: varMatch[1], anchor: varMatch[1], anchorKind: 'let_var' };
    }

    // `return <expr>;`
    const returnMatch = trimmed.match(/^return\s+([\s\S]+?)\s*;?\s*$/);
    if (returnMatch) {
        const retExpr = returnMatch[1];
        // Skip `return _out;` — _out is a FragmentOutput struct, not a vec value
        if (/^\w+$/.test(retExpr) && retExpr.startsWith('_out')) return null;
        return { expr: retExpr, anchor: '__return__', anchorKind: 'return' };
    }

    // `<lhs> = <rhs>;`  — any assignment: covers `_out.color = _v2`, `out.pos = _v0`, `myVar = expr`
    const assignMatch = trimmed.match(/^([\w.[\]]+)\s*=\s*([\s\S]+?)\s*;?\s*$/);
    if (assignMatch) {
        const rhs = assignMatch[2];
        return { expr: rhs, anchor: trimmed, anchorKind: 'assignment' };
    }

    return null;
}

/** Backwards-compat shim used by shader-panel hover logic. */
export function extractProbeVar(line: string): string | null {
    return extractProbeTarget(line)?.expr ?? null;
}

// ---------------------------------------------------------------------------
// Type inference helpers
// ---------------------------------------------------------------------------

/**
 * Extract the first comma-separated argument from a string that begins
 * immediately after the opening paren of a function call.
 * Tracks paren/bracket/angle depth so nested calls are handled correctly.
 *
 * e.g. `extractFirstArg("vec3f(1,2,3), 0.0, 1.0)")` → `"vec3f(1,2,3)"`
 */
function extractFirstArg(s: string): string | null {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '(' || ch === '[' || ch === '<') { depth++; continue; }
        if (ch === ')' || ch === ']' || ch === '>') {
            if (depth === 0) return s.slice(0, i).trim() || null;
            depth--;
            continue;
        }
        if (ch === ',' && depth === 0) return s.slice(0, i).trim() || null;
    }
    return s.trim() || null;
}

/**
 * Remove one layer of balanced outer parentheses if they wrap the whole string.
 * `((a + b))` → `(a + b)` → caller will recurse again.
 */
function stripOuterParens(s: string): string {
    if (!s.startsWith('(') || !s.endsWith(')')) return s;
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '(') depth++;
        else if (s[i] === ')') {
            depth--;
            if (depth === 0 && i < s.length - 1) return s; // closing paren is not the last char
        }
    }
    return s.slice(1, -1).trim();
}

// ---------------------------------------------------------------------------
// Type inference — figure out WGSL component type from an expression
// ---------------------------------------------------------------------------

type WgslVecKind = 'vec4f' | 'vec3f' | 'vec2f' | 'f32' | 'i32' | 'u32' | 'bool' | 'unknown';

/**
 * Infer the WGSL type of a value expression from its syntax.
 * Scans the expression prefix and any `var name : type;` declarations
 * found in the full WGSL body.
 *
 * This is intentionally best-effort — unknown falls back to vec4f coercion.
 */
function inferType(expr: string, fullBody: string, varDecls: Map<string, string>): WgslVecKind {
    const e = expr.trim();

    // Direct lookup from `var name : type;` declarations in the body
    if (/^\w+$/.test(e) && varDecls.has(e)) {
        return normaliseType(varDecls.get(e)!);
    }

    // Constructor prefix: vec4f(...), vec3f(...), vec2f(...), f32(...), etc.
    const ctorMatch = e.match(/^(vec4[fi]?|vec3[fi]?|vec2[fi]?|vec4|vec3|vec2|f32|f16|i32|u32|bool)\s*[(<]/);
    if (ctorMatch) return normaliseType(ctorMatch[1]);

    // texture* functions always return vec4f
    if (/^texture(Sample|Load|Fetch)\b/.test(e)) return 'vec4f';

    // Strictly scalar builtins (always return f32 regardless of arg types)
    if (/^(dot|length|distance|determinant)\s*\(/.test(e)) return 'f32';

    // Builtins that return a bool
    if (/^(any|all)\s*\(/.test(e)) return 'bool';

    // Builtins that return same type as their first argument (polymorphic).
    // We recurse into the first argument to propagate the type properly.
    const polyMatch = e.match(/^(abs|acos|asin|atan|atan2|ceil|clamp|cos|degrees|exp|exp2|floor|fract|inverseSqrt|log|log2|max|min|mix|modf|normalize|pow|radians|reflect|refract|cross|round|select|sign|sin|smoothstep|sqrt|step|tan|trunc|fma)\s*\(/);
    if (polyMatch) {
        const afterParen = e.slice(polyMatch[0].length);
        const firstArg = extractFirstArg(afterParen);
        if (firstArg) {
            const inner = inferType(firstArg, fullBody, varDecls);
            if (inner !== 'unknown') return inner;
        }
    }

    // Strip outer parentheses and retry (handles `((a * b) + c)` style exprs)
    const stripped = stripOuterParens(e);
    if (stripped !== e) return inferType(stripped, fullBody, varDecls);

    // Arithmetic / compound expression — walk tokens to find a typed operand.
    // The first word token that resolves via varDecls wins.
    const firstToken = e.match(/^(\w+)/)?.[1];
    if (firstToken && varDecls.has(firstToken)) {
        return normaliseType(varDecls.get(firstToken)!);
    }

    // Scan the full body for `let name = <constructor>(...)`
    if (/^\w+$/.test(e)) {
        const letRe = new RegExp(`\\blet\\s+${escapeRegex(e)}\\s*=\\s*((vec4[fi]?|vec3[fi]?|vec2[fi]?|vec4|vec3|vec2|f32|f16|i32|u32|bool)\\s*[(<])`);
        const m = fullBody.match(letRe);
        if (m) return normaliseType(m[2]);
    }

    // Scan expression for any vec constructor literal — catches `(a * vec3f(...) + b)` etc.
    const vecInExpr = e.match(/\b(vec4[fi]?|vec3[fi]?|vec2[fi]?|vec4f|vec3f|vec2f|vec4|vec3|vec2)\s*\(/);
    if (vecInExpr) return normaliseType(vecInExpr[1]);

    // Scan expression for any var whose type we know
    for (const [name, type] of varDecls) {
        if (new RegExp(`\\b${escapeRegex(name)}\\b`).test(e)) {
            return normaliseType(type);
        }
    }

    return 'unknown';
}

function normaliseType(t: string): WgslVecKind {
    if (t.startsWith('vec4')) return 'vec4f';
    if (t.startsWith('vec3')) return 'vec3f';
    if (t.startsWith('vec2')) return 'vec2f';
    if (t === 'f32' || t === 'f16') return 'f32';
    if (t === 'i32') return 'i32';
    if (t === 'u32') return 'u32';
    if (t === 'bool') return 'bool';
    return 'unknown';
}

/**
 * Emit the WGSL expression that converts a value of the given inferred type
 * into a `vec4f` suitable for the probe render target.
 */
function coerceToVec4f(expr: string, kind: WgslVecKind): string {
    switch (kind) {
        case 'vec4f': return `(${expr})`;
        case 'vec3f': return `vec4f((${expr}), 1.0f)`;
        case 'vec2f': return `vec4f((${expr}), 0.0f, 1.0f)`;
        case 'f32':   return `vec4f(vec3f(${expr}), 1.0f)`;
        case 'i32':   return `vec4f(vec3f(f32(${expr})), 1.0f)`;
        case 'u32':   return `vec4f(vec3f(f32(${expr})), 1.0f)`;
        case 'bool':  return `vec4f(vec3f(f32(${expr})), 1.0f)`;
        // unknown — attempt a direct vec4f cast. Works if the expression is
        // actually a vec4f. If it's vec3f the shader error will be clear.
        // Explicit 1.0f avoids abstract-float overload ambiguity.
        default:      return `vec4f((${expr}), 1.0f)`;
    }
}

// ---------------------------------------------------------------------------
// buildProbeWGSL — patch combined WGSL to output a single probe variable
// ---------------------------------------------------------------------------

/**
 * Patch the combined WGSL emitted by compile.ts so that:
 *  1. Everything up to and including the original vs_main is kept verbatim.
 *     The probe uses the real vertex shader so the mesh renders correctly
 *     from the camera's point of view with proper transforms.
 *  2. fs_main is truncated at the target line and its return is replaced with
 *     a type-safe `return <coercion>;`.
 *  3. The function return type is changed to `-> @location(0) vec4f`.
 *  4. FragmentOutput / VertexOutput struct var declarations in the body are stripped.
 *
 * Returns the patched WGSL string, or null if patching fails.
 */
export function buildProbeWGSL(code: string, target: ProbeTarget): string | null {
    // -----------------------------------------------------------------------
    // 1. Locate @fragment entry-point.
    // -----------------------------------------------------------------------
    const fragmentAttrRe = /(?:^|\n)(@fragment\s*\n)/;
    const fragmentAttrMatch = code.match(fragmentAttrRe);
    if (!fragmentAttrMatch || fragmentAttrMatch.index === undefined) return null;
    const fsStart = fragmentAttrMatch.index + (fragmentAttrMatch[0].length - fragmentAttrMatch[1].length);

    // -----------------------------------------------------------------------
    // 2. Everything before @fragment is kept verbatim (preamble + vs_main).
    // -----------------------------------------------------------------------
    const beforeFs = code.slice(0, fsStart).trimEnd();

    // -----------------------------------------------------------------------
    // 3. Locate fs_main body start and capture original parameter list.
    // -----------------------------------------------------------------------
    const fsSection = code.slice(fsStart);
    const fnHeaderMatch = fsSection.match(/fn\s+fs_main\s*\([^)]*\)\s*->(?:[^{]*)\{/);
    if (!fnHeaderMatch || fnHeaderMatch.index === undefined) return null;

    // Keep the original parameter (e.g. "in : FragmentInput") so in.xxx refs work.
    const fnHeaderParamMatch = fsSection.match(/fn\s+fs_main\s*\(([^)]*)\)/);
    const fsParam = fnHeaderParamMatch ? fnHeaderParamMatch[1].trim() : '';

    const bodyStart = fsStart + fnHeaderMatch.index + fnHeaderMatch[0].length;
    const rawBody = code.slice(bodyStart);
    const bodyLines = rawBody.split('\n');

    // -----------------------------------------------------------------------
    // 4. Build var-decl map from `var name : type;` lines in the full body.
    // -----------------------------------------------------------------------
    const varDecls = new Map<string, string>();
    for (const bl of bodyLines) {
        const vm = bl.trim().match(/^var\s+(\w+)\s*:\s*([\w<>, ]+?)\s*;/);
        if (vm) varDecls.set(vm[1], vm[2]);
    }

    // -----------------------------------------------------------------------
    // 5. Walk the body lines, collecting up to (and including) the target.
    // -----------------------------------------------------------------------
    const keptLines: string[] = [];
    let found = false;

    for (const bodyLine of bodyLines) {
        const trimmed = bodyLine.trim();

        // Stop at closing brace of fs_main
        if (trimmed === '}') break;

        // Always strip FragmentOutput / VertexOutput struct var declarations
        if (/^var\s+\w+\s*:\s*(?:Fragment|Vertex)Output\s*;/.test(trimmed)) continue;

        switch (target.anchorKind) {
            case 'return':
                if (trimmed.startsWith('return')) {
                    found = true;
                    // don't push — we inject our own return
                } else {
                    keptLines.push(bodyLine);
                }
                break;

            case 'let_var': {
                keptLines.push(bodyLine);
                const isTarget = new RegExp(`^(?:let|var)\\s+${escapeRegex(target.anchor)}\\b`).test(trimmed);
                if (isTarget) { found = true; }
                break;
            }

            case 'assignment': {
                keptLines.push(bodyLine);
                if (trimmed === target.anchor) { found = true; }
                break;
            }
        }

        if (found) break;
    }

    if (!found) return null;

    // -----------------------------------------------------------------------
    // 6. Infer the type of the probed expression and emit safe coercion.
    // -----------------------------------------------------------------------
    const kind = inferType(target.expr, rawBody, varDecls);
    const returnVec4 = coerceToVec4f(target.expr, kind);

    // -----------------------------------------------------------------------
    // 7. Assemble patched fs_main.
    // -----------------------------------------------------------------------
    const probeFsBody = keptLines.join('\n');
    const probeFsMain = [
        `@fragment`,
        `fn fs_main(${fsParam}) -> @location(0) vec4f {`,
        probeFsBody,
        `    return ${returnVec4};`,
        `}`,
    ].join('\n');

    // -----------------------------------------------------------------------
    // 8. Final assembly: original preamble + vs_main, then patched fs_main.
    // -----------------------------------------------------------------------
    return [beforeFs, '', probeFsMain].join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
