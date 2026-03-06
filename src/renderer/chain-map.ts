/**
 * ChainMap - Hierarchical WeakMap-based cache supporting composite keys.
 *
 * This is aligned with Three.js's ChainMap implementation used in RenderObjects
 * and RenderLists for caching by (object, material, renderContext, ...) tuples.
 *
 * The key advantage is automatic garbage collection - when any key object in
 * the chain is garbage collected, the cached value is automatically released.
 *
 * @example
 * ```typescript
 * const map = createChainMap<RenderObject>();
 * const keys = [mesh, material, renderContext];
 *
 * // Set a value
 * chainMapSet(map, keys, renderObject);
 *
 * // Get a value
 * const cached = chainMapGet(map, keys);
 *
 * // Delete a value
 * chainMapDelete(map, keys);
 * ```
 */

/**
 * ChainMap state type. Uses a map of WeakMaps indexed by key length for
 * efficient lookups of different key arities.
 */
export type ChainMap<T> = {
    /**
     * Map of WeakMaps indexed by key length.
     * Each key length gets its own nested WeakMap chain.
     */
    weakMaps: Map<number, WeakMap<object, unknown>>;
    /**
     * Phantom field to preserve the type parameter T.
     * This is never actually used at runtime.
     */
    __phantom?: T;
};

/**
 * Create a new empty ChainMap.
 */
export function create<T>(): ChainMap<T> {
    return {
        weakMaps: new Map(),
    };
}

/**
 * Get the root WeakMap for a given key length, creating it if necessary.
 */
function getWeakMap<T>(map: ChainMap<T>, keyLength: number): WeakMap<object, unknown> {
    let weakMap = map.weakMaps.get(keyLength);
    if (weakMap === undefined) {
        weakMap = new WeakMap();
        map.weakMaps.set(keyLength, weakMap);
    }
    return weakMap;
}

/**
 * Get a value from the ChainMap by composite key.
 *
 * @param map - The ChainMap to query
 * @param keys - Array of objects forming the composite key
 * @returns The cached value, or undefined if not found
 */
export function get<T>(map: ChainMap<T>, keys: object[]): T | undefined {
    if (keys.length === 0) return undefined;

    let current: WeakMap<object, unknown> | unknown = getWeakMap(map, keys.length);

    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const next = (current as WeakMap<object, unknown>).get(key);

        if (next === undefined) {
            return undefined;
        }

        current = next;
    }

    return current as T;
}

/**
 * Set a value in the ChainMap by composite key.
 *
 * @param map - The ChainMap to modify
 * @param keys - Array of objects forming the composite key
 * @param value - The value to cache
 */
export function set<T>(map: ChainMap<T>, keys: object[], value: T): void {
    if (keys.length === 0) return;

    let current: WeakMap<object, unknown> = getWeakMap(map, keys.length);

    // Navigate/create intermediate WeakMaps
    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        let next = current.get(key) as WeakMap<object, unknown> | undefined;

        if (next === undefined) {
            next = new WeakMap();
            current.set(key, next);
        }

        current = next;
    }

    // Set the value at the final key
    current.set(keys[keys.length - 1], value);
}

/**
 * Delete a value from the ChainMap by composite key.
 *
 * @param map - The ChainMap to modify
 * @param keys - Array of objects forming the composite key
 * @returns true if the value existed and was deleted, false otherwise
 */
export function del<T>(map: ChainMap<T>, keys: object[]): boolean {
    if (keys.length === 0) return false;

    let current: WeakMap<object, unknown> | unknown = getWeakMap(map, keys.length);

    // Navigate to the parent of the final key
    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        const next = (current as WeakMap<object, unknown>).get(key);

        if (next === undefined) {
            return false;
        }

        current = next;
    }

    // Delete the final key
    return (current as WeakMap<object, unknown>).delete(keys[keys.length - 1]);
}

/**
 * Clear all entries from the ChainMap.
 *
 * @param map - The ChainMap to clear
 */
export function clear<T>(map: ChainMap<T>): void {
    map.weakMaps.clear();
}
