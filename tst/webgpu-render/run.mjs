/**
 * Real-device WebGPU pixel proof, the mirror of tst/webgl-render for the backend that was covered
 * only by a stub. Dawn through the `webgpu` package gives a device in Node, every case renders into a
 * RenderTarget and reads its centre pixel back, and a wrong colour fails the process.
 *
 * Run: npm run test:webgpu
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const TOLERANCE = 3;

// Cases that reproduce a tracked bug and are expected to fail until it is fixed. Listing one keeps the
// repro executable instead of prose, and the runner fails if a listed case starts passing.
const KNOWN_FAILURES = new Set();

async function main() {
    const { CASE_NAMES } = await import(resolve(__dirname, 'case-names.mjs'));
    const child = resolve(__dirname, 'child.mjs');
    let failed = 0;
    let ran = 0;
    const knownFails = [];
    const fixedButListed = [];

    for (const name of CASE_NAMES) {
        let result;
        try {
            // Each case gets its own process. Dawn in Node dies after roughly eight cases in one
            // process whatever their order, and a `setTimeout` between them makes it die on the
            // first, so this is its event loop rather than anything a case does. Isolation also means
            // an abort names the case that caused it instead of losing the buffered output.
            const out = execFileSync(process.execPath, [child, name], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            result = JSON.parse(out.trim().split('\n').pop());
        } catch (e) {
            const why = (e.stderr || '').trim() || `killed by ${e.signal ?? `exit ${e.status}`}`;
            if (KNOWN_FAILURES.has(name)) knownFails.push(name);
            else failed++;
            const mark = KNOWN_FAILURES.has(name) ? `${YELLOW}~${RESET}` : `${RED}✗${RESET}`;
            console.log(`  ${mark} ${name.padEnd(18)}${RED}did not finish${RESET} ${DIM}(${why.split('\n')[0]})${RESET}`);
            continue;
        }
        ran++;

        const ok = result.pixel.every((v, i) => Math.abs(v - result.expected[i]) <= TOLERANCE);
        const known = KNOWN_FAILURES.has(name);
        if (ok && known) fixedButListed.push(name);
        else if (!ok && known) knownFails.push(name);
        else if (!ok) failed++;
        const note = result.note ? ` ${DIM}(${result.note})${RESET}` : '';
        console.log(
            `  ${ok ? `${GREEN}✓${RESET}` : known ? `${YELLOW}~${RESET}` : `${RED}✗${RESET}`} ${name.padEnd(18)}` +
                `${DIM}got${RESET} [${result.pixel.join(', ')}]`.padEnd(40) +
                `${DIM}want${RESET} [${result.expected.join(', ')}]${note}`,
        );
    }

    console.log(`\n  ${DIM}(tolerance ±${TOLERANCE} per channel, one process per case)${RESET}\n`);
    if (fixedButListed.length) {
        console.log(`${RED}These are in KNOWN_FAILURES but now pass — remove them:${RESET}`);
        for (const n of fixedButListed) console.log(`  ${n}`);
        return 1;
    }
    if (knownFails.length) {
        console.log(`${YELLOW}${knownFails.length} known failure(s), tracked: ${knownFails.join(', ')}${RESET}`);
    }
    if (failed > 0) {
        console.log(`${RED}${failed} / ${CASE_NAMES.length} cases failed${RESET}`);
        return 1;
    }
    const matched = ran - knownFails.length;
    console.log(`${GREEN}${matched} / ${CASE_NAMES.length - knownFails.length} cases match on a real device${RESET}`);
    return 0;
}

process.exit(await main());
