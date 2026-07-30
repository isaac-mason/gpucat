/**
 * programs.ts (webgl) - GLSL program compile/link + cache.
 *
 * Ports the reference renderer's `compile()` program half: create+compile a vertex and fragment
 * shader, attach + link, and check COMPILE_STATUS/LINK_STATUS (throwing with the info log on
 * failure). The GLSL emitter returns a single combined `code` string with the two stages separated
 * by a `// ---- fragment stage ----` marker (see builder.ts `compileGlsl`); we split on it.
 *
 * gpucat's GLSL emitter declares uniforms as `layout(std140) uniform <Block> { … } <inst>;` and
 * attributes as `layout(location=N) in …`, so attribute locations are known at emit time (no
 * `getAttribLocation`). For each UBO block we still resolve its block index via
 * `getUniformBlockIndex` and bind it to a chosen binding point via `uniformBlockBinding`.
 *
 * The program is keyed by the combined shader source: the source is a pure function of the material
 * node graph, so identical materials share one program (analogous to how the WebGPU path shares a
 * pipeline by its cache key).
 */
import type { UniformGroupBlock } from '../../nodes/builder';
/** A linked GL program plus the resolved per-group UBO binding points. */
export type ProgramInfo = {
    program: WebGLProgram;
    /**
     * Map from uniform group name (the `groupName` on `UniformGroupBlock`, e.g. 'render') to the GL
     * uniform-buffer binding point it was bound to. The draw path binds each group's UBO to this
     * point via `bindBufferBase`.
     */
    uboBindingPoints: Map<string, number>;
    /**
     * Cached combined-sampler uniform locations, keyed by the sampler-uniform name (`u_<textureId>`).
     * Resolved lazily on first draw (needs the location, which is a linked-program property). A
     * cached `null` means the sampler was optimized out / not found — the draw path skips it.
     */
    samplerLocations: Map<string, WebGLUniformLocation | null>;
    /**
     * Location of the batched-draw base uniform (`u_drawBase`), or `null` when the program doesn't
     * use `instanceIndex` (so the uniform isn't declared). Resolved at link time. The batched draw
     * loop sets it per sub-draw (`firstInstance`); the single-draw path resets it to 0.
     */
    drawBaseLocation?: WebGLUniformLocation | null;
};
/** Program cache, keyed by the combined GLSL source string. */
export type ProgramCache = {
    programs: Map<string, ProgramInfo>;
};
/** Create an empty program cache. */
export declare function createProgramCache(): ProgramCache;
/**
 * Get (or compile + link + cache) the GL program for a compiled material.
 *
 * @param gl the WebGL2 context
 * @param cache the program cache
 * @param code the combined GLSL source from `compileGlsl` (`nodeBuilderState.vertexCode`)
 * @param uniformGroups the compiled uniform groups, used to resolve + bind each UBO block index
 */
export declare function getProgram(gl: WebGL2RenderingContext, cache: ProgramCache, code: string, uniformGroups: UniformGroupBlock[]): ProgramInfo;
/**
 * Compile + link a transform-feedback program: a vertex shader whose captured varyings are declared
 * to the linker via `gl.transformFeedbackVaryings(program, varyings, SEPARATE_ATTRIBS)` BEFORE
 * `gl.linkProgram` (this ordering is mandatory — the varyings must be registered pre-link), plus a
 * no-op fragment shader (rasterization is discarded at run time but the program must still link).
 *
 * Unlike {@link getProgram}, this does NOT use the source-keyed program cache: the transform-feedback
 * runtime caches the linked program per {@link TransformFeedbackNode} itself (see
 * `webgl/transform-feedback.ts`), so this is a plain compile+link. Throws with the info log on
 * COMPILE/LINK failure.
 *
 * @param vertex the transform-feedback vertex GLSL (from `compileTransformFeedback().vertexCode`)
 * @param fragment the no-op fragment GLSL (from `compileTransformFeedback().fragmentCode`)
 * @param feedbackVaryings ordered captured-varying names (`v_<name>`) — the `SEPARATE_ATTRIBS` order
 *   that the run-site `bindBufferBase` order must match
 * @param uniformGroups the compiled uniform groups, used to resolve + bind each UBO block index
 */
export declare function createTransformFeedbackProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string, feedbackVaryings: string[], uniformGroups: UniformGroupBlock[]): ProgramInfo;
/** Delete all cached programs (called on renderer dispose). */
export declare function disposePrograms(gl: WebGL2RenderingContext, cache: ProgramCache): void;
/** Number of linked GL programs currently cached. */
export declare function getProgramCacheStats(cache: ProgramCache): {
    programCount: number;
};
