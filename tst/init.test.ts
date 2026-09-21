import { expect, test } from 'vitest';
import { createCanvasTarget } from '../src/renderer/core/canvas-target';
import { frame } from '../src/renderer/core/frame';
import { init } from '../src/renderer/core/init';
import { Renderer } from '../src/renderer/core/renderer';
import { webgl } from '../src/renderer/webgl/backend';
import type { WebGLBackend } from '../src/renderer/webgl/webgl-backend';
import { webgpu } from '../src/renderer/webgpu/backend';
import { canvasFormat, gpuDevice, hasFeature } from '../src/renderer/webgpu/device-api';
import { WebGPUBackend } from '../src/renderer/webgpu/webgpu-backend';
import { createStubGPU, installWebGPUPolyfills } from './stub-gpu';

installWebGPUPolyfills();

test('a backend carries its own device options, so init takes nothing else', async () => {
    const stub = createStubGPU();
    const backend = webgpu(stub.getRendererOptions());

    expect(backend.name).toBe('webgpu');

    const gpu = await init(backend);
    expect(gpu.api).toBe('webgpu');
    expect(gpu.backend.device).toBe(stub.device);
});

/**
 * `webgpu()` and `webgl()` build a backend and nothing else. They returned `new Renderer(...).init()`
 * until 6.91, which put the one line the fronting class exists to own in two places and made each
 * backend import the layer above it.
 */
test('a backend factory makes a backend, and init is what makes the renderer', async () => {
    const stub = createStubGPU();

    const backend: WebGPUBackend = webgpu(stub.getRendererOptions());
    expect(backend).toBeInstanceOf(WebGPUBackend);
    expect(backend).not.toBeInstanceOf(Renderer);

    const gpu: Renderer<WebGPUBackend> = await init(webgpu(stub.getRendererOptions()));
    expect(gpu).toBeInstanceOf(Renderer);
});

test('init creates no canvas: a target is the callers, named per pass', async () => {
    const stub = createStubGPU();
    const gpu = await init(webgpu(stub.getRendererOptions()));

    // Two independent canvases over one device, neither of them the renderer's.
    const a = createCanvasTarget(stub.makeCanvas(320, 240));
    const b = createCanvasTarget(stub.makeCanvas(640, 480));

    const f = frame(gpu);
    for (const target of [a, b]) f.pass({ target }).end();
    f.submit();

    expect(a.getDrawingBufferSize()).toEqual({ width: 320, height: 240 });
    expect(b.getDrawingBufferSize()).toEqual({ width: 640, height: 480 });
});

/**
 * A consumer choosing a backend at run time falls back by catching `init`, so a failure has to reject
 * rather than resolve something half-built. lib does exactly this: probe for a hint, then
 * `try { webgpu } catch { webgl }`, which only works if every failure path throws.
 */
test('init rejects when there is no adapter, rather than resolving a renderer that cannot draw', async () => {
    const saved = navigator.gpu;
    Object.defineProperty(navigator, 'gpu', {
        configurable: true,
        value: { requestAdapter: async () => null, getPreferredCanvasFormat: () => 'bgra8unorm' },
    });

    try {
        await expect(init(webgpu())).rejects.toThrow(/No WebGPU adapter/);
    } finally {
        Object.defineProperty(navigator, 'gpu', { configurable: true, value: saved });
    }
});

test('init rejects when the environment has no WebGPU at all', async () => {
    const saved = navigator.gpu;
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });

    try {
        await expect(init(webgpu())).rejects.toThrow(/not supported in this environment/);
    } finally {
        Object.defineProperty(navigator, 'gpu', { configurable: true, value: saved });
    }
});

/**
 * The asymmetry is each backend's own options type, not an overload on `init`. Layer 6.93 deleted
 * `BackendFactory` and its `DeviceTarget` parameter, which existed only to carry this to `init`'s
 * signature; a WebGL2 context is its canvas's context for life, so the canvas is a constructor
 * argument and there is nothing left for `init` to overload on.
 */
test('a WebGL target is required and a WebGPU one is impossible, at compile time', () => {
    // Type-only: no GL context exists under vitest, so nothing here is awaited.
    const requiresTarget = () => init(webgl({ target: createCanvasTarget(document.createElement('canvas')) }));
    // @ts-expect-error webgl's device is a canvas context, so omitting the target cannot type-check
    const missingTarget = () => init(webgl());
    // @ts-expect-error webgpu acquires its device without a canvas, so a target here is meaningless
    const pointlessTarget = () => init(webgpu({ target: createCanvasTarget(document.createElement('canvas')) }));

    expect([requiresTarget, missingTarget, pointlessTarget].every((f) => typeof f === 'function')).toBe(true);
});

/**
 * The escape hatches are free functions typed on the concrete renderer, so a WebGPU device cannot be
 * asked of a WebGL2 one. They replace `renderer.backend.device`, which stopped being public in 6.96.
 */
test('the device escape hatches are typed to their backend', async () => {
    const stub = createStubGPU();
    const renderer = await init(webgpu(stub.getRendererOptions()));

    expect(gpuDevice(renderer)).toBe(stub.device);
    expect(canvasFormat(renderer)).toBe(renderer.backend.format);
    expect(hasFeature(renderer, 'depth-clip-control')).toBe(renderer.backend.hasFeature('depth-clip-control'));

    // Type-only: no GL context exists under vitest, and the point is the signature, not a call.
    const webglRenderer = null as unknown as Renderer<WebGLBackend>;
    // @ts-expect-error a WebGL2 renderer has no WebGPU device to hand back
    const wrongBackend = () => gpuDevice(webglRenderer);
    expect(typeof wrongBackend).toBe('function');
});

/**
 * A consumer assembling render state synchronously has nowhere to await, so the object has to exist
 * before its device: `init(backend)` is the one-call form, not the only one.
 */
test('a renderer can be held before its device exists, and names the gap if used', async () => {
    const stub = createStubGPU();
    const renderer = new Renderer(new WebGPUBackend(stub.getRendererOptions()));

    expect(() => frame(renderer)).toThrow(/before init/);

    await renderer.init();
    expect(() => frame(renderer)).not.toThrow();
});
