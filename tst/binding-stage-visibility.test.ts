import { describe, expect, test } from 'vitest';
import {
    attribute,
    compileWgsl,
    createStorageBuffer,
    d,
    Fn,
    f32,
    index,
    STAGE_FRAGMENT,
    STAGE_VERTEX,
    screenUV,
    storage,
    Texture,
    texture,
    u32,
    varying,
    vec4,
} from '../src/index';

function buffer(label: string) {
    return storage(createStorageBuffer(d.array(d.f32), new Float32Array(4), label), 'read');
}

/** each storage entry's stages, by the label its buffer was made with. */
function storageStages(result: ReturnType<typeof compileWgsl>): Record<string, number> {
    const stages: Record<string, number> = {};
    for (const entry of result.storage) stages[entry.name] = entry.visibility;
    return stages;
}

describe('binding stage visibility', () => {
    test('a binding is visible only to the stages that read it', () => {
        const vertexOnly = buffer('vertexOnly');
        const fragmentOnly = buffer('fragmentOnly');
        const both = buffer('both');
        const forVarying = buffer('forVarying');
        const inFragmentFn = buffer('inFragmentFn');

        const readInFn = Fn(() => index(inFragmentFn, u32(0)), { name: 'readInFn', params: [], return: d.f32 });

        const position = attribute('position', d.vec3f);
        const shifted = position.x.add(index(vertexOnly, u32(0))).add(index(both, u32(0)));
        const vertex = vec4(shifted, position.y, position.z, f32(1));
        // read in the vertex stage to give a varying its value, never in the fragment stage
        const carried = varying(index(forVarying, u32(0)), 'carried');
        const fragment = vec4(index(fragmentOnly, u32(0)), index(both, u32(1)), carried, readInFn());

        const stages = storageStages(compileWgsl({ vertex, fragment, depth: undefined }));
        expect(stages).toEqual({
            vertexOnly: STAGE_VERTEX,
            fragmentOnly: STAGE_FRAGMENT,
            both: STAGE_VERTEX | STAGE_FRAGMENT,
            forVarying: STAGE_VERTEX,
            inFragmentFn: STAGE_FRAGMENT,
        });
    });

    test('a texture sampled in the fragment stage, and its sampler, are the fragment stage only', () => {
        const albedo = new Texture(null);
        albedo.name = 'albedo';
        const vertex = vec4(attribute('position', d.vec3f), f32(1));
        const result = compileWgsl({ vertex, fragment: texture(albedo).sample(screenUV), depth: undefined });
        expect(result.textures.map((entry) => entry.visibility)).toEqual([STAGE_FRAGMENT]);
        expect(result.samplers.map((entry) => entry.visibility)).toEqual([STAGE_FRAGMENT]);
    });
});
