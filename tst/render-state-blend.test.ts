/* The backend-neutral blend policy: the transparent default, and MRT target precedence. */

import { describe, expect, test } from 'vitest';
import { attribute, f32, vec4 } from '../src/index';
import { BlendMode } from '../src/material/blend-mode';
import { Material } from '../src/material/material';
import { MRTNode } from '../src/nodes/lib/mrt';
import { blendModeState, defaultBlendState, materialBlendState, resolveTargetBlend } from '../src/renderer/core/render-state';
import * as d from '../src/schema/schema';

const graph = () => ({ vertex: vec4(attribute('position', d.vec3f), f32(1)), fragment: vec4(1, 1, 1, 1) });

const opaque = () => new Material(graph());
const translucent = () => new Material({ ...graph(), transparent: true });

/** An MRT with one named target per entry, each carrying the given blend mode. */
function mrtWith(modes: Record<string, BlendMode>): MRTNode {
    const node = new MRTNode({});
    for (const [name, mode] of Object.entries(modes)) node.setBlendMode(name, mode);
    return node;
}

describe('material blend', () => {
    test('an opaque material does not blend', () => {
        expect(materialBlendState(opaque())).toBeUndefined();
    });

    test('transparent with no explicit blend falls back to the default rather than to no-blend', () => {
        // The regression this whole module exists for: reading `material.blend` alone left every
        // transparent-by-default material unblended on one backend and blended on the other.
        expect(materialBlendState(translucent())).toEqual(defaultBlendState());
    });

    test('an explicit blend wins over the default', () => {
        const blend: GPUBlendState = {
            color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        };
        expect(materialBlendState(new Material({ ...graph(), transparent: true, blend }))).toBe(blend);
    });

    test('an explicit blend on an opaque material is inert', () => {
        const blend: GPUBlendState = {
            color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        };
        expect(materialBlendState(new Material({ ...graph(), blend }))).toBeUndefined();
    });
});

describe('target precedence', () => {
    test('no MRT context defers to the material', () => {
        expect(resolveTargetBlend(translucent(), null, null)).toEqual(defaultBlendState());
        expect(resolveTargetBlend(opaque(), null, null)).toBeUndefined();
    });

    test("'material' inherits the material's blend", () => {
        const mrt = mrtWith({ output: new BlendMode('material') });
        expect(resolveTargetBlend(translucent(), mrt, 'output')).toEqual(defaultBlendState());
        expect(resolveTargetBlend(opaque(), mrt, 'output')).toBeUndefined();
    });

    test("'no' disables blending even for a transparent material", () => {
        const mrt = mrtWith({ normal: new BlendMode('no') });
        expect(resolveTargetBlend(translucent(), mrt, 'normal')).toBeUndefined();
    });

    test('an unnamed target defaults to no-blend', () => {
        const mrt = mrtWith({ output: new BlendMode('material') });
        expect(resolveTargetBlend(translucent(), mrt, 'velocity')).toBeUndefined();
    });

    test('an explicit mode overrides the material', () => {
        const mrt = mrtWith({ output: new BlendMode('additive') });
        expect(resolveTargetBlend(opaque(), mrt, 'output')).toEqual(blendModeState(new BlendMode('additive')));
    });
});

describe('blend mode translation', () => {
    test('straight vs premultiplied alpha differ only in the color source factor', () => {
        const straight = new BlendMode('normal');
        const premultiplied = new BlendMode('normal');
        premultiplied.premultiplyAlpha = true;

        expect(blendModeState(straight).color.srcFactor).toBe('src-alpha');
        expect(blendModeState(premultiplied).color.srcFactor).toBe('one');
        expect(blendModeState(straight).alpha).toEqual(blendModeState(premultiplied).alpha);
    });

    test('custom blending carries the per-channel factors through, defaulting alpha to color', () => {
        const mode = new BlendMode('custom');
        mode.blendSrc = 'dst';
        mode.blendDst = 'src';
        mode.blendEquation = 'subtract';
        expect(blendModeState(mode)).toEqual({
            color: { srcFactor: 'dst', dstFactor: 'src', operation: 'subtract' },
            alpha: { srcFactor: 'dst', dstFactor: 'src', operation: 'subtract' },
        });
    });

    test('subtractive and multiply are rejected without premultiplied alpha', () => {
        for (const blending of ['subtractive', 'multiply'] as const) {
            const mode = new BlendMode(blending);
            expect(blendModeState(mode)).toEqual(defaultBlendState());
            mode.premultiplyAlpha = true;
            expect(blendModeState(mode)).not.toEqual(defaultBlendState());
        }
    });
});
