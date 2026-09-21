import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, test } from 'vitest';

/**
 * Two of the rendered README's 49 code blocks come from the typechecked `docs/snippets.ts`. The other
 * 47 live in the template and nothing compiles them, so by layer 6.79 three had reached for members
 * this plan deleted or moved: `renderer.domElement`, `renderer.inspector.domElement` and
 * `renderer.transformFeedback`. Only the template is scanned here; the snippets are already checked.
 */

const TEMPLATE = 'docs/README.template.md';
const INDEX = 'src/index.ts';

/** What the docs call a Renderer. A block naming it anything else is outside this guard. */
const RECEIVERS = ['renderer', 'gpu'];

function rendererMembers(): Set<string> {
    const prog = ts.createProgram([INDEX], {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        skipLibCheck: true,
        noEmit: true,
    });
    const checker = prog.getTypeChecker();
    const index = checker.getSymbolAtLocation(prog.getSourceFile(INDEX)!)!;
    const renderer = checker.getExportsOfModule(index).find((e) => e.getName() === 'Renderer')!;
    const type = checker.getDeclaredTypeOfSymbol(renderer);
    return new Set(checker.getPropertiesOfType(type).map((p) => p.getName()));
}

function blockCount(): number {
    return [...readFileSync(TEMPLATE, 'utf8').matchAll(/```ts\n([\s\S]*?)```/g)].length;
}

function citedMembers(): string[] {
    const template = readFileSync(TEMPLATE, 'utf8');
    const found = new Set<string>();
    for (const [, block] of template.matchAll(/```ts\n([\s\S]*?)```/g)) {
        for (const [, receiver, member] of block.matchAll(/\b(\w+)\.(\w+)/g)) {
            if (RECEIVERS.includes(receiver)) found.add(member);
        }
    }
    return [...found].sort();
}

test('every renderer member the README reaches for is one the Renderer has', () => {
    const members = rendererMembers();
    // Floored on blocks, not on cited members: operations are moving to free functions that take the
    // renderer, so `renderer.x` in the docs trends to the properties alone and a member floor would
    // fail on the API getting better rather than on this scan going blind.
    expect(blockCount()).toBeGreaterThan(20);
    expect(citedMembers().filter((m) => !members.has(m))).toEqual([]);
});

/** Doc code is meant to be copied, so it stays typeable: no arrows, ellipses or box drawing. */
test('README code blocks are ASCII', () => {
    const template = readFileSync(TEMPLATE, 'utf8');
    const offenders = new Set<string>();
    for (const [, block] of template.matchAll(/```ts\n([\s\S]*?)```/g)) {
        for (const ch of block) if (ch.charCodeAt(0) > 127) offenders.add(ch);
    }
    expect([...offenders]).toEqual([]);
});

/** Free functions exported from the public entry, which doc code calls by bare name. */
function exportedFunctions(): Set<string> {
    const prog = ts.createProgram([INDEX], {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        skipLibCheck: true,
        noEmit: true,
    });
    const checker = prog.getTypeChecker();
    const index = checker.getSymbolAtLocation(prog.getSourceFile(INDEX)!)!;
    const names = new Set<string>();
    for (const e of checker.getExportsOfModule(index)) {
        const resolved = e.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(e) : e;
        if (resolved.flags & ts.SymbolFlags.Function) names.add(e.getName());
    }
    return names;
}

/**
 * The API is free functions, so a block that declares `function frame()` around a `frame(renderer)`
 * call reads fine and recurses forever. Both README loops did exactly that after the rename.
 */
test('no README block shadows a free function it also calls', () => {
    const template = readFileSync(TEMPLATE, 'utf8');
    const exported = exportedFunctions();
    expect(exported.has('frame')).toBe(true);

    // Shadowing alone is legal: `const sampler = new GpuSampler(...)` never calls `sampler()`. The bug
    // is declaring a name the same block goes on to call.
    const declaration = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function\s+|(?:const|let|var)\s+)(\w+)/g;
    const offenders: string[] = [];
    for (const [, block] of template.matchAll(/```ts\n([\s\S]*?)```/g)) {
        for (const [, name] of block.matchAll(declaration)) {
            if (!exported.has(name!)) continue;
            if (new RegExp(`\\b${name}\\s*\\([^)]`).test(block)) offenders.push(name!);
        }
    }
    expect(offenders).toEqual([]);
});
