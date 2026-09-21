import type { GpuBuffer } from '../../core/gpu-buffer';
import type { Renderer } from '../core/renderer';
import type { WebGLBackend } from './webgl-backend';
/**
 * Reads a transform-feedback output back to the CPU, the buffer counterpart of `read()` for targets.
 * Typed on the WebGL2 renderer, so reaching for it on WebGPU is a compile error; the kernels
 * themselves run in a `frame.transformFeedback()` pass.
 */
export declare function readBuffer(renderer: Renderer<WebGLBackend>, buffer: GpuBuffer): Promise<Float32Array | Int32Array | Uint32Array>;
