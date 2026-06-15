import { test, expect } from 'vitest';
import {
    d, createStorageBuffer, storage, struct, Fn, globalId, Var, Loop, index,
    normalize, dot, max, f32, vec3, compileCompute,
} from '../src/index';

// Regression: a storage buffer read only inside a helper Fn (not the main body)
// must still resolve its binding name. emitDslFunctions previously did not copy
// `storageNames` into the per-function context, so the index expression emitted
// `undefined[...]` and the shader failed to compile.
test('storage read inside a helper Fn resolves its binding name', () => {
    const Light = struct('Light', { position: d.vec3f, color: d.vec3f });
    const lights = storage(createStorageBuffer(d.array(Light), new Float32Array(8 * 8)), 'read');
    const out = storage(createStorageBuffer(d.array(d.vec3f), new Float32Array(64 * 4)), 'read_write');

    // a helper that loops over the light buffer
    const sumLights = Fn(
        (p) => {
            const acc = Var('acc', vec3(0, 0, 0));
            Loop(4, ({ i }) => {
                const l = lights.element(i).fields();
                const ndotl = max(dot(normalize(l.position.sub(p)), vec3(0, 1, 0)), f32(0));
                acc.addAssign(l.color.mul(ndotl));
            });
            return acc;
        },
        { name: 'sumLights', params: [{ name: 'p', type: d.vec3f }], return: d.vec3f },
    );

    const kernel = Fn(() => {
        const i = globalId.x;
        index(out, i).assign(sumLights(vec3(0, 0, 0)));
    }).compute({ workgroupSize: [64, 1, 1] });

    const wgsl = compileCompute(kernel).code;
    expect(wgsl).toContain('fn sumLights(');
    // the binding must be named, not `undefined[...]`
    expect(wgsl).not.toContain('undefined[');
});
