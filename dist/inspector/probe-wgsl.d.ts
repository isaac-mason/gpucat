/**
 * probe-wgsl.ts, WGSL string patching helpers for the shader value probe.
 *
 * The probe re-uses the source mesh's vertex shader verbatim (including camera
 * transforms) so that the probe canvas renders the mesh from the real camera's
 * point of view.  Only fs_main is patched to output a single vec4f showing the
 * chosen intermediate variable.
 */
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
export declare function extractProbeTarget(line: string): ProbeTarget | null;
/** Backwards-compat shim used by shader-panel hover logic. */
export declare function extractProbeVar(line: string): string | null;
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
export declare function buildProbeWGSL(code: string, target: ProbeTarget): string | null;
