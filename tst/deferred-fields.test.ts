import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, test } from 'vitest';

/**
 * `= null!` claims a field holds a value it does not, and `tsc` takes it at its word. Layer 6.94 found
 * 24 of them across the two backends and reduced it to 9 by building at construction everything that
 * needs neither the renderer nor the device. The nine that remain cannot: a backend exists before both.
 */

const BACKENDS = ['src/renderer/webgl', 'src/renderer/webgpu'];

/** Each field here arrives with the renderer or the device, so `init` is the earliest it can be set. */
const ARRIVES_WITH_INIT = new Set([
    'webgl-backend.ts renderer',
    'webgl-backend.ts buffers',
    'webgl-backend.ts _frame',
    'webgpu-backend.ts renderer',
    'webgpu-backend.ts device',
    'webgpu-backend.ts adapter',
    'webgpu-backend.ts format',
    'webgpu-backend.ts buffers',
    'webgpu-backend.ts _frame',
]);

function deferredFields(): string[] {
    const out: string[] = [];
    for (const dir of BACKENDS) {
        for (const entry of readdirSync(dir)) {
            if (!entry.endsWith('.ts')) continue;
            const file = join(dir, entry);
            const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
            const visit = (node: ts.Node): void => {
                if (
                    ts.isPropertyDeclaration(node) &&
                    node.initializer !== undefined &&
                    ts.isNonNullExpression(node.initializer) &&
                    node.initializer.expression.kind === ts.SyntaxKind.NullKeyword
                ) {
                    out.push(`${entry} ${node.name.getText(source)}`);
                }
                ts.forEachChild(node, visit);
            };
            visit(source);
        }
    }
    return out.sort();
}

test('a field is built at construction unless it arrives with the renderer or the device', () => {
    expect(deferredFields().filter((f) => !ARRIVES_WITH_INIT.has(f))).toEqual([]);
});

test('a field that stops being deferred is removed from the list', () => {
    const deferred = new Set(deferredFields());
    expect([...ARRIVES_WITH_INIT].filter((f) => !deferred.has(f)).sort()).toEqual([]);
});
