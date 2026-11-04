/**
 * The GPU bind groups over one layout and one set of resources, shared by every BindGroup binding that set: two render
 * objects drawing one material's textures bind one GPU group, which a pass then sets once for both. Keyed by the
 * layout and the GPU objects bound, by identity, so a recreated texture or buffer is a new key and a stale entry is
 * never found again.
 *
 * An entry goes with the first GPU object it binds that is destroyed, so a disposed scene's groups go with its
 * resources. One whose objects all live but which nothing has bound for {@link GROUP_KEEP_FRAMES} frames is dropped too,
 * as Granite's and Filament's descriptor caches recycle theirs: a group whose texture alternates (a ping-pong target)
 * finds its other entry still there.
 */
export type CachedGroup = {
    key: string;
    /** over the uniform block's own buffer, or for a group with none; built on first need */
    bindGroup: GPUBindGroup | null;
    /**
     * For a group whose uniform block binds at a dynamic offset: one GPU bind group per dynamic uniform
     * buffer a use has been allocated from, by buffer id. Those buffers are pooled, never replaced, so each
     * stays valid.
     */
    dynamicBindGroups: (GPUBindGroup | undefined)[];
    /** the GPU objects the key names */
    objects: object[];
    /** the frame it was last bound in */
    lastFrame: number;
    /** dropped from the cache unused: a group still holding it re-enters it on its next use */
    evicted: boolean;
    /** an object it binds was destroyed: no group may bind it again */
    released: boolean;
};
export type BindGroupCache = {
    /** every entry, by layout and resources bound */
    groups: Map<string, CachedGroup>;
    /** the entries naming each GPU object, so destroying the object releases them */
    objectToGroups: WeakMap<object, CachedGroup[]>;
    /** the frame the cache was last swept for unused entries */
    sweptFrame: number;
};
/** Frames an entry stays cached unused, and how often the cache is swept for them. */
export declare const GROUP_KEEP_FRAMES = 300;
export declare function createBindGroupCache(): BindGroupCache;
/** Entries held. */
export declare function getBindGroupCacheStats(cache: BindGroupCache): {
    groups: number;
};
/** Drops every entry (renderer dispose; `device.destroy()` frees the GPU side). */
export declare function disposeBindGroupCache(cache: BindGroupCache): void;
/** The entry for `key`, made empty on first need and filed under each of `objects`, the GPU objects the key names. */
export declare function cachedGroup(cache: BindGroupCache, key: string, objects: readonly object[]): CachedGroup;
/** An evicted entry a group still binds, back in the cache unless another took its key since. */
export declare function readmit(cache: BindGroupCache, group: CachedGroup): void;
/** Drops entries no draw or dispatch has bound for {@link GROUP_KEEP_FRAMES} frames. */
export declare function sweepGroups(cache: BindGroupCache, frameId: number): void;
/** `object` is being destroyed: every entry naming it leaves the cache for good. */
export declare function releaseGroupsNaming(cache: BindGroupCache, object: object): void;
