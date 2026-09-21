import { expect, test } from 'vitest';
import { attribute, compileWgsl, createStorageTexture, createVertexBuffer, d, f32, Geometry, GpuSampler, texture, varying, vec4 } from '../src/index';
import { assertVertexBuffers, type NodeBuilderState } from '../src/renderer/core/node-builder-state';

/** `assertVertexBuffers` reads only the compiled vertex groups, so the rest of the state is irrelevant. */
function stateFor(opts: Parameters<typeof compileWgsl>[0]): NodeBuilderState {
    return { vertexBufferGroups: compileWgsl(opts).vertexBufferGroups } as NodeBuilderState;
}

function positionOnly(): Geometry {
    const geometry = new Geometry();
    geometry.setBuffer('position', createVertexBuffer(d.vec3f, new Float32Array([0, 0, 0])));
    return geometry;
}

test('a geometry missing a buffer the shader reads is named, not left to the backend', () => {
    const colour = attribute('colour', d.vec3f);
    const state = stateFor({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: vec4(varying(colour, 'vColour'), f32(1)),
        depth: undefined,
    });

    expect(() => assertVertexBuffers(positionOnly(), state, 'mesh')).toThrow(/reads vertex buffer 'colour'/);
});

/**
 * The trap this exists for: sampling a texture pulls in the default `varying(uv())`, so the geometry
 * owes a `uv` nothing in the call mentions, and the uv takes location 0 away from `position`.
 */
test('a sampled texture makes the geometry owe a uv, and says so by name', () => {
    const sampled = texture(createStorageTexture(4, 4, 'rgba8unorm'), new GpuSampler({}));
    const state = stateFor({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: vec4(sampled.r, f32(0), f32(0), f32(1)),
        depth: undefined,
    });

    expect(() => assertVertexBuffers(positionOnly(), state, 'mesh')).toThrow(/reads vertex buffer 'uv'/);
});

test('a geometry with every buffer the shader reads passes', () => {
    const state = stateFor({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: vec4(1, 0, 0, 1),
        depth: undefined,
    });

    expect(() => assertVertexBuffers(positionOnly(), state, 'mesh')).not.toThrow();
});
