import { describe, expect, test } from 'vitest';
import { attribute, compileGlsl, d, f32, instanceIndex, storage, struct, varying, vec4 } from '../src/index';

// Regression: the WebGL2 storage() read-lowering reinterprets a read-only buffer as an rgba32uint mirror
// texture and decodes fields via `decodeField`. Two shapes used to fail:
//   (a) a struct-typed field (`inst.field('params')`, nested struct) → `field type '…' not supported`;
//   (b) a whole struct element materialized to a var (`inst.toVar()`) → a bare `StorageNode` reaching the
//       emitter's unsupported guard.
// Both now decode to a struct constructor. Per-instance reads live in the vertex stage (gl_InstanceID is
// vertex-only) and hand a leaf out via a varying, mirroring makecat's model/sprite materials. These check
// emission doesn't throw; tst/glsl-compile compiles+links the same shapes on real ANGLE.

const Params = struct('NsParams', { uvOffset: d.vec2f, uvScale: d.vec2f, tint: d.vec4f });
const Instance = struct('NsInstance', { worldMatrix: d.mat4x4f, params: Params });

describe('storage() nested-struct read lowering (WebGL/GLSL)', () => {
    test('nested struct field: element(i).field(params).field(tint)', () => {
        const slotMap = storage('slotMap', d.array(d.u32), 'read');
        const instanceData = storage('instanceData', d.array(Instance), 'read');
        const inst = instanceData.element(slotMap.element(instanceIndex));
        const clip = inst.field('worldMatrix').mul(vec4(attribute('position', d.vec3f), f32(1)));
        const fragment = varying(inst.field('params').field('tint'), 'vTint');
        expect(() => compileGlsl({ vertex: clip, fragment, depth: undefined })).not.toThrow();
    });

    test('whole struct element to var: element(i).toVar() then fields', () => {
        const slotMap = storage('slotMap', d.array(d.u32), 'read');
        const instanceData = storage('instanceData', d.array(Instance), 'read');
        const inst = instanceData.element(slotMap.element(instanceIndex)).toVar('inst');
        const clip = inst.field('worldMatrix').mul(vec4(attribute('position', d.vec3f), f32(1)));
        const fragment = varying(inst.field('params').field('tint'), 'vTint');
        const glsl = compileGlsl({ vertex: clip, fragment, depth: undefined });
        // the whole struct decodes into a struct constructor assigned to the GLSL local
        expect(glsl.code).toContain('NsInstance(');
    });
});
