import { WebGLBackend, type WebGLBackendOptions } from './webgl-backend';
/** The canvas is required because a WebGL2 context is that canvas's context for its lifetime. */
export declare function webgl(opts: WebGLBackendOptions): WebGLBackend;
