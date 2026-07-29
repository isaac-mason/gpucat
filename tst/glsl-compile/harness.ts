import { compileGlsl } from '../../src/index';
import { type Case, cases, type Slots } from './cases';
import { buildProbeCase, type ProbeCase, probeCases } from './probe-cases';

/**
 * Browser-side harness. Bundled to a single IIFE by esbuild and injected into a real
 * headless Chromium page (see run.mjs). It creates its own WebGL2 context, feeds every
 * emitted GLSL shader to the real ANGLE driver, and returns structured results.
 *
 * Exposed as a global (`window.__glslCheck.run`) so the Playwright runner can call it via
 * page.evaluate — no HTTP server, no file:// ESM.
 */

const FRAGMENT_MARKER = '// ---- fragment stage ----';

interface StageResult {
    ok: boolean;
    log: string;
    src: string;
}

export interface CaseResult {
    name: string;
    emitError?: string;
    vertex?: StageResult;
    fragment?: StageResult;
    link?: { ok: boolean; log: string };
}

export interface RunResult {
    contextError?: string;
    results: CaseResult[];
}

function splitStages(code: string): { vertexSrc: string; fragmentSrc: string | null } {
    const idx = code.indexOf(FRAGMENT_MARKER);
    const vertexSrc = (idx === -1 ? code : code.slice(0, idx)).trim();
    const fragmentSrc = idx === -1 ? null : code.slice(idx + FRAGMENT_MARKER.length).trim();
    return { vertexSrc, fragmentSrc };
}

function compileShader(
    gl: WebGL2RenderingContext,
    type: number,
    src: string,
): { shader: WebGLShader | null; ok: boolean; log: string } {
    const shader = gl.createShader(type);
    if (!shader) return { shader: null, ok: false, log: 'gl.createShader returned null' };
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    const ok = gl.getShaderParameter(shader, gl.COMPILE_STATUS) as boolean;
    const log = gl.getShaderInfoLog(shader) ?? '';
    return { shader, ok, log };
}

function runCase(gl: WebGL2RenderingContext, c: Case): CaseResult {
    let slots: Slots;
    let code: string;
    try {
        slots = c.build();
        const result = compileGlsl(slots, c.opts);
        code = result.code;
        // For a case requesting a non-highp precision, assert the emitted fragment header reflects it.
        if (c.opts?.precision && c.opts.precision !== 'highp' && !code.includes(`precision ${c.opts.precision} float;`)) {
            return { name: c.name, emitError: `expected 'precision ${c.opts.precision} float;' in emitted GLSL, but it was missing` };
        }
    } catch (err) {
        return { name: c.name, emitError: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) };
    }

    const { vertexSrc, fragmentSrc } = splitStages(code);
    if (fragmentSrc === null) {
        return { name: c.name, emitError: 'No fragment stage found in emitted GLSL (missing marker).' };
    }

    const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSrc);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSrc);

    let link: { ok: boolean; log: string } | undefined;
    if (vs.ok && fs.ok && vs.shader && fs.shader) {
        const prog = gl.createProgram();
        if (prog) {
            gl.attachShader(prog, vs.shader);
            gl.attachShader(prog, fs.shader);
            gl.linkProgram(prog);
            const ok = gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean;
            const log = gl.getProgramInfoLog(prog) ?? '';
            link = { ok, log };
            gl.deleteProgram(prog);
        } else {
            link = { ok: false, log: 'gl.createProgram returned null' };
        }
    }

    if (vs.shader) gl.deleteShader(vs.shader);
    if (fs.shader) gl.deleteShader(fs.shader);

    return {
        name: c.name,
        vertex: { ok: vs.ok, log: vs.log, src: vertexSrc },
        fragment: { ok: fs.ok, log: fs.log, src: fragmentSrc },
        link,
    };
}

/**
 * Run one probe-patcher case: build + emit GLSL, patch the fragment to probe the named var, then
 * compile + link the ORIGINAL vertex + PATCHED fragment under real WebGL2. Also asserts the patcher
 * inferred the expected GLSL kind. Reported like a normal case (vertex/fragment/link).
 */
function runProbeCase(gl: WebGL2RenderingContext, c: ProbeCase): CaseResult {
    let vertexSrc: string;
    let fragmentSrc: string;
    try {
        const built = buildProbeCase(c);
        vertexSrc = built.vertexSrc;
        fragmentSrc = built.fragmentSrc;
        if (built.inferredKind !== c.expectedKind) {
            return {
                name: c.name,
                emitError: `probe inferred kind '${built.inferredKind}', expected '${c.expectedKind}'`,
            };
        }
    } catch (err) {
        return { name: c.name, emitError: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) };
    }

    const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSrc);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSrc);

    let link: { ok: boolean; log: string } | undefined;
    if (vs.ok && fs.ok && vs.shader && fs.shader) {
        const prog = gl.createProgram();
        if (prog) {
            gl.attachShader(prog, vs.shader);
            gl.attachShader(prog, fs.shader);
            gl.linkProgram(prog);
            const ok = gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean;
            const log = gl.getProgramInfoLog(prog) ?? '';
            link = { ok, log };
            gl.deleteProgram(prog);
        } else {
            link = { ok: false, log: 'gl.createProgram returned null' };
        }
    }

    if (vs.shader) gl.deleteShader(vs.shader);
    if (fs.shader) gl.deleteShader(fs.shader);

    return {
        name: c.name,
        vertex: { ok: vs.ok, log: vs.log, src: vertexSrc },
        fragment: { ok: fs.ok, log: fs.log, src: fragmentSrc },
        link,
    };
}

export function run(): RunResult {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const gl = canvas.getContext('webgl2');
    if (!gl) {
        return { contextError: 'canvas.getContext("webgl2") returned null — WebGL2 unavailable in this browser context.', results: [] };
    }
    const results = [...cases.map((c) => runCase(gl, c)), ...probeCases.map((c) => runProbeCase(gl, c))];
    return { results };
}

// Expose for page.evaluate. --global-name=__glslCheck also assigns module exports here,
// but we set it explicitly to be robust regardless of esbuild's IIFE wiring.
(globalThis as unknown as { __glslCheck: { run: typeof run } }).__glslCheck = { run };
