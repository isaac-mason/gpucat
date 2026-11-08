import type { GpuBuffer } from '../../core/gpu-buffer';
import type { GpuTexture } from '../../core/gpu-texture';
import { UniformUpdateType } from '../../core/uniform';
import type { Material } from '../../material/material';
import type { SamplerEntry, StorageEntry, StorageTextureEntry, TextureEntry, UniformGroupBlock } from '../../nodes/builder';
import type { NodeFrame } from './node-frame';
import type { SharedBlock } from './shared-blocks';

let bindGroupIdCounter = 0;

/**
 * A single binding within a BindGroup.
 * Can be a uniform buffer, storage buffer, texture, or sampler.
 */
export type Binding = UniformBinding | StorageBinding | TextureBinding | StorageTextureBinding | SamplerBinding;

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
     * Frame of the last pass or dispatch that used this binding's own buffer. Different bytes after
     * such a use, in the same frame, cannot go into that buffer: every write lands before the frame's
     * submit, so the earlier pass would read them. They take a dynamic allocation instead.
     */
    lastUseFrameId: number;
    /**
     * Where the current use reads from: -1 for the binding's own buffer, otherwise which of the backend's
     * dynamic uniform buffers, with `sliceOffset` as the dynamic offset into it.
     */
    sliceBufferId: number;
    sliceOffset: number;
    /**
     * Double-buffered uniform packing: current holds last uploaded values,
     * scratch is used for packing new values before comparison.
     * Uses ArrayBuffer to support typed views (Float32Array, Int32Array, etc).
     */
    currentBuffer: ArrayBuffer | null;
    scratchBuffer: ArrayBuffer | null;
    /**
     * The versions of what `currentBuffer` was packed from (see {@link readBlockStamp}), when a per-object block's
     * members all have one; empty otherwise. While a draw's versions match, its bytes are the same, so it is not
     * packed again.
     */
    stamp: number[];
    /**
     * The renderer's shared block this binding reads, for a shared group whose uniforms live there: its bytes are the
     * block's, synced and uploaded by the block, and its buffer is keyed by the block. Null for any other.
     */
    sharedBlock: SharedBlock | null;
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
    /** Generation counter for detecting in-place uploads to the SAME texture. */
    generation: number;
    /** Last seen GpuTexture (for detecting texture swaps, e.g. an atlas reload
     *  that rebinds the node's `value` to a fresh, different GpuTexture). */
    lastTexture: GpuTexture | null;
    /** Last seen range of it, by key, for a binding rebound to another view of the same texture. */
    lastRangeKey: string | null;
};

/** Storage texture binding (compute write / read) */
export type StorageTextureBinding = {
    readonly kind: 'storageTexture';
    /** The storage texture entry from compilation. */
    entry: StorageTextureEntry;
    /** Generation counter for detecting in-place uploads to the SAME texture. */
    generation: number;
    /** Last seen GpuTexture (for detecting texture swaps on the bound node). */
    lastTexture: GpuTexture | null;
    /** Last seen range of it, by key, for a binding rebound to another view of the same texture. */
    lastRangeKey: string | null;
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
        lastUseFrameId: -1,
        sliceBufferId: -1,
        sliceOffset: 0,
        currentBuffer: null,
        scratchBuffer: null,
        stamp: [],
        sharedBlock: null,
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
    storageTextures: StorageTextureEntry[],
    samplers: SamplerEntry[],
): BindGroup {
    const bindings: Binding[] = [];

    for (const entry of storage) {
        bindings.push({ kind: 'storage', entry, lastBuffer: null });
    }

    for (const entry of textures) {
        bindings.push({ kind: 'texture', entry, generation: 0, lastTexture: null, lastRangeKey: null });
    }

    for (const entry of storageTextures) {
        bindings.push({ kind: 'storageTexture', entry, generation: 0, lastTexture: null, lastRangeKey: null });
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
                    lastUseFrameId: -1,
                    sliceBufferId: -1,
                    sliceOffset: 0,
                    currentBuffer: null,
                    scratchBuffer: null,
                    stamp: [],
                    sharedBlock: binding.sharedBlock,
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
                    lastTexture: null,
                    lastRangeKey: null,
                };
            case 'storageTexture':
                return {
                    kind: 'storageTexture' as const,
                    entry: binding.entry,
                    generation: 0,
                    lastTexture: null,
                    lastRangeKey: null,
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

/**
 * The versions a per-object block's bytes follow, into `out`: each member's `Uniform.version`, the material's uniform's
 * for a member read from the material, or the drawn object's `worldMatrixVersion` for one of its matrices. False when
 * a member has an object callback: what it reads has no version, so the block is packed at every use. Frame and render
 * callbacks run first, at most once a frame or render as ever, so their uniforms' versions are current.
 */
export function readBlockStamp(block: UniformGroupBlock, frame: NodeFrame, material: Material | null, out: number[]): boolean {
    let count = 0;
    for (const m of block.members) {
        const node = m.node;
        if (node.objectMatrix !== null) {
            out[count++] = frame.object!.worldMatrixVersion;
            continue;
        }
        if (node.update) {
            if (node.updateType === UniformUpdateType.OBJECT) return false;
            frame.updateNode(node as unknown as Parameters<typeof frame.updateNode>[0]);
        }
        const uniform = node.uniform;
        out[count++] = uniform.value !== null ? uniform.version : (material?.parameters.uniform(node.name)?.version ?? 0);
    }
    out.length = count;
    return true;
}

/** Whether two stamps are the same versions. An empty one, a block with no stamp, never matches. */
export function sameStamp(a: readonly number[], b: readonly number[]): boolean {
    if (a.length === 0 || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
    return true;
}

/**
 * Run the update callbacks for a uniform group's members.
 *
 * Neutral on purpose: it walks the group's members and defers to `NodeFrame.updateNode`, which owns
 * the FRAME/RENDER/OBJECT dedup. No device is touched, so both backends call this rather than each
 * keeping its own walk. It lived in `webgpu/bindings.ts` and was imported across the backend boundary
 * by `webgl/`, the only such import in the tree.
 */
export function invokeUniformGroupCallbacks(block: UniformGroupBlock, frame: NodeFrame): void {
    for (const m of block.members) {
        const node = m.node;
        if (node.objectMatrix !== null) {
            node.uniform.value = frame.object![node.objectMatrix];
            continue;
        }
        if (node.update) {
            // Use NodeFrame's updateNode which respects updateType and deduplicates:
            // - FRAME: runs once per frameId
            // - RENDER: runs once per renderId
            // - OBJECT: runs every time (per mesh)
            // The callback itself assigns the uniform's value (see UniformNode.onUpdate)
            frame.updateNode(node as unknown as Parameters<typeof frame.updateNode>[0]);
        }
    }
}
