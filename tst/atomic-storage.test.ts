import { test, expect } from 'vitest';
import { d, createStorageBuffer, storage, Fn, globalId, index, atomicAdd, atomicLoad, atomicStore, u32, Var, If, localId, workgroupBarrier, WorkgroupVar, compileCompute } from '../src/index';

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

// Regression: workgroup-shared atomic (used for workgroup-local stream
// compaction). Must declare `var<workgroup> … : atomic<u32>` and take its
// address in atomic ops.
test('workgroup atomic declares and compiles', () => {
    const wgCount = WorkgroupVar('wgCount', d.atomic(d.u32));
    const out = storage(createStorageBuffer(d.array(d.u32), new Uint32Array(64)), 'read_write');

    const kernel = Fn(() => {
        If(localId.x.equal(u32(0)), () => {
            atomicStore(wgCount, u32(0));
        });
        workgroupBarrier();
        const slot = Var('slot', atomicAdd(wgCount, u32(1)));
        workgroupBarrier();
        const total = Var('total', atomicLoad(wgCount));
        index(out, slot).assign(total);
    }).compute({ workgroupSize: [64, 1, 1] });

    const wgsl = compileCompute(kernel).code;
    expect(wgsl).toContain('var<workgroup> wgCount: atomic<u32>');
    expect(wgsl).toMatch(/atomicAdd\(&wgCount/);
    expect(wgsl).toMatch(/atomicStore\(&wgCount/);
    expect(wgsl).toMatch(/atomicLoad\(&wgCount/);
});
