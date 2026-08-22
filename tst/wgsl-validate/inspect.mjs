// Dev helper: print the emitted WGSL + naga error for shaders whose case name matches an arg substring
// (default: all). Handy for working the KNOWN_NAGA_FAILURES down. Run: node tst/wgsl-validate/inspect.mjs "centroid"
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const want = process.argv[2] ?? '';

const build = await esbuild.build({
    entryPoints: [resolve(__dirname, 'emit.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
});
const dir = mkdtempSync(join(tmpdir(), 'gpucat-insp-'));
writeFileSync(join(dir, 'emit.mjs'), build.outputFiles[0].text);
const { emitAll } = await import(join(dir, 'emit.mjs'));

for (const { name, code } of emitAll()) {
    if (want && !name.includes(want)) continue;
    const f = join(dir, 's.wgsl');
    writeFileSync(f, code);
    let err = '';
    try {
        execFileSync('naga', [f, join(dir, 'o.wgsl')], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
        err = (e.stderr?.toString() || '').trim();
    }
    if (!err && want === '') continue; // only show failures unless a specific filter is given
    console.log(`\n========== ${name} ==========`);
    if (err) console.log(err.replace(/\x1b\[[0-9;]*m/g, ''));
    else console.log('(valid)');
    if (want) console.log('\n--- WGSL ---\n' + code.split('\n').map((l, i) => `${String(i + 1).padStart(3)} | ${l}`).join('\n'));
}
