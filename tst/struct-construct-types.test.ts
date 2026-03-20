import { expectTypeOf, test } from 'vitest';
import {
    struct, vec3, f32,
} from '../src/index';
import { vec3f } from '../src/schema/schema';
import type { Node } from '../src/nodes/lib/core';
import * as d from '../src/schema/schema';

const Particle = struct('Particle', {
    pos: vec3f,
    vel: vec3f,
    mass: d.f32,
});

test('construct has named-field type safety', () => {
    const pos = undefined as unknown as Node<typeof vec3f>;
    const vel = undefined as unknown as Node<typeof vec3f>;
    const mass = undefined as unknown as Node<typeof d.f32>;

    expectTypeOf(Particle.construct).toBeCallableWith({ pos, vel, mass });
});

test('construct rejects wrong type', () => {
    const pos = undefined as unknown as Node<typeof vec3f>;
    const vel = undefined as unknown as Node<typeof d.f32>;
    const mass = undefined as unknown as Node<typeof d.f32>;

    // @ts-expect-error vel should be vec3f
    Particle.construct({ pos, vel, mass });
});

test('construct rejects missing field', () => {
    const pos = undefined as unknown as Node<typeof vec3f>;
    const mass = undefined as unknown as Node<typeof d.f32>;

    // @ts-expect-error missing vel field
    Particle.construct({ pos, mass });
});

test('construct rejects extra field', () => {
    const pos = undefined as unknown as Node<typeof vec3f>;
    const vel = undefined as unknown as Node<typeof vec3f>;
    const mass = undefined as unknown as Node<typeof d.f32>;

    // @ts-expect-error extra field
    Particle.construct({ pos, vel, mass, extra: undefined as unknown as Node<typeof d.f32> });
});
