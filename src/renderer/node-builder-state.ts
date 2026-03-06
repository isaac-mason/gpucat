/**
 * node-builder-state.ts - Formalized compile result state.
 *
 * Aligned with Three.js NodeBuilderState concept:
 * - Holds all compiled shader code and metadata
 * - Owned by RenderObject
 * - Caches binding metadata, attributes, update nodes
 *
 * This is essentially a subset/alias of CompileResult that's owned per-RenderObject.
 * The actual CompileResult is created by the compiler; NodeBuilderState extracts
 * what's needed for rendering.
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
} from '../nodes/compile';
import type { Node, WgslType } from '../nodes/nodes';

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
    // Binding Metadata
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
    // Update Nodes
    // -------------------------------------------------------------------------

    /** Nodes to update before rendering (e.g., compute passes). */
    updateBeforeNodes: UpdateBeforeNode[];

    /** Nodes to update after rendering (e.g., readback). */
    updateAfterNodes: UpdateAfterNode[];

    /** Nodes to update during rendering (per-frame uniforms). */
    updateNodes: UpdateNode[];

    /** Nodes that support inspector inspection. */
    inspectableNodes: Node<WgslType>[];

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
 * @param compileResult - The compiler output
 * @param cacheKey - Pipeline cache key
 */
export function createNodeBuilderState(
    compileResult: CompileResult,
    cacheKey: string,
): NodeBuilderState {
    return {
        code: compileResult.code,
        attributes: compileResult.attributes,
        uniformGroups: compileResult.uniformGroups,
        storage: compileResult.storage,
        textures: compileResult.textures,
        samplers: compileResult.samplers,
        updateBeforeNodes: compileResult.updateBeforeNodes,
        updateAfterNodes: compileResult.updateAfterNodes,
        updateNodes: compileResult.updateNodes,
        inspectableNodes: compileResult.inspectableNodes,
        cacheKey,
        isNodeBuilderState: true,
    };
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
