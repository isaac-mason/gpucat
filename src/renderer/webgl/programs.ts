/**
 * programs.ts (webgl) - GLSL program compile/link + cache.
 *
 * Create and compile a vertex and fragment shader, attach and link, and check
 * COMPILE_STATUS/LINK_STATUS, throwing with the info log on failure. The GLSL emitter returns a single combined `code` string with the two stages separated
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

import type { TextureEntry, UniformGroupBlock } from '../../nodes/builder';
import { FRAGMENT_STAGE_MARKER } from './constants';
import { deleteProgram, type GlState } from './state';
import {
    clearTextureHomes,
    createTextureHomes,
    linkProgramUnits,
    type ProgramUnits,
    releaseProgramUnits,
    type TextureHomes,
} from './texture-homes';

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
     * Each texture binding's uniforms on this program, keyed by the binding's shader name. Resolved on
     * the first draw that binds it (a location is a property of the linked program).
     */
    textureUniforms: Map<string, TextureUniforms>;
    /** The units its textures bind at (`texture-homes.ts`); null for a program no cache holds, which binds each at
     *  the unit the emitter numbered it. */
    units: ProgramUnits | null;
    /**
     * Location of the batched-draw base uniform (`u_drawBase`), or `null` when the program doesn't
     * use `instanceIndex` (so the uniform isn't declared). Resolved at link time. The batched draw
     * loop sets it per sub-draw (`firstInstance`); the single-draw path resets it to 0.
     */
    drawBaseLocation?: WebGLUniformLocation | null;
    /** Whether the instance index reads the multi-draw base table (`DrawBases`, at {@link DRAW_BASES_BINDING}). */
    drawBases?: boolean;
    /**
     * Location of the fragCoord Y-flip height uniform (`u_fragCoordFlipHeight`), or `null` when the
     * program doesn't use `@builtin(position)` (so the uniform isn't declared). The draw path sets it
     * to the current framebuffer height so gl_FragCoord / screenUV match WebGPU's top-left origin.
     */
    fragCoordFlipHeightLocation?: WebGLUniformLocation | null;
    /** The height last written to that uniform: a uniform's value is the program's, kept across passes. */
    fragCoordFlipHeight?: number;
    /**
     * For a program in the source cache, its source and the RenderObjects holding it: at 0 it is deleted, as three.js
     * releases a program at zero `usedTimes`. Null for a program no cache holds (a probe's, a kernel's).
     */
    source?: string;
    users?: number;
};

/**
 * A texture binding's uniforms on one program, and the values last written to them. A program keeps a
 * uniform's value until it is relinked, so a draw writes one only when the value moves.
 */
export type TextureUniforms = {
    /** The combined-sampler uniform (`u_<textureId>`); null when the program has none, being optimized out. */
    sampler: WebGLUniformLocation | null;
    /** The flipY uniform (`u_flipY_<textureId>`); null when the texture's samples weren't flip-wrapped (non-2D, or a storage read). */
    flip: WebGLUniformLocation | null;
    /** The texture unit `sampler` holds; -1 until first set. */
    unit: number;
    /** What `flip` holds, 1 or 0; -1 until first set. */
    flipped: number;
};

/** A program whose stages were compiled and linked without reading their status, which would wait for the driver. */
type PendingProgram = {
    program: WebGLProgram;
    vertex: WebGLShader;
    fragment: WebGLShader;
    vertexSource: string;
    fragmentSource: string;
};

/** From KHR_parallel_shader_compile: whether a program's link has finished, readable without waiting for it. */
const COMPLETION_STATUS_KHR = 0x91b1;

/** Program cache, keyed by the combined GLSL source string, and the texture homes its programs read. */
export type ProgramCache = {
    programs: Map<string, ProgramInfo>;
    /** Programs started by {@link startProgram} whose link nothing has read yet. */
    pending: Map<string, PendingProgram>;
    /** Whether the context has KHR_parallel_shader_compile, so a pending program can be asked if it is done. */
    parallel: boolean;
    homes: TextureHomes;
};

/** Create an empty program cache; its homes wait for the context's unit count ({@link setTextureUnitCount}). */
export function createProgramCache(): ProgramCache {
    return { programs: new Map(), pending: new Map(), parallel: false, homes: createTextureHomes(0) };
}

/** Turns on KHR_parallel_shader_compile, where the context has it: the driver then compiles programs on its own threads. */
export function enableParallelCompile(gl: WebGL2RenderingContext, cache: ProgramCache): void {
    cache.parallel = gl.getExtension('KHR_parallel_shader_compile') !== null;
}

/** Gives the cache's programs homes when the device has the units for them. */
export function setTextureUnitCount(cache: ProgramCache, maxCombinedUnits: number): void {
    cache.homes = createTextureHomes(maxCombinedUnits);
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
    const shader = startShader(gl, type, source);
    const error = shaderError(gl, shader, type, source);
    if (error !== null) {
        gl.deleteShader(shader);
        throw new Error(error);
    }
    return shader;
}

/** Issue one stage's compile without reading its status: a status read waits for the driver to finish it. */
function startShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('[webgl] gl.createShader returned null.');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
}

/** The message for a stage that failed to compile, with its info log and source; null when it compiled. */
function shaderError(gl: WebGL2RenderingContext, shader: WebGLShader, type: number, source: string): string | null {
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return null;
    const stage = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    return `[webgl] ${stage} shader compile failed:\n${gl.getShaderInfoLog(shader)}\n---- source ----\n${source}`;
}

/**
 * Issue the compile and link of `code`'s program without reading any status, as three.js's WebGL backends do: the
 * driver works on it while the caller starts others, and {@link getProgram} reads the result.
 */
export function startProgram(gl: WebGL2RenderingContext, cache: ProgramCache, code: string): void {
    if (cache.programs.has(code) || cache.pending.has(code)) return;
    const { vertex: vertexSource, fragment: fragmentSource } = splitStages(code);
    const vertex = startShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = startShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    if (!program) throw new Error('[webgl] gl.createProgram returned null.');
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    cache.pending.set(code, { program, vertex, fragment, vertexSource, fragmentSource });
}

/**
 * Resolves once every started program has finished linking, polled every 10 ms as three.js's `compileAsync` does: a
 * frame callback would never run in a hidden tab, and a yield would spin the main thread while the driver works.
 * Without KHR_parallel_shader_compile nothing can be asked, so it resolves at once and the first read waits instead.
 */
export function whenProgramsLinked(gl: WebGL2RenderingContext, cache: ProgramCache): Promise<void> {
    if (!cache.parallel) return Promise.resolve();
    return new Promise((resolve) => {
        const check = () => {
            // a lost context answers null for every program, which would never read as done
            if (gl.isContextLost()) return resolve();
            for (const pending of cache.pending.values()) {
                if (gl.getProgramParameter(pending.program, COMPLETION_STATUS_KHR) !== true) {
                    setTimeout(check, 10);
                    return;
                }
            }
            resolve();
        };
        check();
    });
}

/**
 * Get (or compile + link + cache) the GL program for a compiled material. A program {@link startProgram} began is
 * finished here, which waits for the driver only if its link is still running.
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
    textures: readonly TextureEntry[],
): ProgramInfo {
    const existing = cache.programs.get(code);
    if (existing) return existing;

    startProgram(gl, cache, code);
    const { program, vertex, fragment, vertexSource, fragmentSource } = cache.pending.get(code)!;
    cache.pending.delete(code);

    // the stages' logs are only read for a failed link, which is where three.js reads them too
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const error =
            shaderError(gl, vertex, gl.VERTEX_SHADER, vertexSource) ??
            shaderError(gl, fragment, gl.FRAGMENT_SHADER, fragmentSource) ??
            `[webgl] program link failed:\n${gl.getProgramInfoLog(program)}`;
        gl.deleteShader(vertex);
        gl.deleteShader(fragment);
        gl.deleteProgram(program);
        throw new Error(error);
    }

    // Shaders can be detached+deleted after link — the program keeps the linked binary.
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);

    const uboBindingPoints = bindUniformBlocks(gl, program, uniformGroups);
    const drawBases = bindDrawBases(gl, program);

    // Batched-draw base uniform. `getUniformLocation` returns null when u_drawBase isn't declared
    // (program doesn't use instanceIndex) — that null is the draw path's "no batched base" sentinel.
    const drawBaseLocation = gl.getUniformLocation(program, 'u_drawBase');

    // fragCoord Y-flip height. null when @builtin(position) isn't used (uniform not declared) — the
    // draw path's "no flip uniform to set" sentinel.
    const fragCoordFlipHeightLocation = gl.getUniformLocation(program, 'u_fragCoordFlipHeight');

    const info: ProgramInfo = {
        program,
        uboBindingPoints,
        textureUniforms: new Map(),
        units: linkProgramUnits(cache.homes, textures),
        drawBaseLocation,
        drawBases,
        fragCoordFlipHeightLocation,
        fragCoordFlipHeight: -1,
        source: code,
        users: 0,
    };
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
    if (!program) throw new Error('[webgl] gl.createProgram returned null.');
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
        throw new Error(`[webgl] transform-feedback program link failed:\n${log}`);
    }

    // Same std140 UBO binding points as getProgram, so kernels using uniform() work.
    const uboBindingPoints = bindUniformBlocks(gl, program, uniformGroups);

    return { program, uboBindingPoints, textureUniforms: new Map(), units: null };
}

/**
 * Where the multi-draw base table binds: WebGL2 guarantees 24 uniform buffer binding points, and the groups take the
 * ones below this.
 */
export const DRAW_BASES_BINDING = 23;

/**
 * Binds each std140 group block of `program` at its group's index, the same point in every program, as WebGPU's fixed
 * @group indices and PlayCanvas's WebGL bind groups: a block shared across programs (the frame's, the view's) stays
 * bound across a program switch. A block optimised out of the program is skipped.
 */
export function bindUniformBlocks(
    gl: WebGL2RenderingContext,
    program: WebGLProgram,
    uniformGroups: UniformGroupBlock[],
): Map<string, number> {
    const bindingPoints = new Map<string, number>();
    for (const group of uniformGroups) {
        if (group.members.length === 0 || bindingPoints.has(group.groupName)) continue;
        if (group.groupIndex >= DRAW_BASES_BINDING) {
            throw new Error(
                `[webgl] uniform group '${group.groupName}' is at @group(${group.groupIndex}); WebGL binds groups below ${DRAW_BASES_BINDING}`,
            );
        }
        const blockIndex = gl.getUniformBlockIndex(program, `Uniforms_${group.groupName}`);
        if (blockIndex === gl.INVALID_INDEX) continue;
        gl.uniformBlockBinding(program, blockIndex, group.groupIndex);
        bindingPoints.set(group.groupName, group.groupIndex);
    }
    return bindingPoints;
}

/** Binds the multi-draw base table of `program` at {@link DRAW_BASES_BINDING}; whether the program reads one. */
export function bindDrawBases(gl: WebGL2RenderingContext, program: WebGLProgram): boolean {
    const blockIndex = gl.getUniformBlockIndex(program, 'DrawBases');
    if (blockIndex === gl.INVALID_INDEX) return false;
    gl.uniformBlockBinding(program, blockIndex, DRAW_BASES_BINDING);
    return true;
}

/** The cached program for `code`, counted for `held`, releasing what `held` had before. */
export function holdProgram(
    gl: WebGL2RenderingContext,
    cache: ProgramCache,
    state: GlState,
    held: { program: ProgramInfo | null },
    code: string,
    uniformGroups: UniformGroupBlock[],
    textures: readonly TextureEntry[],
): ProgramInfo {
    const info = getProgram(gl, cache, code, uniformGroups, textures);
    if (held.program === info) return info;
    releaseProgram(gl, cache, state, held);
    info.users = (info.users ?? 0) + 1;
    held.program = info;
    return info;
}

/** Stops `held` counting its program; one held by none is deleted. */
export function releaseProgram(
    gl: WebGL2RenderingContext,
    cache: ProgramCache,
    state: GlState,
    held: { program: ProgramInfo | null },
): void {
    const info = held.program;
    if (info === null) return;
    held.program = null;
    if (info.source === undefined || info.users === undefined) return;
    info.users--;
    if (info.users > 0 || cache.programs.get(info.source) !== info) return;
    cache.programs.delete(info.source);
    if (info.units !== null) releaseProgramUnits(cache.homes, info.units);
    deleteProgram(gl, state, info.program);
}

/** Delete all cached programs (called on renderer dispose). */
export function disposePrograms(gl: WebGL2RenderingContext, cache: ProgramCache, state: GlState): void {
    for (const { program } of cache.programs.values()) {
        deleteProgram(gl, state, program);
    }
    cache.programs.clear();
    for (const { program, vertex, fragment } of cache.pending.values()) {
        gl.deleteShader(vertex);
        gl.deleteShader(fragment);
        gl.deleteProgram(program);
    }
    cache.pending.clear();
    clearTextureHomes(cache.homes);
}

/** Number of linked GL programs currently cached. */
export function getProgramCacheStats(cache: ProgramCache): { programCount: number } {
    return { programCount: cache.programs.size };
}
