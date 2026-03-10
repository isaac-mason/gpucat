import type {
    CompileResult,
    ComputeCompileResult,
    AttributeEntry,
    UniformGroupBlock,
    StorageEntry,
    TextureEntry,
    SamplerEntry,
    UpdateBeforeNode,
    UpdateAfterNode,
    UpdateNode,
} from '../nodes/builder';
import {
    type BindGroup,
    createUniformBindGroup,
    createResourceBindGroup,
    cloneBindGroup,
} from './bind-group';
import type { RenderContext, ComputeContext } from './pass-context';

/**
 * Context type for bind group caching.
 * RenderContext for render passes, ComputeContext for compute passes.
 */
export type BindingContext = RenderContext | ComputeContext;

/**
 * Global cache for shared BindGroups (Three.js pattern: _bindingGroupsCache).
 *
 * Structure: WeakMap<BindingContext, Map<cacheKey, BindGroup>>
 *
 * - Outer WeakMap is keyed by context (RenderContext or ComputeContext), allowing GC when context is disposed
 * - Inner Map is keyed by a hash of uniform node IDs in the shared group
 * - All compilations using the same shared uniforms get the same BindGroup instance
 *
 * This ensures currentSets comparison works correctly - shared groups have the same `id`.
 */
const _bindingGroupsCache = new WeakMap<BindingContext, Map<string, BindGroup>>();

/**
 * Simple string hash function (matches Three.js hashString pattern).
 */
function hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0; // Convert to 32bit integer
    }
    return hash.toString(36);
}

/**
 * NodeBuilderState - Compiled shader state for both render and compute.
 *
 * Follows three.js pattern: single monomorphic type with all fields present.
 * For render: vertexCode/fragmentCode populated, computeCode null
 * For compute: computeCode populated, vertexCode/fragmentCode null
 *
 * Contains everything needed to:
 * - Create pipelines (shader code, attributes)
 * - Create bind groups (uniform groups, storage, textures, samplers)
 * - Run per-frame updates (update nodes)
 */
export type NodeBuilderState = {
    // === Render shaders (null for compute) ===
    /** Vertex shader code. Null for compute. */
    vertexCode: string | null;
    /** Fragment shader code. Null for compute. */
    fragmentCode: string | null;

    // === Compute shader (null for render) ===
    /** Compute shader code. Null for render. */
    computeCode: string | null;
    /** Workgroup size [x, y, z]. Null for render. */
    workgroupSize: [number, number, number] | null;

    // === Shared (populated for both) ===
    /** Vertex attribute entries for pipeline layout. Empty for compute. */
    attributes: AttributeEntry[];

    /** Uniform groups. */
    uniformGroups: UniformGroupBlock[];

    /** Storage buffer bindings. */
    storage: StorageEntry[];

    /** Texture bindings. Empty for compute (for now). */
    textures: TextureEntry[];

    /** Sampler bindings. Empty for compute (for now). */
    samplers: SamplerEntry[];

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
export function createNodeBuilderState(
    compileResult: CompileResult,
    cacheKey: string,
    context: BindingContext,
): NodeBuilderState {
    // build template BindGroups from compile result
    const bindings = buildTemplateBindGroups(
        compileResult.uniformGroups,
        compileResult.storage,
        compileResult.textures,
        compileResult.samplers,
        context,
    );

    return {
        // Render shaders: combined vertex+fragment in single module
        vertexCode: compileResult.code,
        fragmentCode: null, // Same module, different entry point
        // No compute
        computeCode: null,
        workgroupSize: null,
        // Bindings
        attributes: compileResult.attributes,
        uniformGroups: compileResult.uniformGroups,
        storage: compileResult.storage,
        textures: compileResult.textures,
        samplers: compileResult.samplers,
        bindings,
        updateBeforeNodes: compileResult.updateBeforeNodes,
        updateAfterNodes: compileResult.updateAfterNodes,
        updateNodes: compileResult.updateNodes,
        cacheKey,
        isNodeBuilderState: true,
    };
}

/**
 * Create a NodeBuilderState from a compute CompileResult.
 *
 * @param compileResult - The compute compiler output
 * @param context - The binding context (ComputeContext) for shared bind group caching
 */
export function createNodeBuilderStateForCompute(
    compileResult: ComputeCompileResult,
    context: BindingContext,
): NodeBuilderState {
    // build template BindGroups from compile result
    const bindings = buildTemplateBindGroups(
        compileResult.uniformGroups,
        compileResult.storage,
        [], // no textures for compute (for now)
        [], // no samplers for compute (for now)
        context,
    );

    return {
        // No render shaders
        vertexCode: null,
        fragmentCode: null,
        // Compute shader
        computeCode: compileResult.code,
        workgroupSize: compileResult.workgroupSize,
        // Bindings
        attributes: [], // no vertex attributes for compute
        uniformGroups: compileResult.uniformGroups,
        storage: compileResult.storage,
        textures: [], // no textures for compute (for now)
        samplers: [], // no samplers for compute (for now)
        bindings,
        updateBeforeNodes: [], // compute doesn't have these yet
        updateAfterNodes: [],
        updateNodes: [],
        cacheKey: '', // no cache key for compute pipelines
        isNodeBuilderState: true,
    };
}

/**
 * Build template BindGroups from compile result.
 *
 * Creates one BindGroup per @group(N) index. Each group contains:
 * - Uniform buffer (if present)
 * - Storage buffers (if present)
 * - Textures (if present)
 * - Samplers (if present)
 *
 * The `shared` flag is taken from the uniform group (if present),
 * otherwise defaults to false (per-object).
 *
 * For shared uniform-only groups, uses _bindingGroupsCache to return the same
 * BindGroup instance across all compilations (Three.js pattern).
 */
function buildTemplateBindGroups(
    uniformGroups: UniformGroupBlock[],
    storage: StorageEntry[],
    textures: TextureEntry[],
    samplers: SamplerEntry[],
    context: BindingContext,
): BindGroup[] {
    // Get or create the cache for this context
    let contextCache = _bindingGroupsCache.get(context);
    if (contextCache === undefined) {
        contextCache = new Map();
        _bindingGroupsCache.set(context, contextCache);
    }

    // collect all group indices
    const groupIndices = new Set<number>();
    for (const ug of uniformGroups) {
        if (ug.members.length > 0) groupIndices.add(ug.groupIndex);
    }
    for (const s of storage) groupIndices.add(s.group);
    for (const t of textures) groupIndices.add(t.group);
    for (const s of samplers) groupIndices.add(s.group);

    // build BindGroup for each index
    const bindGroups: BindGroup[] = [];
    const sortedIndices = [...groupIndices].sort((a, b) => a - b);

    for (const groupIdx of sortedIndices) {
        // find uniform group for this index
        const uniformGroup = uniformGroups.find((g) => g.groupIndex === groupIdx && g.members.length > 0);

        // collect resources for this group
        const groupStorage = storage.filter((s) => s.group === groupIdx);
        const groupTextures = textures.filter((t) => t.group === groupIdx);
        const groupSamplers = samplers.filter((s) => s.group === groupIdx);

        // determine shared flag (from uniform group if present, otherwise false)
        const shared = uniformGroup?.shared ?? false;

        if (uniformGroup && groupStorage.length === 0 && groupTextures.length === 0 && groupSamplers.length === 0) {
            // uniform-only group
            if (shared) {
                // Shared group: use cache (Three.js pattern)
                // Build cache key from sorted uniform node IDs
                const members = [...uniformGroup.members].sort((a, b) => a.node.id.localeCompare(b.node.id));
                const cacheKeyString = members.map(m => m.node.id).join(',');
                const cacheKey = hashString(cacheKeyString);

                let bindGroup = contextCache.get(cacheKey);
                if (bindGroup === undefined) {
                    bindGroup = createUniformBindGroup(uniformGroup);
                    contextCache.set(cacheKey, bindGroup);
                }
                bindGroups.push(bindGroup);
            } else {
                // Non-shared: always create new
                bindGroups.push(createUniformBindGroup(uniformGroup));
            }
        } else if (uniformGroup) {
            // mixed group: uniform + other resources
            // create a combined bind group (not cached - has textures/storage which vary)
            const bindGroup = createUniformBindGroup(uniformGroup);
            // add storage/texture/sampler bindings
            for (const s of groupStorage) {
                bindGroup.bindings.push({ kind: 'storage', entry: s });
            }
            for (const t of groupTextures) {
                bindGroup.bindings.push({ kind: 'texture', entry: t, generation: 0, lastGpuTexture: null });
            }
            for (const s of groupSamplers) {
                bindGroup.bindings.push({ kind: 'sampler', entry: s, samplerKey: null });
            }
            bindGroups.push(bindGroup);
        } else {
            // resource-only group (no uniform)
            bindGroups.push(createResourceBindGroup(
                `group${groupIdx}`,
                groupIdx,
                shared,
                groupStorage,
                groupTextures,
                groupSamplers,
            ));
        }
    }

    return bindGroups;
}

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
export function createBindings(state: NodeBuilderState): BindGroup[] {
    const bindings: BindGroup[] = [];

    for (const templateGroup of state.bindings) {
        if (templateGroup.shared) {
            // shared: reuse the same BindGroup instance
            bindings.push(templateGroup);
        } else {
            // non-shared: clone the BindGroup
            bindings.push(cloneBindGroup(templateGroup));
        }
    }

    return bindings;
}
