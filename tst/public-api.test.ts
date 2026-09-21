import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, test } from 'vitest';
import { BlendMode, mrt, vec4f } from '../src/index';
import { DELIBERATELY_INTERNAL } from './public-api-internal';

const INDEX = 'src/index.ts';

function program(): ts.Program {
    return ts.createProgram([INDEX], {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        skipLibCheck: true,
        noEmit: true,
    });
}

function publicSurface(): { missing: string[]; total: number } {
    const prog = program();
    const checker = prog.getTypeChecker();
    const index = prog.getSourceFile(INDEX);
    if (!index) throw new Error(`[public-api] could not load ${INDEX}`);

    // A module re-exported twice, `export type { … }` beside `export { … }`, is reachable through either.
    const listedBySpecifier = new Map<string, Set<string>>();
    const modules = new Map<string, ts.Symbol>();

    for (const statement of index.statements) {
        if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) continue;
        // A star re-export cannot go stale; only a name list can.
        const clause = statement.exportClause;
        if (!clause || !ts.isNamedExports(clause)) continue;

        const moduleSymbol = checker.getSymbolAtLocation(statement.moduleSpecifier);
        if (!moduleSymbol) continue;

        const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
        modules.set(specifier, moduleSymbol);
        let listed = listedBySpecifier.get(specifier);
        if (listed === undefined) {
            listed = new Set();
            listedBySpecifier.set(specifier, listed);
        }
        for (const element of clause.elements) listed.add((element.propertyName ?? element.name).text);
    }

    const missing: string[] = [];
    let total = 0;

    for (const [specifier, moduleSymbol] of modules) {
        const listed = listedBySpecifier.get(specifier) ?? new Set<string>();
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

/** `@internal` is this codebase's word for "public so the package can reach it, not for you". */
function isInternal(node: ts.Node): boolean {
    return (
        ts.getJSDocTags(node).some((t) => t.tagName.getText() === 'internal') ||
        (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []).some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)
    );
}

function unreachableTypes(): string[] {
    const prog = program();
    const checker = prog.getTypeChecker();
    const index = checker.getSymbolAtLocation(prog.getSourceFile(INDEX)!)!;
    const exports = checker.getExportsOfModule(index);
    const exported = new Set(exports.map((e) => e.getName()));

    const found = new Map<string, string>();

    const scan = (node: ts.Node, owner: string): void => {
        if (ts.isTypeReferenceNode(node)) {
            const ref = ts.isQualifiedName(node.typeName) ? node.typeName.right : node.typeName;
            const name = ref.getText();
            if (/^[A-Z]/.test(name) && !exported.has(name)) {
                let sym = checker.getSymbolAtLocation(ref);
                // An import specifier declares an alias HERE; the question is where the type lives.
                if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
                const file = sym?.declarations?.[0]?.getSourceFile().fileName ?? '';
                const ours = file.includes('/gpucat/src/') && !file.includes('node_modules');
                // Schema types are reached through the exported `d` namespace.
                const viaNamespace = file.endsWith('/src/schema/schema.ts');
                const isTypeParam = sym?.declarations?.[0] && ts.isTypeParameterDeclaration(sym.declarations[0]);
                if (ours && !viaNamespace && !isTypeParam && !found.has(name)) found.set(name, owner);
            }
        }
        node.forEachChild((c) => scan(c, owner));
    };

    for (const e of exports) {
        for (const decl of e.declarations ?? []) {
            if (isInternal(decl)) continue;
            if (ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl)) {
                for (const member of decl.members) {
                    if (isInternal(member)) continue;
                    scan(member, `${e.getName()}.${member.name?.getText() ?? '?'}`);
                }
            } else {
                scan(decl, e.getName());
            }
        }
    }

    return [...found].map(([name, owner]) => `${name} (named by ${owner})`).sort();
}

test('no star-exported signature names a type the package keeps to itself', () => {
    expect(unreachableTypes(), 'export it, or mark the member @internal').toEqual([]);
});

/** `mrt().setBlendMode` was reachable from the package while `BlendMode` was not, so its argument was unwritable. */
test('every argument a public method demands is constructible from the public entry alone', () => {
    const additive = new BlendMode('additive');
    const node = mrt({ output: vec4f(1, 0, 0, 1) }).setBlendMode('output', additive);

    expect(node.getBlendMode('output')).toBe(additive);
});

/** The barrel is hand-maintained and tolerates a repeat silently; `./material/material` was in it twice. */
test('index.ts re-exports each module once', () => {
    const stars = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('export * from'));

    expect(stars).toEqual([...new Set(stars)]);
});
