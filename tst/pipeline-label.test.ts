import { expect, test } from 'vitest';
import { Material } from '../src/material/material';
import { f32, vec4 } from '../src/nodes/nodes';
import type { Mesh } from '../src/objects/mesh';
import { pipelineLabel } from '../src/renderer/core/render-object';

const material = (name?: string) =>
    new Material({ vertex: vec4(f32(0), f32(0), f32(0), f32(1)), fragment: vec4(1, 1, 1, 1), name });

const mesh = (name: string) => ({ name }) as Mesh;

/** `MaterialOptions.name` is documented for debugging, so the one debugging path has to consult it. */
test('a named material labels its draw when the mesh has no name', () => {
    expect(pipelineLabel(mesh(''), material('terrain'))).toBe('terrain');
});

test('the mesh name still wins, being the more specific of the two', () => {
    expect(pipelineLabel(mesh('boulder'), material('terrain'))).toBe('boulder');
});

/** With neither named the class is all that is left, which is why every material used to read alike. */
test('an unnamed draw falls back to the class name', () => {
    expect(pipelineLabel(mesh(''), material())).toBe('Material');
});
