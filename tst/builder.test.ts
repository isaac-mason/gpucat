import { describe, test, expect } from 'vitest';
import {
    struct, vec3, f32, i32, Fn, Loop, If, Break, Continue,
    Return, sin, Const, Var, Let, privateVar, workgroupVar,
    compileCompute, globalId, computeIndex,
} from '../src/index';
import { vec3f } from '../src/schema/schema';
import * as d from '../src/schema/schema';

describe('control flow', () => {
    test('if/else generates correct WGSL with proper condition and assignments', () => {
        const fn = Fn(() => {
            const r = f32(0).toVar('result');
            If(f32(1).greaterThan(f32(0)), () => {
                r.assign(f32(1));
            }).Else(() => {
                r.assign(f32(0));
            });
        });

        const result = compileCompute(fn.compute({ workgroupSize: [64, 1, 1] }));
        
        expect(result.code).toContain('if ((1.0 > 0.0))');
        expect(result.code).toContain('} else {');
        expect(result.code).toContain('result = 1.0');
        expect(result.code).toContain('result = 0.0');
    });

    test('ElseIf chaining generates flat structure with all conditions', () => {
        const fn = Fn(() => {
            const result = f32(0).toVar('result');
            If(f32(15).greaterThan(f32(10)), () => {
                result.assign(f32(100));
            }).ElseIf(f32(7).greaterThan(f32(5)), () => {
                result.assign(f32(50));
            }).ElseIf(f32(2).greaterThan(f32(0)), () => {
                result.assign(f32(10));
            }).Else(() => {
                result.assign(f32(0));
            });
        });

        const result = compileCompute(fn.compute({ workgroupSize: [64, 1, 1] }));

        expect(result.code).toContain('if ((15.0 > 10.0))');
        expect(result.code).toContain('} else if ((7.0 > 5.0))');
        expect(result.code).toContain('} else if ((2.0 > 0.0))');
        expect(result.code).toContain('} else {');
        expect(result.code).toContain('result = 100.0');
        expect(result.code).toContain('result = 50.0');
        expect(result.code).toContain('result = 10.0');
        expect(result.code).toContain('result = 0.0');

        const lines = result.code.split('\n');
        const elseIfLines = lines.filter(l => l.includes('} else if ('));
        expect(elseIfLines.length).toBe(2);
    });

    test('loop with break and continue in correct positions', () => {
        const fn = Fn(() => {
            const sum = f32(0).toVar('sum');
            Loop(100, ({ i }) => {
                If(i.equal(i32(50)), () => Break());
                If(i.lessThan(i32(10)), () => Continue());
                sum.assign(sum.add(i.toF32()));
            });
        });

        const result = compileCompute(fn.compute({ workgroupSize: [64, 1, 1] }));

        expect(result.code).toContain('for (var i_0_0: i32 = 0i; i_0_0 < 100i; i_0_0++)');
        expect(result.code).toContain('if ((i_0_0 == 50i))');
        expect(result.code).toContain('break;');
        expect(result.code).toContain('if ((i_0_0 < 10i))');
        expect(result.code).toContain('continue;');
        expect(result.code).toMatch(/_sum.*=.*\(.*\+ f32\(i_0_0\)\)/);
    });

    test('nested loops generate unique loop variables and proper bounds', () => {
        const fn = Fn(() => {
            const sum = f32(0).toVar('sum');
            Loop(3, ({ i: outer }) => {
                Loop(4, ({ i: inner }) => {
                    sum.assign(sum.add(outer.toF32().mul(inner.toF32())));
                });
            });
        });

        const result = compileCompute(fn.compute({ workgroupSize: [64, 1, 1] }));

        expect(result.code).toContain('for (var i_0_0: i32 = 0i; i_0_0 < 3i; i_0_0++)');
        expect(result.code).toContain('for (var i_1_1: i32 = 0i; i_1_1 < 4i; i_1_1++)');
        expect(result.code).toMatch(/_sum.*=.*\(.*\+.*f32\(i_0_0\).*\*.*f32\(i_1_1\).*\)/);

        const loopVars = result.code.match(/i_\d+_\d+/g) ?? [];
        const uniqueVars = new Set(loopVars);
        expect(uniqueVars.size).toBe(2);
    });
});

describe('variables', () => {
    test('Var creates mutable variable with assignment', () => {
        const fn = Fn(() => {
            const x = Var(f32(0), 'x');
            x.assign(f32(10));
            x.assign(x.add(f32(5)));
        });

        const result = compileCompute(fn.compute({ workgroupSize: [64, 1, 1] }));
        expect(result.code).toContain('var ');
        expect(result.code).toContain('= 10.0');
    });

    test('Const creates immutable let binding', () => {
        const fn = Fn(() => {
            const x = Const(f32(42), 'x');
            const y = Var(f32(0), 'y');
            y.assign(x.add(f32(1)));
        });

        const result = compileCompute(fn.compute({ workgroupSize: [64, 1, 1] }));
        expect(result.code).toContain('let ');
        expect(result.code).toContain('var ');
    });
});

describe('common subexpression elimination', () => {
    test('reused expression is extracted to temp variable', () => {
        const expensive = sin(f32(1).add(f32(2)));

        const fn = Fn(() => {
            Return(expensive);
            Return(expensive);
        });

        const result = compileCompute(fn.compute({ workgroupSize: [64, 1, 1] }));

        const sinCalls = result.code.match(/sin\(/g)?.length ?? 0;
        expect(sinCalls).toBe(1);
        expect(result.code).toMatch(/_v\d+/);
    });

    test('independent expressions with same fn are not merged', () => {
        const fn = Fn(() => {
            Return(sin(f32(1)));
            Return(sin(f32(2)));
        });

        const result = compileCompute(fn.compute({ workgroupSize: [64, 1, 1] }));

        const sinCalls = result.code.match(/sin\(/g)?.length ?? 0;
        expect(sinCalls).toBe(2);
    });
});

describe('struct.construct', () => {
    test('construct generates WGSL struct constructor', () => {
        const MyStruct = struct('MyStruct', {
            pos: vec3f,
            mass: d.f32,
        });

        const fn = Fn(() => {
            const s = MyStruct.construct({
                pos: vec3(f32(1), f32(2), f32(3)),
                mass: f32(4),
            });
            Return(s);
        });

        const result = compileCompute(fn.compute({ workgroupSize: [64, 1, 1] }));
        expect(result.code).toContain('MyStruct(vec3f(1.0, 2.0, 3.0), 4.0)');
    });

    test('construct args are in declaration order regardless of object key order', () => {
        const MyStruct = struct('MyStruct', {
            pos: vec3f,
            mass: d.f32,
        });

        const fn = Fn(() => {
            const s = MyStruct.construct({
                // Object keys in different order than declaration
                mass: f32(4),
                pos: vec3(f32(1), f32(2), f32(3)),
            });
            Return(s);
        });

        const result = compileCompute(fn.compute({ workgroupSize: [64, 1, 1] }));
        // Args should be pos first, mass second (declaration order)
        expect(result.code).toContain('MyStruct(vec3f(1.0, 2.0, 3.0), 4.0)');
        expect(result.code).not.toContain('MyStruct(4.0');
    });
});

describe('module-scope variables', () => {
    test('privateVar without initializer emits var<private> declaration', () => {
        const counter = privateVar(d.u32, 'counter');
        
        const fn = Fn(() => {
            counter.assign(counter.add(i32(1).toU32()));
        });
        
        const result = compileCompute(fn.compute({ workgroupSize: [64, 1, 1] }));
        
        expect(result.code).toContain('var<private> counter: u32;');
        // i32(1).toU32() generates u32(1i)
        expect(result.code).toContain('counter = (counter + u32(1i))');
    });
    
    test('privateVar with literal initializer emits var<private> with init', () => {
        const scale = privateVar(f32(2.5), 'scale');
        
        const fn = Fn(() => {
            const x = Var(f32(1), 'x');
            x.assign(x.mul(scale));
        });
        
        const result = compileCompute(fn.compute({ workgroupSize: [64, 1, 1] }));
        
        expect(result.code).toContain('var<private> scale: f32 = 2.5;');
    });
    
    test('privateVar with vec3 initializer emits proper constructor', () => {
        const gravity = privateVar(vec3(f32(0), f32(-9.8), f32(0)), 'gravity');
        
        const fn = Fn(() => {
            const vel = Var(vec3(f32(0), f32(0), f32(0)), 'vel');
            vel.assign(vel.add(gravity));
        });
        
        const result = compileCompute(fn.compute({ workgroupSize: [64, 1, 1] }));
        
        expect(result.code).toContain('var<private> gravity: vec3f = vec3f(0.0, -9.8, 0.0);');
    });
    
    test('workgroupVar emits var<workgroup> declaration', () => {
        const shared = workgroupVar(d.sizedArray(d.f32, 256), 'sharedData');
        
        const fn = Fn(() => {
            shared.element(i32(0)).assign(f32(42));
        });
        
        const result = compileCompute(fn.compute({ workgroupSize: [64, 1, 1] }));
        
        expect(result.code).toContain('var<workgroup> sharedData: array<f32, 256>;');
    });
    
    test('multiple module-scope vars are emitted before functions', () => {
        const counter = privateVar(d.u32, 'counter');
        const shared = workgroupVar(d.sizedArray(d.u32, 64), 'sharedBuf');
        
        const fn = Fn(() => {
            shared.element(i32(0)).assign(counter);
            counter.assign(counter.add(i32(1).toU32()));
        });
        
        const result = compileCompute(fn.compute({ workgroupSize: [64, 1, 1] }));
        
        // Both vars should be declared
        expect(result.code).toContain('var<private> counter: u32;');
        expect(result.code).toContain('var<workgroup> sharedBuf: array<u32, 64>;');
        
        // Module-scope vars should appear before the compute function
        const privateIdx = result.code.indexOf('var<private>');
        const workgroupIdx = result.code.indexOf('var<workgroup>');
        const fnIdx = result.code.indexOf('@compute');
        
        expect(privateIdx).toBeLessThan(fnIdx);
        expect(workgroupIdx).toBeLessThan(fnIdx);
    });
    
    test('Let creates immutable let binding (same as deprecated Const)', () => {
        const fn = Fn(() => {
            const x = Let(f32(42), 'immutable');
            const y = Var(f32(0), 'mutable');
            y.assign(x.add(f32(1)));
        });

        const result = compileCompute(fn.compute({ workgroupSize: [64, 1, 1] }));
        expect(result.code).toContain('let ');
        expect(result.code).toContain('var ');
    });
});

describe('compute builtins', () => {
    test('globalId builtin only includes global_invocation_id', () => {
        const fn = Fn(() => {
            // Use globalId.x in an expression to trigger builtin inclusion
            const idx = globalId.x.toVar('idx');
            idx.assign(idx.add(i32(1)));
        });

        const result = compileCompute(fn.compute({ workgroupSize: [64, 1, 1] }));
        expect(result.code).toContain('@builtin(global_invocation_id) global_id: vec3u');
        expect(result.code).not.toContain('@builtin(num_workgroups)');
        expect(result.code).not.toContain('var<private> computeIndex');
    });
    
    test('computeIndex includes global_invocation_id and num_workgroups', () => {
        const fn = Fn(() => {
            // Use computeIndex in an expression to trigger builtin inclusion
            const idx = computeIndex.toVar('idx');
            idx.assign(idx.add(i32(1)));
        });

        const result = compileCompute(fn.compute({ workgroupSize: [64, 1, 1] }));
        expect(result.code).toContain('@builtin(global_invocation_id) global_id: vec3u');
        expect(result.code).toContain('@builtin(num_workgroups) num_workgroups: vec3u');
        expect(result.code).toContain('var<private> computeIndex: u32;');
        expect(result.code).toContain('computeIndex = global_id.x');
    });
    
    test('compute shader without builtins has empty parameter list', () => {
        const fn = Fn(() => {
            const x = f32(1).toVar('x');
            x.assign(f32(2));
        });

        const result = compileCompute(fn.compute({ workgroupSize: [64, 1, 1] }));
        expect(result.code).not.toContain('@builtin');
    });
});
