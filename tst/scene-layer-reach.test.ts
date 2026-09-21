import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, test } from 'vitest';

/** The walk is the layer a consumer keeps calling, so what it reaches for on the renderer is its contract. */

const SCENE = 'src/scene';

function privateReaches(file: string): Set<string> {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
    const found = new Set<string>();
    const visit = (node: ts.Node): void => {
        if (ts.isPropertyAccessExpression(node) && node.name.text.startsWith('_')) found.add(node.name.text);
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}

test('the scene walk reaches one private, and it is the render-list cache', () => {
    const reaches = new Set<string>();
    for (const entry of readdirSync(SCENE)) {
        if (entry.endsWith('.ts')) for (const name of privateReaches(join(SCENE, entry))) reaches.add(name);
    }
    expect([...reaches].sort()).toEqual(['_renderLists']);
});

/** The other half: that one reach is a cache `collectRenderList` genuinely takes, not a convenience. */
test('collectRenderList takes the cache the scene walk reaches for', () => {
    const file = 'src/renderer/core/render-list.ts';
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
    let first: string | null = null;
    const visit = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === 'collectRenderList') {
            first = node.parameters[0]?.type?.getText(source) ?? null;
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    expect(first).toBe('RenderListsState');
});
