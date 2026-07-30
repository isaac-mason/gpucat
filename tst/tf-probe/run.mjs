// GO/NO-GO capability probe (Phase 0.5 of llm/webgl-transform-feedback-plan.md).
//
// Confirms the headless-Chromium/Playwright test platform that `npm run test:webgl` drives actually
// supports WebGL2 transform feedback + fence-based buffer readback, BEFORE we build the real feature.
//
// This is PURE raw WebGL2 (no gpucat code): it reuses the exact same Playwright launch + WebGL2
// context infrastructure as tst/webgl-render/run.mjs (same chromium.launch args → ANGLE/SwiftShader),
// but the browser-side probe is hand-written gl.* calls injected as a plain <script> (no esbuild
// bundle needed since there's nothing to import).
//
// Run: node tst/tf-probe/run.mjs

import { chromium } from 'playwright';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const EXPECTED = [1, 3, 5, 7, 9, 11, 13, 15]; // i*2+1 for i in 0..7

// The browser-side probe, stringified and injected. Returns a plain JSON-able result object.
// It is intentionally self-contained raw WebGL2.
async function browserProbe() {
    const N = 8;
    const errors = []; // { where, code }
    const glErr = (gl, where) => {
        const e = gl.getError();
        if (e !== gl.NO_ERROR) errors.push({ where, code: e });
        return e;
    };

    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const gl = canvas.getContext('webgl2', { antialias: false });
    if (!gl) return { contextError: 'could not acquire WebGL2 context' };

    const info = {
        RENDERER: gl.getParameter(gl.RENDERER),
        VENDOR: gl.getParameter(gl.VENDOR),
        VERSION: gl.getParameter(gl.VERSION),
        SHADING_LANGUAGE_VERSION: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
        MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS: gl.getParameter(gl.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS),
    };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) {
        info.UNMASKED_RENDERER = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
        info.UNMASKED_VENDOR = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
    }

    // 1. Vertex-only program: writes an `out float v_out` varying + a dummy gl_Position.
    const vsSrc = `#version 300 es
precision highp float;
out float v_out;
void main() {
    v_out = float(gl_VertexID) * 2.0 + 1.0;
    gl_Position = vec4(0.0);
}`;
    // No-op fragment shader so the program links (transform-feedback-only, RASTERIZER_DISCARD anyway).
    const fsSrc = `#version 300 es
precision highp float;
void main() {}`;

    const compile = (type, src, tag) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            return { error: `${tag} compile failed: ${gl.getShaderInfoLog(sh)}` };
        }
        return { shader: sh };
    };

    const vs = compile(gl.VERTEX_SHADER, vsSrc, 'vertex');
    if (vs.error) return { ...info, compileError: vs.error };
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc, 'fragment');
    if (fs.error) return { ...info, compileError: fs.error };

    const prog = gl.createProgram();
    gl.attachShader(prog, vs.shader);
    gl.attachShader(prog, fs.shader);

    // 2. transformFeedbackVaryings BEFORE linkProgram.
    gl.transformFeedbackVaryings(prog, ['v_out'], gl.SEPARATE_ATTRIBS);
    gl.linkProgram(prog);

    const linked = gl.getProgramParameter(prog, gl.LINK_STATUS);
    const linkLog = gl.getProgramInfoLog(prog) || '';
    if (!linked) {
        return { ...info, linked: false, linkLog };
    }
    glErr(gl, 'after link');

    gl.useProgram(prog);

    // 3. Transform-feedback object + output buffer, bindBufferBase to binding 0.
    const byteSize = N * 4; // N floats
    const outBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, outBuf);
    gl.bufferData(gl.ARRAY_BUFFER, byteSize, gl.STATIC_READ);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    glErr(gl, 'alloc out buffer');

    const tf = gl.createTransformFeedback();
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, tf);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, outBuf);
    glErr(gl, 'bindBufferBase');

    // 4. RASTERIZER_DISCARD → begin/draw/end TF.
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    glErr(gl, 'beginTransformFeedback');
    gl.drawArrays(gl.POINTS, 0, N);
    glErr(gl, 'drawArrays');
    gl.endTransformFeedback();
    glErr(gl, 'endTransformFeedback');
    gl.disable(gl.RASTERIZER_DISCARD);

    // Unbind the TF binding point before reading the buffer back (spec: buffer bound to a TF binding
    // point cannot also be read from; rebind to a generic target).
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    glErr(gl, 'unbind TF');

    // 5a. SYNC (fallback) readback: getBufferSubData right after endTransformFeedback.
    let syncValues = null;
    let syncError = null;
    try {
        const out = new Float32Array(N);
        gl.bindBuffer(gl.ARRAY_BUFFER, outBuf);
        gl.getBufferSubData(gl.ARRAY_BUFFER, 0, out);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        glErr(gl, 'sync getBufferSubData');
        syncValues = Array.from(out);
    } catch (e) {
        syncError = String(e && e.message ? e.message : e);
    }

    // 5b. ASYNC fence readback: fenceSync + flush + poll clientWaitSync → getBufferSubData.
    // This is the path Phase 3 depends on, so it's the one that matters most.
    //
    // NOTE: clientWaitSync is polled across setTimeout(0) ticks so the browser event loop turns
    // between polls (SwiftShader/single-threaded ANGLE needs the loop to turn for GPU commands to
    // complete — a tight synchronous busy-loop with timeout=0 never lets the fence signal). This is
    // exactly the pattern a real readback pool uses (poll per animation frame / microtask).
    let asyncValues = null;
    let asyncError = null;
    let fenceStatus = null; // the last clientWaitSync return
    let pollCount = 0;
    const yieldTick = () => new Promise((r) => setTimeout(r, 0));
    try {
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        glErr(gl, 'fenceSync');
        gl.flush();

        const MAX_POLLS = 1000;
        let status = gl.clientWaitSync(sync, gl.SYNC_FLUSH_COMMANDS_BIT, 0);
        // First poll used SYNC_FLUSH_COMMANDS_BIT to guarantee the flush; subsequent polls without it,
        // yielding to the event loop each time so GPU work can progress.
        while (status === gl.TIMEOUT_EXPIRED && pollCount < MAX_POLLS) {
            await yieldTick();
            status = gl.clientWaitSync(sync, 0, 0);
            pollCount++;
        }
        fenceStatus =
            status === gl.ALREADY_SIGNALED
                ? 'ALREADY_SIGNALED'
                : status === gl.CONDITION_SATISFIED
                  ? 'CONDITION_SATISFIED'
                  : status === gl.TIMEOUT_EXPIRED
                    ? 'TIMEOUT_EXPIRED'
                    : status === gl.WAIT_FAILED
                      ? 'WAIT_FAILED'
                      : `unknown(${status})`;
        gl.deleteSync(sync);

        if (status === gl.TIMEOUT_EXPIRED || status === gl.WAIT_FAILED) {
            asyncError = `fence not signaled: ${fenceStatus} after ${pollCount} polls`;
        } else {
            const out = new Float32Array(N);
            gl.bindBuffer(gl.ARRAY_BUFFER, outBuf);
            gl.getBufferSubData(gl.ARRAY_BUFFER, 0, out);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
            glErr(gl, 'async getBufferSubData');
            asyncValues = Array.from(out);
        }
    } catch (e) {
        asyncError = String(e && e.message ? e.message : e);
    }

    // Cleanup.
    gl.deleteBuffer(outBuf);
    gl.deleteTransformFeedback(tf);
    gl.deleteProgram(prog);
    gl.deleteShader(vs.shader);
    gl.deleteShader(fs.shader);

    return {
        ...info,
        linked: true,
        linkLog,
        syncValues,
        syncError,
        asyncValues,
        asyncError,
        fenceStatus,
        pollCount,
        glErrors: errors.map((e) => ({ where: e.where, code: e.code })),
    };
}

async function main() {
    // Same launch as tst/webgl-render/run.mjs → same headless WebGL2 test platform.
    const browser = await chromium.launch({
        headless: true,
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    });

    let result;
    try {
        const page = await browser.newPage();
        const consoleErrors = [];
        page.on('console', (msg) => {
            if (msg.type() === 'error') consoleErrors.push(msg.text());
        });
        page.on('pageerror', (err) => consoleErrors.push(String(err)));

        await page.goto('about:blank');
        // Inject the probe as a global function, then call it in the page.
        await page.addScriptTag({ content: `window.__tfProbe = ${browserProbe.toString()};` });
        result = await page.evaluate(async () => await window.__tfProbe());

        if (consoleErrors.length) {
            console.log(`${DIM}browser console errors:${RESET}`);
            for (const e of consoleErrors) console.log(`  ${e}`);
        }
    } finally {
        await browser.close();
    }

    console.log('\nWebGL2 transform-feedback + fence-readback capability probe\n');

    if (result.contextError) {
        console.error(`${RED}NO-GO:${RESET} ${result.contextError}`);
        process.exit(1);
    }

    // Platform identity.
    console.log(`${DIM}GL platform:${RESET}`);
    console.log(`  RENDERER : ${result.RENDERER}`);
    console.log(`  VENDOR   : ${result.VENDOR}`);
    console.log(`  VERSION  : ${result.VERSION}`);
    console.log(`  GLSL     : ${result.SHADING_LANGUAGE_VERSION}`);
    if (result.UNMASKED_RENDERER) console.log(`  UNMASKED_RENDERER : ${result.UNMASKED_RENDERER}`);
    if (result.UNMASKED_VENDOR) console.log(`  UNMASKED_VENDOR   : ${result.UNMASKED_VENDOR}`);
    console.log(`  MAX_TF_SEPARATE_ATTRIBS : ${result.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS}`);
    console.log('');

    if (result.compileError) {
        console.error(`${RED}NO-GO:${RESET} shader compile failed:\n  ${result.compileError}`);
        process.exit(1);
    }

    const arrEq = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);

    // Link.
    console.log(`${DIM}link (transformFeedbackVaryings set before linkProgram):${RESET}`);
    if (!result.linked) {
        console.log(`  ${RED}LINK FAILED${RESET}`);
        console.log(`  infolog: ${result.linkLog || '(empty)'}`);
        console.error(`\n${RED}NO-GO${RESET} — program did not link with transform-feedback varyings.\n`);
        process.exit(1);
    }
    console.log(`  ${GREEN}linked OK${RESET}${result.linkLog ? ` ${DIM}(infolog: ${result.linkLog})${RESET}` : ''}`);
    console.log('');

    // Expected.
    console.log(`${DIM}expected readback:${RESET} [${EXPECTED.join(', ')}]`);
    console.log('');

    // Sync readback.
    const syncOk = arrEq(result.syncValues, EXPECTED);
    console.log(`${DIM}sync getBufferSubData (fallback path):${RESET}`);
    if (result.syncError) {
        console.log(`  ${RED}ERROR:${RESET} ${result.syncError}`);
    } else {
        console.log(
            `  values : [${(result.syncValues ?? []).join(', ')}] ${syncOk ? GREEN + 'MATCH' + RESET : RED + 'MISMATCH' + RESET}`,
        );
    }
    console.log('');

    // Async fence readback.
    const asyncOk = arrEq(result.asyncValues, EXPECTED);
    console.log(`${DIM}async fence readback (fenceSync + clientWaitSync + getBufferSubData — Phase 3 path):${RESET}`);
    console.log(`  fenceStatus : ${result.fenceStatus} ${DIM}(after ${result.pollCount} polls)${RESET}`);
    if (result.asyncError) {
        console.log(`  ${RED}ERROR:${RESET} ${result.asyncError}`);
    } else {
        console.log(
            `  values : [${(result.asyncValues ?? []).join(', ')}] ${asyncOk ? GREEN + 'MATCH' + RESET : RED + 'MISMATCH' + RESET}`,
        );
    }
    console.log('');

    // gl.getError hits.
    console.log(`${DIM}gl.getError() hits:${RESET}`);
    if (!result.glErrors || result.glErrors.length === 0) {
        console.log(`  ${GREEN}none${RESET}`);
    } else {
        for (const e of result.glErrors) console.log(`  ${RED}${e.where}: 0x${e.code.toString(16)}${RESET}`);
    }
    console.log('');

    // Gate decision: the async fence path is the one Phase 3 depends on.
    const noGlErrors = !result.glErrors || result.glErrors.length === 0;
    const go = result.linked && asyncOk && noGlErrors;

    console.log('='.repeat(60));
    if (go) {
        console.log(`${GREEN}GO${RESET} — transform feedback + fence readback work on the test platform.`);
        console.log(`  async fence readback = [${result.asyncValues.join(', ')}] (correct)`);
        if (!syncOk) console.log(`  ${DIM}(note: sync getBufferSubData path did NOT match; async path is the one we need)${RESET}`);
        process.exit(0);
    } else {
        console.log(`${RED}NO-GO${RESET} — the test platform does not fully support the required path:`);
        if (!result.linked) console.log('  - program did not link with TF varyings');
        if (!asyncOk) console.log(`  - async fence readback wrong/failed: [${(result.asyncValues ?? []).join(', ')}]`);
        if (!noGlErrors) console.log('  - gl.getError() reported errors (see above)');
        console.log(`  ${DIM}(sync path ${syncOk ? 'DID' : 'did NOT'} match: [${(result.syncValues ?? []).join(', ')}])${RESET}`);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
