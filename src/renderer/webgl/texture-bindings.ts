/**
 * texture-bindings.ts (webgl) - bind a RenderObject's textures + samplers into GL texture units.
 *
 * WGSL binds a texture and its sampler separately; the GLSL emitter collapses each texture binding
 * into one COMBINED-sampler uniform `uniform sampler2D u_<textureId>;` and assigns it a flat texture
 * unit (the `binding` field on the compiled `TextureEntry`/`SamplerEntry`). Per texture binding:
 * `activeTexture(TEXTURE0+unit)`, bind the uploaded
 * GL texture, `bindSampler(unit, glSampler)` for the paired sampler, and `uniform1i(location, unit)`
 * on the combined-sampler uniform so the shader samples through that unit.
 *
 * The GpuTexture/GpuSampler are sourced exactly as the WebGPU bindings path does — `entry.node.value`
 * for the texture and `entry.samplerNode.value` for the sampler — so the value resolution is shared,
 * only the GL binding is new here.
 */

import type { GpuSampler } from '../../core/gpu-sampler';
import type { GpuTexture } from '../../core/gpu-texture';
import type { TextureViewRange } from '../../core/gpu-texture-view';
import type { SamplerEntry, TextureEntry } from '../../nodes/builder';
import { type ResolvedStorageBufferTexture, type StorageBufferTextureSource, storageMirrorGrid } from '../../nodes/lib/texture';
import { getBindings, type RenderObject } from '../core/render-object';
import type { ProgramInfo, TextureUniforms } from './programs';
import { getSampler } from './samplers';
import { unitOf } from './texture-homes';
import {
    bindSamplerUnit,
    bindTextureUnit,
    bindUploadTexture,
    type GlTextureData,
    getTextureData,
    isIntegerTextureFormat,
    type TextureCache,
    updateStorageBufferTexture,
    updateTexture,
} from './textures';
import type { WebGLBackend } from './webgl-backend';

/** The combined-sampler uniform name for a binding's SHADER name (mirrors the GLSL emitter's own
 *  `samplerUniformName`). Keyed on the emitted spelling, not the binding's identity — the two differ
 *  once a texture carries a label. */
function samplerUniformName(shaderName: string): string {
    return `u_${shaderName}`;
}

/** The per-texture flipY uniform name, likewise keyed on the emitted spelling. */
function flipUniformName(shaderName: string): string {
    return `u_flipY_${shaderName}`.replace(/_{2,}/g, '_');
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
            `[webgl] linear filtering of 32-bit float textures requires OES_texture_float_linear, ` +
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
        `[webgl] integer texture format '${textureFormat}' is not texture-filterable; a 'linear' ` +
            `sampler samples it as incomplete (black). Use a 'nearest' filter (or read it with texelFetch/.load()) ` +
            `on the WebGL2 backend.`,
    );
}

/** A texture binding's uniforms on the program, resolved the first time a draw binds it. */
function textureUniformsOf(gl: WebGL2RenderingContext, programInfo: ProgramInfo, shaderName: string): TextureUniforms {
    let uniforms = programInfo.textureUniforms.get(shaderName);
    if (uniforms === undefined) {
        uniforms = {
            sampler: gl.getUniformLocation(programInfo.program, samplerUniformName(shaderName)),
            flip: gl.getUniformLocation(programInfo.program, flipUniformName(shaderName)),
            unit: -1,
            flipped: -1,
        };
        programInfo.textureUniforms.set(shaderName, uniforms);
    }
    return uniforms;
}

/** Points the binding's combined sampler at `unit`, on the program in use. */
function setSamplerUnit(gl: WebGL2RenderingContext, uniforms: TextureUniforms, unit: number): void {
    if (uniforms.sampler === null || uniforms.unit === unit) return;
    gl.uniform1i(uniforms.sampler, unit);
    uniforms.unit = unit;
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
    textures: TextureCache,
    renderObject: RenderObject,
    source: StorageBufferTextureSource,
): ResolvedStorageBufferTexture {
    if (!('name' in source)) return source;
    const buffer = renderObject.geometry.getBuffer(source.name);
    if (!buffer) {
        throw new Error(
            `[webgl] storage('${source.name}') read-lowering: no buffer bound for that name on the ` +
                `geometry — call geometry.setBuffer('${source.name}', buffer).`,
        );
    }
    if (buffer.cpu && buffer.array == null) {
        throw new Error(
            `[webgl] storage('${source.name}') read-lowering: the buffer has no CPU \`array\` to ` +
                `reinterpret (released after upload); keep it resident to sample it on WebGL2.`,
        );
    }
    const bytesPerTexel = source.bytesPerTexel;
    if (textures.maxTextureSize == null) textures.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const grid = storageMirrorGrid(
        buffer.byteLength,
        bytesPerTexel,
        textures.maxTextureSize,
        `[webgl] storage('${source.name}') read-lowering`,
    );
    return { buffer, width: grid.width, height: grid.height, bytesPerTexel };
}

/**
 * The texture and sampler values a draw binds, captured when it is recorded, one entry per texture binding
 * in the order `bindTextures` walks them (a storage-lowered binding holds nulls: its buffer resolves from
 * the geometry when the pass executes, like vertex data). Pooled per record.
 */
export type TextureCapture = {
    textures: (GpuTexture | null)[];
    /** the range of each texture its binding sees */
    ranges: TextureViewRange[];
    samplers: (GpuSampler | null)[];
};

/**
 * Selects the mips `range` covers of the texture bound at the active unit. WebGL2 has no views: a texture's base and
 * max level are set on the texture itself, which is how far a sampled view of a mip range maps to it. A layer, a
 * dimension or an aspect it cannot express.
 */
function applyLevelRange(
    gl: WebGL2RenderingContext,
    textures: TextureCache,
    unit: number,
    texData: GlTextureData,
    gpuTexture: GpuTexture,
    range: TextureViewRange,
): void {
    if (
        range.baseArrayLayer !== 0 ||
        range.arrayLayerCount !== undefined ||
        range.dimension !== undefined ||
        range.aspect !== 'all'
    ) {
        throw new Error(
            `[webgl] texture '${gpuTexture.label ?? gpuTexture.id}' is bound through a view of a layer, a dimension or an ` +
                `aspect, which WebGL2 cannot express: it binds a whole texture, or a range of its mips.`,
        );
    }
    if ((texData.levelRange ?? '') === range.key) return;
    texData.levelRange = range.key;
    // the parameters set the texture the active unit holds: `unit`, which the draw bound it on
    bindUploadTexture(gl, textures, texData.target, texData.texture, unit);
    const last = range.mipLevelCount === undefined ? 1000 : range.baseMipLevel + range.mipLevelCount - 1;
    gl.texParameteri(texData.target, gl.TEXTURE_BASE_LEVEL, range.baseMipLevel);
    gl.texParameteri(texData.target, gl.TEXTURE_MAX_LEVEL, last);
}

/** throws for one draw binding two ranges of a texture: they would be one GL texture with one base and max level */
function assertOneRangePerTexture(
    seen: Map<GpuTexture, TextureViewRange>,
    gpuTexture: GpuTexture,
    range: TextureViewRange,
): void {
    const other = seen.get(gpuTexture);
    if (other !== undefined && other.key !== range.key) {
        throw new Error(
            `[webgl] texture '${gpuTexture.label ?? gpuTexture.id}' is bound through two views in one draw; WebGL2 binds ` +
                `one range of a texture's mips at a time.`,
        );
    }
    seen.set(gpuTexture, range);
}

const _rangesSeen = new Map<GpuTexture, TextureViewRange>();

/** Captures what `renderObject`'s texture bindings hold now, so its draw binds the values set before it. */
export function captureTextures(renderObject: RenderObject, out: TextureCapture): void {
    out.textures.length = 0;
    out.ranges.length = 0;
    out.samplers.length = 0;
    const bindGroups = getBindings(renderObject);
    for (const bindGroup of bindGroups) {
        for (const binding of bindGroup.bindings) {
            if (binding.kind !== 'texture') continue;
            const storageLowered = !!binding.entry.node.storageBufferSource;
            out.textures.push(storageLowered ? null : (binding.entry.node.value ?? null));
            out.ranges.push(binding.entry.node.range);
            out.samplers.push(storageLowered ? null : findSamplerForUnit(bindGroups, binding.entry.binding));
        }
    }
}

/** `capture` is what the draw recorded; null binds the live values (the inspector probe redraws now). */
export function bindTextures(
    gl: WebGL2RenderingContext,
    b: WebGLBackend,
    renderObject: RenderObject,
    programInfo: ProgramInfo,
    capture: TextureCapture | null,
): void {
    const bindGroups = getBindings(renderObject);
    let captured = 0;
    _rangesSeen.clear();

    // First pass: collect the GpuSampler assigned to each texture unit (b.samplers share the unit of
    // their paired texture, per the combined-sampler model).
    // We look them up per-unit as we bind b.textures below.
    for (const bindGroup of bindGroups) {
        for (const binding of bindGroup.bindings) {
            if (binding.kind === 'storageTexture') {
                // Storage b.textures (texture_storage_*, written via textureStore in a compute pass) are
                // a WebGPU-only capability; WebGL2 core has no image load/store.
                throw new Error('[webgl] storage b.textures are not supported on the WebGL2 backend.');
            }
            if (binding.kind !== 'texture') continue;

            const entry = binding.entry;
            if (entry.node.slot !== null) {
                throw new Error(
                    `[webgl] texture slot '${entry.node.slot}' is filled by a compute dispatch, which WebGL2 has none of.`,
                );
            }
            // The program's unit for the texture: its home, shared with every program reading it, or one of the
            // program's own (`texture-homes.ts`). `entry.binding`, the emitter's number, pairs it with its sampler.
            const unit = programInfo.units === null ? entry.binding : unitOf(programInfo.units, entry.shaderName, entry.binding);
            const capturedIndex = captured++;

            // Guard the unit against the device cap: past MAX_COMBINED_TEXTURE_IMAGE_UNITS,
            // `activeTexture(TEXTURE0 + unit)` addresses a non-existent unit and the draw samples garbage. Turn that
            // silent corruption into a clear, actionable error.
            if (b.textures.maxTextureUnits == null) {
                b.textures.maxTextureUnits = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) as number;
            }
            if (unit >= b.textures.maxTextureUnits) {
                throw new Error(
                    `[webgl] a material samples more b.textures + storage buffers than this device's ` +
                        `MAX_COMBINED_TEXTURE_IMAGE_UNITS=${b.textures.maxTextureUnits} (needs unit ${unit}); ` +
                        `reduce the number sampled by one material on the WebGL2 backend.`,
                );
            }

            // storage() read-lowering: the binding is a read-only storage GpuBuffer reinterpreted AS an
            // rgba32uint texture (WebGL2 has no SSBO). Resolve the per-buffer GL texture (version-synced),
            // bind it sampler-less (integer texelFetch needs no sampler), and set its combined-sampler uniform.
            // Uploads bind on their own unit, so none disturbs a unit a draw samples from.
            const storageSource = entry.node.storageBufferSource;
            if (storageSource) {
                // Name-based sources (`storage('slot','read')` + `geometry.setBuffer('slot',…)`) resolve
                // their buffer from THIS render object's geometry now; value-based already carry it.
                const resolved = resolveStorageSource(gl, b.textures, renderObject, storageSource);
                const glTexture = updateStorageBufferTexture(gl, b.textures, resolved);
                bindTextureUnit(gl, b.textures, unit, gl.TEXTURE_2D, glTexture);
                bindSamplerUnit(gl, b.textures, unit, null);
                setSamplerUnit(gl, textureUniformsOf(gl, programInfo, entry.shaderName), unit);
                continue;
            }

            const gpuTexture = capture === null ? entry.node.value : capture.textures[capturedIndex];
            if (!gpuTexture) continue;
            const range = capture === null ? entry.node.range : capture.ranges[capturedIndex]!;
            assertOneRangePerTexture(_rangesSeen, gpuTexture, range);

            // Upload / allocate the GL texture (version-gated). Render-target b.textures are allocated
            // by the FBO path; if never seen, updateTexture allocates them here as a safe fallback.
            let texData = getTextureData(b.textures, gpuTexture);
            if (!gpuTexture.isRenderTargetTexture) {
                texData = updateTexture(gl, b.textures, gpuTexture);
            } else if (!texData) {
                texData = updateTexture(gl, b.textures, gpuTexture);
            }
            if (!texData) continue;

            bindTextureUnit(gl, b.textures, unit, texData.target, texData.texture);
            applyLevelRange(gl, b.textures, unit, texData, gpuTexture, range);

            // Find the sampler paired with it and bind its GL sampler object at its unit.
            const gpuSampler = capture === null ? findSamplerForUnit(bindGroups, entry.binding) : capture.samplers[capturedIndex];
            // Reject a linear filter on a float32 texture when float-linear isn't available (would
            // sample as incomplete/black = wrong output, not just lower quality).
            assertFloatLinearFilterable(gl, gpuTexture.format, gpuSampler);
            assertIntegerNotFiltered(gpuTexture.format, gpuSampler);
            if (gpuSampler) {
                const hasMips = gpuTexture.generateMipmaps;
                const glSampler = getSampler(gl, b.samplers, gpuSampler, hasMips);
                bindSamplerUnit(gl, b.textures, unit, glSampler);
            } else {
                // No paired sampler (bare texture handle): clear any stale sampler on the unit so the
                // texture's own parameters apply.
                bindSamplerUnit(gl, b.textures, unit, null);
            }

            // Set the combined-sampler uniform to this texture unit.
            const uniforms = textureUniformsOf(gl, programInfo, entry.shaderName);
            setSamplerUnit(gl, uniforms, unit);

            // Drive the per-texture flipY conditional (declared only for flip-wrapped 2D samples): a
            // render-target texture was rendered bottom-up vs WebGPU's top-down, so its 2D samples flip V;
            // an ordinary texture (flipped at upload instead) does not. `flip` is null when this texture's
            // samples weren't wrapped, so the set is skipped.
            const flipped = gpuTexture.isRenderTargetTexture ? 1 : 0;
            if (uniforms.flip !== null && uniforms.flipped !== flipped) {
                gl.uniform1i(uniforms.flip, flipped);
                uniforms.flipped = flipped;
            }
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
/** A standalone kernel's texture and sampler values, captured when its dispatch is recorded, in entry order. */
export function captureStandaloneTextures(
    textureEntries: readonly TextureEntry[],
    samplerEntries: readonly SamplerEntry[],
    out: TextureCapture,
): void {
    out.textures.length = 0;
    out.ranges.length = 0;
    out.samplers.length = 0;
    for (const entry of textureEntries) {
        out.textures.push(entry.node.value ?? null);
        out.ranges.push(entry.node.range);
        out.samplers.push(findStandaloneSamplerForUnit(samplerEntries, entry.binding));
    }
}

/** `capture` holds the values the dispatch recorded, one per texture entry. */
export function bindStandaloneTextures(
    gl: WebGL2RenderingContext,
    b: WebGLBackend,
    textureEntries: readonly TextureEntry[],
    programInfo: ProgramInfo,
    capture: TextureCapture,
): void {
    for (let index = 0; index < textureEntries.length; index++) {
        const entry = textureEntries[index];
        const unit = entry.binding;
        const gpuTexture = capture.textures[index];
        if (!gpuTexture) {
            throw new Error(
                `[webgl] transform-feedback kernel samples texture '${entry.textureId}' but no ` +
                    `GpuTexture is bound to it (set the DataTexture on the texture node before dispatch).`,
            );
        }

        let texData = getTextureData(b.textures, gpuTexture);
        if (!gpuTexture.isRenderTargetTexture) {
            texData = updateTexture(gl, b.textures, gpuTexture);
        } else if (!texData) {
            texData = updateTexture(gl, b.textures, gpuTexture);
        }
        if (!texData) continue;

        bindTextureUnit(gl, b.textures, unit, texData.target, texData.texture);
        applyLevelRange(gl, b.textures, unit, texData, gpuTexture, capture.ranges[index]!);

        const gpuSampler = capture.samplers[index];
        assertFloatLinearFilterable(gl, gpuTexture.format, gpuSampler);
        assertIntegerNotFiltered(gpuTexture.format, gpuSampler);
        if (gpuSampler) {
            const hasMips = gpuTexture.generateMipmaps;
            const glSampler = getSampler(gl, b.samplers, gpuSampler, hasMips);
            bindSamplerUnit(gl, b.textures, unit, glSampler);
        } else {
            bindSamplerUnit(gl, b.textures, unit, null);
        }

        setSamplerUnit(gl, textureUniformsOf(gl, programInfo, entry.shaderName), unit);
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
