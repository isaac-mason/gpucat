import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, test } from 'vitest';

const BACKENDS = ['src/renderer/webgpu', 'src/renderer/webgl'];

/** The caches a backend owns. Device handles are not among them: every WebGL call takes `gl` anyway. */
const CACHES =
    /^(BufferCache|TextureCache|SamplerCache|BindingsState|GeometriesState|RenderObjectGpuCache|RenderObjectGlCache|BindGroupLayoutCache|PipelinesState|ProgramCache|GlRenderTargetsState|SwapchainState)$/;

const BAG = /^(WebGPUBackend|WebGLBackend)$/;

/** `Textures.TextureCache` and `TextureCache` are the same type; the old regex only matched the second. */
const bareTypeName = (type: string | undefined): string => (type ?? '').replace(/^.*\./, '').replace(/<.*$/, '');

type Fn = { file: string; name: string; exported: boolean; caches: number; takesBag: boolean };

function functions(): Fn[] {
    const files = BACKENDS.flatMap((backend) =>
        readdirSync(backend)
            .filter((entry) => entry.endsWith('.ts'))
            .map((entry) => join(backend, entry)),
    );
    return files.flatMap((file) => {
        const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
        return source.statements.filter(ts.isFunctionDeclaration).flatMap((statement) => {
            if (statement.name === undefined) return [];
            const types = statement.parameters.map((p) => bareTypeName(p.type?.getText(source)));
            return [
                {
                    file,
                    name: statement.name.text,
                    exported: statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false,
                    caches: types.filter((t) => CACHES.test(t)).length,
                    takesBag: types.some((t) => BAG.test(t)),
                },
            ];
        });
    });
}

/** Half-converted is worse than either end: a call site holding `b` and spreading its fields back out. */
test('a cross-module backend entry point takes the backend, not a handful of its caches', () => {
    const all = functions();
    expect(all.length).toBeGreaterThan(80);

    const spillers = all.filter((fn) => fn.exported && fn.caches >= 2).map((fn) => `${fn.file} ${fn.name}`);
    expect(spillers).toEqual([]);
});

/**
 * The other half. `bindFramebuffer` is the draw path's own helper and holds the bag the pass already
 * has; every other private helper names what it touches, because its parameters are the only statement of it.
 */
test('a private helper names its own caches rather than taking the backend', () => {
    const holders = functions()
        .filter((fn) => !fn.exported && fn.takesBag)
        .map((fn) => `${fn.file} ${fn.name}`);

    expect(holders).toEqual(['src/renderer/webgl/render-pass.ts bindFramebuffer']);
});
