import { WebGLBackend, type WebGLBackendOptions } from './webgl-backend';

/** The canvas is required because a WebGL2 context is that canvas's context for its lifetime. */
export function webgl(opts: WebGLBackendOptions): WebGLBackend {
    return new WebGLBackend(opts);
}
