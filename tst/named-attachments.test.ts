import { describe, expect, test } from 'vitest';
import { PerspectiveCamera } from '../src/camera/perspective-camera';
import { createRenderTarget } from '../src/core/render-target';
import { renderTexture } from '../src/nodes/lib/display/render-texture-node';
import { mrt } from '../src/nodes/lib/mrt';
import { vec4 } from '../src/nodes/nodes';
import { Scene } from '../src/scene/scene';
import { installWebGPUPolyfills } from './stub-gpu';

installWebGPUPolyfills();

// Colour attachments named and formatted where the target is made, `{ output: 'rgba8unorm', normal: 'rgba16float' }`,
// so an mrt() keyed on those names resolves without renaming `textures[i]` after the fact.

describe('RenderTarget attachments', () => {
    test('names and formats each attachment, in the order written, as its location', () => {
        const rt = createRenderTarget(8, 8, { attachments: { output: 'rgba8unorm', normal: 'rgba16float', ids: 'r32uint' } });
        expect(rt.textures.map((t) => t.name)).toEqual(['output', 'normal', 'ids']);
        expect(rt.textures.map((t) => t.format)).toEqual(['rgba8unorm', 'rgba16float', 'r32uint']);
        expect(rt.getTextureIndex('normal')).toBe(1);
    });

    test('an mrt() keyed on the names resolves against it as made', () => {
        const rt = createRenderTarget(8, 8, { attachments: { output: 'rgba8unorm', normal: 'rgba8unorm' } });
        const node = mrt({ normal: vec4(0, 0, 1, 1), output: vec4(1, 0, 0, 1) });
        node.resolveOutputs(
            (name) => rt.getTextureIndex(name),
            rt.textures.map((t) => t.name),
        );
        expect(node._resolvedNames).toEqual(['output', 'normal']);
    });

    test.each(['count', 'colorFormats', 'colorFormat'] as const)('refuses %s beside it, which it would contradict', (other) => {
        const value = other === 'count' ? 2 : other === 'colorFormats' ? ['rgba8unorm'] : 'rgba8unorm';
        expect(() => createRenderTarget(8, 8, { attachments: { output: 'rgba8unorm' }, [other]: value })).toThrow(
            new RegExp(`${other} has no say`),
        );
    });

    test('refuses an empty set', () => {
        expect(() => createRenderTarget(8, 8, { attachments: {} })).toThrow(/attachments is empty/);
    });

    test("refuses 'depth', the depth attachment's name", () => {
        expect(() => createRenderTarget(8, 8, { attachments: { output: 'rgba8unorm', depth: 'r32float' } })).toThrow(
            /'depth' is the depth attachment's name/,
        );
    });

    test.each(['0', '7', '12'])("refuses '%s', which JS would list first and so give an earlier location", (name) => {
        expect(() => createRenderTarget(8, 8, { attachments: { output: 'rgba8unorm', [name]: 'rgba8unorm' } })).toThrow(
            /looks like an integer/,
        );
    });

    test('a name that only starts with a digit is fine, since JS keeps it where it was written', () => {
        const rt = createRenderTarget(8, 8, { attachments: { output: 'rgba8unorm', '01': 'rgba8unorm', '2d': 'rgba8unorm' } });
        expect(rt.textures.map((t) => t.name)).toEqual(['output', '01', '2d']);
    });
});

describe('renderTexture attachments', () => {
    const camera = new PerspectiveCamera();

    test('makes every attachment up front, so getTexture finds each', () => {
        const pass = renderTexture(new Scene(), camera, { attachments: { output: 'rgba16float', normal: 'rgba8unorm' } });
        expect(pass.renderTarget.textures.map((t) => [t.name, t.format])).toEqual([
            ['output', 'rgba16float'],
            ['normal', 'rgba8unorm'],
        ]);
        expect(pass.getTexture('normal')).toBe(pass.renderTarget.textures[1]);
    });

    test('naming one it lacks throws, rather than adding it', () => {
        const pass = renderTexture(new Scene(), camera, { attachments: { output: 'rgba16float', normal: 'rgba8unorm' } });
        expect(() => pass.getTexture('noraml')).toThrow(/no attachment 'noraml'. It has: output, normal/);
        expect(pass.renderTarget.textures).toHaveLength(2);
    });

    test('setMRT leaves the attachments as given', () => {
        const pass = renderTexture(new Scene(), camera, { attachments: { output: 'rgba16float', normal: 'rgba8unorm' } });
        pass.setMRT(mrt({ output: vec4(1, 0, 0, 1), extra: vec4(0, 1, 0, 1) }));
        expect(pass.renderTarget.textures.map((t) => t.name)).toEqual(['output', 'normal']);
    });

    test('refuses colorFormat beside it', () => {
        expect(() =>
            renderTexture(new Scene(), camera, { attachments: { output: 'rgba8unorm' }, colorFormat: 'rgba8unorm' }),
        ).toThrow(/colorFormat has no say/);
    });
});

describe('renderTexture without attachments', () => {
    const camera = new PerspectiveCamera();

    test('setMRT adds an attachment for each output the pass lacks, in the order the outputs are written', () => {
        const pass = renderTexture(new Scene(), camera);
        pass.setMRT(mrt({ output: vec4(1, 0, 0, 1), normal: vec4(0, 0, 1, 1), diffuse: vec4(0.5, 0.5, 0.5, 1) }));
        expect(pass.renderTarget.textures.map((t) => t.name)).toEqual(['output', 'normal', 'diffuse']);
    });

    test('so the pass renders without each being read first, and reading one later returns it', () => {
        const pass = renderTexture(new Scene(), camera);
        pass.setMRT(mrt({ output: vec4(1, 0, 0, 1), normal: vec4(0, 0, 1, 1) }));
        expect(pass.getTexture('normal')).toBe(pass.renderTarget.textures[1]);
    });

    test('getTexture still adds one it is asked for', () => {
        const pass = renderTexture(new Scene(), camera);
        pass.getTexture('velocity');
        expect(pass.renderTarget.textures.map((t) => t.name)).toEqual(['output', 'velocity']);
    });
});
