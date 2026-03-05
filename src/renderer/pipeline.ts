/**
 * pipeline.ts — Async-aware GPURenderPipeline cache (Three.js aligned).
 *
 * Following Three.js's pattern:
 * - Pipeline layout is built from only non-empty bind groups
 * - Each bind group has a dynamic index based on which groups are present
 * - Empty bind groups are not included in the pipeline layout
 *
 * Cache key = stable hash of (positionGraph, colorGraph, renderState, samples).
 * On miss: compile node graphs → build pipeline layout → createRenderPipelineAsync.
 * On hit: return the cached pipeline (or 'pending' if still compiling).
 *
 * Draws that need a not-yet-ready pipeline are skipped by the renderer.
 */

import { compile, type CompileResult } from '../nodes/compile';
import { OutputStructNode } from '../nodes/nodes';
import type { Node, WgslType } from '../nodes/nodes';
import type { Material } from '../scene/material';
import type { Geometry } from '../scene/geometry';
import { buildBindGroupInfo, type BindGroupInfo } from './bindgroups';

function getTargetCount(fragmentNode: Node<WgslType>): number {
    if (fragmentNode instanceof OutputStructNode) {
        return Math.max(1, fragmentNode.members.length);
    }
    return 1;
}

export type PipelineEntry = {
    pipeline: GPURenderPipeline;
    compileResult: CompileResult;
    bindGroupInfo: BindGroupInfo;
};

export type PipelineCacheStats = {
    readyCount: number;
    pendingCount: number;
};

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

    /** Returns pipeline counts for the Inspector memory/performance tabs. */
    getStats(): PipelineCacheStats {
        return {
            readyCount: this.ready.size,
            pendingCount: this.pending.size,
        };
    }

    /**
     * Returns the CompileResult for the given key if the pipeline is already
     * compiled, or null otherwise.  Does NOT trigger compilation.
     *
     * Used by the renderer to access updateBeforeNodes synchronously — the
     * fullscreen composite pipeline must already be compiled (via compile())
     * before this is called.
     */
    getCompileResult(key: string): CompileResult | null {
        return this.ready.get(key)?.compileResult ?? null;
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
        const vertex: Node<WgslType> = material.vertexNode;
        const fragment: Node<WgslType> = material.fragmentNode;

        const cr = compile({
            position: vertex,
            color: fragment,
            mask:  material.maskNode,
            depth: material.depthNode,
        });

        // Build bind group info (Three.js aligned - only non-empty groups)
        const bindGroupInfo = buildBindGroupInfo(this.device, cr);

        // Build pipeline layout from only the non-empty bind groups
        const bindGroupLayouts = bindGroupInfo.bindGroups.map(bg => bg.layout);
        const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts });

        const shaderModule = this.device.createShaderModule({ code: cr.code });

        // Build vertex buffer layouts from CompileResult.attributes + geometry.attributes.
        const vertexBuffers = buildVertexBufferLayouts(cr, geometry);

        // Build color target state from material render state.
        const targetCount = getTargetCount(material.fragmentNode);
        const colorTargets: GPUColorTargetState[] = [];
        for (let i = 0; i < targetCount; i++) {
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

        const entry: PipelineEntry = {
            pipeline,
            compileResult: cr,
            bindGroupInfo,
        };
        this.ready.set(key, entry);
        this.pending.delete(key);
        return entry;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build GPUVertexBufferLayout[] from CompileResult.attributes + Geometry.attributes.
 *
 * - kind: 'geometry' — look up format/stride/offset from geometry.attributes
 * - kind: 'buffer' — derive format from WGSL type, use node.stride/node.offset, stepMode from node.instanced
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
            if (!bufAttr.format) {
                throw new Error(
                    `[PipelineCache] attribute '${attrEntry.name}' has no format — cannot derive from array type + itemSize`
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
            // kind: 'buffer' — per-vertex or per-instance from BufferAttributeNode
            const node = attrEntry.node;
            const format = wgslTypeToVertexFormat(attrEntry.type);
            const itemSize = wgslTypeItemSize(attrEntry.type);
            layouts.push({
                arrayStride: node.stride > 0 ? node.stride : itemSize * 4, // 4 bytes per component for f32/i32/u32
                stepMode: node.instanced ? 'instance' : 'vertex',
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

/** Number of components for a WGSL type. */
function wgslTypeItemSize(type: string): number {
    switch (type) {
        case 'f32':   case 'i32':   case 'u32':   return 1;
        case 'vec2f': case 'vec2i': case 'vec2u': return 2;
        case 'vec3f': case 'vec3i': case 'vec3u': return 3;
        case 'vec4f': case 'vec4i': case 'vec4u': return 4;
        default: return 4;
    }
}

/**
 * Stable cache key for a material + MSAA sample count.
 *
 * We hash the node graph IDs (which are already content-addressed) plus all
 * render-state fields that affect the GPURenderPipeline descriptor.
 */
export function makePipelineKey(material: Material, samples: number, format: GPUTextureFormat): string {
    // Node graph IDs are content-addressed — they ARE the hash of the graph.
    // We just need to extract their string IDs.
    const posId  = material.vertexNode  ? nodeGraphId(material.vertexNode)  : '__default__';
    const colId  = nodeGraphId(material.fragmentNode);
    const maskId = material.maskNode  ? nodeGraphId(material.maskNode)  : '__none__';
    const depId  = material.depthNode ? nodeGraphId(material.depthNode) : '__none__';

    const rs = [
        material.transparent ? 1 : 0,
        material.depthWrite ? 1 : 0,
        material.depthTest ? 1 : 0,
        material.depthCompare,
        material.cullMode,
        material.alphaToCoverage ? 1 : 0,
        getTargetCount(material.fragmentNode),
        samples,
        format,
        material.blend ? JSON.stringify(material.blend) : 'none',
    ].join('|');

    return `${posId}::${colId}::${maskId}::${depId}::${rs}`;
}

/** Extract the stable content-addressed ID from a Node object. */
function nodeGraphId(node: Node<WgslType>): string {
    return node.id;
}
