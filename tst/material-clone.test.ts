import { expect, test } from 'vitest';
import { d, GpuBuffer, Material, vec4 } from '../src/index';
import { makeRenderPipelineKey } from '../src/renderer/webgpu/pipelines';
import { installWebGPUPolyfills } from './stub-gpu';

installWebGPUPolyfills();

const KEY_ARGS = ['12:v|', 1, ['bgra8unorm'] as GPUTextureFormat[], 'depth24plus' as GPUTextureFormat, null] as const;

test('a clone shares the nodes and state, so it keys the same pipeline', () => {
    const material = new Material({
        name: 'quads',
        vertex: { id: 1 } as never,
        fragment: vec4(1, 0, 0, 1),
        transparent: true,
        cullMode: 'none',
        depthBias: 2,
        stencilBack: { func: 'equal' } as never,
    });
    const clone = material.clone();
    expect(clone).not.toBe(material);
    expect(clone.vertex).toBe(material.vertex);
    expect(clone.fragment).toBe(material.fragment);
    expect(clone.name).toBe('quads');
    expect(clone.stencilBack).toEqual(material.stencilBack);
    expect(makeRenderPipelineKey(clone, ...KEY_ARGS)).toBe(makeRenderPipelineKey(material, ...KEY_ARGS));
});

test('a clone starts with its source parameters and sets its own apart', () => {
    const blocks = new GpuBuffer(d.array(d.u32), { count: 4, usage: 'storage' });
    const models = new GpuBuffer(d.array(d.u32), { count: 4, usage: 'storage' });
    const material = new Material({ vertex: { id: 1 } as never });
    material.parameters.setBuffer('quads', blocks);
    const clone = material.clone();
    expect(clone.parameters.buffer('quads')).toBe(blocks);
    clone.parameters.setBuffer('quads', models);
    expect(clone.parameters.buffer('quads')).toBe(models);
    expect(material.parameters.buffer('quads')).toBe(blocks);
});
