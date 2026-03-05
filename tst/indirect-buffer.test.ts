/**
 * Tests for IndirectStorageBufferAttribute — Uint32Array-backed indirect draw buffer.
 *
 * Covers:
 *  1. Constructor: no-arg (single draw, zero data), drawCount number, Uint32Array
 *  2. Constructor: invalid Uint32Array length throws
 *  3. data / drawCount / stride / indexed / computeWritable properties
 *  4. needsUpdate bumps version
 *  5. asStorageNode() throws when computeWritable=false
 *  6. asStorageNode() (no-arg) returns StorageNode<'u32'> with array<u32> storageType
 *  7. asStorageNode() is cached
 *  8. asStorageNode(structDef) returns StructInstance with correct field types
 *  9. StructInstance.$node is a StorageNode with _indirectOwner set
 * 10. asStorageNode(structDef) is cached — repeated calls return same $node
 * 11. _cachedStorageNode lifecycle
 * 12. compileCompute smoke — struct-typed binding emits struct decl + typed var
 * 13. compileCompute smoke — flat array<u32> variant
 */

import { describe, expect, test } from 'vitest';
import { IndirectStorageBufferAttribute } from '../src/scene/indirect-storage-buffer-attribute.js';
import { StorageNode, struct, toVar, u32 } from '../src/nodes/nodes.js';
import * as S from '../src/nodes/schema.js';
import { compileCompute } from '../src/nodes/compile.js';
import { compute } from '../src/nodes/compute-node.js';

// ---------------------------------------------------------------------------
// User-defined struct defs (mirrors Three.js pattern — struct lives here, not
// in IndirectStorageBufferAttribute).
// ---------------------------------------------------------------------------

const DrawIndexedIndirectArgsStruct = struct('DrawIndexedIndirectArgs', {
    indexCount:    S.u32(),
    instanceCount: S.u32(),
    firstIndex:    S.u32(),
    baseVertex:    S.u32(),
    firstInstance: S.u32(),
});

const DrawIndirectArgsStruct = struct('DrawIndirectArgs', {
    vertexCount:   S.u32(),
    instanceCount: S.u32(),
    firstVertex:   S.u32(),
    firstInstance: S.u32(),
});

// ---------------------------------------------------------------------------
// 1. Constructor — no-arg (single draw)
// ---------------------------------------------------------------------------

describe('IndirectStorageBufferAttribute constructor — no-arg', () => {
    test('indexed=true: drawCount=1, stride=5, data.length=5', () => {
        const buf = new IndirectStorageBufferAttribute(true);
        expect(buf.indexed).toBe(true);
        expect(buf.drawCount).toBe(1);
        expect(buf.stride).toBe(5);
        expect(buf.data.length).toBe(5);
    });

    test('indexed=false: drawCount=1, stride=4, data.length=4', () => {
        const buf = new IndirectStorageBufferAttribute(false);
        expect(buf.indexed).toBe(false);
        expect(buf.drawCount).toBe(1);
        expect(buf.stride).toBe(4);
        expect(buf.data.length).toBe(4);
    });

    test('data is all zeros initially', () => {
        const buf = new IndirectStorageBufferAttribute(true);
        expect(Array.from(buf.data)).toEqual([0, 0, 0, 0, 0]);
    });

    test('computeWritable defaults to false', () => {
        const buf = new IndirectStorageBufferAttribute(true);
        expect(buf.computeWritable).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 2. Constructor — drawCount number
// ---------------------------------------------------------------------------

describe('IndirectStorageBufferAttribute constructor — drawCount number', () => {
    test('indexed=true, drawCount=2: data.length=10', () => {
        const buf = new IndirectStorageBufferAttribute(true, 2);
        expect(buf.drawCount).toBe(2);
        expect(buf.data.length).toBe(10);
    });

    test('indexed=false, drawCount=3: data.length=12', () => {
        const buf = new IndirectStorageBufferAttribute(false, 3);
        expect(buf.drawCount).toBe(3);
        expect(buf.data.length).toBe(12);
    });
});

// ---------------------------------------------------------------------------
// 3. Constructor — Uint32Array
// ---------------------------------------------------------------------------

describe('IndirectStorageBufferAttribute constructor — Uint32Array', () => {
    test('indexed=true, length=5: drawCount=1, data is the passed array', () => {
        const arr = new Uint32Array([36, 10, 0, 0, 0]);
        const buf = new IndirectStorageBufferAttribute(true, arr);
        expect(buf.data).toBe(arr);
        expect(buf.drawCount).toBe(1);
        expect(buf.data[0]).toBe(36);
        expect(buf.data[1]).toBe(10);
    });

    test('indexed=true, length=10: drawCount=2', () => {
        const arr = new Uint32Array(10);
        const buf = new IndirectStorageBufferAttribute(true, arr);
        expect(buf.drawCount).toBe(2);
    });

    test('throws when length is not a multiple of stride', () => {
        const arr = new Uint32Array(7); // 7 % 5 != 0
        expect(() => new IndirectStorageBufferAttribute(true, arr)).toThrow(/stride/);
    });

    test('indexed=false: throws when length is not a multiple of 4', () => {
        const arr = new Uint32Array(6); // 6 % 4 != 0
        expect(() => new IndirectStorageBufferAttribute(false, arr)).toThrow(/stride/);
    });
});

// ---------------------------------------------------------------------------
// 4. needsUpdate bumps version
// ---------------------------------------------------------------------------

describe('needsUpdate', () => {
    test('version starts at 0', () => {
        const buf = new IndirectStorageBufferAttribute(true);
        expect(buf.version).toBe(0);
    });

    test('needsUpdate = true increments version', () => {
        const buf = new IndirectStorageBufferAttribute(true);
        buf.needsUpdate = true;
        expect(buf.version).toBe(1);
        buf.needsUpdate = true;
        expect(buf.version).toBe(2);
    });

    test('direct data[] writes do NOT auto-increment version', () => {
        const buf = new IndirectStorageBufferAttribute(true);
        buf.data[1] = 42;
        expect(buf.version).toBe(0); // must call needsUpdate manually
    });
});

// ---------------------------------------------------------------------------
// 5. asStorageNode() throws when computeWritable=false
// ---------------------------------------------------------------------------

describe('asStorageNode() throws when computeWritable=false', () => {
    test('throws for flat variant', () => {
        const buf = new IndirectStorageBufferAttribute(true);
        expect(() => buf.asStorageNode()).toThrow(/computeWritable=true/);
    });

    test('throws for struct variant', () => {
        const buf = new IndirectStorageBufferAttribute(true);
        expect(() => buf.asStorageNode(DrawIndexedIndirectArgsStruct)).toThrow(/computeWritable=true/);
    });
});

// ---------------------------------------------------------------------------
// 6. asStorageNode() (no-arg) — flat array<u32>
// ---------------------------------------------------------------------------

describe('asStorageNode() flat (no-arg)', () => {
    test('returns a StorageNode with type u32 and storageType array<u32>', () => {
        const buf = new IndirectStorageBufferAttribute(true, undefined, { computeWritable: true });
        const node = buf.asStorageNode();
        expect(node).toBeInstanceOf(StorageNode);
        expect(node.type).toBe('u32');
        expect(node.storageType).toBe('array<u32>');
    });

    test('_indirectOwner points back to the IndirectStorageBufferAttribute', () => {
        const buf = new IndirectStorageBufferAttribute(true, undefined, { computeWritable: true });
        const node = buf.asStorageNode();
        expect(node._indirectOwner).toBe(buf);
    });
});

// ---------------------------------------------------------------------------
// 7. asStorageNode() is cached
// ---------------------------------------------------------------------------

describe('asStorageNode() caching', () => {
    test('repeated flat calls return same instance', () => {
        const buf = new IndirectStorageBufferAttribute(false, undefined, { computeWritable: true });
        const a = buf.asStorageNode();
        const b = buf.asStorageNode();
        expect(a).toBe(b);
    });

    test('repeated struct calls return same $node', () => {
        const buf = new IndirectStorageBufferAttribute(true, undefined, { computeWritable: true });
        const inst1 = buf.asStorageNode(DrawIndexedIndirectArgsStruct);
        const inst2 = buf.asStorageNode(DrawIndexedIndirectArgsStruct);
        expect(inst1.$node).toBe(inst2.$node);
    });
});

// ---------------------------------------------------------------------------
// 8. asStorageNode(structDef) returns correct StructInstance
// ---------------------------------------------------------------------------

describe('asStorageNode(structDef) struct-typed variant', () => {
    test('returns a StructInstance with all five fields for DrawIndexedIndirectArgs', () => {
        const buf = new IndirectStorageBufferAttribute(true, undefined, { computeWritable: true });
        const inst = buf.asStorageNode(DrawIndexedIndirectArgsStruct);
        expect(inst).toHaveProperty('indexCount');
        expect(inst).toHaveProperty('instanceCount');
        expect(inst).toHaveProperty('firstIndex');
        expect(inst).toHaveProperty('baseVertex');
        expect(inst).toHaveProperty('firstInstance');
    });

    test('each field node has type u32', () => {
        const buf = new IndirectStorageBufferAttribute(true, undefined, { computeWritable: true });
        const inst = buf.asStorageNode(DrawIndexedIndirectArgsStruct);
        for (const key of ['indexCount', 'instanceCount', 'firstIndex', 'baseVertex', 'firstInstance'] as const) {
            expect(inst[key].type).toBe('u32');
        }
    });

    test('returns a StructInstance with all four fields for DrawIndirectArgs', () => {
        const buf = new IndirectStorageBufferAttribute(false, undefined, { computeWritable: true });
        const inst = buf.asStorageNode(DrawIndirectArgsStruct);
        expect(inst).toHaveProperty('vertexCount');
        expect(inst).toHaveProperty('instanceCount');
        expect(inst).toHaveProperty('firstVertex');
        expect(inst).toHaveProperty('firstInstance');
    });
});

// ---------------------------------------------------------------------------
// 9. $node is a StorageNode with _indirectOwner set
// ---------------------------------------------------------------------------

describe('StructInstance.$node', () => {
    test('$node is a StorageNode', () => {
        const buf = new IndirectStorageBufferAttribute(true, undefined, { computeWritable: true });
        const inst = buf.asStorageNode(DrawIndexedIndirectArgsStruct);
        expect(inst.$node).toBeInstanceOf(StorageNode);
    });

    test('$node.type and storageType are both the struct name', () => {
        const buf = new IndirectStorageBufferAttribute(true, undefined, { computeWritable: true });
        const inst = buf.asStorageNode(DrawIndexedIndirectArgsStruct);
        const node = inst.$node as StorageNode<string>;
        expect(node.type).toBe('DrawIndexedIndirectArgs');
        expect(node.storageType).toBe('DrawIndexedIndirectArgs');
    });

    test('$node._indirectOwner points back to the IndirectStorageBufferAttribute', () => {
        const buf = new IndirectStorageBufferAttribute(true, undefined, { computeWritable: true });
        const inst = buf.asStorageNode(DrawIndexedIndirectArgsStruct);
        expect((inst.$node as StorageNode<string>)._indirectOwner).toBe(buf);
    });
});

// ---------------------------------------------------------------------------
// 10. _cachedStorageNode lifecycle
// ---------------------------------------------------------------------------

describe('_cachedStorageNode', () => {
    test('returns null before any asStorageNode call', () => {
        const buf = new IndirectStorageBufferAttribute(true, undefined, { computeWritable: true });
        expect(buf._cachedStorageNode).toBeNull();
    });

    test('returns flat node after flat asStorageNode()', () => {
        const buf = new IndirectStorageBufferAttribute(true, undefined, { computeWritable: true });
        const node = buf.asStorageNode();
        expect(buf._cachedStorageNode).toBe(node);
    });

    test('returns struct node (preferred over flat) after asStorageNode(structDef)', () => {
        const buf = new IndirectStorageBufferAttribute(true, undefined, { computeWritable: true });
        buf.asStorageNode(); // create flat node first
        const inst = buf.asStorageNode(DrawIndexedIndirectArgsStruct);
        // struct node takes priority
        expect(buf._cachedStorageNode).toBe(inst.$node);
    });
});

// ---------------------------------------------------------------------------
// 11. compileCompute smoke — struct-typed binding
// ---------------------------------------------------------------------------

describe('compileCompute with struct-typed indirect storage', () => {
    test('struct declaration emitted in WGSL output when node is used in body', () => {
        const buf = new IndirectStorageBufferAttribute(true, undefined, { computeWritable: true });
        const argsNode = buf.asStorageNode(DrawIndexedIndirectArgsStruct);
        const storageNode = argsNode.$node as StorageNode<string>;

        const node = compute({
            dispatch: [1],
            storage: [storageNode],
            body: () => {
                const _count = toVar(argsNode.instanceCount, 'count');
                void _count;
            },
        });

        const result = compileCompute(node);

        expect(result.code).toContain('struct DrawIndexedIndirectArgs {');
        expect(result.code).toContain('indexCount');
        expect(result.code).toContain('instanceCount');
        expect(result.code).toContain('firstIndex');
        expect(result.code).toContain('baseVertex');
        expect(result.code).toContain('firstInstance');
    });

    test('storage binding uses struct name not array<u32>', () => {
        const buf = new IndirectStorageBufferAttribute(true, undefined, { computeWritable: true });
        const argsNode = buf.asStorageNode(DrawIndexedIndirectArgsStruct);
        const storageNode = argsNode.$node as StorageNode<string>;

        const node = compute({
            dispatch: [1],
            storage: [storageNode],
            body: () => {},
        });

        const result = compileCompute(node);

        expect(result.code).toContain('var<storage, read_write> _cs0 : DrawIndexedIndirectArgs');
        expect(result.code).not.toContain('array<u32>');
    });

    test('struct declaration appears before the @compute entry point', () => {
        const buf = new IndirectStorageBufferAttribute(true, undefined, { computeWritable: true });
        const argsNode = buf.asStorageNode(DrawIndexedIndirectArgsStruct);
        const storageNode = argsNode.$node as StorageNode<string>;

        const node = compute({
            dispatch: [1],
            storage: [storageNode],
            body: () => {
                const _n = toVar(argsNode.indexCount, 'n');
                void _n;
            },
        });

        const result = compileCompute(node);

        const structPos  = result.code.indexOf('struct DrawIndexedIndirectArgs {');
        const computePos = result.code.indexOf('@compute');
        expect(structPos).toBeGreaterThanOrEqual(0);
        expect(structPos).toBeLessThan(computePos);
    });

    test('result.storage entry has correct type and binding', () => {
        const buf = new IndirectStorageBufferAttribute(true, undefined, { computeWritable: true });
        const argsNode = buf.asStorageNode(DrawIndexedIndirectArgsStruct);
        const storageNode = argsNode.$node as StorageNode<string>;

        const node = compute({
            dispatch: [1],
            storage: [storageNode],
            body: () => {},
        });

        const result = compileCompute(node);

        expect(result.storage).toHaveLength(1);
        expect(result.storage[0].type).toBe('DrawIndexedIndirectArgs');
        expect(result.storage[0].binding).toBe(0);
        expect(result.storage[0].access).toBe('read_write');
    });

    test('field access in body emits correct dot-notation in WGSL', () => {
        const buf = new IndirectStorageBufferAttribute(true, undefined, { computeWritable: true });
        const argsNode = buf.asStorageNode(DrawIndexedIndirectArgsStruct);
        const storageNode = argsNode.$node as StorageNode<string>;

        const node = compute({
            dispatch: [1],
            storage: [storageNode],
            body: () => {
                argsNode.instanceCount.assign(u32(42));
            },
        });

        const result = compileCompute(node);

        expect(result.code).toContain('instanceCount');
        expect(result.code).toContain('_cs0');
    });
});

// ---------------------------------------------------------------------------
// 12. compileCompute smoke — flat array<u32>
// ---------------------------------------------------------------------------

describe('compileCompute with flat array<u32> indirect storage', () => {
    test('flat binding emits array<u32> and no struct declaration for the indirect layout', () => {
        const buf = new IndirectStorageBufferAttribute(true, undefined, { computeWritable: true });
        const storageNode = buf.asStorageNode();

        const node = compute({
            dispatch: [1],
            storage: [storageNode],
            body: () => {},
        });

        const result = compileCompute(node);

        expect(result.code).toContain('var<storage, read_write> _cs0 : array<u32>');
        expect(result.code).not.toContain('struct DrawIndexedIndirectArgs {');
    });

    test('result.storage entry has type array<u32>', () => {
        const buf = new IndirectStorageBufferAttribute(true, undefined, { computeWritable: true });
        const storageNode = buf.asStorageNode();

        const node = compute({
            dispatch: [1],
            storage: [storageNode],
            body: () => {},
        });

        const result = compileCompute(node);

        expect(result.storage).toHaveLength(1);
        expect(result.storage[0].type).toBe('array<u32>');
    });
});
