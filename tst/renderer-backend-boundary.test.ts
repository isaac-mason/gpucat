import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, test } from 'vitest';

const CORE = 'src/renderer/core';
const BACKENDS = ['src/renderer/webgl/webgl-backend.ts', 'src/renderer/webgpu/webgpu-backend.ts'];

/** The state the `Renderer` owns. A backend declaring any of these has a second copy of it. */
const NEUTRAL_STATE = [
    '_nodes',
    '_renderObjects',
    '_renderLists',
    '_renderContexts',
    '_computeContext',
    '_frameState',
    '_initialized',
    '_isDeviceLost',
    'info',
    'inspector',
    'onDeviceLost',
];

function importsOf(file: string): string[] {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
    const specifiers: string[] = [];
    source.forEachChild((node) => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
            if (ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
        }
    });
    return specifiers;
}

test('the orchestration layer names no backend, which is what lets one-backend bundles shake', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(CORE)) {
        if (!name.endsWith('.ts')) continue;
        for (const specifier of importsOf(join(CORE, name))) {
            if (/(^|\/)(webgl|webgpu)\//.test(specifier)) offenders.push(`${name} -> ${specifier}`);
        }
    }
    expect(offenders).toEqual([]);
});

test('a backend declares no field the renderer owns, so neutral state cannot be copied back onto it', () => {
    const offenders: string[] = [];
    for (const file of BACKENDS) {
        const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
        const visit = (node: ts.Node): void => {
            if (ts.isClassDeclaration(node)) {
                for (const member of node.members) {
                    if (!ts.isPropertyDeclaration(member) && !ts.isGetAccessor(member)) continue;
                    const name = member.name.getText(source);
                    if (NEUTRAL_STATE.includes(name)) offenders.push(`${file}#${name}`);
                }
            }
            node.forEachChild(visit);
        };
        visit(source);
    }
    expect(offenders).toEqual([]);
});
