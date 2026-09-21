import type { DeviceBackend } from '../core/device-backend';
import type { DrawOptions, PassDesc, PassEntry } from '../core/frame';
import type { PreparedRenderObject, PreparedSegment } from '../core/render-types';
import type { Renderer } from '../core/renderer';
import type { WebGLBackend } from './webgl-backend';
export type WebGLFrameBackendState = {
    /** Neutral state: node graph, render objects, pass contexts, inspector, info. */
    renderer: Renderer<DeviceBackend>;
    /** Device state: the GL context, the canvas it lives on and every resource cache. */
    backend: WebGLBackend;
    /** One prepared list per nesting depth, since a nested pass prepares while an outer list is live. */
    preparedByDepth: PreparedRenderObject[][];
    /** Each prepared object's per-submission overrides, same index, same depth. */
    preparedOptsByDepth: (DrawOptions | null)[][];
    segmentsByDepth: PreparedSegment[][];
    depth: number;
};
export declare function createWebGLFrameBackendState(renderer: Renderer<DeviceBackend>, backend: WebGLBackend): WebGLFrameBackendState;
export declare function beginFrame(s: WebGLFrameBackendState): void;
export declare function encodePass(s: WebGLFrameBackendState, desc: PassDesc, records: readonly PassEntry[], count: number): void;
/** Unreachable: `beginComputePass` rejects this backend by name before any dispatch is recorded. */
export declare function encodeComputePass(): never;
/** WebGL2 is immediate mode: the work reached the driver as each pass ended, so neither can undo it. */
export declare function submitFrame(s: WebGLFrameBackendState): void;
export declare function discardFrame(s: WebGLFrameBackendState): void;
