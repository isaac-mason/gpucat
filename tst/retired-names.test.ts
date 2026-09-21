import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * Names this plan deleted. Layer 6.46 found 68 references to two of them surviving in error strings
 * and comments long after the classes went, because nothing was looking. Layer 6.80 widened the roots
 * past `src`, where two more were waiting in the harnesses. The plan and worklog are excluded on
 * purpose: they are the record of the deletion and have to be able to name what went.
 */
const RETIRED = [
    'WebGPURenderer',
    'WebGLRenderer',
    'WebGL2Renderer',
    'QuadMesh',
    'saveRendererState',
    'restoreRendererState',
    '__quadCamera__',
    '_renderCallDepth',
    'overrideMaterial',
    'setScissorTest',
    'PassNode',
    'depthPass',
];

const ROOTS = ['src', 'examples/src', 'tst', 'docs'];

/** This file lists every retired name, so scanning it would report each one against itself. */
const SELF = join('tst', 'retired-names.test.ts');

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules') continue; // docs/node_modules/gpucat is a workspace self-link, so statSync loops
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) sourceFiles(path, out);
        else if ((path.endsWith('.ts') || path.endsWith('.md')) && path !== SELF) out.push(path);
    }
    return out;
}

test('a deleted name stays deleted, in error strings and comments as much as in code', () => {
    const found: string[] = [];
    for (const path of ROOTS.flatMap((root) => sourceFiles(root))) {
        const lines = readFileSync(path, 'utf8').split('\n');
        lines.forEach((line, i) => {
            for (const name of RETIRED) {
                if (new RegExp(`\\b${name}\\b`).test(line)) found.push(`${path}:${i + 1} ${name}`);
            }
        });
    }
    expect(found).toEqual([]);
});
