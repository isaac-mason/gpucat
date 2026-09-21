import ts from 'typescript';
import { expect, test } from 'vitest';

/**
 * A type named in a public signature that the package does not export cannot be written down by a
 * consumer. Layer 6.1's ratchet does not catch this: it only rejects exports added after its baseline,
 * and the baseline was generated from the surface as it stood, holes included. `ComputeNode` (6.9) and
 * `ViewOffset` (6.10) were both found that way, by reading rather than by a gate.
 */

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

test('no public signature names a type the package keeps to itself', () => {
    expect(unreachableTypes(), 'export it, or mark the member @internal').toEqual([]);
});
