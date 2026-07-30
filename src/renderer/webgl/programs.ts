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
import { FRAGMENT_STAGE_MARKER } from './constants';

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
};

/** Program cache, keyed by the combined GLSL source string. */
export type ProgramCache = {
    programs: Map<string, ProgramInfo>;
};

/** Create an empty program cache. */
export function createProgramCache(): ProgramCache {
    return { programs: new Map() };
}

/** Split the emitter's combined `code` into its vertex and fragment sources. */
function splitStages(code: string): { vertex: string; fragment: string } {
    const idx = code.indexOf(FRAGMENT_STAGE_MARKER);
    if (idx === -1) {
        // Depth-only / fragment-less material: the emitter emits no fragment stage. Provide a trivial
        // fragment shader so the program still links (WebGL2 has no fragment-less rasterization).
        return {
            vertex: code,
            fragment: '#version 300 es\nprecision highp float;\nvoid main() {}',
        };
    }
    return {
        vertex: code.slice(0, idx).trimEnd(),
        // Skip past the marker line to the start of the fragment source.
        fragment: code.slice(idx + FRAGMENT_STAGE_MARKER.length).trimStart(),
    };
}

/** Compile one shader stage, throwing with the info log (and source) on failure. */
function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('[WebGLRenderer] gl.createShader returned null.');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        const stage = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
        throw new Error(`[WebGLRenderer] ${stage} shader compile failed:\n${log}\n---- source ----\n${source}`);
    }
    return shader;
}

/**
 * Get (or compile + link + cache) the GL program for a compiled material.
 *
 * @param gl the WebGL2 context
 * @param cache the program cache
 * @param code the combined GLSL source from `compileGlsl` (`nodeBuilderState.vertexCode`)
 * @param uniformGroups the compiled uniform groups, used to resolve + bind each UBO block index
 */
export function getProgram(
    gl: WebGL2RenderingContext,
    cache: ProgramCache,
    code: string,
    uniformGroups: UniformGroupBlock[],
): ProgramInfo {
    const existing = cache.programs.get(code);
    if (existing) return existing;

    const { vertex, fragment } = splitStages(code);

    const vs = compileShader(gl, gl.VERTEX_SHADER, vertex);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragment);

    const program = gl.createProgram();
    if (!program) throw new Error('[WebGLRenderer] gl.createProgram returned null.');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    // Shaders can be detached+deleted after link — the program keeps the linked binary.
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program);
        gl.deleteProgram(program);
        throw new Error(`[WebGLRenderer] program link failed:\n${log}`);
    }

    // Resolve each std140 UBO block and assign it a unique binding point. The GLSL emitter always
    // writes `binding: 0` on every group (it never emits explicit binding qualifiers), so we can't
    // reuse that — assign a fresh binding point per distinct group name instead.
    const uboBindingPoints = new Map<string, number>();
    let nextBindingPoint = 0;
    for (const group of uniformGroups) {
        if (group.members.length === 0) continue;
        if (uboBindingPoints.has(group.groupName)) continue;

        const blockName = `Uniforms_${group.groupName}`;
        const blockIndex = gl.getUniformBlockIndex(program, blockName);
        // INVALID_INDEX (0xffffffff) means the block was optimized out (all members unused). Skip it.
        if (blockIndex === gl.INVALID_INDEX) continue;

        const bindingPoint = nextBindingPoint++;
        gl.uniformBlockBinding(program, blockIndex, bindingPoint);
        uboBindingPoints.set(group.groupName, bindingPoint);
    }

    const info: ProgramInfo = { program, uboBindingPoints, samplerLocations: new Map() };
    cache.programs.set(code, info);
    return info;
}

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
export function createTransformFeedbackProgram(
    gl: WebGL2RenderingContext,
    vertex: string,
    fragment: string,
    feedbackVaryings: string[],
    uniformGroups: UniformGroupBlock[],
): ProgramInfo {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vertex);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragment);

    const program = gl.createProgram();
    if (!program) throw new Error('[WebGLRenderer] gl.createProgram returned null.');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);

    // The captured varyings MUST be declared before linkProgram, or the link ignores them.
    gl.transformFeedbackVaryings(program, feedbackVaryings, gl.SEPARATE_ATTRIBS);
    gl.linkProgram(program);

    gl.deleteShader(vs);
    gl.deleteShader(fs);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program);
        gl.deleteProgram(program);
        throw new Error(`[WebGLRenderer] transform-feedback program link failed:\n${log}`);
    }

    // Same std140 UBO binding-point resolution as getProgram, so kernels using uniform() work.
    const uboBindingPoints = new Map<string, number>();
    let nextBindingPoint = 0;
    for (const group of uniformGroups) {
        if (group.members.length === 0) continue;
        if (uboBindingPoints.has(group.groupName)) continue;

        const blockName = `Uniforms_${group.groupName}`;
        const blockIndex = gl.getUniformBlockIndex(program, blockName);
        if (blockIndex === gl.INVALID_INDEX) continue;

        const bindingPoint = nextBindingPoint++;
        gl.uniformBlockBinding(program, blockIndex, bindingPoint);
        uboBindingPoints.set(group.groupName, bindingPoint);
    }

    return { program, uboBindingPoints, samplerLocations: new Map() };
}

/** Delete all cached programs (called on renderer dispose). */
export function disposePrograms(gl: WebGL2RenderingContext, cache: ProgramCache): void {
    for (const { program } of cache.programs.values()) {
        gl.deleteProgram(program);
    }
    cache.programs.clear();
}

/** Number of linked GL programs currently cached. */
export function getProgramCacheStats(cache: ProgramCache): { programCount: number } {
    return { programCount: cache.programs.size };
}
