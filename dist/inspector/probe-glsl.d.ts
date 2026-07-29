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
import type { ProbeTarget } from './probe-wgsl';
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
export declare function extractGlslProbeTarget(line: string): ProbeTarget | null;
/** The GLSL component kinds the coercion understands. `unknown` falls back to a pass-through. */
export type GlslKind = 'float' | 'vec2' | 'vec3' | 'vec4' | 'int' | 'uint' | 'ivec2' | 'ivec3' | 'ivec4' | 'uvec2' | 'uvec3' | 'uvec4' | 'bool' | 'bvec2' | 'bvec3' | 'bvec4' | 'unknown';
/**
 * Infer the GLSL type of a probe target from the fragment source.
 *
 * The primary path is a direct declaration lookup: the emitter writes every CSE var / local as
 * `<glslType> <name> = …;`, so for a bare identifier target (`_v3`, `scaled`, …) we scan for its
 * declaration and read the leading type token. Failing that (e.g. a selected sub-expression or a
 * swizzle), we fall back to lightweight structural inference: constructor prefixes, texture calls,
 * literals, and trailing swizzles. Unresolvable targets return 'unknown' → pass-through coercion.
 */
export declare function inferGlslType(expr: string, fragmentSrc: string): GlslKind;
/**
 * A GLSL expression that widens a value of `kind` to a `vec4` for the location-0 color output.
 *   float→vec4(v,0,0,1)   vec2→vec4(v,0,1)   vec3→vec4(v,1)   vec4→v
 *   int/uint→vec4(float(v),0,0,1)            bool→vec4(v?1:0,0,0,1)
 *   ivecN/uvecN→vec4(vec_of_floats, …)       bvecN→vec4 of floats
 * `unknown` passes the expression through unchanged (already a vec4, or the compiler surfaces a clear
 * type error — the same fallback the WGSL probe uses).
 */
export declare function coerceToVec4(expr: string, kind: GlslKind): string;
/**
 * How many color components the coerced value meaningfully carries (drives readback decode). vec4
 * outputs carry 4, vec3/ivec3/… carry 3, and so on; scalars carry 1. `unknown` decodes as 4.
 */
export declare function componentCount(kind: GlslKind): number;
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
export declare function buildProbeGLSL(fragmentSrc: string, target: ProbeTarget): ProbeGlslResult | null;
