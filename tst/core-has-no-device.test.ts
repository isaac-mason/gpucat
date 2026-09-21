import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, test } from 'vitest';

/**
 * `PLAN-backend-symmetry.md` rule 3: core holds decisions that must not differ and machinery with no
 * device in it. That property is what lets one `Renderer` serve both backends, and until layer 6.83
 * the only thing checking any of it was `neutral-contract`, which reads two type declarations.
 */

const CORE = 'src/renderer/core';

/**
 * WebGPU's string unions are gpucat's neutral vocabulary: `Material` is authored in them on both
 * backends, and `webgl/state.ts` translates them to GL at the edge. They name no device object.
 */
const VOCABULARY = new Set(['GPUTextureFormat', 'GPUBlendFactor', 'GPUBlendState', 'GPUFeatureName']);

/** Identifiers only, so comments and error strings naming a backend do not count as touching one. */
function graphicsIdentifiers(file: string): string[] {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
    const found = new Set<string>();
    const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && /^(GPU|WebGL|WebGPU)[A-Z0-9]/.test(node.text)) found.add(node.text);
        ts.forEachChild(node, visit);
    };
    visit(source);
    return [...found];
}

test('core names no device object, only the vocabulary both backends are authored in', () => {
    const leaks: string[] = [];
    for (const entry of readdirSync(CORE)) {
        if (!entry.endsWith('.ts')) continue;
        const file = join(CORE, entry);
        for (const name of graphicsIdentifiers(file)) {
            if (!VOCABULARY.has(name)) leaks.push(`${file} ${name}`);
        }
    }
    expect(leaks.sort()).toEqual([]);
});

test('a vocabulary entry no longer used in core is removed rather than left standing', () => {
    const used = new Set(readdirSync(CORE).flatMap((e) => (e.endsWith('.ts') ? graphicsIdentifiers(join(CORE, e)) : [])));
    expect([...VOCABULARY].filter((v) => !used.has(v))).toEqual([]);
});
