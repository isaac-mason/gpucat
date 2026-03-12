import { describe, expect, test, beforeEach } from 'vitest';
import { GpuBuffer, BufferLifecycle } from '../src/core/gpu-buffer';
import { Geometry } from '../src/geometry/geometry';
import * as d from '../src/schema/schema';
import { trackDisposal } from './mock-gpu';

// ---------------------------------------------------------------------------
// GpuBuffer Lifecycle Tests
// ---------------------------------------------------------------------------

describe('GpuBuffer lifecycle', () => {
    describe('MANUAL lifecycle', () => {
        test('defaults to MANUAL', () => {
            const buffer = new GpuBuffer(d.vec3f, { data: new Float32Array(9) });
            expect(buffer.lifecycle).toBe(BufferLifecycle.MANUAL);
        });

        test('dispose() works for MANUAL buffers', () => {
            const buffer = new GpuBuffer(d.vec3f, { data: new Float32Array(9) });
            const tracker = trackDisposal(buffer);

            expect(buffer.disposed).toBe(false);
            buffer.dispose();
            expect(buffer.disposed).toBe(true);
            expect(tracker.disposeCount).toBe(1);
        });

        test('dispose() clears array for MANUAL buffers', () => {
            const buffer = new GpuBuffer(d.vec3f, { data: new Float32Array(9) });
            expect(buffer.array).not.toBeNull();
            buffer.dispose();
            expect(buffer.array).toBeNull();
        });

        test('dispose() is idempotent for MANUAL buffers', () => {
            const buffer = new GpuBuffer(d.vec3f, { data: new Float32Array(9) });
            const tracker = trackDisposal(buffer);

            buffer.dispose();
            buffer.dispose();
            expect(tracker.disposeCount).toBe(1);
        });

        test('increaseUsages() is no-op for MANUAL buffers', () => {
            const buffer = new GpuBuffer(d.vec3f, { data: new Float32Array(9) });
            expect(buffer._usages).toBe(0);
            buffer.increaseUsages();
            expect(buffer._usages).toBe(0);
        });

        test('decreaseUsages() is no-op for MANUAL buffers', () => {
            const buffer = new GpuBuffer(d.vec3f, { data: new Float32Array(9) });
            // Should not throw
            buffer.decreaseUsages();
            expect(buffer._usages).toBe(0);
        });
    });

    describe('REF_COUNTED lifecycle', () => {
        test('can be set via lifecycle option', () => {
            const buffer = new GpuBuffer(d.vec3f, {
                data: new Float32Array(9),
                lifecycle: BufferLifecycle.REF_COUNTED,
            });
            expect(buffer.lifecycle).toBe(BufferLifecycle.REF_COUNTED);
        });

        test('dispose() throws for REF_COUNTED buffers', () => {
            const buffer = new GpuBuffer(d.vec3f, {
                data: new Float32Array(9),
                lifecycle: BufferLifecycle.REF_COUNTED,
            });
            expect(() => buffer.dispose()).toThrow('dispose() is not valid for REF_COUNTED buffers');
        });

        test('increaseUsages() increments count', () => {
            const buffer = new GpuBuffer(d.vec3f, {
                data: new Float32Array(9),
                lifecycle: BufferLifecycle.REF_COUNTED,
            });
            expect(buffer._usages).toBe(0);
            buffer.increaseUsages();
            expect(buffer._usages).toBe(1);
            buffer.increaseUsages();
            expect(buffer._usages).toBe(2);
        });

        test('decreaseUsages() decrements count', () => {
            const buffer = new GpuBuffer(d.vec3f, {
                data: new Float32Array(9),
                lifecycle: BufferLifecycle.REF_COUNTED,
            });
            buffer.increaseUsages();
            buffer.increaseUsages();
            expect(buffer._usages).toBe(2);
            buffer.decreaseUsages();
            expect(buffer._usages).toBe(1);
        });

        test('decreaseUsages() disposes when count reaches 0', () => {
            const buffer = new GpuBuffer(d.vec3f, {
                data: new Float32Array(9),
                lifecycle: BufferLifecycle.REF_COUNTED,
            });
            const tracker = trackDisposal(buffer);

            buffer.increaseUsages();
            buffer.increaseUsages();
            buffer.decreaseUsages();
            expect(buffer.disposed).toBe(false);
            expect(tracker.disposeCount).toBe(0);

            buffer.decreaseUsages();
            expect(buffer.disposed).toBe(true);
            expect(tracker.disposeCount).toBe(1);
        });

        test('decreaseUsages() throws when already at 0', () => {
            const buffer = new GpuBuffer(d.vec3f, {
                data: new Float32Array(9),
                lifecycle: BufferLifecycle.REF_COUNTED,
            });
            expect(() => buffer.decreaseUsages()).toThrow('_usages is already 0');
        });

        test('REF_COUNTED disposal preserves array (for revival)', () => {
            const buffer = new GpuBuffer(d.vec3f, {
                data: new Float32Array(9),
                lifecycle: BufferLifecycle.REF_COUNTED,
            });
            buffer.increaseUsages();
            buffer.decreaseUsages();
            expect(buffer.disposed).toBe(true);
            expect(buffer.array).not.toBeNull();
        });

        test('increaseUsages() revives disposed buffer', () => {
            const buffer = new GpuBuffer(d.vec3f, {
                data: new Float32Array(9),
                lifecycle: BufferLifecycle.REF_COUNTED,
            });
            const initialVersion = buffer.version;

            buffer.increaseUsages();
            buffer.decreaseUsages();
            expect(buffer.disposed).toBe(true);

            buffer.increaseUsages();
            expect(buffer.disposed).toBe(false);
            expect(buffer._usages).toBe(1);
            expect(buffer.version).toBe(initialVersion + 1);
        });

        test('increaseUsages() returns this for chaining', () => {
            const buffer = new GpuBuffer(d.vec3f, {
                data: new Float32Array(9),
                lifecycle: BufferLifecycle.REF_COUNTED,
            });
            expect(buffer.increaseUsages()).toBe(buffer);
        });
    });

    describe('count option', () => {
        test('allocates array with count * itemSize', () => {
            const buffer = new GpuBuffer(d.vec3f, { count: 10 });
            expect(buffer.array).not.toBeNull();
            expect(buffer.array!.length).toBe(30); // 10 * 3
            expect(buffer.count).toBe(10);
        });

        test('uses correct TypedArray based on schema', () => {
            const f32Buffer = new GpuBuffer(d.vec3f, { count: 10 });
            expect(f32Buffer.array).toBeInstanceOf(Float32Array);

            const i32Buffer = new GpuBuffer(d.vec3i, { count: 10 });
            expect(i32Buffer.array).toBeInstanceOf(Int32Array);

            const u32Buffer = new GpuBuffer(d.vec3u, { count: 10 });
            expect(u32Buffer.array).toBeInstanceOf(Uint32Array);
        });

        test('throws when both data and count provided', () => {
            expect(() => new GpuBuffer(d.vec3f, {
                data: new Float32Array(9),
                count: 10,
            })).toThrow('provide either `data` or `count`, not both');
        });
    });
});

// ---------------------------------------------------------------------------
// Geometry Buffer Management Tests
// ---------------------------------------------------------------------------

describe('Geometry buffer management', () => {
    let geometry: Geometry;

    beforeEach(() => {
        geometry = new Geometry();
    });

    describe('setBuffer', () => {
        test('increments usages for REF_COUNTED buffer', () => {
            const buffer = new GpuBuffer(d.vec3f, {
                data: new Float32Array(9),
                lifecycle: BufferLifecycle.REF_COUNTED,
            });
            expect(buffer._usages).toBe(0);

            geometry.setBuffer('position', buffer);
            expect(buffer._usages).toBe(1);
        });

        test('does not affect MANUAL buffer usages', () => {
            const buffer = new GpuBuffer(d.vec3f, {
                data: new Float32Array(9),
                lifecycle: BufferLifecycle.MANUAL,
            });
            expect(buffer._usages).toBe(0);

            geometry.setBuffer('position', buffer);
            expect(buffer._usages).toBe(0);
        });

        test('replacing buffer decreases old and increases new', () => {
            const buffer1 = new GpuBuffer(d.vec3f, {
                data: new Float32Array(9),
                lifecycle: BufferLifecycle.REF_COUNTED,
            });
            const buffer2 = new GpuBuffer(d.vec3f, {
                data: new Float32Array(9),
                lifecycle: BufferLifecycle.REF_COUNTED,
            });

            geometry.setBuffer('position', buffer1);
            expect(buffer1._usages).toBe(1);
            expect(buffer2._usages).toBe(0);

            geometry.setBuffer('position', buffer2);
            expect(buffer1._usages).toBe(0);
            expect(buffer2._usages).toBe(1);
        });

        test('setting same buffer does not change usages', () => {
            const buffer = new GpuBuffer(d.vec3f, {
                data: new Float32Array(9),
                lifecycle: BufferLifecycle.REF_COUNTED,
            });

            geometry.setBuffer('position', buffer);
            expect(buffer._usages).toBe(1);

            geometry.setBuffer('position', buffer);
            expect(buffer._usages).toBe(1);
        });

        test('disposing old buffer when replaced', () => {
            const buffer1 = new GpuBuffer(d.vec3f, {
                data: new Float32Array(9),
                lifecycle: BufferLifecycle.REF_COUNTED,
            });
            const buffer2 = new GpuBuffer(d.vec3f, {
                data: new Float32Array(9),
                lifecycle: BufferLifecycle.REF_COUNTED,
            });
            const tracker1 = trackDisposal(buffer1);

            geometry.setBuffer('position', buffer1);
            geometry.setBuffer('position', buffer2);

            expect(buffer1.disposed).toBe(true);
            expect(tracker1.disposeCount).toBe(1);
        });
    });

    describe('deleteBuffer', () => {
        test('decrements usages for REF_COUNTED buffer', () => {
            const buffer = new GpuBuffer(d.vec3f, {
                data: new Float32Array(9),
                lifecycle: BufferLifecycle.REF_COUNTED,
            });

            geometry.setBuffer('position', buffer);
            expect(buffer._usages).toBe(1);

            geometry.removeBuffer('position');
            expect(buffer._usages).toBe(0);
            expect(buffer.disposed).toBe(true);
        });

        test('does not affect MANUAL buffer', () => {
            const buffer = new GpuBuffer(d.vec3f, {
                data: new Float32Array(9),
                lifecycle: BufferLifecycle.MANUAL,
            });

            geometry.setBuffer('position', buffer);
            geometry.removeBuffer('position');
            expect(buffer.disposed).toBe(false);
        });
    });

    describe('setIndirect', () => {
        test('increments usages for REF_COUNTED buffer', () => {
            const buffer = new GpuBuffer(d.vec4u, {
                data: new Uint32Array(4),
                usage: ['storage', 'indirect'],
                lifecycle: BufferLifecycle.REF_COUNTED,
            });

            geometry.setIndirect(buffer);
            expect(buffer._usages).toBe(1);
        });

        test('clearing indirect decrements usages', () => {
            const buffer = new GpuBuffer(d.vec4u, {
                data: new Uint32Array(4),
                usage: ['storage', 'indirect'],
                lifecycle: BufferLifecycle.REF_COUNTED,
            });

            geometry.setIndirect(buffer);
            geometry.setIndirect(undefined);
            expect(buffer._usages).toBe(0);
            expect(buffer.disposed).toBe(true);
        });

        test('replacing indirect buffer handles both', () => {
            const buffer1 = new GpuBuffer(d.vec4u, {
                data: new Uint32Array(4),
                usage: ['storage', 'indirect'],
                lifecycle: BufferLifecycle.REF_COUNTED,
            });
            const buffer2 = new GpuBuffer(d.vec4u, {
                data: new Uint32Array(4),
                usage: ['storage', 'indirect'],
                lifecycle: BufferLifecycle.REF_COUNTED,
            });

            geometry.setIndirect(buffer1);
            geometry.setIndirect(buffer2);

            expect(buffer1._usages).toBe(0);
            expect(buffer1.disposed).toBe(true);
            expect(buffer2._usages).toBe(1);
        });
    });

    describe('dispose', () => {
        test('decrements usages on all REF_COUNTED buffers', () => {
            const posBuffer = new GpuBuffer(d.vec3f, {
                data: new Float32Array(9),
                lifecycle: BufferLifecycle.REF_COUNTED,
            });
            const normalBuffer = new GpuBuffer(d.vec3f, {
                data: new Float32Array(9),
                lifecycle: BufferLifecycle.REF_COUNTED,
            });

            geometry.setBuffer('position', posBuffer);
            geometry.setBuffer('normal', normalBuffer);

            geometry.dispose();

            expect(posBuffer._usages).toBe(0);
            expect(posBuffer.disposed).toBe(true);
            expect(normalBuffer._usages).toBe(0);
            expect(normalBuffer.disposed).toBe(true);
        });

        test('decrements usages on indirect buffer', () => {
            const indirect = new GpuBuffer(d.vec4u, {
                data: new Uint32Array(4),
                usage: ['storage', 'indirect'],
                lifecycle: BufferLifecycle.REF_COUNTED,
            });

            geometry.setIndirect(indirect);
            geometry.dispose();

            expect(indirect._usages).toBe(0);
            expect(indirect.disposed).toBe(true);
        });

        test('does not affect MANUAL buffers', () => {
            const buffer = new GpuBuffer(d.vec3f, {
                data: new Float32Array(9),
                lifecycle: BufferLifecycle.MANUAL,
            });

            geometry.setBuffer('position', buffer);
            geometry.dispose();

            expect(buffer.disposed).toBe(false);
        });

        test('is idempotent', () => {
            const buffer = new GpuBuffer(d.vec3f, {
                data: new Float32Array(9),
                lifecycle: BufferLifecycle.REF_COUNTED,
            });
            const tracker = trackDisposal(buffer);

            geometry.setBuffer('position', buffer);
            geometry.dispose();
            geometry.dispose();

            expect(tracker.disposeCount).toBe(1);
        });

        test('shared buffer only disposed when last geometry releases', () => {
            const sharedBuffer = new GpuBuffer(d.vec3f, {
                data: new Float32Array(9),
                lifecycle: BufferLifecycle.REF_COUNTED,
            });
            const tracker = trackDisposal(sharedBuffer);

            const geo1 = new Geometry();
            const geo2 = new Geometry();

            geo1.setBuffer('position', sharedBuffer);
            geo2.setBuffer('position', sharedBuffer);
            expect(sharedBuffer._usages).toBe(2);

            geo1.dispose();
            expect(sharedBuffer._usages).toBe(1);
            expect(sharedBuffer.disposed).toBe(false);
            expect(tracker.disposeCount).toBe(0);

            geo2.dispose();
            expect(sharedBuffer._usages).toBe(0);
            expect(sharedBuffer.disposed).toBe(true);
            expect(tracker.disposeCount).toBe(1);
        });
    });
});
