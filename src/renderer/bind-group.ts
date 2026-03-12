import type { GpuBuffer } from '../core/gpu-buffer';
import type { UniformGroupBlock, StorageEntry, TextureEntry, SamplerEntry } from '../nodes/builder';

let bindGroupIdCounter = 0;

/**
 * A single binding within a BindGroup.
 * Can be a uniform buffer, storage buffer, texture, or sampler.
 */
export type Binding =
    | UniformBinding
    | StorageBinding
    | TextureBinding
    | SamplerBinding;

/** Uniform buffer binding (UBO) */
export type UniformBinding = {
    readonly kind: 'uniform';
    /** The uniform group block from compilation. */
    block: UniformGroupBlock;
    /** Buffer key for the GPU buffer cache (created lazily). */
    bufferKey: object | null;
    /**
     * Last processed frame ID for deduplication of 'frame' update type groups.
     * Compared against nodeFrame.frameId to skip redundant processing.
     */
    lastFrameId: number;
    /**
     * Last processed render ID for deduplication of 'render' update type groups.
     * Compared against nodeFrame.renderId to skip redundant processing.
     */
    lastRenderId: number;
    /**
     * Double-buffered uniform packing: current holds last uploaded values,
     * scratch is used for packing new values before comparison.
     * Uses ArrayBuffer to support typed views (Float32Array, Int32Array, etc).
     */
    currentBuffer: ArrayBuffer | null;
    scratchBuffer: ArrayBuffer | null;
};

/** Storage buffer binding (SSBO) */
export type StorageBinding = {
    readonly kind: 'storage';
    /** The storage entry from compilation. */
    entry: StorageEntry;
    /** Last seen GpuBuffer (for detecting buffer swaps). */
    lastBuffer: GpuBuffer | null;
};

/** Texture binding */
export type TextureBinding = {
    readonly kind: 'texture';
    /** The texture entry from compilation. */
    entry: TextureEntry;
    /** Generation counter for detecting texture changes. */
    generation: number;
    /** Last seen GPU texture (for detecting render target texture changes). */
    lastGpuTexture: GPUTexture | null;
};

/** Sampler binding */
export type SamplerBinding = {
    readonly kind: 'sampler';
    /** The sampler entry from compilation. */
    entry: SamplerEntry;
    /** Sampler key for detecting sampler changes. */
    samplerKey: string | null;
};

/**
 * BindGroup - A collection of bindings for a single @group(N).
 *
 * This is the cache key for GPU bind group creation.
 * - Shared groups are reused across all RenderObjects (one instance)
 * - Non-shared groups are cloned per RenderObject (separate instances)
 */
export type BindGroup = {
    /** Unique identifier for debugging. */
    readonly id: number;

    /** Group name (e.g., 'render', 'object'). */
    readonly name: string;

    /** The @group(N) index in WGSL. */
    readonly groupIndex: number;

    /** Whether this group is shared across all RenderObjects. */
    readonly shared: boolean;

    /** Bindings in this group. */
    bindings: Binding[];

    /** Type flag. */
    readonly isBindGroup: true;
};

/** Create a BindGroup from uniform group block */
export function createUniformBindGroup(block: UniformGroupBlock): BindGroup {
    const binding: UniformBinding = {
        kind: 'uniform',
        block,
        bufferKey: null,
        lastFrameId: -1,
        lastRenderId: -1,
        currentBuffer: null,
        scratchBuffer: null,
    };

    return {
        id: bindGroupIdCounter++,
        name: block.groupName,
        groupIndex: block.groupIndex,
        shared: block.shared,
        bindings: [binding],
        isBindGroup: true,
    };
}

/** Create a BindGroup for storage/texture/sampler bindings in a group */
export function createResourceBindGroup(
    name: string,
    groupIndex: number,
    shared: boolean,
    storage: StorageEntry[],
    textures: TextureEntry[],
    samplers: SamplerEntry[],
): BindGroup {
    const bindings: Binding[] = [];

    for (const entry of storage) {
        bindings.push({ kind: 'storage', entry, lastBuffer: null });
    }

    for (const entry of textures) {
        bindings.push({ kind: 'texture', entry, generation: 0, lastGpuTexture: null });
    }

    for (const entry of samplers) {
        bindings.push({ kind: 'sampler', entry, samplerKey: null });
    }

    return {
        id: bindGroupIdCounter++,
        name,
        groupIndex,
        shared,
        bindings,
        isBindGroup: true,
    };
}

/**
 * Clone a BindGroup (deep clone of bindings).
 * Used for non-shared groups that need per-RenderObject instances.
 */
export function cloneBindGroup(source: BindGroup): BindGroup {
    const clonedBindings: Binding[] = source.bindings.map((binding) => {
        switch (binding.kind) {
            case 'uniform':
                return {
                    kind: 'uniform' as const,
                    block: binding.block,
                    bufferKey: null, // New buffer key for cloned group
                    lastFrameId: -1,
                    lastRenderId: -1,
                    currentBuffer: null,
                    scratchBuffer: null,
                };
            case 'storage':
                return {
                    kind: 'storage' as const,
                    entry: binding.entry,
                    lastBuffer: null,
                };
            case 'texture':
                return {
                    kind: 'texture' as const,
                    entry: binding.entry,
                    generation: 0,
                    lastGpuTexture: null,
                };
            case 'sampler':
                return {
                    kind: 'sampler' as const,
                    entry: binding.entry,
                    samplerKey: null,
                };
        }
    });

    return {
        id: bindGroupIdCounter++,
        name: source.name,
        groupIndex: source.groupIndex,
        shared: source.shared,
        bindings: clonedBindings,
        isBindGroup: true,
    };
}


