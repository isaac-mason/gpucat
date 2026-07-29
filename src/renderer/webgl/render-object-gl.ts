/**
 * render-object-gl.ts - WebGL-owned per-draw device payload for RenderObjects.
 *
 * The neutral `RenderObject` (in core/) must not reference raw WebGL handles, so the per-draw GL
 * program lives here, keyed by RenderObject identity in a WeakMap — mirroring
 * `webgpu/render-object-gpu.ts`. The VAO and UBOs are resolved per-draw from the geometry/uniforms
 * caches (they depend on the program), so only the linked program (+ its UBO binding points) is
 * memoized here.
 */

import type { RenderObject } from '../core/render-object';
import type { ProgramInfo } from './programs';

/** The WebGL device payload for a single RenderObject. */
export type RenderObjectGl = {
    /** The linked GL program + resolved UBO binding points. Null until prepared. */
    program: ProgramInfo | null;
};

/** Per-renderer cache mapping RenderObject -> its WebGL device payload. */
export type RenderObjectGlCache = {
    data: WeakMap<RenderObject, RenderObjectGl>;
};

/** Create a new RenderObjectGl cache. */
export function createRenderObjectGlCache(): RenderObjectGlCache {
    return { data: new WeakMap() };
}

/** Get the WebGL device payload for a RenderObject, lazily creating the entry. */
export function getRenderObjectGl(cache: RenderObjectGlCache, renderObject: RenderObject): RenderObjectGl {
    let gl = cache.data.get(renderObject);
    if (!gl) {
        gl = { program: null };
        cache.data.set(renderObject, gl);
    }
    return gl;
}
