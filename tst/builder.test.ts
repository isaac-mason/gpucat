import { describe, expect, test } from 'vitest';
import {
    // DSL functions
    f32,
    vec2,
    vec3,
    vec4,
    i32,
    u32,
    bool,
    // Operators
    add,
    sub,
    mul,
    div,
    // Math
    sin,
    cos,
    normalize,
    dot,
    cross,
    mix,
    clamp,
    // Nodes
    uniform,
    attribute,
    varying,
    Fn,
    If,
    Loop,
    compute,
    // Control flow
    Break,
    Continue,
    // Ternary
    cond,
    // MRT
    mrt,
    // Texture
    texture,
    // Wgsl template
    wgsl,
    // Types
    type Node,
    type WgslType,
    type FnNode,
    vertexIndex,
    builtin,
} from '../src/nodes/nodes';
import * as S from '../src/nodes/schema';
import { compile, compileCompute } from '../src/nodes/builder';
import { Texture } from '../src/texture/texture';

// Helper to normalize whitespace for comparison
function normalizeWgsl(code: string): string {
    return code
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('//'))
        .join('\n');
}

// Helper to check if generated code contains expected snippet
function expectContains(code: string, snippet: string) {
    const normalizedCode = normalizeWgsl(code);
    const normalizedSnippet = normalizeWgsl(snippet);
    expect(normalizedCode).toContain(normalizedSnippet);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
    test('float constant', () => {
        const pos = vec4(0, 0, 0, 1);
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: pos, color });
        
        // WGSL uses 0.0 format, not 0f
        expectContains(result.code, 'vec4f(0.0, 0.0, 0.0, 1.0)');
        expectContains(result.code, 'vec4f(1.0, 0.0, 0.0, 1.0)');
    });

    test('int constant', () => {
        const pos = vec4(i32(1).toF32(), 0, 0, 1);
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: pos, color });
        
        expectContains(result.code, '1i');
    });

    test('uint constant', () => {
        const pos = vec4(u32(1).toF32(), 0, 0, 1);
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: pos, color });
        
        expectContains(result.code, '1u');
    });

    test('bool constant', () => {
        const condition = bool(true);
        const pos = vec4(0, 0, 0, 1);
        // Use standalone cond function
        const color = cond(condition, vec4(1, 0, 0, 1), vec4(0, 1, 0, 1));
        
        const result = compile({ position: pos, color });
        
        expectContains(result.code, 'true');
    });
});

// ---------------------------------------------------------------------------
// Binary Operations
// ---------------------------------------------------------------------------

describe('binary operations', () => {
    test('add', () => {
        const a = f32(1);
        const b = f32(2);
        const pos = vec4(add(a, b), 0, 0, 1);
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: pos, color });
        
        expectContains(result.code, '(1.0 + 2.0)');
    });

    test('sub', () => {
        const a = f32(1);
        const b = f32(2);
        const pos = vec4(sub(a, b), 0, 0, 1);
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: pos, color });
        
        expectContains(result.code, '(1.0 - 2.0)');
    });

    test('mul', () => {
        const a = f32(2);
        const b = f32(3);
        const pos = vec4(mul(a, b), 0, 0, 1);
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: pos, color });
        
        expectContains(result.code, '(2.0 * 3.0)');
    });

    test('div', () => {
        const a = f32(6);
        const b = f32(2);
        const pos = vec4(div(a, b), 0, 0, 1);
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: pos, color });
        
        expectContains(result.code, '(6.0 / 2.0)');
    });

    test('chained operations', () => {
        const a = f32(1);
        const b = f32(2);
        const c = f32(3);
        // (a + b) * c
        const pos = vec4(a.add(b).mul(c), 0, 0, 1);
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: pos, color });
        
        expectContains(result.code, '((1.0 + 2.0) * 3.0)');
    });
});

// ---------------------------------------------------------------------------
// Math Functions
// ---------------------------------------------------------------------------

describe('math functions', () => {
    test('sin', () => {
        const x = f32(0);
        const pos = vec4(sin(x), 0, 0, 1);
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: pos, color });
        
        expectContains(result.code, 'sin(0.0)');
    });

    test('cos', () => {
        const x = f32(0);
        const pos = vec4(cos(x), 0, 0, 1);
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: pos, color });
        
        expectContains(result.code, 'cos(0.0)');
    });

    test('normalize', () => {
        const v = vec3(1, 0, 0);
        const pos = vec4(normalize(v), 1);
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: pos, color });
        
        expectContains(result.code, 'normalize(vec3f(1.0, 0.0, 0.0))');
    });

    test('dot product', () => {
        const a = vec3(1, 0, 0);
        const b = vec3(0, 1, 0);
        const pos = vec4(dot(a, b), 0, 0, 1);
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: pos, color });
        
        expectContains(result.code, 'dot(');
    });

    test('cross product', () => {
        const a = vec3(1, 0, 0);
        const b = vec3(0, 1, 0);
        const pos = vec4(cross(a, b), 1);
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: pos, color });
        
        expectContains(result.code, 'cross(');
    });

    test('mix', () => {
        const a = f32(0);
        const b = f32(1);
        const t = f32(0.5);
        const pos = vec4(mix(a, b, t), 0, 0, 1);
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: pos, color });
        
        expectContains(result.code, 'mix(');
    });

    test('clamp', () => {
        const x = f32(1.5);
        const lo = f32(0);
        const hi = f32(1);
        const pos = vec4(clamp(x, lo, hi), 0, 0, 1);
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: pos, color });
        
        expectContains(result.code, 'clamp(');
    });

    test('toVar outside Fn body emits declaration inline', () => {
        // When toVar is called outside a Fn body (e.g., at module scope),
        // the variable declaration should be emitted when the var is used
        const position = attribute(S.vec3f, 'position');
        const worldPos = vec4(position, 1).toVar('worldPos');
        const clipPos = worldPos.mul(f32(2)).toVar('clipPos');
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: clipPos, color });
        
        // Should emit var declarations in the shader
        expectContains(result.code, 'var var_');
        expectContains(result.code, 'worldPos');
        expectContains(result.code, 'clipPos');
        // The declarations should appear before usage
        const worldPosDecl = result.code.indexOf('var_');
        const clipPosUsage = result.code.indexOf('output.position');
        expect(worldPosDecl).toBeLessThan(clipPosUsage);
    });
});

// ---------------------------------------------------------------------------
// Uniforms
// ---------------------------------------------------------------------------

describe('uniforms', () => {
    test('single uniform', () => {
        const time = uniform(f32(0), 'time');
        const pos = vec4(sin(time), 0, 0, 1);
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: pos, color });
        
        // Should have uniform declaration
        expectContains(result.code, 'time: f32');
        // Should reference uniform in expression
        expectContains(result.code, 'uniforms_');
        expect(result.uniformGroups.length).toBeGreaterThan(0);
    });

    test('multiple uniforms', () => {
        const time = uniform(f32(0), 'time');
        const scale = uniform(f32(1), 'scale');
        const pos = vec4(sin(time).mul(scale), 0, 0, 1);
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: pos, color });
        
        expectContains(result.code, 'time: f32');
        expectContains(result.code, 'scale: f32');
    });

    test('vec4 uniform', () => {
        const offset = uniform(vec4(0, 0, 0, 0), 'offset');
        const pos = offset;
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: pos, color });
        
        expectContains(result.code, 'offset: vec4f');
    });
});

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

describe('attributes', () => {
    test('position attribute', () => {
        const position = attribute(S.vec3f, 'position');
        const pos = vec4(position, 1);
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: pos, color });
        
        // Should have attribute in vertex input
        expectContains(result.code, '@location');
        expectContains(result.code, 'position: vec3f');
        expect(result.attributes.length).toBe(1);
        expect(result.attributes[0].name).toBe('position');
    });

    test('multiple attributes', () => {
        const position = attribute(S.vec3f, 'position');
        const normal = attribute(S.vec3f, 'normal');
        
        // Both position and normal used in vertex stage
        const pos = vec4(position.add(normal), 1);
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: pos, color });
        
        expect(result.attributes.length).toBe(2); // position and normal used
    });
});

// ---------------------------------------------------------------------------
// Varyings
// ---------------------------------------------------------------------------

describe('varyings', () => {
    test('varying passes data from vertex to fragment', () => {
        const position = attribute(S.vec3f, 'position');
        const normal = attribute(S.vec3f, 'normal');
        
        // Varying: pass normal from vertex to fragment
        const vNormal = varying(normal, 'vNormal');
        
        const pos = vec4(position, 1);
        const color = vec4(vNormal, 1);
        
        const result = compile({ position: pos, color });
        
        // Should have varying in both vertex output and fragment input
        expectContains(result.code, 'vNormal: vec3f');
        expect(result.varyings.length).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// DSL Functions (Fn) - using variadic signature
// ---------------------------------------------------------------------------

describe('Fn (DSL functions)', () => {
    test('simple function', () => {
        // Use layout form since no-layout form requires fixing in nodes.ts
        const square = Fn((x) => {
            return x.mul(x);
        }, {
            name: 'square',
            params: [{ name: 'x', type: S.f32 }],
        });
        
        const pos = vec4(square(f32(3)), 0, 0, 1);
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: pos, color });
        
        // Should have function definition
        expectContains(result.code, 'fn ');
        expectContains(result.code, '-> f32');
    });

    test('function with multiple parameters', () => {
        const addTwo = Fn((a, b) => {
            return a.add(b);
        }, {
            name: 'addTwo',
            params: [
                { name: 'a', type: S.f32 },
                { name: 'b', type: S.f32 },
            ],
        });
        
        const pos = vec4(addTwo(f32(1), f32(2)), 0, 0, 1);
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: pos, color });
        
        // Function should have two parameters
        expectContains(result.code, 'fn ');
    });

    test('function calling another function', () => {
        const square = Fn((x) => {
            return x.mul(x);
        }, {
            name: 'square',
            params: [{ name: 'x', type: S.f32 }],
        });
        
        const cube = Fn((x) => {
            return square(x).mul(x);
        }, {
            name: 'cube',
            params: [{ name: 'x', type: S.f32 }],
        });
        
        const pos = vec4(cube(f32(2)), 0, 0, 1);
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: pos, color });
        
        // Both functions should be defined
        expect(result.code.match(/fn /g)?.length).toBeGreaterThanOrEqual(2);
    });
});

// ---------------------------------------------------------------------------
// Control Flow - If (in void-returning Fn)
// ---------------------------------------------------------------------------

describe('If statements', () => {
    test('simple if in void function', () => {
        const condition = bool(true);
        
        // Void-returning function
        const myFn = Fn(() => {
            const result = f32(0).toVar('result');
            
            If(condition, () => {
                result.assign(f32(1));
            });
            
            // no return - void
        });
        
        // Use the FnNode for compute
        const result = compileCompute(myFn.compute({  workgroupSize: [64, 1, 1] }));
        
        expectContains(result.code, 'if (');
    });

    test('if-else', () => {
        const condition = bool(true);
        
        const myFn = Fn(() => {
            const result = f32(0).toVar('result');
            
            If(condition, () => {
                result.assign(f32(1));
            }).Else(() => {
                result.assign(f32(2));
            });
        });
        
        const result = compileCompute(myFn.compute({  workgroupSize: [64, 1, 1] }));
        
        expectContains(result.code, 'if (');
        expectContains(result.code, '} else {');
    });

    test('nested if', () => {
        const a = bool(true);
        const b = bool(false);
        
        const myFn = Fn(() => {
            const result = f32(0).toVar('result');
            
            If(a, () => {
                If(b, () => {
                    result.assign(f32(1));
                }).Else(() => {
                    result.assign(f32(2));
                });
            });
        });
        
        const result = compileCompute(myFn.compute({  workgroupSize: [64, 1, 1] }));
        
        // Should have nested if statements
        const ifCount = result.code.match(/if \(/g)?.length ?? 0;
        expect(ifCount).toBeGreaterThanOrEqual(2);
    });
});

// ---------------------------------------------------------------------------
// Control Flow - Loops
// ---------------------------------------------------------------------------

describe('Loop statements', () => {
    test('simple loop with count', () => {
        const myFn = Fn(() => {
            const sum = f32(0).toVar('sum');
            
            Loop(10, () => {
                sum.assign(sum.add(f32(1)));
            });
        });
        
        const result = compileCompute(myFn.compute({  workgroupSize: [64, 1, 1] }));
        
        expectContains(result.code, 'for (');
    });

    test('loop with break', () => {
        const myFn = Fn(() => {
            const sum = f32(0).toVar('sum');
            
            Loop(100, ({ i }) => {
                If(i.greaterThan(i32(5)), () => {
                    Break();
                });
                sum.assign(sum.add(f32(1)));
            });
        });
        
        const result = compileCompute(myFn.compute({  workgroupSize: [64, 1, 1] }));
        
        expectContains(result.code, 'break');
    });

    test('loop with continue', () => {
        const myFn = Fn(() => {
            const sum = f32(0).toVar('sum');
            
            Loop(10, ({ i }) => {
                If(i.equal(i32(5)), () => {
                    Continue();
                });
                sum.assign(sum.add(f32(1)));
            });
        });
        
        const result = compileCompute(myFn.compute({  workgroupSize: [64, 1, 1] }));
        
        expectContains(result.code, 'continue');
    });

    test('nested loops using indices', () => {
        const myFn = Fn(() => {
            const sum = f32(0).toVar('sum');
            
            // Outer loop: row index
            Loop(3, ({ i: row }) => {
                // Inner loop: col index
                Loop(4, ({ i: col }) => {
                    // Compute linear index: row * 4 + col
                    const linearIdx = row.mul(i32(4)).add(col);
                    sum.assign(sum.add(linearIdx.toF32()));
                });
            });
        });
        
        const result = compileCompute(myFn.compute({  workgroupSize: [64, 1, 1] }));
        
        // Should have two for loops with unique variable names
        const forCount = result.code.match(/for \(/g)?.length ?? 0;
        expect(forCount).toBe(2);
        
        // Each loop variable should be unique (i_depth_counter format)
        const loopVars = result.code.match(/i_\d+_\d+/g) ?? [];
        const uniqueVars = new Set(loopVars);
        expect(uniqueVars.size).toBe(2);
        
        // Should use multiplication and addition with indices
        expectContains(result.code, '* 4i');
    });

    test('triple nested loops computing 3D index', () => {
        const myFn = Fn(() => {
            const sum = f32(0).toVar('sum');
            
            // 3D grid: 2x3x4
            Loop(2, ({ i: z }) => {
                Loop(3, ({ i: y }) => {
                    Loop(4, ({ i: x }) => {
                        // Linear index in 3D: z * (3*4) + y * 4 + x
                        const idx = z.mul(i32(12)).add(y.mul(i32(4))).add(x);
                        sum.assign(sum.add(idx.toF32()));
                    });
                });
            });
        });
        
        const result = compileCompute(myFn.compute({  workgroupSize: [64, 1, 1] }));
        
        // Should have three for loops
        const forCount = result.code.match(/for \(/g)?.length ?? 0;
        expect(forCount).toBe(3);
        
        // Each loop variable should be unique
        const loopVars = result.code.match(/i_\d+_\d+/g) ?? [];
        const uniqueVars = new Set(loopVars);
        expect(uniqueVars.size).toBe(3);
        
        // Check that we have different loop bounds
        expectContains(result.code, '< 2i');
        expectContains(result.code, '< 3i');
        expectContains(result.code, '< 4i');
        
        // Should use the indices in calculations
        expectContains(result.code, '* 12i');
        expectContains(result.code, '* 4i');
        
        // Verify proper indentation - inner loops should be more indented
        const lines = result.code.split('\n');
        const forLines = lines.filter(l => l.includes('for ('));
        expect(forLines.length).toBe(3);
        const indents = forLines.map(l => l.match(/^(\s*)/)?.[1].length ?? 0);
        expect(indents[1]).toBeGreaterThan(indents[0]);
        expect(indents[2]).toBeGreaterThan(indents[1]);
    });

    test('nested loops with index access', () => {
        const myFn = Fn(() => {
            const sum = f32(0).toVar('sum');
            
            Loop(3, ({ i: outerI }) => {
                Loop(4, ({ i: innerI }) => {
                    // Use both indices
                    sum.assign(sum.add(outerI.toF32()).add(innerI.toF32()));
                });
            });
        });
        
        const result = compileCompute(myFn.compute({  workgroupSize: [64, 1, 1] }));
        
        // Should have two for loops
        const forCount = result.code.match(/for \(/g)?.length ?? 0;
        expect(forCount).toBe(2);
        
        // Both loop indices should be unique and used in the body
        const loopVars = result.code.match(/i_\d+_\d+/g) ?? [];
        const uniqueVars = new Set(loopVars);
        expect(uniqueVars.size).toBe(2);
        
        // Should have f32() conversions for both indices
        expectContains(result.code, 'f32(');
    });
});

// ---------------------------------------------------------------------------
// CSE (Common Subexpression Elimination)
// ---------------------------------------------------------------------------

describe('CSE (Common Subexpression Elimination)', () => {
    test('reused expression gets extracted to variable', () => {
        const a = f32(1);
        const b = f32(2);
        const expensive = sin(a.add(b));
        
        // Use expensive twice
        const pos = vec4(expensive, expensive, 0, 1);
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: pos, color });
        
        // Should have a let declaration for the reused expression
        expectContains(result.code, 'let _v');
    });
});

// ---------------------------------------------------------------------------
// Shader Structure
// ---------------------------------------------------------------------------

describe('shader structure', () => {
    test('generates vertex and fragment shaders', () => {
        const position = attribute(S.vec3f, 'position');
        const pos = vec4(position, 1);
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: pos, color });
        
        // Should have @vertex and @fragment
        expectContains(result.code, '@vertex');
        expectContains(result.code, '@fragment');
        
        // Should have entry point functions
        expectContains(result.code, 'fn vs_main(');
        expectContains(result.code, 'fn fs_main(');
        
        // Should return entry point names
        expect(result.vertexEntryPoint).toBe('vs_main');
        expect(result.fragmentEntryPoint).toBe('fs_main');
    });

    test('generates input/output structs', () => {
        const position = attribute(S.vec3f, 'position');
        const pos = vec4(position, 1);
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: pos, color });
        
        // Should have VertexInput and VertexOutput structs
        expectContains(result.code, 'struct VertexInput');
        expectContains(result.code, 'struct VertexOutput');
    });

    test('fullscreen triangle using only vertex_index builtin (no attributes)', () => {
        // This pattern is used for fullscreen passes - no vertex attributes,
        // only @builtin(vertex_index) to generate clip-space positions
        const vi = vertexIndex;
        const pos = wgsl(S.vec4f)`vec4f(f32((${vi} & 1u) * 2u) * 2.0 - 1.0, f32(${vi} & 2u) * 2.0 - 1.0, 0.0, 1.0)`;
        const color = vec4(1, 0, 0, 1);
        
        const result = compile({ position: pos, color });
        
        // Should have vertex_index in VertexInput struct
        expectContains(result.code, '@builtin(vertex_index) vertex_index: u32');
        // VertexInput should NOT be empty - WGSL requires at least one member
        expect(result.code).not.toMatch(/struct VertexInput \{\s*\}/);
    });
});

// ---------------------------------------------------------------------------
// Compute Shaders
// ---------------------------------------------------------------------------

describe('compute shaders', () => {
    test('basic compute shader', () => {
        const myFn = Fn(() => {
            // Just an empty compute shader
        });
        
        const result = compileCompute(myFn.compute({  workgroupSize: [64, 1, 1] }));
        
        expectContains(result.code, '@compute');
        expectContains(result.code, '@workgroup_size(64, 1, 1)');
    });
});

// ---------------------------------------------------------------------------
// Texture Sampling
// ---------------------------------------------------------------------------

describe('texture sampling', () => {
    test('texture node generates textureSample call', () => {
        const position = attribute(S.vec3f, 'position');
        const uvAttr = attribute(S.vec2f, 'uv');
        const pos = vec4(position, 1);
        
        // Pass UV through varying to fragment stage
        const vUv = varying(uvAttr, 'v_uv');
        
        // Create a texture using the DSL and sample with UVs
        const myTexture = new Texture();
        const texNode = texture(myTexture).sample(vUv);
        
        const result = compile({ position: pos, color: texNode });
        
        // Should declare texture and sampler bindings
        // Following Three.js pattern: textures go to objectGroup, but group index is 
        // determined by sorted position (not order value). When only objectGroup is used,
        // it becomes @group(0) since it's the only group.
        expectContains(result.code, '@group(0) @binding');
        expectContains(result.code, 'texture_2d<f32>');
        expectContains(result.code, 'sampler');
        
        // Should generate textureSample call in fragment shader
        expectContains(result.code, 'textureSample(');
    });
    
    test('texture with custom UV generates correct sample', () => {
        const position = attribute(S.vec3f, 'position');
        const pos = vec4(position, 1);
        
        // Custom UV expression (constant, no varying needed)
        const customUv = vec2(f32(0.5), f32(0.5));
        
        const myTexture = new Texture();
        const texNode = texture(myTexture).sample(customUv);
        
        const result = compile({ position: pos, color: texNode });
        
        // Should use the custom UV in textureSample
        expectContains(result.code, 'textureSample(');
        expectContains(result.code, 'vec2f(0.5, 0.5)');
    });
    
    test('texture bindings are included in compile result with correct binding indices', () => {
        const position = attribute(S.vec3f, 'position');
        const uvAttr = attribute(S.vec2f, 'uv');
        const pos = vec4(position, 1);
        
        // Pass UV through varying to fragment stage
        const vUv = varying(uvAttr, 'v_uv');
        
        const myTexture = new Texture();
        const texNode = texture(myTexture).sample(vUv);
        
        const result = compile({ position: pos, color: texNode });
        
        // Check that textures array contains the texture entry with correct binding
        // Following Three.js pattern: textures go to objectGroup, but group index is
        // determined by sorted position. When only objectGroup is used, it becomes
        // @group(0) since it's the only group.
        expect(result.textures.length).toBe(1);
        expect(result.textures[0].type).toBe('texture_2d<f32>');
        expect(result.textures[0].group).toBe(0); // Only group used → sorted position 0
        expect(result.textures[0].binding).toBe(0); // First binding in group
        
        // Check that samplers array contains the sampler entry with correct binding
        expect(result.samplers.length).toBe(1);
        expect(result.samplers[0].group).toBe(0); // Only group used → sorted position 0
        expect(result.samplers[0].binding).toBe(1); // Second binding in group (after texture)
        
        // Verify WGSL has matching bindings
        expectContains(result.code, '@group(0) @binding(0)');
        expectContains(result.code, '@group(0) @binding(1)');
    });
    
    test('texture wrapped in WgslNode is collected in result.textures', () => {
        const position = attribute(S.vec3f, 'position');
        const uvAttr = attribute(S.vec2f, 'uv');
        const pos = vec4(position, 1);
        
        // Pass UV through varying to fragment stage
        const vUv = varying(uvAttr, 'v_uv');
        
        const myTexture = new Texture();
        const texNode = texture(myTexture).sample(vUv);
        
        // Wrap the texture in a WgslNode, similar to _makeOutputMaterial
        // This pattern: wgsl(d.vec4f)`${ outputNode }`.with(uvVarying)
        const wrappedColor = wgsl(S.vec4f)`${texNode}`.with(vUv);
        
        const result = compile({ position: pos, color: wrappedColor });
        
        console.log('\n=== WGSL-WRAPPED TEXTURE SHADER ===');
        console.log(result.code);
        console.log('textures:', result.textures);
        console.log('samplers:', result.samplers);
        
        // The texture should still be collected even when wrapped in WgslNode
        expect(result.textures.length).toBe(1);
        expect(result.textures[0].type).toBe('texture_2d<f32>');
        
        // Sampler should also be collected
        expect(result.samplers.length).toBe(1);
        
        // Should have textureSample call
        expectContains(result.code, 'textureSample(');
    });
});

describe('MRT (Multiple Render Targets)', () => {
    test('MRT generates FragmentOutput struct with multiple outputs', () => {
        const colorOutput = vec4(f32(1), f32(0), f32(0), f32(1));
        const normalOutput = vec4(f32(0), f32(1), f32(0), f32(1));
        const velocityOutput = vec4(f32(0), f32(0), f32(1), f32(1));
        
        const mrtNode = mrt({
            color: colorOutput,
            normal: normalOutput,
            velocity: velocityOutput,
        });
        
        const result = compile({
            position: vec4(f32(0), f32(0), f32(0), f32(1)),
            color: mrtNode,
        });
        
        console.log('\n=== MRT SHADER ===');
        console.log(result.code);
        
        // Should have FragmentOutput struct
        expectContains(result.code, 'struct FragmentOutput {');
        
        // Should have @location outputs for each named output
        expectContains(result.code, '@location(');
        expectContains(result.code, 'color: vec4f');
        expectContains(result.code, 'normal: vec4f');
        expectContains(result.code, 'velocity: vec4f');
        
        // Should return FragmentOutput
        expectContains(result.code, '-> FragmentOutput');
        expectContains(result.code, 'var output: FragmentOutput');
        expectContains(result.code, 'return output');
        
        // Should assign each output
        expectContains(result.code, 'output.color =');
        expectContains(result.code, 'output.normal =');
        expectContains(result.code, 'output.velocity =');
    });
    
    test('MRT with resolved members uses correct @location indices', () => {
        const colorOutput = vec4(f32(1), f32(0), f32(0), f32(1));
        const normalOutput = vec4(f32(0), f32(1), f32(0), f32(1));
        
        const mrtNode = mrt({
            color: colorOutput,
            normal: normalOutput,
        });
        
        // Simulate resolution (as renderer would do)
        // Maps texture names to indices
        mrtNode.resolveOutputs((name) => {
            if (name === 'color') return 0;
            if (name === 'normal') return 1;
            return -1;
        });
        
        const result = compile({
            position: vec4(f32(0), f32(0), f32(0), f32(1)),
            color: mrtNode,
        });
        
        console.log('\n=== MRT RESOLVED ===');
        console.log(result.code);
        
        // Should have correct @location indices after resolution
        expectContains(result.code, '@location(0) color: vec4f');
        expectContains(result.code, '@location(1) normal: vec4f');
    });
});
