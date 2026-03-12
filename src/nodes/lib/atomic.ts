import { addToStack, CallNode, Node } from './core';
import type { Any } from '../../schema/schema';
import * as d from '../../schema/schema';

/* atomic operations for i32 and u32 types */
// Pointers can be bare `i32`/`u32` nodes (e.g. from a plain storageArray) or
// `atomic<i32>`/`atomic<u32>` nodes (e.g. struct fields declared with d.atomic()).
// The operations always return/accept the underlying scalar type.

type AtomicPtrDesc = d.i32 | d.u32 | d.atomicI32 | d.atomicU32;
type ScalarResultDesc = d.i32 | d.u32;

/** Strip `atomic<…>` wrapper to get the underlying scalar type descriptor at runtime. */
function scalarDescOf(desc: Any): ScalarResultDesc {
    if (desc.wgslType === 'atomic<i32>' || desc.wgslType === 'i32') return d.i32;
    return d.u32;
}

/**
 * Atomically adds `value` to the atomic value at `ptr` and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicAdd(&ptr, value) -> i32/u32`
 */
export function atomicAdd<D extends AtomicPtrDesc>(ptr: Node<D>, value: Node<d.i32 | d.u32>): Node<ScalarResultDesc> {
    const node = new CallNode(scalarDescOf(ptr.type), 'atomicAdd', [ptr, value]);
    addToStack(node);
    return node;
}

/**
 * Atomically stores `value` to the atomic location at `ptr`.
 *
 * In WGSL: `atomicStore(&ptr, value)`
 */
export function atomicStore<D extends AtomicPtrDesc>(ptr: Node<D>, value: Node<d.i32 | d.u32>): void {
    addToStack(new CallNode(d.voidDesc, 'atomicStore', [ptr, value]));
}

/**
 * Atomically loads the value from the atomic location at `ptr`.
 *
 * In WGSL: `atomicLoad(&ptr) -> i32/u32`
 */
export function atomicLoad<D extends AtomicPtrDesc>(ptr: Node<D>): Node<ScalarResultDesc> {
    return new CallNode(scalarDescOf(ptr.type), 'atomicLoad', [ptr]);
}

/**
 * Atomically subtracts `value` from the atomic value at `ptr` and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicSub(&ptr, value) -> i32/u32`
 */
export function atomicSub<D extends AtomicPtrDesc>(ptr: Node<D>, value: Node<d.i32 | d.u32>): Node<ScalarResultDesc> {
    const node = new CallNode(scalarDescOf(ptr.type), 'atomicSub', [ptr, value]);
    addToStack(node);
    return node;
}

/**
 * Atomically computes the maximum of the atomic value and `value`, stores it, and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicMax(&ptr, value) -> i32/u32`
 */
export function atomicMax<D extends AtomicPtrDesc>(ptr: Node<D>, value: Node<d.i32 | d.u32>): Node<ScalarResultDesc> {
    const node = new CallNode(scalarDescOf(ptr.type), 'atomicMax', [ptr, value]);
    addToStack(node);
    return node;
}

/**
 * Atomically computes the minimum of the atomic value and `value`, stores it, and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicMin(&ptr, value) -> i32/u32`
 */
export function atomicMin<D extends AtomicPtrDesc>(ptr: Node<D>, value: Node<d.i32 | d.u32>): Node<ScalarResultDesc> {
    const node = new CallNode(scalarDescOf(ptr.type), 'atomicMin', [ptr, value]);
    addToStack(node);
    return node;
}

/**
 * Atomically computes the bitwise AND of the atomic value and `value`, stores it, and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicAnd(&ptr, value) -> i32/u32`
 */
export function atomicAnd<D extends AtomicPtrDesc>(ptr: Node<D>, value: Node<d.i32 | d.u32>): Node<ScalarResultDesc> {
    const node = new CallNode(scalarDescOf(ptr.type), 'atomicAnd', [ptr, value]);
    addToStack(node);
    return node;
}

/**
 * Atomically computes the bitwise OR of the atomic value and `value`, stores it, and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicOr(&ptr, value) -> i32/u32`
 */
export function atomicOr<D extends AtomicPtrDesc>(ptr: Node<D>, value: Node<d.i32 | d.u32>): Node<ScalarResultDesc> {
    const node = new CallNode(scalarDescOf(ptr.type), 'atomicOr', [ptr, value]);
    addToStack(node);
    return node;
}

/**
 * Atomically computes the bitwise XOR of the atomic value and `value`, stores it, and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicXor(&ptr, value) -> i32/u32`
 */
export function atomicXor<D extends AtomicPtrDesc>(ptr: Node<D>, value: Node<d.i32 | d.u32>): Node<ScalarResultDesc> {
    const node = new CallNode(scalarDescOf(ptr.type), 'atomicXor', [ptr, value]);
    addToStack(node);
    return node;
}

/**
 * Atomically exchanges the value at `ptr` with `value` and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicExchange(&ptr, value) -> i32/u32`
 */
export function atomicExchange<D extends AtomicPtrDesc>(ptr: Node<D>, value: Node<d.i32 | d.u32>): Node<ScalarResultDesc> {
    const node = new CallNode(scalarDescOf(ptr.type), 'atomicExchange', [ptr, value]);
    addToStack(node);
    return node;
}

/**
 * Atomically compares the value at `ptr` with `comparator` and if equal, stores `value`.
 * Returns the old value (regardless of whether the exchange happened).
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicCompareExchangeWeak(&ptr, comparator, value) -> __atomic_compare_exchange_result<T>`
 *
 * Note: WGSL returns a struct { old_value: T, exchanged: bool }. This function returns the struct type
 * which you need to access via .old_value and .exchanged fields.
 */
export function atomicCompareExchangeWeak<D extends AtomicPtrDesc>(
    ptr: Node<D>,
    comparator: Node<d.i32 | d.u32>,
    value: Node<d.i32 | d.u32>
): Node<Any> {
    const node = new CallNode(d.voidDesc, 'atomicCompareExchangeWeak', [ptr, comparator, value]);
    addToStack(node);
    return node;
}
