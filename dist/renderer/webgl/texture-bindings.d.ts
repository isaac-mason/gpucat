/**
 * texture-bindings.ts (webgl) - bind a RenderObject's textures + samplers into GL texture units.
 *
 * WGSL binds a texture and its sampler separately; the GLSL emitter collapses each texture binding
 * into one COMBINED-sampler uniform `uniform sampler2D u_<textureId>;` and assigns it a flat texture
 * unit (the `binding` field on the compiled `TextureEntry`/`SamplerEntry`). The GL mechanics are the
 * reference renderer's: for each texture binding, `activeTexture(TEXTURE0+unit)`, bind the uploaded
 * GL texture, `bindSampler(unit, glSampler)` for the paired sampler, and `uniform1i(location, unit)`
 * on the combined-sampler uniform so the shader samples through that unit.
 *
 * The GpuTexture/GpuSampler are sourced exactly as the WebGPU bindings path does — `entry.node.value`
 * for the texture and `entry.samplerNode.value` for the sampler — so the value resolution is shared,
 * only the GL binding is new here.
 */
import { type RenderObject } from '../core/render-object';
import type { ProgramInfo } from './programs';
import { type GlSamplersState } from './samplers';
import { type GlTexturesState } from './textures';
/**
 * Bind every texture + sampler on a RenderObject into its assigned GL texture units for the given
 * program. Uploads each texture (version-gated) and its paired sampler object, binds them to the
 * unit the GLSL emitter assigned (`entry.binding`), and sets the combined-sampler uniform to that
 * unit. Returns the highest unit used +1 (unused; the caller may ignore it).
 *
 * @param frame the node frame (unused for value sourcing here — texture/sampler node `value` is set
 *   at graph-build time — but kept for symmetry with the uniform path and future update hooks)
 */
export declare function bindTextures(gl: WebGL2RenderingContext, textures: GlTexturesState, samplers: GlSamplersState, renderObject: RenderObject, programInfo: ProgramInfo): void;
