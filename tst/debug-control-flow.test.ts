import { describe, test, expect } from 'vitest';
import { Fn, f32, i32, u32, Loop, If, Break, Continue, Return, vec4, sin, cos, uniform, objectGroup, Uniform, UniformNode } from '../src/nodes/nodes';
import { compile, compileCompute } from '../src/nodes/builder';
import * as d from '../src/schema/schema';

describe('complex control flow', () => {
    test('ElseIf chaining', () => {
        const x = new UniformNode(new Uniform(d.f32, 0, objectGroup), 'x');
        
        const myFn = Fn(() => {
            const result = f32(0).toVar('result');
            
            // Using ElseIf for flat else-if chains
            If(x.greaterThan(f32(10)), () => {
                result.assign(f32(100));
            }).ElseIf(x.greaterThan(f32(5)), () => {
                result.assign(f32(50));
            }).ElseIf(x.greaterThan(f32(0)), () => {
                result.assign(f32(10));
            }).Else(() => {
                result.assign(f32(0));
            });
        });
        
        const result = compileCompute(myFn.compute({ workgroupSize: [64, 1, 1] }));
        console.log('\n=== ELSEIF CHAINING ===');
        console.log(result.code);
        
        // Should have flat if/else-if/else structure (not nested)
        expect(result.code).toContain('if ((uniforms_object.x > 10.0))');
        expect(result.code).toContain('} else if ((uniforms_object.x > 5.0))');
        expect(result.code).toContain('} else if ((uniforms_object.x > 0.0))');
        expect(result.code).toContain('} else {');
        
        // Should NOT be nested (only one closing brace before else if)
        const lines = result.code.split('\n');
        const elseIfLines = lines.filter(l => l.includes('} else if ('));
        expect(elseIfLines.length).toBe(2);
    });

    test('nested if/else (legacy style)', () => {
        const x = new UniformNode(new Uniform(d.f32, 0, objectGroup), 'x');
        
        const myFn = Fn(() => {
            const result = f32(0).toVar('result');
            
            // Nested if/else (old style still works)
            If(x.greaterThan(f32(10)), () => {
                result.assign(f32(100));
            }).Else(() => {
                If(x.greaterThan(f32(5)), () => {
                    result.assign(f32(50));
                }).Else(() => {
                    If(x.greaterThan(f32(0)), () => {
                        result.assign(f32(10));
                    }).Else(() => {
                        result.assign(f32(0));
                    });
                });
            });
        });
        
        const result = compileCompute(myFn.compute({ workgroupSize: [64, 1, 1] }));
        console.log('\n=== NESTED IF/ELSE (LEGACY) ===');
        console.log(result.code);
        
        // Should have if, else structure (nested style)
        expect(result.code).toContain('if (');
        expect(result.code).toContain('} else {');
    });

    test('if inside loop with break/continue', () => {
        const myFn = Fn(() => {
            const sum = f32(0).toVar('sum');
            
            Loop(100, ({ i }) => {
                If(i.equal(i32(50)), () => {
                    Break();
                });
                
                If(i.lessThan(i32(10)), () => {
                    Continue();
                });
                
                sum.assign(sum.add(i.toF32()));
            });
        });
        
        const result = compileCompute(myFn.compute({ workgroupSize: [64, 1, 1] }));
        console.log('\n=== IF INSIDE LOOP WITH BREAK/CONTINUE ===');
        console.log(result.code);
        
        expect(result.code).toContain('break;');
        expect(result.code).toContain('continue;');
    });

    test('loop inside if branches', () => {
        const flag = new UniformNode(new Uniform(d.i32, 0, objectGroup), 'flag');
        
        const myFn = Fn(() => {
            const sum = f32(0).toVar('sum');
            
            If(flag.greaterThan(i32(0)), () => {
                Loop(10, ({ i }) => {
                    sum.assign(sum.add(i.toF32()));
                });
            }).Else(() => {
                Loop(5, ({ i }) => {
                    sum.assign(sum.mul(i.toF32()));
                });
            });
        });
        
        const result = compileCompute(myFn.compute({ workgroupSize: [64, 1, 1] }));
        console.log('\n=== LOOP INSIDE IF BRANCHES ===');
        console.log(result.code);
        
        // Both loops should have unique variable names
        const loopVars = result.code.match(/i_\d+_\d+/g) ?? [];
        const uniqueVars = new Set(loopVars);
        expect(uniqueVars.size).toBe(2);
    });

    test('deeply nested control flow', () => {
        const myFn = Fn(() => {
            const sum = f32(0).toVar('sum');
            
            Loop(3, ({ i: outerI }) => {
                If(outerI.greaterThan(i32(0)), () => {
                    Loop(4, ({ i: innerI }) => {
                        If(innerI.lessThan(i32(2)), () => {
                            sum.assign(sum.add(f32(1)));
                        }).Else(() => {
                            sum.assign(sum.sub(f32(1)));
                        });
                    });
                });
            });
        });
        
        const result = compileCompute(myFn.compute({ workgroupSize: [64, 1, 1] }));
        console.log('\n=== DEEPLY NESTED CONTROL FLOW ===');
        console.log(result.code);
        
        // Check proper indentation increases
        const lines = result.code.split('\n');
        const indentedLines = lines.filter(l => l.trim().length > 0);
        // Find the most indented line
        const maxIndent = Math.max(...indentedLines.map(l => l.match(/^(\s*)/)?.[1].length ?? 0));
        // Should have significant nesting (at least 5 levels: fn body + loop + if + loop + if)
        expect(maxIndent).toBeGreaterThanOrEqual(20); // 5 levels * 4 spaces
    });
});

describe('CSE (Common Subexpression Elimination)', () => {
    test('reused expression gets extracted within vertex shader', () => {
        const expensive = sin(f32(1).add(f32(2)));
        
        // Use expensive twice in position (vertex shader only)
        const pos = vec4(expensive, expensive, f32(0), f32(1));
        const color = vec4(f32(1), f32(0), f32(0), f32(1)); // No expensive here
        
        const result = compile({ position: pos, color });
        console.log('\n=== CSE - REUSED EXPRESSION (VERTEX ONLY) ===');
        console.log(result.code);
        
        // sin(1.0 + 2.0) should appear only once in vertex shader, extracted to _v0
        // Count in vertex shader portion only
        const vertexShader = result.code.split('// Fragment Shader')[0];
        const sinCalls = vertexShader.match(/sin\(/g)?.length ?? 0;
        expect(sinCalls).toBe(1);
        
        // Should have a CSE variable like _v0
        expect(vertexShader).toMatch(/_v\d+/);
    });

    test('complex expression reused multiple times', () => {
        const a = f32(1);
        const b = f32(2);
        const c = f32(3);
        const complex = sin(a.add(b)).mul(cos(c));
        
        // Use it 3 times
        const pos = vec4(complex, complex, complex, f32(1));
        const color = vec4(f32(1), f32(0), f32(0), f32(1));
        
        const result = compile({ position: pos, color });
        console.log('\n=== CSE - COMPLEX EXPRESSION 3x ===');
        console.log(result.code);
        
        // sin should appear once, cos should appear once
        const sinCalls = result.code.match(/sin\(/g)?.length ?? 0;
        const cosCalls = result.code.match(/cos\(/g)?.length ?? 0;
        expect(sinCalls).toBe(1);
        expect(cosCalls).toBe(1);
    });

    test('independent expressions not merged', () => {
        const a = sin(f32(1));
        const b = sin(f32(2)); // Different arg, should not merge
        
        const pos = vec4(a, b, f32(0), f32(1));
        const color = vec4(f32(1), f32(0), f32(0), f32(1));
        
        const result = compile({ position: pos, color });
        console.log('\n=== CSE - INDEPENDENT EXPRESSIONS ===');
        console.log(result.code);
        
        // Both sin calls should remain (different arguments)
        const sinCalls = result.code.match(/sin\(/g)?.length ?? 0;
        expect(sinCalls).toBe(2);
    });
});

describe('Var and toVar', () => {
    test('toVar creates mutable variable', () => {
        const myFn = Fn(() => {
            const x = f32(0).toVar('myX');
            x.assign(f32(10));
            x.assign(x.add(f32(5)));
        });
        
        const result = compileCompute(myFn.compute({ workgroupSize: [64, 1, 1] }));
        console.log('\n=== toVar MUTABLE VARIABLE ===');
        console.log(result.code);
        
        // Should have var declaration and assignments
        expect(result.code).toContain('var ');
        expect(result.code).toContain('myX');
        expect(result.code).toMatch(/= 10\.0/);
        expect(result.code).toMatch(/= \(.*\+ 5\.0\)/);
    });

    test('toConst creates immutable variable', () => {
        const myFn = Fn(() => {
            const x = f32(42).toConst('myConst');
            // x is used but not reassigned
            const y = x.add(f32(1)).toVar('y');
            y.assign(y.mul(x));
        });
        
        const result = compileCompute(myFn.compute({ workgroupSize: [64, 1, 1] }));
        console.log('\n=== toConst IMMUTABLE VARIABLE ===');
        console.log(result.code);
        
        // Should have let for const, var for var
        expect(result.code).toContain('let ');
        expect(result.code).toContain('var ');
        expect(result.code).toContain('myConst');
    });

    test('multiple toVar with different labels', () => {
        const myFn = Fn(() => {
            const a = f32(1).toVar('alpha');
            const b = f32(2).toVar('beta');
            const c = f32(3).toVar('gamma');
            
            a.assign(b.add(c));
            b.assign(a.mul(c));
        });
        
        const result = compileCompute(myFn.compute({ workgroupSize: [64, 1, 1] }));
        console.log('\n=== MULTIPLE toVar WITH LABELS ===');
        console.log(result.code);
        
        expect(result.code).toContain('alpha');
        expect(result.code).toContain('beta');
        expect(result.code).toContain('gamma');
    });

    test('toVar without label gets auto-generated name', () => {
        const myFn = Fn(() => {
            const x = f32(0).toVar();
            const y = f32(1).toVar();
            x.assign(y);
        });
        
        const result = compileCompute(myFn.compute({ workgroupSize: [64, 1, 1] }));
        console.log('\n=== toVar WITHOUT LABEL ===');
        console.log(result.code);
        
        // Should have auto-generated var names like var_N
        expect(result.code).toMatch(/var var_\d+/);
    });
});
