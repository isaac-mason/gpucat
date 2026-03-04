/**
 * bindgroups.ts — GPUBindGroup construction.
 *
 * Group 0 (frame): flat per-field camera/time uniform bindings (three.js style).
 *   Bindings 0–4: cameraProjectionMatrix, cameraViewMatrix, cameraPosition, cameraNear, cameraFar
 *   Bindings 5–6: timeElapsed, timeDelta
 * Group 1 (mesh):  flat mesh bindings (0 = meshModelMatrix, 1 = meshNormalMatrix) + material
 *                  uniforms/textures/samplers starting at binding 2.
 *
 * The renderer calls these once per frame (group 0) and once per draw (group 1).
 */

import type { CompileResult } from '../nodes/compile.js';
import type { Mesh } from '../scene/mesh.js';
import type { BufferCache } from './buffers.js';

// ---------------------------------------------------------------------------
// Group 0 — frame-level (camera + time flat uniforms)
// ---------------------------------------------------------------------------

export type FrameBuffers = {
    /** @group(0) @binding(0) cameraProjectionMatrix : mat4x4f  (64B) */
    camProj:    GPUBuffer | null;
    /** @group(0) @binding(1) cameraViewMatrix : mat4x4f        (64B) */
    camView:    GPUBuffer | null;
    /** @group(0) @binding(2) cameraPosition : vec3f            (16B, std140 padded) */
    camPos:     GPUBuffer | null;
    /** @group(0) @binding(3) cameraNear : f32                  (4B, min 16B) */
    camNear:    GPUBuffer | null;
    /** @group(0) @binding(4) cameraFar : f32                   (4B, min 16B) */
    camFar:     GPUBuffer | null;
    /** @group(0) @binding(5) timeElapsed : f32                 (4B, min 16B) */
    timeElapsed: GPUBuffer | null;
    /** @group(0) @binding(6) timeDelta : f32                   (4B, min 16B) */
    timeDelta:  GPUBuffer | null;
};

/**
 * Build the frame-level bind group (group 0).
 *
 * Only includes entries for bindings declared in the shader (driven by cr.builtinsUsed).
 * The layout must have been built from the same CompileResult via _buildLayout0.
 */
export function buildFrameBindGroup(
    device: GPUDevice,
    layout: GPUBindGroupLayout,
    cr: CompileResult,
    bufs: FrameBuffers,
): GPUBindGroup {
    const entries: GPUBindGroupEntry[] = [];

    if (cr.builtinsUsed.has('camera')) {
        entries.push({ binding: 0, resource: { buffer: bufs.camProj! } });
        entries.push({ binding: 1, resource: { buffer: bufs.camView! } });
        entries.push({ binding: 2, resource: { buffer: bufs.camPos! } });
        entries.push({ binding: 3, resource: { buffer: bufs.camNear! } });
        entries.push({ binding: 4, resource: { buffer: bufs.camFar! } });
    }
    if (cr.builtinsUsed.has('time')) {
        entries.push({ binding: 5, resource: { buffer: bufs.timeElapsed! } });
        entries.push({ binding: 6, resource: { buffer: bufs.timeDelta! } });
    }

    return device.createBindGroup({ layout, entries });
}

// ---------------------------------------------------------------------------
// Group 1 — mesh-level (flat mesh bindings + material)
// ---------------------------------------------------------------------------

/**
 * Build the per-mesh bind group (group 1).
 *
 * Mesh flat bindings (when 'mesh' is used by the shader):
 *   binding 0: meshModelMatrix : mat4x4f
 *   binding 1: meshNormalMatrix : mat3x3f
 * Material uniforms, textures, and samplers follow at binding 2+.
 *
 * @param device              GPUDevice
 * @param layout              Bind group layout from PipelineEntry.layout1
 * @param cr                  CompileResult for this material
 * @param _mesh               The mesh being drawn (reserved for future use)
 * @param meshModelMatrixBuf  GPUBuffer for meshModelMatrix (may be null if mesh not used)
 * @param meshNormalMatrixBuf GPUBuffer for meshNormalMatrix (may be null if mesh not used)
 * @param materialUboBuf      GPUBuffer containing the packed material uniform block (may be null)
 */
export function buildMeshBindGroup(
    device: GPUDevice,
    layout: GPUBindGroupLayout,
    cr: CompileResult,
    _mesh: Mesh | null,
    meshModelMatrixBuf: GPUBuffer | null,
    meshNormalMatrixBuf: GPUBuffer | null,
    materialUboBuf: GPUBuffer | null,
    buffers: BufferCache,
): GPUBindGroup {
    const entries: GPUBindGroupEntry[] = [];

    // Flat mesh bindings
    if (cr.builtinsUsed.has('mesh')) {
        entries.push({ binding: 0, resource: { buffer: meshModelMatrixBuf! } });
        entries.push({ binding: 1, resource: { buffer: meshNormalMatrixBuf! } });
    }

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
        const res = t.node.resource;
        if (res === null) {
            throw new Error(`[buildMeshBindGroup] TextureNode '${t.textureId}' has no resource set`);
        }
        const view = res instanceof GPUTextureView ? res : (res as GPUTexture).createView();
        entries.push({ binding: t.binding, resource: view });
    }

    // Samplers (binding 1+)
    for (const s of cr.samplers) {
        if (s.group !== 1) continue;
        const samp = s.node.resource;
        if (samp === null) {
            throw new Error(`[buildMeshBindGroup] SamplerNode '${s.samplerId}' has no resource set`);
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
 * Reads values from each member's node.value directly.
 * Uses byte offsets from `CompileResult.uniforms[0].members`.
 */
export function packMaterialUBO(cr: CompileResult): Float32Array | null {
    // Find the group-1 material uniform block
    const ub = cr.uniforms.find((u) => u.group === 1);
    if (!ub || ub.totalBytes === 0) return null;

    const buf = new Float32Array(Math.ceil(ub.totalBytes / 4));
    const bytes = new Uint8Array(buf.buffer);

    for (const member of ub.members) {
        const value = member.node.value;
        if (value === null || value === undefined) continue;

        if (typeof value === 'number') {
            new DataView(bytes.buffer).setFloat32(member.offset, value, true);
        } else if (value instanceof Float32Array) {
            bytes.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), member.offset);
        } else if (Array.isArray(value)) {
            const fa = new Float32Array(value as number[]);
            bytes.set(new Uint8Array(fa.buffer), member.offset);
        }
    }

    return buf;
}
