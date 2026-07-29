/**
 * backend/wgsl/emit.ts — the WGSL emitter.
 *
 * Consumes the backend-neutral node graph + discovered facts (carried on BuildContext) and produces
 * WGSL source strings. This is the first concrete shader backend; a future GLSL emitter is a sibling
 * module here. Nothing in this file touches GPUDevice or any runtime object — it is purely
 * node-graph → text. compile()/compileCompute() (in ../../builder) orchestrate discover → emit.
 */
import type { StructSchema } from '../../../schema/schema';
import * as d from '../../../schema/schema';
import type { AttributeEntry, CompileSlots, Discovery, NodeGraphInfo, SamplerEntry, StorageEntry, StorageTextureEntry, TextureEntry, UniformGroupBlock } from '../../builder';
import { type ComputeNode, type FnNode, type Node, type ParameterNode, type PrivateVarNode, type StackNode, type StructDef, type StructNode, type WorkgroupVarNode } from '../../lib/core';
import type { StorageNode } from '../../lib/storage';
import { SamplerNode, type StorageTextureBindingNode, type TextureBindingNode } from '../../lib/texture';
import type { UniformGroup, UniformNode } from '../../lib/uniform';
import type { VaryingNode } from '../../lib/varying';
import type { WgslFunctionNode } from '../../lib/wgsl-fn';
type ShaderStage = 'vertex' | 'fragment' | 'compute';
/** Traced FnNode data */
export type TracedFn = {
    params: ParameterNode<d.Any>[];
    body: StackNode;
    output: Node<d.Any>;
};
/** Build context - carries all state during code generation */
export type BuildContext = {
    stage: ShaderStage;
    isRender: boolean;
    uniforms: Map<string, {
        node: UniformNode<d.Any>;
        group: UniformGroup;
    }>;
    storages: Map<string, StorageNode<d.Any>>;
    storageNames: Map<number, string>;
    textures: Map<string, TextureBindingNode>;
    storageTextures: Map<string, StorageTextureBindingNode>;
    samplers: Map<string, SamplerNode>;
    attributes: Map<number, AttributeEntry>;
    attrCounter: number;
    varyings: Map<string, {
        node: VaryingNode<d.Any>;
        vertexExpr: string;
    }>;
    builtins: Set<string>;
    privateVars: Map<number, PrivateVarNode<d.Any>>;
    workgroupVars: Map<number, WorkgroupVarNode<d.Any>>;
    structs: Map<string, StructNode>;
    structDefs: Map<string, StructDef<StructSchema>>;
    usageCount: Map<number, number>;
    mutatedNodes: Set<number>;
    nodeVars: Map<number, string>;
    varCounter: number;
    indentLevel: number;
    code: string[];
    fnDefs: Map<string, {
        fn: FnNode<d.Any>;
        traced: TracedFn;
    }>;
    wgslFnDefs: Map<string, WgslFunctionNode>;
    graphNodes: Map<number, Node<d.Any>>;
    graphEdges: Map<number, number[]>;
    graphInfo: Map<number, NodeGraphInfo>;
};
/**
 * Context for a top-level shader stage. Emission scratch is fresh, but the discovered facts (bindings,
 * struct/fn tables, CSE usage counts) are referenced — not copied — directly from the single discovery
 * pass, so every context for one compile (vertex + fragment) shares one binding set. This matches the
 * prior behaviour where compile() aliased the discovered maps into both contexts. Emission still appends
 * to some of them (e.g. uniforms/textures registered on first encounter), so they are shared-mutable.
 */
export declare function createContext(stage: ShaderStage, isRender: boolean, discovery: Discovery): BuildContext;
/** Pre-collect VaryingNodes from roots and generate their vertex expressions. */
export declare function collectVaryings(roots: Node<d.Any>[], ctx: BuildContext): void;
/**
 * Emit module-scope variable declarations (var<private> and var<workgroup>).
 * These are emitted before bindings in the shader.
 */
export declare function emitModuleScopeVars(ctx: BuildContext): string;
/**
 * Emit all bindings (uniforms, storage, textures, samplers).
 *
 * - Each named group (render, object, etc.) gets its own @group(N) index
 * - Groups are sorted by UniformGroup.order
 * - The @group(N) index is the SORTED ARRAY POSITION, not the order value directly
 * - Within each group, bindings get sequential @binding(M) indices starting from 0
 */
export declare function emitAllBindings(ctx: BuildContext): {
    wgsl: string;
    uniformBlocks: UniformGroupBlock[];
    storageEntries: StorageEntry[];
    textureEntries: TextureEntry[];
    storageTextureEntries: StorageTextureEntry[];
    samplerEntries: SamplerEntry[];
};
export declare function emitWgslFunctions(ctx: BuildContext): string;
export declare function emitDslFunctions(ctx: BuildContext): string;
export declare function generateVertexShader(slots: CompileSlots, ctx: BuildContext): string;
export declare function generateFragmentShader(fragmentNode: Node<d.Any>, ctx: BuildContext, varyings: Map<string, {
    node: VaryingNode<d.Any>;
    vertexExpr: string;
}>): string;
export declare function generateComputeShader(node: ComputeNode, traced: ReturnType<FnNode<d.Any>['trace']>, ctx: BuildContext): string;
export {};
