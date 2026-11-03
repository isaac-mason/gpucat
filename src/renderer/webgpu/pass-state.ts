import type { StateInfo } from '../core/info';

// What a pass encoder has bound, so a draw or dispatch sets only what changed: its pipeline, and each @group's bind
// group and dynamic offset. Render and compute passes keep one each; a render pass adds its vertex and index
// buffers and stencil reference on top (render-pass.ts). Bevy's tracked render pass, for the same reason: WebGPU
// passes every set call through to the GPU process, which pays for each whether or not it changed anything.

type Encoder = GPURenderPassEncoder | GPUComputePassEncoder | GPURenderBundleEncoder;

export type PassState = {
    pipeline: GPURenderPipeline | GPUComputePipeline | null;
    groups: (GPUBindGroup | undefined)[];
    offsets: number[];
    /** where the sets and the skips are counted */
    info: StateInfo;
};

/** @group indices kept: WebGPU's default `maxBindGroups`. Filled from the start so the arrays stay packed. */
const GROUP_SLOTS = 4;

export function createPassState(info: StateInfo): PassState {
    const state: PassState = { pipeline: null, groups: [], offsets: [], info };
    for (let index = 0; index < GROUP_SLOTS; index++) {
        state.groups.push(undefined);
        state.offsets.push(-1);
    }
    return state;
}

/** Nothing bound: a new pass begins, or a bundle replayed and left the encoder's state undefined. Emptied in place, its
 *  arrays' length and packing kept. */
export function resetPassState(state: PassState): void {
    state.pipeline = null;
    for (let index = 0; index < state.groups.length; index++) {
        state.groups[index] = undefined;
        state.offsets[index] = -1;
    }
}

/** Whether `pipeline` must be set, recording it as bound if so. */
export function takesPipeline(state: PassState, pipeline: GPURenderPipeline | GPUComputePipeline): boolean {
    if (state.pipeline === pipeline) {
        state.info.skipped++;
        return false;
    }
    state.pipeline = pipeline;
    state.info.set++;
    return true;
}

/**
 * Each @group of `groups` (at its offset in `offsets`, -1 for none) set on `encoder` where it differs from what is
 * bound. An index the shader skips is undefined: its layout is empty and needs no group.
 */
export function setBindGroups(
    state: PassState,
    encoder: Encoder,
    groups: readonly (GPUBindGroup | undefined)[],
    offsets: readonly number[],
    onSet: ((index: number, group: GPUBindGroup, offset: number) => void) | null,
): void {
    for (let index = 0; index < groups.length; index++) {
        const group = groups[index];
        if (group === undefined) continue;
        const offset = offsets[index]!;
        if (state.groups[index] === group && state.offsets[index] === offset) {
            state.info.skipped++;
            continue;
        }
        if (offset < 0) {
            encoder.setBindGroup(index, group);
        } else {
            _offset[0] = offset;
            encoder.setBindGroup(index, group, _offset, 0, 1);
        }
        state.groups[index] = group;
        state.offsets[index] = offset;
        state.info.set++;
        onSet?.(index, group, offset);
    }
}

/** One dynamic offset, reused so binding a transient block allocates nothing. */
const _offset = /*@__PURE__*/ new Uint32Array(1);
