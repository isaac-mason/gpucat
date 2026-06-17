import type { NodeFrame } from '../renderer/node-frame';
import { type Node, type ComputeNode } from './lib/core';
import { type InterpolationType, type InterpolationSampling } from './lib/varying';
import { AttributeNode } from './lib/attribute';
import { GpuBuffer } from '../core/gpu-buffer';
import { TextureBindingNode, StorageTextureBindingNode, SamplerNode } from './lib/texture';
import { StorageNode } from './lib/storage';
import { UniformNode, UniformGroup } from './lib/uniform';
import * as d from '../schema/schema';
export declare function compile(slots: CompileSlots): CompileResult;
export declare function compileCompute(node: ComputeNode): ComputeCompileResult;
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
