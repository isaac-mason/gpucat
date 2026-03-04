/**
 * indirect-buffer.ts — Typed owner of WebGPU indirect draw arguments.
 *
 * Two variants:
 *   indexed = false → drawIndirect          4 × u32 (16 bytes)
 *   indexed = true  → drawIndexedIndirect   5 × u32 (20 bytes)
 *
 * Named accessors read/write the correct Uint32Array slot and increment `version`
 * on every write so the renderer knows to re-upload the buffer.
 *
 * baseVertex is stored as u32. The WebGPU spec types it i32 to allow negative
 * values (needed when sub-meshes share one slab-allocated vertex buffer). gpucat
 * has no slab allocator — every Geometry owns its own BufferAttribute — so
 * baseVertex is always ≥ 0. Using Uint32Array keeps the code uniform. If a slab
 * allocator is added later, only this field needs DataView.setInt32 / getInt32.
 */

import { StorageNode } from '../nodes/nodes.js';

// ---------------------------------------------------------------------------
// Arg types — init helpers
// ---------------------------------------------------------------------------

export type DrawIndirectArgs = {
    vertexCount?:   number; // u32
    instanceCount?: number; // u32
    firstVertex?:   number; // u32
    firstInstance?: number; // u32
};

export type DrawIndexedIndirectArgs = {
    indexCount?:    number; // u32
    instanceCount?: number; // u32
    firstIndex?:    number; // u32
    baseVertex?:    number; // u32 (stored) / i32 (spec) — must be >= 0
    firstInstance?: number; // u32
};

// ---------------------------------------------------------------------------
// IndirectBuffer
// ---------------------------------------------------------------------------

export class IndirectBuffer {
    /**
     * Raw u32 storage. Layout:
     *
     * Non-indexed (indexed=false):       Indexed (indexed=true):
     *   [0] vertexCount                    [0] indexCount
     *   [1] instanceCount                  [1] instanceCount
     *   [2] firstVertex                    [2] firstIndex
     *   [3] firstInstance                  [3] baseVertex
     *                                      [4] firstInstance
     *
     * You may write directly to `data` and then set `needsUpdate = true`
     * to trigger a full re-upload on the next frame.
     */
    readonly data: Uint32Array;

    /** true → drawIndexedIndirect, false → drawIndirect. */
    readonly indexed: boolean;

    /**
     * When true, the renderer allocates the GPUBuffer with
     * STORAGE | INDIRECT | COPY_DST so a compute shader can write to it.
     * Must be set before the first frame — changing it after the buffer has
     * been created has no effect (the old buffer keeps its original usage).
     * Default: false.
     */
    readonly computeWritable: boolean;

    /**
     * Monotonically incremented by every setter and by `needsUpdate = true`.
     * The renderer compares this against its cached version to decide whether
     * to re-upload. Starts at 0.
     */
    version: number = 0;

    /** Lazily created StorageNode (only when computeWritable=true and asStorageNode() is called). */
    private _storageNode: StorageNode<'u32'> | null = null;

    constructor(indexed: boolean, init?: DrawIndirectArgs | DrawIndexedIndirectArgs, options?: { computeWritable?: boolean }) {
        this.indexed = indexed;
        this.computeWritable = options?.computeWritable ?? false;
        this.data = new Uint32Array(indexed ? 5 : 4);

        if (init) {
            if (indexed) {
                const a = init as DrawIndexedIndirectArgs;
                if (a.indexCount    !== undefined) this.indexCount    = a.indexCount;
                if (a.instanceCount !== undefined) this.instanceCount = a.instanceCount;
                if (a.firstIndex    !== undefined) this.firstIndex    = a.firstIndex;
                if (a.baseVertex    !== undefined) this.baseVertex    = a.baseVertex;
                if (a.firstInstance !== undefined) this.firstInstance = a.firstInstance;
            } else {
                const a = init as DrawIndirectArgs;
                if (a.vertexCount   !== undefined) this.vertexCount   = a.vertexCount;
                if (a.instanceCount !== undefined) this.instanceCount = a.instanceCount;
                if (a.firstVertex   !== undefined) this.firstVertex   = a.firstVertex;
                if (a.firstInstance !== undefined) this.firstInstance = a.firstInstance;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Shared accessors (both variants)
    // -----------------------------------------------------------------------

    get instanceCount(): number { return this.data[1]; }
    set instanceCount(v: number) { this.data[1] = v; this.version++; }

    // firstInstance slot differs between indexed/non-indexed
    get firstInstance(): number { return this.indexed ? this.data[4] : this.data[3]; }
    set firstInstance(v: number) {
        if (this.indexed) { this.data[4] = v; } else { this.data[3] = v; }
        this.version++;
    }

    // -----------------------------------------------------------------------
    // Non-indexed only
    // -----------------------------------------------------------------------

    get vertexCount(): number { return this.data[0]; }
    set vertexCount(v: number) { this.data[0] = v; this.version++; }

    get firstVertex(): number { return this.data[2]; }
    set firstVertex(v: number) { this.data[2] = v; this.version++; }

    // -----------------------------------------------------------------------
    // Indexed only
    // -----------------------------------------------------------------------

    get indexCount(): number { return this.data[0]; }
    set indexCount(v: number) { this.data[0] = v; this.version++; }

    get firstIndex(): number { return this.data[2]; }
    set firstIndex(v: number) { this.data[2] = v; this.version++; }

    get baseVertex(): number { return this.data[3]; }
    set baseVertex(v: number) { this.data[3] = v; this.version++; }

    // -----------------------------------------------------------------------
    // needsUpdate — explicit full-buffer re-upload trigger
    // -----------------------------------------------------------------------

    /**
     * Setting needsUpdate = true increments `version`, causing the renderer to
     * re-upload the entire `data` array on the next frame. Use this when you
     * write directly to `data` without going through the named setters.
     */
    set needsUpdate(_: true) {
        this.version++;
    }

    // -----------------------------------------------------------------------
    // asStorageNode — compute-shader integration
    // -----------------------------------------------------------------------

    /**
     * Return a StorageNode<'u32'> backed by this buffer's Uint32Array.
     *
     * Only valid when computeWritable=true. The returned node is cached — every
     * call returns the same instance. Pass it to a ComputeNode's storage array
     * so the compute shader can write the draw arguments (e.g. instanceCount).
     *
     * The renderer ensures the same GPUBuffer (with STORAGE | INDIRECT | COPY_DST)
     * is used for both the compute binding and the drawIndexedIndirect call.
     *
     * The WGSL storage type is `array<u32>` — index with `gpu.index(node, i)` to
     * read/write individual u32 fields:
     *   [0] indexCount  [1] instanceCount  [2] firstIndex  [3] baseVertex  [4] firstInstance
     * For non-indexed indirect:
     *   [0] vertexCount  [1] instanceCount  [2] firstVertex  [3] firstInstance
     */
    asStorageNode(): StorageNode<'u32'> {
        if (!this.computeWritable) {
            throw new Error('[gpucat] IndirectBuffer.asStorageNode() requires computeWritable=true');
        }
        if (!this._storageNode) {
            this._storageNode = new StorageNode<'u32'>(
                'u32',
                'array<u32>',
                this.data,
                'read_write',
            );
            this._storageNode._indirectOwner = this;
        }
        return this._storageNode;
    }

    /**
     * Internal: return the cached StorageNode if it exists, without creating one.
     * Used by BufferCache to detect shared-buffer indirect nodes.
     */
    get _cachedStorageNode(): StorageNode<'u32'> | null {
        return this._storageNode;
    }
}
