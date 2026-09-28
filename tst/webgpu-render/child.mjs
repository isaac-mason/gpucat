// Runs the named cases in order in one process, writing one JSON line per case as it finishes.
// argv: <case name>...
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const names = process.argv.slice(2);

const build = await esbuild.build({
    entryPoints: [resolve(__dirname, 'cases.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
});
const modulePath = join(mkdtempSync(join(tmpdir(), 'gpucat-webgpu-case-')), 'cases.mjs');
writeFileSync(modulePath, build.outputFiles[0].text);

const dawn = await import('webgpu');
Object.assign(globalThis, dawn.globals);
// Dawn's instance lives only as long as this object does, and its event pump keeps running for work
// in flight. Left unreferenced, a collection frees the instance under that pump: a SIGSEGV in
// `InstanceBase::ProcessEvents` whose timing follows the garbage collector, not any case.
const gpu = dawn.create([]);

const { runCase, assertCaseNames } = await import(modulePath);
const { CASE_NAMES } = await import(resolve(__dirname, 'case-names.mjs'));
assertCaseNames(CASE_NAMES);

for (const name of names) {
    // A device per case, so one case's errors and leftover state cannot reach the next.
    const adapter = await gpu.requestAdapter();
    const device = await adapter.requestDevice();

    // Errors raised outside any pushed scope land here and nowhere else, which is how a pass that
    // produces no pixels and no scoped error still says why.
    const uncaptured = [];
    device.addEventListener?.('uncapturederror', (e) => uncaptured.push(e.error?.message ?? String(e)));

    let line;
    try {
        line = await runCase(device, adapter, name);
        if (uncaptured.length > 0) {
            line.note = `${uncaptured.length} uncaptured: ${uncaptured[0]}`;
            line.pixel = [255, 0, 0, 255];
        }
    } catch (e) {
        line = { name, error: String(e) };
    }
    process.stdout.write(`${JSON.stringify(line)}\n`);
}

// The held instance keeps the event loop alive, so leave once everything written has flushed.
process.stdout.write('', () => process.exit(0));
