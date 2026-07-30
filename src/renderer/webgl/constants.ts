/**
 * constants.ts (webgl) - small shared constants for the WebGL2 backend.
 */

/**
 * The stage separator the GLSL emitter writes between the vertex and fragment source (see builder.ts
 * `compileGlsl`). `programs.ts` and `probe.ts` split the combined `code` on it.
 */
export const FRAGMENT_STAGE_MARKER = '// ---- fragment stage ----';
