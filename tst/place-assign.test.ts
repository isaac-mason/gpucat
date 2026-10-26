import { expect, test } from 'vitest';
import {
    attribute,
    compileComputeWgsl,
    compileGlsl,
    createStorageBuffer,
    d,
    Fn,
    f32,
    localId,
    storage,
    u32,
    vec4f,
    WorkgroupVar,
    workgroupBarrier,
} from '../src/index';

// Regression: `element(i).addAssign(x)` uses the element twice, as the target and in the sum. Shared through a CSE
// temp, the write landed in the temp (`var _elem = sums[i]; _elem = _elem + x;`) and never reached the array.

test('a compound assign to a workgroup array element writes the array', () => {
    const out = storage(createStorageBuffer(d.array(d.u32), new Uint32Array(64)), 'read_write');
    const sums = WorkgroupVar('sums', d.sizedArray(d.u32, 64));
    const kernel = Fn(() => {
        const lane = localId.x.toVar('lane');
        const element = sums.element(lane);
        element.assign(lane);
        workgroupBarrier();
        element.addAssign(u32(1));
        workgroupBarrier();
        out.element(lane).assign(element);
    }).compute({ workgroupSize: [64, 1, 1] });

    const wgsl = compileComputeWgsl(kernel).code;
    expect(wgsl).toMatch(/sums\[lane\] = sums\[lane\] \+ 1u;/);
    // read again after the barrier, not out of a temp taken before it
    expect(wgsl).toMatch(/\[lane\] = sums\[lane\];/);
    expect(wgsl).not.toMatch(/var _\w+ = sums\[/);
});

test('a compound assign to a field of a local variable writes the variable', () => {
    const position = attribute('position', d.vec3f);
    const clip = vec4f(position, f32(1));
    const shade = Fn(
        () => {
            const colour = vec4f(f32(0), f32(0), f32(0), f32(1)).toVar('colour');
            colour.x.addAssign(f32(0.5));
            colour.x.addAssign(f32(0.25));
            return colour;
        },
        { name: 'shade', params: [] as const, return: d.vec4f },
    );

    const glsl = compileGlsl({ vertex: clip, fragment: shade(), depth: undefined }).code;
    expect(glsl).toMatch(/colour\.x = colour\.x \+ 0\.5;/);
    expect(glsl).toMatch(/colour\.x = colour\.x \+ 0\.25;/);
});
