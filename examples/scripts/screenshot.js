/**
 * Screenshot automation for examples.
 *
 * Starts `pnpm run dev` (Vite dev server), navigates Playwright Chromium to
 * each example, waits for GPU rendering to settle, clips to the <canvas>
 * element, and writes PNGs to examples/public/screenshots/<key>.png.
 *
 * Usage:
 *   pnpm run screenshot                  (from examples/)
 *   SCREENSHOT_TIMEOUT=2000 pnpm run screenshot
 */

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const examplesDir = resolve(__dirname, '..');

const TIMEOUT_MS = Number(process.env.SCREENSHOT_TIMEOUT ?? 2000);
const VIEWPORT = { width: 1280, height: 720 };

// ---------------------------------------------------------------------------
// Read example registry
// ---------------------------------------------------------------------------

const examples = JSON.parse(
    readFileSync(resolve(examplesDir, 'src/examples.json'), 'utf8'),
);
const exampleKeys = Object.keys(examples);

// ---------------------------------------------------------------------------
// Ensure output directory exists
// ---------------------------------------------------------------------------

const screenshotsDir = resolve(examplesDir, 'public/screenshots');
mkdirSync(screenshotsDir, { recursive: true });

// ---------------------------------------------------------------------------
// Start Vite dev server and wait until it's ready
// ---------------------------------------------------------------------------

function startDevServer() {
    return new Promise((resolve, reject) => {
        const proc = spawn('pnpm', ['run', 'dev', '--', '--port', '5199', '--strictPort'], {
            cwd: examplesDir,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let resolved = false;

        const onData = (data) => {
            const text = data.toString();
            process.stdout.write(`[vite] ${text}`);

            // Vite prints "Local: http://localhost:<port>/" when ready
            const match = text.match(/Local:\s+(http:\/\/localhost:\d+)/);
            if (match && !resolved) {
                resolved = true;
                resolve({ proc, url: match[1] });
            }
        };

        proc.stdout.on('data', onData);
        proc.stderr.on('data', onData);

        proc.on('error', reject);
        proc.on('exit', (code) => {
            if (!resolved) reject(new Error(`Vite exited early with code ${code}`));
        });
    });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let viteProc = null;

try {
    console.log('Starting Vite dev server...');
    const { proc, url } = await startDevServer();
    viteProc = proc;
    console.log(`Vite ready at ${url}`);

    const browser = await chromium.launch({
        // On macOS, WebGPU works out of the box in modern Chromium.
        // --use-angle=metal gives the best GPU path on Apple Silicon / Intel Mac.
        args: ['--use-angle=metal'],
    });

    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();

    // Surface any page errors so we know if WebGPU init fails
    page.on('pageerror', (err) => console.error(`[page error] ${err.message}`));
    page.on('console', (msg) => {
        if (msg.type() === 'error') console.error(`[console error] ${msg.text()}`);
    });

    for (const key of exampleKeys) {
        const pageUrl = `${url}/${key}.html`;
        console.log(`\n→ ${key}`);

        await page.goto(pageUrl, { waitUntil: 'networkidle' });
        await page.waitForTimeout(TIMEOUT_MS);

        const canvas = page.locator('canvas').first();
        const box = await canvas.boundingBox();

        if (!box) {
            console.warn(`  No <canvas> found — skipping`);
            continue;
        }

        const outPath = resolve(screenshotsDir, `${key}.png`);
        await page.screenshot({ path: outPath, clip: box });
        console.log(`  Saved → ${outPath}`);
    }

    await browser.close();
    console.log('\nAll screenshots captured.');
} finally {
    if (viteProc) {
        viteProc.kill('SIGTERM');
    }
}
