import type { GpuBuffer } from '../core/gpu-buffer';
import type { NodeFrame } from '../renderer/core/node-frame';
import type { StructSchema } from '../schema/schema';
import * as d from '../schema/schema';
import { type TracedFn } from './backend/wgsl/emit';
import type { AttributeNode } from './lib/attribute';
import { type ComputeNode, type FnNode, type Node, type PrivateVarNode, type StructDef, type WorkgroupVarNode } from './lib/core';
import type { TransformFeedbackNode } from './lib/transform-feedback';
import type { StorageNode } from './lib/storage';
import { SamplerNode, type StorageTextureBindingNode, TextureBindingNode } from './lib/texture';
import type { UniformGroup, UniformNode } from './lib/uniform';
import type { InterpolationSampling, InterpolationType } from './lib/varying';
import type { WgslFunctionNode } from './lib/wgsl-fn';
export declare function compile(slots: CompileSlots): CompileResult;
/**
 * GLSL ES 3.00 sibling of {@link compile}. Reuses the shared, backend-neutral {@link discover} pass
 * and node graph, then drives the GLSL emitter instead of the WGSL one. First vertical slice: a "lit
 * mesh" material (attributes, camera/model uniform matrices as std140 UBOs, a varying, vec math,
 * clip position + fragment color). Textures, control flow, user functions, and compute/storage are
 * not yet supported and throw a clear "[glsl] … not yet supported" error via the emitter.
 *
 * The WGSL {@link compile} path is untouched: this only shares discover() and the node graph.
 */
/**
 * Options for the GLSL emitter. WGSL has no precision qualifier, so these are GLSL-only (grammar-
 * native): a WebGL-backend concern that never touches the WGSL path.
 */
export type CompileGlslOptions = {
    /**
     * Fragment-stage default precision qualifier (`precision <p> float;` / `precision <p> int;`).
     * Default: 'highp' — keeping the emitted GLSL byte-identical to the golden snapshots.
     */
    precision?: 'highp' | 'mediump' | 'lowp';
};
export declare function compileGlsl(slots: CompileSlots, opts?: CompileGlslOptions): CompileResult;
export declare function compileCompute(node: ComputeNode): ComputeCompileResult;
/**
 * GLSL compile path for a transform-feedback kernel (Phase 1 of the WebGL transform-feedback plan).
 * Sibling to {@link compileCompute}: reuses the shared, backend-neutral {@link discover} pass and the
 * GLSL emitter to produce a real, linkable transform-feedback VERTEX program (attribute-in / captured-
 * varying-out) plus a no-op fragment shader so the program links.
 *
 * There is intentionally NO WGSL sibling — transform feedback is a WebGL2 primitive. Portability is via
 * a shared body `Fn` wrapped in a WebGPU compute(), not by this node spanning backends.
 */
export declare function compileTransformFeedback(node: TransformFeedbackNode, opts?: CompileGlslOptions): TransformFeedbackGlslResult;
export type NodeUpdateType = 'none' | 'frame' | 'render' | 'object';
export type UpdateBeforeNode = {
    readonly id: number;
    readonly updateBeforeType: NodeUpdateType;
    updateBefore(frame: NodeFrame): boolean | void;
};
export type UpdateAfterNode = {
    readonly id: number;
    readonly updateAfterType: NodeUpdateType;
    updateAfter(frame: NodeFrame): boolean | void;
};
export type UpdateNode = {
    readonly id: number;
    readonly updateType: NodeUpdateType;
    update(frame: NodeFrame): boolean | void;
};
export type AttributeEntry = {
    kind: 'geometry' | 'buffer';
    /** For geometry: the geometry buffer name. For buffer: null (direct reference). */
    name: string | null;
    /** WGSL struct member name (e.g. '_position_0', '_buf_1'). */
    shaderName: string;
    type: string;
    location: number;
    node: AttributeNode<d.Any>;
    stride: number;
    offset: number;
    instanced: boolean;
};
/**
 * VertexBufferGroup, groups attributes that share the same underlying buffer.
 *
 * For interleaved vertex data, multiple attributes may reference the same buffer
 * with different offsets. Grouping them enables:
 * - One GPUVertexBufferLayout with multiple attributes
 * - One setVertexBuffer() call per unique buffer
 *
 * This follows WebGPU's design where VertexBufferLayout.attributes is an array.
 */
export type VertexBufferGroup = {
    /** For geometry-based: the buffer name. For direct buffer: null. */
    name: string | null;
    /** For direct buffer: the GpuBuffer. For geometry-based: null (resolved at render time). */
    buffer: GpuBuffer<d.Any> | null;
    /** Shared stride (must match across grouped attributes). */
    stride: number;
    /** Whether these are per-instance attributes. */
    instanced: boolean;
    /** The attributes in this group (for building GPUVertexBufferLayout.attributes). */
    attributes: {
        type: string;
        offset: number;
        shaderLocation: number;
    }[];
};
export type VaryingEntry = {
    name: string;
    type: string;
    location: number;
    interpolationType: InterpolationType | null;
    interpolationSampling: InterpolationSampling | null;
};
export type UniformMember = {
    uniformId: string;
    schema: d.Any;
    offset: number;
    size: number;
    node: UniformNode<d.Any>;
};
export type UniformGroupBlock = {
    groupName: string;
    groupIndex: number;
    binding: number;
    shared: boolean;
    members: UniformMember[];
    totalBytes: number;
    group: UniformGroup;
};
export type StorageEntry = {
    node: StorageNode<d.Any>;
    name: string;
    type: string;
    access: 'read' | 'read_write';
    group: number;
    binding: number;
};
export type TextureEntry = {
    textureId: string;
    type: string;
    group: number;
    binding: number;
    node: TextureBindingNode;
};
export type StorageTextureEntry = {
    textureId: string;
    /** Composed WGSL binding type, e.g. `texture_storage_2d<rgba8unorm, write>`. */
    type: string;
    format: d.StorageTextureFormat;
    access: d.StorageTextureAccess;
    dim: '1d' | '2d' | '2d_array' | '3d';
    group: number;
    binding: number;
    node: StorageTextureBindingNode;
};
export type SamplerEntry = {
    samplerId: string;
    type: 'sampler' | 'sampler_comparison';
    group: number;
    binding: number;
    samplerNode: SamplerNode<d.sampler | d.samplerComparison>;
};
export type ComputeStorageEntry = {
    node: StorageNode<d.Any>;
    name: string;
    type: string;
    access: 'read' | 'read_write';
    group: number;
    binding: number;
};
export type NodeGraphInfo = {
    stages: ReadonlyArray<'vertex' | 'fragment' | 'compute'>;
    cseVar: string | undefined;
    usageCount: number;
    expression: string | undefined;
};
export type CompileSlots = {
    vertex: Node<d.Any>;
    fragment?: Node<d.Any>;
    depth?: Node<d.Any>;
};
export type CompileResult = {
    code: string;
    vertexEntryPoint: string;
    fragmentEntryPoint: string | null;
    attributes: AttributeEntry[];
    vertexBufferGroups: VertexBufferGroup[];
    varyings: VaryingEntry[];
    uniformGroups: UniformGroupBlock[];
    storage: StorageEntry[];
    textures: TextureEntry[];
    storageTextures: StorageTextureEntry[];
    samplers: SamplerEntry[];
    builtinsUsed: Set<string>;
    updateBeforeNodes: UpdateBeforeNode[];
    updateAfterNodes: UpdateAfterNode[];
    updateNodes: UpdateNode[];
    graphNodes: ReadonlyMap<number, Node<d.Any>>;
    graphEdges: ReadonlyMap<number, readonly number[]>;
    graphInfo: ReadonlyMap<number, NodeGraphInfo>;
};
export type ComputeCompileResult = {
    code: string;
    storage: ComputeStorageEntry[];
    storageTextures: StorageTextureEntry[];
    workgroupSize: [number, number, number];
    builtinsUsed: Set<string>;
    uniformGroups: UniformGroupBlock[];
};
/** One transform-feedback input attribute (bound from a GpuBuffer at the run site in Phase 2). */
export type TransformFeedbackInputAttribute = {
    /** Shader attribute name, `a_<name>`. */
    name: string;
    /** WGSL type name (e.g. 'vec4f'); the GLSL type is derivable via the schema's glslType companion. */
    type: string;
    location: number;
};
export type TransformFeedbackGlslResult = {
    /** The transform-feedback vertex shader (attribute-in / captured-varying-out, dummy gl_Position). */
    vertexCode: string;
    /** A no-op fragment shader so the program links (rasterization is discarded at run time). */
    fragmentCode: string;
    /** Ordered captured-varying names (`v_<name>`) for gl.transformFeedbackVaryings(..., SEPARATE_ATTRIBS). */
    feedbackVaryings: string[];
    /** Input attribute layout (name → type → location). */
    inputAttributes: TransformFeedbackInputAttribute[];
    uniformGroups: UniformGroupBlock[];
    textures: TextureEntry[];
    samplers: SamplerEntry[];
    builtinsUsed: Set<string>;
};
/** result of a single DFS pass that discovers all metadata needed before code generation */
export type Discovery = {
    nodeIdToUsages: Map<number, number>;
    mutatedNodes: Set<number>;
    fnDefs: Map<string, {
        fn: FnNode<d.Any>;
        traced: TracedFn;
    }>;
    wgslFnDefs: Map<string, WgslFunctionNode>;
    structDefs: Map<string, StructDef<StructSchema>>;
    storageNames: Map<number, string>;
    textures: Map<string, TextureBindingNode>;
    storageTextures: Map<string, StorageTextureBindingNode>;
    samplers: Map<string, SamplerNode>;
    uniforms: Map<string, {
        node: UniformNode<d.Any>;
        group: UniformGroup;
    }>;
    storages: Map<string, StorageNode<d.Any>>;
    privateVars: Map<number, PrivateVarNode<d.Any>>;
    workgroupVars: Map<number, WorkgroupVarNode<d.Any>>;
    nodeIdToNode: Map<number, Node<d.Any>>;
    updateBeforeNodes: UpdateBeforeNode[];
    updateAfterNodes: UpdateAfterNode[];
    updateNodes: UpdateNode[];
};
