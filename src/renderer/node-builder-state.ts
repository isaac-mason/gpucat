/**
 * node-builder-state.ts - Formalized compile result state.
 *
 * Aligned with Three.js NodeBuilderState concept:
 * - Holds all compiled shader code and metadata
 * - Shared across RenderObjects with same material/shader config
 * - Caches binding metadata, attributes, update nodes
 * - Template BindGroups that are cloned per-RenderObject via createBindings()
 *
 * Key Three.js pattern:
 * - NodeBuilderState.bindings holds template BindGroups
 * - createBindings() clones non-shared groups (per-object), reuses shared groups
 * - This allows shared uniform buffers (camera, time) across all RenderObjects
 */

import type {
    CompileResult,
    AttributeEntry,
    UniformGroupBlock,
    StorageEntry,
    TextureEntry,
    SamplerEntry,
    UpdateBeforeNode,
    UpdateAfterNode,
    UpdateNode,
} from '../nodes/node-builder';
import {
    type BindGroup,
    createUniformBindGroup,
    createResourceBindGroup,
    cloneBindGroup,
} from './bind-group';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * NodeBuilderState - Compiled shader state for a RenderObject.
 *
 * Contains everything needed to:
 * - Create render pipelines (shader code, attributes)
 * - Create bind groups (uniform groups, storage, textures, samplers)
 * - Run per-frame updates (update nodes)
 *
 * Three.js pattern:
 * - `bindings` array holds template BindGroups
 * - Shared groups (camera, time) are reused across all RenderObjects
 * - Non-shared groups (object uniforms) are cloned per-RenderObject
 */
export type NodeBuilderState = {
    // -------------------------------------------------------------------------
    // Shader Code
    // -------------------------------------------------------------------------

    /** Combined WGSL shader code (vertex + fragment). */
    code: string;

    // -------------------------------------------------------------------------
    // Attribute Metadata
    // -------------------------------------------------------------------------

    /** Vertex attribute entries for pipeline layout. */
    attributes: AttributeEntry[];

    // -------------------------------------------------------------------------
    // Binding Metadata (raw compile output - kept for compatibility)
    // -------------------------------------------------------------------------

    /** Uniform groups (render group @0, object group @1). */
    uniformGroups: UniformGroupBlock[];

    /** Storage buffer bindings. */
    storage: StorageEntry[];

    /** Texture bindings. */
    textures: TextureEntry[];

    /** Sampler bindings. */
    samplers: SamplerEntry[];

    // -------------------------------------------------------------------------
    // Template BindGroups (Three.js aligned)
    // -------------------------------------------------------------------------

    /**
     * Template BindGroups for this shader.
     * These are cloned per-RenderObject via createBindings() for non-shared groups.
     * Shared groups (render/camera) are reused directly.
     */
    bindings: BindGroup[];

    // -------------------------------------------------------------------------
    // Update Nodes
    // -------------------------------------------------------------------------

    /** Nodes to update before rendering (e.g., compute passes). */
    updateBeforeNodes: UpdateBeforeNode[];

    /** Nodes to update after rendering (e.g., readback). */
    updateAfterNodes: UpdateAfterNode[];

    /** Nodes to update during rendering (per-frame uniforms). */
    updateNodes: UpdateNode[];

    // -------------------------------------------------------------------------
    // Cache Key
    // -------------------------------------------------------------------------

    /**
     * Cache key for pipeline lookup.
     * Derived from material + geometry configuration.
     */
    cacheKey: string;

    // -------------------------------------------------------------------------
    // Type Flag
    // -------------------------------------------------------------------------

    readonly isNodeBuilderState: true;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a NodeBuilderState from a CompileResult.
 *
 * This builds the template BindGroups from the compile result.
 * Template groups are later cloned (non-shared) or reused (shared) via createBindings().
 *
 * @param compileResult - The compiler output
 * @param cacheKey - Pipeline cache key
 */
export function createNodeBuilderState(
    compileResult: CompileResult,
    cacheKey: string,
): NodeBuilderState {
    // Build template BindGroups from compile result
    const bindings = buildTemplateBindGroups(
        compileResult.uniformGroups,
        compileResult.storage,
        compileResult.textures,
        compileResult.samplers,
    );

    return {
        code: compileResult.code,
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
 */
function buildTemplateBindGroups(
    uniformGroups: UniformGroupBlock[],
    storage: StorageEntry[],
    textures: TextureEntry[],
    samplers: SamplerEntry[],
): BindGroup[] {
    // Collect all group indices
    const groupIndices = new Set<number>();
    for (const ug of uniformGroups) {
        if (ug.members.length > 0) groupIndices.add(ug.groupIndex);
    }
    for (const s of storage) groupIndices.add(s.group);
    for (const t of textures) groupIndices.add(t.group);
    for (const s of samplers) groupIndices.add(s.group);

    // Build BindGroup for each index
    const bindGroups: BindGroup[] = [];
    const sortedIndices = [...groupIndices].sort((a, b) => a - b);

    for (const groupIdx of sortedIndices) {
        // Find uniform group for this index
        const uniformGroup = uniformGroups.find((g) => g.groupIndex === groupIdx && g.members.length > 0);

        // Collect resources for this group
        const groupStorage = storage.filter((s) => s.group === groupIdx);
        const groupTextures = textures.filter((t) => t.group === groupIdx);
        const groupSamplers = samplers.filter((s) => s.group === groupIdx);

        // Determine shared flag (from uniform group if present, otherwise false)
        const shared = uniformGroup?.shared ?? false;

        if (uniformGroup && groupStorage.length === 0 && groupTextures.length === 0 && groupSamplers.length === 0) {
            // Uniform-only group
            bindGroups.push(createUniformBindGroup(uniformGroup));
        } else if (uniformGroup) {
            // Mixed group: uniform + other resources
            // Create a combined bind group
            const bindGroup = createUniformBindGroup(uniformGroup);
            // Add storage/texture/sampler bindings
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
            // Resource-only group (no uniform)
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
 * Three.js pattern (NodeBuilderState.createBindings):
 * - Shared groups are reused directly (same BindGroup instance)
 * - Non-shared groups are cloned (new BindGroup instance per RenderObject)
 *
 * This is the key to efficient uniform buffer sharing - camera/time buffers
 * are shared across all RenderObjects, while object uniforms get their own.
 *
 * @param state - The NodeBuilderState (template)
 * @returns Array of BindGroups for this RenderObject
 */
export function createBindings(state: NodeBuilderState): BindGroup[] {
    const bindings: BindGroup[] = [];

    for (const templateGroup of state.bindings) {
        if (templateGroup.shared) {
            // Shared: reuse the same BindGroup instance
            bindings.push(templateGroup);
        } else {
            // Non-shared: clone the BindGroup
            bindings.push(cloneBindGroup(templateGroup));
        }
    }

    return bindings;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if the NodeBuilderState needs to be recompiled.
 *
 * This compares the current cache key against a new one computed from
 * the material and geometry configuration.
 *
 * @param state - The current NodeBuilderState
 * @param newCacheKey - The newly computed cache key
 * @returns true if recompilation is needed
 */
export function needsRecompile(state: NodeBuilderState, newCacheKey: string): boolean {
    return state.cacheKey !== newCacheKey;
}

/**
 * Get the uniform group by name.
 *
 * @param state - The NodeBuilderState
 * @param groupName - 'render' or 'object'
 * @returns The uniform group block or undefined
 */
export function getUniformGroup(
    state: NodeBuilderState,
    groupName: 'render' | 'object',
): UniformGroupBlock | undefined {
    return state.uniformGroups.find((g) => g.groupName === groupName);
}

/**
 * Check if the state has any update nodes.
 */
export function hasUpdateNodes(state: NodeBuilderState): boolean {
    return (
        state.updateNodes.length > 0 ||
        state.updateBeforeNodes.length > 0 ||
        state.updateAfterNodes.length > 0
    );
}

/**
 * Check if the state has any storage bindings.
 */
export function hasStorageBindings(state: NodeBuilderState): boolean {
    return state.storage.length > 0;
}

/**
 * Check if the state has any texture bindings.
 */
export function hasTextureBindings(state: NodeBuilderState): boolean {
    return state.textures.length > 0;
}
