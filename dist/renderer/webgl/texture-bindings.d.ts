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
import type { SamplerEntry, TextureEntry } from '../../nodes/builder';
import { type RenderObject } from '../core/render-object';
import type { ProgramInfo } from './programs';
import { type GlSamplersState } from './samplers';
import { type GlTexturesState } from './textures';
export declare function bindTextures(gl: WebGL2RenderingContext, textures: GlTexturesState, samplers: GlSamplersState, renderObject: RenderObject, programInfo: ProgramInfo): void;
/**
 * Bind a STANDALONE kernel's textures + samplers (transform feedback) into their assigned GL texture
 * units for `programInfo`. The kernel has no RenderObject/BindGroup, so the compiled `TextureEntry[]` /
 * `SamplerEntry[]` (from `compileTransformFeedback`) are consumed directly: each texture's `GpuTexture`
 * (from `entry.node.value`, exactly as the render path sources it) is uploaded (version-gated), bound to
 * the emitter-assigned unit (`entry.binding`), its paired sampler (matched by unit) is bound, and the
 * combined-sampler uniform `u_<textureId>` is set to that unit. The user binds neighbour data as an
 * explicit `DataTexture` referenced by the kernel's `textureLoad` — there is no hidden mirror.
 */
export declare function bindStandaloneTextures(gl: WebGL2RenderingContext, textures: GlTexturesState, samplers: GlSamplersState, textureEntries: readonly TextureEntry[], samplerEntries: readonly SamplerEntry[], programInfo: ProgramInfo): void;
