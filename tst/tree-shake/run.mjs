/**
 * One entry point and no subpaths rests on a static backend choice shaking the loser out. This
 * measures that: bundle a one-backend app against `dist`, assert the other backend is not in it.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import { rollup } from 'rollup';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../../dist/index.js');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

/** Markers unique to one backend, chosen to appear in emitted code rather than in comments. */
const CASES = [
    {
        name: 'webgpu-only',
        entry: 'webgpu-only.mjs',
        absent: [
            ["compileGlsl(", 'the GLSL emitter'],
            ["'webglcontextlost'", 'the WebGL context-loss listener'],
            ['precision highp float', 'GLSL precision qualifiers'],
            ["getContext('webgl2'", 'WebGL context creation'],
        ],
    },
    {
        name: 'webgl-only',
        entry: 'webgl-only.mjs',
        absent: [
            ['compileWgsl(', 'the WGSL emitter'],
            ['getPreferredCanvasFormat', 'WebGPU swapchain setup'],
            ['requestAdapter', 'WebGPU adapter selection'],
            ['createRenderPipeline', 'WebGPU pipeline creation'],
        ],
    },
];

if (!existsSync(dist)) {
    console.error(`${RED}dist/index.js is missing. Run \`pnpm run build\` first.${OFF}`);
    process.exit(1);
}

let failed = 0;
const distBytes = statSync(dist).size;

for (const c of CASES) {
    const bundle = await rollup({
        input: path.join(here, c.entry),
        plugins: [nodeResolve()],
        onwarn: () => {},
    });
    const { output } = await bundle.generate({ format: 'es' });
    await bundle.close();
    const code = output[0].code;

    const kept = c.absent.filter(([marker]) => code.includes(marker));
    const share = ((code.length / distBytes) * 100).toFixed(0);
    if (kept.length === 0) {
        console.log(`  ${GREEN}✓${OFF} ${c.name.padEnd(12)} ${(code.length / 1024).toFixed(0)} KB ${DIM}(${share}% of dist)${OFF}`);
    } else {
        failed++;
        console.log(`  ${RED}✗${OFF} ${c.name.padEnd(12)} ${(code.length / 1024).toFixed(0)} KB`);
        for (const [marker, what] of kept) console.log(`      ${RED}${what} survived${OFF} ${DIM}(${marker})${OFF}`);
    }
}

console.log();
if (failed > 0) {
    console.log(`${RED}${failed} / ${CASES.length} bundles carry the other backend${OFF}`);
    process.exit(1);
}
console.log(`${GREEN}${CASES.length} / ${CASES.length} one-backend bundles shake the other out${OFF}`);
