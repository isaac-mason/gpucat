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
// Type environment — struct field maps parsed from WGSL preamble
// ---------------------------------------------------------------------------

/**
 * Maps struct name → (field name → WGSL type string).
 * e.g. "FragmentInput" → { "v_uv": "vec2f", "v_norm": "vec3f", ... }
 */
type StructFieldMap = Map<string, Map<string, string>>;

/**
 * Parse every `struct Name { ... }` block out of the full WGSL source and
 * return a StructFieldMap.  Handles:
 *   - `@builtin(position) position : vec4f,`
 *   - `@location(N) [interpolation attrs] name : type,`
 *   - bare `name : type,` (no attribute)
 *
 * This is intentionally domain-specific to our own generated WGSL so we
 * don't need a full parser — we just need the structs compile.ts emits.
 */
function buildStructFieldMap(wgsl: string): StructFieldMap {
    const result: StructFieldMap = new Map();

    // Iterate over every `struct <Name> { ... }` block.
    // We do a depth-tracked scan so nested braces don't trip us up.
    const structRe = /\bstruct\s+(\w+)\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = structRe.exec(wgsl)) !== null) {
        const structName = m[1];
        const bodyStart = m.index + m[0].length;
        // Walk forward to find the matching closing brace
        let depth = 1;
        let i = bodyStart;
        while (i < wgsl.length && depth > 0) {
            if (wgsl[i] === '{') depth++;
            else if (wgsl[i] === '}') depth--;
            i++;
        }
        const body = wgsl.slice(bodyStart, i - 1);
        const fieldMap = new Map<string, string>();

        // Each field is one line: optional attrs, then `name : type,`
        for (const rawLine of body.split('\n')) {
            const line = rawLine.trim();
            if (!line || line.startsWith('//')) continue;
            // Strip leading attribute(s): @builtin(...), @location(N), @interpolate(...)
            const stripped = line.replace(/(?:@\w+\s*(?:\([^)]*\))?\s*)+/, '').trim();
            // Now expect `name : type[,]`
            const fieldMatch = stripped.match(/^(\w+)\s*:\s*([\w<>, ]+?)\s*,?\s*$/);
            if (fieldMatch) {
                fieldMap.set(fieldMatch[1], fieldMatch[2].trim());
            }
        }

        if (fieldMap.size > 0) result.set(structName, fieldMap);
    }

    return result;
}

// ---------------------------------------------------------------------------
// Type inference helpers
// ---------------------------------------------------------------------------

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
 * found in the full WGSL body.  Also resolves `in.fieldName` and
 * `_out.fieldName` via the struct field map parsed from the full WGSL.
 *
 * This is intentionally best-effort — unknown falls back to vec4f coercion.
 */
function inferType(
    expr: string,
    fullBody: string,
    varDecls: Map<string, string>,
    structFields: StructFieldMap,
): WgslVecKind {
    const e = expr.trim();

    // Direct lookup from `var name : type;` declarations in the body,
    // or from `in.fieldName` entries pre-seeded by buildProbeWGSL.
    if (/^\w+(?:\.\w+)?$/.test(e) && varDecls.has(e)) {
        return normaliseType(varDecls.get(e)!);
    }

    // Swizzle access: `in.v_norm.xyz`, `someVec.xy`, `_v0.x`, etc.
    // Resolve the base object type, then derive the swizzle result type.
    const swizzleMatch = e.match(/^([\w.]+)\.([xyzwrgba]{1,4})$/);
    if (swizzleMatch) {
        const [, base, swizzle] = swizzleMatch;
        const baseKind = inferType(base, fullBody, varDecls, structFields);
        if (baseKind !== 'unknown') {
            const swLen = swizzle.length;
            if (swLen === 1) return 'f32';
            if (swLen === 2) return 'vec2f';
            if (swLen === 3) return 'vec3f';
            if (swLen === 4) return 'vec4f';
        }
    }

    // `in.fieldName` — look up the FragmentInput struct (or any struct the
    // `in` parameter is typed as).  We also handle `_out.fieldName` via
    // FragmentOutput for completeness.
    const memberMatch = e.match(/^(\w+)\.(\w+)$/);
    if (memberMatch) {
        const [, objName, fieldName] = memberMatch;
        // Determine the struct name for this object by scanning the full WGSL
        // for the `fn fs_main(... objName : StructName ...)` parameter list.
        const paramRe = new RegExp(`\\b${escapeRegex(objName)}\\s*:\\s*(\\w+)\\b`);
        const paramMatch = fullBody.match(paramRe);
        if (paramMatch) {
            const structName = paramMatch[1];
            const fields = structFields.get(structName);
            if (fields?.has(fieldName)) {
                return normaliseType(fields.get(fieldName)!);
            }
        }
        // Fallback: try all structs for a field name match (covers unambiguous names)
        for (const fields of structFields.values()) {
            if (fields.has(fieldName)) {
                return normaliseType(fields.get(fieldName)!);
            }
        }
    }

    // Constructor prefix: vec4f(...), vec3f(...), vec2f(...), f32(...), etc.
    const ctorMatch = e.match(/^(vec4[fi]?|vec3[fi]?|vec2[fi]?|vec4|vec3|vec2|f32|f16|i32|u32|bool)\s*[(<]/);
    if (ctorMatch) return normaliseType(ctorMatch[1]);

    // texture* functions always return vec4f
    if (/^texture(Sample|Load|Fetch)\b/.test(e)) return 'vec4f';

    // Float / int literal: 0.0, -1.5, 3.14f, 0.5h → f32; 42u → u32; 42i → i32
    if (/^-?[0-9]*\.[0-9]+(?:[eE][+-]?[0-9]+)?[fh]?$/.test(e)) return 'f32';
    if (/^-?[0-9]+[fh]$/.test(e)) return 'f32';
    if (/^-?[0-9]+u$/.test(e)) return 'u32';
    if (/^-?[0-9]+i$/.test(e)) return 'i32';

    // Strictly scalar builtins (always return f32 regardless of arg types)
    if (/^(dot|length|distance|determinant)\s*\(/.test(e)) return 'f32';

    // Builtins that return a bool
    if (/^(any|all)\s*\(/.test(e)) return 'bool';

    // Builtins that return same type as their first argument (polymorphic).
    // We recurse into ALL arguments until we find a non-unknown type, because
    // the first arg may itself be unresolvable (e.g. a raw literal like 0.0
    // is abstract-float, but the second arg might be a typed variable).
    const polyMatch = e.match(/^(abs|acos|asin|atan|atan2|ceil|clamp|cos|degrees|exp|exp2|floor|fract|inverseSqrt|log|log2|max|min|mix|modf|normalize|pow|radians|reflect|refract|cross|round|select|sign|sin|smoothstep|sqrt|step|tan|trunc|fma)\s*\(/);
    if (polyMatch) {
        const afterOpen = e.slice(polyMatch[0].length);
        // Walk comma-separated args (depth-aware) and return first resolved type.
        let depth = 0;
        let argStart = 0;
        for (let i = 0; i <= afterOpen.length; i++) {
            const ch = afterOpen[i];
            if (ch === '(' || ch === '[' || ch === '<') { depth++; continue; }
            if (ch === ')' || ch === ']' || ch === '>') {
                if (depth === 0 || i === afterOpen.length) {
                    const arg = afterOpen.slice(argStart, i).trim();
                    if (arg) {
                        const t = inferType(arg, fullBody, varDecls, structFields);
                        if (t !== 'unknown') return t;
                    }
                    break;
                }
                depth--;
                continue;
            }
            if (ch === ',' && depth === 0) {
                const arg = afterOpen.slice(argStart, i).trim();
                if (arg) {
                    const t = inferType(arg, fullBody, varDecls, structFields);
                    if (t !== 'unknown') return t;
                }
                argStart = i + 1;
            }
        }
    }

    // Strip outer parentheses and retry (handles `((a * b) + c)` style exprs)
    const stripped = stripOuterParens(e);
    if (stripped !== e) return inferType(stripped, fullBody, varDecls, structFields);

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
        // unknown — pass through bare, same as fragcoord's fallback.
        // If the expression is already vec4f this is correct.  If it's
        // something else the shader compiler will surface a clear error
        // rather than silently emitting a wrong value (or failing with a
        // cryptic "wrong number of components" message from the extra 1.0f).
        default:      return `(${expr})`;
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
 *  2. A `return <coercion>;` is injected immediately after the target line
 *     in fs_main; remaining lines become dead code (WGSL allows unreachable
 *     statements after a return).
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
    // 4. Build var-decl map from `var name : type;` lines in the full body,
    //    and parse struct field maps from the full WGSL (for in.fieldName etc).
    // -----------------------------------------------------------------------
    const varDecls = new Map<string, string>();
    for (const bl of bodyLines) {
        const vm = bl.trim().match(/^var\s+(\w+)\s*:\s*([\w<>, ]+?)\s*;/);
        if (vm) varDecls.set(vm[1], vm[2]);
    }
    const structFields = buildStructFieldMap(code);

    // Expand varDecls with `obj.fieldName → type` entries from struct params.
    // This lets inferType resolve `in.v_elevation`, `in.v_norm`, etc. directly
    // via its plain varDecls lookup when the expression is `in.fieldName`.
    // fsParam is e.g. "in : FragmentInput" or "in : FragmentInput, ..."
    for (const paramDecl of fsParam.split(',')) {
        const pm = paramDecl.trim().match(/^(\w+)\s*:\s*(\w+)$/);
        if (!pm) continue;
        const [, paramName, structName] = pm;
        const fields = structFields.get(structName);
        if (!fields) continue;
        for (const [fieldName, fieldType] of fields) {
            varDecls.set(`${paramName}.${fieldName}`, fieldType);
        }
    }

    // -----------------------------------------------------------------------
    // 5. Infer the type of the probed expression and emit safe coercion.
    //    We do this before the walk so the injected return line is ready.
    // -----------------------------------------------------------------------
    const kind = inferType(target.expr, rawBody, varDecls, structFields);
    const returnVec4 = coerceToVec4f(target.expr, kind);
    const injectedReturn = `    return ${returnVec4};`;

    // -----------------------------------------------------------------------
    // 6. Walk ALL body lines using inject-and-early-return strategy.
    //
    //    Rather than truncating the function at the target line (which loses
    //    variable initialisations that appear later but are referenced in the
    //    probed expression), we keep every line and inject our `return` right
    //    after the anchor line.  Everything after the injected return is dead
    //    code — WGSL allows unreachable statements after a return.
    //
    //    This mirrors fragcoord.xyz's approach (insert fragColor = coerce(expr)
    //    at the cursor line, then keep the rest as dead code).
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
                    // Skip the original return line; inject ours in its place.
                    if (!found) {
                        keptLines.push(injectedReturn);
                        found = true;
                    }
                } else {
                    keptLines.push(bodyLine);
                }
                break;

            case 'let_var': {
                keptLines.push(bodyLine);
                if (!found) {
                    const isTarget = new RegExp(`^(?:let|var)\\s+${escapeRegex(target.anchor)}\\b`).test(trimmed);
                    if (isTarget) {
                        keptLines.push(injectedReturn);
                        found = true;
                    }
                }
                break;
            }

            case 'assignment': {
                keptLines.push(bodyLine);
                if (!found && trimmed === target.anchor) {
                    keptLines.push(injectedReturn);
                    found = true;
                }
                break;
            }
        }
    }

    if (!found) return null;

    // -----------------------------------------------------------------------
    // 7. Assemble patched fs_main.
    // -----------------------------------------------------------------------
    const probeFsBody = keptLines.join('\n');
    const probeFsMain = [
        `@fragment`,
        `fn fs_main(${fsParam}) -> @location(0) vec4f {`,
        probeFsBody,
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
