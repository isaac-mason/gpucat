import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { expect, test } from 'vitest';

/** The package entry, which nothing imports by design. */
const ROOT = join('src', 'index.ts');

/** Written, never wired. Empty: a module that nothing imports is either finished or deleted. */
const UNWIRED: string[] = [];

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) sourceFiles(path, out);
        else if (path.endsWith('.ts')) out.push(path);
    }
    return out;
}

/** Relative specifiers only: a bare one names a package, not a file in this tree. */
function importedFilesOf(file: string): string[] {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
    const out: string[] = [];
    source.forEachChild((node) => {
        const specifier =
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
                ? node.moduleSpecifier
                : undefined;
        if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) return;
        const base = resolve(dirname(file), specifier.text);
        for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
            if (existsSync(candidate)) {
                out.push(relative(process.cwd(), candidate));
                return;
            }
        }
    });
    return out;
}

/**
 * `tsc` never reports a module nobody imports, so a file can outlive its last consumer indefinitely.
 * Layer 6.73 removed `inspector/gui/index.ts` on exactly this: a barrel whose symbols every caller
 * reached directly.
 */
test('every module in src is imported by something, or is the entry itself', () => {
    const all = sourceFiles('src');
    const imported = new Set<string>();
    for (const file of [...all, ...sourceFiles('tst')]) {
        for (const target of importedFilesOf(file)) imported.add(target);
    }
    const orphans = all.filter((f) => f !== ROOT && !UNWIRED.includes(f) && !imported.has(f));
    expect(orphans).toEqual([]);
});
