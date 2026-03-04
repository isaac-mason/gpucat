/**
 * bindgroups.ts — GPUBindGroup construction.
 *
 * Group 0 (frame): Camera UBO + Time UBO.
 * Group 1 (mesh):  Mesh UBO (binding 0, always) + material uniforms/textures/samplers (binding 1+).
 *
 * The renderer calls these once per frame (group 0) and once per draw (group 1).
 */

import type { CompileResult } from '../nodes/compile.js';
import type { Material } from '../scene/material.js';
import type { Mesh } from '../scene/mesh.js';
import type { BufferCache } from './buffers.js';

// ---------------------------------------------------------------------------
// Group 0 — frame-level (camera + time)
// ---------------------------------------------------------------------------

/**
 * Build the frame-level bind group (group 0).
 *
 * @param device         GPUDevice
 * @param layout         Bind group layout from PipelineEntry.layout0
 * @param cameraBuffer   GPUBuffer containing the Camera UBO (160B)
 * @param timeBuffer     GPUBuffer containing the Time UBO (8B)
 */
export function buildFrameBindGroup(
    device: GPUDevice,
    layout: GPUBindGroupLayout,
    cameraBuffer: GPUBuffer,
    timeBuffer: GPUBuffer,
): GPUBindGroup {
    return device.createBindGroup({
        layout,
        entries: [
            { binding: 0, resource: { buffer: cameraBuffer } },
            { binding: 1, resource: { buffer: timeBuffer } },
        ],
    });
}

// ---------------------------------------------------------------------------
// Group 1 — mesh-level (Mesh UBO + material)
// ---------------------------------------------------------------------------

/**
 * Build the per-mesh bind group (group 1).
 *
 * The Mesh UBO (modelMatrix + normalMatrix) is always at binding 0.
 * Material uniforms, textures, and samplers follow at binding 1+.
 *
 * @param device          GPUDevice
 * @param layout          Bind group layout from PipelineEntry.layout1
 * @param cr              CompileResult for this material
 * @param _mesh           The mesh being drawn (reserved for future use)
 * @param material        The mesh's material
 * @param meshUboBuf      GPUBuffer containing the Mesh UBO (modelMatrix + normalMatrix)
 * @param materialUboBuf  GPUBuffer containing the packed material uniform block (may be null)
 */
export function buildMeshBindGroup(
    device: GPUDevice,
    layout: GPUBindGroupLayout,
    cr: CompileResult,
    _mesh: Mesh | null,
    material: Material,
    meshUboBuf: GPUBuffer,
    materialUboBuf: GPUBuffer | null,
    buffers: BufferCache,
): GPUBindGroup {
    const entries: GPUBindGroupEntry[] = [];

    // Mesh UBO — always at binding 0
    entries.push({ binding: 0, resource: { buffer: meshUboBuf } });

    // Per-material storage buffers (binding 1+)
    for (const s of cr.storage) {
        if (s.group !== 1) continue;
        const buf = buffers.uploadStorage(s.node);
        entries.push({ binding: s.binding, resource: { buffer: buf } });
    }

    // Material uniform block (binding 1+)
    for (const ub of cr.uniforms) {
        if (ub.group !== 1) continue;
        if (!materialUboBuf) {
            throw new Error('[buildMeshBindGroup] materialUboBuf required but not provided');
        }
        entries.push({ binding: ub.binding, resource: { buffer: materialUboBuf } });
    }

    // Textures (binding 1+)
    for (const t of cr.textures) {
        if (t.group !== 1) continue;
        const tex = material.uniforms.get(t.textureId);
        if (!(tex instanceof GPUTextureView) && !(tex && typeof tex === 'object' && 'createView' in tex)) {
            throw new Error(`[buildMeshBindGroup] missing texture '${t.textureId}' in material.uniforms`);
        }
        // Accept either a GPUTextureView directly or a GPUTexture (call createView())
        const view = tex instanceof GPUTextureView
            ? tex
            : (tex as GPUTexture).createView();
        entries.push({ binding: t.binding, resource: view });
    }

    // Samplers (binding 1+)
    for (const s of cr.samplers) {
        if (s.group !== 1) continue;
        const samp = material.uniforms.get(s.samplerId);
        if (!(samp instanceof GPUSampler)) {
            throw new Error(`[buildMeshBindGroup] missing sampler '${s.samplerId}' in material.uniforms`);
        }
        entries.push({ binding: s.binding, resource: samp });
    }

    return device.createBindGroup({ layout, entries });
}

// ---------------------------------------------------------------------------
// Material UBO packing
// ---------------------------------------------------------------------------

/**
 * Pack material uniform values into a Float32Array for GPU upload.
 * Reads values from `material.uniforms` keyed by `uniformId`.
 * Uses byte offsets from `CompileResult.uniforms[0].members`.
 */
export function packMaterialUBO(cr: CompileResult, material: Material): Float32Array | null {
    // Find the group-1 material uniform block
    const ub = cr.uniforms.find((u) => u.group === 1);
    if (!ub || ub.totalBytes === 0) return null;

    const buf = new Float32Array(Math.ceil(ub.totalBytes / 4));
    const bytes = new Uint8Array(buf.buffer);

    for (const member of ub.members) {
        const value = material.uniforms.get(member.uniformId);
        if (value === undefined) continue;

        if (typeof value === 'number') {
            new DataView(bytes.buffer).setFloat32(member.offset, value, true);
        } else if (value instanceof Float32Array) {
            bytes.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), member.offset);
        } else if (Array.isArray(value)) {
            const fa = new Float32Array(value as number[]);
            bytes.set(new Uint8Array(fa.buffer), member.offset);
        }
        // GPUTexture / GPUSampler — not scalar, handled via texture/sampler entries above
    }

    return buf;
}
