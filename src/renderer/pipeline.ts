/**
 * pipeline.ts — Async-aware GPURenderPipeline cache.
 *
 * Cache key = stable hash of (positionGraph, colorGraph, renderState, samples).
 * On miss: compile node graphs → build pipeline layout → createRenderPipelineAsync.
 * On hit: return the cached pipeline (or 'pending' if still compiling).
 *
 * Draws that need a not-yet-ready pipeline are skipped by the renderer.
 */

import { compile, type CompileResult } from '../nodes/compile.js';
import { positionClip } from '../nodes/nodes.js';
import type { Node, WgslType } from '../nodes/nodes.js';
import type { Material } from '../scene/material.js';
import type { Geometry } from '../scene/geometry.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PipelineEntry = {
    pipeline: GPURenderPipeline;
    compileResult: CompileResult;
    /** Bind group layout for group 0 (camera + time). */
    layout0: GPUBindGroupLayout;
    /** Bind group layout for group 1 (instance + material). */
    layout1: GPUBindGroupLayout;
};

// ---------------------------------------------------------------------------
// PipelineCache
// ---------------------------------------------------------------------------

export class PipelineCache {
    private readonly device: GPUDevice;
    private readonly format: GPUTextureFormat;
    private readonly depthFormat: GPUTextureFormat = 'depth24plus';

    /** Resolved pipelines. */
    private readonly ready: Map<string, PipelineEntry> = new Map();
    /** In-flight async compilations, keyed by pipeline key. */
    private readonly pending: Map<string, Promise<PipelineEntry>> = new Map();

    constructor(device: GPUDevice, format: GPUTextureFormat) {
        this.device = device;
        this.format = format;
    }

    /**
     * Returns the cached PipelineEntry for `key`, or undefined if not ready.
     * Triggers async compilation on first call for a given key.
     */
    get(
        key: string,
        material: Material,
        geometry: Geometry,
        samples: number,
        format: GPUTextureFormat = this.format,
    ): PipelineEntry | undefined {
        if (this.ready.has(key)) return this.ready.get(key)!;

        if (!this.pending.has(key)) {
            this._startCompile(key, material, geometry, samples, format);
        }

        return undefined;
    }

    /**
     * Returns a Promise that resolves to the PipelineEntry.
     * If already compiled, resolves immediately.
     * If compilation is in-flight, returns the same Promise (deduplicates).
     * If not yet started, kicks off compilation and returns the Promise.
     * Used by renderer.compile() to pre-warm a pipeline before the frame loop.
     */
    getAsync(
        key: string,
        material: Material,
        geometry: Geometry,
        samples: number,
        format: GPUTextureFormat = this.format,
    ): Promise<PipelineEntry> {
        if (this.ready.has(key)) return Promise.resolve(this.ready.get(key)!);
        if (this.pending.has(key)) return this.pending.get(key)!;
        return this._startCompile(key, material, geometry, samples, format);
    }

    private _startCompile(
        key: string,
        material: Material,
        geometry: Geometry,
        samples: number,
        format: GPUTextureFormat,
    ): Promise<PipelineEntry> {
        const p = this._compile(key, material, geometry, samples, format);
        this.pending.set(key, p);
        p.then(() => {
            this.pending.delete(key);
        }).catch((err) => {
            this.pending.delete(key);
            console.error('[PipelineCache] pipeline compilation failed:', err);
        });
        return p;
    }

    private async _compile(
        key: string,
        material: Material,
        geometry: Geometry,
        samples: number,
        format: GPUTextureFormat = this.format,
    ): Promise<PipelineEntry> {
        const positionGraph: Node<WgslType> = material.position ?? positionClip;
        const colorGraph: Node<WgslType> = material.color;

        const cr = compile({ position: positionGraph, color: colorGraph });

        // Build bind group layouts from CompileResult.
        const layout0 = this._buildLayout0(cr);
        const layout1 = this._buildLayout1(cr);

        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [layout0, layout1],
        });

        const shaderModule = this.device.createShaderModule({ code: cr.code });

        // Build vertex buffer layouts from CompileResult.attributes + geometry.attributes.
        const vertexBuffers = buildVertexBufferLayouts(cr, geometry);

        // Build color target state from material render state.
        const colorTargets: GPUColorTargetState[] = [];
        for (let i = 0; i < material.targets; i++) {
            colorTargets.push({
                format,
                blend: material.blend,
                writeMask: GPUColorWrite.ALL,
            });
        }

        const depthCompare: GPUCompareFunction = !material.depthTest ? 'always' : material.depthCompare;

        const descriptor: GPURenderPipelineDescriptor = {
            layout: pipelineLayout,
            vertex: {
                module: shaderModule,
                entryPoint: 'vs_main',
                buffers: vertexBuffers,
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: colorTargets,
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: material.cullMode,
            },
            depthStencil: {
                format: this.depthFormat,
                depthWriteEnabled: material.depthWrite,
                depthCompare,
            },
            multisample: samples > 1
                ? { count: samples, alphaToCoverageEnabled: material.alphaToCoverage }
                : undefined,
        };

        const pipeline = await this.device.createRenderPipelineAsync(descriptor);

        const entry: PipelineEntry = { pipeline, compileResult: cr, layout0, layout1 };
        this.ready.set(key, entry);
        this.pending.delete(key);
        return entry;
    }

    // -----------------------------------------------------------------------
    // Bind group layout builders
    // -----------------------------------------------------------------------

    /** Group 0: flat per-field camera/time uniform bindings, dynamic based on shader usage. */
    private _buildLayout0(cr: CompileResult): GPUBindGroupLayout {
        const entries: GPUBindGroupLayoutEntry[] = [];
        const vis = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;

        if (cr.builtinsUsed.has('camera')) {
            // bindings 0–4: projectionMatrix, viewMatrix, position, near, far
            for (let b = 0; b <= 4; b++) {
                entries.push({ binding: b, visibility: vis, buffer: { type: 'uniform' } });
            }
        }
        if (cr.builtinsUsed.has('time')) {
            // bindings 5–6: elapsed, delta
            entries.push({ binding: 5, visibility: vis, buffer: { type: 'uniform' } });
            entries.push({ binding: 6, visibility: vis, buffer: { type: 'uniform' } });
        }

        return this.device.createBindGroupLayout({ entries });
    }

    /**
     * Group 1: flat mesh bindings (0 = meshModelMatrix, 1 = meshNormalMatrix) when 'mesh' is
     * used, then material resources (uniforms, textures, samplers) starting at binding 2.
     *
     * InstancedBufferAttributeNodes are vertex buffers, not bind group entries — they are
     * NOT included here.
     */
    private _buildLayout1(cr: CompileResult): GPUBindGroupLayout {
        const entries: GPUBindGroupLayoutEntry[] = [];

        // Mesh flat bindings — always present when the shader references mesh fields
        if (cr.builtinsUsed.has('mesh')) {
            // binding 0: meshModelMatrix : mat4x4f
            entries.push({
                binding: 0,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: { type: 'uniform' },
            });
            // binding 1: meshNormalMatrix : mat3x3f
            entries.push({
                binding: 1,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: { type: 'uniform' },
            });
        }

        // Per-material storage buffers (binding 1+)
        // Render shaders emit all storage buffers as var<storage, read> (the WGSL module is shared
        // between vertex and fragment stages, and read_write is forbidden in the vertex stage).
        // The bind group layout therefore always uses read-only-storage here, regardless of the
        // node's access field.  Read-write access is only relevant for compute passes.
        for (const s of cr.storage) {
            if (s.group !== 1) continue;
            entries.push({
                binding: s.binding,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: { type: 'read-only-storage' },
            });
        }

        // Material uniform blocks (binding 1+)
        for (const ub of cr.uniforms) {
            if (ub.group !== 1) continue;
            entries.push({
                binding: ub.binding,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: { type: 'uniform' },
            });
        }

        // Textures (binding 1+)
        for (const t of cr.textures) {
            if (t.group !== 1) continue;
            entries.push({
                binding: t.binding,
                visibility: GPUShaderStage.FRAGMENT,
                texture: {},
            });
        }

        // Samplers (binding 1+)
        for (const s of cr.samplers) {
            if (s.group !== 1) continue;
            entries.push({
                binding: s.binding,
                visibility: GPUShaderStage.FRAGMENT,
                sampler: {},
            });
        }

        return this.device.createBindGroupLayout({ entries });
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build GPUVertexBufferLayout[] from CompileResult.attributes + Geometry.attributes.
 *
 * - kind: 'geometry' — look up format/stride/offset from geometry.attributes
 * - kind: 'instanced' — derive format from WGSL type, use node.stride/node.offset, stepMode: 'instance'
 */
function buildVertexBufferLayouts(cr: CompileResult, geometry: Geometry): GPUVertexBufferLayout[] {
    const layouts: GPUVertexBufferLayout[] = [];

    for (const attrEntry of cr.attributes) {
        if (attrEntry.kind === 'geometry') {
            const bufAttr = geometry.attributes.get(attrEntry.name);
            if (!bufAttr) {
                throw new Error(
                    `[PipelineCache] geometry is missing required attribute '${attrEntry.name}' (expected by shader)`
                );
            }
            const stride = bufAttr.stride > 0 ? bufAttr.stride : gpuFormatByteSize(bufAttr.format);
            layouts.push({
                arrayStride: stride,
                stepMode: 'vertex',
                attributes: [
                    {
                        shaderLocation: attrEntry.location,
                        offset: bufAttr.offset,
                        format: bufAttr.format,
                    },
                ],
            });
        } else {
            // kind: 'instanced' — per-instance vertex buffer from InstancedBufferAttributeNode
            const node = attrEntry.node;
            const format = wgslTypeToVertexFormat(attrEntry.type);
            layouts.push({
                arrayStride: node.stride,
                stepMode: 'instance',
                attributes: [
                    {
                        shaderLocation: attrEntry.location,
                        offset: node.offset,
                        format,
                    },
                ],
            });
        }
    }

    return layouts;
}

/** Byte size of a GPUVertexFormat. */
function gpuFormatByteSize(format: GPUVertexFormat): number {
    switch (format) {
        case 'float32':   case 'uint32':   case 'sint32':   return 4;
        case 'float32x2': case 'uint32x2': case 'sint32x2': return 8;
        case 'float32x3': case 'uint32x3': case 'sint32x3': return 12;
        case 'float32x4': case 'uint32x4': case 'sint32x4': return 16;
        case 'float16x2': case 'unorm16x2': case 'snorm16x2': case 'uint16x2': case 'sint16x2': return 4;
        case 'float16x4': case 'unorm16x4': case 'snorm16x4': case 'uint16x4': case 'sint16x4': return 8;
        case 'unorm8x2':  case 'snorm8x2':  case 'uint8x2':  case 'sint8x2':  return 2;
        case 'unorm8x4':  case 'snorm8x4':  case 'uint8x4':  case 'sint8x4':  return 4;
        default: return 4;
    }
}

/** Map a WGSL scalar/vector type to the matching GPUVertexFormat (float32 variants). */
function wgslTypeToVertexFormat(type: string): GPUVertexFormat {
    switch (type) {
        case 'f32':    return 'float32';
        case 'vec2f':  return 'float32x2';
        case 'vec3f':  return 'float32x3';
        case 'vec4f':  return 'float32x4';
        case 'i32':    return 'sint32';
        case 'vec2i':  return 'sint32x2';
        case 'vec3i':  return 'sint32x3';
        case 'vec4i':  return 'sint32x4';
        case 'u32':    return 'uint32';
        case 'vec2u':  return 'uint32x2';
        case 'vec3u':  return 'uint32x3';
        case 'vec4u':  return 'uint32x4';
        default:       return 'float32x4';
    }
}

// ---------------------------------------------------------------------------
// Pipeline cache key generation
// ---------------------------------------------------------------------------

/**
 * Stable cache key for a material + MSAA sample count.
 *
 * We hash the node graph IDs (which are already content-addressed) plus all
 * render-state fields that affect the GPURenderPipeline descriptor.
 */
export function makePipelineKey(material: Material, samples: number, format: GPUTextureFormat): string {
    // Node graph IDs are content-addressed — they ARE the hash of the graph.
    // We just need to extract their string IDs.
    const posId = material.position ? nodeGraphId(material.position) : '__default__';
    const colId = nodeGraphId(material.color);

    const rs = [
        material.transparent ? 1 : 0,
        material.depthWrite ? 1 : 0,
        material.depthTest ? 1 : 0,
        material.depthCompare,
        material.cullMode,
        material.alphaToCoverage ? 1 : 0,
        material.targets,
        samples,
        format,
        material.blend ? JSON.stringify(material.blend) : 'none',
    ].join('|');

    return `${posId}::${colId}::${rs}`;
}

/** Extract the stable content-addressed ID from a Node object. */
function nodeGraphId(node: Node<WgslType>): string {
    return node.id;
}
