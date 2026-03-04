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
    CallNode,
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
        const heatmap = Fn([S.vec2f()], (uv): Node<'vec3f'> => {
            const result = toVar('vec3f', vec3f(0, 0, 0));
            If(uv.x.gt(f32(0.5)), () => {
                result.assign(vec3f(1, 0, 0));
            }).Else(() => {
                result.assign(vec3f(0, 0, 1));
            });
            return result;
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
        const myFn = Fn([S.f32()], (x: Node<'f32'>): Node<'f32'> => {
            capturedVar = toVar('f32', x);
            return capturedVar;
        });
        const arg = f32(1.0);
        myFn(arg); // trigger trace (Fn traces eagerly to get return type)
        // The var should have been created
        expect(capturedVar).not.toBeNull();
        expect((capturedVar as VarNode<'f32'>).kind).toBe('var');
        expect((capturedVar as VarNode<'f32'>).type).toBe('f32');
    });

    test('IfNode has thenBody and elseBody after Else chain', () => {
        let capturedIf: IfNode | null = null;
        Fn([S.f32()], (x: Node<'f32'>): Node<'f32'> => {
            const result = toVar('f32', f32(0.0));
            // Intercept to capture the IfNode — we check the stack body
            const cond = x.gt(f32(0.5));
            If(cond, () => {
                result.assign(f32(1.0));
            }).Else(() => {
                result.assign(f32(-1.0));
            });
            return result;
        });
        // We can't capture IfNode directly without tracing, but we can check
        // by tracing via a FnNode
        const fnNode = new FnNode<'f32'>('f32', [S.f32()], (x: Node<'f32'>) => {
            const result = toVar('f32', f32(0.0));
            // Intercept to capture the IfNode — we check the stack body
            const cond = x.gt(f32(0.5));
            capturedIf = null;
            If(cond, () => {
                result.assign(f32(1.0));
            }).Else(() => {
                result.assign(f32(-1.0));
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
    test('ForNode is created with correct count and body', () => {
        const fnNode = new FnNode<'f32'>('f32', [S.u32()], (n: Node<'u32'>) => {
            const acc = toVar('f32', f32(0.0));
            For({ count: n }, ({ i }) => {
                acc.assign(acc.add(i.toF32()));
            });
            return acc;
        });

        const { body } = fnNode.trace();
        // body: [VarNode(acc), ForNode]
        expect(body.body.length).toBe(2);
        const forStmt = body.body[1] as ForNode;
        expect(forStmt.kind).toBe('for');
        expect(forStmt.count.type).toBe('u32');
        expect(forStmt.indexVar.type).toBe('u32');
        expect(forStmt.body).toBeInstanceOf(StackNode);
        // body of loop: [AssignNode]
        expect(forStmt.body.body.length).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// 4. Early Return
// ---------------------------------------------------------------------------

describe('Return inside Fn', () => {
    test('ReturnNode is pushed onto stack', () => {
        const fnNode = new FnNode<'f32'>('f32', [S.f32()], (x: Node<'f32'>) => {
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
            For({ count: u32(4) }, () => {});
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
        const fnNode = new FnNode<'f32'>('f32', [S.f32()], (x: Node<'f32'>) => {
            return toVar('f32', x);
        });
        const { body } = fnNode.trace();
        const varNode = body.body[0] as VarNode<'f32'>;
        const deps = depsOf(varNode as Node<WgslType>);
        expect(deps.length).toBe(1);
        expect(deps[0]).toBe(varNode.init);
    });

    test('if deps = [condition, thenBody] or [condition, thenBody, elseBody]', () => {
        const fnNode = new FnNode<'void'>('void', [S.f32()], (x: Node<'f32'>) => {
            const v = toVar('f32', f32(0.0));
            If(x.gt(f32(0.0)), () => {
                v.assign(f32(1.0));
            }).Else(() => {
                v.assign(f32(-1.0));
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

    test('for deps = [count, indexVar, body]', () => {
        const fnNode = new FnNode<'f32'>('f32', [S.u32()], (n: Node<'u32'>) => {
            const acc = toVar('f32', f32(0.0));
            For({ count: n }, ({ i }) => {
                acc.assign(i.toF32());
            });
            return acc;
        });
        const { body } = fnNode.trace();
        const forStmt = body.body[1] as ForNode;
        const deps = depsOf(forStmt as Node<WgslType>);
        expect(deps.length).toBe(3);
        expect(deps[0]).toBe(forStmt.count);
        expect(deps[1]).toBe(forStmt.indexVar);
        expect(deps[2]).toBe(forStmt.body);
    });

    test('return deps = [value]', () => {
        const fnNode = new FnNode<'f32'>('f32', [S.f32()], (x: Node<'f32'>) => {
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
        const fnNode = new FnNode<'f32'>('f32', [S.f32()], (x: Node<'f32'>) => x);
        const { params } = fnNode.trace();
        const deps = depsOf(params[0] as Node<WgslType>);
        expect(deps).toEqual([]);
    });

    test('fn deps = []', () => {
        const fnNode = new FnNode<'f32'>('f32', [S.f32()], (x: Node<'f32'>) => x);
        const deps = depsOf(fnNode as Node<WgslType>);
        expect(deps).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// 7. Fn produces a stable FnNode and callable
// ---------------------------------------------------------------------------

describe('Fn DSL', () => {
    test('Fn returns a callable that produces CallNode with fnNode reference', () => {
        const double = Fn([S.f32()], (x: Node<'f32'>): Node<'f32'> => {
            return x.mul(f32(2.0));
        });

        const arg = f32(5.0);
        const result = double(arg);
        expect(result).toBeInstanceOf(CallNode);
        expect(result.type).toBe('f32');
        expect((result as CallNode<'f32'>).fnNode).not.toBeUndefined();
        expect((result as CallNode<'f32'>).fnNode).toBeInstanceOf(FnNode);
    });

    test('Fn with vec3f param', () => {
        const invert = Fn([S.vec3f()], (c: Node<'vec3f'>): Node<'vec3f'> => {
            return vec3f(1, 1, 1).sub(c);
        });

        const color = attribute('vec3f', 'color');
        const result = invert(color);
        expect(result.type).toBe('vec3f');
    });
});
