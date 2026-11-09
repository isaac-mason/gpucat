import { describe, expect, test } from 'vitest';
import {
    attribute,
    compileComputeWgsl,
    compileGlsl,
    createStorageBuffer,
    DepthTexture,
    d,
    depthTexture,
    Fn,
    f32,
    i32,
    storage,
    textureGather,
    u32,
    vec2f,
    vec2i,
    vec4f,
} from '../src/index';

/** a compute shader writing `gathered` out, so it is kept, compiled to WGSL */
function gatherWgsl(gathered: () => ReturnType<typeof textureGather>): string {
    const out = storage(createStorageBuffer(d.array(d.vec4f), new Float32Array(4)), 'read_write');
    const kernel = Fn(() => {
        out.element(u32(0)).assign(gathered());
    }).compute({ workgroupSize: [1, 1, 1] });
    return compileComputeWgsl(kernel).code;
}

describe('textureGather on a depth texture', () => {
    test('takes no component: the texture comes first, and four depths come back', () => {
        const depth = depthTexture(new DepthTexture(8, 8));
        const gathered = textureGather(depth.bindingNode, depth.samplerNode!, vec2f(f32(0.5), f32(0.5)));
        expect(gathered.type).toBe(d.vec4f);
        const wgsl = gatherWgsl(() => gathered);
        expect(wgsl).toMatch(/: texture_depth_2d;/);
        expect(wgsl).toMatch(/textureGather\(\w+, \w+, vec2f\(0\.5f, 0\.5f\)\)/);
    });

    test('passes an offset through', () => {
        const depth = depthTexture(new DepthTexture(8, 8));
        const wgsl = gatherWgsl(() =>
            textureGather(depth.bindingNode, depth.samplerNode!, vec2f(f32(0.5), f32(0.5)), vec2i(i32(1), i32(0))),
        );
        expect(wgsl).toMatch(/textureGather\(\w+, \w+, vec2f\(0\.5f, 0\.5f\), vec2i\(1i?, 0i?\)\)/);
    });

    test('takes the layer after the coords on a depth array texture', () => {
        const depth = depthTexture(new DepthTexture(8, 8, 'depth24plus', 2));
        const wgsl = gatherWgsl(() => textureGather(depth.bindingNode, depth.samplerNode!, vec2f(f32(0.5), f32(0.5)), i32(1)));
        expect(wgsl).toMatch(/: texture_depth_2d_array;/);
        expect(wgsl).toMatch(/textureGather\(\w+, \w+, vec2f\(0\.5f, 0\.5f\), 1i\)/);
    });

    test('is rejected on WebGL2, as every gather is, naming the backend', () => {
        const depth = depthTexture(new DepthTexture(8, 8));
        const clip = vec4f(attribute('position', d.vec3f), f32(1));
        const fragment = textureGather(depth.bindingNode, depth.samplerNode!, vec2f(f32(0.5), f32(0.5)));
        expect(() => compileGlsl({ vertex: clip, fragment, depth: undefined })).toThrow(
            /textureGather is a GLSL ES 3\.10 builtin with no GLSL ES 3\.00 form; not supported on the WebGL2 backend/,
        );
    });
});
