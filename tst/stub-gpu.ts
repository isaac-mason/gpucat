/// <reference types="@webgpu/types" />

/**
 * Stub GPU backend for testing.
 *
 * Provides minimal GPUDevice/GPUAdapter/Canvas implementations that track operations
 * for verifying renderer behavior without actual WebGPU.
 */

import type { WebGPUBackendOptions } from '../src/renderer/webgpu/webgpu-backend';

/**
 * Install WebGPU global polyfills for Node.js testing environment.
 * Call this before running any tests that use WebGPU.
 */
export function installWebGPUPolyfills(): void {
    const g = globalThis as any;

    if (typeof g.GPUShaderStage === 'undefined') {
        g.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
    }
    if (typeof g.GPUBufferUsage === 'undefined') {
        g.GPUBufferUsage = {
            MAP_READ: 1,
            MAP_WRITE: 2,
            COPY_SRC: 4,
            COPY_DST: 8,
            INDEX: 16,
            VERTEX: 32,
            UNIFORM: 64,
            STORAGE: 128,
            INDIRECT: 256,
            QUERY_RESOLVE: 512,
        };
    }
    if (typeof g.GPUTextureUsage === 'undefined') {
        g.GPUTextureUsage = {
            COPY_SRC: 1,
            COPY_DST: 2,
            TEXTURE_BINDING: 4,
            STORAGE_BINDING: 8,
            RENDER_ATTACHMENT: 16,
        };
    }
    if (typeof g.GPUColorWrite === 'undefined') {
        g.GPUColorWrite = { RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15 };
    }
    if (typeof g.GPUMapMode === 'undefined') {
        g.GPUMapMode = { READ: 1, WRITE: 2 };
    }
    // Stub classes for instanceof checks
    if (typeof g.GPUTextureView === 'undefined') {
        g.GPUTextureView = class GPUTextureView {};
    }
    if (typeof g.GPUTexture === 'undefined') {
        g.GPUTexture = class GPUTexture {};
    }
    if (typeof g.GPUBuffer === 'undefined') {
        g.GPUBuffer = class GPUBuffer {};
    }
    if (typeof g.GPUSampler === 'undefined') {
        g.GPUSampler = class GPUSampler {};
    }
}

export type StubGPUStats = {
    /** Number of queue.writeBuffer calls */
    bufferWrites: number;
    /** Number of createBindGroup calls */
    bindGroupCreations: number;
    /** Number of createBuffer calls */
    bufferCreations: number;
    /** Index count of the most recent drawIndexed, so a test can tell which geometry was drawn. */
    lastIndexCount: number;
    /** Number of draw/drawIndexed calls, on a render pass or a bundle encoder */
    drawCalls: number;
    /** Number of device.createRenderBundleEncoder calls, so a test can see a re-record */
    bundleRecordings: number;
    /** Labels the bundle encoders were created with, so a test can see the caller's own name arrive. */
    bundleLabels: string[];
    /** Number of bundles handed to executeBundles */
    bundleExecutions: number;
    /** Number of dispatchWorkgroups/dispatchWorkgroupsIndirect calls */
    dispatches: number;
    /** Number of encoder.beginComputePass calls */
    computePasses: number;
    /** Number of setPipeline calls on compute pass encoders */
    computeSetPipelines: number;
    /** Number of device.createCommandEncoder calls */
    encoderCreations: number;
    /** A pushed scope the device never pops stays on its stack and misattributes every later error. */
    errorScopeDepth: number;
    errorScopePushes: number;
    /** Number of queue.submit calls */
    submits: number;
    /** Reset all counters */
    reset(): void;
};

export type StubGPUResult = {
    /** Stub GPUDevice */
    device: GPUDevice;
    /** Stub GPUAdapter */
    adapter: GPUAdapter;
    /** Stub HTMLCanvasElement */
    canvas: HTMLCanvasElement;
    /** A further canvas of its own size, for frames that draw to more than one. */
    makeCanvas(width: number, height: number): HTMLCanvasElement;
    /** Stats for verifying GPU operations */
    stats: StubGPUStats;
    /** Get renderer options with all stubs pre-configured */
    getRendererOptions(): WebGPUBackendOptions;
};

/**
 * Create a stub GPU backend for testing.
 *
 * Returns device, adapter, canvas, and stats for tracking GPU operations.
 * Use `getRendererOptions()` to get options ready for WebGPUBackend.
 *
 * @example
 * ```ts
 * const stub = createStubGPU();
 * const renderer = new Renderer(new WebGPUBackend(stub.getRendererOptions()));
 * await renderer.init();
 *
 * renderer.render(outputNode);
 * expect(stub.stats.bufferWrites).toBe(1);
 * ```
 */
export function createStubGPU(): StubGPUResult {
    const stats: StubGPUStats = {
        bufferWrites: 0,
        bindGroupCreations: 0,
        bufferCreations: 0,
        drawCalls: 0,
        bundleRecordings: 0,
        bundleLabels: [],
        bundleExecutions: 0,
        lastIndexCount: 0,
        dispatches: 0,
        computePasses: 0,
        computeSetPipelines: 0,
        encoderCreations: 0,
        errorScopeDepth: 0,
        errorScopePushes: 0,
        submits: 0,
        reset() {
            this.bufferWrites = 0;
            this.bindGroupCreations = 0;
            this.bufferCreations = 0;
            this.drawCalls = 0;
            this.bundleRecordings = 0;
            this.bundleLabels = [];
            this.bundleExecutions = 0;
            this.lastIndexCount = 0;
            this.dispatches = 0;
            this.computePasses = 0;
            this.computeSetPipelines = 0;
            this.encoderCreations = 0;
            this.errorScopeDepth = 0;
            this.errorScopePushes = 0;
            this.submits = 0;
        },
    };

    // Stub buffer
    const createStubBuffer = (): GPUBuffer =>
        ({
            size: 0,
            usage: 0,
            mapState: 'unmapped',
            label: '',
            mapAsync: async () => {},
            getMappedRange: () => new ArrayBuffer(1024),
            unmap: () => {},
            destroy: () => {},
        }) as unknown as GPUBuffer;

    // Stub texture
    // Dimensionally honest: a view remembers its texture, so beginRenderPass can check attachments
    // agree the way real WebGPU does. A 1x1-for-everything stub makes every mismatch invisible.
    const createStubTexture = (descriptor?: GPUTextureDescriptor): GPUTexture => {
        const size = (descriptor?.size ?? [1, 1, 1]) as number[];
        const texture = {
            width: size[0] ?? 1,
            height: size[1] ?? 1,
            depthOrArrayLayers: size[2] ?? 1,
            mipLevelCount: descriptor?.mipLevelCount ?? 1,
            sampleCount: descriptor?.sampleCount ?? 1,
            dimension: descriptor?.dimension ?? '2d',
            format: descriptor?.format ?? 'rgba8unorm',
            usage: descriptor?.usage ?? 0,
            label: descriptor?.label ?? '',
            createView: () => ({ __texture: texture }) as unknown as GPUTextureView,
            destroy: () => {},
        };
        return texture as unknown as GPUTexture;
    };

    /** Mirrors the validation rule that every attachment in a pass must agree on size and samples. */
    const assertAttachmentsAgree = (descriptor: GPURenderPassDescriptor): void => {
        const views: (GPUTexture | GPUTextureView)[] = [];
        for (const a of descriptor.colorAttachments ?? []) {
            if (!a) continue;
            views.push(a.view);
            if (a.resolveTarget) views.push(a.resolveTarget);
        }
        if (descriptor.depthStencilAttachment) views.push(descriptor.depthStencilAttachment.view);

        let expected: { width: number; height: number } | null = null;
        for (const view of views) {
            const texture = (view as unknown as { __texture?: GPUTexture }).__texture;
            if (texture === undefined) continue;
            if (expected === null) {
                expected = { width: texture.width, height: texture.height };
            } else if (texture.width !== expected.width || texture.height !== expected.height) {
                throw new Error(
                    `[stub-gpu] render pass attachments disagree: ${expected.width}x${expected.height} vs ` +
                        `${texture.width}x${texture.height}`,
                );
            }
        }
    };

    // Stub sampler
    const createStubSampler = (): GPUSampler =>
        ({
            label: '',
        }) as unknown as GPUSampler;

    // Stub bind group layout
    const createStubBindGroupLayout = (): GPUBindGroupLayout =>
        ({
            label: '',
        }) as unknown as GPUBindGroupLayout;

    // Stub bind group
    const createStubBindGroup = (): GPUBindGroup =>
        ({
            label: '',
        }) as unknown as GPUBindGroup;

    // Stub pipeline layout
    const createStubPipelineLayout = (): GPUPipelineLayout =>
        ({
            label: '',
        }) as unknown as GPUPipelineLayout;

    // Stub shader module
    const createStubShaderModule = (): GPUShaderModule =>
        ({
            label: '',
            getCompilationInfo: async () => ({ messages: [] }),
        }) as unknown as GPUShaderModule;

    // Stub render pipeline
    const createStubRenderPipeline = (): GPURenderPipeline =>
        ({
            label: '',
            getBindGroupLayout: () => createStubBindGroupLayout(),
        }) as unknown as GPURenderPipeline;

    // Stub compute pipeline
    const createStubComputePipeline = (): GPUComputePipeline =>
        ({
            label: '',
            getBindGroupLayout: () => createStubBindGroupLayout(),
        }) as unknown as GPUComputePipeline;

    // Stub command encoder
    const createStubCommandEncoder = (): GPUCommandEncoder =>
        ({
            label: '',
            beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
                assertAttachmentsAgree(descriptor);
                return createStubRenderPassEncoder();
            },
            beginComputePass: () => {
                stats.computePasses++;
                return createStubComputePassEncoder();
            },
            copyBufferToBuffer: () => {},
            copyBufferToTexture: () => {},
            copyTextureToBuffer: () => {},
            copyTextureToTexture: () => {},
            clearBuffer: () => {},
            resolveQuerySet: () => {},
            finish: () => ({}) as unknown as GPUCommandBuffer,
            pushDebugGroup: () => {},
            popDebugGroup: () => {},
            insertDebugMarker: () => {},
        }) as unknown as GPUCommandEncoder;

    // Shared by both encoders, so a replayed draw counts exactly as the direct draw it stands in for.
    const drawRecorder = () => ({
        label: '',
        setPipeline: () => {},
        setBindGroup: () => {},
        setVertexBuffer: () => {},
        setIndexBuffer: () => {},
        draw: () => {
            stats.drawCalls++;
        },
        drawIndexed: (indexCount: number) => {
            stats.drawCalls++;
            stats.lastIndexCount = indexCount;
        },
        drawIndirect: () => {
            stats.drawCalls++;
        },
        drawIndexedIndirect: () => {
            stats.drawCalls++;
        },
        pushDebugGroup: () => {},
        popDebugGroup: () => {},
        insertDebugMarker: () => {},
    });

    // Deliberately no setStencilReference: a real bundle encoder lacks it, and the encoder tests for that.
    const createStubRenderBundleEncoder = (descriptor?: GPURenderBundleEncoderDescriptor): GPURenderBundleEncoder => {
        stats.bundleRecordings++;
        if (descriptor?.label !== undefined) stats.bundleLabels.push(descriptor.label);
        return {
            ...drawRecorder(),
            finish: () => ({}) as unknown as GPURenderBundle,
        } as unknown as GPURenderBundleEncoder;
    };

    // Stub render pass encoder
    const createStubRenderPassEncoder = (): GPURenderPassEncoder =>
        ({
            ...drawRecorder(),
            setViewport: () => {},
            setScissorRect: () => {},
            setBlendConstant: () => {},
            setStencilReference: () => {},
            executeBundles: (bundles: Iterable<GPURenderBundle>) => {
                for (const _ of bundles) stats.bundleExecutions++;
            },
            end: () => {},
            beginOcclusionQuery: () => {},
            endOcclusionQuery: () => {},
        }) as unknown as GPURenderPassEncoder;

    // Stub compute pass encoder
    const createStubComputePassEncoder = (): GPUComputePassEncoder =>
        ({
            label: '',
            setPipeline: () => {
                stats.computeSetPipelines++;
            },
            setBindGroup: () => {},
            dispatchWorkgroups: () => {
                stats.dispatches++;
            },
            dispatchWorkgroupsIndirect: () => {
                stats.dispatches++;
            },
            end: () => {},
            pushDebugGroup: () => {},
            popDebugGroup: () => {},
            insertDebugMarker: () => {},
        }) as unknown as GPUComputePassEncoder;

    // Stub queue
    const queue: GPUQueue = {
        label: '',
        submit: () => {
            stats.submits++;
        },
        writeBuffer: () => {
            stats.bufferWrites++;
        },
        writeTexture: () => {},
        copyExternalImageToTexture: () => {},
        onSubmittedWorkDone: async () => {},
    } as unknown as GPUQueue;

    // Stub features set
    const features = new Set<GPUFeatureName>() as GPUSupportedFeatures;

    // Stub limits
    const limits = {} as GPUSupportedLimits;

    // Stub adapter info
    const adapterInfo = {
        vendor: 'stub',
        architecture: 'stub',
        device: 'stub',
        description: 'stub',
        __brand: 'GPUAdapterInfo',
    } as unknown as GPUAdapterInfo;

    // Stub device
    const device: GPUDevice = {
        __brand: 'GPUDevice',
        label: '',
        features,
        limits,
        adapterInfo,
        queue,
        lost: Promise.resolve({
            reason: 'destroyed',
            message: '',
            __brand: 'GPUDeviceLostInfo',
        } as GPUDeviceLostInfo),
        destroy: () => {},
        createBuffer: () => {
            stats.bufferCreations++;
            return createStubBuffer();
        },
        createTexture: (descriptor: GPUTextureDescriptor) => createStubTexture(descriptor),
        createSampler: () => createStubSampler(),
        createBindGroupLayout: () => createStubBindGroupLayout(),
        createBindGroup: () => {
            stats.bindGroupCreations++;
            return createStubBindGroup();
        },
        createPipelineLayout: () => createStubPipelineLayout(),
        createShaderModule: () => createStubShaderModule(),
        createRenderPipeline: () => createStubRenderPipeline(),
        createComputePipeline: () => createStubComputePipeline(),
        createRenderPipelineAsync: async () => createStubRenderPipeline(),
        createComputePipelineAsync: async () => createStubComputePipeline(),
        createCommandEncoder: () => {
            stats.encoderCreations++;
            return createStubCommandEncoder();
        },
        createRenderBundleEncoder: (descriptor?: GPURenderBundleEncoderDescriptor) => createStubRenderBundleEncoder(descriptor),
        createQuerySet: () => ({}) as unknown as GPUQuerySet,
        importExternalTexture: () => ({}) as unknown as GPUExternalTexture,
        pushErrorScope: () => {
            stats.errorScopeDepth++;
            stats.errorScopePushes++;
        },
        popErrorScope: async () => {
            stats.errorScopeDepth--;
            return null;
        },
        onuncapturederror: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    } as unknown as GPUDevice;

    // Stub adapter
    const adapter: GPUAdapter = {
        __brand: 'GPUAdapter',
        features,
        limits,
        info: adapterInfo,
        isFallbackAdapter: false,
        requestDevice: async () => device,
        requestAdapterInfo: async () => adapterInfo,
    } as unknown as GPUAdapter;

    /** Each canvas reports its own size, so a frame drawing to several is dimensionally distinguishable. */
    const makeCanvas = (width: number, height: number): HTMLCanvasElement => {
        const element = {
            width,
            height,
            // The CSS layout size, which `autoResize` reads; tests set it to simulate a layout change.
            clientWidth: width,
            clientHeight: height,
            style: {},
            getContext: (contextId: string) => {
                if (contextId !== 'webgpu') return null;
                return {
                    __brand: 'GPUCanvasContext',
                    canvas: element,
                    configure: () => {},
                    unconfigure: () => {},
                    getCurrentTexture: () =>
                        createStubTexture({ size: [element.width, element.height, 1] } as unknown as GPUTextureDescriptor),
                } as unknown as GPUCanvasContext;
            },
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false,
        };
        return element as unknown as HTMLCanvasElement;
    };

    const canvas = makeCanvas(800, 600);

    return {
        device,
        adapter,
        canvas,
        makeCanvas,
        stats,
        getRendererOptions(): WebGPUBackendOptions {
            return {
                device,
                adapter,
                format: 'bgra8unorm',
            };
        },
    };
}
