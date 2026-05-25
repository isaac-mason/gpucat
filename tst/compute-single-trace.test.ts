// Regression: compileCompute used to call fn.trace() twice — once for the
// discovery pass and again inside generateComputeShader. Each trace re-runs
// the user's callback, so any `storage(...)` / `uniform(...)` / etc. node
// created inside Fn() was a fresh instance with a new id on the second trace.
//
// Symptom: storageNames was keyed by trace-#1 ids; code emission looked up
// trace-#2 ids → got `undefined` → emitted literal `undefined[...]` in the
// shader plus a phantom `var<storage> undefined: ...` binding line.
//
// Fix: trace once in compileCompute, pass the traced result into
// generateComputeShader.

import { describe, expect, test } from 'vitest';
import { Fn, compileCompute, globalId, index, storage, struct } from '../src/index';
import * as d from '../src/schema/schema';

describe('compileCompute — single-trace invariant', () => {
    test('name-based storage bindings emit with consistent names across declarations and body refs', () => {
        const Entry = struct('Entry', { value: d.u32 });

        const fn = Fn(() => {
            const slot = globalId.x.toVar('slot');
            const table = storage('table', d.array(Entry), 'read');
            const out = storage('out', d.array(d.u32), 'read_write');
            const planes = storage('planes', d.sizedArray(d.vec4f, 6), 'read');

            const entry = index(table, slot).toVar('entry');
            const v = entry.field('value').toVar('v');
            const plane0 = planes.element(slot).toVar('plane0');
            index(out, slot).assign(v.add(plane0.x.toU32()));
        });

        const result = compileCompute(fn.compute({ workgroupSize: [64, 1, 1] }));

        // no phantom binding and no undefined refs in body
        expect(result.code).not.toContain('undefined');

        // every name-based storage gets a `_storageN` binding + at least one body reference
        const storageDecls = [...result.code.matchAll(/var<storage,[^>]+>\s+(_storage\d+):/g)].map((m) => m[1]);
        expect(storageDecls.length).toBe(3);
        for (const name of storageDecls) {
            // each declared storage must be referenced somewhere outside the binding line itself
            const bodyRefs = result.code.split('\n').filter((l) => l.includes(name) && !l.includes('var<storage')).length;
            expect(bodyRefs, `expected body refs for ${name}`).toBeGreaterThan(0);
        }
    });

    test('storage created inside Fn() retains identity between discovery and code emission', () => {
        // tighter check: every storage that appears in the body should be in the bindings
        // section (catches a regression where one is registered but the other isn't).
        const fn = Fn(() => {
            const a = storage('a', d.array(d.u32), 'read');
            const b = storage('b', d.array(d.u32), 'read_write');
            const slot = globalId.x.toVar('slot');
            index(b, slot).assign(index(a, slot));
        });

        const result = compileCompute(fn.compute({ workgroupSize: [64, 1, 1] }));
        const [bindings, body] = result.code.split('// Compute Shader');

        const declared = new Set(
            [...bindings.matchAll(/var<storage,[^>]+>\s+(\w+):/g)].map((m) => m[1]),
        );
        const referenced = new Set(
            [...body.matchAll(/\b(_storage\d+)\b/g)].map((m) => m[1]),
        );

        for (const ref of referenced) {
            expect(declared.has(ref), `body refs ${ref} but bindings only has [${[...declared].join(', ')}]`).toBe(true);
        }
    });
});
