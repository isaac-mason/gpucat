/**
 * The GPU bind groups over one layout and one set of resources, shared by every BindGroup binding that set: two render
 * objects drawing one material's textures bind one GPU group, which a pass then sets once for both. Keyed by the
 * layout and the GPU objects bound, by identity, so a recreated texture or buffer is a new key and a stale entry is
 * never found again.
 *
 * An entry goes with the first object it names that goes: a buffer or texture it binds destroyed, or its layout's last
 * holder released. As Godot's `UniformSetCacheRD` keeps uniform sets, it lives exactly as long as what it depends on,
 * so a group whose texture alternates (a ping-pong target) finds its other entry still there while both live.
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
    /** an object it binds was destroyed: no group may bind it again */
    released: boolean;
};

export type BindGroupCache = {
    /** every entry, by layout and resources bound */
    groups: Map<string, CachedGroup>;
    /** the entries naming each GPU object, so destroying the object releases them */
    objectToGroups: WeakMap<object, CachedGroup[]>;
};

export function createBindGroupCache(): BindGroupCache {
    return { groups: new Map(), objectToGroups: new WeakMap() };
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
            released: false,
        };
        cache.groups.set(key, group);
        file(cache, group);
    }
    return group;
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
