/**
 * ChainMap state type. Uses a map of WeakMaps indexed by key length for
 * efficient lookups of different key arities.
 *
 * It's key advantage is automatic garbage collection - when any key object in
 * the chain is garbage collected, the cached value is automatically released.
 */
export type ChainMap<T> = {
    /** Type brand, not set at runtime */
    __T?: T;
    /**
     * Map of WeakMaps indexed by key length.
     * Each key length gets its own nested WeakMap chain.
     */
    weakMaps: Map<number, WeakMap<object, unknown>>;
};
/** Create a new empty ChainMap */
export declare function create<T>(): ChainMap<T>;
/**
 * Get a value from the ChainMap by composite key.
 * @param map the ChainMap to query
 * @param keys array of objects forming the composite key
 * @returns the cached value, or undefined if not found
 */
export declare function get<T>(map: ChainMap<T>, keys: object[]): T | undefined;
/**
 * Set a value in the ChainMap by composite key.
 * @param map the ChainMap to modify
 * @param keys array of objects forming the composite key
 * @param value the value to cache
 */
export declare function set<T>(map: ChainMap<T>, keys: object[], value: T): void;
/**
 * Delete a value from the ChainMap by composite key.
 * @param map the ChainMap to modify
 * @param keys array of objects forming the composite key
 * @returns true if the value existed and was deleted, false otherwise
 */
export declare function del<T>(map: ChainMap<T>, keys: object[]): boolean;
/**
 * Clear all entries from the ChainMap.
 * @param map the ChainMap to clear
 */
export declare function clear<T>(map: ChainMap<T>): void;
