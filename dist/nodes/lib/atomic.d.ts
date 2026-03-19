import { Node } from './core';
import type { Any } from '../../schema/schema';
import * as d from '../../schema/schema';
type AtomicPtrDesc = d.i32 | d.u32 | d.atomicI32 | d.atomicU32;
type ScalarResultDesc = d.i32 | d.u32;
/**
 * Atomically adds `value` to the atomic value at `ptr` and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicAdd(&ptr, value) -> i32/u32`
 */
export declare function atomicAdd<D extends AtomicPtrDesc>(ptr: Node<D>, value: Node<d.i32 | d.u32>): Node<ScalarResultDesc>;
/**
 * Atomically stores `value` to the atomic location at `ptr`.
 *
 * In WGSL: `atomicStore(&ptr, value)`
 */
export declare function atomicStore<D extends AtomicPtrDesc>(ptr: Node<D>, value: Node<d.i32 | d.u32>): void;
/**
 * Atomically loads the value from the atomic location at `ptr`.
 *
 * In WGSL: `atomicLoad(&ptr) -> i32/u32`
 */
export declare function atomicLoad<D extends AtomicPtrDesc>(ptr: Node<D>): Node<ScalarResultDesc>;
/**
 * Atomically subtracts `value` from the atomic value at `ptr` and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicSub(&ptr, value) -> i32/u32`
 */
export declare function atomicSub<D extends AtomicPtrDesc>(ptr: Node<D>, value: Node<d.i32 | d.u32>): Node<ScalarResultDesc>;
/**
 * Atomically computes the maximum of the atomic value and `value`, stores it, and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicMax(&ptr, value) -> i32/u32`
 */
export declare function atomicMax<D extends AtomicPtrDesc>(ptr: Node<D>, value: Node<d.i32 | d.u32>): Node<ScalarResultDesc>;
/**
 * Atomically computes the minimum of the atomic value and `value`, stores it, and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicMin(&ptr, value) -> i32/u32`
 */
export declare function atomicMin<D extends AtomicPtrDesc>(ptr: Node<D>, value: Node<d.i32 | d.u32>): Node<ScalarResultDesc>;
/**
 * Atomically computes the bitwise AND of the atomic value and `value`, stores it, and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicAnd(&ptr, value) -> i32/u32`
 */
export declare function atomicAnd<D extends AtomicPtrDesc>(ptr: Node<D>, value: Node<d.i32 | d.u32>): Node<ScalarResultDesc>;
/**
 * Atomically computes the bitwise OR of the atomic value and `value`, stores it, and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicOr(&ptr, value) -> i32/u32`
 */
export declare function atomicOr<D extends AtomicPtrDesc>(ptr: Node<D>, value: Node<d.i32 | d.u32>): Node<ScalarResultDesc>;
/**
 * Atomically computes the bitwise XOR of the atomic value and `value`, stores it, and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicXor(&ptr, value) -> i32/u32`
 */
export declare function atomicXor<D extends AtomicPtrDesc>(ptr: Node<D>, value: Node<d.i32 | d.u32>): Node<ScalarResultDesc>;
/**
 * Atomically exchanges the value at `ptr` with `value` and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicExchange(&ptr, value) -> i32/u32`
 */
export declare function atomicExchange<D extends AtomicPtrDesc>(ptr: Node<D>, value: Node<d.i32 | d.u32>): Node<ScalarResultDesc>;
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
export declare function atomicCompareExchangeWeak<D extends AtomicPtrDesc>(ptr: Node<D>, comparator: Node<d.i32 | d.u32>, value: Node<d.i32 | d.u32>): Node<Any>;
export {};
