import type { StateInfo } from '../core/info';
type Encoder = GPURenderPassEncoder | GPUComputePassEncoder | GPURenderBundleEncoder;
export type PassState = {
    pipeline: GPURenderPipeline | GPUComputePipeline | null;
    groups: (GPUBindGroup | undefined)[];
    offsets: number[];
    /** where the sets and the skips are counted */
    info: StateInfo;
};
export declare function createPassState(info: StateInfo): PassState;
/** Nothing bound: a new pass begins, or a bundle replayed and left the encoder's state undefined. Emptied in place, its
 *  arrays' length and packing kept. */
export declare function resetPassState(state: PassState): void;
/** Whether `pipeline` must be set, recording it as bound if so. */
export declare function takesPipeline(state: PassState, pipeline: GPURenderPipeline | GPUComputePipeline): boolean;
/**
 * Each @group of `groups` (at its offset in `offsets`, -1 for none) set on `encoder` where it differs from what is
 * bound. An index the shader skips is undefined: its layout is empty and needs no group.
 */
export declare function setBindGroups(state: PassState, encoder: Encoder, groups: readonly (GPUBindGroup | undefined)[], offsets: readonly number[], onSet: ((index: number, group: GPUBindGroup, offset: number) => void) | null): void;
export {};
