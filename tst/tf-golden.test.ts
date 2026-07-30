import { describe, expect, test } from 'vitest';
import {
    compileTransformFeedback,
    createStorageTexture,
    d,
    f32,
    GpuSampler,
    i32,
    struct,
    texture,
    transformFeedback,
    vec2i,
    vertexIndex,
} from '../src/index';

/**
 * Golden GLSL regression net for the transform-feedback compile path (Phase 1 of
 * llm/webgl-transform-feedback-plan.md).
 *
 * compileTransformFeedback() reuses the SAME neutral discover() output + node graph + GLSL emitter as
 * compileGlsl(), producing a linkable transform-feedback vertex program (attribute-in / captured-
 * varying-out) plus a no-op fragment shader. This pins the emitted vertex+fragment GLSL, the ordered
 * feedbackVaryings, and the input-attribute layout. Real GL link correctness is checked by
 * `npm run test:glsl` (gate #2); these snapshots guard the emitter against regressions.
 *
 * Node ids are module-global and monotonic, so snapshots are stable only while this file's node-
 * creation sequence is unchanged.
 */

function tfShape(r: ReturnType<typeof compileTransformFeedback>) {
    return {
        vertexCode: r.vertexCode,
        fragmentCode: r.fragmentCode,
        feedbackVaryings: r.feedbackVaryings,
        inputAttributes: r.inputAttributes,
        builtins: Array.from(r.builtinsUsed).sort(),
    };
}

describe('transform-feedback GLSL compile', () => {
    test('particles: pos.add(vel) → captured v_pos', () => {
        const kernel = transformFeedback((io) => ({ pos: io.pos.add(io.vel) }), {
            inputs: { pos: d.vec4f, vel: d.vec4f },
            outputs: { pos: d.vec4f },
            name: 'particles',
        });

        expect(tfShape(compileTransformFeedback(kernel))).toMatchSnapshot();
    });

    test('neighbour: textureLoad gather in a TF kernel', () => {
        const data = createStorageTexture(1024, 1, 'rgba32float');
        const sampler = new GpuSampler({});
        const kernel = transformFeedback(
            (io) => {
                const i = vertexIndex.toI32();
                const neighbour = texture(data, sampler).load(vec2i(i.add(i32(1)), i32(0)), i32(0));
                return { pos: io.pos.add(neighbour.mul(f32(0.5))) };
            },
            {
                inputs: { pos: d.vec4f },
                outputs: { pos: d.vec4f },
                name: 'neighbour',
            },
        );

        expect(tfShape(compileTransformFeedback(kernel))).toMatchSnapshot();
    });

    test('rejects a vec3 output naming the fix', () => {
        const kernel = transformFeedback((io) => ({ pos: io.pos.xyz }), {
            inputs: { pos: d.vec4f },
            outputs: { pos: d.vec3f },
        });
        expect(() => compileTransformFeedback(kernel)).toThrow(/vec3.*use vec4f/s);
    });

    test('rejects more than 4 outputs', () => {
        const kernel = transformFeedback((io) => ({ a: io.p, b: io.p, c: io.p, d: io.p, e: io.p }), {
            inputs: { p: d.vec4f },
            outputs: { a: d.vec4f, b: d.vec4f, c: d.vec4f, d: d.vec4f, e: d.vec4f },
        });
        expect(() => compileTransformFeedback(kernel)).toThrow(/at most 4 outputs/);
    });

    test('rejects a struct output', () => {
        const Particle = struct('Particle', { pos: d.vec4f, vel: d.vec4f });
        const kernel = transformFeedback(
            (io) => ({ out: Particle.construct({ pos: io.pos, vel: io.vel }) }),
            {
                inputs: { pos: d.vec4f, vel: d.vec4f },
                outputs: { out: Particle },
            },
        );
        expect(() => compileTransformFeedback(kernel)).toThrow(/struct.*separate/s);
    });

    // Sanity: the dummy gl_Position and no-op fragment are present so the program can link.
    test('emits dummy gl_Position + no-op fragment', () => {
        const kernel = transformFeedback((io) => ({ pos: io.pos }), {
            inputs: { pos: d.vec4f },
            outputs: { pos: d.vec4f },
        });
        const r = compileTransformFeedback(kernel);
        expect(r.vertexCode).toContain('gl_Position = vec4(0.0);');
        expect(r.fragmentCode).toContain('void main() {}');
        expect(r.feedbackVaryings).toEqual(['v_pos']);
    });
});
