import { expect, test } from 'vitest';
import { createRendererInfo } from '../src/renderer/core/info';
import { createPassState, resetPassState, setBindGroups, takesPipeline } from '../src/renderer/webgpu/pass-state';

/** an encoder that only records what is set on it */
function recordingEncoder() {
    const sets: [number, unknown, number][] = [];
    const encoder = {
        setBindGroup: (index: number, group: unknown, offsets?: Uint32Array) => sets.push([index, group, offsets?.[0] ?? -1]),
    } as unknown as GPUComputePassEncoder;
    return { encoder, sets };
}

test('a group already bound at its index, at the same offset, is not set again; the skip is counted', () => {
    const info = createRendererInfo().state;
    const state = createPassState(info);
    const { encoder, sets } = recordingEncoder();
    const a = {} as GPUBindGroup;
    const b = {} as GPUBindGroup;
    setBindGroups(state, encoder, [a, b], [-1, 256], null);
    setBindGroups(state, encoder, [a, b], [-1, 256], null);
    setBindGroups(state, encoder, [a, b], [-1, 512], null);
    expect(sets).toEqual([
        [0, a, -1],
        [1, b, 256],
        [1, b, 512],
    ]);
    expect(info).toMatchObject({ set: 3, skipped: 3 });
});

test('an index a shader skips is left alone, and what is bound past it still holds', () => {
    const info = createRendererInfo().state;
    const state = createPassState(info);
    const { encoder, sets } = recordingEncoder();
    const object = {} as GPUBindGroup;
    setBindGroups(state, encoder, [undefined, undefined, object], [-1, -1, -1], null);
    setBindGroups(state, encoder, [undefined, undefined, object], [-1, -1, -1], null);
    expect(sets).toEqual([[2, object, -1]]);
});

test('a pipeline is set once until another, and a reset forgets everything bound', () => {
    const info = createRendererInfo().state;
    const state = createPassState(info);
    const first = {} as GPUComputePipeline;
    const second = {} as GPUComputePipeline;
    expect(takesPipeline(state, first)).toBe(true);
    expect(takesPipeline(state, first)).toBe(false);
    expect(takesPipeline(state, second)).toBe(true);
    resetPassState(state);
    expect(takesPipeline(state, second)).toBe(true);
    const { encoder, sets } = recordingEncoder();
    const group = {} as GPUBindGroup;
    setBindGroups(state, encoder, [group], [-1], null);
    resetPassState(state);
    setBindGroups(state, encoder, [group], [-1], null);
    expect(sets.length).toBe(2);
});
