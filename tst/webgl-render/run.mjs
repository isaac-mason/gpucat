// Headless real-WebGL2 draw-path proof.
//
// esbuild-bundles the browser harness (importing gpucat from src) to a single IIFE, launches a real
// headless Chromium (ANGLE/SwiftShader), runs several render cases against a real WebGL2 context
// (clear, a solid-color fullscreen triangle, a uniform-driven color via the std140 UBO path, and a
// camera-transformed lit box), reads the center pixel of each, and fails the process unless every
// case matches its expected pixel within tolerance.
//
// Run: npm run test:webgl

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as esbuild from 'esbuild';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const TOLERANCE = 3;

async function main() {
    // 1. Bundle the harness to a single IIFE, importing gpucat from src.
    const build = await esbuild.build({
        entryPoints: [resolve(__dirname, 'harness.ts')],
        bundle: true,
        format: 'iife',
        globalName: '__webglRenderModule',
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

        runResult = await page.evaluate(async () => {
            const mod = window.__webglRender;
            if (!mod || typeof mod.run !== 'function') {
                return { contextError: 'harness global __webglRender.run not found after injecting bundle' };
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
    console.log('\nWebGL2 draw-path proof (real node-graph materials → real WebGL2)\n');

    if (runResult.contextError) {
        console.error(`${RED}FATAL:${RESET} ${runResult.contextError}`);
        process.exit(1);
    }

    const cases = runResult.cases ?? [];
    let anyFail = false;

    const pad = (s, n) => String(s).padEnd(n);
    console.log(`  ${pad('case', 10)} ${pad('expected', 22)} ${pad('returned', 22)} result`);
    console.log(`  ${'-'.repeat(10)} ${'-'.repeat(22)} ${'-'.repeat(22)} ------`);

    for (const c of cases) {
        if (c.error) {
            anyFail = true;
            console.log(`  ${pad(c.name, 10)} ${RED}ERROR${RESET}`);
            for (const line of c.error.split('\n')) console.log(`    ${DIM}${line}${RESET}`);
            continue;
        }
        const within = c.pixel.every((v, i) => Math.abs(v - c.expected[i]) <= TOLERANCE);
        if (!within) anyFail = true;
        const expStr = `[${c.expected.join(', ')}]`;
        const gotStr = `[${c.pixel.join(', ')}]`;
        const tag = within ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
        const note = c.note ? ` ${DIM}(${c.note})${RESET}` : '';
        console.log(`  ${pad(c.name, 12)} ${pad(expStr, 22)} ${pad(gotStr, 22)} ${tag}${note}`);
    }

    console.log(`\n  (tolerance ±${TOLERANCE} per channel)\n`);

    if (anyFail) {
        console.log(`${RED}FAIL${RESET} — one or more cases did not match within tolerance.\n`);
        process.exit(1);
    } else {
        console.log(`${GREEN}PASS${RESET} — all cases match.\n`);
        process.exit(0);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
