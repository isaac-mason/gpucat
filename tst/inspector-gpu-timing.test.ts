import { beforeEach, expect, test, vi } from 'vitest';
import type { InspectableRenderer } from '../src/inspector/inspector-base';
import { RendererInspector } from '../src/inspector/renderer-inspector';
import { installWebGPUPolyfills } from './stub-gpu';

installWebGPUPolyfills();

/**
 * WebGPU GPU times reach a FrameRecord only if `finish()` actually resolves the query set. The
 * readback buffers are allocated on demand from inside that resolve, so any precondition on the
 * pool being non-empty can never be met and every frame's `gpuMs` stays null — which is what
 * happened. These drive the inspector against a fake device and assert a resolved `gpuMs`.
 */

const NS_PER_MS = 1_000_000;

type FakeDevice = {
    device: GPUDevice;
    /** Per-slot [begin, end] the fake readback hands back, in ns. */
    timestamps: Map<number, [bigint, bigint]>;
    resolveCalls: number;
    readbackBuffers: number;
    /** When non-null, every mapAsync parks its resolver here instead of landing. */
    heldMaps: (() => void)[] | null;
};

function createFakeDevice(): FakeDevice {
    const state: FakeDevice = {
        device: null as unknown as GPUDevice,
        timestamps: new Map(),
        resolveCalls: 0,
        readbackBuffers: 0,
        heldMaps: null,
    };

    const createBuffer = (desc: GPUBufferDescriptor): GPUBuffer => {
        const bytes = new ArrayBuffer(desc.size);
        const isReadback = (desc.usage & GPUBufferUsage.MAP_READ) !== 0;
        if (isReadback) state.readbackBuffers++;
        return {
            size: desc.size,
            mapState: 'unmapped',
            mapAsync(this: { mapState: string }) {
                // Real mapAsync flips mapState synchronously, which is how the pool tells a
                // buffer still in flight from a free one.
                this.mapState = 'pending';
                const land = (): void => {
                    // The copy the encoder "did": fill the range from the scripted timestamps.
                    const view = new BigUint64Array(bytes);
                    for (const [slot, [begin, end]] of state.timestamps) {
                        view[slot * 2] = begin;
                        view[slot * 2 + 1] = end;
                    }
                    this.mapState = 'mapped';
                };
                if (state.heldMaps) {
                    return new Promise<void>((resolve) => {
                        state.heldMaps!.push(() => {
                            land();
                            resolve();
                        });
                    });
                }
                land();
                return Promise.resolve();
            },
            getMappedRange(offset = 0, size = bytes.byteLength) {
                return bytes.slice(offset, offset + size);
            },
            unmap(this: { mapState: string }) {
                this.mapState = 'unmapped';
            },
            destroy() {},
        } as unknown as GPUBuffer;
    };

    state.device = {
        features: new Set<string>(['timestamp-query']),
        createQuerySet: () => ({ destroy() {} }) as unknown as GPUQuerySet,
        createBuffer,
        createCommandEncoder: () =>
            ({
                resolveQuerySet: () => {
                    state.resolveCalls++;
                },
                copyBufferToBuffer: () => {},
                finish: () => ({}) as GPUCommandBuffer,
            }) as unknown as GPUCommandEncoder,
        queue: {
            submit: () => {},
            onSubmittedWorkDone: async () => {},
        },
    } as unknown as GPUDevice;

    return state;
}

/** The slice of a renderer the inspector's timing path touches. */
function fakeRenderer(device: GPUDevice): InspectableRenderer {
    return { api: 'webgpu', backend: { device } } as unknown as InspectableRenderer;
}

let fake: FakeDevice;
let inspector: RendererInspector;

beforeEach(() => {
    fake = createFakeDevice();
    inspector = new RendererInspector();
    inspector.setRenderer(fakeRenderer(fake.device));
});

/** getMappedRange copies, so the readback lands a microtask or two after finish(). */
async function settle(): Promise<void> {
    for (let i = 0; i < 4; i++) await Promise.resolve();
}

test('a WebGPU frame resolves per-pass and whole-frame GPU times', async () => {
    fake.timestamps.set(0, [1_000n, 1_000n + 2n * BigInt(NS_PER_MS)]);

    inspector.begin(1);
    inspector.beginRender('main');
    expect(inspector.getTimestampWrites('main')).toEqual({
        querySet: expect.anything(),
        beginningOfPassWriteIndex: 0,
        endOfPassWriteIndex: 1,
    });
    inspector.finishRender('main');
    inspector.finish(1);

    expect(fake.resolveCalls).toBe(1);
    expect(fake.readbackBuffers).toBe(1);

    await settle();

    const frame = inspector.latestResolvedFrame();
    expect(frame).not.toBeNull();
    expect(frame!.gpuMs).toBeCloseTo(2, 5);
    const pass = frame!.timeline.find((e) => e.kind === 'render')!;
    expect(pass.kind === 'render' && pass.gpuMs).toBeCloseTo(2, 5);
});

test('the whole-frame GPU time is the span of overlapping passes, not their sum', async () => {
    // Two passes that pipeline: 0→3ms and 1→4ms. Span is 4ms; the sum would claim 6ms.
    fake.timestamps.set(0, [0n, 3n * BigInt(NS_PER_MS)]);
    fake.timestamps.set(1, [1n * BigInt(NS_PER_MS), 4n * BigInt(NS_PER_MS)]);

    inspector.begin(1);
    for (const pass of ['a', 'b']) {
        inspector.beginRender(pass);
        inspector.finishRender(pass);
    }
    inspector.finish(1);
    await settle();

    expect(inspector.latestResolvedFrame()!.gpuMs).toBeCloseTo(4, 5);
});

test('passes past the query set go untimed instead of writing out of range', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    inspector.begin(1);
    // The query set holds MAX_PASSES_PER_FRAME (64) slots; 70 passes overruns it.
    for (let i = 0; i < 70; i++) {
        const passId = `pass-${i}`;
        inspector.beginRender(passId);
        const writes = inspector.getTimestampWrites(passId);
        if (i < 64) {
            expect(writes).toBeDefined();
            expect(writes!.endOfPassWriteIndex).toBeLessThan(64 * 2);
            fake.timestamps.set(i, [0n, BigInt(NS_PER_MS)]);
        } else {
            expect(writes).toBeUndefined();
        }
        inspector.finishRender(passId);
    }
    inspector.finish(1);
    await settle();
    warn.mockRestore();

    // Resolving must not have thrown on the untimed slots, and the timed ones still land.
    expect(inspector.latestResolvedFrame()!.gpuMs).toBeCloseTo(1, 5);
});

test('the readback pool self-sizes across frames with a readback still in flight', async () => {
    fake.timestamps.set(0, [0n, BigInt(NS_PER_MS)]);
    // Park every map, so each frame has to reach for a buffer the previous one is still holding.
    const held: (() => void)[] = [];
    fake.heldMaps = held;

    for (let frameId = 1; frameId <= 3; frameId++) {
        inspector.begin(frameId);
        inspector.beginRender('main');
        inspector.finishRender('main');
        inspector.finish(frameId);
        await settle();
    }

    expect(fake.readbackBuffers).toBe(3);
    expect(inspector.latestResolvedFrame()).toBeNull(); // nothing has landed yet

    for (const land of held) land();
    await settle();
    expect(inspector.latestResolvedFrame()!.gpuMs).toBeCloseTo(1, 5);
});
