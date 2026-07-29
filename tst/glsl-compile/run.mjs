// Headless real-WebGL2 GLSL compile+link check.
//
// esbuild-bundles the browser harness (importing gpucat from src) to a single IIFE, launches
// a real headless Chromium (ANGLE/SwiftShader), injects the bundle via addScriptTag, compiles
// every emitted shader in a real WebGL2 context, links a program, and fails the process if any
// shader/program is rejected by the driver.
//
// Run: npm run test:glsl

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as esbuild from 'esbuild';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const tick = (ok) => (ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`);

function numbered(src) {
    return src
        .split('\n')
        .map((line, i) => `      ${String(i + 1).padStart(4, ' ')} | ${line}`)
        .join('\n');
}

async function main() {
    // 1. Bundle the harness to a single IIFE, importing gpucat from src.
    const build = await esbuild.build({
        entryPoints: [resolve(__dirname, 'harness.ts')],
        bundle: true,
        format: 'iife',
        globalName: '__glslCheckModule',
        platform: 'browser',
        write: false,
        logLevel: 'silent',
    });
    const bundleString = build.outputFiles[0].text;

    // 2. Launch real headless Chromium with software GL so WebGL2 is always available.
    const browser = await chromium.launch({
        headless: true,
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    });

    let runResult;
    try {
        const page = await browser.newPage();
        const consoleErrors = [];
        page.on('console', (msg) => {
            if (msg.type() === 'error') consoleErrors.push(msg.text());
        });
        page.on('pageerror', (err) => consoleErrors.push(String(err)));

        await page.goto('about:blank');
        await page.addScriptTag({ content: bundleString });

        runResult = await page.evaluate(() => {
            const mod = window.__glslCheck;
            if (!mod || typeof mod.run !== 'function') {
                return { contextError: 'harness global __glslCheck.run not found after injecting bundle', results: [] };
            }
            return mod.run();
        });

        if (consoleErrors.length) {
            console.log(`${DIM}browser console errors:${RESET}`);
            for (const e of consoleErrors) console.log(`  ${e}`);
        }
    } finally {
        await browser.close();
    }

    // 3. Report.
    if (runResult.contextError) {
        console.error(`${RED}FATAL:${RESET} ${runResult.contextError}`);
        process.exit(1);
    }

    console.log('\nGLSL ES 3.00 real-WebGL2 compile + link check\n');

    let passCount = 0;
    const failures = [];

    for (const r of runResult.results) {
        const emitOk = !r.emitError;
        const vOk = emitOk && r.vertex?.ok;
        const fOk = emitOk && r.fragment?.ok;
        const lOk = emitOk && r.link?.ok;
        const casePass = emitOk && vOk && fOk && lOk;
        if (casePass) passCount++;
        else failures.push(r);

        const name = r.name.padEnd(28, ' ');
        if (emitError(r)) {
            console.log(`${tick(false)} ${name} emit ${tick(false)}`);
        } else {
            console.log(`${tick(casePass)} ${name} vert ${tick(vOk)}  frag ${tick(fOk)}  link ${tick(lOk)}`);
        }
    }

    // Detailed failure logs.
    for (const r of failures) {
        console.log(`\n${RED}── ${r.name} ──${RESET}`);
        if (r.emitError) {
            console.log(`  emit error:`);
            console.log(`    ${r.emitError.split('\n').join('\n    ')}`);
            continue;
        }
        if (r.vertex && !r.vertex.ok) {
            console.log(`  vertex compile log:`);
            console.log(`    ${r.vertex.log.trim().split('\n').join('\n    ')}`);
            console.log(`  vertex source:`);
            console.log(numbered(r.vertex.src));
        }
        if (r.fragment && !r.fragment.ok) {
            console.log(`  fragment compile log:`);
            console.log(`    ${r.fragment.log.trim().split('\n').join('\n    ')}`);
            console.log(`  fragment source:`);
            console.log(numbered(r.fragment.src));
        }
        if (r.link && !r.link.ok) {
            console.log(`  link log:`);
            console.log(`    ${(r.link.log.trim() || '(empty)').split('\n').join('\n    ')}`);
        }
    }

    const total = runResult.results.length;
    console.log(`\n${passCount === total ? GREEN : RED}${passCount} / ${total} compiled + linked${RESET}\n`);

    process.exit(passCount === total ? 0 : 1);
}

function emitError(r) {
    return !!r.emitError;
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
