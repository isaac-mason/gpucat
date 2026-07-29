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

import { getBindings, type RenderObject } from '../core/render-object';
import type { ProgramInfo } from './programs';
import { getGlSampler, type GlSamplersState } from './samplers';
import { getGlTextureData, updateTexture, type GlTexturesState } from './textures';

/** The combined-sampler uniform name for a texture id (mirrors the GLSL emitter's `samplerUniformName`). */
function samplerUniformName(textureId: string): string {
    return `u_${textureId}`;
}

/** Resolve (and cache) a combined-sampler uniform's location on a program. */
function getSamplerLocation(gl: WebGL2RenderingContext, programInfo: ProgramInfo, name: string): WebGLUniformLocation | null {
    if (programInfo.samplerLocations.has(name)) {
        return programInfo.samplerLocations.get(name) ?? null;
    }
    const loc = gl.getUniformLocation(programInfo.program, name);
    programInfo.samplerLocations.set(name, loc);
    return loc;
}

/**
 * Bind every texture + sampler on a RenderObject into its assigned GL texture units for the given
 * program. Uploads each texture (version-gated) and its paired sampler object, binds them to the
 * unit the GLSL emitter assigned (`entry.binding`), and sets the combined-sampler uniform to that
 * unit. Returns the highest unit used +1 (unused; the caller may ignore it).
 *
 * @param frame the node frame (unused for value sourcing here — texture/sampler node `value` is set
 *   at graph-build time — but kept for symmetry with the uniform path and future update hooks)
 */
export function bindTextures(
    gl: WebGL2RenderingContext,
    textures: GlTexturesState,
    samplers: GlSamplersState,
    renderObject: RenderObject,
    programInfo: ProgramInfo,
): void {
    const bindGroups = getBindings(renderObject);

    // First pass: collect the GpuSampler assigned to each texture unit (samplers share the unit of
    // their paired texture, per the combined-sampler model).
    // We look them up per-unit as we bind textures below.
    for (const bindGroup of bindGroups) {
        for (const binding of bindGroup.bindings) {
            if (binding.kind !== 'texture') continue;

            const entry = binding.entry;
            const unit = entry.binding;
            const gpuTexture = entry.node.value;
            if (!gpuTexture) continue;

            // Upload / allocate the GL texture (version-gated). Render-target textures are allocated
            // by the FBO path; if never seen, updateTexture allocates them here as a safe fallback.
            let texData = getGlTextureData(textures, gpuTexture);
            if (!gpuTexture.isRenderTargetTexture) {
                texData = updateTexture(gl, textures, gpuTexture);
            } else if (!texData) {
                texData = updateTexture(gl, textures, gpuTexture);
            }
            if (!texData) continue;

            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(texData.target, texData.texture);

            // Find the sampler assigned to this same unit and bind its GL sampler object.
            const gpuSampler = findSamplerForUnit(bindGroups, unit);
            if (gpuSampler) {
                const hasMips = gpuTexture.generateMipmaps;
                const glSampler = getGlSampler(gl, samplers, gpuSampler, hasMips);
                gl.bindSampler(unit, glSampler);
            } else {
                // No paired sampler (bare texture handle): clear any stale sampler on the unit so the
                // texture's own parameters apply.
                gl.bindSampler(unit, null);
            }

            // Set the combined-sampler uniform to this texture unit.
            const loc = getSamplerLocation(gl, programInfo, samplerUniformName(entry.textureId));
            if (loc) gl.uniform1i(loc, unit);
        }
    }
}

/** Find the GpuSampler whose SamplerEntry was assigned `unit`, across all of the object's groups. */
function findSamplerForUnit(bindGroups: ReturnType<typeof getBindings>, unit: number) {
    for (const bindGroup of bindGroups) {
        for (const binding of bindGroup.bindings) {
            if (binding.kind === 'sampler' && binding.entry.binding === unit) {
                return binding.entry.samplerNode.value;
            }
        }
    }
    return null;
}
