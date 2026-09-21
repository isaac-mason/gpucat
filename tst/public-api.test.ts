import ts from 'typescript';
import { expect, test } from 'vitest';
import { DELIBERATELY_INTERNAL } from './public-api-internal';

/**
 * Five times a module behind an explicit re-export list in `index.ts` gained an export the list never
 * picked up, and the working feature shipped unreachable: `compile`/`compileCompute`, `readPixels`,
 * `MRTNode`, the depth pass factory, `Renderer`/`DispatchRecord`. Every one was found by a consumer.
 */

const INDEX = 'src/index.ts';

function publicSurface(): { missing: string[]; total: number } {
    const program = ts.createProgram([INDEX], {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        skipLibCheck: true,
        noEmit: true,
    });
    const checker = program.getTypeChecker();
    const index = program.getSourceFile(INDEX);
    if (!index) throw new Error(`[public-api] could not load ${INDEX}`);

    const missing: string[] = [];
    let total = 0;

    for (const statement of index.statements) {
        if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) continue;
        // A star re-export cannot go stale; only a name list can.
        const clause = statement.exportClause;
        if (!clause || !ts.isNamedExports(clause)) continue;

        const moduleSymbol = checker.getSymbolAtLocation(statement.moduleSpecifier);
        if (!moduleSymbol) continue;

        const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
        const listed = new Set(clause.elements.map((e) => (e.propertyName ?? e.name).text));
        for (const exported of checker.getExportsOfModule(moduleSymbol)) {
            total++;
            const name = exported.getName();
            if (listed.has(name)) continue;
            if (DELIBERATELY_INTERNAL.has(`${specifier}#${name}`)) continue;
            missing.push(`${specifier}#${name}`);
        }
    }
    return { missing, total };
}

test('a new export is either public or internal on purpose, never silently unreachable', () => {
    const { missing, total } = publicSurface();
    expect(total).toBeGreaterThan(100);
    expect(missing, 'add each to index.ts, or to DELIBERATELY_INTERNAL in public-api-internal.ts').toEqual([]);
});
