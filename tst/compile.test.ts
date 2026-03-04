/**
 * Smoke tests for src/nodes/compile.ts
 *
 * Covers:
 *  1. Constant color + default position graph → valid WGSL emitted
 *  2. Attribute nodes appear in VertexInput struct and result.attributes
 *  3. Builtin nodes (camera, mesh, instance_index) → correct binding declarations
 *  4. Camera / Time / Mesh struct declarations emitted before entry points
 *  5. Varying declared in vertex graph → assigned in vs_main, readable in fs_main
 *  6. Material uniform node → MaterialUniforms struct + binding emitted
 *  7. Texture + sampler nodes → correct @group(1) bindings
 *  8. result.attributes, .varyings, .uniforms, .storage, .textures, .samplers populated
 *  9. positionClip from std-nodes.ts compiles correctly
 * 10. negate call emits as (-expr)
 * 11. Fn node emits user function declaration
 * 12. InstancedBufferAttributeNode appears in VertexInput + result.attributes
 * 13. Nested struct — inner declared before outer in WGSL output
 * 14. Nested struct — field access on nested struct member compiles correctly
 * 15. Deeply nested (A → B → C) — correct declaration order A, B, C in output
 * 16. Stage validation — attribute in fragment graph throws
 * 17. Stage validation — instancedBufferAttribute in fragment graph throws
 */

import { describe, expect, test } from 'vitest';
import { compile } from '../src/nodes/compile.js';
import {
    attribute,
    Fn,
    instancedBufferAttribute,
    konst,
    mat4,
    sampler,
    texture,
    textureSample,
    uniform,
    varying,
    vec4,
} from '../src/nodes/nodes.js';
import * as S from '../src/nodes/schema.js';
import { defineStruct } from '../src/nodes/schema.js';
import { camera, positionClip, instanceIndex, mesh } from '../src/nodes/std-nodes.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Compile with positionClip as position. */
function compileColor(colorNode: ReturnType<typeof konst>) {
    return compile({ position: positionClip, color: colorNode });
}

// ---------------------------------------------------------------------------
// 1. Constant color smoke test
// ---------------------------------------------------------------------------

describe('constant color + positionClip', () => {
    test('produces a non-empty WGSL string', () => {
        const result = compileColor(konst('vec4f', [1, 0.5, 0.1, 1]));
        expect(typeof result.code).toBe('string');
        expect(result.code.length).toBeGreaterThan(0);
    });

    test('contains @vertex and @fragment entry points', () => {
        const result = compileColor(konst('vec4f', [1, 0, 0, 1]));
        expect(result.code).toContain('@vertex');
        expect(result.code).toContain('fn vs_main(');
        expect(result.code).toContain('@fragment');
        expect(result.code).toContain('fn fs_main(');
    });

    test('VertexOutput has @builtin(position)', () => {
        const result = compileColor(konst('vec4f', [1, 0, 0, 1]));
        expect(result.code).toContain('@builtin(position) position : vec4f');
    });

    test('fs_main returns @location(0) vec4f', () => {
        const result = compileColor(konst('vec4f', [1, 0, 0, 1]));
        expect(result.code).toContain('-> @location(0) vec4f');
    });
});

// ---------------------------------------------------------------------------
// 2. Attributes → VertexInput struct + result.attributes
// ---------------------------------------------------------------------------

describe('attribute nodes', () => {
    test('attribute in position graph appears in VertexInput struct', () => {
        // positionClip uses attribute('vec3f', 'position')
        const result = compileColor(konst('vec4f', [1, 1, 1, 1]));
        expect(result.code).toContain('struct VertexInput {');
        expect(result.code).toContain('@location(0) position : vec3f');
    });

    test('result.attributes contains the position attribute with kind:geometry', () => {
        const result = compileColor(konst('vec4f', [1, 1, 1, 1]));
        const posAttr = result.attributes.find((a) => a.name === 'position');
        expect(posAttr).toBeDefined();
        expect(posAttr!.kind).toBe('geometry');
        expect(posAttr!.type).toBe('vec3f');
        expect(posAttr!.location).toBe(0);
    });

    test('custom attribute bridged via varying appears in result.attributes', () => {
        const uv = attribute('vec2f', 'uv');
        // uv is vertex-only; bridge it to the fragment stage via a varying
        const vUv = varying('vec2f', 'vUv', uv);
        const pos = attribute('vec3f', 'position');
        const localPos = vec4(pos, konst('f32', 1.0));
        const color = vec4(vUv, konst('f32', 1.0));
        const result = compile({
            position: localPos as ReturnType<typeof konst>,
            color: color as ReturnType<typeof konst>,
        });
        const uvAttr = result.attributes.find((a) => a.name === 'uv');
        expect(uvAttr).toBeDefined();
        expect(uvAttr!.kind).toBe('geometry');
        expect(uvAttr!.type).toBe('vec2f');
    });
});

// ---------------------------------------------------------------------------
// 3. Builtin bindings
// ---------------------------------------------------------------------------

describe('builtin binding declarations', () => {
    test('camera builtin → @group(0) @binding(0) uniform', () => {
        const result = compileColor(konst('vec4f', [1, 1, 1, 1]));
        expect(result.code).toContain('@group(0) @binding(0) var<uniform> camera : Camera;');
    });

    test('Mesh UBO always emitted at @group(1) @binding(0)', () => {
        const result = compileColor(konst('vec4f', [1, 1, 1, 1]));
        expect(result.code).toContain('@group(1) @binding(0) var<uniform> mesh : Mesh;');
    });

    test('instance_index → @builtin(instance_index) in VertexInput', () => {
        // Build a simple graph that uses instanceIndex directly
        const iIdx = instanceIndex();
        const pos = attribute('vec3f', 'position');
        const localPos = vec4(pos, konst('f32', 1.0));
        // Use iIdx somewhere in color to pull it into the graph
        const result = compile({
            position: localPos as ReturnType<typeof konst>,
            color: konst('vec4f', [1, 0, 0, 1]),
        });
        // instance_index only appears in VertexInput if it's referenced from the vertex graph
        // (it's in localPos which uses position attr — instance_index itself isn't referenced here)
        // Use it explicitly:
        const r2 = compile({
            position: vec4(
                pos,
                iIdx as unknown as ReturnType<typeof konst>,
            ) as ReturnType<typeof konst>,
            color: konst('vec4f', [1, 0, 0, 1]),
        });
        expect(r2.code).toContain('@builtin(instance_index) instance_index : u32');
    });

    test('explicit mesh() node in graph causes Mesh struct to appear', () => {
        const m = mesh();
        const pos = attribute('vec3f', 'position');
        const localPos = vec4(pos, konst('f32', 1.0));
        const worldPos = m.modelMatrix.mul(localPos);
        const cam = camera();
        const clipPos = cam.projectionMatrix.mul(cam.viewMatrix.mul(worldPos));
        const result = compile({
            position: clipPos as ReturnType<typeof konst>,
            color: konst('vec4f', [1, 0, 0, 1]),
        });
        expect(result.code).toContain('struct Mesh {');
        expect(result.code).toContain('modelMatrix : mat4x4f');
        expect(result.code).toContain('@group(1) @binding(0) var<uniform> mesh : Mesh;');
    });

    test('result.storage is empty (no instanceMatrices storage buffer)', () => {
        const result = compileColor(konst('vec4f', [1, 1, 1, 1]));
        expect(result.storage).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// 4. Struct declarations (Camera, Time, Mesh) emitted before entry points
// ---------------------------------------------------------------------------

describe('struct declarations', () => {
    test('Camera struct emitted before @vertex', () => {
        const result = compileColor(konst('vec4f', [1, 1, 1, 1]));
        const cameraStructIdx = result.code.indexOf('struct Camera {');
        const vertexIdx = result.code.indexOf('@vertex');
        expect(cameraStructIdx).toBeGreaterThanOrEqual(0);
        expect(cameraStructIdx).toBeLessThan(vertexIdx);
    });

    test('Camera struct contains expected fields', () => {
        const result = compileColor(konst('vec4f', [1, 1, 1, 1]));
        expect(result.code).toContain('projectionMatrix : mat4x4f');
        expect(result.code).toContain('viewMatrix : mat4x4f');
        expect(result.code).toContain('position : vec3f');
    });

    test('Mesh struct emitted before @vertex', () => {
        const result = compileColor(konst('vec4f', [1, 1, 1, 1]));
        const meshStructIdx = result.code.indexOf('struct Mesh {');
        const vertexIdx = result.code.indexOf('@vertex');
        expect(meshStructIdx).toBeGreaterThanOrEqual(0);
        expect(meshStructIdx).toBeLessThan(vertexIdx);
    });
});

// ---------------------------------------------------------------------------
// 5. Varyings bridge vertex → fragment
// ---------------------------------------------------------------------------

describe('varyings', () => {
    test('varying source assigned in vs_main and read in fs_main', () => {
        const pos = attribute('vec3f', 'position');
        const localPos = vec4(pos, konst('f32', 1.0));
        const vColor = varying('vec3f', 'vColor', pos);
        const result = compile({
            position: localPos as ReturnType<typeof konst>,
            color: vec4(vColor, konst('f32', 1.0)) as ReturnType<typeof konst>,
        });
        // Vertex stage assigns the varying
        expect(result.code).toContain('out.vColor =');
        // Fragment input struct has the varying
        expect(result.code).toContain('struct FragmentInput {');
        expect(result.code).toContain('vColor : vec3f');
        // Fragment stage reads it
        expect(result.code).toContain('in.vColor');
    });

    test('result.varyings populated correctly', () => {
        const pos = attribute('vec3f', 'position');
        const localPos = vec4(pos, konst('f32', 1.0));
        const vColor = varying('vec3f', 'vColor', pos);
        const result = compile({
            position: localPos as ReturnType<typeof konst>,
            color: vec4(vColor, konst('f32', 1.0)) as ReturnType<typeof konst>,
        });
        expect(result.varyings).toHaveLength(1);
        expect(result.varyings[0].name).toBe('vColor');
        expect(result.varyings[0].type).toBe('vec3f');
        expect(result.varyings[0].location).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// 6. Material uniform → MaterialUniforms struct + binding
// ---------------------------------------------------------------------------

describe('material uniforms', () => {
    test('uniform node generates MaterialUniforms struct', () => {
        const u = uniform('vec4f', 'baseColor', { group: 'material' });
        const result = compile({
            position: positionClip,
            color: u as ReturnType<typeof konst>,
        });
        expect(result.code).toContain('struct MaterialUniforms {');
        expect(result.code).toContain('baseColor : vec4f');
        expect(result.code).toContain('var<uniform> materialUniforms : MaterialUniforms;');
    });

    test('material uniform gets @group(1) binding starting at 1', () => {
        const u = uniform('vec4f', 'baseColor', { group: 'material' });
        const result = compile({
            position: positionClip,
            color: u as ReturnType<typeof konst>,
        });
        expect(result.code).toContain('@group(1) @binding(1)');
    });

    test('result.uniforms populated correctly', () => {
        const u = uniform('f32', 'roughness', { group: 'material' });
        const result = compile({
            position: positionClip,
            color: konst('vec4f', [1, 1, 1, 1]),
        });
        // Uniform not reachable from color/position → not collected
        expect(result.uniforms).toHaveLength(0);

        // Now use it
        const result2 = compile({
            position: positionClip,
            color: vec4(
                konst('vec3f', [1, 1, 1]),
                u,
            ) as ReturnType<typeof konst>,
        });
        expect(result2.uniforms).toHaveLength(1);
        expect(result2.uniforms[0].members[0].uniformId).toBe('roughness');
        expect(result2.uniforms[0].group).toBe(1);
        expect(result2.uniforms[0].binding).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// 7. Texture + sampler nodes
// ---------------------------------------------------------------------------

describe('texture and sampler nodes', () => {
    test('texture and sampler get consecutive @group(1) bindings starting at 1', () => {
        const albedoTex = texture('texture_2d<f32>', 'albedo');
        const albedoSamp = sampler('albedo');
        const uv = attribute('vec2f', 'uv');
        // uv is vertex-only; bridge to fragment via a varying
        const pos = attribute('vec3f', 'position');
        const localPos = vec4(pos, konst('f32', 1.0));
        const vUv = varying('vec2f', 'vUv', uv);
        const sample = textureSample(albedoTex, albedoSamp, vUv);
        const result = compile({
            position: localPos as ReturnType<typeof konst>,
            color: sample as ReturnType<typeof konst>,
        });
        expect(result.code).toContain('@group(1) @binding(1) var albedo_tex : texture_2d<f32>');
        expect(result.code).toContain('@group(1) @binding(2) var albedo_samp : sampler');
    });

    test('result.textures and result.samplers populated', () => {
        const albedoTex = texture('texture_2d<f32>', 'albedo');
        const albedoSamp = sampler('albedo');
        const uv = attribute('vec2f', 'uv');
        const pos = attribute('vec3f', 'position');
        const localPos = vec4(pos, konst('f32', 1.0));
        const vUv = varying('vec2f', 'vUv', uv);
        const sample = textureSample(albedoTex, albedoSamp, vUv);
        const result = compile({
            position: localPos as ReturnType<typeof konst>,
            color: sample as ReturnType<typeof konst>,
        });
        expect(result.textures).toHaveLength(1);
        expect(result.textures[0].textureId).toBe('albedo');
        expect(result.textures[0].group).toBe(1);
        expect(result.textures[0].binding).toBe(1);

        expect(result.samplers).toHaveLength(1);
        expect(result.samplers[0].samplerId).toBe('albedo');
        expect(result.samplers[0].group).toBe(1);
        expect(result.samplers[0].binding).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// 8. positionClip compiles correctly (end-to-end)
// ---------------------------------------------------------------------------

describe('defaultPositionGraph', () => {
    test('compiles without error', () => {
        expect(() => compileColor(konst('vec4f', [0.2, 0.4, 0.8, 1]))).not.toThrow();
    });

    test('result code contains MVP transform calls via mesh.modelMatrix', () => {
        const result = compileColor(konst('vec4f', [0.2, 0.4, 0.8, 1]));
        expect(result.code).toContain('camera.projectionMatrix');
        expect(result.code).toContain('camera.viewMatrix');
        expect(result.code).toContain('mesh.modelMatrix');
    });

    test('result.attributes has only position (vec3f) with kind:geometry', () => {
        const result = compileColor(konst('vec4f', [0.2, 0.4, 0.8, 1]));
        expect(result.attributes).toHaveLength(1);
        expect(result.attributes[0].kind).toBe('geometry');
        expect(result.attributes[0].name).toBe('position');
        expect(result.attributes[0].type).toBe('vec3f');
    });

    test('result.varyings is empty', () => {
        const result = compileColor(konst('vec4f', [0.2, 0.4, 0.8, 1]));
        expect(result.varyings).toHaveLength(0);
    });

    test('result.storage is empty (no instance matrices storage buffer)', () => {
        const result = compileColor(konst('vec4f', [0.2, 0.4, 0.8, 1]));
        expect(result.storage).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// 9. negate emits as (-expr)
// ---------------------------------------------------------------------------

describe('negate', () => {
    test('negate call compiles to (-expr) not negate(expr)', () => {
        const x = attribute('f32', 'x');
        // x is vertex-only; bridge via a varying so it can be used in the fragment graph
        const vX = varying('f32', 'vX', x);
        const neg = vX.negate();
        const pos = attribute('vec3f', 'position');
        const localPos = vec4(pos, konst('f32', 1.0));
        const colorFromNeg = vec4(
            konst('vec3f', [1, 1, 1]),
            neg,
        );
        const r2 = compile({
            position: localPos as ReturnType<typeof konst>,
            color: colorFromNeg as ReturnType<typeof konst>,
        });
        expect(r2.code).toContain('(-');
        expect(r2.code).not.toContain('negate(');
    });
});

// ---------------------------------------------------------------------------
// 10. Fn node emits user function declaration
// ---------------------------------------------------------------------------

describe('Fn node', () => {
    test('Fn produces a named function in WGSL output', () => {
        const lerp = Fn([S.f32(), S.f32(), S.f32()], (a, b, t) => a.add(b.sub(a).mul(t)));
        const pos = attribute('vec3f', 'position');
        const localPos = vec4(pos, konst('f32', 1.0));
        const alpha = lerp(konst('f32', 0.0), konst('f32', 1.0), konst('f32', 0.5));
        const color = vec4(konst('vec3f', [1, 0.5, 0]), alpha);
        const result = compile({
            position: localPos as ReturnType<typeof konst>,
            color: color as ReturnType<typeof konst>,
        });
        // A user fn declaration should appear before vs_main
        const fnIdx = result.code.search(/^fn \w+\(p0/m);
        const vertexIdx = result.code.indexOf('@vertex');
        expect(fnIdx).toBeGreaterThanOrEqual(0);
        expect(fnIdx).toBeLessThan(vertexIdx);
        // Params should be p0, p1, p2 with type f32
        expect(result.code).toContain('p0 : f32');
        expect(result.code).toContain('p1 : f32');
        expect(result.code).toContain('p2 : f32');
    });
});

// ---------------------------------------------------------------------------
// 11. InstancedBufferAttributeNode in VertexInput + result.attributes
// ---------------------------------------------------------------------------

describe('InstancedBufferAttributeNode', () => {
    test('instancedBufferAttribute appears in VertexInput and result.attributes with kind:instanced', () => {
        const colors = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
        const instColor = instancedBufferAttribute(colors, 'vec3f', 12, 0);
        const pos = attribute('vec3f', 'position');
        const localPos = vec4(pos, konst('f32', 1.0));
        // instColor is vertex-only; bridge to fragment via a varying
        const vInstColor = varying('vec3f', 'vInstColor', instColor);
        const result = compile({
            position: localPos as ReturnType<typeof konst>,
            color: vec4(vInstColor, konst('f32', 1.0)) as ReturnType<typeof konst>,
        });
        // Should appear in VertexInput struct
        expect(result.code).toContain('struct VertexInput {');
        expect(result.code).toMatch(/@location\(\d+\) _inst\d+ : vec3f/);
        // result.attributes should contain it with kind: 'instanced'
        const instEntry = result.attributes.find((a) => a.kind === 'instanced');
        expect(instEntry).toBeDefined();
        expect(instEntry!.type).toBe('vec3f');
    });

    test('instancedBufferAttribute x4 + mat4() produces 4 instanced vec4f attrs and emits mat4x4f construct', () => {
        const matrices = new Float32Array(16); // 1 identity matrix
        matrices[0] = 1; matrices[5] = 1; matrices[10] = 1; matrices[15] = 1;
        const stride = 16 * 4;
        const col0 = instancedBufferAttribute(matrices, 'vec4f', stride, 0);
        const col1 = instancedBufferAttribute(matrices, 'vec4f', stride, 16);
        const col2 = instancedBufferAttribute(matrices, 'vec4f', stride, 32);
        const col3 = instancedBufferAttribute(matrices, 'vec4f', stride, 48);
        const instanceTransform = mat4(col0, col1, col2, col3);
        const pos = attribute('vec3f', 'position');
        const localPos = vec4(pos, konst('f32', 1.0));
        const worldPos = instanceTransform.mul(localPos);
        const result = compile({
            position: worldPos as ReturnType<typeof konst>,
            color: konst('vec4f', [1, 1, 1, 1]),
        });
        // Should have 4 instanced attributes (one per column)
        const instAttrs = result.attributes.filter((a) => a.kind === 'instanced');
        expect(instAttrs).toHaveLength(4);
        // VertexInput should have _inst0 through _inst3
        expect(result.code).toContain('_inst0');
        expect(result.code).toContain('_inst1');
        expect(result.code).toContain('_inst2');
        expect(result.code).toContain('_inst3');
    });
});

// ---------------------------------------------------------------------------
// 13–15. Nested struct declaration order
// ---------------------------------------------------------------------------

describe('nested struct support', () => {
    test('inner struct declared before outer struct in WGSL output', () => {
        const Inner = defineStruct('NestInner', { x: S.f32(), y: S.f32() });
        const Outer = defineStruct('NestOuter', { inner: S.struct(Inner), z: S.f32() });

        // Reference Outer via a material uniform so its StructNode enters the graph
        const outerUniform = uniform('NestOuter' as ReturnType<typeof S.f32>['wgslType'], 'nestOuterVal', 'material');
        const colorField = outerUniform.field('z', 'f32');
        const result = compile({
            position: positionClip,
            color: vec4(
                konst('vec3f', [0, 0, 0]),
                colorField as ReturnType<typeof konst>,
            ) as ReturnType<typeof konst>,
        });

        // Both struct declarations should appear
        expect(result.code).toContain('struct NestInner {');
        expect(result.code).toContain('struct NestOuter {');

        // Inner must be declared before Outer
        const innerPos = result.code.indexOf('struct NestInner {');
        const outerPos = result.code.indexOf('struct NestOuter {');
        expect(innerPos).toBeGreaterThanOrEqual(0);
        expect(outerPos).toBeGreaterThan(innerPos);
    });

    test('field access on nested struct member emits correct dot-chain', () => {
        const Inner = defineStruct('Inner2', { val: S.f32() });
        defineStruct('Outer2', { inner: S.struct(Inner), extra: S.f32() });

        // Use a uniform of type Outer2 and access .inner.val
        const outerUniform = uniform('Outer2' as ReturnType<typeof S.f32>['wgslType'], 'outerVal2', 'material');
        const innerMember = outerUniform.field('inner', 'Inner2' as ReturnType<typeof S.f32>['wgslType']);
        const valField = innerMember.field('val', 'f32');

        const result = compile({
            position: positionClip,
            color: vec4(
                konst('vec3f', [0, 0, 0]),
                valField as ReturnType<typeof konst>,
            ) as ReturnType<typeof konst>,
        });

        expect(result.code).toContain('struct Inner2 {');
        expect(result.code).toContain('struct Outer2 {');
        // The field chain should appear in the fragment shader body
        expect(result.code).toContain('materialUniforms.outerVal2');
    });

    test('deeply nested A→B→C — correct declaration order A, B, C', () => {
        const A = defineStruct('DeepA', { a: S.f32() });
        const B = defineStruct('DeepB', { nested: S.struct(A), b: S.f32() });
        const C = defineStruct('DeepC', { nested: S.struct(B), c: S.f32() });

        const cUniform = uniform('DeepC' as ReturnType<typeof S.f32>['wgslType'], 'deepC', 'material');
        const cField = cUniform.field('c', 'f32');

        const result = compile({
            position: positionClip,
            color: vec4(
                konst('vec3f', [0, 0, 0]),
                cField as ReturnType<typeof konst>,
            ) as ReturnType<typeof konst>,
        });

        expect(result.code).toContain('struct DeepA {');
        expect(result.code).toContain('struct DeepB {');
        expect(result.code).toContain('struct DeepC {');

        const posA = result.code.indexOf('struct DeepA {');
        const posB = result.code.indexOf('struct DeepB {');
        const posC = result.code.indexOf('struct DeepC {');
        expect(posA).toBeGreaterThanOrEqual(0);
        expect(posB).toBeGreaterThan(posA);
        expect(posC).toBeGreaterThan(posB);
    });
});

// ---------------------------------------------------------------------------
// 16–17. Stage validation — vertex-only nodes in fragment graph throw
// ---------------------------------------------------------------------------

describe('stage validation', () => {
    test('attribute node in fragment graph throws a descriptive error', () => {
        const pos = attribute('vec3f', 'position');
        const localPos = vec4(pos, konst('f32', 1.0));
        const uv = attribute('vec2f', 'uv');
        // uv is a vertex-only attribute — using it directly as color is invalid
        expect(() =>
            compile({
                position: localPos as ReturnType<typeof konst>,
                color: vec4(uv, konst('f32', 1.0)) as ReturnType<typeof konst>,
            }),
        ).toThrow(/attribute.*vertex-only/i);
    });

    test('instancedBufferAttribute node in fragment graph throws a descriptive error', () => {
        const colors = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
        const instColor = instancedBufferAttribute(colors, 'vec3f', 12, 0);
        const pos = attribute('vec3f', 'position');
        const localPos = vec4(pos, konst('f32', 1.0));
        // instColor is vertex-only — using it directly as color is invalid
        expect(() =>
            compile({
                position: localPos as ReturnType<typeof konst>,
                color: vec4(instColor, konst('f32', 1.0)) as ReturnType<typeof konst>,
            }),
        ).toThrow(/instancedBufferAttribute.*vertex-only/i);
    });
});
