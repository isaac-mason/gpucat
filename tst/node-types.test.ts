/**
 * Type tests for node arithmetic operations.
 * 
 * These tests verify that the type system correctly infers result types
 * for chained arithmetic operations.
 */
import { describe, it, expectTypeOf } from 'vitest';
import {
    Node,
    f32,
    vec3f,
    vec4f,
    add,
    sub,
    div,
    mul,
    type ArithResult,
    type MulResult,
} from '../src/nodes/nodes';

describe('ArithResult type', () => {
    it('scalar op scalar → scalar', () => {
        expectTypeOf<ArithResult<'f32', 'f32'>>().toEqualTypeOf<'f32'>();
        expectTypeOf<ArithResult<'i32', 'i32'>>().toEqualTypeOf<'i32'>();
    });

    it('vector op vector → vector', () => {
        expectTypeOf<ArithResult<'vec3f', 'vec3f'>>().toEqualTypeOf<'vec3f'>();
        expectTypeOf<ArithResult<'vec4f', 'vec4f'>>().toEqualTypeOf<'vec4f'>();
    });

    it('scalar op vector → vector', () => {
        expectTypeOf<ArithResult<'f32', 'vec3f'>>().toEqualTypeOf<'vec3f'>();
        expectTypeOf<ArithResult<'f32', 'vec4f'>>().toEqualTypeOf<'vec4f'>();
    });

    it('vector op scalar → vector', () => {
        expectTypeOf<ArithResult<'vec3f', 'f32'>>().toEqualTypeOf<'vec3f'>();
        expectTypeOf<ArithResult<'vec4f', 'f32'>>().toEqualTypeOf<'vec4f'>();
    });
});

describe('MulResult type', () => {
    it('scalar op scalar → scalar', () => {
        expectTypeOf<MulResult<'f32', 'f32'>>().toEqualTypeOf<'f32'>();
    });

    it('vector op vector → vector', () => {
        expectTypeOf<MulResult<'vec3f', 'vec3f'>>().toEqualTypeOf<'vec3f'>();
    });

    it('scalar op vector → vector', () => {
        expectTypeOf<MulResult<'f32', 'vec3f'>>().toEqualTypeOf<'vec3f'>();
    });

    it('vector op scalar → vector', () => {
        expectTypeOf<MulResult<'vec3f', 'f32'>>().toEqualTypeOf<'vec3f'>();
    });

    it('mat4 op vec4 → vec4', () => {
        expectTypeOf<MulResult<'mat4x4f', 'vec4f'>>().toEqualTypeOf<'vec4f'>();
    });

    it('mat4 op mat4 → mat4', () => {
        expectTypeOf<MulResult<'mat4x4f', 'mat4x4f'>>().toEqualTypeOf<'mat4x4f'>();
    });
});

describe('Node arithmetic method types', () => {
    it('f32.add(f32) → Node<f32>', () => {
        const a = f32(1);
        const b = f32(2);
        const result = a.add(b);
        expectTypeOf(result).toEqualTypeOf<Node<'f32'>>();
    });

    it('f32.sub(f32) → Node<f32>', () => {
        const a = f32(1);
        const b = f32(2);
        const result = a.sub(b);
        expectTypeOf(result).toEqualTypeOf<Node<'f32'>>();
    });

    it('f32.mul(f32) → Node<f32>', () => {
        const a = f32(1);
        const b = f32(2);
        const result = a.mul(b);
        expectTypeOf(result).toEqualTypeOf<Node<'f32'>>();
    });

    it('f32.div(f32) → Node<f32>', () => {
        const a = f32(1);
        const b = f32(2);
        const result = a.div(b);
        expectTypeOf(result).toEqualTypeOf<Node<'f32'>>();
    });

    it('vec3f.add(vec3f) → Node<vec3f>', () => {
        const a = vec3f(1, 2, 3);
        const b = vec3f(4, 5, 6);
        const result = a.add(b);
        expectTypeOf(result).toEqualTypeOf<Node<'vec3f'>>();
    });

    it('vec3f.mul(f32) → Node<vec3f>', () => {
        const a = vec3f(1, 2, 3);
        const b = f32(2);
        const result = a.mul(b);
        expectTypeOf(result).toEqualTypeOf<Node<'vec3f'>>();
    });

    it('f32.mul(vec3f) → Node<vec3f>', () => {
        const a = f32(2);
        const b = vec3f(1, 2, 3);
        const result = a.mul(b);
        expectTypeOf(result).toEqualTypeOf<Node<'vec3f'>>();
    });
});

describe('Standalone function types', () => {
    it('add(f32, f32) → Node<f32>', () => {
        const result = add(f32(1), f32(2));
        expectTypeOf(result).toEqualTypeOf<Node<'f32'>>();
    });

    it('sub(vec3f, vec3f) → Node<vec3f>', () => {
        const result = sub(vec3f(1, 2, 3), vec3f(4, 5, 6));
        expectTypeOf(result).toEqualTypeOf<Node<'vec3f'>>();
    });

    it('mul(f32, vec4f) → Node<vec4f>', () => {
        const result = mul(f32(2), vec4f(1, 2, 3, 4));
        expectTypeOf(result).toEqualTypeOf<Node<'vec4f'>>();
    });

    it('div(vec4f, f32) → Node<vec4f>', () => {
        const result = div(vec4f(1, 2, 3, 4), f32(2));
        expectTypeOf(result).toEqualTypeOf<Node<'vec4f'>>();
    });
});

describe('Chained operations preserve types', () => {
    it('f32.mul(f32).div(f32) → Node<f32>', () => {
        const a = f32(1);
        const b = f32(2);
        const c = f32(3);
        const result = a.mul(b).div(c);
        expectTypeOf(result).toEqualTypeOf<Node<'f32'>>();
    });

    it('f32.add(f32).sub(f32).mul(f32).div(f32) → Node<f32>', () => {
        const a = f32(1);
        const b = f32(2);
        const c = f32(3);
        const d = f32(4);
        const e = f32(5);
        const result = a.add(b).sub(c).mul(d).div(e);
        expectTypeOf(result).toEqualTypeOf<Node<'f32'>>();
    });

    it('vec3f.mul(f32).add(vec3f) → Node<vec3f>', () => {
        const a = vec3f(1, 2, 3);
        const b = f32(2);
        const c = vec3f(4, 5, 6);
        const result = a.mul(b).add(c);
        expectTypeOf(result).toEqualTypeOf<Node<'vec3f'>>();
    });

    it('complex depth calculation stays f32', () => {
        // This is the pattern from pass-node.ts getViewZNode
        const near = f32(0.1);
        const far = f32(100);
        const depth = f32(0.5);
        
        // viewZ = near.mul(far).div(far.sub(near).mul(depth).sub(far))
        const viewZ = near
            .mul(far)
            .div(far.sub(near).mul(depth).sub(far));
        
        expectTypeOf(viewZ).toEqualTypeOf<Node<'f32'>>();
    });
});
