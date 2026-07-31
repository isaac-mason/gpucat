import { describe, expect, test } from 'vitest';
import { sampleTypeForFormat, samplerBindingType, textureBindingLayout } from '../src/renderer/webgpu/bind-group-layout';

// Robustness parity with three.js's WebGPUBindingUtils: the bind-group-layout sampleType must match
// the bound texture's filterability (32-bit float = unfilterable unless float32-filterable), integer
// formats map to uint/sint, multisampled color is unfilterable-float, and the sampler binding type is
// derived from the actual sampler settings (comparison / non-filtering / filtering).

const texEntry = (type: string, format?: string) =>
    ({ type, binding: 0, node: { value: format ? { format } : null } }) as never;

const samplerEntry = (type: 'sampler' | 'sampler_comparison', sampler?: unknown) =>
    ({ type, binding: 0, samplerNode: { value: sampler } }) as never;

describe('sampleTypeForFormat', () => {
    test('32-bit float is unfilterable unless float32-filterable is enabled', () => {
        expect(sampleTypeForFormat('rgba32float', false)).toBe('unfilterable-float');
        expect(sampleTypeForFormat('r32float', false)).toBe('unfilterable-float');
        expect(sampleTypeForFormat('rg32float', false)).toBe('unfilterable-float');
        expect(sampleTypeForFormat('rgba32float', true)).toBe('float'); // feature enabled → filterable
    });

    test('integer formats map to uint/sint', () => {
        expect(sampleTypeForFormat('rgba8uint', false)).toBe('uint');
        expect(sampleTypeForFormat('r32uint', false)).toBe('uint');
        expect(sampleTypeForFormat('rgba16sint', false)).toBe('sint');
    });

    test('filterable formats (unorm / 16-bit float) stay float', () => {
        expect(sampleTypeForFormat('rgba8unorm', false)).toBe('float');
        expect(sampleTypeForFormat('rgba16float', false)).toBe('float');
        expect(sampleTypeForFormat(undefined, false)).toBe('float');
    });
});

describe('textureBindingLayout', () => {
    test('rgba32float sampled texture → unfilterable-float', () => {
        expect(textureBindingLayout(texEntry('texture_2d<f32>', 'rgba32float'), false).sampleType).toBe('unfilterable-float');
    });

    test('depth textures → depth (regardless of format lookup)', () => {
        expect(textureBindingLayout(texEntry('texture_depth_2d'), false).sampleType).toBe('depth');
    });

    test('multisampled color → multisampled + unfilterable-float', () => {
        const layout = textureBindingLayout(texEntry('texture_multisampled_2d<f32>'), false);
        expect(layout.multisampled).toBe(true);
        expect(layout.sampleType).toBe('unfilterable-float');
    });

    test('view dimension is derived from the type', () => {
        expect(textureBindingLayout(texEntry('texture_cube<f32>', 'rgba8unorm'), false).viewDimension).toBe('cube');
        expect(textureBindingLayout(texEntry('texture_2d_array<f32>', 'rgba8unorm'), false).viewDimension).toBe('2d-array');
    });
});

describe('samplerBindingType', () => {
    test('comparison sampler type → comparison', () => {
        expect(samplerBindingType(samplerEntry('sampler_comparison'))).toBe('comparison');
    });

    test('sampler with a compare function → comparison', () => {
        expect(samplerBindingType(samplerEntry('sampler', { compare: 'less', minFilter: 'linear', magFilter: 'linear', mipmapFilter: 'linear' }))).toBe('comparison');
    });

    test('all-nearest, no-compare sampler → non-filtering', () => {
        expect(samplerBindingType(samplerEntry('sampler', { minFilter: 'nearest', magFilter: 'nearest', mipmapFilter: 'nearest' }))).toBe('non-filtering');
    });

    test('linear sampler → filtering', () => {
        expect(samplerBindingType(samplerEntry('sampler', { minFilter: 'linear', magFilter: 'linear', mipmapFilter: 'nearest' }))).toBe('filtering');
    });
});
