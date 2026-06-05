import type { CompileResult, ComputeCompileResult, AttributeEntry, VaryingEntry, VertexBufferGroup, UniformGroupBlock, StorageEntry, TextureEntry, SamplerEntry, UpdateBeforeNode, UpdateAfterNode, UpdateNode } from '../nodes/builder';
import { type BindGroup } from './bind-group';
import type { RenderContext, ComputeContext } from './pass-context';
/**
 * Context type for bind group caching.
 * RenderContext for render passes, ComputeContext for compute passes.
 */
export type BindingContext = RenderContext | ComputeContext;
/**
 * NodeBuilderState - Compiled shader state for both render and compute.
 *
 * Single monomorphic type with all fields present.
 * For render: vertexCode/fragmentCode populated, computeCode null
 * For compute: computeCode populated, vertexCode/fragmentCode null
 *
 * Contains everything needed to:
 * - Create pipelines (shader code, attributes)
 * - Create bind groups (uniform groups, storage, textures, samplers)
 * - Run per-frame updates (update nodes)
 */
export type NodeBuilderState = {
    /** Vertex shader code. Null for compute. */
    vertexCode: string | null;
    /** Fragment shader code. Null for compute. */
    fragmentCode: string | null;
    /** Compute shader code. Null for render. */
    computeCode: string | null;
    /** Workgroup size [x, y, z]. Null for render. */
    workgroupSize: [number, number, number] | null;
    /** Vertex attribute entries for pipeline layout. Empty for compute. */
    attributes: AttributeEntry[];
    /** Vertex buffer groups - attributes grouped by underlying buffer. Empty for compute. */
    vertexBufferGroups: VertexBufferGroup[];
    /** Uniform groups. */
    uniformGroups: UniformGroupBlock[];
    /** Storage buffer bindings. */
    storage: StorageEntry[];
    /** Texture bindings. Empty for compute (for now). */
    textures: TextureEntry[];
    /** Sampler bindings. Empty for compute (for now). */
    samplers: SamplerEntry[];
    /** Varying entries (vertex → fragment). Empty for compute. */
    varyings: VaryingEntry[];
    /** Builtins used by the shader (e.g. 'vertex_index', 'instance_index'). */
    builtinsUsed: ReadonlySet<string>;
    /**
     * Template BindGroups for this shader.
     * For render: cloned per-RenderObject via createBindings() for non-shared groups.
     * For compute: used directly (no cloning needed).
     */
    bindings: BindGroup[];
    /** Nodes to update before rendering/dispatch. */
    updateBeforeNodes: UpdateBeforeNode[];
    /** Nodes to update after rendering/dispatch. */
    updateAfterNodes: UpdateAfterNode[];
    /** Nodes to update during rendering/dispatch. */
    updateNodes: UpdateNode[];
    /** Cache key for pipeline lookup. Empty for compute. */
    cacheKey: string;
    readonly isNodeBuilderState: true;
};
/**
 * Create a NodeBuilderState from a render CompileResult.
 *
 * This builds the template BindGroups from the compile result.
 * Template groups are later cloned (non-shared) or reused (shared) via createBindings().
 *
 * @param compileResult - The compiler output
 * @param cacheKey - Pipeline cache key
 * @param context - The binding context (RenderContext) for shared bind group caching
 */
export declare function createNodeBuilderState(compileResult: CompileResult, cacheKey: string, context: BindingContext): NodeBuilderState;
/**
 * Create a NodeBuilderState from a compute CompileResult.
 *
 * @param compileResult - The compute compiler output
 * @param context - The binding context (ComputeContext) for shared bind group caching
 */
export declare function createNodeBuilderStateForCompute(compileResult: ComputeCompileResult, context: BindingContext): NodeBuilderState;
/**
 * Create bindings for a RenderObject from a NodeBuilderState.
 *
 * Shared groups are reused directly (same BindGroup instance)
 * Non-shared groups are cloned (new BindGroup instance per RenderObject)
 *
 * This is the key to efficient uniform buffer sharing - camera/time buffers
 * are shared across all RenderObjects, while object uniforms get their own.
 *
 * @param state the NodeBuilderState (template)
 * @returns array of BindGroups for this RenderObject
 */
export declare function createBindings(state: NodeBuilderState): BindGroup[];
