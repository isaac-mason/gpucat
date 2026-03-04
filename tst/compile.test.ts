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
    Break,
    Continue,
    f32,
    Fn,
    For,
    If,
    i32,
    instancedBufferAttribute,
    mat4,
    type Node,
    sampler,
    texture,
    textureSample,
    toVar,
    u32,
    uniform,
    varying,
    vec3f,
    vec4,
    vec4f,
    While,
    type WgslType,
} from '../src/nodes/nodes.js';
import * as S from '../src/nodes/schema.js';
import { struct } from '../src/nodes/nodes.js';
import { camera, positionClip, instanceIndex, mesh } from '../src/nodes/nodes.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Compile with positionClip as position. */
function compileColor(colorNode: ReturnType<typeof vec4f>) {
    return compile({ position: positionClip, color: colorNode });
}

// ---------------------------------------------------------------------------
// 1. Constant color smoke test
// ---------------------------------------------------------------------------

describe('constant color + positionClip', () => {
    test('produces a non-empty WGSL string', () => {
        const result = compileColor(vec4f(1, 0.5, 0.1, 1));
        expect(typeof result.code).toBe('string');
        expect(result.code.length).toBeGreaterThan(0);
    });

    test('contains @vertex and @fragment entry points', () => {
        const result = compileColor(vec4f(1, 0, 0, 1));
        expect(result.code).toContain('@vertex');
        expect(result.code).toContain('fn vs_main(');
        expect(result.code).toContain('@fragment');
        expect(result.code).toContain('fn fs_main(');
    });

    test('VertexOutput has @builtin(position)', () => {
        const result = compileColor(vec4f(1, 0, 0, 1));
        expect(result.code).toContain('@builtin(position) position : vec4f');
    });

    test('fs_main returns @location(0) vec4f', () => {
        const result = compileColor(vec4f(1, 0, 0, 1));
        expect(result.code).toContain('-> @location(0) vec4f');
    });
});

// ---------------------------------------------------------------------------
// 2. Attributes → VertexInput struct + result.attributes
// ---------------------------------------------------------------------------

describe('attribute nodes', () => {
    test('attribute in position graph appears in VertexInput struct', () => {
        // positionClip uses attribute('vec3f', 'position')
        const result = compileColor(vec4f(1, 1, 1, 1));
        expect(result.code).toContain('struct VertexInput {');
        expect(result.code).toContain('@location(0) position : vec3f');
    });

    test('result.attributes contains the position attribute with kind:geometry', () => {
        const result = compileColor(vec4f(1, 1, 1, 1));
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
        const localPos = vec4(pos, f32(1.0));
        const color = vec4(vUv, f32(1.0));
        const result = compile({
            position: localPos,
            color: color,
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
        const result = compileColor(vec4f(1, 1, 1, 1));
        expect(result.code).toContain('@group(0) @binding(0) var<uniform> camera : Camera;');
    });

    test('Mesh UBO always emitted at @group(1) @binding(0)', () => {
        const result = compileColor(vec4f(1, 1, 1, 1));
        expect(result.code).toContain('@group(1) @binding(0) var<uniform> mesh : Mesh;');
    });

    test('instance_index → @builtin(instance_index) in VertexInput', () => {
        // Build a simple graph that uses instanceIndex directly
        const iIdx = instanceIndex();
        const pos = attribute('vec3f', 'position');
        const localPos = vec4(pos, f32(1.0));
        // Use iIdx somewhere in color to pull it into the graph
        const result = compile({
            position: localPos,
            color: vec4f(1, 0, 0, 1),
        });
        // instance_index only appears in VertexInput if it's referenced from the vertex graph
        // (it's in localPos which uses position attr — instance_index itself isn't referenced here)
        // Use it explicitly:
        const r2 = compile({
            position: vec4(
                pos,
                iIdx as unknown as ReturnType<typeof f32>,
            ),
            color: vec4f(1, 0, 0, 1),
        });
        expect(r2.code).toContain('@builtin(instance_index) instance_index : u32');
    });

    test('explicit mesh() node in graph causes Mesh struct to appear', () => {
        const m = mesh();
        const pos = attribute('vec3f', 'position');
        const localPos = vec4(pos, f32(1.0));
        const worldPos = m.modelMatrix.mul(localPos);
        const cam = camera();
        const clipPos = cam.projectionMatrix.mul(cam.viewMatrix.mul(worldPos));
        const result = compile({
            position: clipPos,
            color: vec4f(1, 0, 0, 1),
        });
        expect(result.code).toContain('struct Mesh {');
        expect(result.code).toContain('modelMatrix : mat4x4f');
        expect(result.code).toContain('@group(1) @binding(0) var<uniform> mesh : Mesh;');
    });

    test('result.storage is empty (no instanceMatrices storage buffer)', () => {
        const result = compileColor(vec4f(1, 1, 1, 1));
        expect(result.storage).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// 4. Struct declarations (Camera, Time, Mesh) emitted before entry points
// ---------------------------------------------------------------------------

describe('struct declarations', () => {
    test('Camera struct emitted before @vertex', () => {
        const result = compileColor(vec4f(1, 1, 1, 1));
        const cameraStructIdx = result.code.indexOf('struct Camera {');
        const vertexIdx = result.code.indexOf('@vertex');
        expect(cameraStructIdx).toBeGreaterThanOrEqual(0);
        expect(cameraStructIdx).toBeLessThan(vertexIdx);
    });

    test('Camera struct contains expected fields', () => {
        const result = compileColor(vec4f(1, 1, 1, 1));
        expect(result.code).toContain('projectionMatrix : mat4x4f');
        expect(result.code).toContain('viewMatrix : mat4x4f');
        expect(result.code).toContain('position : vec3f');
    });

    test('Mesh struct emitted before @vertex', () => {
        const result = compileColor(vec4f(1, 1, 1, 1));
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
        const localPos = vec4(pos, f32(1.0));
        const vColor = varying('vec3f', 'vColor', pos);
        const result = compile({
            position: localPos,
            color: vec4(vColor, f32(1.0)),
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
        const localPos = vec4(pos, f32(1.0));
        const vColor = varying('vec3f', 'vColor', pos);
        const result = compile({
            position: localPos,
            color: vec4(vColor, f32(1.0)),
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
        const u = uniform(vec4f(0, 0, 0, 0), 'baseColor');
        const result = compile({
            position: positionClip,
            color: u,
        });
        expect(result.code).toContain('struct MaterialUniforms {');
        expect(result.code).toContain('baseColor : vec4f');
        expect(result.code).toContain('var<uniform> materialUniforms : MaterialUniforms;');
    });

    test('material uniform gets @group(1) binding starting at 1', () => {
        const u = uniform(vec4f(0, 0, 0, 0), 'baseColor');
        const result = compile({
            position: positionClip,
            color: u,
        });
        expect(result.code).toContain('@group(1) @binding(1)');
    });

    test('result.uniforms populated correctly', () => {
        const u = uniform(f32(0), 'roughness');
        const result = compile({
            position: positionClip,
            color: vec4f(1, 1, 1, 1),
        });
        // Uniform not reachable from color/position → not collected
        expect(result.uniforms).toHaveLength(0);

        // Now use it
        const result2 = compile({
            position: positionClip,
            color: vec4(vec3f(1, 1, 1), u),
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
        const localPos = vec4(pos, f32(1.0));
        const vUv = varying('vec2f', 'vUv', uv);
        const sample = textureSample(albedoTex, albedoSamp, vUv);
        const result = compile({
            position: localPos,
            color: sample,
        });
        expect(result.code).toContain('@group(1) @binding(1) var albedo_tex : texture_2d<f32>');
        expect(result.code).toContain('@group(1) @binding(2) var albedo_samp : sampler');
    });

    test('result.textures and result.samplers populated', () => {
        const albedoTex = texture('texture_2d<f32>', 'albedo');
        const albedoSamp = sampler('albedo');
        const uv = attribute('vec2f', 'uv');
        const pos = attribute('vec3f', 'position');
        const localPos = vec4(pos, f32(1.0));
        const vUv = varying('vec2f', 'vUv', uv);
        const sample = textureSample(albedoTex, albedoSamp, vUv);
        const result = compile({
            position: localPos,
            color: sample,
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
        expect(() => compileColor(vec4f(0.2, 0.4, 0.8, 1))).not.toThrow();
    });

    test('result code contains MVP transform calls via mesh.modelMatrix', () => {
        const result = compileColor(vec4f(0.2, 0.4, 0.8, 1));
        expect(result.code).toContain('camera.projectionMatrix');
        expect(result.code).toContain('camera.viewMatrix');
        expect(result.code).toContain('mesh.modelMatrix');
    });

    test('result.attributes has only position (vec3f) with kind:geometry', () => {
        const result = compileColor(vec4f(0.2, 0.4, 0.8, 1));
        expect(result.attributes).toHaveLength(1);
        expect(result.attributes[0].kind).toBe('geometry');
        expect(result.attributes[0].name).toBe('position');
        expect(result.attributes[0].type).toBe('vec3f');
    });

    test('result.varyings is empty', () => {
        const result = compileColor(vec4f(0.2, 0.4, 0.8, 1));
        expect(result.varyings).toHaveLength(0);
    });

    test('result.storage is empty (no instance matrices storage buffer)', () => {
        const result = compileColor(vec4f(0.2, 0.4, 0.8, 1));
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
        const localPos = vec4(pos, f32(1.0));
        const colorFromNeg = vec4(vec3f(1, 1, 1), neg);
        const r2 = compile({
            position: localPos,
            color: colorFromNeg,
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
        const lerp = Fn(
            (a: Node<WgslType>, b: Node<WgslType>, t: Node<WgslType>) => {
                const af = a as ReturnType<typeof f32>;
                const bf = b as ReturnType<typeof f32>;
                const tf = t as ReturnType<typeof f32>;
                return af.add(bf.sub(af).mul(tf));
            },
            {
                name: 'lerp',
                params: [
                    { name: 'a', type: S.f32() },
                    { name: 'b', type: S.f32() },
                    { name: 't', type: S.f32() },
                ],
            },
        );
        const pos = attribute('vec3f', 'position');
        const localPos = vec4(pos, f32(1.0));
        const alpha = lerp(f32(0.0), f32(1.0), f32(0.5));
        const color = vec4(vec3f(1, 0.5, 0), alpha);
        const result = compile({
            position: localPos,
            color: color,
        });
        // A user fn declaration should appear before vs_main
        const fnIdx = result.code.search(/^fn lerp\(/m);
        const vertexIdx = result.code.indexOf('@vertex');
        expect(fnIdx).toBeGreaterThanOrEqual(0);
        expect(fnIdx).toBeLessThan(vertexIdx);
        // Params should use declared names with type f32
        expect(result.code).toContain('a : f32');
        expect(result.code).toContain('b : f32');
        expect(result.code).toContain('t : f32');
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
        const localPos = vec4(pos, f32(1.0));
        // instColor is vertex-only; bridge to fragment via a varying
        const vInstColor = varying('vec3f', 'vInstColor', instColor);
        const result = compile({
            position: localPos,
            color: vec4(vInstColor, f32(1.0)),
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
        const localPos = vec4(pos, f32(1.0));
        const worldPos = instanceTransform.mul(localPos);
        const result = compile({
            position: worldPos,
            color: vec4f(1, 1, 1, 1),
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
        const Inner = struct('NestInner', { x: S.f32(), y: S.f32() });
        const Outer = struct('NestOuter', { inner: Inner, z: S.f32() });

        // Reference Outer via a material uniform so its StructNode enters the graph
        const outerInst = uniform(Outer, 'nestOuterVal');
        const colorField = outerInst.z;
        const result = compile({
            position: positionClip,
            color: vec4(vec3f(0, 0, 0), colorField),
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
        const Inner = struct('Inner2', { val: S.f32() });
        const Outer2 = struct('Outer2', { inner: Inner, extra: S.f32() });

        // Use a uniform of type Outer2 and access .inner.val via instantiate
        const outerInst = uniform(Outer2, 'outerVal2');
        const innerInst = Inner.instantiate(outerInst.inner);
        const valField = innerInst.val;

        const result = compile({
            position: positionClip,
            color: vec4(vec3f(0, 0, 0), valField),
        });

        expect(result.code).toContain('struct Inner2 {');
        expect(result.code).toContain('struct Outer2 {');
        // The field chain should appear in the fragment shader body
        expect(result.code).toContain('materialUniforms.outerVal2');
    });

    test('deeply nested A→B→C — correct declaration order A, B, C', () => {
        const A = struct('DeepA', { a: S.f32() });
        const B = struct('DeepB', { nested: A, b: S.f32() });
        const C = struct('DeepC', { nested: B, c: S.f32() });

        const cInst = uniform(C, 'deepC');
        const cField = cInst.c;

        const result = compile({
            position: positionClip,
            color: vec4(vec3f(0, 0, 0), cField),
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
        const localPos = vec4(pos, f32(1.0));
        const uv = attribute('vec2f', 'uv');
        // uv is a vertex-only attribute — using it directly as color is invalid
        expect(() =>
            compile({
                position: localPos,
                color: vec4(uv, f32(1.0)),
            }),
        ).toThrow(/attribute.*vertex-only/i);
    });

    test('instancedBufferAttribute node in fragment graph throws a descriptive error', () => {
        const colors = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
        const instColor = instancedBufferAttribute(colors, 'vec3f', 12, 0);
        const pos = attribute('vec3f', 'position');
        const localPos = vec4(pos, f32(1.0));
        // instColor is vertex-only — using it directly as color is invalid
        expect(() =>
            compile({
                position: localPos,
                color: vec4(instColor, f32(1.0)),
            }),
        ).toThrow(/instancedBufferAttribute.*vertex-only/i);
    });
});

// ---------------------------------------------------------------------------
// 18. Loop WGSL output
// ---------------------------------------------------------------------------

describe('loop WGSL output', () => {
    test('For with end emits forward for loop from 0', () => {
        const sumFn = Fn(() => {
            const acc = toVar(f32(0.0)) as Node<'f32'>;
            For({ end: 8 }, ({ i }) => {
                acc.assign(acc.add(i.toF32()));
            });
            return acc;
        }, { name: 'sumFn', params: [] });

        const call = sumFn() as Node<'f32'>;
        const result = compile({
            position: positionClip,
            color: vec4(call, call, call, f32(1.0)),
        });
        // Should have a forward for loop from 0u to 8u
        expect(result.code).toMatch(/for\s*\(var \w+ : u32 = 0u; \w+ < 8u; \w+\+\+\)/);
    });

    test('For with start only emits backwards for loop', () => {
        const fn = Fn(() => {
            For({ start: 4 }, ({ i }) => { void i; });
            return f32(0.0);
        }, { name: 'backFn', params: [] });

        const call = fn() as Node<'f32'>;
        const result = compile({
            position: positionClip,
            color: vec4(call, call, call, f32(1.0)),
        });
        // Should have backwards loop: start = 4u - 1u, condition >=, step --
        expect(result.code).toMatch(/for\s*\(var \w+ : u32 = 4u - 1u; \w+ >= 0u; \w+--\)/);
    });

    test('For with explicit start, end, step emits custom loop', () => {
        const fn = Fn(() => {
            For({ start: 2, end: 10, condition: '<', update: 2 }, ({ i }) => { void i; });
            return f32(0.0);
        }, { name: 'stepFn', params: [] });

        const call = fn() as Node<'f32'>;
        const result = compile({
            position: positionClip,
            color: vec4(call, call, call, f32(1.0)),
        });
        // start=2u, end=10u, step+=2u
        expect(result.code).toMatch(/for\s*\(var \w+ : u32 = 2u; \w+ < 10u; \w+ \+= 2u\)/);
    });

    test('For with type i32 emits i32 index variable', () => {
        const fn = Fn(() => {
            For({ end: 4, type: 'i32' }, ({ i }) => { void i; });
            return f32(0.0);
        }, { name: 'i32Fn', params: [] });

        const call = fn() as Node<'f32'>;
        const result = compile({
            position: positionClip,
            color: vec4(call, call, call, f32(1.0)),
        });
        expect(result.code).toMatch(/for\s*\(var \w+ : i32 = 0i; \w+ < 4i; \w+\+\+\)/);
    });

    test('For with node end emits node expression as bound', () => {
        const countFn = Fn((n: Node<WgslType>) => {
            For({ end: n as Node<'u32'> }, ({ i }) => { void i; });
            return f32(0.0);
        }, {
            name: 'nodeEndFn',
            params: [{ name: 'n', type: S.u32() }],
        });

        const call = countFn(u32(5)) as Node<'f32'>;
        const result = compile({
            position: positionClip,
            color: vec4(call, call, call, f32(1.0)),
        });
        expect(result.code).toMatch(/for\s*\(var \w+ : u32 = 0u; \w+ < \w+; \w+\+\+\)/);
    });

    test('While emits while loop with condition', () => {
        const fn = Fn(() => {
            const counter = toVar(u32(0)) as Node<'u32'>;
            While(counter.lt(u32(10)), () => {
                counter.assign(counter.add(u32(1)));
            });
            return f32(0.0);
        }, { name: 'whileFn', params: [] });

        const call = fn() as Node<'f32'>;
        const result = compile({
            position: positionClip,
            color: vec4(call, call, call, f32(1.0)),
        });
        expect(result.code).toContain('while (');
        // BinopNode emits with its own parens: while ((var_N < 10u))
        expect(result.code).toMatch(/while\s*\(\(\w+ < 10u\)\)/);
    });

    test('Break emits break; statement inside loop', () => {
        const fn = Fn(() => {
            For({ end: 10 }, ({ i }) => {
                void i;
                Break();
            });
            return f32(0.0);
        }, { name: 'breakFn', params: [] });

        const call = fn() as Node<'f32'>;
        const result = compile({
            position: positionClip,
            color: vec4(call, call, call, f32(1.0)),
        });
        expect(result.code).toContain('break;');
    });

    test('Continue emits continue; statement inside loop', () => {
        const fn = Fn(() => {
            For({ end: 10 }, ({ i }) => {
                void i;
                Continue();
            });
            return f32(0.0);
        }, { name: 'continueFn', params: [] });

        const call = fn() as Node<'f32'>;
        const result = compile({
            position: positionClip,
            color: vec4(call, call, call, f32(1.0)),
        });
        expect(result.code).toContain('continue;');
    });

    test('nested For loops emit correctly indented and independent index variables', () => {
        const fn = Fn(() => {
            For({ end: 4 }, ({ i }) => {
                For({ end: 8 }, ({ i: j }) => {
                    void i;
                    void j;
                });
            });
            return f32(0.0);
        }, { name: 'nestedFn', params: [] });

        const call = fn() as Node<'f32'>;
        const result = compile({
            position: positionClip,
            color: vec4(call, call, call, f32(1.0)),
        });
        // Both loops present
        const forMatches = [...result.code.matchAll(/for\s*\(var (\w+) : u32 = 0u; \w+ < \d+u; \w+\+\+\)/g)];
        expect(forMatches).toHaveLength(2);
        // Outer loop bound is 4u, inner is 8u
        expect(result.code).toMatch(/for\s*\(var \w+ : u32 = 0u; \w+ < 4u; \w+\+\+\)/);
        expect(result.code).toMatch(/for\s*\(var \w+ : u32 = 0u; \w+ < 8u; \w+\+\+\)/);
        // The two loops use distinct index variable names
        const [outerIdx, innerIdx] = forMatches.map(m => m[1]);
        expect(outerIdx).not.toBe(innerIdx);
    });
});

// ---------------------------------------------------------------------------
// Nested if conditions
// ---------------------------------------------------------------------------

describe('nested if WGSL output', () => {
    test('nested If emits correctly indented if blocks', () => {
        const fn = Fn(() => {
            const x = toVar(f32(0.5)) as Node<'f32'>;
            const y = toVar(f32(0.25)) as Node<'f32'>;
            If(x.gt(f32(0.0)), () => {
                If(y.lt(f32(1.0)), () => {
                    x.assign(f32(1.0));
                });
            });
            return x;
        }, { name: 'nestedIfFn', params: [] });

        const call = fn() as Node<'f32'>;
        const result = compile({
            position: positionClip,
            color: vec4(call, call, call, f32(1.0)),
        });
        // Both if blocks present
        const ifMatches = [...result.code.matchAll(/if\s*\(/g)];
        expect(ifMatches.length).toBeGreaterThanOrEqual(2);
        // Outer condition checks x > 0.0, inner checks y < 1.0
        expect(result.code).toMatch(/if\s*\(\(\w+ > 0.0\)\)/);
        expect(result.code).toMatch(/if\s*\(\(\w+ < 1.0\)\)/);
    });

    test('If/Else emits both branches', () => {
        const fn = Fn(() => {
            const x = toVar(f32(0.0)) as Node<'f32'>;
            If(x.gt(f32(0.5)), () => {
                x.assign(f32(1.0));
            }).Else(() => {
                x.assign(f32(0.0));
            });
            return x;
        }, { name: 'ifElseFn', params: [] });

        const call = fn() as Node<'f32'>;
        const result = compile({
            position: positionClip,
            color: vec4(call, call, call, f32(1.0)),
        });
        expect(result.code).toContain('if (');
        expect(result.code).toContain('} else {');
    });

    test('If nested inside For loop emits correct structure', () => {
        const fn = Fn(() => {
            const acc = toVar(f32(0.0)) as Node<'f32'>;
            For({ end: 4 }, ({ i }) => {
                void i;
                If(acc.lt(f32(2.0)), () => {
                    acc.assign(acc.add(f32(1.0)));
                });
            });
            return acc;
        }, { name: 'forIfFn', params: [] });

        const call = fn() as Node<'f32'>;
        const result = compile({
            position: positionClip,
            color: vec4(call, call, call, f32(1.0)),
        });
        expect(result.code).toMatch(/for\s*\(var \w+ : u32 = 0u; \w+ < 4u; \w+\+\+\)/);
        expect(result.code).toContain('if (');
        // if block appears inside (after) the for header
        const forPos = result.code.indexOf('for (');
        const ifPos = result.code.indexOf('if (');
        expect(ifPos).toBeGreaterThan(forPos);
    });
});
