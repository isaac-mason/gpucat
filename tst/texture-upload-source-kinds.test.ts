import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, test } from 'vitest';

const FILE = 'src/renderer/webgpu/textures.ts';

/** Every view dimension's full upload, which must all accept the same source kinds. */
const FULL_UPLOADS = ['uploadTextureData', 'uploadCubeTextureData', 'uploadArrayTextureData'];

/** The two shapes a `Source.data` can take. A path handling one and not the other uploads nothing. */
const SOURCE_KINDS = ['isExternalImage', 'isTypedArrayData'];

function bodyOf(name: string): string {
    const source = ts.createSourceFile(FILE, readFileSync(FILE, 'utf8'), ts.ScriptTarget.ES2022, true);
    let body = '';
    const visit = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node) && node.name?.getText(source) === name) body = node.getText(source);
        node.forEachChild(visit);
    };
    visit(source);
    if (body === '') throw new Error(`[texture-upload] no function named '${name}' in ${FILE}`);
    return body;
}

test('every full-upload path handles every source kind, so none silently uploads nothing', () => {
    const missing: string[] = [];
    for (const fn of FULL_UPLOADS) {
        const body = bodyOf(fn);
        for (const kind of SOURCE_KINDS) {
            if (!body.includes(kind)) missing.push(`${fn} does not handle ${kind}`);
        }
    }
    expect(missing).toEqual([]);
});
