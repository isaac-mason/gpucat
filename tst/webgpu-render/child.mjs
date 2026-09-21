// One case, one process. argv: <case name>.
//
// The child bundles for itself rather than taking a path from the parent. Order matters and is not
// guessable: esbuild forks, and forking with Dawn's addon already loaded segfaults, while importing
// the bundle into a process that has not run esbuild segfaults too. Bundle, then Dawn, then import.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const name = process.argv[2];

const build = await esbuild.build({
    entryPoints: [resolve(__dirname, 'cases.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
    // Dawn in Node segfaults on an imported module past roughly 530 KB, proven with 20 KB of inert
    // padding, so the bundle is minified to stay well under it rather than growing into the wall.
    minify: true,
});
const modulePath = join(mkdtempSync(join(tmpdir(), 'gpucat-webgpu-case-')), 'cases.mjs');
writeFileSync(modulePath, build.outputFiles[0].text);

const dawn = await import('webgpu');
Object.assign(globalThis, dawn.globals);
const adapter = await dawn.create([]).requestAdapter();
const device = await adapter.requestDevice();

// Errors raised outside any pushed scope land here and nowhere else, which is how a pass that produces
// no pixels and no scoped error still says why.
const uncaptured = [];
device.addEventListener?.('uncapturederror', (e) => uncaptured.push(e.error?.message ?? String(e)));

const { runCase, assertCaseNames } = await import(modulePath);
const { CASE_NAMES } = await import(resolve(__dirname, 'case-names.mjs'));
assertCaseNames(CASE_NAMES);
try {
    const result = await runCase(device, adapter, name);
    if (uncaptured.length > 0) {
        result.note = `${uncaptured.length} uncaptured: ${uncaptured[0]}`;
        result.pixel = [255, 0, 0, 255];
    }
    // Dawn segfaults during Node's own teardown, so exit once stdout has flushed.
    process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
} catch (e) {
    process.stderr.write(`${String(e)}\n`, () => process.exit(1));
}
