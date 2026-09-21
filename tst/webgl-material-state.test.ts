import { expect, test } from 'vitest';
import { Material } from '../src/material/material';
import { applyMaterialState, createGlStateCache } from '../src/renderer/webgl/state';

/** `gl.polygonOffset` has no clamp, so honouring it would bias differently on the two backends. */
test('a material with depthBiasClamp is refused before any GL call, not quietly dropped', () => {
    const noGl = {} as WebGL2RenderingContext;

    expect(() =>
        applyMaterialState(
            noGl,
            createGlStateCache(),
            new Material({ vertex: { id: 1 } as never, depthBiasClamp: 0.5 }),
            false,
            undefined,
        ),
    ).toThrow(/depthBiasClamp/);
});
