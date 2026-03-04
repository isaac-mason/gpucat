/**
 * Smoke tests for src/nodes/nodes.ts
 *
 * These tests verify:
 *  1. Pure expression graph construction (no Fn, no control flow)
 *  2. toVar + If/Else inside a Fn body
 *  3. For loop inside a Fn body
 *  4. Early Return inside a Fn body
 *  5. Fn called with arguments produces a CallNode
 *  6. Errors thrown when control flow used outside Fn
 *  7. collect.ts depsOf handles all new node kinds
 */

import { describe, expect, test } from 'vitest';
import { collectGraph, depsOf } from '../src/nodes/collect.js';
import {
    attribute,
    bool,
    Break,
    BreakNode,
    CallNode,
    Continue,
    ContinueNode,
    f32,
    Fn,
    FnNode,
    For,
    type ForNode,
    If,
    type IfNode,
    konst,
    type Node,
    Return,
    type ReturnNode,
    StackNode,
    toVar,
    u32,
    type VarNode,
    vec3f,
    vec4,
    While,
    WhileNode,
    type WgslType,
} from '../src/nodes/nodes.js';
import * as S from '../src/nodes/schema.js';

// ---------------------------------------------------------------------------
// 1. Pure expression graph
// ---------------------------------------------------------------------------

describe('pure expression graph', () => {
    test('konst node has stable content-addressed id', () => {
        const a = f32(1.0);
        const b = f32(1.0);
        expect(a.id).toBe(b.id);
        expect(a.kind).toBe('const');
        expect(a.type).toBe('f32');
    });

    test('binop nodes chain correctly', () => {
        const x = attribute('f32', 'x');
        const y = attribute('f32', 'y');
        const sum = x.add(y);
        expect(sum.kind).toBe('binop');
        expect(sum.type).toBe('f32');
    });

    test('comparison operators return bool', () => {
        const x = f32(1.0);
        const y = f32(2.0);
        expect(x.gt(y).type).toBe('bool');
        expect(x.lt(y).type).toBe('bool');
        expect(x.gte(y).type).toBe('bool');
        expect(x.lte(y).type).toBe('bool');
        expect(x.eq(y).type).toBe('bool');
        expect(x.neq(y).type).toBe('bool');
    });

    test('toF32 conversion', () => {
        const n = u32(42);
        const f = n.toF32();
        expect(f.type).toBe('f32');
        expect(f.kind).toBe('call');
    });

    test('collectGraph traverses expression tree', () => {
        const pos = attribute('vec3f', 'position');
        const w = f32(1.0);
        const clip = vec4(pos, w);
        const g = collectGraph(clip);
        // Should contain clip, pos, w
        expect(g.nodes.size).toBe(3);
        expect(g.nodes.has(clip.id)).toBe(true);
        expect(g.nodes.has(pos.id)).toBe(true);
        expect(g.nodes.has(w.id)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// 2. toVar + If/Else
// ---------------------------------------------------------------------------

describe('toVar + If/Else inside Fn', () => {
    test('Fn traces toVar and If correctly', () => {
        const heatmap = Fn((uv: Node<WgslType>): Node<'vec3f'> => {
            const result = toVar('vec3f', vec3f(0, 0, 0)) as Node<'vec3f'>;
            If((uv as Node<'vec2f'>).x.gt(f32(0.5)), () => {
                (result as VarNode<'vec3f'>).assign(vec3f(1, 0, 0));
            }).Else(() => {
                (result as VarNode<'vec3f'>).assign(vec3f(0, 0, 1));
            });
            return result;
        }, {
            name: 'heatmap',
            params: [{ name: 'uv', type: S.vec2f() }],
        });

        // Calling the returned function should produce a CallNode
        const uvNode = attribute('vec2f', 'uv');
        const callNode = heatmap(uvNode);
        expect(callNode).toBeInstanceOf(CallNode);
        expect(callNode.type).toBe('vec3f');
        expect(callNode.kind).toBe('call');
    });

    test('VarNode is pushed onto stack during Fn trace', () => {
        let capturedVar: VarNode<'f32'> | null = null;
        const myFn = Fn((x: Node<WgslType>): Node<'f32'> => {
            capturedVar = toVar('f32', x as Node<'f32'>) as VarNode<'f32'>;
            return capturedVar;
        }, {
            name: 'myFn',
            params: [{ name: 'x', type: S.f32() }],
        });
        const arg = f32(1.0);
        myFn(arg); // trigger trace (Fn traces eagerly to get return type)
        // The var should have been created
        expect(capturedVar).not.toBeNull();
        expect(capturedVar!.kind).toBe('var');
        expect(capturedVar!.type).toBe('f32');
    });

    test('IfNode has thenBody and elseBody after Else chain', () => {
        let capturedIf: IfNode | null = null;
        Fn((x: Node<WgslType>): Node<'f32'> => {
            const result = toVar('f32', f32(0.0)) as Node<'f32'>;
            const cond = (x as Node<'f32'>).gt(f32(0.5));
            If(cond, () => {
                (result as VarNode<'f32'>).assign(f32(1.0));
            }).Else(() => {
                (result as VarNode<'f32'>).assign(f32(-1.0));
            });
            return result;
        }, {
            name: 'ifElseFn',
            params: [{ name: 'x', type: S.f32() }],
        });
        // We can't capture IfNode directly without tracing, but we can check
        // by tracing via a FnNode
        const fnNode = new FnNode<'f32'>('f32', [S.f32()], (...args: Node<WgslType>[]) => {
            const x = args[0] as Node<'f32'>;
            const result = toVar('f32', f32(0.0)) as Node<'f32'>;
            const cond = x.gt(f32(0.5));
            capturedIf = null;
            If(cond, () => {
                (result as VarNode<'f32'>).assign(f32(1.0));
            }).Else(() => {
                (result as VarNode<'f32'>).assign(f32(-1.0));
            });
            return result;
        });
        const { body } = fnNode.trace();
        // body should contain [VarNode, IfNode]
        expect(body.body.length).toBe(2);
        const ifStmt = body.body[1] as IfNode;
        expect(ifStmt.kind).toBe('if');
        expect(ifStmt.thenBody).toBeInstanceOf(StackNode);
        expect(ifStmt.elseBody).toBeInstanceOf(StackNode);
        capturedIf = ifStmt; // satisfy TS unused var check
        expect(capturedIf).not.toBeNull();
    });
});

// ---------------------------------------------------------------------------
// 3. For loop
// ---------------------------------------------------------------------------

describe('For loop inside Fn', () => {
    test('ForNode is created with correct range and body', () => {
        const fnNode = new FnNode<'f32'>('f32', [S.u32()], (...args: Node<WgslType>[]) => {
            const n = args[0] as Node<'u32'>;
            const acc = toVar('f32', f32(0.0)) as Node<'f32'>;
            For({ end: n }, ({ i }) => {
                (acc as VarNode<'f32'>).assign((acc as Node<'f32'>).add(i.toF32()));
            });
            return acc;
        });

        const { body } = fnNode.trace();
        // body: [VarNode(acc), ForNode]
        expect(body.body.length).toBe(2);
        const forStmt = body.body[1] as ForNode;
        expect(forStmt.kind).toBe('for');
        expect(forStmt.range.end).not.toBeUndefined();
        expect(forStmt.indexVar.type).toBe('u32');
        expect(forStmt.body).toBeInstanceOf(StackNode);
        // body of loop: [AssignNode]
        expect(forStmt.body.body.length).toBe(1);
    });

    test('For with numeric end creates forward loop with u32 index', () => {
        const fnNode = new FnNode<'void'>('void', [], () => {
            For({ end: 8 }, ({ i }) => {
                void i;
            });
            return konst('void', 0) as unknown as Node<'void'>;
        });
        const { body } = fnNode.trace();
        const forStmt = body.body[0] as ForNode;
        expect(forStmt.kind).toBe('for');
        expect(forStmt.range.end).toBe(8);
        expect(forStmt.range.start).toBeUndefined();
        expect(forStmt.indexVar.type).toBe('u32');
    });

    test('For with only start creates backwards loop', () => {
        const fnNode = new FnNode<'void'>('void', [], () => {
            For({ start: 10 }, ({ i }) => {
                void i;
            });
            return konst('void', 0) as unknown as Node<'void'>;
        });
        const { body } = fnNode.trace();
        const forStmt = body.body[0] as ForNode;
        expect(forStmt.kind).toBe('for');
        expect(forStmt.range.start).toBe(10);
        expect(forStmt.range.end).toBeUndefined();
        expect(forStmt.indexVar.type).toBe('u32');
    });

    test('For with explicit start, end and condition', () => {
        const fnNode = new FnNode<'void'>('void', [], () => {
            For({ start: 2, end: 10, condition: '<', update: 2 }, ({ i }) => {
                void i;
            });
            return konst('void', 0) as unknown as Node<'void'>;
        });
        const { body } = fnNode.trace();
        const forStmt = body.body[0] as ForNode;
        expect(forStmt.range.start).toBe(2);
        expect(forStmt.range.end).toBe(10);
        expect(forStmt.range.condition).toBe('<');
        expect(forStmt.range.update).toBe(2);
    });

    test('For with type i32 creates i32 index variable', () => {
        const fnNode = new FnNode<'void'>('void', [], () => {
            For({ end: 4, type: 'i32' }, ({ i }) => {
                void i;
            });
            return konst('void', 0) as unknown as Node<'void'>;
        });
        const { body } = fnNode.trace();
        const forStmt = body.body[0] as ForNode;
        expect(forStmt.indexVar.type).toBe('i32');
    });
});

// ---------------------------------------------------------------------------
// 3b. While loop
// ---------------------------------------------------------------------------

describe('While loop inside Fn', () => {
    test('WhileNode is created with condition and body', () => {
        const fnNode = new FnNode<'void'>('void', [], () => {
            const counter = toVar('u32', u32(0)) as Node<'u32'>;
            While(counter.lt(u32(10)), () => {
                (counter as VarNode<'u32'>).assign(counter.add(u32(1)));
            });
            return konst('void', 0) as unknown as Node<'void'>;
        });
        const { body } = fnNode.trace();
        const whileStmt = body.body[1] as WhileNode;
        expect(whileStmt.kind).toBe('while');
        expect(whileStmt.condition).not.toBeUndefined();
        expect(whileStmt.body).toBeInstanceOf(StackNode);
        expect(whileStmt.body.body.length).toBe(1);
    });

    test('While outside Fn throws', () => {
        expect(() => {
            While(bool(true), () => {});
        }).toThrow('[gpucat]');
    });
});

// ---------------------------------------------------------------------------
// 3c. Break and Continue
// ---------------------------------------------------------------------------

describe('Break and Continue inside loops', () => {
    test('BreakNode is pushed onto loop body stack', () => {
        const fnNode = new FnNode<'void'>('void', [], () => {
            For({ end: 10 }, ({ i }) => {
                If(i.gt(u32(5)), () => {
                    Break();
                });
            });
            return konst('void', 0) as unknown as Node<'void'>;
        });
        const { body } = fnNode.trace();
        const forStmt = body.body[0] as ForNode;
        const ifStmt = forStmt.body.body[0] as IfNode;
        const breakStmt = ifStmt.thenBody.body[0];
        expect(breakStmt.kind).toBe('break');
        expect(breakStmt).toBeInstanceOf(BreakNode);
    });

    test('ContinueNode is pushed onto loop body stack', () => {
        const fnNode = new FnNode<'void'>('void', [], () => {
            For({ end: 10 }, ({ i }) => {
                If(i.gt(u32(3)), () => {
                    Continue();
                });
            });
            return konst('void', 0) as unknown as Node<'void'>;
        });
        const { body } = fnNode.trace();
        const forStmt = body.body[0] as ForNode;
        const ifStmt = forStmt.body.body[0] as IfNode;
        const continueStmt = ifStmt.thenBody.body[0];
        expect(continueStmt.kind).toBe('continue');
        expect(continueStmt).toBeInstanceOf(ContinueNode);
    });

    test('Break outside Fn throws', () => {
        expect(() => {
            Break();
        }).toThrow('[gpucat]');
    });

    test('Continue outside Fn throws', () => {
        expect(() => {
            Continue();
        }).toThrow('[gpucat]');
    });
});

// ---------------------------------------------------------------------------
// 4. Early Return
// ---------------------------------------------------------------------------

describe('Return inside Fn', () => {
    test('ReturnNode is pushed onto stack', () => {
        const fnNode = new FnNode<'f32'>('f32', [S.f32()], (...args: Node<WgslType>[]) => {
            const x = args[0] as Node<'f32'>;
            If(x.lt(f32(0.0)), () => {
                Return(f32(0.0));
            });
            return x.mul(f32(2.0));
        });

        const { body } = fnNode.trace();
        // body: [IfNode]
        expect(body.body.length).toBe(1);
        const ifStmt = body.body[0] as IfNode;
        expect(ifStmt.kind).toBe('if');
        // thenBody: [ReturnNode]
        expect(ifStmt.thenBody.body.length).toBe(1);
        const ret = ifStmt.thenBody.body[0] as ReturnNode<'f32'>;
        expect(ret.kind).toBe('return');
        expect(ret.value.type).toBe('f32');
    });
});

// ---------------------------------------------------------------------------
// 5. Control flow outside Fn throws
// ---------------------------------------------------------------------------

describe('control flow outside Fn throws', () => {
    test('toVar outside Fn throws', () => {
        expect(() => {
            toVar('f32', f32(0.0));
        }).toThrow('[gpucat]');
    });

    test('If outside Fn throws', () => {
        expect(() => {
            If(bool(true), () => {});
        }).toThrow('[gpucat]');
    });

    test('For outside Fn throws', () => {
        expect(() => {
            For({ end: u32(4) }, () => {});
        }).toThrow('[gpucat]');
    });

    test('Return outside Fn throws', () => {
        expect(() => {
            Return(f32(0.0));
        }).toThrow('[gpucat]');
    });
});

// ---------------------------------------------------------------------------
// 6. depsOf handles new node kinds
// ---------------------------------------------------------------------------

describe('depsOf new node kinds', () => {
    test('var deps = [init]', () => {
        const fnNode = new FnNode<'f32'>('f32', [S.f32()], (...args: Node<WgslType>[]) => {
            const x = args[0] as Node<'f32'>;
            return toVar('f32', x) as Node<'f32'>;
        });
        const { body } = fnNode.trace();
        const varNode = body.body[0] as VarNode<'f32'>;
        const deps = depsOf(varNode as Node<WgslType>);
        expect(deps.length).toBe(1);
        expect(deps[0]).toBe(varNode.init);
    });

    test('if deps = [condition, thenBody] or [condition, thenBody, elseBody]', () => {
        const fnNode = new FnNode<'void'>('void', [S.f32()], (...args: Node<WgslType>[]) => {
            const x = args[0] as Node<'f32'>;
            const v = toVar('f32', f32(0.0)) as Node<'f32'>;
            If(x.gt(f32(0.0)), () => {
                (v as VarNode<'f32'>).assign(f32(1.0));
            }).Else(() => {
                (v as VarNode<'f32'>).assign(f32(-1.0));
            });
            return konst('void', 0) as unknown as Node<'void'>;
        });
        const { body } = fnNode.trace();
        const ifStmt = body.body[1] as IfNode;
        const deps = depsOf(ifStmt as Node<WgslType>);
        expect(deps.length).toBe(3); // condition, thenBody, elseBody
        expect(deps[0]).toBe(ifStmt.condition);
        expect(deps[1]).toBe(ifStmt.thenBody);
        expect(deps[2]).toBe(ifStmt.elseBody);
    });

    test('for deps = [indexVar, body, end-node] when end is a node', () => {
        const fnNode = new FnNode<'f32'>('f32', [S.u32()], (...args: Node<WgslType>[]) => {
            const n = args[0] as Node<'u32'>;
            const acc = toVar('f32', f32(0.0)) as Node<'f32'>;
            For({ end: n }, ({ i }) => {
                (acc as VarNode<'f32'>).assign(i.toF32());
            });
            return acc;
        });
        const { body } = fnNode.trace();
        const forStmt = body.body[1] as ForNode;
        const deps = depsOf(forStmt as Node<WgslType>);
        // deps: [indexVar, body, end-node] (end is a Node, not a number)
        expect(deps.length).toBe(3);
        expect(deps[0]).toBe(forStmt.indexVar);
        expect(deps[1]).toBe(forStmt.body);
        expect(deps[2]).toBe(forStmt.range.end); // the end node
    });

    test('return deps = [value]', () => {
        const fnNode = new FnNode<'f32'>('f32', [S.f32()], (...args: Node<WgslType>[]) => {
            const x = args[0] as Node<'f32'>;
            If(x.lt(f32(0.0)), () => {
                Return(f32(0.0));
            });
            return x;
        });
        const { body } = fnNode.trace();
        const ifStmt = body.body[0] as IfNode;
        const ret = ifStmt.thenBody.body[0] as ReturnNode<'f32'>;
        const deps = depsOf(ret as Node<WgslType>);
        expect(deps.length).toBe(1);
        expect(deps[0]).toBe(ret.value);
    });

    test('param deps = []', () => {
        const fnNode = new FnNode<'f32'>('f32', [S.f32()], (...args: Node<WgslType>[]) => {
            return args[0] as Node<'f32'>;
        });
        const { params } = fnNode.trace();
        const deps = depsOf(params[0] as Node<WgslType>);
        expect(deps).toEqual([]);
    });

    test('fn deps = []', () => {
        const fnNode = new FnNode<'f32'>('f32', [S.f32()], (...args: Node<WgslType>[]) => {
            return args[0] as Node<'f32'>;
        });
        const deps = depsOf(fnNode as Node<WgslType>);
        expect(deps).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// 7. Fn produces a stable FnNode and callable
// ---------------------------------------------------------------------------

describe('Fn DSL', () => {
    test('Fn returns a callable that produces CallNode with fnNode reference', () => {
        const double = Fn((x: Node<WgslType>): Node<'f32'> => {
            return (x as Node<'f32'>).mul(f32(2.0));
        }, {
            name: 'double',
            params: [{ name: 'x', type: S.f32() }],
        });

        const arg = f32(5.0);
        const result = double(arg);
        expect(result).toBeInstanceOf(CallNode);
        expect(result.type).toBe('f32');
        expect((result as CallNode<'f32'>).fnNode).not.toBeUndefined();
        expect((result as CallNode<'f32'>).fnNode).toBeInstanceOf(FnNode);
    });

    test('Fn with vec3f param', () => {
        const invert = Fn((c: Node<WgslType>): Node<'vec3f'> => {
            return vec3f(1, 1, 1).sub(c as Node<'vec3f'>);
        }, {
            name: 'invert',
            params: [{ name: 'c', type: S.vec3f() }],
        });

        const color = attribute('vec3f', 'color');
        const result = invert(color);
        expect(result.type).toBe('vec3f');
    });

    test('Fn with layout uses declared param names in emitted WGSL fn signature', () => {
        // The FnNode should carry the declared param names through to trace()
        const lerp = Fn((a: Node<WgslType>, b: Node<WgslType>, t: Node<WgslType>): Node<'f32'> => {
            const af = a as Node<'f32'>;
            const bf = b as Node<'f32'>;
            const tf = t as Node<'f32'>;
            return af.add(bf.sub(af).mul(tf));
        }, {
            name: 'lerp',
            params: [
                { name: 'a', type: S.f32() },
                { name: 'b', type: S.f32() },
                { name: 't', type: S.f32() },
            ],
        });

        // Access the FnNode via a CallNode
        const call = lerp(f32(0), f32(1), f32(0.5));
        const fnNode = (call as CallNode<'f32'>).fnNode!;
        expect(fnNode).toBeInstanceOf(FnNode);
        expect(fnNode.fnName).toBe('lerp');
        const { params } = fnNode.trace();
        expect(params[0].paramName).toBe('a');
        expect(params[1].paramName).toBe('b');
        expect(params[2].paramName).toBe('t');
    });
});
