import { describe, test, expect } from 'vitest';
import {
    struct, vec3, f32, i32, Fn, Loop, If, Break, Continue,
    Return, sin, Const, Var,
    compileCompute,
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
