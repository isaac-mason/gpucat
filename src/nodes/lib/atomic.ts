import { addToStack, CallNode, type WgslType, Node } from './core';

/* atomic operations for i32 and u32 types */
// operate on storage buffer elements marked as atomic, represented by StorageNode with isAtomic=true

/**
 * Atomically adds `value` to the atomic value at `ptr` and returns the old value.
 *
 * In WGSL: `atomicAdd(&ptr, value) -> i32/u32`
 *
 * @param ptr - A node representing an atomic storage location (must be i32 or u32)
 * @param value - The value to add
 * @returns The old value before the addition
 *
 * @example
 * const grid = storageArray(GRID_SIZE, S.array(S.i32()), 'read_write');
 * const cellIdx = computeCellIndex();
 * const oldVal = atomicAdd(grid.element(cellIdx), i32(100));
 */
export function atomicAdd<T extends 'i32' | 'u32'>(ptr: Node<T>, value: Node<T>): Node<T> {
    return new CallNode(ptr.type as T, 'atomicAdd', [ptr, value]);
}

/**
 * Atomically stores `value` to the atomic location at `ptr`.
 *
 * In WGSL: `atomicStore(&ptr, value)`
 *
 * @param ptr - A node representing an atomic storage location (must be i32 or u32)
 * @param value - The value to store
 *
 * @example
 * const grid = storageArray(GRID_SIZE, S.array(S.i32()), 'read_write');
 * const cellIdx = computeCellIndex();
 * atomicStore(grid.element(cellIdx), i32(0));
 */
export function atomicStore<T extends 'i32' | 'u32'>(ptr: Node<T>, value: Node<T>): void {
    addToStack(new CallNode('void', 'atomicStore', [ptr, value]) as Node<WgslType>);
}

/**
 * Atomically loads the value from the atomic location at `ptr`.
 *
 * In WGSL: `atomicLoad(&ptr) -> i32/u32`
 *
 * @param ptr - A node representing an atomic storage location (must be i32 or u32)
 * @returns The current value at the atomic location
 *
 * @example
 * const grid = storageArray(GRID_SIZE, S.array(S.i32()), 'read_write');
 * const cellIdx = computeCellIndex();
 * const val = atomicLoad(grid.element(cellIdx));
 */
export function atomicLoad<T extends 'i32' | 'u32'>(ptr: Node<T>): Node<T> {
    return new CallNode(ptr.type as T, 'atomicLoad', [ptr]);
}

/**
 * Atomically subtracts `value` from the atomic value at `ptr` and returns the old value.
 *
 * In WGSL: `atomicSub(&ptr, value) -> i32/u32`
 *
 * @param ptr - A node representing an atomic storage location (must be i32 or u32)
 * @param value - The value to subtract
 * @returns The old value before the subtraction
 */
export function atomicSub<T extends 'i32' | 'u32'>(ptr: Node<T>, value: Node<T>): Node<T> {
    return new CallNode(ptr.type as T, 'atomicSub', [ptr, value]);
}

/**
 * Atomically computes the maximum of the atomic value and `value`, stores it, and returns the old value.
 *
 * In WGSL: `atomicMax(&ptr, value) -> i32/u32`
 *
 * @param ptr - A node representing an atomic storage location (must be i32 or u32)
 * @param value - The value to compare with
 * @returns The old value before the operation
 */
export function atomicMax<T extends 'i32' | 'u32'>(ptr: Node<T>, value: Node<T>): Node<T> {
    return new CallNode(ptr.type as T, 'atomicMax', [ptr, value]);
}

/**
 * Atomically computes the minimum of the atomic value and `value`, stores it, and returns the old value.
 *
 * In WGSL: `atomicMin(&ptr, value) -> i32/u32`
 *
 * @param ptr - A node representing an atomic storage location (must be i32 or u32)
 * @param value - The value to compare with
 * @returns The old value before the operation
 */
export function atomicMin<T extends 'i32' | 'u32'>(ptr: Node<T>, value: Node<T>): Node<T> {
    return new CallNode(ptr.type as T, 'atomicMin', [ptr, value]);
}

/**
 * Atomically computes the bitwise AND of the atomic value and `value`, stores it, and returns the old value.
 *
 * In WGSL: `atomicAnd(&ptr, value) -> i32/u32`
 *
 * @param ptr - A node representing an atomic storage location (must be i32 or u32)
 * @param value - The value to AND with
 * @returns The old value before the operation
 */
export function atomicAnd<T extends 'i32' | 'u32'>(ptr: Node<T>, value: Node<T>): Node<T> {
    return new CallNode(ptr.type as T, 'atomicAnd', [ptr, value]);
}

/**
 * Atomically computes the bitwise OR of the atomic value and `value`, stores it, and returns the old value.
 *
 * In WGSL: `atomicOr(&ptr, value) -> i32/u32`
 *
 * @param ptr - A node representing an atomic storage location (must be i32 or u32)
 * @param value - The value to OR with
 * @returns The old value before the operation
 */
export function atomicOr<T extends 'i32' | 'u32'>(ptr: Node<T>, value: Node<T>): Node<T> {
    return new CallNode(ptr.type as T, 'atomicOr', [ptr, value]);
}

/**
 * Atomically computes the bitwise XOR of the atomic value and `value`, stores it, and returns the old value.
 *
 * In WGSL: `atomicXor(&ptr, value) -> i32/u32`
 *
 * @param ptr - A node representing an atomic storage location (must be i32 or u32)
 * @param value - The value to XOR with
 * @returns The old value before the operation
 */
export function atomicXor<T extends 'i32' | 'u32'>(ptr: Node<T>, value: Node<T>): Node<T> {
    return new CallNode(ptr.type as T, 'atomicXor', [ptr, value]);
}

/**
 * Atomically exchanges the value at `ptr` with `value` and returns the old value.
 *
 * In WGSL: `atomicExchange(&ptr, value) -> i32/u32`
 *
 * @param ptr - A node representing an atomic storage location (must be i32 or u32)
 * @param value - The new value to store
 * @returns The old value before the exchange
 */
export function atomicExchange<T extends 'i32' | 'u32'>(ptr: Node<T>, value: Node<T>): Node<T> {
    return new CallNode(ptr.type as T, 'atomicExchange', [ptr, value]);
}

/**
 * Atomically compares the value at `ptr` with `comparator` and if equal, stores `value`.
 * Returns the old value (regardless of whether the exchange happened).
 *
 * In WGSL: `atomicCompareExchangeWeak(&ptr, comparator, value) -> __atomic_compare_exchange_result<T>`
 *
 * Note: WGSL returns a struct { old_value: T, exchanged: bool }. This function returns the struct type
 * which you need to access via .old_value and .exchanged fields.
 *
 * @param ptr - A node representing an atomic storage location (must be i32 or u32)
 * @param comparator - The expected current value
 * @param value - The new value to store if comparison succeeds
 * @returns A struct node with old_value and exchanged fields
 */
export function atomicCompareExchangeWeak<T extends 'i32' | 'u32'>(
    ptr: Node<T>,
    comparator: Node<T>,
    value: Node<T>
): Node<WgslType> {
    // WGSL returns __atomic_compare_exchange_result<T> which is a struct
    // For now we type it as WgslType; users access .old_value and .exchanged via .field()
    return new CallNode('void' as WgslType, 'atomicCompareExchangeWeak', [ptr, comparator, value]);
}
