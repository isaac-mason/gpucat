import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, test } from 'vitest';

const OBJECT = 'src/renderer/core/render-object.ts';
const MANAGER = 'src/renderer/core/render-objects.ts';

function parse(file: string): ts.SourceFile {
    return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
}

function find(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
    let found: ts.FunctionDeclaration | null = null;
    const visit = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
        ts.forEachChild(node, visit);
    };
    visit(source);
    if (found === null) throw new Error(`${name} not found in ${source.fileName}`);
    return found;
}

/** Fields `createRenderObject` copies off the mesh, which the cache key therefore does not cover. */
function cachedFromMesh(): string[] {
    const source = parse(OBJECT);
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
        if (
            ts.isPropertyAssignment(node) &&
            ts.isIdentifier(node.name) &&
            ts.isPropertyAccessExpression(node.initializer) &&
            ts.isIdentifier(node.initializer.expression) &&
            node.initializer.expression.text === 'mesh'
        ) {
            found.push(node.name.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(find(source, 'createRenderObject'));
    return found.sort();
}

function refreshedOnHit(): string[] {
    const source = parse(MANAGER);
    const declaration = find(source, 'getRenderObject');
    const found = new Set<string>();
    const visit = (node: ts.Node): void => {
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(node.left) &&
            ts.isIdentifier(node.left.expression) &&
            node.left.expression.text === 'renderObject'
        ) {
            found.add(node.left.name.text);
        }
        ts.forEachChild(node, visit);
    };
    let elseBranch: ts.Statement | null = null;
    const findElse = (node: ts.Node): void => {
        if (ts.isIfStatement(node) && node.elseStatement !== undefined) elseBranch ??= node.elseStatement;
        ts.forEachChild(node, findElse);
    };
    findElse(declaration);
    if (elseBranch === null) throw new Error('getRenderObject has no cache-hit branch');
    visit(elseBranch);
    return [...found].sort();
}

/** 6.104: a geometry swap kept drawing the old geometry, which the key covers for material but not for it. */
test('every field cached off the mesh is refreshed when the cache hits', () => {
    const cached = cachedFromMesh();
    expect(cached).toEqual(['geometry']);
    expect(cached.filter((name) => !refreshedOnHit().includes(name))).toEqual([]);
});

/** The other half: material is safe to leave alone only while it is part of the key. */
test('mesh, material and renderContext are the cache key, so they cannot drift', () => {
    const text = readFileSync(MANAGER, 'utf8');
    expect(text).toContain('const materialMap = cache.get(mesh);');
    expect(text).toContain('const contextMap = materialMap?.get(material);');
    expect(text).toContain('let renderObject = contextMap?.get(renderContext);');
});
