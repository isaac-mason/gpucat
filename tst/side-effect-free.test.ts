import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, test } from 'vitest';

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) sourceFiles(path, out);
        else if (path.endsWith('.ts')) out.push(path);
    }
    return out;
}

/** A statement at module scope that is not a declaration: the thing `sideEffects: false` promises absent. */
function moduleScopeEffects(file: string): string[] {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
    return source.statements
        .filter(ts.isExpressionStatement)
        .map((statement) => `${file}:${source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1}`);
}

/** The tree-shake gate proves a module can be dropped; this one proves dropping it is safe. */
test('sideEffects: false is declared, and no module in src has one', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { sideEffects?: unknown };
    expect(pkg.sideEffects).toBe(false);
    expect(sourceFiles('src').flatMap(moduleScopeEffects)).toEqual([]);
});
