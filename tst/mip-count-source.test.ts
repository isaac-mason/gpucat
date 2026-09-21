import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/** The one place allowed to turn `generateMipmaps` into a chain length. */
const OWNER = join('src', 'renderer', 'core', 'texture-size.ts');

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) sourceFiles(path, out);
        else if (path.endsWith('.ts')) out.push(path);
    }
    return out;
}

/**
 * `generateMipmaps` answers "regenerate now", and `CubeCamera` flips it off mid-render to regenerate
 * once rather than per face. Anything deciding how much to *allocate* must ask `mipLevelCountFor`
 * instead: layer 6.53 fixed one such reader and 6.55 found the check beside it still asking the flag,
 * which reallocated a texture under the frame encoding into it.
 */
test('no mip count is derived from the live generateMipmaps flag', () => {
    const offenders: string[] = [];
    for (const path of sourceFiles('src')) {
        if (path === OWNER) continue;
        readFileSync(path, 'utf8')
            .split('\n')
            .forEach((line, i) => {
                if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;
                if (!line.includes('fullMipChainLength')) return;
                // `opts.generateMipmaps` is the construction option, which is where the intent is
                // captured once; the defect is deriving a count from the live, mutable flag.
                const live = /(?<!opts)\.generateMipmaps\b/.test(line);
                if (live) offenders.push(`${path}:${i + 1}`);
            });
    }
    expect(offenders).toEqual([]);
});
