import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * Comments cite sibling modules constantly, and a rename leaves the citation pointing at nothing.
 * Layer 6.81 found `webgl/renderer.ts`, deleted by this plan, and `uniforms.ts`, which had been
 * `bindings.ts` for longer than that. Neither is a retired *name*, so 6.80's guard could not see them.
 */

const ROOTS = ['src', 'examples/src', 'tst', 'docs'];

/** Paths inside a backtick span, which is how this codebase writes a file reference. */
const CITATION = /`((?:[a-z0-9.-]+\/)*[a-z0-9-]+\.ts)`/g;

/**
 * A guard that records what it deleted has to be able to name it. Keyed by citing file so the name
 * stays dangling everywhere else.
 */
const NAMES_A_DELETED_FILE = new Set([
    'tst/cited-files.test.ts webgl/renderer.ts',
    'tst/cited-files.test.ts uniforms.ts',
    'tst/unimported-modules.test.ts inspector/gui/index.ts',
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules') continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) sourceFiles(path, out);
        else if (path.endsWith('.ts')) out.push(path);
    }
    return out;
}

/** Citations are written relative to wherever reads naturally, so match on the tail of a real path. */
function resolves(cited: string, all: readonly string[]): boolean {
    return all.some((real) => real === cited || real === `src/${cited}` || real.endsWith(`/${cited}`));
}

test('every module a comment points at is one that exists', () => {
    const all = ROOTS.flatMap((root) => sourceFiles(root));
    const dangling: string[] = [];
    for (const path of all) {
        readFileSync(path, 'utf8')
            .split('\n')
            .forEach((line, i) => {
                for (const [, cited] of line.matchAll(CITATION)) {
                    if (resolves(cited, all) || NAMES_A_DELETED_FILE.has(`${path} ${cited}`)) continue;
                    dangling.push(`${path}:${i + 1} ${cited}`);
                }
            });
    }
    expect(dangling).toEqual([]);
});
