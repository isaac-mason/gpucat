import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, test } from 'vitest';

/**
 * `renderer.pipelines` and `renderer.info` read alike and come from different objects when a backend
 * is bound to the name `renderer`. Layer 6.92 found five such bindings, and misread its own survey of
 * what the backends reach for on the `Renderer` because of them.
 */

const ROOTS = ['src'];
const BACKEND_TYPE = /^(WebGPUBackend|WebGLBackend|DeviceBackend)$/;

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) sourceFiles(path, out);
        else if (path.endsWith('.ts')) out.push(path);
    }
    return out;
}

function misnamed(file: string): string[] {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
        const named =
            (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
            ts.isIdentifier(node.name) &&
            node.name.text === 'renderer';
        if (named && node.type !== undefined) {
            const base = node.type.getText(source).replace(/<.*>$/, '');
            if (BACKEND_TYPE.test(base)) {
                const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
                found.push(`${file}:${line + 1} ${node.type.getText(source)}`);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}

test('a binding called renderer holds a Renderer, never a backend', () => {
    const offenders = ROOTS.flatMap((root) => sourceFiles(root)).flatMap(misnamed);
    expect(offenders.sort()).toEqual([]);
});
