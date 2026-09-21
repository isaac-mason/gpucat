import type * as Bindings from './bindings';
import type * as Buffers from './buffers';
import type * as Geometries from './geometries';
import type * as Programs from './programs';
import type { RenderObjectGlCache } from './render-object-gl';
import type * as RenderTargets from './render-target';
import type * as Samplers from './samplers';
import type * as Textures from './textures';
/**
 * Every cache the backend owns, as one argument. `WebGLBackend implements` it, so there is no second
 * copy to keep in step. The GL context is not here: it is nullable until `init` acquires it, and an
 * immediate-mode backend passes it explicitly at every call anyway.
 */
export type BackendState = {
    programs: Programs.ProgramCache;
    geometries: Geometries.GeometriesState;
    buffers: Buffers.BufferCache;
    uniforms: Bindings.BindingsState;
    renderObjectGl: RenderObjectGlCache;
    textures: Textures.TextureCache;
    samplers: Samplers.SamplerCache;
    renderTargets: RenderTargets.GlRenderTargetsState;
};
