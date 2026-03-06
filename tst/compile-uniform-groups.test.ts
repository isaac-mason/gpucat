import { describe, expect, test } from 'vitest';
import {
    compile,
    type CompileResult,
    type UniformGroupBlock,
} from '../src/nodes/compile';
import {
    uniform,
    f32,
    vec4f,
    cameraProjectionMatrix,
    cameraViewMatrix,
    cameraPosition,
    cameraNear,
    cameraFar,
    timeElapsed,
    timeDelta,
    modelWorldMatrix,
    modelNormalMatrix,
} from '../src/nodes/nodes';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function findGroup(result: CompileResult, name: string): UniformGroupBlock | undefined {
    return result.uniformGroups.find(g => g.groupName === name);
}

// ─────────────────────────────────────────────────────────────────────────────
// WGSL struct naming — bare group name, no 'Struct' suffix
// ─────────────────────────────────────────────────────────────────────────────

describe('WGSL struct naming', () => {
    test('render struct uses bare group name as both type and variable name', () => {
        const result = compile({
            position: cameraProjectionMatrix.mul(vec4f(0, 0, 0, 1)),
            color: vec4f(1, 0, 0, 1),
        });

        expect(result.code).toContain('struct render {');
        expect(result.code).not.toContain('struct renderStruct {');
        expect(result.code).toContain('var<uniform> render : render');
    });

    test('object struct uses bare group name as both type and variable name', () => {
        const result = compile({
            position: modelWorldMatrix.mul(vec4f(0, 0, 0, 1)),
            color: vec4f(1, 0, 0, 1),
        });

        expect(result.code).toContain('struct object {');
        expect(result.code).not.toContain('struct objectStruct {');
        expect(result.code).toContain('var<uniform> object : object');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// WGSL property access patterns — groupName.fieldName
// ─────────────────────────────────────────────────────────────────────────────

describe('WGSL property access', () => {
    test('camera uniforms accessed as render.<field>', () => {
        const result = compile({
            position: cameraProjectionMatrix.mul(vec4f(0, 0, 0, 1)),
            color: vec4f(cameraNear, 0, 0, 1),
        });

        expect(result.code).toContain('render.cameraProjectionMatrix');
        expect(result.code).toContain('render.cameraNear');

        // No flat var<uniform> declarations for these
        expect(result.code).not.toMatch(/var<uniform>\s+cameraProjectionMatrix/);
        expect(result.code).not.toMatch(/var<uniform>\s+cameraNear/);
    });

    test('model uniforms accessed as object.<field>', () => {
        const result = compile({
            position: modelWorldMatrix.mul(vec4f(0, 0, 0, 1)),
            color: vec4f(1, 0, 0, 1),
        });

        expect(result.code).toContain('object.modelWorldMatrix');
        expect(result.code).not.toMatch(/var<uniform>\s+modelWorldMatrix/);
    });

    test('user material uniform accessed as object.<field>', () => {
        // uniform() takes a ConstNode — use f32() to create one
        const roughness = uniform(f32(0.5), 'roughness');
        const result = compile({
            position: vec4f(0, 0, 0, 1),
            color: vec4f(roughness, 0, 0, 1),
        });

        expect(result.code).toContain('object.roughness');
        expect(result.code).not.toMatch(/var<uniform>\s+roughness/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// UniformGroupBlock metadata
// ─────────────────────────────────────────────────────────────────────────────

describe('uniformGroups metadata', () => {
    test('render group gets lower groupIndex than object group when both present', () => {
        const result = compile({
            position: cameraProjectionMatrix.mul(modelWorldMatrix.mul(vec4f(0, 0, 0, 1))),
            color: vec4f(1, 0, 0, 1),
        });

        const rg = findGroup(result, 'render');
        const og = findGroup(result, 'object');
        expect(rg).toBeDefined();
        expect(og).toBeDefined();
        expect(rg!.groupIndex).toBeLessThan(og!.groupIndex);
    });

    test('render group is @group(0) when both render and object groups are used', () => {
        const result = compile({
            position: cameraProjectionMatrix.mul(modelWorldMatrix.mul(vec4f(0, 0, 0, 1))),
            color: vec4f(1, 0, 0, 1),
        });

        const rg = findGroup(result, 'render');
        expect(rg!.groupIndex).toBe(0);
        expect(rg!.binding).toBe(0);
        expect(rg!.shared).toBe(true);
    });

    test('object group is @group(1) when both render and object groups are used', () => {
        const result = compile({
            position: cameraProjectionMatrix.mul(modelWorldMatrix.mul(vec4f(0, 0, 0, 1))),
            color: vec4f(1, 0, 0, 1),
        });

        const og = findGroup(result, 'object');
        expect(og!.groupIndex).toBe(1);
        expect(og!.binding).toBe(0);
        expect(og!.shared).toBe(false);
    });

    test('when only object group is used, it gets groupIndex 0 (compact assignment)', () => {
        // objectGroup has order=1 but when render group is absent it still starts at 0
        const myVal = uniform(f32(1.0), 'myVal');
        const result = compile({
            position: vec4f(0, 0, 0, 1),
            color: vec4f(myVal, 0, 0, 1),
        });

        const og = findGroup(result, 'object');
        expect(og).toBeDefined();
        expect(og!.groupIndex).toBe(0);
    });

    test('render group contains all camera and time uniforms', () => {
        const result = compile({
            position: cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4f(0, 0, 0, 1))),
            color: vec4f(timeElapsed, timeDelta, cameraNear, cameraFar),
        });

        const rg = findGroup(result, 'render');
        expect(rg).toBeDefined();
        const memberNames = rg!.members.map(m => m.uniformId);
        expect(memberNames).toContain('cameraProjectionMatrix');
        expect(memberNames).toContain('cameraViewMatrix');
        expect(memberNames).toContain('cameraNear');
        expect(memberNames).toContain('cameraFar');
        expect(memberNames).toContain('timeElapsed');
        expect(memberNames).toContain('timeDelta');
    });

    test('object group contains modelWorldMatrix', () => {
        const result = compile({
            position: modelWorldMatrix.mul(vec4f(0, 0, 0, 1)),
            color: vec4f(1, 0, 0, 1),
        });

        const og = findGroup(result, 'object');
        expect(og).toBeDefined();
        const memberNames = og!.members.map(m => m.uniformId);
        expect(memberNames).toContain('modelWorldMatrix');
    });

    test('user material uniforms are packed into the object group alongside mesh uniforms', () => {
        const baseColor = uniform(vec4f(1, 0, 0, 1), 'baseColor');
        const roughness = uniform(f32(0.5), 'roughness');

        const result = compile({
            position: modelWorldMatrix.mul(vec4f(0, 0, 0, 1)),
            color: baseColor.mul(vec4f(roughness, roughness, roughness, 1)),
        });

        const og = findGroup(result, 'object');
        expect(og).toBeDefined();
        const memberNames = og!.members.map(m => m.uniformId);
        expect(memberNames).toContain('modelWorldMatrix');
        expect(memberNames).toContain('baseColor');
        expect(memberNames).toContain('roughness');
    });

    test('only groups that are actually used appear in uniformGroups', () => {
        // Only object-group uniform used — render group must not appear
        const myVal = uniform(f32(1.0), 'myVal');
        const result = compile({
            position: vec4f(0, 0, 0, 1),
            color: vec4f(myVal, 0, 0, 1),
        });

        const groupNames = result.uniformGroups.map(g => g.groupName);
        expect(groupNames).toContain('object');
        expect(groupNames).not.toContain('render');
    });

    test('unused groups produce no WGSL output', () => {
        const myVal = uniform(f32(1.0), 'myVal');
        const result = compile({
            position: vec4f(0, 0, 0, 1),
            color: vec4f(myVal, 0, 0, 1),
        });

        expect(result.code).not.toContain('struct render {');
        expect(result.code).not.toContain('var<uniform> render');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Byte layout / offset correctness
// ─────────────────────────────────────────────────────────────────────────────

describe('uniform group byte layout', () => {
    test('mat4x4f member has size=64 and is 16-byte aligned', () => {
        const result = compile({
            position: cameraProjectionMatrix.mul(vec4f(0, 0, 0, 1)),
            color: vec4f(1, 0, 0, 1),
        });

        const rg = findGroup(result, 'render');
        const mat = rg!.members.find(m => m.uniformId === 'cameraProjectionMatrix');
        expect(mat).toBeDefined();
        expect(mat!.size).toBe(64);
        expect(mat!.offset % 16).toBe(0);
    });

    test('f32 member has size=4', () => {
        const result = compile({
            position: vec4f(0, 0, 0, 1),
            color: vec4f(cameraNear, 0, 0, 1),
        });

        const rg = findGroup(result, 'render');
        const near = rg!.members.find(m => m.uniformId === 'cameraNear');
        expect(near).toBeDefined();
        expect(near!.size).toBe(4);
    });

    test('totalBytes is a multiple of 16', () => {
        const result = compile({
            position: cameraProjectionMatrix.mul(vec4f(0, 0, 0, 1)),
            color: vec4f(cameraNear, cameraFar, 0, 1),
        });

        const rg = findGroup(result, 'render');
        expect(rg!.totalBytes % 16).toBe(0);
    });

    test('members do not overlap (each offset >= previous offset + size)', () => {
        const result = compile({
            position: cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4f(0, 0, 0, 1))),
            color: vec4f(cameraNear, cameraFar, 0, 1),
        });

        const rg = findGroup(result, 'render');
        const members = rg!.members;
        for (let i = 0; i < members.length - 1; i++) {
            expect(members[i].offset + members[i].size).toBeLessThanOrEqual(members[i + 1].offset);
        }
    });

    test('vec4f member has size=16 and is 16-byte aligned', () => {
        const myVec = uniform(vec4f(1, 0, 0, 1), 'myColor');
        const result = compile({
            position: vec4f(0, 0, 0, 1),
            color: myVec,
        });

        const og = findGroup(result, 'object');
        const member = og!.members.find(m => m.uniformId === 'myColor');
        expect(member).toBeDefined();
        expect(member!.size).toBe(16);
        expect(member!.offset % 16).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// WGSL code structure
// ─────────────────────────────────────────────────────────────────────────────

describe('WGSL code structure', () => {
    test('struct declaration appears before the binding declaration', () => {
        const result = compile({
            position: cameraProjectionMatrix.mul(vec4f(0, 0, 0, 1)),
            color: vec4f(1, 0, 0, 1),
        });

        const structIdx = result.code.indexOf('struct render {');
        const bindingIdx = result.code.indexOf('var<uniform> render : render');
        expect(structIdx).toBeGreaterThanOrEqual(0);
        expect(bindingIdx).toBeGreaterThanOrEqual(0);
        expect(structIdx).toBeLessThan(bindingIdx);
    });

    test('render at @group(0) and object at @group(1) when both present', () => {
        const result = compile({
            position: cameraProjectionMatrix.mul(modelWorldMatrix.mul(vec4f(0, 0, 0, 1))),
            color: vec4f(1, 0, 0, 1),
        });

        expect(result.code).toContain('@group(0) @binding(0) var<uniform> render : render');
        expect(result.code).toContain('@group(1) @binding(0) var<uniform> object : object');
    });

    test('render struct block contains camera fields and not object fields', () => {
        const result = compile({
            position: cameraProjectionMatrix.mul(modelWorldMatrix.mul(vec4f(0, 0, 0, 1))),
            color: vec4f(cameraNear, 0, 0, 1),
        });

        const renderStructStart = result.code.indexOf('struct render {');
        const renderStructEnd = result.code.indexOf('}', renderStructStart);
        const renderBlock = result.code.slice(renderStructStart, renderStructEnd);
        expect(renderBlock).toContain('cameraProjectionMatrix');
        expect(renderBlock).toContain('cameraNear');
        expect(renderBlock).not.toContain('modelWorldMatrix');
    });

    test('object struct block contains model fields and not camera fields', () => {
        const result = compile({
            position: cameraProjectionMatrix.mul(modelWorldMatrix.mul(vec4f(0, 0, 0, 1))),
            color: vec4f(1, 0, 0, 1),
        });

        const objectStructStart = result.code.indexOf('struct object {');
        const objectStructEnd = result.code.indexOf('}', objectStructStart);
        const objectBlock = result.code.slice(objectStructStart, objectStructEnd);
        expect(objectBlock).toContain('modelWorldMatrix');
        expect(objectBlock).not.toContain('cameraProjectionMatrix');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// CompileResult shape — no legacy fields
// ─────────────────────────────────────────────────────────────────────────────

describe('CompileResult shape', () => {
    test('no legacy uniforms field on CompileResult', () => {
        const result = compile({
            position: vec4f(0, 0, 0, 1),
            color: vec4f(1, 0, 0, 1),
        });
        expect('uniforms' in result).toBe(false);
    });
});
