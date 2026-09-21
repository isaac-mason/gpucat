import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, test } from 'vitest';

/**
 * The plan cites gpucat files as evidence, and thirty of those citations carried line numbers that
 * had all drifted by layer 6.8, several past the end of their file. Names survive edits where line
 * numbers do not, so the citations are names now and this checks the files they name still exist.
 */

const PLAN = 'PLAN-explicit-frame.md';

/** A citation like `core/pass-desc.ts` or `webgpu/render-pass.ts`, minus other repos' paths. */
const CITATION = /`((?:[a-z0-9-]+\/)*[a-z0-9-]+\.ts)`/g;

/** Other repos the plan cites as evidence; this suite cannot see their trees. */
const OTHER_REPOS = ['vgpu/', 'lib/', 'three/'];
const LIB_OWNED = new Set([
    'mesh-resources.ts',
    'offline.ts',
    'pipeline.ts',
    'src/render/webgl.ts',
    'src/render/webgpu.ts',
    'visibility/dbvt.ts',
    'visibility/visibility.ts',
    'webgl.ts',
    'webgpu.ts',
]);

function citedPaths(): string[] {
    const plan = readFileSync(PLAN, 'utf8');
    const found = new Set<string>();
    for (const [, path] of plan.matchAll(CITATION)) {
        if (OTHER_REPOS.some((p) => path.startsWith(p)) || LIB_OWNED.has(path)) continue;
        found.add(path);
    }
    return [...found].sort();
}

/** Citations are written relative to wherever reads naturally, so match on the tail of a real path. */
function resolves(path: string, all: readonly string[]): boolean {
    return all.some((real) => real === path || real === `src/${path}` || real.endsWith(`/${path}`));
}

const ROOTS = ['src', 'examples/src', 'tst', 'docs'];

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) sourceFiles(full, out);
        else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
}

test('every gpucat file the plan cites still exists', () => {
    const cited = citedPaths();
    const all = ROOTS.flatMap((root) => sourceFiles(root));
    expect(cited.length).toBeGreaterThan(20);
    expect(cited.filter((p) => !resolves(p, all))).toEqual([]);
});

/**
 * The API listing is the part of the plan a reader takes as the contract, and it had drifted in four
 * places at once: a `Drawable` alias that was never created, a `Color` type that does not exist,
 * `Renderer` where three functions take a structural minimum, and a non-generic `init`. Every symbol
 * it names must therefore be one the package exports, or a primitive shape spelled out inline.
 */
test('every type the API listing names is one the package exports', () => {
    const plan = readFileSync(PLAN, 'utf8');
    const ANCHOR = 'init<B extends DeviceBackend>';
    const start = plan.indexOf(ANCHOR);
    expect(start, `the API listing no longer starts at ${ANCHOR}`).toBeGreaterThan(-1);
    const listing = plan.slice(start, plan.indexOf('type Target ='));

    // Types are erased at run time, so the export set comes from the compiler rather than an import.
    const program = ts.createProgram(['src/index.ts'], {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        skipLibCheck: true,
        noEmit: true,
    });
    const checker = program.getTypeChecker();
    const index = checker.getSymbolAtLocation(program.getSourceFile('src/index.ts')!)!;
    const exported = new Set(checker.getExportsOfModule(index).map((e) => e.getName()));

    // Built in, or a type parameter the listing declares itself; neither is ours to export.
    const INLINE = new Set(['Promise', 'Record', 'Uint8Array', 'Float32Array', 'Int32Array', 'Uint32Array', 'B']);

    // Trailing `//` comments are prose ("reversed-Z"), not type names.
    const code = listing.replace(/\/\/[^\n]*/g, '');
    // A dotted name like `d.Any` is reached through `d`, which is what has to be exported.
    const named = [...code.matchAll(/(?<![.\w])([A-Z][A-Za-z0-9]*)\b/g)].map(([, n]) => n);
    const missing = [...new Set(named)].filter((n) => !exported.has(n) && !INLINE.has(n));

    expect(named.length).toBeGreaterThan(10);
    expect(missing, 'the listing names a type the package does not export').toEqual([]);
});

test('the plan cites files by name, not by line number, because line numbers drift', () => {
    const plan = readFileSync(PLAN, 'utf8');
    // vgpu is another repo, where a line is the only locator available.
    const withLines = [...plan.matchAll(/`([a-z0-9/_-]+\.ts:[0-9-,]+)`/g)]
        .map(([, ref]) => ref)
        .filter((ref) => !ref.startsWith('vgpu/'));
    expect(withLines).toEqual([]);
});
