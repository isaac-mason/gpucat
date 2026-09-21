import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, test } from 'vitest';

/**
 * `FrameRecord` is built once per frame into a ring the inspector keeps, so a field nobody reads is
 * work every frame plus a second source of truth. Four were: `bufferStats`, `pipelineStats`,
 * `bindGroupLayoutStats` and `renderObjectStats`, all duplicating what the Memory tab already reads
 * from `renderer.info.memory` on demand. `tsc` cannot see it, since an object property is used by
 * being written.
 */

/**
 * The record's key in the ring. It costs one number, duplicates nothing, and is the only thing that
 * could correlate a record with the `begin`/`finish` pair that produced it.
 */
const IDENTITY = new Set(['frameId']);

const DECLARED_IN = 'src/inspector/renderer-inspector.ts';
const INSPECTOR = 'src/inspector';

function fieldsOfFrameRecord(): string[] {
    const source = ts.createSourceFile(DECLARED_IN, readFileSync(DECLARED_IN, 'utf8'), ts.ScriptTarget.ES2022, true);
    const out: string[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isTypeAliasDeclaration(node) && node.name.text === 'FrameRecord' && ts.isTypeLiteralNode(node.type)) {
            for (const member of node.type.members) if (member.name) out.push(member.name.getText(source));
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    if (out.length === 0) throw new Error('[frame-record] FrameRecord is not a type literal here any more');
    return out;
}

function inspectorSources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) inspectorSources(path, out);
        else if (path.endsWith('.ts')) out.push(path);
    }
    return out;
}

/**
 * Property access and destructuring both count. Matching `.field` alone would call a field read only
 * as `const { compiled } = cache` unread, and a guard whose false positives delete live code is worse
 * than no guard.
 */
function readCount(field: string): number {
    let seen = 0;
    for (const path of inspectorSources(INSPECTOR)) {
        const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true);
        const visit = (node: ts.Node): void => {
            if (ts.isPropertyAccessExpression(node) && node.name.text === field) seen++;
            if (ts.isBindingElement(node) && (node.propertyName ?? node.name).getText(source) === field) seen++;
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    return seen;
}

test('every FrameRecord field is read by something that displays it', () => {
    const unread = fieldsOfFrameRecord().filter((f) => !IDENTITY.has(f) && readCount(f) === 0);
    expect(unread).toEqual([]);
});
