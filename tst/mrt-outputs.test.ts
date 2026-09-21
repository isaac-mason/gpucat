import { expect, test } from 'vitest';
import { createRenderTarget } from '../src/core/render-target';
import { mrt } from '../src/nodes/lib/mrt';
import { vec4 } from '../src/nodes/nodes';
import { installWebGPUPolyfills } from './stub-gpu';

installWebGPUPolyfills();

function gbuffer(names: string[]) {
    const rt = createRenderTarget(8, 8, { count: names.length, colorFormat: 'rgba8unorm' });
    names.forEach((n, i) => {
        rt.textures[i].name = n;
    });
    return rt;
}

const resolveAgainst = (outputs: Parameters<typeof mrt>[0], target: ReturnType<typeof gbuffer>) =>
    mrt(outputs).resolveOutputs(
        (name) => target.getTextureIndex(name),
        target.textures.map((t) => t.name),
    );

test('a named output resolves to its own attachment index', () => {
    const node = mrt({ output: vec4(1, 0, 0, 1), aux: vec4(0, 1, 0, 1) });
    const target = gbuffer(['output', 'aux']);

    node.resolveOutputs(
        (name) => target.getTextureIndex(name),
        target.textures.map((t) => t.name),
    );

    expect(node.members).toHaveLength(2);
});

test('an output naming no attachment throws, and says which names the target has', () => {
    const target = gbuffer(['output', 'normal']);

    expect(() => resolveAgainst({ output: vec4(1, 0, 0, 1), noraml: vec4(0, 1, 0, 1) }, target)).toThrow(
        /output 'noraml' names no attachment.*It has: output, normal/,
    );
});

test('a target with no attachments says so rather than listing nothing', () => {
    const target = createRenderTarget(8, 8, { count: 0 });

    expect(() => resolveAgainst({ output: vec4(1, 0, 0, 1) }, target)).toThrow(/It has: \(none\)/);
});
