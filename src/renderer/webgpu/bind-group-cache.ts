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
export const GROUP_KEEP_FRAMES = 300;

export function createBindGroupCache(): BindGroupCache {
    return { groups: new Map(), objectToGroups: new WeakMap(), sweptFrame: 0 };
}

/** Entries held. */
export function getBindGroupCacheStats(cache: BindGroupCache): { groups: number } {
    return { groups: cache.groups.size };
}

/** Drops every entry (renderer dispose; `device.destroy()` frees the GPU side). */
export function disposeBindGroupCache(cache: BindGroupCache): void {
    cache.groups.clear();
    cache.objectToGroups = new WeakMap();
}

/** The entry for `key`, made empty on first need and filed under each of `objects`, the GPU objects the key names. */
export function cachedGroup(cache: BindGroupCache, key: string, objects: readonly object[]): CachedGroup {
    let group = cache.groups.get(key);
    if (group === undefined) {
        group = {
            key,
            bindGroup: null,
            dynamicBindGroups: [],
            objects: [...objects],
            lastFrame: 0,
            evicted: false,
            released: false,
        };
        cache.groups.set(key, group);
        file(cache, group);
    }
    return group;
}

/** An evicted entry a group still binds, back in the cache unless another took its key since. */
export function readmit(cache: BindGroupCache, group: CachedGroup): void {
    group.evicted = false;
    if (cache.groups.has(group.key)) return;
    cache.groups.set(group.key, group);
    file(cache, group);
}

/** Drops entries no draw or dispatch has bound for {@link GROUP_KEEP_FRAMES} frames. */
export function sweepGroups(cache: BindGroupCache, frameId: number): void {
    cache.sweptFrame = frameId;
    for (const [key, group] of cache.groups) {
        if (frameId - group.lastFrame < GROUP_KEEP_FRAMES) continue;
        group.evicted = true;
        cache.groups.delete(key);
        unfile(cache, group, null);
    }
}

/** `object` is being destroyed: every entry naming it leaves the cache for good. */
export function releaseGroupsNaming(cache: BindGroupCache, object: object): void {
    const named = cache.objectToGroups.get(object);
    if (named === undefined) return;
    cache.objectToGroups.delete(object);
    for (const group of named) {
        group.released = true;
        group.bindGroup = null;
        group.dynamicBindGroups.length = 0;
        if (cache.groups.get(group.key) === group) cache.groups.delete(group.key);
        unfile(cache, group, object);
    }
}

/** Files `group` under each object it names. */
function file(cache: BindGroupCache, group: CachedGroup): void {
    for (const object of group.objects) {
        const named = cache.objectToGroups.get(object);
        if (named === undefined) cache.objectToGroups.set(object, [group]);
        else named.push(group);
    }
}

/** Takes `group` off the lists of the objects it names, but `except`'s, which is being dropped whole. */
function unfile(cache: BindGroupCache, group: CachedGroup, except: object | null): void {
    for (const object of group.objects) {
        if (object === except) continue;
        const named = cache.objectToGroups.get(object);
        if (named === undefined) continue;
        const at = named.indexOf(group);
        if (at >= 0) named.splice(at, 1);
        if (named.length === 0) cache.objectToGroups.delete(object);
    }
}
