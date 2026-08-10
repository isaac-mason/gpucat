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
import type { ResolvedStorageBufferTexture, StorageBufferTextureSource } from '../../nodes/lib/texture';
import { getBindings, type RenderObject } from '../core/render-object';
import type { ProgramInfo } from './programs';
import { type GlSamplersState, getGlSampler } from './samplers';
import { type GlTexturesState, getGlTextureData, isIntegerTextureFormat, updateStorageBufferTexture, updateTexture } from './textures';

/** The combined-sampler uniform name for a texture id (mirrors the GLSL emitter's `samplerUniformName`). */
function samplerUniformName(textureId: string): string {
    return `u_${textureId}`;
}

/** The per-texture flipY uniform name (mirrors the GLSL emitter's `flipUniformName`). */
function flipUniformName(textureId: string): string {
    return `u_flipY_${textureId}`.replace(/_{2,}/g, '_');
}

/** Cached OES_texture_float_linear support (probed once): null = unprobed, then true/false. */
let floatLinearSupported: boolean | null = null;

/**
 * Guard: sampling a 32-bit float texture with a LINEAR filter needs OES_texture_float_linear. Without
 * it the sample reads as incomplete (black) — a WRONG result, not merely lower quality — so throw a
 * clear error rather than silently render black. Half-float (16float) linear is core in WebGL2, and
 * nearest filtering of float32 is always fine; both are left alone.
 */
function assertFloatLinearFilterable(
    gl: WebGL2RenderingContext,
    textureFormat: string,
    gpuSampler: { minFilter: string; magFilter: string; mipmapFilter: string } | null,
): void {
    if (!textureFormat.includes('32float')) return;
    if (!gpuSampler) return;
    const usesLinear =
        gpuSampler.minFilter === 'linear' || gpuSampler.magFilter === 'linear' || gpuSampler.mipmapFilter === 'linear';
    if (!usesLinear) return;
    if (floatLinearSupported === null) floatLinearSupported = !!gl.getExtension('OES_texture_float_linear');
    if (!floatLinearSupported) {
        throw new Error(
            `[WebGLRenderer] linear filtering of 32-bit float textures requires OES_texture_float_linear, ` +
                `which is not available; use a 'nearest' filter for '${textureFormat}' textures on the WebGL2 backend.`,
        );
    }
}

/**
 * Guard: an integer texture (`…uint`/`…sint`) is never texture-filterable — it must be read with
 * `texelFetch` (nearest). A LINEAR sampler paired with one makes the sample read as incomplete
 * (black) — a WRONG result, not lower quality — so throw a clear error rather than render black.
 * Normally integer textures carry no sampler (texelFetch needs none), so this only fires on a genuine
 * misuse; it mirrors {@link assertFloatLinearFilterable}.
 */
function assertIntegerNotFiltered(
    textureFormat: string,
    gpuSampler: { minFilter: string; magFilter: string; mipmapFilter: string } | null,
): void {
    if (!gpuSampler) return;
    if (!isIntegerTextureFormat(textureFormat)) return;
    const usesLinear =
        gpuSampler.minFilter === 'linear' || gpuSampler.magFilter === 'linear' || gpuSampler.mipmapFilter === 'linear';
    if (!usesLinear) return;
    throw new Error(
        `[WebGLRenderer] integer texture format '${textureFormat}' is not texture-filterable; a 'linear' ` +
            `sampler samples it as incomplete (black). Use a 'nearest' filter (or read it with texelFetch/.load()) ` +
            `on the WebGL2 backend.`,
    );
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

/** Resolve (and cache) a per-texture flipY uniform's location; null when the texture wasn't flip-wrapped. */
function getFlipLocation(gl: WebGL2RenderingContext, programInfo: ProgramInfo, name: string): WebGLUniformLocation | null {
    if (programInfo.flipLocations.has(name)) {
        return programInfo.flipLocations.get(name) ?? null;
    }
    const loc = gl.getUniformLocation(programInfo.program, name);
    programInfo.flipLocations.set(name, loc);
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
/**
 * Resolve a storage()-read mirror source to `{ buffer, width, height }` for {@link updateStorageBufferTexture}.
 * Value-based sources are returned as-is. Name-based sources (`storage('slot', 'read')` bound via
 * `geometry.setBuffer('slot', buf)`) resolve the buffer from THIS render object's geometry and size the
 * texel grid now (`width = min(texels, MAX_TEXTURE_SIZE)`, `height = ceil`) — the shader reads the actual
 * width back via `textureSize()`, so any binding/size works with one compiled shader.
 */
function resolveStorageSource(
    gl: WebGL2RenderingContext,
    textures: GlTexturesState,
    renderObject: RenderObject,
    source: StorageBufferTextureSource,
): ResolvedStorageBufferTexture {
    if (!('name' in source)) return source;
    const buffer = renderObject.geometry.getBuffer(source.name);
    if (!buffer) {
        throw new Error(
            `[WebGLRenderer] storage('${source.name}') read-lowering: no buffer bound for that name on the ` +
                `geometry — call geometry.setBuffer('${source.name}', buffer).`,
        );
    }
    const arr = buffer.array;
    if (arr == null) {
        throw new Error(
            `[WebGLRenderer] storage('${source.name}') read-lowering: the buffer has no CPU \`array\` to ` +
                `reinterpret (released after upload); keep it resident to sample it on WebGL2.`,
        );
    }
    const bytesPerTexel = source.bytesPerTexel;
    if (arr.byteLength === 0 || arr.byteLength % bytesPerTexel !== 0) {
        throw new Error(
            `[WebGLRenderer] storage('${source.name}') read-lowering: buffer byte length ${arr.byteLength} must ` +
                `be a non-zero multiple of ${bytesPerTexel} (whole texels) to reinterpret as a texture.`,
        );
    }
    if (textures.maxTextureSize == null) textures.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const totalTexels = arr.byteLength / bytesPerTexel;
    const width = Math.min(totalTexels, textures.maxTextureSize);
    return { buffer, width, height: Math.ceil(totalTexels / width), bytesPerTexel };
}

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
            if (binding.kind === 'storageTexture') {
                // Storage textures (texture_storage_*, written via textureStore in a compute pass) are
                // a WebGPU-only capability; WebGL2 core has no image load/store.
                throw new Error('[WebGLRenderer] storage textures are not supported on the WebGL2 backend.');
            }
            if (binding.kind !== 'texture') continue;

            const entry = binding.entry;
            const unit = entry.binding;

            // Guard the flat texture-unit assignment against the device cap. Units are `entry.binding`,
            // a 0-based index across every texture + storage-buffer a material samples; once it reaches
            // MAX_COMBINED_TEXTURE_IMAGE_UNITS, `activeTexture(TEXTURE0 + unit)` addresses a non-existent
            // unit and the draw samples garbage. Turn that silent corruption into a clear, actionable error.
            if (textures.maxTextureUnits == null) {
                textures.maxTextureUnits = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) as number;
            }
            if (unit >= textures.maxTextureUnits) {
                throw new Error(
                    `[WebGLRenderer] a material samples more textures + storage buffers than this device's ` +
                        `MAX_COMBINED_TEXTURE_IMAGE_UNITS=${textures.maxTextureUnits} (needs unit ${unit}); ` +
                        `reduce the number sampled by one material on the WebGL2 backend.`,
                );
            }

            // storage() read-lowering: the binding is a read-only storage GpuBuffer reinterpreted AS an
            // rgba32uint texture (WebGL2 has no SSBO). Resolve the per-buffer GL texture (version-synced),
            // bind it sampler-less (integer texelFetch needs no sampler), and set its combined-sampler uniform.
            // Select this binding's unit FIRST: `updateTexture` / `updateStorageBufferTexture` bind the GL
            // texture to the currently-active unit to upload it, so selecting the target unit up front
            // makes that upload-bind land on the right unit. Otherwise the next binding's upload would
            // clobber the texture we just bound to a still-active earlier unit (e.g. a storage integer
            // texture at unit 0 being overwritten by a regular texture's upload, giving a
            // usampler2D/sampler2D format mismatch at draw).
            gl.activeTexture(gl.TEXTURE0 + unit);

            const storageSource = entry.node.storageBufferSource;
            if (storageSource) {
                // Name-based sources (`storage('slot','read')` + `geometry.setBuffer('slot',…)`) resolve
                // their buffer from THIS render object's geometry now; value-based already carry it.
                const resolved = resolveStorageSource(gl, textures, renderObject, storageSource);
                const glTexture = updateStorageBufferTexture(gl, textures, resolved);
                gl.activeTexture(gl.TEXTURE0 + unit); // updateStorageBufferTexture may have left another unit active
                gl.bindTexture(gl.TEXTURE_2D, glTexture);
                gl.bindSampler(unit, null);
                const loc = getSamplerLocation(gl, programInfo, samplerUniformName(entry.textureId));
                if (loc) gl.uniform1i(loc, unit);
                continue;
            }

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

            gl.activeTexture(gl.TEXTURE0 + unit); // updateTexture may have left another unit active
            gl.bindTexture(texData.target, texData.texture);

            // Find the sampler assigned to this same unit and bind its GL sampler object.
            const gpuSampler = findSamplerForUnit(bindGroups, unit);
            // Reject a linear filter on a float32 texture when float-linear isn't available (would
            // sample as incomplete/black = wrong output, not just lower quality).
            assertFloatLinearFilterable(gl, gpuTexture.format, gpuSampler);
            assertIntegerNotFiltered(gpuTexture.format, gpuSampler);
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

            // Drive the per-texture flipY conditional (declared only for flip-wrapped 2D samples): a
            // render-target texture was rendered bottom-up vs WebGPU's top-down, so its 2D samples flip V;
            // an ordinary texture (flipped at upload instead) does not. `getFlipLocation` returns null when
            // this texture's samples weren't wrapped, so the set is skipped.
            const flipLoc = getFlipLocation(gl, programInfo, flipUniformName(entry.textureId));
            if (flipLoc) gl.uniform1i(flipLoc, gpuTexture.isRenderTargetTexture ? 1 : 0);
        }
    }
}

/**
 * Bind a STANDALONE kernel's textures + samplers (transform feedback) into their assigned GL texture
 * units for `programInfo`. The kernel has no RenderObject/BindGroup, so the compiled `TextureEntry[]` /
 * `SamplerEntry[]` (from `compileTransformFeedback`) are consumed directly: each texture's `GpuTexture`
 * (from `entry.node.value`, exactly as the render path sources it) is uploaded (version-gated), bound to
 * the emitter-assigned unit (`entry.binding`), its paired sampler (matched by unit) is bound, and the
 * combined-sampler uniform `u_<textureId>` is set to that unit. The user binds neighbour data as an
 * explicit `DataTexture` referenced by the kernel's `textureLoad` — there is no hidden mirror.
 */
export function bindStandaloneTextures(
    gl: WebGL2RenderingContext,
    textures: GlTexturesState,
    samplers: GlSamplersState,
    textureEntries: readonly TextureEntry[],
    samplerEntries: readonly SamplerEntry[],
    programInfo: ProgramInfo,
): void {
    for (const entry of textureEntries) {
        const unit = entry.binding;
        const gpuTexture = entry.node.value;
        if (!gpuTexture) {
            throw new Error(
                `[WebGLRenderer] transform-feedback kernel samples texture '${entry.textureId}' but no ` +
                    `GpuTexture is bound to it (set the DataTexture on the texture node before dispatch).`,
            );
        }

        let texData = getGlTextureData(textures, gpuTexture);
        if (!gpuTexture.isRenderTargetTexture) {
            texData = updateTexture(gl, textures, gpuTexture);
        } else if (!texData) {
            texData = updateTexture(gl, textures, gpuTexture);
        }
        if (!texData) continue;

        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(texData.target, texData.texture);

        const gpuSampler = findStandaloneSamplerForUnit(samplerEntries, unit);
        assertFloatLinearFilterable(gl, gpuTexture.format, gpuSampler);
        assertIntegerNotFiltered(gpuTexture.format, gpuSampler);
        if (gpuSampler) {
            const hasMips = gpuTexture.generateMipmaps;
            const glSampler = getGlSampler(gl, samplers, gpuSampler, hasMips);
            gl.bindSampler(unit, glSampler);
        } else {
            gl.bindSampler(unit, null);
        }

        const loc = getSamplerLocation(gl, programInfo, samplerUniformName(entry.textureId));
        if (loc) gl.uniform1i(loc, unit);
    }
}

/** Find the GpuSampler whose SamplerEntry was assigned `unit`, among a standalone kernel's samplers. */
function findStandaloneSamplerForUnit(samplerEntries: readonly SamplerEntry[], unit: number) {
    for (const entry of samplerEntries) {
        if (entry.binding === unit) return entry.samplerNode.value;
    }
    return null;
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
