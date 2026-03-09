/// <reference types="@webgpu/types" />

/**
 * Stub GPU backend for testing.
 *
 * Provides minimal GPUDevice/GPUAdapter/Canvas implementations that track operations
 * for verifying renderer behavior without actual WebGPU.
 */

import type { WebGPURendererOptions } from '../src/renderer/renderer';

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
            MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8,
            INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128,
            INDIRECT: 256, QUERY_RESOLVE: 512,
        };
    }
    if (typeof g.GPUTextureUsage === 'undefined') {
        g.GPUTextureUsage = {
            COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4,
            STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16,
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
    /** Number of draw/drawIndexed calls */
    drawCalls: number;
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
    /** Stats for verifying GPU operations */
    stats: StubGPUStats;
    /** Get renderer options with all stubs pre-configured */
    getRendererOptions(): WebGPURendererOptions;
};

/**
 * Create a stub GPU backend for testing.
 *
 * Returns device, adapter, canvas, and stats for tracking GPU operations.
 * Use `getRendererOptions()` to get options ready for WebGPURenderer.
 *
 * @example
 * ```ts
 * const stub = createStubGPU();
 * const renderer = new WebGPURenderer(stub.getRendererOptions());
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
        reset() {
            this.bufferWrites = 0;
            this.bindGroupCreations = 0;
            this.bufferCreations = 0;
            this.drawCalls = 0;
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
    const createStubTexture = (): GPUTexture =>
        ({
            width: 1,
            height: 1,
            depthOrArrayLayers: 1,
            mipLevelCount: 1,
            sampleCount: 1,
            dimension: '2d',
            format: 'rgba8unorm',
            usage: 0,
            label: '',
            createView: () => ({}) as unknown as GPUTextureView,
            destroy: () => {},
        }) as unknown as GPUTexture;

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
            beginRenderPass: () => createStubRenderPassEncoder(),
            beginComputePass: () => createStubComputePassEncoder(),
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

    // Stub render pass encoder
    const createStubRenderPassEncoder = (): GPURenderPassEncoder =>
        ({
            label: '',
            setPipeline: () => {},
            setBindGroup: () => {},
            setVertexBuffer: () => {},
            setIndexBuffer: () => {},
            draw: () => { stats.drawCalls++; },
            drawIndexed: () => { stats.drawCalls++; },
            drawIndirect: () => { stats.drawCalls++; },
            drawIndexedIndirect: () => { stats.drawCalls++; },
            setViewport: () => {},
            setScissorRect: () => {},
            setBlendConstant: () => {},
            setStencilReference: () => {},
            executeBundles: () => {},
            end: () => {},
            beginOcclusionQuery: () => {},
            endOcclusionQuery: () => {},
            pushDebugGroup: () => {},
            popDebugGroup: () => {},
            insertDebugMarker: () => {},
        }) as unknown as GPURenderPassEncoder;

    // Stub compute pass encoder
    const createStubComputePassEncoder = (): GPUComputePassEncoder =>
        ({
            label: '',
            setPipeline: () => {},
            setBindGroup: () => {},
            dispatchWorkgroups: () => {},
            dispatchWorkgroupsIndirect: () => {},
            end: () => {},
            pushDebugGroup: () => {},
            popDebugGroup: () => {},
            insertDebugMarker: () => {},
        }) as unknown as GPUComputePassEncoder;

    // Stub queue
    const queue: GPUQueue = {
        label: '',
        submit: () => {},
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
        createTexture: () => createStubTexture(),
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
        createCommandEncoder: () => createStubCommandEncoder(),
        createRenderBundleEncoder: () => ({}) as unknown as GPURenderBundleEncoder,
        createQuerySet: () => ({}) as unknown as GPUQuerySet,
        importExternalTexture: () => ({}) as unknown as GPUExternalTexture,
        pushErrorScope: () => {},
        popErrorScope: async () => null,
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

    // Stub canvas context
    const stubCanvasContext: GPUCanvasContext = {
        __brand: 'GPUCanvasContext',
        canvas: null as any,
        configure: () => {},
        unconfigure: () => {},
        getCurrentTexture: () => createStubTexture(),
    } as unknown as GPUCanvasContext;

    // Stub canvas
    const canvas: HTMLCanvasElement = {
        width: 800,
        height: 600,
        style: {},
        getContext: (contextId: string) => {
            if (contextId === 'webgpu') {
                return stubCanvasContext;
            }
            return null;
        },
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    } as unknown as HTMLCanvasElement;

    return {
        device,
        adapter,
        canvas,
        stats,
        getRendererOptions(): WebGPURendererOptions {
            return {
                device,
                adapter,
                canvas,
                format: 'bgra8unorm',
            };
        },
    };
}
