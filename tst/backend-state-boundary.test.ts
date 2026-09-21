import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, test } from 'vitest';

const BACKENDS = ['src/renderer/webgpu', 'src/renderer/webgl'];

/** Types that live on `BackendState`, so naming several of them is naming the backend the long way. */
const CACHES =
    /^(GPUDevice|GPUAdapter|BufferCache|TextureCache|SamplerCache|BindingsState|GeometriesState|RenderObjectGpuCache|BindGroupLayoutCache|pipelines\.PipelinesState|Pipelines\.PipelinesState)$/;

function exportedCacheSpillers(file: string): string[] {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
    const found: string[] = [];
    for (const statement of source.statements) {
        if (!ts.isFunctionDeclaration(statement) || statement.name === undefined) continue;
        const exported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
        if (!exported) continue;
        const caches = statement.parameters.filter((p) => CACHES.test(p.type?.getText(source) ?? ''));
        if (caches.length >= 3) found.push(`${file} ${statement.name.text} (${caches.length})`);
    }
    return found;
}

/** Half-converted is worse than either end: a call site holding `b` and spreading its fields back out. */
test('a cross-module backend entry point takes BackendState, not a handful of its caches', () => {
    const files = BACKENDS.flatMap((backend) =>
        readdirSync(backend)
            .filter((entry) => entry.endsWith('.ts'))
            .map((entry) => join(backend, entry)),
    );
    expect(files.length).toBeGreaterThan(20);
    expect(files.flatMap(exportedCacheSpillers)).toEqual([]);
});

/** The other half: module-private helpers keep naming what they use, so the type is not a free-for-all. */
test('BackendState is the aggregate, and private helpers still name their own caches', () => {
    const bindings = readFileSync('src/renderer/webgpu/bindings.ts', 'utf8');
    expect(bindings).toMatch(/\nfunction rebuildGPUBindGroup\(/);
    expect(bindings).toContain('bufferCache: BufferCache');
});
