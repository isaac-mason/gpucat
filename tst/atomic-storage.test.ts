import { test, expect } from 'vitest';
import { d, createStorageBuffer, storage, Fn, globalId, index, atomicAdd, atomicLoad, u32, Var, compileCompute } from '../src/index';

// Regression: a storage buffer of `array<atomic<u32>>` must size and compile
// (itemSizeOf previously threw on 'atomic<u32>').
test('atomic storage array sizes and compiles', () => {
    const counts = storage(createStorageBuffer(d.array(d.atomic(d.u32)), new Uint32Array(64)), 'read_write');
    const items = storage(createStorageBuffer(d.array(d.u32), new Uint32Array(64 * 16)), 'read_write');

    const kernel = Fn(() => {
        const i = globalId.x;
        const cell = i.mod(u32(64));
        const slot = Var('slot', atomicAdd(index(counts, cell), u32(1)));
        index(items, cell.mul(u32(16)).add(slot)).assign(i);
        const c = Var('c', atomicLoad(index(counts, cell)));
        index(items, c).assign(i);
    }).compute({ workgroupSize: [64, 1, 1] });

    const wgsl = compileCompute(kernel).code;
    expect(wgsl).toContain('array<atomic<u32>>');
    expect(wgsl).toContain('atomicAdd');
    expect(wgsl).toContain('atomicLoad');
    // A side-effecting call used as a value must not also emit a bare `_vN;`
    // reference, which is invalid WGSL.
    expect(wgsl).not.toMatch(/^\s*_v\d+;\s*$/m);
});
