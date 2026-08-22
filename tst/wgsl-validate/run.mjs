// Headless WGSL validation with naga — the validator Firefox/wgpu use. Chrome's Tint is more lenient
// (it tolerated the nested-struct-at-offset-8 layout that broke Firefox), so validating against naga is
// what keeps that whole bug class from shipping. Mirrors tst/glsl-compile/run.mjs for the WGSL side.
//
// Bundles the emit entry (importing gpucat from src), produces the WGSL for a representative shader
// matrix, writes each to a .wgsl file, round-trips it through `naga in.wgsl out.wgsl` (a full parse +
// validate), and fails the process if naga rejects any shader.
//
// Run: npm run test:wgsl   (requires `naga` on PATH: cargo install naga-cli)

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const tick = (ok) => (ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`);

// Pre-existing WGSL emitter bugs naga rejects (Chrome's Tint tolerates them). These are real
// Firefox-breakers but are unrelated to the uniform-layout hardening — tracked here as expected
// failures so this gate stays green for LAYOUT regressions while the debt is visible. Fix these and
// remove them from the set (the runner fails if a listed case starts passing, to force pruning).
const KNOWN_NAGA_FAILURES = new Set();

function hasNaga() {
    try {
        execFileSync('naga', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

async function main() {
    if (!hasNaga()) {
        console.log(
            `${DIM}naga not found on PATH — skipping WGSL validation. Install with \`cargo install naga-cli\`.${RESET}`,
        );
        process.exit(0);
    }

    // Bundle the emit entry to a temp ESM module and import it (Node can't load TS directly).
    const build = await esbuild.build({
        entryPoints: [resolve(__dirname, 'emit.ts')],
        bundle: true,
        format: 'esm',
        platform: 'node',
        write: false,
        logLevel: 'silent',
    });
    const dir = mkdtempSync(join(tmpdir(), 'gpucat-wgsl-'));
    const modPath = join(dir, 'emit.mjs');
    writeFileSync(modPath, build.outputFiles[0].text);
    const { emitAll } = await import(modPath);
    const shaders = emitAll();

    console.log('\nWGSL naga validation\n');

    let passCount = 0;
    const failures = []; // unexpected: a non-allowlisted shader naga rejected (layout regression, etc.)
    const knownFails = []; // expected: a tracked pre-existing bug still failing
    const fixedButListed = []; // an allowlisted case that now PASSES — prune it from the set
    for (const { name, code } of shaders) {
        const inPath = join(dir, 'shader.wgsl');
        const outPath = join(dir, 'shader.out.wgsl');
        writeFileSync(inPath, code);
        let ok = true;
        let err = '';
        try {
            execFileSync('naga', [inPath, outPath], { stdio: ['ignore', 'ignore', 'pipe'] });
        } catch (e) {
            ok = false;
            err = (e.stderr?.toString() || e.message || '').trim();
        }
        const known = KNOWN_NAGA_FAILURES.has(name);
        if (ok) {
            passCount++;
            if (known) fixedButListed.push(name);
        } else if (known) {
            knownFails.push({ name, err });
        } else {
            failures.push({ name, err, code });
        }
        const mark = ok ? tick(true) : known ? `${YELLOW}~${RESET}` : tick(false);
        console.log(`  ${mark} ${name}${!ok && known ? `${DIM} (known)${RESET}` : ''}`);
    }

    if (knownFails.length) {
        console.log(`\n${YELLOW}${knownFails.length} known pre-existing naga failure(s) (unrelated to layout).${RESET}`);
    }
    if (fixedButListed.length) {
        console.log(`\n${RED}These are in KNOWN_NAGA_FAILURES but now PASS — remove them:${RESET}`);
        for (const n of fixedButListed) console.log(`  ${n}`);
        process.exit(1);
    }
    if (failures.length) {
        console.log(`\n${RED}${failures.length} shader(s) unexpectedly rejected by naga:${RESET}\n`);
        for (const f of failures) {
            console.log(`${RED}✗ ${f.name}${RESET}`);
            console.log(`${DIM}${f.err}${RESET}\n`);
        }
        process.exit(1);
    }

    console.log(`\n${GREEN}${passCount} shaders valid under naga${RESET} (${knownFails.length} known-failing, tracked).`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
