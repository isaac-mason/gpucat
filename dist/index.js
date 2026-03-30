/**
 * InspectorBase.ts — Abstract no-op inspector interface.
 *
 * Mirrors Three's InspectorBase.js. The renderer holds a reference to one
 * of these (defaulting to a bare InspectorBase instance whose methods are all
 * no-ops). Swap it for a RendererInspector / Inspector instance to enable
 * profiling and the full Inspector UI.
 *
 * Hook call sites in WebGPURenderer:
 *   init()                 → inspector.setRenderer(renderer); inspector.init()
 *   render() start         → inspector.begin(frameId)
 *   render() end           → inspector.finish(frameId)
 *   _renderPassNode start  → inspector.beginRender(passId, frameId)
 *   _renderPassNode end    → inspector.finishRender(passId, frameId)
 *   _dispatchComputeNode   → inspector.beginCompute(node, frameId) / finishCompute
 *   Node.inspect()         → inspector.inspect(node)
 *   renderScene() start    → inspector.beginRenderScene(passId, scene, samples, colorFormat, frameId)
 *
 * Per-draw-call hooks (inside a render pass):
 *   issueDrawsForItems      → inspector.setPipeline(label)
 *                           → inspector.setBindGroup(index, label)
 *                           → inspector.setVertexBuffer(slot)
 *                           → inspector.setIndexBuffer()
 *                           → inspector.draw(vertexCount, instanceCount)
 *                           → inspector.drawIndexed(indexCount, instanceCount)
 *                           → inspector.drawIndirect()
 *                           → inspector.drawIndexedIndirect()
 *
 * Per-dispatch hooks (inside a compute pass):
 *   _dispatchComputeNode    → inspector.dispatchWorkgroups(x, y, z)
 */
class InspectorBase {
    /** Back-reference to the renderer. Set by renderer after init(). */
    renderer = null;
    // -----------------------------------------------------------------------
    // Performance markers (no-op in base class)
    // -----------------------------------------------------------------------
    /** Performance marker API - no-op in base class, implemented in RendererInspector */
    perf = {
        start: (_name) => { },
        end: (_name) => { },
    };
    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------
    /** Called once after the renderer's GPUDevice is ready. */
    setRenderer(renderer) {
        this.renderer = renderer;
    }
    /** Called after setRenderer() — subclasses perform one-time GPU resource setup here. */
    init() { }
    // -----------------------------------------------------------------------
    // Frame hooks
    // -----------------------------------------------------------------------
    /** Called at the very start of WebGPURenderer.render(), before any work. */
    begin(_frameId) { }
    /** Called at the very end of WebGPURenderer.render(), after queue.submit(). */
    finish(_frameId) { }
    // -----------------------------------------------------------------------
    // Render pass hooks
    // -----------------------------------------------------------------------
    /** Called before a PassNode scene render pass begins. */
    beginRender(_passId, _frameId) { }
    /** Called after a PassNode scene render pass ends. */
    finishRender(_passId, _frameId) { }
    /**
     * Returns timestampWrites configuration for a render/compute pass, or undefined if not available.
     * Called by the renderer when creating a pass to inject GPU timing queries.
     */
    getTimestampWrites(_passId) {
        return undefined;
    }
    // -----------------------------------------------------------------------
    // Compute pass hooks
    // -----------------------------------------------------------------------
    /** Called before a compute dispatch. */
    beginCompute(_node, _frameId) { }
    /** Called after a compute dispatch. */
    finishCompute(_nodeId, _frameId) { }
    // -----------------------------------------------------------------------
    // Scene hooks
    // -----------------------------------------------------------------------
    /**
     * Called at the start of renderScene(), before the GPU pass begins.
     * Gives the inspector a reference to the scene being rendered, along with
     * the pipeline key parameters needed to retrieve compiled WGSL later.
     */
    beginRenderScene(_passId, _scene, _samples, _colorFormat, _frameId) { }
    // -----------------------------------------------------------------------
    // Node inspection
    // -----------------------------------------------------------------------
    /**
     * Called when a node marked with .inspect() is encountered during rendering.
     * Subclasses override this to register the node for Viewer tab preview.
     */
    inspect(_node) { }
    // -----------------------------------------------------------------------
    // Per-draw-call hooks (inside a render pass)
    // -----------------------------------------------------------------------
    /**
     * Called whenever a new pipeline is bound (i.e. renderObject.pipeline changed).
     * `label` is the mesh/material label for the object that triggered the switch.
     */
    setPipeline(_label) { }
    /**
     * Called for each setBindGroup() issued to the GPU pass encoder.
     * `index` is the bind group slot index; `label` is an optional debug label.
     */
    setBindGroup(_index, _label) { }
    /**
     * Called for each setVertexBuffer() issued to the GPU pass encoder.
     * `slot` is the vertex buffer slot index.
     */
    setVertexBuffer(_slot) { }
    /**
     * Called whenever setIndexBuffer() is issued for an indexed draw.
     */
    setIndexBuffer() { }
    /**
     * Called for each non-indexed draw().
     */
    draw(_vertexCount, _instanceCount) { }
    /**
     * Called for each indexed drawIndexed().
     */
    drawIndexed(_indexCount, _instanceCount) { }
    /**
     * Called for each drawIndirect() (non-indexed indirect draw).
     */
    drawIndirect() { }
    /**
     * Called for each drawIndexedIndirect() (indexed indirect draw).
     */
    drawIndexedIndirect() { }
    // -----------------------------------------------------------------------
    // Per-dispatch hooks (inside a compute pass)
    // -----------------------------------------------------------------------
    /**
     * Called for each dispatchWorkgroups() issued in a compute pass.
     */
    dispatchWorkgroups(_x, _y, _z) { }
    /**
     * Called for each dispatchWorkgroupsIndirect() issued in a compute pass.
     */
    dispatchWorkgroupsIndirect(_buffer, _offset) { }
    /** Returns the renderer reference (null until setRenderer() is called). */
    getRenderer() {
        return this.renderer;
    }
}

function createBufferCache() {
    return {
        bufferMap: new WeakMap(),
        rawMap: new WeakMap(),
        bufferCount: 0,
        rawCount: 0,
    };
}
/**
 * Set up the _onDispose callback on a GpuBuffer to destroy its GPU buffer.
 * Only sets the callback once (idempotent).
 */
function setupDispose$1(cache, buffer) {
    if (buffer._onDispose)
        return;
    buffer._onDispose = () => {
        const entry = cache.bufferMap.get(buffer);
        if (entry) {
            entry.buf.destroy();
        }
    };
}
/**
 * Derive GPUBufferUsage flags from a GpuBuffer's usage set.
 */
function deriveGPUUsage(buffer) {
    let flags = GPUBufferUsage.COPY_DST;
    if (buffer.usage.has('vertex'))
        flags |= GPUBufferUsage.VERTEX;
    if (buffer.usage.has('index'))
        flags |= GPUBufferUsage.INDEX;
    if (buffer.usage.has('storage'))
        flags |= GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC;
    if (buffer.usage.has('indirect'))
        flags |= GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE;
    if (buffer.usage.has('uniform'))
        flags |= GPUBufferUsage.UNIFORM;
    return flags;
}
/**
 * Ensure a GpuBuffer is uploaded to the GPU, creating the GPUBuffer on first
 * use and re-uploading when the version advances or updateRanges are pending.
 *
 * This is the single upload function for all GpuBuffer types (vertex, index,
 * storage, indirect). GPU usage flags are derived from `buffer.usage`.
 */
function ensureUploaded(cache, device, buffer) {
    const arr = buffer.array;
    // CPU memory was released — return existing GPU buffer.
    if (!arr) {
        const entry = cache.bufferMap.get(buffer);
        if (!entry) {
            throw new Error('[gpucat] ensureUploaded: buffer.array is null but GPU buffer was never created');
        }
        return entry.buf;
    }
    const byteLength = alignTo4(arr.byteLength);
    const entry = cache.bufferMap.get(buffer);
    // Create buffer if it doesn't exist or is too small.
    if (!entry || entry.buf.size < byteLength) {
        entry?.buf.destroy();
        const buf = device.createBuffer({
            size: byteLength,
            usage: deriveGPUUsage(buffer),
        });
        if (!entry)
            cache.bufferCount++;
        device.queue.writeBuffer(buf, 0, arr.buffer, arr.byteOffset, arr.byteLength);
        cache.bufferMap.set(buffer, { buf, version: buffer.version });
        setupDispose$1(cache, buffer);
        buffer.onUpload?.();
        return buf;
    }
    const { buf } = entry;
    if (buffer.updateRanges.length > 0) {
        // Partial upload — ranges are flat component indices; convert to bytes.
        const bytesPerComponent = arr.BYTES_PER_ELEMENT;
        for (const { start, count } of buffer.updateRanges) {
            const byteOffset = start * bytesPerComponent;
            const byteCount = count * bytesPerComponent;
            device.queue.writeBuffer(buf, byteOffset, arr.buffer, arr.byteOffset + byteOffset, byteCount);
        }
        buffer.clearUpdateRanges();
        entry.version = buffer.version;
    }
    else if (buffer.version !== entry.version) {
        // Full re-upload.
        device.queue.writeBuffer(buf, 0, arr.buffer, arr.byteOffset, arr.byteLength);
        entry.version = buffer.version;
    }
    return buf;
}
/**
 * Return the GPUBuffer for an already-uploaded GpuBuffer, or undefined
 * if it has not been uploaded yet.
 *
 * This is a pure lookup — no data transfer occurs.
 */
function getUploaded(cache, buffer) {
    return cache.bufferMap.get(buffer)?.buf;
}
/**
 * Resolve a GpuBuffer from a StorageNode.
 *
 * For named references, the buffer is resolved from geometry.buffers.
 * For value references, the buffer is taken from node.value.
 */
function resolveStorageBuffer(node, geometry) {
    if (node.isNamedReference) {
        if (!geometry) {
            throw new Error(`[gpucat] resolveStorageBuffer: storage node '${node.bufferName}' is name-based but no geometry was provided`);
        }
        const buffer = geometry.buffers.get(node.bufferName);
        if (!buffer) {
            throw new Error(`[gpucat] resolveStorageBuffer: buffer '${node.bufferName}' not found in geometry.buffers`);
        }
        return buffer;
    }
    else {
        const buffer = node.value;
        if (!buffer) {
            throw new Error('[gpucat] resolveStorageBuffer: node.value is null');
        }
        return buffer;
    }
}
/**
 * Get or create a uniform/storage GPUBuffer identified by a JS object key.
 * Always writes `data` to the buffer (caller decides when to call this).
 * Returns both the buffer and whether it was newly created/resized.
 */
function uploadRaw(cache, device, key, data, usage) {
    let buf = cache.rawMap.get(key);
    const byteLength = alignTo4(data.byteLength);
    const isNew = !buf;
    let created = false;
    if (!buf || buf.size < byteLength) {
        buf?.destroy();
        buf = device.createBuffer({ size: byteLength, usage });
        cache.rawMap.set(key, buf);
        created = true;
        if (isNew) {
            cache.rawCount++;
        }
    }
    device.queue.writeBuffer(buf, 0, data.buffer, data.byteOffset, data.byteLength);
    return { buffer: buf, created };
}
/**
 * Get a previously created raw buffer, or undefined.
 * Does NOT upload — use uploadRaw for that.
 */
function getRaw(cache, key) {
    return cache.rawMap.get(key);
}
// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
/**
 * Returns approximate buffer counts tracked by this cache.
 */
function getBufferCacheStats(cache) {
    return {
        bufferCount: cache.bufferCount,
        rawCount: cache.rawCount,
    };
}
function alignTo4(n) {
    return Math.ceil(n / 4) * 4;
}

/**
 * schema.ts — WGSL type descriptors following packcat's discriminated union pattern.
 *
 * Import this module as:
 *   import * as d from './schema'
 *
 * Every descriptor has:
 *   - `type`     — discriminant string for type-level narrowing and runtime switching
 *   - `wgslType` — the WGSL type name string
 *
 * For primitives, type === wgslType (e.g. { type: 'f32'; wgslType: 'f32' }).
 * For composites, type is the discriminant ('array', 'struct') and wgslType is computed.
 */
// ---------------------------------------------------------------------------
// Scalar descriptors
// ---------------------------------------------------------------------------
const f32$1 = { type: 'f32', wgslType: 'f32' };
const i32$1 = { type: 'i32', wgslType: 'i32' };
const u32$1 = { type: 'u32', wgslType: 'u32' };
const bool$1 = { type: 'bool', wgslType: 'bool' };
const f16$1 = { type: 'f16', wgslType: 'f16' };
const vec2f$1 = { type: 'vec2f', wgslType: 'vec2f' };
const vec2i$1 = { type: 'vec2i', wgslType: 'vec2i' };
const vec2u$1 = { type: 'vec2u', wgslType: 'vec2u' };
const vec2bool = { type: 'vec2<bool>', wgslType: 'vec2<bool>' };
const vec2h$1 = { type: 'vec2h', wgslType: 'vec2h' };
const vec3f$1 = { type: 'vec3f', wgslType: 'vec3f' };
const vec3i$1 = { type: 'vec3i', wgslType: 'vec3i' };
const vec3u$1 = { type: 'vec3u', wgslType: 'vec3u' };
const vec3bool = { type: 'vec3<bool>', wgslType: 'vec3<bool>' };
const vec3h$1 = { type: 'vec3h', wgslType: 'vec3h' };
const vec4f$1 = { type: 'vec4f', wgslType: 'vec4f' };
const vec4i$1 = { type: 'vec4i', wgslType: 'vec4i' };
const vec4u$1 = { type: 'vec4u', wgslType: 'vec4u' };
const vec4bool = { type: 'vec4<bool>', wgslType: 'vec4<bool>' };
const vec4h$1 = { type: 'vec4h', wgslType: 'vec4h' };
const mat2x2f$1 = { type: 'mat2x2f', wgslType: 'mat2x2f' };
const mat2x3f$1 = { type: 'mat2x3f', wgslType: 'mat2x3f' };
const mat2x4f$1 = { type: 'mat2x4f', wgslType: 'mat2x4f' };
const mat3x2f$1 = { type: 'mat3x2f', wgslType: 'mat3x2f' };
const mat3x3f$1 = { type: 'mat3x3f', wgslType: 'mat3x3f' };
const mat3x4f$1 = { type: 'mat3x4f', wgslType: 'mat3x4f' };
const mat4x2f$1 = { type: 'mat4x2f', wgslType: 'mat4x2f' };
const mat4x3f$1 = { type: 'mat4x3f', wgslType: 'mat4x3f' };
const mat4x4f$1 = { type: 'mat4x4f', wgslType: 'mat4x4f' };
const mat2x2h$1 = { type: 'mat2x2h', wgslType: 'mat2x2h' };
const mat2x3h$1 = { type: 'mat2x3h', wgslType: 'mat2x3h' };
const mat2x4h$1 = { type: 'mat2x4h', wgslType: 'mat2x4h' };
const mat3x2h$1 = { type: 'mat3x2h', wgslType: 'mat3x2h' };
const mat3x3h$1 = { type: 'mat3x3h', wgslType: 'mat3x3h' };
const mat3x4h$1 = { type: 'mat3x4h', wgslType: 'mat3x4h' };
const mat4x2h$1 = { type: 'mat4x2h', wgslType: 'mat4x2h' };
const mat4x3h$1 = { type: 'mat4x3h', wgslType: 'mat4x3h' };
const mat4x4h$1 = { type: 'mat4x4h', wgslType: 'mat4x4h' };
function texture1d(sampleType) {
    const s = (sampleType ?? f32$1);
    return { type: 'texture_1d', wgslType: `texture_1d<${s.wgslType}>`, sampleType: s };
}
function texture2d(sampleType) {
    const s = (sampleType ?? f32$1);
    return { type: 'texture_2d', wgslType: `texture_2d<${s.wgslType}>`, sampleType: s };
}
function texture2dArray(sampleType) {
    const s = (sampleType ?? f32$1);
    return { type: 'texture_2d_array', wgslType: `texture_2d_array<${s.wgslType}>`, sampleType: s };
}
function texture3d(sampleType) {
    const s = (sampleType ?? f32$1);
    return { type: 'texture_3d', wgslType: `texture_3d<${s.wgslType}>`, sampleType: s };
}
function textureCube(sampleType) {
    const s = (sampleType ?? f32$1);
    return { type: 'texture_cube', wgslType: `texture_cube<${s.wgslType}>`, sampleType: s };
}
function textureCubeArray(sampleType) {
    const s = (sampleType ?? f32$1);
    return { type: 'texture_cube_array', wgslType: `texture_cube_array<${s.wgslType}>`, sampleType: s };
}
function textureMultisampled2d(sampleType) {
    const s = (sampleType ?? f32$1);
    return { type: 'texture_multisampled_2d', wgslType: `texture_multisampled_2d<${s.wgslType}>`, sampleType: s };
}
/** Runtime version of SampleResultOf — maps a sample type descriptor to its vec4 result. */
function sampleResultOf(s) {
    if (s.type === 'f32')
        return vec4f$1;
    if (s.type === 'i32')
        return vec4i$1;
    return vec4u$1;
}
/** Runtime version of TextureSampleResultOf — maps a texture descriptor to its sampling return descriptor. */
function textureSampleResultOf(desc) {
    if (isDepthTextureDesc(desc))
        return f32$1;
    return sampleResultOf(desc.sampleType);
}
const textureDepth2d = { type: 'texture_depth_2d', wgslType: 'texture_depth_2d' };
const textureDepth2dArray = { type: 'texture_depth_2d_array', wgslType: 'texture_depth_2d_array' };
const textureDepthCube = { type: 'texture_depth_cube', wgslType: 'texture_depth_cube' };
const textureDepthCubeArray = { type: 'texture_depth_cube_array', wgslType: 'texture_depth_cube_array' };
const textureDepthMultisampled2d = { type: 'texture_depth_multisampled_2d', wgslType: 'texture_depth_multisampled_2d' };
const sampler$1 = { type: 'sampler', wgslType: 'sampler' };
const samplerComparison = { type: 'sampler_comparison', wgslType: 'sampler_comparison' };
const voidDesc = { type: 'void', wgslType: 'void' };
const wgslfn = { type: 'wgslfn', wgslType: 'wgslfn' };
// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------
function isAtomicDesc(desc) {
    return desc.type === 'atomic';
}
function isStructDesc(desc) {
    return desc.type === 'struct';
}
function isArrayDesc(desc) {
    return desc.type === 'array';
}
function isSizedArrayDesc(desc) {
    return desc.type === 'sized-array';
}
function isTextureDesc(desc) {
    return desc.type.startsWith('texture_') && !desc.type.startsWith('texture_depth_');
}
function isDepthTextureDesc(desc) {
    return desc.type.startsWith('texture_depth_');
}
function isAnyTextureDesc(desc) {
    return desc.type.startsWith('texture_');
}
function isCubeTextureDesc(desc) {
    return desc.type === 'texture_cube' || desc.type === 'texture_depth_cube';
}
function isCubeArrayTextureDesc(desc) {
    return desc.type === 'texture_cube_array' || desc.type === 'texture_depth_cube_array';
}
function isArrayTextureDesc(desc) {
    return desc.type === 'texture_2d_array' || desc.type === 'texture_depth_2d_array';
}
/** Returns the GPUTextureDimension for a texture schema type */
function textureDimension(desc) {
    if (desc.type === 'texture_1d')
        return '1d';
    if (desc.type === 'texture_3d')
        return '3d';
    return '2d';
}
/** Returns the GPUTextureViewDimension for a texture schema type */
function textureViewDimension(desc) {
    switch (desc.type) {
        case 'texture_1d': return '1d';
        case 'texture_2d':
        case 'texture_depth_2d':
        case 'texture_multisampled_2d':
        case 'texture_depth_multisampled_2d':
            return '2d';
        case 'texture_2d_array':
        case 'texture_depth_2d_array':
            return '2d-array';
        case 'texture_cube':
        case 'texture_depth_cube':
            return 'cube';
        case 'texture_cube_array':
        case 'texture_depth_cube_array':
            return 'cube-array';
        case 'texture_3d':
            return '3d';
        default:
            return '2d';
    }
}
function isSamplerDesc(desc) {
    return desc.type === 'sampler';
}
function isSamplerComparisonDesc(desc) {
    return desc.type === 'sampler_comparison';
}
function isMatDesc(desc) {
    return desc.wgslType.startsWith('mat');
}
function isVecDesc(desc) {
    return desc.wgslType.startsWith('vec');
}
// Legacy alias
function isStructDef(desc) {
    return isStructDesc(desc);
}
function atomic(inner) {
    if (inner.type === 'i32') {
        return { type: 'atomic', wgslType: 'atomic<i32>', inner };
    }
    return { type: 'atomic', wgslType: 'atomic<u32>', inner };
}
function struct$1(name, fields) {
    return { type: 'struct', wgslType: name, name, fields };
}
function array$1(element) {
    return { type: 'array', wgslType: `array<${element.wgslType}>`, element };
}
function sizedArray(element, length) {
    return { type: 'sized-array', wgslType: `array<${element.wgslType}, ${length}>`, element, length };
}
// ---------------------------------------------------------------------------
// Sampler factory functions
// ---------------------------------------------------------------------------
const samplerDesc = () => ({
    type: 'sampler', wgslType: 'sampler',
});
const samplerComparisonDesc = () => ({
    type: 'sampler_comparison', wgslType: 'sampler_comparison',
});
// ---------------------------------------------------------------------------
// WGSL std430 layout utilities
// ---------------------------------------------------------------------------
function roundUp$1(n, align) {
    return Math.ceil(n / align) * align;
}
function wgslAlignOf(desc) {
    if (isStructDesc(desc)) {
        let maxAlign = 4;
        for (const field of Object.values(desc.fields)) {
            maxAlign = Math.max(maxAlign, wgslAlignOf(field));
        }
        return maxAlign;
    }
    if (isArrayDesc(desc) || isSizedArrayDesc(desc))
        return wgslAlignOf(desc.element);
    if (isAtomicDesc(desc))
        return 4;
    const t = desc.wgslType;
    if (t === 'f16' || t === 'vec2h')
        return 4;
    if (t === 'vec3h' || t === 'vec4h')
        return 8;
    if (t === 'mat2x2h')
        return 4;
    if (t === 'mat2x3h' || t === 'mat3x2h')
        return 8;
    if (t === 'mat2x4h' || t === 'mat4x2h')
        return 8;
    if (t === 'mat3x3h' || t === 'mat3x4h' || t === 'mat4x3h' || t === 'mat4x4h')
        return 8;
    if (t === 'f32' || t === 'i32' || t === 'u32' || t === 'bool')
        return 4;
    if (t === 'vec2f' || t === 'vec2i' || t === 'vec2u' || t === 'vec2<bool>')
        return 8;
    if (t === 'vec3f' || t === 'vec3i' || t === 'vec3u' || t === 'vec3<bool>')
        return 16;
    if (t === 'vec4f' || t === 'vec4i' || t === 'vec4u' || t === 'vec4<bool>')
        return 16;
    if (t === 'mat2x2f')
        return 8;
    if (t === 'mat2x3f' || t === 'mat3x3f' || t === 'mat4x3f')
        return 16;
    if (t === 'mat2x4f' || t === 'mat3x4f' || t === 'mat4x4f')
        return 16;
    if (t === 'mat3x2f' || t === 'mat4x2f')
        return 8;
    throw new Error(`[gpucat] wgslAlignOf: unsupported type '${t}'`);
}
function wgslSizeOf(desc) {
    if (isStructDesc(desc)) {
        const structAlign = wgslAlignOf(desc);
        let offset = 0;
        for (const field of Object.values(desc.fields)) {
            offset = roundUp$1(offset, wgslAlignOf(field)) + wgslSizeOf(field);
        }
        return roundUp$1(offset, structAlign);
    }
    if (isSizedArrayDesc(desc)) {
        return desc.length * wgslStrideOf(desc.element);
    }
    if (isArrayDesc(desc)) {
        throw new Error(`[gpucat] wgslSizeOf: cannot compute static size of runtime-sized array '${desc.wgslType}'`);
    }
    if (isAtomicDesc(desc))
        return 4;
    const t = desc.wgslType;
    if (t === 'f16')
        return 2;
    if (t === 'f32' || t === 'i32' || t === 'u32' || t === 'bool')
        return 4;
    if (t === 'vec2f' || t === 'vec2i' || t === 'vec2u' || t === 'vec2<bool>')
        return 8;
    if (t === 'vec2h')
        return 4;
    if (t === 'vec3f' || t === 'vec3i' || t === 'vec3u' || t === 'vec3<bool>')
        return 12;
    if (t === 'vec3h')
        return 6;
    if (t === 'vec4f' || t === 'vec4i' || t === 'vec4u' || t === 'vec4<bool>')
        return 16;
    if (t === 'vec4h')
        return 8;
    if (t === 'mat2x2f')
        return 2 * 8;
    if (t === 'mat2x2h')
        return 2 * 4;
    if (t === 'mat3x2f')
        return 3 * 8;
    if (t === 'mat3x2h')
        return 3 * 4;
    if (t === 'mat4x2f')
        return 4 * 8;
    if (t === 'mat4x2h')
        return 4 * 4;
    if (t === 'mat2x3f')
        return 2 * 16;
    if (t === 'mat2x3h')
        return 2 * 8;
    if (t === 'mat3x3f')
        return 3 * 16;
    if (t === 'mat3x3h')
        return 3 * 8;
    if (t === 'mat4x3f')
        return 4 * 16;
    if (t === 'mat4x3h')
        return 4 * 8;
    if (t === 'mat2x4f')
        return 2 * 16;
    if (t === 'mat2x4h')
        return 2 * 8;
    if (t === 'mat3x4f')
        return 3 * 16;
    if (t === 'mat3x4h')
        return 3 * 8;
    if (t === 'mat4x4f')
        return 4 * 16;
    if (t === 'mat4x4h')
        return 4 * 8;
    throw new Error(`[gpucat] wgslSizeOf: unsupported type '${t}'`);
}
function wgslStrideOf(desc) {
    return roundUp$1(wgslSizeOf(desc), wgslAlignOf(desc));
}
// ---------------------------------------------------------------------------
// Buffer packing helpers
// ---------------------------------------------------------------------------
function itemSizeOf(desc) {
    const t = desc.wgslType;
    if (t === 'f32' || t === 'i32' || t === 'u32' || t === 'bool' || t === 'f16')
        return 1;
    if (t === 'vec2f' || t === 'vec2i' || t === 'vec2u' || t === 'vec2<bool>' || t === 'vec2h')
        return 2;
    if (t === 'vec3f' || t === 'vec3i' || t === 'vec3u' || t === 'vec3<bool>' || t === 'vec3h')
        return 3;
    if (t === 'vec4f' || t === 'vec4i' || t === 'vec4u' || t === 'vec4<bool>' || t === 'vec4h')
        return 4;
    if (t === 'mat2x2f' || t === 'mat2x2h')
        return 4;
    if (t === 'mat2x3f' || t === 'mat3x2f' || t === 'mat2x3h' || t === 'mat3x2h')
        return 6;
    if (t === 'mat2x4f' || t === 'mat4x2f' || t === 'mat2x4h' || t === 'mat4x2h')
        return 8;
    if (t === 'mat3x3f' || t === 'mat3x3h')
        return 9;
    if (t === 'mat3x4f' || t === 'mat4x3f' || t === 'mat3x4h' || t === 'mat4x3h')
        return 12;
    if (t === 'mat4x4f' || t === 'mat4x4h')
        return 16;
    throw new Error(`[gpucat] itemSizeOf: unsupported type '${t}'`);
}
function typedArrayCtorOf(desc) {
    const t = desc.wgslType;
    if (t === 'i32' || t === 'vec2i' || t === 'vec3i' || t === 'vec4i')
        return Int32Array;
    if (t === 'u32' || t === 'vec2u' || t === 'vec3u' || t === 'vec4u')
        return Uint32Array;
    return Float32Array;
}
// ---------------------------------------------------------------------------
// Lookup descriptor by WGSL type string
// ---------------------------------------------------------------------------
const WGSL_TYPE_TO_DESC = {
    'f32': f32$1, 'i32': i32$1, 'u32': u32$1, 'bool': bool$1, 'f16': f16$1,
    'vec2f': vec2f$1, 'vec3f': vec3f$1, 'vec4f': vec4f$1,
    'vec2i': vec2i$1, 'vec3i': vec3i$1, 'vec4i': vec4i$1,
    'vec2u': vec2u$1, 'vec3u': vec3u$1, 'vec4u': vec4u$1,
    'vec2h': vec2h$1, 'vec3h': vec3h$1, 'vec4h': vec4h$1,
    'vec2<bool>': { type: 'vec2<bool>', wgslType: 'vec2<bool>' },
    'vec3<bool>': { type: 'vec3<bool>', wgslType: 'vec3<bool>' },
    'vec4<bool>': { type: 'vec4<bool>', wgslType: 'vec4<bool>' },
    'mat2x2f': mat2x2f$1, 'mat2x3f': mat2x3f$1, 'mat2x4f': mat2x4f$1,
    'mat3x2f': mat3x2f$1, 'mat3x3f': mat3x3f$1, 'mat3x4f': mat3x4f$1,
    'mat4x2f': mat4x2f$1, 'mat4x3f': mat4x3f$1, 'mat4x4f': mat4x4f$1,
    'mat2x2h': mat2x2h$1, 'mat2x3h': mat2x3h$1, 'mat2x4h': mat2x4h$1,
    'mat3x2h': mat3x2h$1, 'mat3x3h': mat3x3h$1, 'mat3x4h': mat3x4h$1,
    'mat4x2h': mat4x2h$1, 'mat4x3h': mat4x3h$1, 'mat4x4h': mat4x4h$1,
    'sampler': sampler$1, 'sampler_comparison': samplerComparison,
    'void': voidDesc,
};
function descFromWgslType(wgslType) {
    const desc = WGSL_TYPE_TO_DESC[wgslType];
    if (desc)
        return desc;
    // For custom types (structs, arrays, textures), return a generic descriptor
    return { type: 'string', wgslType };
}
// ---------------------------------------------------------------------------
// Descriptor-based swizzle helpers (runtime)
// ---------------------------------------------------------------------------
const VEC_ELEMENT_DESC = {
    vec2f: f32$1, vec3f: f32$1, vec4f: f32$1,
    vec2i: i32$1, vec3i: i32$1, vec4i: i32$1,
    vec2u: u32$1, vec3u: u32$1, vec4u: u32$1,
    vec2h: f16$1, vec3h: f16$1, vec4h: f16$1,
    vec2: f32$1, vec3: f32$1, vec4: f32$1,
    'vec2<bool>': bool$1, 'vec3<bool>': bool$1, 'vec4<bool>': bool$1,
};
const VEC2_DESC = {
    f32: vec2f$1, i32: vec2i$1, u32: vec2u$1, f16: vec2h$1, bool: { type: 'vec2<bool>', wgslType: 'vec2<bool>' },
};
const VEC3_DESC = {
    f32: vec3f$1, i32: vec3i$1, u32: vec3u$1, f16: vec3h$1, bool: { type: 'vec3<bool>', wgslType: 'vec3<bool>' },
};
const VEC4_DESC = {
    f32: vec4f$1, i32: vec4i$1, u32: vec4u$1, f16: vec4h$1, bool: { type: 'vec4<bool>', wgslType: 'vec4<bool>' },
};
const SCALAR_DESC = { f32: f32$1, i32: i32$1, u32: u32$1, bool: bool$1, f16: f16$1 };
function vecElementDescOrSelf(desc) {
    const elem = VEC_ELEMENT_DESC[desc.wgslType];
    return elem ?? desc;
}
function vec2DescOf(desc) {
    const elem = VEC_ELEMENT_DESC[desc.wgslType] ?? SCALAR_DESC[desc.wgslType];
    return VEC2_DESC[elem?.wgslType ?? 'f32'] ?? vec2f$1;
}
function vec3DescOf(desc) {
    const elem = VEC_ELEMENT_DESC[desc.wgslType] ?? SCALAR_DESC[desc.wgslType];
    return VEC3_DESC[elem?.wgslType ?? 'f32'] ?? vec3f$1;
}
function vec4DescOf(desc) {
    const elem = VEC_ELEMENT_DESC[desc.wgslType] ?? SCALAR_DESC[desc.wgslType];
    return VEC4_DESC[elem?.wgslType ?? 'f32'] ?? vec4f$1;
}
const MAT_COLUMN_DESC = {
    mat2x2f: vec2f$1, mat3x2f: vec2f$1, mat4x2f: vec2f$1,
    mat2x3f: vec3f$1, mat3x3f: vec3f$1, mat4x3f: vec3f$1,
    mat2x4f: vec4f$1, mat3x4f: vec4f$1, mat4x4f: vec4f$1,
    mat2x2h: vec2h$1, mat3x2h: vec2h$1, mat4x2h: vec2h$1,
    mat2x3h: vec3h$1, mat3x3h: vec3h$1, mat4x3h: vec3h$1,
    mat2x4h: vec4h$1, mat3x4h: vec4h$1, mat4x4h: vec4h$1,
};
function matColumnDesc(desc) {
    return MAT_COLUMN_DESC[desc.wgslType];
}
// ---------------------------------------------------------------------------
// Arithmetic result descriptor helpers (runtime)
// ---------------------------------------------------------------------------
const MAT_TYPES_SET = new Set([
    'mat2x2f', 'mat2x3f', 'mat2x4f', 'mat3x2f', 'mat3x3f', 'mat3x4f', 'mat4x2f', 'mat4x3f', 'mat4x4f',
    'mat2x2h', 'mat2x3h', 'mat2x4h', 'mat3x2h', 'mat3x3h', 'mat3x4h', 'mat4x2h', 'mat4x3h', 'mat4x4h',
]);
const VEC_TYPES_SET = new Set(Object.keys(VEC_ELEMENT_DESC));
const SCALAR_TYPES_SET = new Set(['f32', 'i32', 'u32', 'bool', 'f16']);
function mulResultDesc(a, b) {
    if (MAT_TYPES_SET.has(a.wgslType))
        return VEC_TYPES_SET.has(b.wgslType) ? b : a;
    if (SCALAR_TYPES_SET.has(b.wgslType))
        return a;
    if (SCALAR_TYPES_SET.has(a.wgslType))
        return b;
    return a;
}
function arithResultDesc(a, b) {
    if (SCALAR_TYPES_SET.has(a.wgslType))
        return SCALAR_TYPES_SET.has(b.wgslType) ? a : b;
    return a;
}
const COMPARE_RESULT = {
    vec2f: vec2bool, vec2i: vec2bool, vec2u: vec2bool, vec2h: vec2bool,
    vec3f: vec3bool, vec3i: vec3bool, vec3u: vec3bool, vec3h: vec3bool,
    vec4f: vec4bool, vec4i: vec4bool, vec4u: vec4bool, vec4h: vec4bool,
};
function compareResultDesc(d) {
    return COMPARE_RESULT[d.wgslType] ?? bool$1;
}

var schema = /*#__PURE__*/Object.freeze({
    __proto__: null,
    arithResultDesc: arithResultDesc,
    array: array$1,
    atomic: atomic,
    bool: bool$1,
    compareResultDesc: compareResultDesc,
    descFromWgslType: descFromWgslType,
    f16: f16$1,
    f32: f32$1,
    i32: i32$1,
    isAnyTextureDesc: isAnyTextureDesc,
    isArrayDesc: isArrayDesc,
    isArrayTextureDesc: isArrayTextureDesc,
    isAtomicDesc: isAtomicDesc,
    isCubeArrayTextureDesc: isCubeArrayTextureDesc,
    isCubeTextureDesc: isCubeTextureDesc,
    isDepthTextureDesc: isDepthTextureDesc,
    isMatDesc: isMatDesc,
    isSamplerComparisonDesc: isSamplerComparisonDesc,
    isSamplerDesc: isSamplerDesc,
    isSizedArrayDesc: isSizedArrayDesc,
    isStructDef: isStructDef,
    isStructDesc: isStructDesc,
    isTextureDesc: isTextureDesc,
    isVecDesc: isVecDesc,
    itemSizeOf: itemSizeOf,
    mat2x2f: mat2x2f$1,
    mat2x2h: mat2x2h$1,
    mat2x3f: mat2x3f$1,
    mat2x3h: mat2x3h$1,
    mat2x4f: mat2x4f$1,
    mat2x4h: mat2x4h$1,
    mat3x2f: mat3x2f$1,
    mat3x2h: mat3x2h$1,
    mat3x3f: mat3x3f$1,
    mat3x3h: mat3x3h$1,
    mat3x4f: mat3x4f$1,
    mat3x4h: mat3x4h$1,
    mat4x2f: mat4x2f$1,
    mat4x2h: mat4x2h$1,
    mat4x3f: mat4x3f$1,
    mat4x3h: mat4x3h$1,
    mat4x4f: mat4x4f$1,
    mat4x4h: mat4x4h$1,
    matColumnDesc: matColumnDesc,
    mulResultDesc: mulResultDesc,
    roundUp: roundUp$1,
    sampleResultOf: sampleResultOf,
    sampler: sampler$1,
    samplerComparison: samplerComparison,
    samplerComparisonDesc: samplerComparisonDesc,
    samplerDesc: samplerDesc,
    sizedArray: sizedArray,
    struct: struct$1,
    texture1d: texture1d,
    texture2d: texture2d,
    texture2dArray: texture2dArray,
    texture3d: texture3d,
    textureCube: textureCube,
    textureCubeArray: textureCubeArray,
    textureDepth2d: textureDepth2d,
    textureDepth2dArray: textureDepth2dArray,
    textureDepthCube: textureDepthCube,
    textureDepthCubeArray: textureDepthCubeArray,
    textureDepthMultisampled2d: textureDepthMultisampled2d,
    textureDimension: textureDimension,
    textureMultisampled2d: textureMultisampled2d,
    textureSampleResultOf: textureSampleResultOf,
    textureViewDimension: textureViewDimension,
    typedArrayCtorOf: typedArrayCtorOf,
    u32: u32$1,
    vec2DescOf: vec2DescOf,
    vec2bool: vec2bool,
    vec2f: vec2f$1,
    vec2h: vec2h$1,
    vec2i: vec2i$1,
    vec2u: vec2u$1,
    vec3DescOf: vec3DescOf,
    vec3bool: vec3bool,
    vec3f: vec3f$1,
    vec3h: vec3h$1,
    vec3i: vec3i$1,
    vec3u: vec3u$1,
    vec4DescOf: vec4DescOf,
    vec4bool: vec4bool,
    vec4f: vec4f$1,
    vec4h: vec4h$1,
    vec4i: vec4i$1,
    vec4u: vec4u$1,
    vecElementDescOrSelf: vecElementDescOrSelf,
    voidDesc: voidDesc,
    wgslAlignOf: wgslAlignOf,
    wgslSizeOf: wgslSizeOf,
    wgslStrideOf: wgslStrideOf,
    wgslfn: wgslfn
});

// ─── Node id utilities ────────────────────────────────────────────────────────
let _nodeId = 0;
// ─── Runtime type lookup tables ───────────────────────────────────────────────
const VEC_ELEMENT = {
    vec2f: 'f32', vec3f: 'f32', vec4f: 'f32',
    vec2i: 'i32', vec3i: 'i32', vec4i: 'i32',
    vec2u: 'u32', vec3u: 'u32', vec4u: 'u32',
    vec2h: 'f16', vec3h: 'f16', vec4h: 'f16',
};
new Set(Object.keys(VEC_ELEMENT));
// ─── Stack context ────────────────────────────────────────────────────────────
let currentStack = null;
function pushStack(stack) {
    const prev = currentStack;
    currentStack = stack;
    return prev;
}
function popStack(prev) { currentStack = prev; }
function addToStack(node) {
    if (currentStack === null)
        throw new Error(`[gpucat] Control flow (toVar, If, For, Return, Discard) must be called inside a Fn body. ` +
            `You are calling it outside of any Fn — wrap your code in Fn([...], () => { ... }).`);
    currentStack.push(node);
}
// ─── Node base class ──────────────────────────────────────────────────────────
const NodeUpdateType = {
    NONE: 'none',
    FRAME: 'frame',
    RENDER: 'render',
    OBJECT: 'object',
};
class Node {
    id;
    type;
    _beforeNodes = null;
    updateType = NodeUpdateType.NONE;
    updateBeforeType = NodeUpdateType.NONE;
    updateAfterType = NodeUpdateType.NONE;
    global = false;
    parents = false;
    isNode = true;
    constructor(type) {
        this.id = _nodeId++;
        this.type = type;
    }
    onUpdate(callback, updateType) {
        this.updateType = updateType;
        this.update = callback;
        return this;
    }
    onRenderUpdate(callback) { return this.onUpdate(callback, NodeUpdateType.RENDER); }
    onObjectUpdate(callback) { return this.onUpdate(callback, NodeUpdateType.OBJECT); }
    onFrameUpdate(callback) { return this.onUpdate(callback, NodeUpdateType.FRAME); }
    onBeforeUpdate(callback, updateType) {
        this.updateBeforeType = updateType;
        this.updateBefore = callback;
        return this;
    }
    onBeforeRender(callback) { return this.onBeforeUpdate(callback, NodeUpdateType.RENDER); }
    onBeforeObject(callback) { return this.onBeforeUpdate(callback, NodeUpdateType.OBJECT); }
    onBeforeFrame(callback) { return this.onBeforeUpdate(callback, NodeUpdateType.FRAME); }
    onAfterUpdate(callback, updateType) {
        this.updateAfterType = updateType;
        this.updateAfter = callback;
        return this;
    }
    onAfterRender(callback) { return this.onAfterUpdate(callback, NodeUpdateType.RENDER); }
    onAfterObject(callback) { return this.onAfterUpdate(callback, NodeUpdateType.OBJECT); }
    onAfterFrame(callback) { return this.onAfterUpdate(callback, NodeUpdateType.FRAME); }
    before(node) {
        if (this._beforeNodes === null)
            this._beforeNodes = [];
        this._beforeNodes.push(node);
        return this;
    }
    // ── Type conversions ──────────────────────────────────────────────────────
    toF32() { return new CallNode(f32$1, 'f32', [this]); }
    toF16() { return new CallNode(f16$1, 'f16', [this]); }
    toU32() { return new CallNode(u32$1, 'u32', [this]); }
    toI32() { return new CallNode(i32$1, 'i32', [this]); }
    // ── Field access ──────────────────────────────────────────────────────────
    field(name) {
        return field(this, name);
    }
    fields() {
        return fields(this);
    }
    // ── Comparisons ───────────────────────────────────────────────────────────
    greaterThan(b) { return greaterThan(this, b); }
    lessThan(b) { return lessThan(this, b); }
    greaterThanEqual(b) { return greaterThanEqual(this, b); }
    lessThanEqual(b) { return lessThanEqual(this, b); }
    equal(b) { return equal(this, b); }
    notEqual(b) { return notEqual(this, b); }
    /** `select(falseVal, trueVal, this)` — use `this` node as the condition. */
    select(ifTrue, ifFalse) { return new CondNode(this, ifTrue, ifFalse); }
    any() { return any(this); }
    all() { return all(this); }
    // ── Math ──────────────────────────────────────────────────────────────────
    add(b) { return add$1(this, b); }
    sub(b) { return sub(this, b); }
    div(b) { return div(this, b); }
    mul(b) { return mul(this, b); }
    abs() { return abs(this); }
    floor() { return floor(this); }
    ceil() { return ceil(this); }
    fract() { return fract(this); }
    sqrt() { return sqrt(this); }
    sin() { return sin(this); }
    cos() { return cos(this); }
    negate() { return negate$1(this); }
    normalize() { return normalize$4(this); }
    length() { return length$1(this); }
    dot(b) { return dot$1(this, b); }
    cross(b) { return cross$1(this, b); }
    pow(b) { return pow(this, b); }
    max(b) { return max(this, b); }
    min(b) { return min(this, b); }
    clamp(lo, hi) { return clamp(this, lo, hi); }
    mix(b, t) { return mix(this, b, t); }
    step(x) { return step(this, x); }
    smoothstep(hi, x) { return smoothstep(this, hi, x); }
    // ── Element access ────────────────────────────────────────────────────────
    element(idx) {
        const t = this.type;
        if (t.type === 'array' || t.type === 'sized-array') {
            return new IndexNode(t.element, this, idx);
        }
        if (isMatDesc(t)) {
            return new IndexNode(matColumnDesc(t), this, idx);
        }
        if (isVecDesc(t)) {
            return new IndexNode(vecElementDescOrSelf(t), this, idx);
        }
        throw new Error(`[gpucat] Cannot index into type '${t.wgslType}' — only array, matrix, and vector types support .element().`);
    }
    // ── Lang ──────────────────────────────────────────────────────────────────
    assign(value) { addToStack(new AssignNode(this, value)); }
    toVar(label) { return Var(this, label); }
    toConst(label) { return Let(this, label); }
    addAssign(v) { addToStack(new AssignNode(this, add$1(this, v))); }
    subAssign(v) { addToStack(new AssignNode(this, sub(this, v))); }
    mulAssign(v) { addToStack(new AssignNode(this, mul(this, v))); }
    divAssign(v) { addToStack(new AssignNode(this, div(this, v))); }
    sign() { return sign(this); }
    mod(b) { return mod(this, b); }
    oneMinus() { return sub(f32(1), this); }
    or(b) { return or(this, b); }
    and(b) { return and(this, b); }
    not() { return not(this); }
    transpose() { return new CallNode(this.type, 'transpose', [this]); }
    // ── Swizzles ──────────────────────────────────────────────────────────────
    get x() { return new FieldNode(vecElementDescOrSelf(this.type), this, 'x'); }
    get y() { return new FieldNode(vecElementDescOrSelf(this.type), this, 'y'); }
    get z() { return new FieldNode(vecElementDescOrSelf(this.type), this, 'z'); }
    get w() { return new FieldNode(vecElementDescOrSelf(this.type), this, 'w'); }
    get r() { return new FieldNode(vecElementDescOrSelf(this.type), this, 'x'); }
    get g() { return new FieldNode(vecElementDescOrSelf(this.type), this, 'y'); }
    get b() { return new FieldNode(vecElementDescOrSelf(this.type), this, 'z'); }
    get a() { return new FieldNode(vecElementDescOrSelf(this.type), this, 'w'); }
    get xx() { return new FieldNode(vec2DescOf(this.type), this, 'xx'); }
    get xy() { return new FieldNode(vec2DescOf(this.type), this, 'xy'); }
    get xz() { return new FieldNode(vec2DescOf(this.type), this, 'xz'); }
    get xw() { return new FieldNode(vec2DescOf(this.type), this, 'xw'); }
    get yx() { return new FieldNode(vec2DescOf(this.type), this, 'yx'); }
    get yy() { return new FieldNode(vec2DescOf(this.type), this, 'yy'); }
    get yz() { return new FieldNode(vec2DescOf(this.type), this, 'yz'); }
    get yw() { return new FieldNode(vec2DescOf(this.type), this, 'yw'); }
    get zx() { return new FieldNode(vec2DescOf(this.type), this, 'zx'); }
    get zy() { return new FieldNode(vec2DescOf(this.type), this, 'zy'); }
    get zz() { return new FieldNode(vec2DescOf(this.type), this, 'zz'); }
    get zw() { return new FieldNode(vec2DescOf(this.type), this, 'zw'); }
    get wx() { return new FieldNode(vec2DescOf(this.type), this, 'wx'); }
    get wy() { return new FieldNode(vec2DescOf(this.type), this, 'wy'); }
    get wz() { return new FieldNode(vec2DescOf(this.type), this, 'wz'); }
    get ww() { return new FieldNode(vec2DescOf(this.type), this, 'ww'); }
    get rr() { return new FieldNode(vec2DescOf(this.type), this, 'xx'); }
    get rg() { return new FieldNode(vec2DescOf(this.type), this, 'xy'); }
    get rb() { return new FieldNode(vec2DescOf(this.type), this, 'xz'); }
    get ra() { return new FieldNode(vec2DescOf(this.type), this, 'xw'); }
    get gr() { return new FieldNode(vec2DescOf(this.type), this, 'yx'); }
    get gg() { return new FieldNode(vec2DescOf(this.type), this, 'yy'); }
    get gb() { return new FieldNode(vec2DescOf(this.type), this, 'yz'); }
    get ga() { return new FieldNode(vec2DescOf(this.type), this, 'yw'); }
    get br() { return new FieldNode(vec2DescOf(this.type), this, 'zx'); }
    get bg() { return new FieldNode(vec2DescOf(this.type), this, 'zy'); }
    get bb() { return new FieldNode(vec2DescOf(this.type), this, 'zz'); }
    get ba() { return new FieldNode(vec2DescOf(this.type), this, 'zw'); }
    get ar() { return new FieldNode(vec2DescOf(this.type), this, 'wx'); }
    get ag() { return new FieldNode(vec2DescOf(this.type), this, 'wy'); }
    get ab() { return new FieldNode(vec2DescOf(this.type), this, 'wz'); }
    get aa() { return new FieldNode(vec2DescOf(this.type), this, 'ww'); }
    get xxx() { return new FieldNode(vec3DescOf(this.type), this, 'xxx'); }
    get xxy() { return new FieldNode(vec3DescOf(this.type), this, 'xxy'); }
    get xxz() { return new FieldNode(vec3DescOf(this.type), this, 'xxz'); }
    get xxw() { return new FieldNode(vec3DescOf(this.type), this, 'xxw'); }
    get xyx() { return new FieldNode(vec3DescOf(this.type), this, 'xyx'); }
    get xyy() { return new FieldNode(vec3DescOf(this.type), this, 'xyy'); }
    get xyz() { return new FieldNode(vec3DescOf(this.type), this, 'xyz'); }
    get xyw() { return new FieldNode(vec3DescOf(this.type), this, 'xyw'); }
    get xzx() { return new FieldNode(vec3DescOf(this.type), this, 'xzx'); }
    get xzy() { return new FieldNode(vec3DescOf(this.type), this, 'xzy'); }
    get xzz() { return new FieldNode(vec3DescOf(this.type), this, 'xzz'); }
    get xzw() { return new FieldNode(vec3DescOf(this.type), this, 'xzw'); }
    get xwx() { return new FieldNode(vec3DescOf(this.type), this, 'xwx'); }
    get xwy() { return new FieldNode(vec3DescOf(this.type), this, 'xwy'); }
    get xwz() { return new FieldNode(vec3DescOf(this.type), this, 'xwz'); }
    get xww() { return new FieldNode(vec3DescOf(this.type), this, 'xww'); }
    get yxx() { return new FieldNode(vec3DescOf(this.type), this, 'yxx'); }
    get yxy() { return new FieldNode(vec3DescOf(this.type), this, 'yxy'); }
    get yxz() { return new FieldNode(vec3DescOf(this.type), this, 'yxz'); }
    get yxw() { return new FieldNode(vec3DescOf(this.type), this, 'yxw'); }
    get yyx() { return new FieldNode(vec3DescOf(this.type), this, 'yyx'); }
    get yyy() { return new FieldNode(vec3DescOf(this.type), this, 'yyy'); }
    get yyz() { return new FieldNode(vec3DescOf(this.type), this, 'yyz'); }
    get yyw() { return new FieldNode(vec3DescOf(this.type), this, 'yyw'); }
    get yzx() { return new FieldNode(vec3DescOf(this.type), this, 'yzx'); }
    get yzy() { return new FieldNode(vec3DescOf(this.type), this, 'yzy'); }
    get yzz() { return new FieldNode(vec3DescOf(this.type), this, 'yzz'); }
    get yzw() { return new FieldNode(vec3DescOf(this.type), this, 'yzw'); }
    get ywx() { return new FieldNode(vec3DescOf(this.type), this, 'ywx'); }
    get ywy() { return new FieldNode(vec3DescOf(this.type), this, 'ywy'); }
    get ywz() { return new FieldNode(vec3DescOf(this.type), this, 'ywz'); }
    get yww() { return new FieldNode(vec3DescOf(this.type), this, 'yww'); }
    get zxx() { return new FieldNode(vec3DescOf(this.type), this, 'zxx'); }
    get zxy() { return new FieldNode(vec3DescOf(this.type), this, 'zxy'); }
    get zxz() { return new FieldNode(vec3DescOf(this.type), this, 'zxz'); }
    get zxw() { return new FieldNode(vec3DescOf(this.type), this, 'zxw'); }
    get zyx() { return new FieldNode(vec3DescOf(this.type), this, 'zyx'); }
    get zyy() { return new FieldNode(vec3DescOf(this.type), this, 'zyy'); }
    get zyz() { return new FieldNode(vec3DescOf(this.type), this, 'zyz'); }
    get zyw() { return new FieldNode(vec3DescOf(this.type), this, 'zyw'); }
    get zzx() { return new FieldNode(vec3DescOf(this.type), this, 'zzx'); }
    get zzy() { return new FieldNode(vec3DescOf(this.type), this, 'zzy'); }
    get zzz() { return new FieldNode(vec3DescOf(this.type), this, 'zzz'); }
    get zzw() { return new FieldNode(vec3DescOf(this.type), this, 'zzw'); }
    get zwx() { return new FieldNode(vec3DescOf(this.type), this, 'zwx'); }
    get zwy() { return new FieldNode(vec3DescOf(this.type), this, 'zwy'); }
    get zwz() { return new FieldNode(vec3DescOf(this.type), this, 'zwz'); }
    get zww() { return new FieldNode(vec3DescOf(this.type), this, 'zww'); }
    get wxx() { return new FieldNode(vec3DescOf(this.type), this, 'wxx'); }
    get wxy() { return new FieldNode(vec3DescOf(this.type), this, 'wxy'); }
    get wxz() { return new FieldNode(vec3DescOf(this.type), this, 'wxz'); }
    get wxw() { return new FieldNode(vec3DescOf(this.type), this, 'wxw'); }
    get wyx() { return new FieldNode(vec3DescOf(this.type), this, 'wyx'); }
    get wyy() { return new FieldNode(vec3DescOf(this.type), this, 'wyy'); }
    get wyz() { return new FieldNode(vec3DescOf(this.type), this, 'wyz'); }
    get wyw() { return new FieldNode(vec3DescOf(this.type), this, 'wyw'); }
    get wzx() { return new FieldNode(vec3DescOf(this.type), this, 'wzx'); }
    get wzy() { return new FieldNode(vec3DescOf(this.type), this, 'wzy'); }
    get wzz() { return new FieldNode(vec3DescOf(this.type), this, 'wzz'); }
    get wzw() { return new FieldNode(vec3DescOf(this.type), this, 'wzw'); }
    get wwx() { return new FieldNode(vec3DescOf(this.type), this, 'wwx'); }
    get wwy() { return new FieldNode(vec3DescOf(this.type), this, 'wwy'); }
    get wwz() { return new FieldNode(vec3DescOf(this.type), this, 'wwz'); }
    get www() { return new FieldNode(vec3DescOf(this.type), this, 'www'); }
    get rrr() { return new FieldNode(vec3DescOf(this.type), this, 'xxx'); }
    get rrg() { return new FieldNode(vec3DescOf(this.type), this, 'xxy'); }
    get rrb() { return new FieldNode(vec3DescOf(this.type), this, 'xxz'); }
    get rra() { return new FieldNode(vec3DescOf(this.type), this, 'xxw'); }
    get rgr() { return new FieldNode(vec3DescOf(this.type), this, 'xyx'); }
    get rgg() { return new FieldNode(vec3DescOf(this.type), this, 'xyy'); }
    get rgb() { return new FieldNode(vec3DescOf(this.type), this, 'xyz'); }
    get rga() { return new FieldNode(vec3DescOf(this.type), this, 'xyw'); }
    get rbr() { return new FieldNode(vec3DescOf(this.type), this, 'xzx'); }
    get rbg() { return new FieldNode(vec3DescOf(this.type), this, 'xzy'); }
    get rbb() { return new FieldNode(vec3DescOf(this.type), this, 'xzz'); }
    get rba() { return new FieldNode(vec3DescOf(this.type), this, 'xzw'); }
    get rar() { return new FieldNode(vec3DescOf(this.type), this, 'xwx'); }
    get rag() { return new FieldNode(vec3DescOf(this.type), this, 'xwy'); }
    get rab() { return new FieldNode(vec3DescOf(this.type), this, 'xwz'); }
    get raa() { return new FieldNode(vec3DescOf(this.type), this, 'xww'); }
    get grr() { return new FieldNode(vec3DescOf(this.type), this, 'yxx'); }
    get grg() { return new FieldNode(vec3DescOf(this.type), this, 'yxy'); }
    get grb() { return new FieldNode(vec3DescOf(this.type), this, 'yxz'); }
    get gra() { return new FieldNode(vec3DescOf(this.type), this, 'yxw'); }
    get ggr() { return new FieldNode(vec3DescOf(this.type), this, 'yyx'); }
    get ggg() { return new FieldNode(vec3DescOf(this.type), this, 'yyy'); }
    get ggb() { return new FieldNode(vec3DescOf(this.type), this, 'yyz'); }
    get gga() { return new FieldNode(vec3DescOf(this.type), this, 'yyw'); }
    get gbr() { return new FieldNode(vec3DescOf(this.type), this, 'yzx'); }
    get gbg() { return new FieldNode(vec3DescOf(this.type), this, 'yzy'); }
    get gbb() { return new FieldNode(vec3DescOf(this.type), this, 'yzz'); }
    get gba() { return new FieldNode(vec3DescOf(this.type), this, 'yzw'); }
    get gar() { return new FieldNode(vec3DescOf(this.type), this, 'ywx'); }
    get gag() { return new FieldNode(vec3DescOf(this.type), this, 'ywy'); }
    get gab() { return new FieldNode(vec3DescOf(this.type), this, 'ywz'); }
    get gaa() { return new FieldNode(vec3DescOf(this.type), this, 'yww'); }
    get brr() { return new FieldNode(vec3DescOf(this.type), this, 'zxx'); }
    get brg() { return new FieldNode(vec3DescOf(this.type), this, 'zxy'); }
    get brb() { return new FieldNode(vec3DescOf(this.type), this, 'zxz'); }
    get bra() { return new FieldNode(vec3DescOf(this.type), this, 'zxw'); }
    get bgr() { return new FieldNode(vec3DescOf(this.type), this, 'zyx'); }
    get bgg() { return new FieldNode(vec3DescOf(this.type), this, 'zyy'); }
    get bgb() { return new FieldNode(vec3DescOf(this.type), this, 'zyz'); }
    get bga() { return new FieldNode(vec3DescOf(this.type), this, 'zyw'); }
    get bbr() { return new FieldNode(vec3DescOf(this.type), this, 'zzx'); }
    get bbg() { return new FieldNode(vec3DescOf(this.type), this, 'zzy'); }
    get bbb() { return new FieldNode(vec3DescOf(this.type), this, 'zzz'); }
    get bba() { return new FieldNode(vec3DescOf(this.type), this, 'zzw'); }
    get bar() { return new FieldNode(vec3DescOf(this.type), this, 'zwx'); }
    get bag() { return new FieldNode(vec3DescOf(this.type), this, 'zwy'); }
    get bab() { return new FieldNode(vec3DescOf(this.type), this, 'zwz'); }
    get baa() { return new FieldNode(vec3DescOf(this.type), this, 'zww'); }
    get arr() { return new FieldNode(vec3DescOf(this.type), this, 'wxx'); }
    get arg() { return new FieldNode(vec3DescOf(this.type), this, 'wxy'); }
    get arb() { return new FieldNode(vec3DescOf(this.type), this, 'wxz'); }
    get ara() { return new FieldNode(vec3DescOf(this.type), this, 'wxw'); }
    get agr() { return new FieldNode(vec3DescOf(this.type), this, 'wyx'); }
    get agg() { return new FieldNode(vec3DescOf(this.type), this, 'wyy'); }
    get agb() { return new FieldNode(vec3DescOf(this.type), this, 'wyz'); }
    get aga() { return new FieldNode(vec3DescOf(this.type), this, 'wyw'); }
    get abr() { return new FieldNode(vec3DescOf(this.type), this, 'wzx'); }
    get abg() { return new FieldNode(vec3DescOf(this.type), this, 'wzy'); }
    get abb() { return new FieldNode(vec3DescOf(this.type), this, 'wzz'); }
    get aba() { return new FieldNode(vec3DescOf(this.type), this, 'wzw'); }
    get aar() { return new FieldNode(vec3DescOf(this.type), this, 'wwx'); }
    get aag() { return new FieldNode(vec3DescOf(this.type), this, 'wwy'); }
    get aab() { return new FieldNode(vec3DescOf(this.type), this, 'wwz'); }
    get aaa() { return new FieldNode(vec3DescOf(this.type), this, 'www'); }
    get xyzw() { return new FieldNode(vec4DescOf(this.type), this, 'xyzw'); }
    get xywz() { return new FieldNode(vec4DescOf(this.type), this, 'xywz'); }
    get xzyw() { return new FieldNode(vec4DescOf(this.type), this, 'xzyw'); }
    get xzwy() { return new FieldNode(vec4DescOf(this.type), this, 'xzwy'); }
    get xwyz() { return new FieldNode(vec4DescOf(this.type), this, 'xwyz'); }
    get xwzy() { return new FieldNode(vec4DescOf(this.type), this, 'xwzy'); }
    get yxzw() { return new FieldNode(vec4DescOf(this.type), this, 'yxzw'); }
    get yxwz() { return new FieldNode(vec4DescOf(this.type), this, 'yxwz'); }
    get yzxw() { return new FieldNode(vec4DescOf(this.type), this, 'yzxw'); }
    get yzwx() { return new FieldNode(vec4DescOf(this.type), this, 'yzwx'); }
    get ywxz() { return new FieldNode(vec4DescOf(this.type), this, 'ywxz'); }
    get ywzx() { return new FieldNode(vec4DescOf(this.type), this, 'ywzx'); }
    get zxyw() { return new FieldNode(vec4DescOf(this.type), this, 'zxyw'); }
    get zxwy() { return new FieldNode(vec4DescOf(this.type), this, 'zxwy'); }
    get zyxw() { return new FieldNode(vec4DescOf(this.type), this, 'zyxw'); }
    get zywx() { return new FieldNode(vec4DescOf(this.type), this, 'zywx'); }
    get zwxy() { return new FieldNode(vec4DescOf(this.type), this, 'zwxy'); }
    get zwyx() { return new FieldNode(vec4DescOf(this.type), this, 'zwyx'); }
    get wxyz() { return new FieldNode(vec4DescOf(this.type), this, 'wxyz'); }
    get wxzy() { return new FieldNode(vec4DescOf(this.type), this, 'wxzy'); }
    get wyxz() { return new FieldNode(vec4DescOf(this.type), this, 'wyxz'); }
    get wyzx() { return new FieldNode(vec4DescOf(this.type), this, 'wyzx'); }
    get wzxy() { return new FieldNode(vec4DescOf(this.type), this, 'wzxy'); }
    get wzyx() { return new FieldNode(vec4DescOf(this.type), this, 'wzyx'); }
    get rgba() { return new FieldNode(vec4DescOf(this.type), this, 'xyzw'); }
    get rgab() { return new FieldNode(vec4DescOf(this.type), this, 'xywz'); }
    get rbga() { return new FieldNode(vec4DescOf(this.type), this, 'xzyw'); }
    get rbag() { return new FieldNode(vec4DescOf(this.type), this, 'xzwy'); }
    get ragb() { return new FieldNode(vec4DescOf(this.type), this, 'xwyz'); }
    get rabg() { return new FieldNode(vec4DescOf(this.type), this, 'xwzy'); }
    get grba() { return new FieldNode(vec4DescOf(this.type), this, 'yxzw'); }
    get grab() { return new FieldNode(vec4DescOf(this.type), this, 'yxwz'); }
    get gbra() { return new FieldNode(vec4DescOf(this.type), this, 'yzxw'); }
    get gbar() { return new FieldNode(vec4DescOf(this.type), this, 'yzwx'); }
    get garb() { return new FieldNode(vec4DescOf(this.type), this, 'ywxz'); }
    get gabr() { return new FieldNode(vec4DescOf(this.type), this, 'ywzx'); }
    get brga() { return new FieldNode(vec4DescOf(this.type), this, 'zxyw'); }
    get brag() { return new FieldNode(vec4DescOf(this.type), this, 'zxwy'); }
    get bgra() { return new FieldNode(vec4DescOf(this.type), this, 'zyxw'); }
    get bgar() { return new FieldNode(vec4DescOf(this.type), this, 'zywx'); }
    get barg() { return new FieldNode(vec4DescOf(this.type), this, 'zwxy'); }
    get bagr() { return new FieldNode(vec4DescOf(this.type), this, 'zwyx'); }
    get argb() { return new FieldNode(vec4DescOf(this.type), this, 'wxyz'); }
    get arbg() { return new FieldNode(vec4DescOf(this.type), this, 'wxzy'); }
    get agrb() { return new FieldNode(vec4DescOf(this.type), this, 'wyxz'); }
    get agbr() { return new FieldNode(vec4DescOf(this.type), this, 'wyzx'); }
    get abrg() { return new FieldNode(vec4DescOf(this.type), this, 'wzxy'); }
    get abgr() { return new FieldNode(vec4DescOf(this.type), this, 'wzyx'); }
    // ── Inspector ─────────────────────────────────────────────────────────────
    inspect(name) {
        const inspector = new InspectorNode(this, name);
        this.before(inspector);
        return this;
    }
}
function isNode(v) { return v instanceof Node; }
/**
 * Creates an empty lifecycle node.
 * Useful for attaching update callbacks via .onFrameUpdate(), .onRenderUpdate(), etc.
 * Attach to other nodes via .before() to ensure the lifecycle runs.
 *
 * @example
 * const updater = node().onFrameUpdate(() => {
 *     myUniform.value = computeValue();
 * });
 * return myOutputNode.before(updater);
 */
function node() {
    return new Node(voidDesc);
}
// ─── InspectorNode ────────────────────────────────────────────────────────────
/**
 * InspectorNode wraps a node and registers it with the inspector every frame.
 *
 * Instead of flagging nodes with _isInspectable and manually iterating in the renderer,
 * InspectorNode leverages the existing node update system (updateType = FRAME) to
 * automatically call inspector.inspect() every frame.
 *
 * Key properties:
 * - `wrappedNode`: The original node being inspected
 * - `inspectorName`: Display name for the inspector UI
 * - `updateType = FRAME`: Ensures update() is called once per frame
 *
 * Usage:
 *   const albedo = texture('texture_2d<f32>', 'albedo').inspect('Albedo');
 *
 * The .inspect() method on Node creates an InspectorNode wrapper and attaches it
 * via node.before(), so it gets built and updated alongside the original node.
 */
class InspectorNode extends Node {
    /** The original node being inspected. */
    wrappedNode;
    /** Display name for the inspector UI. */
    inspectorName;
    /** Marker for type checking. */
    isInspectorNode = true;
    constructor(node, name) {
        super(node.type);
        this.wrappedNode = node;
        this.inspectorName = name ?? String(node.id);
        // Key: use the FRAME update type so update() is called every frame
        this.updateType = NodeUpdateType.FRAME;
    }
    /**
     * Called by the node update system every frame.
     * Registers this node with the renderer's inspector.
     */
    update = (frame) => {
        frame.renderer.inspector.inspect(this);
    };
    /**
     * Returns the display name for the inspector.
     */
    getName() {
        return this.inspectorName;
    }
}
// ─── Expr nodes ───────────────────────────────────────────────────────────────
class LiteralNode extends Node {
    value;
    constructor(type, value) {
        super(type);
        this.value = value;
    }
}
class LetNode extends Node {
    varName;
    init;
    constructor(type, varName, init) {
        super(type);
        this.varName = varName;
        this.init = init;
    }
}
class VarNode extends Node {
    varName;
    init;
    constructor(type, varName, init) {
        super(type);
        this.varName = varName;
        this.init = init;
    }
}
// ─── Module-scope variables ───────────────────────────────────────────────────
/**
 * Module-scope private variable: `var<private> name: T [= init];`
 *
 * Private variables are per-invocation storage at module scope.
 * Unlike function-scope variables, they persist across function calls
 * within the same shader invocation.
 *
 * @example
 * const counter = privateVar(d.u32, 'counter');
 * // → var<private> counter: u32;
 *
 * const gravity = privateVar(vec3f(0, -9.8, 0), 'gravity');
 * // → var<private> gravity: vec3f = vec3f(0.0, -9.8, 0.0);
 */
class PrivateVarNode extends Node {
    varName;
    init;
    constructor(type, varName, init) {
        super(type);
        this.varName = varName;
        this.init = init;
    }
}
/**
 * Module-scope workgroup variable: `var<workgroup> name: T;`
 *
 * Workgroup variables are shared across all invocations in a workgroup.
 * Only valid in compute shaders. Cannot have an initializer.
 *
 * @example
 * const shared = workgroupVar(d.array(d.f32, 256), 'sharedData');
 * // → var<workgroup> sharedData: array<f32, 256>;
 */
class WorkgroupVarNode extends Node {
    varName;
    constructor(type, varName) {
        super(type);
        this.varName = varName;
    }
}
class AssignNode extends Node {
    target;
    value;
    constructor(target, value) {
        super(voidDesc);
        this.target = target;
        this.value = value;
    }
}
class BinopNode extends Node {
    op;
    left;
    right;
    constructor(op, type, left, right) {
        super(type);
        this.op = op;
        this.left = left;
        this.right = right;
    }
}
class CallNode extends Node {
    fn;
    args;
    fnNode; // eslint-disable-line @typescript-eslint/no-explicit-any
    wgslFnNode;
    constructor(type, fn, args, fnNode, wgslFnNode) {
        super(type);
        this.fn = fn;
        this.args = args;
        this.fnNode = fnNode;
        this.wgslFnNode = wgslFnNode;
    }
}
class ConstructNode extends Node {
    args;
    constructor(type, args) {
        super(type);
        this.args = args;
    }
}
class FieldNode extends Node {
    object;
    fieldName;
    constructor(type, object, fieldName) {
        super(type);
        this.object = object;
        this.fieldName = fieldName;
    }
}
/**
 * Represents an inline fixed-size array expression in WGSL.
 *
 * Use `array([e0, e1, e2])` to construct, then `.element(idx)` to index into it.
 * This corresponds to WGSL's array value constructor expression.
 */
class ArrayNode extends Node {
    elements;
    constructor(elementType, elements) {
        const sizedArrayDesc = {
            type: 'sized-array',
            wgslType: `array<${elementType.wgslType}, ${elements.length}>`,
            element: elementType,
            length: elements.length,
        };
        super(sizedArrayDesc);
        this.elements = elements;
    }
}
class IndexNode extends Node {
    array;
    index;
    constructor(type, array, index) {
        super(type);
        this.array = array;
        this.index = index;
    }
}
// ── Standalone expr functions ─────────────────────────────────────────────────
/** Type-safe field access for structs - infers the field type from the struct descriptor */
const field = (node, name) => {
    const structDesc = node.type;
    const fieldType = structDesc.fields[name];
    return new FieldNode(fieldType, node, name);
};
const index = (array, idx) => {
    const t = array.type;
    let elementDesc;
    if (t.type === 'array' || t.type === 'sized-array') {
        elementDesc = t.element;
    }
    else if (isMatDesc(t)) {
        elementDesc = matColumnDesc(t);
    }
    else if (isVecDesc(t)) {
        elementDesc = vecElementDescOrSelf(t);
    }
    else {
        throw new Error(`[gpucat] Cannot index into type '${t.wgslType}' — only array, matrix, and vector types support indexing.`);
    }
    return new IndexNode(elementDesc, array, idx);
};
function fields(node) {
    const desc = node.type;
    if (!desc || typeof desc !== 'object' || !('fields' in desc)) {
        throw new Error('[gpucat] fields() requires a struct-typed node');
    }
    const structFields = desc.fields;
    const result = { $node: node };
    for (const [fieldName, fieldDesc] of Object.entries(structFields)) {
        result[fieldName] = new FieldNode(fieldDesc, node, fieldName);
    }
    return result;
}
const greaterThan = (a, b) => new BinopNode('>', compareResultDesc(a.type), a, b);
const lessThan = (a, b) => new BinopNode('<', compareResultDesc(a.type), a, b);
const greaterThanEqual = (a, b) => new BinopNode('>=', compareResultDesc(a.type), a, b);
const lessThanEqual = (a, b) => new BinopNode('<=', compareResultDesc(a.type), a, b);
const equal = (a, b) => new BinopNode('==', compareResultDesc(a.type), a, b);
const notEqual = (a, b) => new BinopNode('!=', compareResultDesc(a.type), a, b);
const any = (a) => new CallNode(bool$1, 'any', [a]);
const all = (a) => new CallNode(bool$1, 'all', [a]);
/**
 * Create an inline fixed-size array of nodes, emitted as `array<E, N>(e0, e1, ..., eN-1)`.
 * All elements must share the same WGSL type.
 * Use `.element(idx)` to index into the result.
 *
 * @example
 * const weights = array([w0, w1, w2]);
 * const w = weights.element(gx);
 */
function array(elements) {
    return new ArrayNode(elements[0].type, elements);
}
function f32(v = 0) {
    if (isNode(v))
        return new CallNode(f32$1, 'f32', [v]);
    return new LiteralNode(f32$1, v);
}
function f16(v = 0) {
    if (isNode(v))
        return new CallNode(f16$1, 'f16', [v]);
    return new LiteralNode(f16$1, v);
}
function i32(v = 0) {
    if (isNode(v))
        return new CallNode(i32$1, 'i32', [v]);
    return new LiteralNode(i32$1, Math.trunc(v));
}
function u32(v = 0) {
    if (isNode(v))
        return new CallNode(u32$1, 'u32', [v]);
    return new LiteralNode(u32$1, Math.trunc(v));
}
const bool = (v) => new LiteralNode(bool$1, v ? 1 : 0);
function wrapScalar(v, elemType) {
    if (isNode(v))
        return v;
    if (elemType === 'bool')
        return new LiteralNode(bool$1, v ? 1 : 0);
    if (elemType === 'i32')
        return new LiteralNode(i32$1, Math.trunc(v));
    if (elemType === 'u32')
        return new LiteralNode(u32$1, Math.trunc(v));
    if (elemType === 'f16')
        return new LiteralNode(f16$1, v);
    return new LiteralNode(f32$1, v);
}
function elemOf(type) {
    if (type.endsWith('h'))
        return 'f16';
    if (type.endsWith('f'))
        return 'f32';
    if (type.endsWith('i'))
        return 'i32';
    if (type.endsWith('u'))
        return 'u32';
    return 'bool';
}
function makeVec2(desc) {
    const e = elemOf(desc.wgslType);
    function ctor(a, b) {
        if (b === undefined)
            return new ConstructNode(desc, [wrapScalar(a, e)]);
        return new ConstructNode(desc, [wrapScalar(a, e), wrapScalar(b, e)]);
    }
    return ctor;
}
function makeVec3(desc) {
    const e = elemOf(desc.wgslType);
    function ctor(a, b, c) {
        if (b === undefined)
            return new ConstructNode(desc, [wrapScalar(a, e)]);
        if (c === undefined)
            return new ConstructNode(desc, [wrapScalar(a, e), wrapScalar(b, e)]);
        return new ConstructNode(desc, [wrapScalar(a, e), wrapScalar(b, e), wrapScalar(c, e)]);
    }
    return ctor;
}
function makeVec4(desc) {
    const e = elemOf(desc.wgslType);
    function ctor(a, b, c, dVal) {
        if (b === undefined)
            return new ConstructNode(desc, [wrapScalar(a, e)]);
        if (c === undefined)
            return new ConstructNode(desc, [wrapScalar(a, e), wrapScalar(b, e)]);
        if (dVal === undefined)
            return new ConstructNode(desc, [wrapScalar(a, e), wrapScalar(b, e), wrapScalar(c, e)]);
        return new ConstructNode(desc, [wrapScalar(a, e), wrapScalar(b, e), wrapScalar(c, e), wrapScalar(dVal, e)]);
    }
    return ctor;
}
const vec2 = makeVec2(vec2f$1);
const vec3 = makeVec3(vec3f$1);
const vec4 = makeVec4(vec4f$1);
const vec2f = makeVec2(vec2f$1);
const vec3f = makeVec3(vec3f$1);
const vec4f = makeVec4(vec4f$1);
const vec2i = makeVec2(vec2i$1);
const vec3i = makeVec3(vec3i$1);
const vec4i = makeVec4(vec4i$1);
const vec2u = makeVec2(vec2u$1);
const vec3u = makeVec3(vec3u$1);
const vec4u = makeVec4(vec4u$1);
const vec2h = makeVec2(vec2h$1);
const vec3h = makeVec3(vec3h$1);
const vec4h = makeVec4(vec4h$1);
const vec2b = makeVec2(vec2bool);
const vec3b = makeVec3(vec3bool);
const vec4b = makeVec4(vec4bool);
const mat2x2f = (...v) => new LiteralNode(mat2x2f$1, v.length ? v : []);
const mat2x3f = (...v) => new LiteralNode(mat2x3f$1, v.length ? v : []);
const mat2x4f = (...v) => new LiteralNode(mat2x4f$1, v.length ? v : []);
const mat3x2f = (...v) => new LiteralNode(mat3x2f$1, v.length ? v : []);
const mat3x3f = (...v) => new LiteralNode(mat3x3f$1, v.length ? v : []);
const mat3x4f = (...v) => new LiteralNode(mat3x4f$1, v.length ? v : []);
const mat4x2f = (...v) => new LiteralNode(mat4x2f$1, v.length ? v : []);
const mat4x3f = (...v) => new LiteralNode(mat4x3f$1, v.length ? v : []);
const mat4x4f = (...v) => new LiteralNode(mat4x4f$1, v.length ? v : []);
const mat2x2h = (...v) => new LiteralNode(mat2x2h$1, v.length ? v : []);
const mat2x3h = (...v) => new LiteralNode(mat2x3h$1, v.length ? v : []);
const mat2x4h = (...v) => new LiteralNode(mat2x4h$1, v.length ? v : []);
const mat3x2h = (...v) => new LiteralNode(mat3x2h$1, v.length ? v : []);
const mat3x3h = (...v) => new LiteralNode(mat3x3h$1, v.length ? v : []);
const mat3x4h = (...v) => new LiteralNode(mat3x4h$1, v.length ? v : []);
const mat4x2h = (...v) => new LiteralNode(mat4x2h$1, v.length ? v : []);
const mat4x3h = (...v) => new LiteralNode(mat4x3h$1, v.length ? v : []);
const mat4x4h = (...v) => new LiteralNode(mat4x4h$1, v.length ? v : []);
const mat4 = (c0, c1, c2, c3) => new ConstructNode(mat4x4f$1, [c0, c1, c2, c3]);
function mat3(c0, c1, c2, s10, s11, s12, s20, s21, s22) {
    // 9-scalar overload: mat3x3f(s00..s22) — column-major scalars
    if (s10 !== undefined) {
        return new ConstructNode(mat3x3f$1, [c0, c1, c2, s10, s11, s12, s20, s21, s22]);
    }
    // 3-column overload
    if (c1 !== undefined && c2 !== undefined) {
        return new ConstructNode(mat3x3f$1, [c0, c1, c2]);
    }
    // scalar diagonal: expand to 9 scalars (WGSL has no single-scalar matrix constructor)
    const z = new LiteralNode(f32$1, 0);
    return new ConstructNode(mat3x3f$1, [c0, z, z, z, c0, z, z, z, c0]);
}
// ── Standalone math functions ─────────────────────────────────────────────────
const add$1 = (a, b) => new BinopNode('+', arithResultDesc(a.type, b.type), a, b);
const sub = (a, b) => new BinopNode('-', arithResultDesc(a.type, b.type), a, b);
const div = (a, b) => new BinopNode('/', arithResultDesc(a.type, b.type), a, b);
const mul = (a, b) => new BinopNode('*', mulResultDesc(a.type, b.type), a, b);
const dot$1 = (a, b) => new CallNode(f32$1, 'dot', [a, b]);
const cross$1 = (a, b) => new CallNode(a.type, 'cross', [a, b]);
const normalize$4 = (a) => new CallNode(a.type, 'normalize', [a]);
const length$1 = (a) => new CallNode(f32$1, 'length', [a]);
const abs = (a) => new CallNode(a.type, 'abs', [a]);
const floor = (a) => new CallNode(a.type, 'floor', [a]);
const ceil = (a) => new CallNode(a.type, 'ceil', [a]);
const fract = (a) => new CallNode(a.type, 'fract', [a]);
const sqrt = (a) => new CallNode(a.type, 'sqrt', [a]);
const sin = (a) => new CallNode(a.type, 'sin', [a]);
const cos = (a) => new CallNode(a.type, 'cos', [a]);
const negate$1 = (a) => new CallNode(a.type, 'negate', [a]);
const pow = (a, b) => new CallNode(a.type, 'pow', [a, b]);
function max(a, b, ...rest) {
    let result = new CallNode(a.type, 'max', [a, b]);
    for (const n of rest) {
        result = new CallNode(a.type, 'max', [result, n]);
    }
    return result;
}
function min(a, b, ...rest) {
    let result = new CallNode(a.type, 'min', [a, b]);
    for (const n of rest) {
        result = new CallNode(a.type, 'min', [result, n]);
    }
    return result;
}
const clamp = (a, lo, hi) => new CallNode(a.type, 'clamp', [a, lo, hi]);
const mix = (a, b, t) => new CallNode(a.type, 'mix', [a, b, t]);
const step = (edge, x) => new CallNode(x.type, 'step', [edge, x]);
const smoothstep = (lo, hi, x) => new CallNode(x.type, 'smoothstep', [lo, hi, x]);
const sign = (a) => new CallNode(a.type, 'sign', [a]);
const mod = (a, b) => new BinopNode('%', a.type, a, b);
const or = (a, b) => new BinopNode('||', bool$1, a, b);
const and = (a, b) => new BinopNode('&&', bool$1, a, b);
const not = (a) => new CallNode(bool$1, 'not', [a]);
const transpose = (m) => new CallNode(m.type, 'transpose', [m]);
// ── Lang ──────────────────────────────────────────────────────────────────────
class StackNode extends Node {
    body;
    constructor(initial) {
        super(voidDesc);
        this.body = initial ? [...initial] : [];
    }
    push(node) { this.body.push(node); }
}
class FnNode extends Node {
    fnName;
    paramDescs;
    jsFunc;
    constructor(returnType, paramDescs, jsFunc, fnName) {
        super(returnType);
        this.fnName = fnName ?? `fn_${this.id}`;
        this.paramDescs = paramDescs;
        this.jsFunc = jsFunc;
    }
    compute(opts) { return new ComputeNode({ fn: this, ...opts }); }
    trace() {
        const params = this.paramDescs.map((pd, i) => {
            const paramName = 'name' in pd ? pd.name : undefined;
            const desc = 'name' in pd ? pd.type : pd;
            return new ParamNode(desc, i, paramName);
        });
        const stack = new StackNode();
        const prev = pushStack(stack);
        let output;
        try {
            output = this.jsFunc(...params);
        }
        finally {
            popStack(prev);
        }
        return { params, body: stack, output };
    }
}
class ParamNode extends Node {
    paramIndex;
    paramName;
    constructor(type, paramIndex, paramName) {
        super(type);
        this.paramIndex = paramIndex;
        this.paramName = paramName;
    }
}
class ReturnNode extends Node {
    value;
    constructor(value) {
        super(value.type);
        this.value = value;
    }
}
class CondNode extends Node {
    condition;
    ifTrue;
    ifFalse;
    constructor(condition, ifTrue, ifFalse) {
        super(ifTrue.type);
        this.condition = condition;
        this.ifTrue = ifTrue;
        this.ifFalse = ifFalse;
    }
}
class IfNode extends Node {
    condition;
    thenBody;
    elseIfBranches = [];
    elseBody = null;
    constructor(condition, thenBody) {
        super(voidDesc);
        this.condition = condition;
        this.thenBody = thenBody;
    }
}
let _loopVarCounter = 0;
class LoopNode extends Node {
    config;
    loopVar;
    callbackKey;
    body;
    constructor(config, loopVar, callbackKey, body) {
        super(voidDesc);
        this.config = config;
        this.loopVar = loopVar;
        this.callbackKey = callbackKey;
        this.body = body;
    }
}
class BreakNode extends Node {
    constructor() { super(voidDesc); }
}
class ContinueNode extends Node {
    constructor() { super(voidDesc); }
}
class DiscardNode extends Node {
    constructor() { super(voidDesc); }
}
function If(condition, thenBody) {
    const thenStack = new StackNode();
    const prev = pushStack(thenStack);
    try {
        thenBody();
    }
    finally {
        popStack(prev);
    }
    const ifNode = new IfNode(condition, thenStack);
    addToStack(ifNode);
    const chain = {
        ElseIf(c, body) {
            const s = new StackNode();
            const f = pushStack(s);
            try {
                body();
            }
            finally {
                popStack(f);
            }
            ifNode.elseIfBranches.push({ condition: c, body: s });
            return chain;
        },
        Else(body) {
            const s = new StackNode();
            const f = pushStack(s);
            try {
                body();
            }
            finally {
                popStack(f);
            }
            ifNode.elseBody = s;
            return chain;
        },
    };
    return chain;
}
function Loop(o, callback) {
    // Determine loop variable type and name from config
    let loopVarType = i32$1;
    let callbackKey = 'i';
    const varName = `_loop_${_loopVarCounter++}`;
    if (typeof o === 'object' && o !== null && !(o instanceof Node)) {
        const cfg = o;
        if (cfg.type)
            loopVarType = cfg.type;
        if (cfg.name)
            callbackKey = cfg.name;
    }
    // Create the loop variable ParamNode
    const loopVar = new ParamNode(loopVarType, 0, varName);
    // Eagerly capture the body (like If does)
    const bodyStack = new StackNode();
    const prev = pushStack(bodyStack);
    try {
        callback({ [callbackKey]: loopVar });
    }
    finally {
        popStack(prev);
    }
    const node = new LoopNode(o, loopVar, callbackKey, bodyStack);
    addToStack(node);
    return node;
}
const For = Loop;
function While(condition, body) { Loop(condition, body); }
function Return(value) {
    if (value !== undefined)
        addToStack(new ReturnNode(value));
    else
        addToStack(new ReturnNode(new LiteralNode(voidDesc, 0)));
}
function Break() { addToStack(new BreakNode()); }
function Continue() { addToStack(new ContinueNode()); }
function Discard() { addToStack(new DiscardNode()); }
// Implementation
function Fn(jsFunc, layout) {
    const paramDescs = layout?.params ?? [];
    const dummyParams = paramDescs.map((pd, i) => {
        const paramName = 'name' in pd ? pd.name : undefined;
        const desc = 'name' in pd ? pd.type : pd;
        return new ParamNode(desc, i, paramName);
    });
    const traceStack = new StackNode();
    const prev = pushStack(traceStack);
    let returnType;
    try {
        const output = jsFunc(...dummyParams);
        returnType = output != null ? output.type : voidDesc;
    }
    finally {
        popStack(prev);
    }
    if (returnType === voidDesc && paramDescs.length === 0 && !layout) {
        return new FnNode(voidDesc, [], jsFunc, undefined);
    }
    const fnNode = new FnNode(returnType, paramDescs, jsFunc, layout?.name);
    return (...args) => new CallNode(returnType, fnNode.fnName, args, fnNode);
}
const cond = (condition, ifTrue, ifFalse) => new CondNode(condition, ifTrue, ifFalse);
/**
 * WGSL `select(falseVal, trueVal, condition)`.
 * Returns `trueVal` when `condition` is true, `falseVal` otherwise.
 */
const select = (falseVal, trueVal, condition) => new CondNode(condition, trueVal, falseVal);
function Var(init, label) {
    const varName = label ? `var_${_nodeId}_${label}` : `var_${_nodeId}`;
    const v = new VarNode(init.type, varName, init);
    if (currentStack !== null)
        currentStack.push(v);
    return v;
}
function Let(init, label) {
    const varName = label ? `let_${_nodeId}_${label}` : `let_${_nodeId}`;
    const v = new LetNode(init.type, varName, init);
    if (currentStack !== null)
        currentStack.push(v);
    return v;
}
/** @deprecated Use Let() instead */
function Const(init, label) {
    return Let(init, label);
}
function privateVar(typeOrInit, name) {
    // Check if first arg is a Node (has .type property and is instanceof Node)
    if (typeOrInit instanceof Node) {
        const init = typeOrInit;
        const varName = name ?? `private_${_nodeId}`;
        return new PrivateVarNode(init.type, varName, init);
    }
    // Otherwise it's a type descriptor
    const type = typeOrInit;
    const varName = name ?? `private_${_nodeId}`;
    return new PrivateVarNode(type, varName);
}
/**
 * Create a module-scope workgroup variable: `var<workgroup> name: T;`
 *
 * Workgroup variables are shared across all invocations in a workgroup.
 * Only valid in compute shaders. Cannot have an initializer.
 *
 * @example
 * const shared = workgroupVar(d.array(d.f32, 256), 'sharedData');
 * // → var<workgroup> sharedData: array<f32, 256>;
 */
function workgroupVar(type, name) {
    return new WorkgroupVarNode(type, name);
}
let _computeCounter = 0;
class ComputeNode {
    id;
    fn;
    workgroupSize;
    name;
    /**
     * Set to true after dispose() is called.
     * The renderer checks this flag to skip dispatch and clean up GPU resources.
     */
    disposed = false;
    /**
     * Internal callback set by the renderer to clean up GPU resources (pipelines, caches).
     * @internal
     */
    _onDispose = null;
    constructor(opts) {
        this.id = `_compute_${_computeCounter++}`;
        this.fn = opts.fn;
        this.workgroupSize = opts.workgroupSize;
        this.name = opts.name;
    }
    /**
     * Frees GPU-related resources allocated for this compute node.
     * Call this method when the compute node is no longer used.
     */
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this._onDispose?.();
    }
}
function compute(fn, opts) { return new ComputeNode({ fn, ...opts }); }
function struct(name, fields) {
    const members = Object.entries(fields).map(([n, desc]) => ({ name: n, type: desc }));
    const structDesc = { type: 'struct', wgslType: name, name, fields };
    const node = new StructNode(structDesc, members);
    const nestedDefs = new Map();
    for (const desc of Object.values(fields)) {
        if (isStructDef(desc))
            nestedDefs.set(desc.wgslType, desc);
    }
    function construct(fieldNodes) {
        const args = members.map(m => fieldNodes[m.name]);
        return new ConstructNode(def, args);
    }
    const def = { type: 'struct', wgslType: name, name, fields, members, node, nestedDefs, construct };
    return def;
}
class StructNode extends Node {
    members;
    constructor(desc, members) {
        super(desc);
        this.members = members;
    }
}

/** Strip `atomic<…>` wrapper to get the underlying scalar type descriptor at runtime. */
function scalarDescOf(desc) {
    if (desc.wgslType === 'atomic<i32>' || desc.wgslType === 'i32')
        return i32$1;
    return u32$1;
}
/**
 * Atomically adds `value` to the atomic value at `ptr` and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicAdd(&ptr, value) -> i32/u32`
 */
function atomicAdd(ptr, value) {
    const node = new CallNode(scalarDescOf(ptr.type), 'atomicAdd', [ptr, value]);
    addToStack(node);
    return node;
}
/**
 * Atomically stores `value` to the atomic location at `ptr`.
 *
 * In WGSL: `atomicStore(&ptr, value)`
 */
function atomicStore(ptr, value) {
    addToStack(new CallNode(voidDesc, 'atomicStore', [ptr, value]));
}
/**
 * Atomically loads the value from the atomic location at `ptr`.
 *
 * In WGSL: `atomicLoad(&ptr) -> i32/u32`
 */
function atomicLoad(ptr) {
    return new CallNode(scalarDescOf(ptr.type), 'atomicLoad', [ptr]);
}
/**
 * Atomically subtracts `value` from the atomic value at `ptr` and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicSub(&ptr, value) -> i32/u32`
 */
function atomicSub(ptr, value) {
    const node = new CallNode(scalarDescOf(ptr.type), 'atomicSub', [ptr, value]);
    addToStack(node);
    return node;
}
/**
 * Atomically computes the maximum of the atomic value and `value`, stores it, and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicMax(&ptr, value) -> i32/u32`
 */
function atomicMax(ptr, value) {
    const node = new CallNode(scalarDescOf(ptr.type), 'atomicMax', [ptr, value]);
    addToStack(node);
    return node;
}
/**
 * Atomically computes the minimum of the atomic value and `value`, stores it, and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicMin(&ptr, value) -> i32/u32`
 */
function atomicMin(ptr, value) {
    const node = new CallNode(scalarDescOf(ptr.type), 'atomicMin', [ptr, value]);
    addToStack(node);
    return node;
}
/**
 * Atomically computes the bitwise AND of the atomic value and `value`, stores it, and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicAnd(&ptr, value) -> i32/u32`
 */
function atomicAnd(ptr, value) {
    const node = new CallNode(scalarDescOf(ptr.type), 'atomicAnd', [ptr, value]);
    addToStack(node);
    return node;
}
/**
 * Atomically computes the bitwise OR of the atomic value and `value`, stores it, and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicOr(&ptr, value) -> i32/u32`
 */
function atomicOr(ptr, value) {
    const node = new CallNode(scalarDescOf(ptr.type), 'atomicOr', [ptr, value]);
    addToStack(node);
    return node;
}
/**
 * Atomically computes the bitwise XOR of the atomic value and `value`, stores it, and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicXor(&ptr, value) -> i32/u32`
 */
function atomicXor(ptr, value) {
    const node = new CallNode(scalarDescOf(ptr.type), 'atomicXor', [ptr, value]);
    addToStack(node);
    return node;
}
/**
 * Atomically exchanges the value at `ptr` with `value` and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicExchange(&ptr, value) -> i32/u32`
 */
function atomicExchange(ptr, value) {
    const node = new CallNode(scalarDescOf(ptr.type), 'atomicExchange', [ptr, value]);
    addToStack(node);
    return node;
}
/**
 * Atomically compares the value at `ptr` with `comparator` and if equal, stores `value`.
 * Returns the old value (regardless of whether the exchange happened).
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicCompareExchangeWeak(&ptr, comparator, value) -> __atomic_compare_exchange_result<T>`
 *
 * Note: WGSL returns a struct { old_value: T, exchanged: bool }. This function returns the struct type
 * which you need to access via .old_value and .exchanged fields.
 */
function atomicCompareExchangeWeak(ptr, comparator, value) {
    const node = new CallNode(voidDesc, 'atomicCompareExchangeWeak', [ptr, comparator, value]);
    addToStack(node);
    return node;
}

/** determines how a buffer's lifecycle is managed */
var BufferLifecycle;
(function (BufferLifecycle) {
    /** Usages are tracked, GPU resources are disposed when usage count hits 0 */
    BufferLifecycle[BufferLifecycle["REF_COUNTED"] = 0] = "REF_COUNTED";
    /** User is responsible for calling buffer.dispose() */
    BufferLifecycle[BufferLifecycle["MANUAL"] = 1] = "MANUAL";
})(BufferLifecycle || (BufferLifecycle = {}));
/** Derive GPUVertexFormat from typed array type and itemSize */
function deriveVertexFormat(array, itemSize) {
    if (array instanceof Float32Array) {
        switch (itemSize) {
            case 1: return 'float32';
            case 2: return 'float32x2';
            case 3: return 'float32x3';
            case 4: return 'float32x4';
        }
    }
    else if (array instanceof Int32Array) {
        switch (itemSize) {
            case 1: return 'sint32';
            case 2: return 'sint32x2';
            case 3: return 'sint32x3';
            case 4: return 'sint32x4';
        }
    }
    else if (array instanceof Uint32Array) {
        switch (itemSize) {
            case 1: return 'uint32';
            case 2: return 'uint32x2';
            case 3: return 'uint32x3';
            case 4: return 'uint32x4';
        }
    }
    else if (array instanceof Int16Array) {
        switch (itemSize) {
            case 2: return 'sint16x2';
            case 4: return 'sint16x4';
        }
    }
    else if (array instanceof Uint16Array) {
        switch (itemSize) {
            case 2: return 'uint16x2';
            case 4: return 'uint16x4';
        }
    }
    else if (array instanceof Int8Array) {
        switch (itemSize) {
            case 2: return 'sint8x2';
            case 4: return 'sint8x4';
        }
    }
    else if (array instanceof Uint8Array) {
        switch (itemSize) {
            case 2: return 'uint8x2';
            case 4: return 'uint8x4';
        }
    }
    return undefined;
}
/**
 * Get the index format for a buffer's array.
 * Returns undefined if the array is null or not an index buffer array type.
 */
function getIndexFormat(array) {
    if (array instanceof Uint16Array)
        return 'uint16';
    if (array instanceof Uint32Array)
        return 'uint32';
    return undefined;
}
function normalizeUsage(usage) {
    if (!usage)
        return new Set(['vertex']);
    if (Array.isArray(usage))
        return new Set(usage);
    return new Set([usage]);
}
/**
 * Return the number of f32-sized slots occupied by one element of `schema`.
 * For primitive/vector/matrix types this is the same as `itemSizeOf`.
 * For struct types it is `wgslSizeOf(element) / 4` (byte size divided by 4).
 * For array types, returns the item size of the element type.
 */
function schemaItemSize(schema) {
    if (isArrayDesc(schema) || isSizedArrayDesc(schema)) {
        const element = schema.element;
        return schemaItemSize(element);
    }
    if (isStructDesc(schema))
        return wgslSizeOf(schema) / 4;
    return itemSizeOf(schema);
}
/**
 * Unified buffer class for vertex attributes, storage buffers, index buffers, etc.
 *
 * Replaces BufferAttribute, StorageBufferAttribute, InstancedBufferAttribute,
 * StorageInstancedBufferAttribute, and IndirectStorageBufferAttribute.
 *
 * @example Vertex buffer
 * const positions = new GpuBuffer(d.vec3f, { data: positionArray, usage: 'vertex' });
 *
 * @example Storage buffer
 * const particles = new GpuBuffer(d.array(Particle), { data: new Float32Array(1000 * stride), usage: 'storage' });
 *
 * @example Dual-use buffer (storage + vertex, instanced)
 * const transforms = new GpuBuffer(d.mat4x4f, {
 *     data: new Float32Array(1000 * 16),
 *     usage: ['storage', 'vertex'],
 *     instanced: true,
 * });
 */
class GpuBuffer {
    /** Type descriptor (d.vec3f, d.array(Particle), etc.) */
    schema;
    /** Allowed usages */
    usage;
    /** How this buffer's lifecycle is managed */
    lifecycle;
    /** Usage count for REF_COUNTED buffers. When this hits 0, GPU resources are disposed. */
    _usages = 0;
    /** CPU-side typed array. Can be set to null after onUpload releases memory. */
    array;
    /** Number of elements */
    count;
    /** Components per element (e.g., 3 for vec3f) */
    itemSize;
    /** Version for dirty tracking. Incremented when needsUpdate is set. */
    version = 0;
    /** Pending partial-upload ranges (flat component indices). */
    updateRanges = [];
    /** Callback after GPU upload (e.g., release CPU memory via `this.array = null`). */
    onUpload = null;
    /** The GPUVertexFormat for vertex buffers (e.g., 'float32x3'). Derived or explicit. */
    format;
    /** Set to true after dispose() is called. */
    disposed = false;
    /** Renderer-set callback to destroy GPU resources when dispose() is called. */
    _onDispose = null;
    constructor(schema, options = {}) {
        this.schema = schema;
        this.usage = normalizeUsage(options.usage);
        this.lifecycle = options.lifecycle ?? BufferLifecycle.MANUAL;
        // Derive itemSize from schema
        this.itemSize = schemaItemSize(schema);
        // Handle data vs count
        if (options.data && options.count !== undefined) {
            throw new Error('GpuBuffer: provide either `data` or `count`, not both');
        }
        if (options.data) {
            this.array = options.data;
            this.count = options.data.length / this.itemSize;
        }
        else if (options.count !== undefined) {
            const ArrayCtor = isStructDesc(schema) ? Float32Array : typedArrayCtorOf(schema);
            this.array = new ArrayCtor(options.count * this.itemSize);
            this.count = options.count;
        }
        else {
            this.array = null;
            this.count = 0;
        }
        // Derive vertex format from array type + itemSize
        if (this.usage.has('vertex') && this.array) {
            this.format = deriveVertexFormat(this.array, this.itemSize);
        }
        else {
            this.format = undefined;
        }
        // Validate index buffer array type
        if (this.usage.has('index') && this.array) {
            if (!(this.array instanceof Uint16Array) && !(this.array instanceof Uint32Array)) {
                throw new Error('GpuBuffer: index buffers must use Uint16Array or Uint32Array');
            }
        }
    }
    /** Mark buffer as needing re-upload */
    set needsUpdate(_) {
        this.version++;
    }
    /** Register a dirty range for partial re-upload */
    addUpdateRange(start, count) {
        this.updateRanges.push({ start, count });
    }
    /** Clear pending update ranges (called by renderer after upload) */
    clearUpdateRanges() {
        this.updateRanges.length = 0;
    }
    /**
     * Increment usage count.
     * For REF_COUNTED buffers: tracks usage and can "revive" a disposed buffer.
     * For MANUAL buffers: no-op (lifecycle is user-managed).
     * @returns this for chaining
     */
    increaseUsages() {
        if (this.lifecycle !== BufferLifecycle.REF_COUNTED)
            return this;
        if (this.disposed) {
            // Revive the buffer - it will be re-uploaded on next render
            this.disposed = false;
            this.version++;
        }
        this._usages++;
        return this;
    }
    /**
     * Decrement usage count.
     * For REF_COUNTED buffers: decrements count and disposes GPU resources when it hits 0.
     * For MANUAL buffers: no-op (lifecycle is user-managed).
     */
    decreaseUsages() {
        if (this.lifecycle !== BufferLifecycle.REF_COUNTED)
            return;
        if (this._usages <= 0) {
            throw new Error('decreaseUsages() called but _usages is already 0');
        }
        this._usages--;
        if (this._usages === 0) {
            this._disposeGpuResources();
        }
    }
    /**
     * Internal: dispose GPU resources without clearing CPU data.
     * Used by decreaseUsages() to allow revival.
     */
    _disposeGpuResources() {
        if (this.disposed)
            return;
        this.disposed = true;
        this._onDispose?.();
        this._onDispose = null;
    }
    /**
     * Dispose of this buffer's resources.
     * For MANUAL buffers: destroys GPU buffer and cleans up CPU-side data.
     * For REF_COUNTED buffers: throws error (use decreaseUsages() instead).
     */
    dispose() {
        if (this.lifecycle === BufferLifecycle.REF_COUNTED) {
            throw new Error('dispose() is not valid for REF_COUNTED buffers. Use decreaseUsages() instead.');
        }
        if (this.disposed)
            return;
        this.disposed = true;
        this._onDispose?.();
        this._onDispose = null;
        this.array = null;
        this.updateRanges.length = 0;
        this.onUpload = null;
    }
}
/**
 * Create a vertex buffer with sensible defaults.
 * - usage: 'vertex'
 * - lifecycle: REF_COUNTED (vertex buffers are typically owned by a Geometry)
 *
 * @example
 * const positions = createVertexBuffer(d.vec3f, new Float32Array([...]));
 */
function createVertexBuffer(schema, data) {
    return new GpuBuffer(schema, {
        data,
        usage: 'vertex',
        lifecycle: BufferLifecycle.REF_COUNTED,
    });
}
/**
 * Create a storage buffer with sensible defaults.
 * - usage: 'storage'
 * - lifecycle: MANUAL (storage buffers are often managed directly by user code)
 *
 * @example
 * const particles = createStorageBuffer(d.array(Particle, 1000), new Float32Array(1000 * particleStride));
 */
function createStorageBuffer(schema, data) {
    return new GpuBuffer(schema, {
        data,
        usage: 'storage',
        lifecycle: BufferLifecycle.MANUAL,
    });
}
/**
 * Create a uniform buffer with sensible defaults.
 * - usage: 'uniform'
 * - lifecycle: REF_COUNTED
 *
 * @example
 * const uniforms = createUniformBuffer(MyUniforms, new Float32Array([...]));
 */
function createUniformBuffer(schema, data) {
    return new GpuBuffer(schema, {
        data,
        usage: 'uniform',
        lifecycle: BufferLifecycle.REF_COUNTED,
    });
}
/**
 * Create an indirect draw buffer with sensible defaults.
 * - usage: ['storage', 'indirect'] (can be written by compute, read by draw)
 * - lifecycle: REF_COUNTED
 *
 * @example
 * const indirectBuffer = createIndirectBuffer(DrawIndirectArgs, new Uint32Array([vertexCount, instanceCount, firstVertex, firstInstance]));
 */
function createIndirectBuffer(schema, data) {
    return new GpuBuffer(schema, {
        data,
        usage: ['storage', 'indirect'],
        lifecycle: BufferLifecycle.REF_COUNTED,
    });
}
/**
 * Create an index buffer with sensible defaults.
 * - usage: 'index'
 * - lifecycle: REF_COUNTED (index buffers are typically owned by a Geometry)
 *
 * @example
 * const indices = createIndexBuffer(new Uint16Array([0, 1, 2, 2, 3, 0]));
 */
function createIndexBuffer(data) {
    return new GpuBuffer(u32$1, {
        // Cast is safe: we're storing uint16/uint32 indices, itemSize=1 matches
        data: data,
        usage: 'index',
        lifecycle: BufferLifecycle.REF_COUNTED,
    });
}

/**
 * AttributeNode — a vertex attribute that reads from either:
 * 1. A named geometry buffer (looked up at render time by name)
 * 2. A direct GpuBuffer reference
 *
 * View info (stride, offset, instanced) lives on the node, not the buffer.
 * This follows the WebGPU pattern where GPUBuffer is bound separately from
 * the GPUVertexBufferLayout which specifies stride/offset.
 *
 * @example
 * // By-name (geometry lookup)
 * const pos = attribute('position', d.vec3f);
 * const uv = attribute('uv', d.vec2f);
 *
 * // By-name with view options
 * const pos = attribute('position', d.vec3f, { stride: 32, offset: 0 });
 *
 * // Direct GpuBuffer (schema from buffer)
 * const colors = attribute(colorBuffer);
 *
 * // Direct GpuBuffer with view options (interleaved)
 * const position = attribute(interleavedBuffer, { stride: 32, offset: 0 });
 * const normal = attribute(interleavedBuffer, { stride: 32, offset: 12 });
 *
 * // Raw TypedArray (auto-wrapped in GpuBuffer)
 * const offsets = attribute(offsetData, d.vec3f);
 *
 * // Instanced
 * const instanceMatrix = attribute(matricesBuffer, { stride: 64, offset: 0, instanced: true });
 */
class AttributeNode extends Node {
    /** Either a name (geometry lookup) or direct GpuBuffer reference */
    source;
    /** Byte stride between elements. 0 = tightly packed. */
    stride;
    /** Byte offset within each stride. */
    offset;
    /** Whether this is per-instance data (stepMode: 'instance'). */
    instanced;
    constructor(desc, source, options = {}) {
        super(desc);
        this.source = source;
        this.stride = options.stride ?? 0;
        this.offset = options.offset ?? 0;
        this.instanced = options.instanced ?? false;
    }
    /** Whether this is a name-based lookup. */
    get isNamedReference() {
        return typeof this.source === 'string';
    }
    /** Get the name, or null if buffer-based. */
    get name() {
        return typeof this.source === 'string' ? this.source : null;
    }
    /** Get the buffer, or null if name-based. */
    get buffer() {
        return typeof this.source === 'string' ? null : this.source;
    }
}
// Implementation
function attribute(nameOrBufferOrData, schemaOrOptions, maybeOptions) {
    // Overload 1: attribute(name, schema, options?)
    if (typeof nameOrBufferOrData === 'string') {
        const name = nameOrBufferOrData;
        const schema = schemaOrOptions;
        const options = maybeOptions ?? {};
        return new AttributeNode(schema, name, options);
    }
    // Overload 2: attribute(buffer, options?)
    if (nameOrBufferOrData instanceof GpuBuffer) {
        const buffer = nameOrBufferOrData;
        const options = schemaOrOptions ?? {};
        return new AttributeNode(buffer.schema, buffer, options);
    }
    // Overload 3: attribute(data, schema, options?)
    // data is a TypedArray - wrap in GpuBuffer
    const data = nameOrBufferOrData;
    const schema = schemaOrOptions;
    const options = maybeOptions ?? {};
    const buffer = new GpuBuffer(schema, {
        data: data,
        usage: 'vertex',
    });
    return new AttributeNode(schema, buffer, options);
}
/**
 * UV attribute node for texture coordinate access.
 *
 * Returns an AttributeNode that reads the 'uv' vertex attribute (or 'uv1', 'uv2', etc.
 * for additional UV channels).
 *
 * @param index - The UV channel index. Defaults to 0 (reads 'uv').
 *                Index 1 reads 'uv1', index 2 reads 'uv2', etc.
 * @returns An AttributeNode<Vec2fDesc> representing the UV coordinates.
 *
 * @example
 * // Default UV channel
 * const texCoord = uv();
 *
 * // Second UV channel (e.g., for lightmaps)
 * const lightmapUV = uv(1);
 *
 * // Sample a texture with UVs
 * const color = myTexture.sample(uv());
 */
const uv = (index = 0) => new AttributeNode(vec2f$1, 'uv' + (index > 0 ? index : ''));

class BuiltinNode extends Node {
    builtinKind;
    constructor(builtinKind, desc) {
        super(desc);
        this.builtinKind = builtinKind;
    }
}
const builtin = (builtinKind, desc) => new BuiltinNode(builtinKind, desc);
/** @builtin(instance_index) — the instance index for instanced draw calls. */
const instanceIndex = /*@__PURE__*/ builtin('instance_index', u32$1);
/** @builtin(vertex_index) — the vertex index in the current draw call. */
const vertexIndex = /*@__PURE__*/ builtin('vertex_index', u32$1);
/** @builtin(global_invocation_id) — unique thread ID across the entire dispatch. */
const globalId = /*@__PURE__*/ builtin('global_invocation_id', vec3u$1);
/** @builtin(local_invocation_id) — thread ID within its workgroup. */
const localId = /*@__PURE__*/ builtin('local_invocation_id', vec3u$1);
/** @builtin(local_invocation_index) — flat 1-D index within the workgroup. */
const localIndex = /*@__PURE__*/ builtin('local_invocation_index', u32$1);
/** @builtin(workgroup_id) — workgroup coordinate in the dispatch grid. */
const workgroupId = /*@__PURE__*/ builtin('workgroup_id', vec3u$1);
/** @builtin(num_workgroups) — total number of workgroups dispatched. */
const numWorkgroups = /*@__PURE__*/ builtin('num_workgroups', vec3u$1);
/**
 * Fragment position in window/pixel coordinates.
 * @builtin(position) in the fragment shader — vec4f where xy are pixel coordinates.
 *
 * This is the raw fragment coordinate from the rasterizer.
 * Use screenCoordinate.xy for 2D pixel position.
 */
const fragCoord = /*@__PURE__*/ builtin('position', vec4f$1);
/**
 * Linearized compute invocation index across the entire dispatch grid.
 *
 * For a dispatch of size (Dx, Dy, Dz) workgroups with workgroup size (Wx, Wy, Wz),
 * this computes:
 *   globalId.x + globalId.y * (Wx * Dx) + globalId.z * (Wx * Dx) * (Wy * Dy)
 *
 * This gives each thread a unique u32 index from 0 to (Dx*Wx * Dy*Wy * Dz*Wz - 1).
 *
 * Use this in compute shaders where you need a linear index into a buffer,
 * similar to how instanceIndex works in vertex shaders.
 */
class ComputeIndexNode extends Node {
    constructor() {
        super(u32$1);
    }
}
const computeIndex = /*@__PURE__*/ new ComputeIndexNode();

/**
 * Update frequency for uniform groups.
 */
const UniformUpdateType = {
    NONE: 'none',
    FRAME: 'frame',
    RENDER: 'render',
    OBJECT: 'object',
};
/**
 * Uniform group — determines WGSL @group index and struct packing.
 */
class UniformGroup {
    name;
    shared;
    order;
    updateType;
    constructor(name, shared, order, updateType = UniformUpdateType.NONE) {
        this.name = name;
        this.shared = shared;
        this.order = order;
        this.updateType = updateType;
    }
}
/** Create a per-object (non-shared) uniform group. */
const uniformGroup = (name, order = 1, updateType = UniformUpdateType.NONE) => new UniformGroup(name, false, order, updateType);
/** Create a shared uniform group. */
const sharedUniformGroup = (name, order = 0, updateType = UniformUpdateType.NONE) => new UniformGroup(name, true, order, updateType);
/**
 * frameGroup — shared uniforms updated once per frame.
 * Contains time uniforms (timeElapsed, timeDelta).
 * Maps to @group(0) with FRAME update type.
 */
const frameGroup = /*@__PURE__*/ sharedUniformGroup('frame', 0, UniformUpdateType.FRAME);
/**
 * renderGroup — shared uniforms updated per render() call.
 * Contains camera uniforms (projection, view, position, near, far).
 * Maps to @group(0) with RENDER update type.
 */
const renderGroup = /*@__PURE__*/ sharedUniformGroup('render', 0, UniformUpdateType.RENDER);
/**
 * objectGroup — per-object uniforms updated per draw call.
 * Contains mesh matrices (modelWorldMatrix, modelNormalMatrix) and user material uniforms.
 * Maps to @group(1) with OBJECT update type.
 */
const objectGroup = /*@__PURE__*/ uniformGroup('object', 1, UniformUpdateType.OBJECT);
/**
 * Core uniform data container.
 *
 * Owns the CPU-side value, version for dirty tracking, and group assignment.
 * Referenced by UniformNode in the DSL layer.
 *
 * @example
 * const roughness = new Uniform(d.f32, 0.5);
 * roughness.set(0.8);
 *
 * @example
 * const color = new Uniform(d.vec3f, [1, 0, 0]);
 * color.set([0, 1, 0]);
 *
 * @example With explicit group
 * const time = new Uniform(d.f32, 0, frameGroup);
 */
class Uniform {
    schema;
    group;
    value = null;
    constructor(schema, initialValue, group = objectGroup) {
        this.schema = schema;
        this.group = group;
        if (initialValue !== undefined) {
            this.value = initialValue;
        }
    }
}

class UniformNode extends Node {
    /** uniform name */
    name;
    /** The underlying Uniform data container */
    uniform;
    /** Get the uniform group */
    get groupNode() { return this.uniform.group; }
    /** Get the current value */
    get value() { return this.uniform.value; }
    /** Set value directly */
    set value(v) { this.uniform.value = v; }
    constructor(uniform, name) {
        super(uniform.schema);
        this.uniform = uniform;
        this.name = name;
    }
    /**
     * Register an update callback that runs per frame/render/object.
     * The callback returns a value which is assigned to the uniform's value.
     */
    onUpdate(callback, updateType) {
        this.updateType = updateType;
        this.update = (frame) => {
            const value = callback(frame);
            if (value !== undefined) {
                this.uniform.value = value;
            }
        };
        return this;
    }
    /** Register an update callback for FRAME update type. */
    onFrameUpdate(callback) {
        return this.onUpdate(callback, UniformUpdateType.FRAME);
    }
    /** Register an update callback for RENDER update type. */
    onRenderUpdate(callback) {
        return this.onUpdate(callback, UniformUpdateType.RENDER);
    }
    /** Register an update callback for OBJECT update type. */
    onObjectUpdate(callback) {
        return this.onUpdate(callback, UniformUpdateType.OBJECT);
    }
}
// Implementation
function uniform(init, nameOrSchema) {
    // Value-based: uniform(Uniform)
    if (init instanceof Uniform) {
        const u = init;
        return new UniformNode(u, `uniform_${_nodeId}`);
    }
    // Name-based: uniform('name', schema) or uniform('name', StructDef)
    if (typeof init === 'string') {
        const name = init;
        const schema = nameOrSchema;
        // Check if it's a StructDef
        if (schema && 'fields' in schema && 'construct' in schema) {
            const def = schema;
            const u = new Uniform(def);
            const node = new UniformNode(u, name);
            return fields(node);
        }
        // Regular schema — create Uniform for name-based resolution
        const u = new Uniform(schema);
        return new UniformNode(u, name);
    }
    // Inline scalar/vector/matrix form: uniform(f32(0.5), 'name')
    const initNode = init;
    const name = nameOrSchema;
    const uniformId = name ?? `${initNode.type.wgslType}_${_nodeId}`;
    // Extract initial value from the node
    const initialValue = extractValue(initNode);
    const u = new Uniform(initNode.type, initialValue);
    return new UniformNode(u, uniformId);
}
/**
 * Extract a concrete value from a LiteralNode or ConstructNode.
 * For ConstructNode, recursively extracts from child LiteralNodes.
 * Returns undefined if any child is not a LiteralNode (dynamic value).
 */
function extractValue(node) {
    // LiteralNode has a direct value
    if (node instanceof LiteralNode) {
        return node.value;
    }
    // ConstructNode: extract values from args (must all be LiteralNodes)
    if (node instanceof ConstructNode) {
        const values = [];
        for (const arg of node.args) {
            if (arg instanceof LiteralNode && typeof arg.value === 'number') {
                values.push(arg.value);
            }
            else {
                // Dynamic child - can't extract static value
                return undefined;
            }
        }
        return values;
    }
    return undefined;
}

/** Projection matrix of the scene camera. In renderGroup. */
const cameraProjectionMatrix = /*@__PURE__*/ new UniformNode(new Uniform(mat4x4f$1, undefined, renderGroup), 'cameraProjectionMatrix')
    .onRenderUpdate((frame) => frame.camera.projectionMatrix);
/** View (world-to-camera) matrix. In renderGroup. */
const cameraViewMatrix = /*@__PURE__*/ new UniformNode(new Uniform(mat4x4f$1, undefined, renderGroup), 'cameraViewMatrix')
    .onRenderUpdate((frame) => frame.camera.matrixWorldInverse);
/** Camera world-space position. In renderGroup. */
const cameraPosition = /*@__PURE__*/ new UniformNode(new Uniform(vec3f$1, undefined, renderGroup), 'cameraPosition')
    .onRenderUpdate((frame) => frame.camera.position);
/** Camera near plane distance. In renderGroup. */
const cameraNear = /*@__PURE__*/ new UniformNode(new Uniform(f32$1, undefined, renderGroup), 'cameraNear')
    .onRenderUpdate((frame) => frame.camera.near);
/** Camera far plane distance. In renderGroup. */
const cameraFar = /*@__PURE__*/ new UniformNode(new Uniform(f32$1, undefined, renderGroup), 'cameraFar')
    .onRenderUpdate((frame) => frame.camera.far);

/**
 * color.ts — Linear-sRGB color utilities.
 *
 * A Color is a 3-element tuple [r, g, b] of linear-sRGB floats in [0, 1].
 *
 * All CSS-style / gamma-sRGB inputs are converted to linear RGB via the
 * standard sRGB gamma-expansion formula.
 */
// ---------------------------------------------------------------------------
// CSS named color table (the 148 CSS4 named colors)
// Values are 0xRRGGBB integers in sRGB gamma space.
// ---------------------------------------------------------------------------
/* eslint-disable sort-keys */
const CSS_COLORS = {
    aliceblue: 0xf0f8ff,
    antiquewhite: 0xfaebd7,
    aqua: 0x00ffff,
    aquamarine: 0x7fffd4,
    azure: 0xf0ffff,
    beige: 0xf5f5dc,
    bisque: 0xffe4c4,
    black: 0x000000,
    blanchedalmond: 0xffebcd,
    blue: 0x0000ff,
    blueviolet: 0x8a2be2,
    brown: 0xa52a2a,
    burlywood: 0xdeb887,
    cadetblue: 0x5f9ea0,
    chartreuse: 0x7fff00,
    chocolate: 0xd2691e,
    coral: 0xff7f50,
    cornflowerblue: 0x6495ed,
    cornsilk: 0xfff8dc,
    crimson: 0xdc143c,
    cyan: 0x00ffff,
    darkblue: 0x00008b,
    darkcyan: 0x008b8b,
    darkgoldenrod: 0xb8860b,
    darkgray: 0xa9a9a9,
    darkgreen: 0x006400,
    darkgrey: 0xa9a9a9,
    darkkhaki: 0xbdb76b,
    darkmagenta: 0x8b008b,
    darkolivegreen: 0x556b2f,
    darkorange: 0xff8c00,
    darkorchid: 0x9932cc,
    darkred: 0x8b0000,
    darksalmon: 0xe9967a,
    darkseagreen: 0x8fbc8f,
    darkslateblue: 0x483d8b,
    darkslategray: 0x2f4f4f,
    darkslategrey: 0x2f4f4f,
    darkturquoise: 0x00ced1,
    darkviolet: 0x9400d3,
    deeppink: 0xff1493,
    deepskyblue: 0x00bfff,
    dimgray: 0x696969,
    dimgrey: 0x696969,
    dodgerblue: 0x1e90ff,
    firebrick: 0xb22222,
    floralwhite: 0xfffaf0,
    forestgreen: 0x228b22,
    fuchsia: 0xff00ff,
    gainsboro: 0xdcdcdc,
    ghostwhite: 0xf8f8ff,
    gold: 0xffd700,
    goldenrod: 0xdaa520,
    gray: 0x808080,
    green: 0x008000,
    greenyellow: 0xadff2f,
    grey: 0x808080,
    honeydew: 0xf0fff0,
    hotpink: 0xff69b4,
    indianred: 0xcd5c5c,
    indigo: 0x4b0082,
    ivory: 0xfffff0,
    khaki: 0xf0e68c,
    lavender: 0xe6e6fa,
    lavenderblush: 0xfff0f5,
    lawngreen: 0x7cfc00,
    lemonchiffon: 0xfffacd,
    lightblue: 0xadd8e6,
    lightcoral: 0xf08080,
    lightcyan: 0xe0ffff,
    lightgoldenrodyellow: 0xfafad2,
    lightgray: 0xd3d3d3,
    lightgreen: 0x90ee90,
    lightgrey: 0xd3d3d3,
    lightpink: 0xffb6c1,
    lightsalmon: 0xffa07a,
    lightseagreen: 0x20b2aa,
    lightskyblue: 0x87cefa,
    lightslategray: 0x778899,
    lightslategrey: 0x778899,
    lightsteelblue: 0xb0c4de,
    lightyellow: 0xffffe0,
    lime: 0x00ff00,
    limegreen: 0x32cd32,
    linen: 0xfaf0e6,
    magenta: 0xff00ff,
    maroon: 0x800000,
    mediumaquamarine: 0x66cdaa,
    mediumblue: 0x0000cd,
    mediumorchid: 0xba55d3,
    mediumpurple: 0x9370db,
    mediumseagreen: 0x3cb371,
    mediumslateblue: 0x7b68ee,
    mediumspringgreen: 0x00fa9a,
    mediumturquoise: 0x48d1cc,
    mediumvioletred: 0xc71585,
    midnightblue: 0x191970,
    mintcream: 0xf5fffa,
    mistyrose: 0xffe4e1,
    moccasin: 0xffe4b5,
    navajowhite: 0xffdead,
    navy: 0x000080,
    oldlace: 0xfdf5e6,
    olive: 0x808000,
    olivedrab: 0x6b8e23,
    orange: 0xffa500,
    orangered: 0xff4500,
    orchid: 0xda70d6,
    palegoldenrod: 0xeee8aa,
    palegreen: 0x98fb98,
    paleturquoise: 0xafeeee,
    palevioletred: 0xdb7093,
    papayawhip: 0xffefd5,
    peachpuff: 0xffdab9,
    peru: 0xcd853f,
    pink: 0xffc0cb,
    plum: 0xdda0dd,
    powderblue: 0xb0e0e6,
    purple: 0x800080,
    rebeccapurple: 0x663399,
    red: 0xff0000,
    rosybrown: 0xbc8f8f,
    royalblue: 0x4169e1,
    saddlebrown: 0x8b4513,
    salmon: 0xfa8072,
    sandybrown: 0xf4a460,
    seagreen: 0x2e8b57,
    seashell: 0xfff5ee,
    sienna: 0xa0522d,
    silver: 0xc0c0c0,
    skyblue: 0x87ceeb,
    slateblue: 0x6a5acd,
    slategray: 0x737373,
    slategrey: 0x737373,
    snow: 0xfffafa,
    springgreen: 0x00ff7f,
    steelblue: 0x4682b4,
    tan: 0xd2b48c,
    teal: 0x008080,
    thistle: 0xd8bfd8,
    tomato: 0xff6347,
    turquoise: 0x40e0d0,
    violet: 0xee82ee,
    wheat: 0xf5deb3,
    white: 0xffffff,
    whitesmoke: 0xf5f5f5,
    yellow: 0xffff00,
    yellowgreen: 0x9acd32,
};
/* eslint-enable sort-keys */
// ---------------------------------------------------------------------------
// sRGB <-> linear conversion helpers
// ---------------------------------------------------------------------------
/** Convert a single sRGB gamma-encoded channel [0, 1] to linear light [0, 1]. */
function srgbChannelToLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
/** Convert a single linear light channel [0, 1] to sRGB gamma-encoded [0, 1]. */
function linearChannelToSrgb(c) {
    return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
// ---------------------------------------------------------------------------
// Internal parser helpers
// ---------------------------------------------------------------------------
function parseHex3(hex) {
    const r = parseInt(hex[1] + hex[1], 16) / 255;
    const g = parseInt(hex[2] + hex[2], 16) / 255;
    const b = parseInt(hex[3] + hex[3], 16) / 255;
    return [srgbChannelToLinear(r), srgbChannelToLinear(g), srgbChannelToLinear(b)];
}
function parseHex6(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    return [srgbChannelToLinear(r), srgbChannelToLinear(g), srgbChannelToLinear(b)];
}
function parseRgbString(str) {
    const m = str.match(/^rgb\(\s*([^,]+),\s*([^,]+),\s*([^)]+)\)$/i);
    if (!m)
        return null;
    const parse = (s) => {
        s = s.trim();
        if (s.endsWith('%'))
            return parseFloat(s) / 100;
        return parseFloat(s) / 255;
    };
    return [srgbChannelToLinear(parse(m[1])), srgbChannelToLinear(parse(m[2])), srgbChannelToLinear(parse(m[3]))];
}
function parseHslString(str) {
    const m = str.match(/^hsl\(\s*([^,]+),\s*([^,]+),\s*([^)]+)\)$/i);
    if (!m)
        return null;
    const h = parseFloat(m[1]) / 360;
    const s = parseFloat(m[2]) / 100;
    const l = parseFloat(m[3]) / 100;
    return hslToLinear(h, s, l);
}
function hslToLinear(h, s, l) {
    let r, g, b;
    if (s === 0) {
        r = g = b = l;
    }
    else {
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1 / 3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1 / 3);
    }
    return [srgbChannelToLinear(r), srgbChannelToLinear(g), srgbChannelToLinear(b)];
}
function hue2rgb(p, q, t) {
    if (t < 0)
        t += 1;
    if (t > 1)
        t -= 1;
    if (t < 1 / 6)
        return p + (q - p) * 6 * t;
    if (t < 1 / 2)
        return q;
    if (t < 2 / 3)
        return p + (q - p) * (2 / 3 - t) * 6;
    return p;
}
// ---------------------------------------------------------------------------
// Free functions
// ---------------------------------------------------------------------------
/** Create a new Color initialized to black [0, 0, 0]. */
function create$a() {
    return [0, 0, 0];
}
/** Create a new Color with the given linear r, g, b values. */
function fromValues$1(r, g, b) {
    return [r, g, b];
}
/** Create a new Color that is a copy of `c`. */
function clone$3(c) {
    return [c[0], c[1], c[2]];
}
/** Copy the values from `src` into `out`. Returns `out`. */
function copy$6(out, src) {
    out[0] = src[0];
    out[1] = src[1];
    out[2] = src[2];
    return out;
}
/** Set the linear r, g, b components of `out` directly. Returns `out`. */
function set$4(out, r, g, b) {
    out[0] = r;
    out[1] = g;
    out[2] = b;
    return out;
}
/**
 * Set `out` from an sRGB gamma-encoded [r, g, b] array with values in [0, 1].
 * Converts from sRGB gamma space to linear. Returns `out`.
 */
function setFromSRGB(out, srgb) {
    out[0] = srgbChannelToLinear(srgb[0]);
    out[1] = srgbChannelToLinear(srgb[1]);
    out[2] = srgbChannelToLinear(srgb[2]);
    return out;
}
/** Create a new Color from an sRGB gamma-encoded [r, g, b] array with values in [0, 1]. */
function fromSRGB(srgb) {
    return setFromSRGB(create$a(), srgb);
}
/**
 * Parse any supported color input and write the result into `out`. Returns `out`.
 *
 * Supported inputs:
 *   - CSS hex strings:       '#f00', '#ff0000'
 *   - CSS rgb():             'rgb(255, 0, 0)', 'rgb(100%, 0%, 0%)'
 *   - CSS hsl():             'hsl(0, 100%, 50%)'
 *   - 0xRRGGBB integers:     0xff0000 (sRGB gamma)
 *   - Named CSS colors:      'red', 'lime', 'deepskyblue', ...
 *   - [r, g, b] array:       treated as already-linear [0, 1]
 */
function setFromColorInput(out, input) {
    const parsed = parse(input);
    out[0] = parsed[0];
    out[1] = parsed[1];
    out[2] = parsed[2];
    return out;
}
/** Parse any supported color input into a new Color. */
function fromColorInput(input) {
    return parse(input);
}
/**
 * Return a CSS `rgb(...)` string in sRGB gamma space (for HTML/canvas use).
 */
function toCSS(c) {
    const r = Math.round(linearChannelToSrgb(c[0]) * 255);
    const g = Math.round(linearChannelToSrgb(c[1]) * 255);
    const b = Math.round(linearChannelToSrgb(c[2]) * 255);
    return `rgb(${r}, ${g}, ${b})`;
}
// ---------------------------------------------------------------------------
// Internal parse
// ---------------------------------------------------------------------------
function parse(input) {
    // [r, g, b] array — treated as already-linear
    if (Array.isArray(input)) {
        return [input[0] ?? 0, input[1] ?? 0, input[2] ?? 0];
    }
    // Integer 0xRRGGBB (sRGB gamma)
    if (typeof input === 'number') {
        const r = ((input >> 16) & 0xff) / 255;
        const g = ((input >> 8) & 0xff) / 255;
        const b = (input & 0xff) / 255;
        return [srgbChannelToLinear(r), srgbChannelToLinear(g), srgbChannelToLinear(b)];
    }
    // String forms
    const s = input.trim().toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(s))
        return parseHex3(s);
    if (/^#[0-9a-f]{6}$/i.test(s))
        return parseHex6(s);
    if (s.startsWith('rgb(')) {
        const result = parseRgbString(s);
        if (result)
            return result;
    }
    if (s.startsWith('hsl(')) {
        const result = parseHslString(s);
        if (result)
            return result;
    }
    const hex = CSS_COLORS[s];
    if (hex !== undefined) {
        return parseHex6('#' + hex.toString(16).padStart(6, '0'));
    }
    throw new Error(`[gpucat] color: unrecognised color input: "${input}"`);
}

var color = /*#__PURE__*/Object.freeze({
    __proto__: null,
    clone: clone$3,
    copy: copy$6,
    create: create$a,
    fromColorInput: fromColorInput,
    fromSRGB: fromSRGB,
    fromValues: fromValues$1,
    set: set$4,
    setFromColorInput: setFromColorInput,
    setFromSRGB: setFromSRGB,
    toCSS: toCSS
});

/**
 * Convert any color input to a `vec3f` linear RGB node.
 *
 * This is the primary way to introduce a color into the node graph.
 * The resulting node has type `vec3f` so it can be used anywhere a `vec3f`
 * is expected — including as the first argument to `vec4(xyz, w)`.
 *
 * @example
 * import { rgb, vec4, f32 } from 'gpucat';
 *
 * const fragColor = vec4(rgb('#f00'), f32(1));
 *
 * // Other accepted forms:
 * rgb('hsl(200, 80%, 50%)');
 * rgb('deepskyblue');
 * rgb(0xff8800);
 * rgb([1, 0.5, 0]);
 */
function rgb(input) {
    const c = fromColorInput(input);
    return vec3f(c[0], c[1], c[2]);
}

let _sourceId = 0;
/**
 * Represents the data source of a texture.
 *
 * The main purpose of this class is to decouple the data definition from the texture
 * definition so the same data can be used with multiple texture instances.
 */
class Source {
    /** unique numeric ID */
    id;
    /** the data definition of a texture, can be an ImageBitmap, HTMLImageElement, canvas, video, or null */
    data;
    /** when set to `false`, the engine performs memory allocation but does not transfer data to GPU memory, useful for deferred loading */
    dataReady = true;
    /** version number, incremented when `needsUpdate` is set to true, used for dirty checking by the renderer */
    version = 0;
    /**
     * Constructs a new Source
     * @param data the data definition (ImageBitmap, HTMLImageElement, etc.)
     */
    constructor(data) {
        this.id = _sourceId++;
        this.data = data;
    }
    /** when set to `true`, increments the version counter to trigger a GPU upload on the next render */
    set needsUpdate(value) {
        if (value === true)
            this.version++;
    }
    /** returns the width of the source data, or 0 if no data */
    get width() {
        const data = this.data;
        if (!data || typeof data !== 'object')
            return 0;
        if (typeof HTMLVideoElement !== 'undefined' && data instanceof HTMLVideoElement) {
            return data.videoWidth;
        }
        if (typeof VideoFrame !== 'undefined' && data instanceof VideoFrame) {
            return data.displayWidth;
        }
        if ('width' in data && typeof data.width === 'number') {
            return data.width;
        }
        return 0;
    }
    /** returns the height of the source data, or 0 if no data */
    get height() {
        const data = this.data;
        if (!data || typeof data !== 'object')
            return 0;
        if (typeof HTMLVideoElement !== 'undefined' && data instanceof HTMLVideoElement) {
            return data.videoHeight;
        }
        if (typeof VideoFrame !== 'undefined' && data instanceof VideoFrame) {
            return data.displayHeight;
        }
        if ('height' in data && typeof data.height === 'number') {
            return data.height;
        }
        return 0;
    }
    /** returns the depth of the source data (for 3D textures), or 0 */
    get depth() {
        const data = this.data;
        if (!data || typeof data !== 'object')
            return 0;
        if ('depth' in data && typeof data.depth === 'number') {
            return data.depth;
        }
        return 0;
    }
}

let _textureId = 0;
class GpuTexture {
    /** Unique ID */
    id = _textureId++;
    /** Schema type descriptor — source of truth for WGSL type */
    type;
    /** GPU texture dimension ('1d', '2d', '3d') */
    dimension;
    /** View dimension for createView() */
    viewDimension;
    // ─────────────────────────────────────────────────────────────────────────
    // GPUTextureDescriptor fields
    // ─────────────────────────────────────────────────────────────────────────
    width;
    height;
    depthOrArrayLayers;
    format;
    usage;
    mipLevelCount;
    sampleCount;
    // ─────────────────────────────────────────────────────────────────────────
    // Source data
    // ─────────────────────────────────────────────────────────────────────────
    /** Primary source (for 2D/3D) */
    source = null;
    /** Per-layer/face sources (for array/cube textures) */
    sources = [];
    /** Generate mipmaps on upload */
    generateMipmaps = false;
    /** Flip Y on upload (for image sources) */
    flipY = false;
    /** Premultiply alpha on upload */
    premultiplyAlpha = false;
    // ─────────────────────────────────────────────────────────────────────────
    // Dirty tracking (same pattern as GpuBuffer)
    // ─────────────────────────────────────────────────────────────────────────
    /** Version number, incremented when needsUpdate is set */
    version = 0;
    /** Mark texture as needing re-upload */
    set needsUpdate(_) {
        this.version++;
    }
    /** Track which layers need updating (for 2D array textures) */
    layerUpdates = new Set();
    // ─────────────────────────────────────────────────────────────────────────
    // Render target flag
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * Whether this texture is a render target (managed by RenderTarget system).
     * When true, the renderer skips source data upload - the GPU texture is
     * created and managed by RenderTarget.
     */
    isRenderTargetTexture = false;
    // ─────────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ─────────────────────────────────────────────────────────────────────────
    /** Renderer-set callback to destroy GPU resources */
    _onDispose = null;
    /** Set to true after dispose() */
    disposed = false;
    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────
    constructor(type, options) {
        this.type = type;
        // Derive dimension and viewDimension from schema type
        this.dimension = textureDimension(type);
        this.viewDimension = textureViewDimension(type);
        // Extract size from options (type-safe per schema)
        const { width, height, depthOrArrayLayers } = extractTextureSize(type, options);
        this.width = width;
        this.height = height;
        this.depthOrArrayLayers = depthOrArrayLayers;
        // Format defaults based on whether it's a depth texture
        this.format = options.format ?? (isDepthTextureDesc(type) ? 'depth32float' : 'rgba8unorm');
        // Usage defaults
        this.usage = options.usage ?? (GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
        // Mip levels
        this.mipLevelCount = options.mipLevelCount ?? 1;
        this.sampleCount = options.sampleCount ?? 1;
        // Source handling
        this.generateMipmaps = options.generateMipmaps ?? false;
        this.flipY = options.flipY ?? false;
        this.premultiplyAlpha = options.premultiplyAlpha ?? false;
        // Handle source(s) based on texture type
        const opts = options;
        if (opts.source) {
            this.source = opts.source instanceof Source
                ? opts.source
                : new Source(opts.source);
        }
        if (opts.sources) {
            this.sources = opts.sources.map((s) => s instanceof Source ? s : new Source(s));
        }
        if (opts.faces) {
            this.sources = opts.faces.map((s) => s instanceof Source ? s : new Source(s));
        }
    }
    // Convenience getters
    /** For cube textures: the size (width = height) */
    get size() { return this.width; }
    /** For 2D array: number of layers */
    get layers() { return this.depthOrArrayLayers; }
    /** For 3D: depth */
    get depth() { return this.depthOrArrayLayers; }
    /** For cube array: number of cubes */
    get cubeCount() { return this.depthOrArrayLayers / 6; }
    /** Is this a depth texture? */
    get isDepth() { return isDepthTextureDesc(this.type); }
    /** Is all source data ready for upload? */
    get isComplete() {
        if (this.source && !this.source.dataReady)
            return false;
        for (const s of this.sources) {
            if (!s.dataReady)
                return false;
        }
        // Cube textures need exactly 6 faces
        if (isCubeTextureDesc(this.type) && this.sources.length !== 6)
            return false;
        return true;
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this._onDispose?.();
        this._onDispose = null;
        this.source = null;
        this.sources = [];
    }
}
function extractTextureSize(type, options) {
    const viewDim = textureViewDimension(type);
    const opts = options;
    switch (viewDim) {
        case 'cube':
            return { width: opts.size, height: opts.size, depthOrArrayLayers: 6 };
        case 'cube-array':
            return { width: opts.size, height: opts.size, depthOrArrayLayers: opts.cubeCount * 6 };
        case '2d-array':
            return { width: opts.width, height: opts.height, depthOrArrayLayers: opts.layers };
        case '3d':
            return { width: opts.width, height: opts.height, depthOrArrayLayers: opts.depth };
        case '1d':
            return { width: opts.width, height: 1, depthOrArrayLayers: 1 };
        default:
            return { width: opts.width, height: opts.height, depthOrArrayLayers: 1 };
    }
}

let _samplerId = 0;
/**
 * Declarative sampler settings.
 *
 * Does NOT hold the GPU resource - that's managed by the renderer's cache.
 * The settingsKey is used for deduplication (multiple GpuSampler instances
 * with the same settings share one GPUSampler).
 */
class GpuSampler {
    id = _samplerId++;
    minFilter;
    magFilter;
    mipmapFilter;
    addressModeU;
    addressModeV;
    addressModeW;
    maxAnisotropy;
    lodMinClamp;
    lodMaxClamp;
    /** For comparison samplers (shadow mapping) */
    compare;
    /** Renderer-set callback to clean up cache entry */
    _onDispose = null;
    disposed = false;
    constructor(options = {}) {
        this.minFilter = options.minFilter ?? 'linear';
        this.magFilter = options.magFilter ?? 'linear';
        this.mipmapFilter = options.mipmapFilter ?? 'linear';
        this.addressModeU = options.addressModeU ?? 'clamp-to-edge';
        this.addressModeV = options.addressModeV ?? 'clamp-to-edge';
        this.addressModeW = options.addressModeW ?? 'clamp-to-edge';
        this.maxAnisotropy = options.maxAnisotropy ?? 1;
        this.lodMinClamp = options.lodMinClamp ?? 0;
        this.lodMaxClamp = options.lodMaxClamp ?? 32;
        this.compare = options.compare;
    }
    /** Is this a comparison sampler? */
    get isComparison() {
        return this.compare !== undefined;
    }
    /** Settings key for deduplication */
    get settingsKey() {
        const base = `${this.minFilter}-${this.magFilter}-${this.mipmapFilter}-` +
            `${this.addressModeU}-${this.addressModeV}-${this.addressModeW}-` +
            `${this.maxAnisotropy}-${this.lodMinClamp}-${this.lodMaxClamp}`;
        return this.compare ? `${base}-cmp-${this.compare}` : base;
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this._onDispose?.();
        this._onDispose = null;
    }
}

/**
 * High-level 2D texture class.
 *
 * Holds sampling parameters and references a Source for image data.
 */
class Texture {
    /** Type flag for runtime type checking */
    isTexture = true;
    /** The underlying GPU texture resource */
    _gpuTexture;
    /** The underlying sampler */
    _gpuSampler;
    /** Optional name for debugging */
    name = '';
    /**
     * User-provided mipmaps as Sources. If empty, mipmaps are auto-generated
     * when `generateMipmaps` is true.
     */
    mipmaps = [];
    /**
     * Callback fired when the texture is updated.
     */
    onUpdate = null;
    /**
     * Whether this texture belongs to a render target.
     * Set to true by RenderTarget when creating its textures.
     * @default false
     */
    isRenderTargetTexture = false;
    /**
     * Constructs a new Texture.
     *
     * @param image - The image source (ImageBitmap, HTMLImageElement, Source, etc.)
     * @param options - Texture options
     */
    constructor(image, options = {}) {
        // Create the source
        const src = image instanceof Source
            ? image
            : image !== null
                ? new Source(image)
                : null;
        // Create the underlying GpuTexture
        this._gpuTexture = new GpuTexture(texture2d(), {
            width: src?.width || 1,
            height: src?.height || 1,
            source: src ?? undefined,
            format: options.format,
            generateMipmaps: options.generateMipmaps ?? true,
            flipY: options.flipY ?? false,
            premultiplyAlpha: options.premultiplyAlpha ?? false,
        });
        // Create the underlying sampler
        this._gpuSampler = new GpuSampler({
            addressModeU: options.wrapS ?? 'clamp-to-edge',
            addressModeV: options.wrapT ?? 'clamp-to-edge',
            magFilter: options.magFilter ?? 'linear',
            minFilter: options.minFilter ?? 'linear',
            mipmapFilter: options.mipmapFilter ?? 'linear',
            maxAnisotropy: options.anisotropy ?? 1,
        });
    }
    // ─── Convenience getters/setters that forward to internals ───
    /** Unique numeric ID */
    get id() { return this._gpuTexture.id; }
    /** Returns the width of the source, or 1 if no data. */
    get width() { return this._gpuTexture.width; }
    /** Returns the height of the source, or 1 if no data. */
    get height() { return this._gpuTexture.height; }
    /** The data source for this texture. */
    get source() { return this._gpuTexture.source; }
    set source(s) {
        this._gpuTexture.source = s;
        if (s) {
            this._gpuTexture.width = s.width || 1;
            this._gpuTexture.height = s.height || 1;
        }
    }
    /** Convenience getter for the source data. */
    get image() {
        return this._gpuTexture.source?.data;
    }
    /** Convenience setter for the source data. */
    set image(value) {
        if (this._gpuTexture.source) {
            this._gpuTexture.source.data = value;
        }
        else if (value !== null) {
            this._gpuTexture.source = new Source(value);
        }
    }
    /** Horizontal wrap mode (U direction). */
    get wrapS() { return this._gpuSampler.addressModeU; }
    set wrapS(v) { this._gpuSampler.addressModeU = v; }
    /** Vertical wrap mode (V direction). */
    get wrapT() { return this._gpuSampler.addressModeV; }
    set wrapT(v) { this._gpuSampler.addressModeV = v; }
    /** Magnification filter. */
    get magFilter() { return this._gpuSampler.magFilter; }
    set magFilter(v) { this._gpuSampler.magFilter = v; }
    /** Minification filter. */
    get minFilter() { return this._gpuSampler.minFilter; }
    set minFilter(v) { this._gpuSampler.minFilter = v; }
    /** Mipmap filter mode. */
    get mipmapFilter() { return this._gpuSampler.mipmapFilter; }
    set mipmapFilter(v) { this._gpuSampler.mipmapFilter = v; }
    /** Anisotropic filtering level. */
    get anisotropy() { return this._gpuSampler.maxAnisotropy; }
    set anisotropy(v) { this._gpuSampler.maxAnisotropy = v; }
    /** WebGPU texture format. */
    get format() { return this._gpuTexture.format; }
    set format(v) { this._gpuTexture.format = v; }
    /** Whether to auto-generate mipmaps. */
    get generateMipmaps() { return this._gpuTexture.generateMipmaps; }
    set generateMipmaps(v) { this._gpuTexture.generateMipmaps = v; }
    /** Whether to flip the image vertically when uploading. */
    get flipY() { return this._gpuTexture.flipY; }
    set flipY(v) { this._gpuTexture.flipY = v; }
    /** Whether to premultiply alpha. */
    get premultiplyAlpha() { return this._gpuTexture.premultiplyAlpha; }
    set premultiplyAlpha(v) { this._gpuTexture.premultiplyAlpha = v; }
    /** Version for dirty tracking. */
    get version() { return this._gpuTexture.version; }
    /** Set to `true` to trigger a GPU upload on the next render. */
    set needsUpdate(value) {
        if (value) {
            this._gpuTexture.needsUpdate = true;
            if (this._gpuTexture.source) {
                this._gpuTexture.source.needsUpdate = true;
            }
            this.onUpdate?.(this);
        }
    }
    /** Renderer-set callback to destroy GPU resources. */
    // TODO: did we ever need it?
    // get _onDispose(): (() => void) | null { return this._gpuTexture._onDispose; }
    // set _onDispose(v: (() => void) | null) { this._gpuTexture._onDispose = v; }
    /**
     * Creates a clone of this texture.
     * Note: The clone shares the same Source by default.
     */
    clone() {
        const tex = new Texture(this.source, {
            wrapS: this.wrapS,
            wrapT: this.wrapT,
            magFilter: this.magFilter,
            minFilter: this.minFilter,
            mipmapFilter: this.mipmapFilter,
            anisotropy: this.anisotropy,
            format: this.format,
            generateMipmaps: this.generateMipmaps,
            flipY: this.flipY,
            premultiplyAlpha: this.premultiplyAlpha,
        });
        tex.name = this.name;
        tex.mipmaps = [...this.mipmaps];
        return tex;
    }
    /**
     * Disposes of the texture and its GPU resources.
     */
    dispose() {
        this._gpuTexture.dispose();
        this._gpuSampler.dispose();
        this.mipmaps = [];
    }
}

/**
 * A texture for storing depth information.
 * Used as the depth attachment in RenderTarget, or for shadow mapping.
 *
 * Defaults to comparison sampler for shadow mapping convenience.
 */
class DepthTexture {
    /** The underlying GPU texture resource */
    _gpuTexture;
    /** The underlying sampler */
    _gpuSampler;
    /** Optional name for debugging */
    name = '';
    /**
     * Constructs a new DepthTexture.
     *
     * @param width - The width of the texture
     * @param height - The height of the texture
     * @param format - The depth format (default: 'depth24plus')
     */
    constructor(width, height, format = 'depth24plus') {
        this._gpuTexture = new GpuTexture(textureDepth2d, {
            width,
            height,
            format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        // Default to comparison sampler for shadow mapping
        this._gpuSampler = new GpuSampler({
            compare: 'less',
            magFilter: 'linear',
            minFilter: 'linear',
        });
    }
    get id() { return this._gpuTexture.id; }
    get width() { return this._gpuTexture.width; }
    get height() { return this._gpuTexture.height; }
    get format() { return this._gpuTexture.format; }
    get compareFunction() { return this._gpuSampler.compare; }
    set compareFunction(v) { this._gpuSampler.compare = v; }
    /** Version for dirty tracking. */
    get version() { return this._gpuTexture.version; }
    /** Mark as needing re-upload. */
    set needsUpdate(v) {
        if (v)
            this._gpuTexture.needsUpdate = true;
    }
    /** Set the size of the depth texture. */
    setSize(width, height) {
        if (this._gpuTexture.width !== width || this._gpuTexture.height !== height) {
            this._gpuTexture.width = width;
            this._gpuTexture.height = height;
            this._gpuTexture.needsUpdate = true;
        }
    }
    clone() {
        const tex = new DepthTexture(this.width, this.height, this.format);
        tex.name = this.name;
        tex.compareFunction = this.compareFunction;
        return tex;
    }
    dispose() {
        this._gpuTexture.dispose();
        this._gpuSampler.dispose();
    }
}

/**
 * A render target is a buffer where the video card draws pixels for a scene
 * that is being rendered in the background. It is used in different effects,
 * such as applying postprocessing to a rendered image before displaying it
 * on the screen.
 */
class RenderTarget {
    /** The width of the render target */
    width;
    /** The height of the render target */
    height;
    /** The color format of the render target's texture(s) */
    colorFormat;
    /** The depth format of the render target's depth texture, or null if no depth attachment */
    depthFormat;
    /** The MSAA sample count of the render target */
    samples;
    /**
     * Array of color attachment textures.
     * Each has a `.name` for MRT mapping, the first texture is also accessible via the `texture` getter.
     * These are Texture instances with isRenderTargetTexture = true.
     */
    textures;
    /** Depth texture, or null if no depth */
    depthTexture = null;
    /** Constructs a new render target */
    constructor(width, height, opts = {}) {
        this.width = width;
        this.height = height;
        this.colorFormat = opts.colorFormat ?? 'rgba16float';
        this.depthFormat = opts.depthFormat !== undefined ? opts.depthFormat : 'depth24plus';
        this.samples = opts.samples ?? 1;
        // Create color attachment textures
        const count = opts.count ?? 1;
        this.textures = [];
        for (let i = 0; i < count; i++) {
            const texture = createRenderTargetTexture(this, width, height, this.colorFormat);
            texture.name = i === 0 ? 'output' : `output${i}`;
            this.textures.push(texture);
        }
        // Create depth texture if depth format specified
        if (this.depthFormat) {
            const depthTexture = new DepthTexture(width, height, this.depthFormat);
            depthTexture.name = 'depth';
            depthTexture._gpuTexture.isRenderTargetTexture = true;
            this.depthTexture = depthTexture;
        }
    }
    /** The first color attachment texture, or undefined when count=0 (depth-only target). */
    get texture() {
        return this.textures[0];
    }
    /** Sets the size of the render target, disposes existing GPU resources; renderer will reallocate on next use */
    setSize(width, height) {
        if (this.width === width && this.height === height)
            return;
        this.dispose();
        this.width = width;
        this.height = height;
        // update texture dimensions on the GpuTexture
        for (const tex of this.textures) {
            tex._gpuTexture.width = width;
            tex._gpuTexture.height = height;
            tex._gpuTexture.needsUpdate = true;
        }
        if (this.depthTexture) {
            this.depthTexture.setSize(width, height);
        }
    }
    /**
     * Dispose of the render target's GPU resources.
     * This triggers the _onDispose callbacks set by the renderer cache.
     */
    dispose() {
        for (const tex of this.textures) {
            tex._gpuTexture.dispose();
        }
        if (this.depthTexture) {
            this.depthTexture._gpuTexture.dispose();
        }
    }
    /** Returns the texture index for the given name, or -1 if not found. */
    getTextureIndex(name) {
        for (let i = 0; i < this.textures.length; i++) {
            if (this.textures[i].name === name)
                return i;
        }
        return -1;
    }
}
/** creates a Texture configured for use as a render target color attachment */
function createRenderTargetTexture(_renderTarget, width, height, format) {
    // create placeholder image object with dimensions
    const image = { width, height };
    const texture = new Texture(image);
    texture.format = format;
    texture.isRenderTargetTexture = true;
    texture.generateMipmaps = false;
    texture.flipY = false;
    // Mark the underlying GpuTexture as a render target texture too
    texture._gpuTexture.isRenderTargetTexture = true;
    return texture;
}

/**
 * SubBuildNode - wraps a node to build it in a specific sub-build context.
 * Used by VaryingNode to ensure source nodes are built in VERTEX stage.
 */
class SubBuildNode extends Node {
    node;
    subBuildName;
    isSubBuildNode = true;
    constructor(node, subBuildName, nodeType = null) {
        super(nodeType ?? node.type);
        this.node = node;
        this.subBuildName = subBuildName;
    }
}
// TODO: kill SubBuildNode? or keep?
/**
 * Creates a SubBuildNode wrapper.
 */
function subBuild(node, name, type = null) {
    return new SubBuildNode(node, name, type);
}

/**
 * VaryingNode - represents shader varyings that pass data from vertex to fragment stage.
 */
class VaryingNode extends Node {
    isVaryingNode = true;
    /** The source node wrapped with subBuild('VERTEX') */
    node;
    /** The name of the varying in the shader (auto-generated if null) */
    name;
    /** Interpolation type */
    interpolationType = null;
    /** Interpolation sampling */
    interpolationSampling = null;
    constructor(source, name = null) {
        super(source.type);
        // wrap source in SubBuildNode for VERTEX stage
        this.node = subBuild(source, 'VERTEX');
        this.name = name;
        // use global cache for varyings
        this.global = true;
    }
    /**
     * Set the WGSL @interpolate qualifier for this varying.
     */
    setInterpolation(type, sampling) {
        this.interpolationType = type;
        this.interpolationSampling = sampling ?? null;
        return this;
    }
}
const varying = (source, name) => new VaryingNode(source, name ?? null);

/**
 * SamplerNode - represents a sampler binding.
 *
 * Samplers are first-class nodes with their own bindings, mirroring WGSL's
 * separate texture/sampler model.
 *
 * Holds a reference to a GpuSampler which contains the actual settings.
 */
class SamplerNode extends Node {
    /** The GpuSampler - always has a valid default */
    value = new GpuSampler();
    /** Unique ID for this sampler instance */
    samplerId;
    /** Uniform group — determines @group index. */
    groupNode;
    constructor(desc, samplerId, groupNode = objectGroup) {
        super(desc);
        this.samplerId = samplerId;
        this.groupNode = groupNode;
    }
    /** Settings key from the GpuSampler (for deduplication) */
    get settingsKey() {
        return this.value.settingsKey;
    }
    /** Sampling parameters (forwarded from GpuSampler) */
    get minFilter() { return this.value.minFilter; }
    get magFilter() { return this.value.magFilter; }
    get mipmapFilter() { return this.value.mipmapFilter; }
    get addressModeU() { return this.value.addressModeU; }
    get addressModeV() { return this.value.addressModeV; }
    get addressModeW() { return this.value.addressModeW; }
    get maxAnisotropy() { return this.value.maxAnisotropy; }
    get compare() { return this.value.compare; }
    /** Clone this sampler (shares same GpuSampler reference) */
    clone() {
        const cloned = new SamplerNode(this.type, this.samplerId, this.groupNode);
        cloned.value = this.value;
        return cloned;
    }
}
/* ────────────────────────────────────────────────────────────────────────────
 * TextureBindingNode
 * ──────────────────────────────────────────────────────────────────────────── */
/**
 * TextureBindingNode - represents a module-scope texture handle binding.
 *
 * This mirrors how SamplerNode works: it represents a `var t : texture_2d<f32>`
 * (or texture_cube<f32>, texture_depth_2d, etc.) at module scope. When used as
 * an expression, it generates just the binding name — never a sampling operation.
 *
 * The existing TextureNode/CubeTextureNode/DepthTextureNode own a
 * TextureBindingNode internally and delegate binding registration to it.
 * Free functions take TextureBindingNode + SamplerNode as arguments, producing
 * correct WGSL like `textureSample(myTex, mySampler, uv)`.
 *
 * Holds a reference to a GpuTexture<D> which the renderer uses to create/update
 * the GPU texture.
 */
class TextureBindingNode extends Node {
    /** The GpuTexture */
    value = null;
    /** Unique ID for this texture binding (e.g. 'tAlbedo', 'tShadowMap'). */
    textureId;
    /** Uniform group — determines @group index. */
    groupNode;
    constructor(desc, textureId, groupNode = objectGroup) {
        super(desc);
        this.textureId = textureId;
        this.groupNode = groupNode;
    }
}
/**
 * TextureNode - represents a texture sample operation.
 *
 * When used as a value, it samples the texture at the given UV coordinates.
 * The node type is 'vec4f' (the sampled color), not the texture type.
 *
 * Owns a TextureBindingNode that handles the module-scope binding.
 *
 * Supports chainable methods for ergonomic sampling control:
 * - .sample(uv) - set UV coordinates
 * - .level(level) - use textureSampleLevel
 * - .bias(bias) - use textureSampleBias
 * - .grad(ddx, ddy) - use textureSampleGrad
 * - .offset(offset) - add offset parameter (2D only)
 * - .load(coords, level?) - use textureLoad (no sampler)
 */
class TextureNode extends Node {
    isTextureNode = true;
    /** The texture binding — holds GPU resource, textureId, groupNode. */
    bindingNode;
    /**
     * The UV node for texture coordinates.
     * Defaults to varying(uv()) if not specified.
     */
    uvNode;
    /**
     * The reference node
     * When sampling with different UVs, this points to the base texture node.
     */
    referenceNode = null;
    /**
     * The sampler node for this texture.
     * Auto-created by texture() factory from texture settings.
     * Can be set explicitly for custom sampler sharing.
     */
    samplerNode = null;
    /* ─────────────────────────────────────────────────────────────────────────
     * Sampling mode properties
     * ───────────────────────────────────────────────────────────────────────── */
    /** Current sampling mode */
    samplingMode = 'sample';
    /** Level node for textureSampleLevel (f32 for regular textures) */
    levelNode = null;
    /** Bias node for textureSampleBias */
    biasNode = null;
    /** Gradient nodes for textureSampleGrad [ddx, ddy] */
    gradNode = null;
    /** Offset node for sampling with offset (2D and 2D-array only, must be const) */
    offsetNode = null;
    /** Integer coordinates for textureLoad */
    loadCoords = null;
    /** Level for textureLoad (i32) */
    loadLevel = null;
    constructor(bindingNode, uvNode = null) {
        // Node type is vec4f (the sampled color)
        super(vec4f$1);
        this.bindingNode = bindingNode;
        this.uvNode = uvNode ?? varying(uv());
    }
    /** Get the base texture node (follows referenceNode chain) */
    getBase() {
        return this.referenceNode ? this.referenceNode.getBase() : this;
    }
    /** Convert this texture node to a sampler type */
    convert(type) {
        const desc = type === 'sampler' ? sampler$1 : samplerComparison;
        return new CallNode(desc, type, [this]);
    }
    /** Clone this texture node with all sampling properties */
    clone() {
        const cloned = new TextureNode(this.bindingNode, this.uvNode);
        // copy nodes
        cloned.referenceNode = this.referenceNode;
        cloned.samplerNode = this.samplerNode;
        // copy sampling mode properties
        cloned.samplingMode = this.samplingMode;
        cloned.levelNode = this.levelNode;
        cloned.biasNode = this.biasNode;
        cloned.gradNode = this.gradNode;
        cloned.offsetNode = this.offsetNode;
        cloned.loadCoords = this.loadCoords;
        cloned.loadLevel = this.loadLevel;
        return cloned;
    }
    /* ─────────────────────────────────────────────────────────────────────────
     * Chainable sampling methods
     * ───────────────────────────────────────────────────────────────────────── */
    /** Sample the texture at the given UV coordinates */
    sample(uvNode) {
        const textureNode = this.clone();
        textureNode.uvNode = uvNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }
    /** Use textureSampleLevel with explicit mip level */
    level(levelNode) {
        const textureNode = this.clone();
        textureNode.samplingMode = 'level';
        textureNode.levelNode = levelNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }
    /** Use textureSampleBias with mip level bias */
    bias(biasNode) {
        const textureNode = this.clone();
        textureNode.samplingMode = 'bias';
        textureNode.biasNode = biasNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }
    /** Use textureSampleGrad with explicit gradients */
    grad(ddx, ddy) {
        const textureNode = this.clone();
        textureNode.samplingMode = 'grad';
        textureNode.gradNode = [ddx, ddy];
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }
    /** Add offset to sampling (2D and 2D-array only, must be const expression) */
    offset(offsetNode) {
        const textureNode = this.clone();
        textureNode.offsetNode = offsetNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }
    /** Use textureLoad for direct texel fetch (no filtering) */
    load(coords, level) {
        const textureNode = this.clone();
        textureNode.samplingMode = 'load';
        textureNode.loadCoords = coords;
        textureNode.loadLevel = level ?? null;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }
}
/** Counter for generating unique sampler IDs when using GpuSampler directly */
let _samplerIdCounter = 0;
function sampler(source, groupNode = objectGroup) {
    if (source instanceof GpuSampler) {
        const node = new SamplerNode(sampler$1, `s${_samplerIdCounter++}`, groupNode);
        node.value = source;
        return node;
    }
    else {
        const node = new SamplerNode(sampler$1, `s${source.id}`, groupNode);
        node.value = source._gpuSampler;
        return node;
    }
}
function comparisonSampler(source, compare = 'less', groupNode = objectGroup) {
    const baseSampler = source instanceof GpuSampler ? source : source._gpuSampler;
    const samplerId = source instanceof GpuSampler ? `s${_samplerIdCounter++}_cmp` : `s${source.id}_cmp`;
    const node = new SamplerNode(samplerComparison, samplerId, groupNode);
    // Create a new GpuSampler with comparison function
    const cmpSampler = new GpuSampler({
        minFilter: baseSampler.minFilter,
        magFilter: baseSampler.magFilter,
        mipmapFilter: baseSampler.mipmapFilter,
        addressModeU: baseSampler.addressModeU,
        addressModeV: baseSampler.addressModeV,
        addressModeW: baseSampler.addressModeW,
        maxAnisotropy: baseSampler.maxAnisotropy,
        compare,
    });
    node.value = cmpSampler;
    return node;
}
/** Counter for generating unique texture IDs when using GpuTexture directly */
let _textureIdCounter = 0;
function texture(source, gpuSampler) {
    if (source instanceof GpuTexture) {
        if (!gpuSampler) {
            throw new Error('texture(): GpuSampler required when passing GpuTexture directly');
        }
        // Widen the type for the binding to FlatSampledTextureDesc
        const desc = source.type;
        const binding = new TextureBindingNode(desc, `t${_textureIdCounter++}`);
        binding.value = source;
        const node = new TextureNode(binding);
        node.samplerNode = sampler(gpuSampler, binding.groupNode);
        return node;
    }
    else {
        // Texture._gpuTexture is GpuTexture<d.texture2d>
        // Widen to FlatSampledTextureDesc for the binding
        const gpuTex = source._gpuTexture;
        const desc = gpuTex.type;
        const binding = new TextureBindingNode(desc, `t${source.id}`);
        binding.value = gpuTex;
        const node = new TextureNode(binding);
        node.samplerNode = sampler(source._gpuSampler, binding.groupNode);
        return node;
    }
}
/**
 * Create a standalone texture binding node.
 *
 * Use this when you want to work with WGSL-level free functions directly
 * (textureSample, textureLoad, etc.) instead of the high-level TextureNode
 * sampling API.
 */
const textureBinding = (tex, textureDesc) => {
    const binding = new TextureBindingNode(textureDesc, `t${tex.id}`);
    binding.value = tex._gpuTexture;
    return binding;
};
/**
 * CubeTextureNode - represents a cube texture sample operation.
 *
 * Cube textures use a 3D direction vector for sampling (vec3f).
 * WGSL cube texture constraints:
 * - NO offset support (cube textures don't support offset parameter)
 * - NO textureLoad support (cube textures don't support direct texel access)
 * - Uses vec3f for both coordinates and gradients
 *
 * Supports chainable methods:
 * - .sample(direction) - set sampling direction
 * - .level(level) - use textureSampleLevel
 * - .bias(bias) - use textureSampleBias
 * - .grad(ddx, ddy) - use textureSampleGrad
 */
class CubeTextureNode extends Node {
    isCubeTextureNode = true;
    /** The texture binding — holds GPU resource, textureId, groupNode. */
    bindingNode;
    /**
     * The direction node for cube texture sampling (vec3f).
     * This is a 3D direction vector pointing into the cube.
     */
    directionNode = null;
    /**
     * The reference node.
     * When sampling with different directions, this points to the base texture node.
     */
    referenceNode = null;
    /**
     * The sampler node for this texture.
     * Auto-created by cubeTexture() factory from texture settings.
     */
    samplerNode = null;
    /* ─────────────────────────────────────────────────────────────────────────
     * Sampling mode properties
     * ───────────────────────────────────────────────────────────────────────── */
    /** Current sampling mode */
    samplingMode = 'sample';
    /** Level node for textureSampleLevel (f32) */
    levelNode = null;
    /** Bias node for textureSampleBias */
    biasNode = null;
    /** Gradient nodes for textureSampleGrad [ddx, ddy] - vec3f for cube textures */
    gradNode = null;
    constructor(bindingNode, directionNode = null) {
        // Node type is vec4f (the sampled color)
        super(vec4f$1);
        this.bindingNode = bindingNode;
        this.directionNode = directionNode;
    }
    /** Get the base texture node (follows referenceNode chain) */
    getBase() {
        return this.referenceNode ? this.referenceNode.getBase() : this;
    }
    /** Clone this texture node with all sampling properties */
    clone() {
        const cloned = new CubeTextureNode(this.bindingNode, this.directionNode);
        cloned.referenceNode = this.referenceNode;
        cloned.samplerNode = this.samplerNode;
        // Copy sampling mode properties
        cloned.samplingMode = this.samplingMode;
        cloned.levelNode = this.levelNode;
        cloned.biasNode = this.biasNode;
        cloned.gradNode = this.gradNode;
        return cloned;
    }
    /* ─────────────────────────────────────────────────────────────────────────
     * Chainable sampling methods
     * ───────────────────────────────────────────────────────────────────────── */
    /** Sample the cube texture in the given direction */
    sample(directionNode) {
        const textureNode = this.clone();
        textureNode.directionNode = directionNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }
    /** Use textureSampleLevel with explicit mip level */
    level(levelNode) {
        const textureNode = this.clone();
        textureNode.samplingMode = 'level';
        textureNode.levelNode = levelNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }
    /** Use textureSampleBias with mip level bias */
    bias(biasNode) {
        const textureNode = this.clone();
        textureNode.samplingMode = 'bias';
        textureNode.biasNode = biasNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }
    /** Use textureSampleGrad with explicit gradients (vec3f for cube textures) */
    grad(ddx, ddy) {
        const textureNode = this.clone();
        textureNode.samplingMode = 'grad';
        textureNode.gradNode = [ddx, ddy];
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }
}
function cubeTexture(source, gpuSampler) {
    if (source instanceof GpuTexture) {
        if (!gpuSampler) {
            throw new Error('cubeTexture(): GpuSampler required when passing GpuTexture directly');
        }
        const desc = source.type;
        const binding = new TextureBindingNode(desc, `t${_textureIdCounter++}`);
        binding.value = source;
        const node = new CubeTextureNode(binding);
        node.samplerNode = sampler(gpuSampler, binding.groupNode);
        return node;
    }
    else {
        const gpuTex = source._gpuTexture;
        const desc = gpuTex.type;
        const binding = new TextureBindingNode(desc, `t${source.id}`);
        binding.value = gpuTex;
        const node = new CubeTextureNode(binding);
        node.samplerNode = sampler(source._gpuSampler, binding.groupNode);
        return node;
    }
}
/**
 * DepthTextureNode - represents a depth texture sample operation.
 *
 * Maps to WGSL `texture_depth_2d`. Returns f32 (not vec4f).
 *
 * Key differences from regular TextureNode:
 * - Returns f32 (single depth value)
 * - Level is i32 (not f32) for textureSampleLevel
 * - NO textureSampleBias support
 * - NO textureSampleGrad support
 * - Supports offset (2D depth textures)
 * - Comparison sampling via free functions (textureSampleCompare/textureSampleCompareLevel)
 *   which require a sampler_comparison — use comparisonSampler() to create one
 *
 * Supports chainable methods:
 * - .sample(uv) - set UV coordinates
 * - .level(level) - use textureSampleLevel (i32 level)
 * - .offset(offset) - add offset parameter
 * - .load(coords, level?) - use textureLoad
 */
class DepthTextureNode extends Node {
    isDepthTextureNode = true;
    /** The texture binding — holds GPU resource, textureId, groupNode. */
    bindingNode;
    /**
     * The UV node for texture coordinates (vec2f).
     * Defaults to varying(uv()) if not specified.
     */
    uvNode;
    /**
     * The reference node.
     * When sampling with different UVs, this points to the base texture node.
     */
    referenceNode = null;
    /**
     * The sampler node for this texture.
     * Auto-created by depthTexture() factory from texture settings.
     * This is a regular sampler for textureSample/textureSampleLevel.
     * For comparison sampling, use comparisonSampler() and the free functions.
     */
    samplerNode = null;
    /* ─────────────────────────────────────────────────────────────────────────
     * Sampling mode properties
     * ───────────────────────────────────────────────────────────────────────── */
    /** Current sampling mode */
    samplingMode = 'sample';
    /** Level node for textureSampleLevel (i32 for depth textures) */
    levelNode = null;
    /** Offset node for sampling with offset (must be const expression) */
    offsetNode = null;
    /** Integer coordinates for textureLoad */
    loadCoords = null;
    /** Level for textureLoad (i32) */
    loadLevel = null;
    constructor(bindingNode, uvNode = null) {
        // Node type is f32 (depth value)
        super(f32$1);
        this.bindingNode = bindingNode;
        this.uvNode = uvNode ?? varying(uv());
    }
    /** Get the base texture node (follows referenceNode chain) */
    getBase() {
        return this.referenceNode ? this.referenceNode.getBase() : this;
    }
    /** Clone this texture node with all sampling properties */
    clone() {
        const cloned = new DepthTextureNode(this.bindingNode, this.uvNode);
        cloned.referenceNode = this.referenceNode;
        cloned.samplerNode = this.samplerNode;
        // Copy sampling mode properties
        cloned.samplingMode = this.samplingMode;
        cloned.levelNode = this.levelNode;
        cloned.offsetNode = this.offsetNode;
        cloned.loadCoords = this.loadCoords;
        cloned.loadLevel = this.loadLevel;
        return cloned;
    }
    /* ─────────────────────────────────────────────────────────────────────────
     * Chainable sampling methods
     * ───────────────────────────────────────────────────────────────────────── */
    /** Sample the depth texture at the given UV coordinates */
    sample(uvNode) {
        const textureNode = this.clone();
        textureNode.uvNode = uvNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }
    /** Use textureSampleLevel with explicit mip level (i32 for depth textures) */
    level(levelNode) {
        const textureNode = this.clone();
        textureNode.samplingMode = 'level';
        textureNode.levelNode = levelNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }
    /** Add offset to sampling (must be const expression) */
    offset(offsetNode) {
        const textureNode = this.clone();
        textureNode.offsetNode = offsetNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }
    /** Use textureLoad for direct texel fetch (no filtering) */
    load(coords, level) {
        const textureNode = this.clone();
        textureNode.samplingMode = 'load';
        textureNode.loadCoords = coords;
        textureNode.loadLevel = level ?? null;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }
}
function depthTexture(source, gpuSampler) {
    if (source instanceof GpuTexture) {
        if (!gpuSampler) {
            throw new Error('depthTexture(): GpuSampler required when passing GpuTexture directly');
        }
        const desc = source.type;
        const binding = new TextureBindingNode(desc, `t${_textureIdCounter++}`);
        binding.value = source;
        const node = new DepthTextureNode(binding);
        node.samplerNode = sampler(gpuSampler, binding.groupNode);
        return node;
    }
    else {
        const gpuTex = source._gpuTexture;
        const desc = gpuTex.type;
        const binding = new TextureBindingNode(desc, `t${source.id}`);
        binding.value = gpuTex;
        const node = new DepthTextureNode(binding);
        node.samplerNode = sampler(source._gpuSampler, binding.groupNode);
        return node;
    }
}
/**
 * ArrayTextureNode - represents a 2D array texture sample operation.
 *
 * Maps to WGSL `texture_2d_array<f32>`. Returns vec4f.
 *
 * Key differences from regular TextureNode:
 * - Has a `layerNode` (i32) for the array layer index
 * - WGSL inserts the array_index after coords in all sampling calls
 * - Uses vec2f coords + i32 array_index (not vec3f)
 *
 * Supports chainable methods:
 * - .layer(index) - set the array layer index
 * - .sample(uv) - set UV coordinates
 * - .level(level) - use textureSampleLevel
 * - .bias(bias) - use textureSampleBias
 * - .grad(ddx, ddy) - use textureSampleGrad
 * - .offset(offset) - add offset parameter
 * - .load(coords, level?) - use textureLoad
 */
class ArrayTextureNode extends Node {
    isArrayTextureNode = true;
    /** The texture binding — holds GPU resource, textureId, groupNode. */
    bindingNode;
    /**
     * The UV node for texture coordinates (vec2f).
     * Defaults to varying(uv()) if not specified.
     */
    uvNode;
    /** The array layer index (i32). */
    layerNode;
    /**
     * The reference node.
     * When sampling with different UVs/layers, this points to the base texture node.
     */
    referenceNode = null;
    /**
     * The sampler node for this texture.
     * Auto-created by arrayTexture() factory from texture settings.
     */
    samplerNode = null;
    /* ─────────────────────────────────────────────────────────────────────────
     * Sampling mode properties
     * ───────────────────────────────────────────────────────────────────────── */
    /** Current sampling mode */
    samplingMode = 'sample';
    /** Level node for textureSampleLevel (f32) */
    levelNode = null;
    /** Bias node for textureSampleBias */
    biasNode = null;
    /** Gradient nodes for textureSampleGrad [ddx, ddy] (vec2f) */
    gradNode = null;
    /** Offset node for sampling with offset (must be const expression) */
    offsetNode = null;
    /** Integer coordinates for textureLoad */
    loadCoords = null;
    /** Level for textureLoad (i32) */
    loadLevel = null;
    constructor(bindingNode, layerNode, uvNode = null) {
        // Node type is vec4f (the sampled color)
        super(vec4f$1);
        this.bindingNode = bindingNode;
        this.layerNode = layerNode;
        this.uvNode = uvNode ?? varying(uv());
    }
    /** Get the base texture node (follows referenceNode chain) */
    getBase() {
        return this.referenceNode ? this.referenceNode.getBase() : this;
    }
    /** Clone this texture node with all sampling properties */
    clone() {
        const cloned = new ArrayTextureNode(this.bindingNode, this.layerNode, this.uvNode);
        cloned.referenceNode = this.referenceNode;
        cloned.samplerNode = this.samplerNode;
        cloned.samplingMode = this.samplingMode;
        cloned.levelNode = this.levelNode;
        cloned.biasNode = this.biasNode;
        cloned.gradNode = this.gradNode;
        cloned.offsetNode = this.offsetNode;
        cloned.loadCoords = this.loadCoords;
        cloned.loadLevel = this.loadLevel;
        return cloned;
    }
    /* ─────────────────────────────────────────────────────────────────────────
     * Chainable sampling methods
     * ───────────────────────────────────────────────────────────────────────── */
    /** Set the array layer index */
    layer(layerNode) {
        const textureNode = this.clone();
        textureNode.layerNode = layerNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }
    /** Sample the texture at the given UV coordinates */
    sample(uvNode) {
        const textureNode = this.clone();
        textureNode.uvNode = uvNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }
    /** Use textureSampleLevel with explicit mip level */
    level(levelNode) {
        const textureNode = this.clone();
        textureNode.samplingMode = 'level';
        textureNode.levelNode = levelNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }
    /** Use textureSampleBias with mip level bias */
    bias(biasNode) {
        const textureNode = this.clone();
        textureNode.samplingMode = 'bias';
        textureNode.biasNode = biasNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }
    /** Use textureSampleGrad with explicit gradients */
    grad(ddx, ddy) {
        const textureNode = this.clone();
        textureNode.samplingMode = 'grad';
        textureNode.gradNode = [ddx, ddy];
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }
    /** Add offset to sampling (must be const expression) */
    offset(offsetNode) {
        const textureNode = this.clone();
        textureNode.offsetNode = offsetNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }
    /** Use textureLoad for direct texel fetch (no filtering) */
    load(coords, level) {
        const textureNode = this.clone();
        textureNode.samplingMode = 'load';
        textureNode.loadCoords = coords;
        textureNode.loadLevel = level ?? null;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }
}
function arrayTexture(source, samplerOrLayer, maybeLayerNode) {
    if (source instanceof GpuTexture) {
        const gpuSampler = samplerOrLayer;
        const layerNode = maybeLayerNode;
        const binding = new TextureBindingNode(source.type, `t${_textureIdCounter++}`);
        binding.value = source;
        const node = new ArrayTextureNode(binding, layerNode);
        node.samplerNode = sampler(gpuSampler, binding.groupNode);
        return node;
    }
    else {
        const layerNode = samplerOrLayer;
        const gpuTex = source._gpuTexture;
        const binding = new TextureBindingNode(gpuTex.type, `t${source.id}`);
        binding.value = gpuTex;
        const node = new ArrayTextureNode(binding, layerNode);
        node.samplerNode = sampler(source._gpuSampler, binding.groupNode);
        return node;
    }
}
/**
 * textureSample - Sample a texture at UV coordinates.
 * Fragment shader only.
 */
function textureSample(t, s, coords, offset) {
    const args = offset ? [t, s, coords, offset] : [t, s, coords];
    return new CallNode(textureSampleResultOf(t.type), 'textureSample', args);
}
/**
 * textureSampleLevel - Sample a texture at a specific mip level.
 * Works in any shader stage.
 */
function textureSampleLevel(t, s, coords, level, offset) {
    const args = offset ? [t, s, coords, level, offset] : [t, s, coords, level];
    return new CallNode(textureSampleResultOf(t.type), 'textureSampleLevel', args);
}
/**
 * textureSampleBias - Sample a texture with mip level bias.
 * Fragment shader only. Not supported for depth textures.
 */
function textureSampleBias(t, s, coords, bias, offset) {
    const args = offset ? [t, s, coords, bias, offset] : [t, s, coords, bias];
    return new CallNode(textureSampleResultOf(t.type), 'textureSampleBias', args);
}
/**
 * textureSampleGrad - Sample a texture with explicit gradients.
 * Works in any shader stage. Not supported for depth textures.
 */
function textureSampleGrad(t, s, coords, ddx, ddy, offset) {
    const args = offset ? [t, s, coords, ddx, ddy, offset] : [t, s, coords, ddx, ddy];
    return new CallNode(textureSampleResultOf(t.type), 'textureSampleGrad', args);
}
/**
 * textureSampleCompare - Compare-sample a depth texture.
 * Fragment shader only. Requires sampler_comparison.
 */
function textureSampleCompare(t, s, coords, depthRef, offset) {
    const args = offset ? [t, s, coords, depthRef, offset] : [t, s, coords, depthRef];
    return new CallNode(f32$1, 'textureSampleCompare', args);
}
/**
 * textureSampleCompareLevel - Compare-sample a depth texture at a specific level.
 * Works in any shader stage. Requires sampler_comparison.
 */
function textureSampleCompareLevel(t, s, coords, depthRef, level, offset) {
    const args = offset ? [t, s, coords, depthRef, level, offset] : [t, s, coords, depthRef, level];
    return new CallNode(f32$1, 'textureSampleCompareLevel', args);
}
/**
 * textureLoad - Load a texel directly without filtering.
 * Works in any shader stage. No sampler needed.
 */
function textureLoad(t, coords, level) {
    return new CallNode(textureSampleResultOf(t.type), 'textureLoad', [t, coords, level]);
}
/**
 * textureStore - Store a value to a storage texture.
 */
function textureStore(t, // StorageTextureNode when we add it
coords, value) {
    return new CallNode(voidDesc, 'textureStore', [t, coords, value]);
}
/**
 * textureDimensions - Get texture dimensions.
 */
function textureDimensions(t, level) {
    const args = level ? [t, level] : [t];
    return new CallNode(vec2u$1, 'textureDimensions', args);
}
/**
 * textureNumLevels - Get number of mip levels.
 */
function textureNumLevels(t) {
    return new CallNode(u32$1, 'textureNumLevels', [t]);
}
/**
 * textureNumLayers - Get number of array layers.
 */
function textureNumLayers(t) {
    return new CallNode(u32$1, 'textureNumLayers', [t]);
}
/**
 * textureGather - Gather a single component from 4 texels.
 */
function textureGather(component, t, s, coords, offset) {
    const args = offset ? [component, t, s, coords, offset] : [component, t, s, coords];
    return new CallNode(textureSampleResultOf(t.type), 'textureGather', args);
}
/**
 * textureGatherCompare - Gather compare results from 4 texels.
 * Requires sampler_comparison.
 */
function textureGatherCompare(t, s, coords, depthRef, offset) {
    const args = offset ? [t, s, coords, depthRef, offset] : [t, s, coords, depthRef];
    return new CallNode(vec4f$1, 'textureGatherCompare', args);
}

let _passCount = 0;
/**
 * Represents the texture of a pass node.
 * Extends TextureNode to ensure proper registration during setup for sampler generation.
 */
class PassTextureNode extends TextureNode {
    /** A reference to the pass node. */
    passNode;
    /** This flag can be used for type testing. */
    isPassTextureNode = true;
    /**
     * Constructs a new pass texture node.
     *
     * @param passNode - The pass node.
     * @param texture - The output texture (Texture with isRenderTargetTexture=true, or DepthTexture).
     * @param textureId - Optional custom texture ID. If not provided, uses default pass output ID.
     * @param existingBinding - If provided, reuse this binding instead of creating a new one (used by clone).
     */
    constructor(passNode, texture = null, textureId, existingBinding) {
        const binding = existingBinding ?? new TextureBindingNode(texture2d(), textureId ?? `_pass${passNode.passId}_output`, objectGroup);
        super(binding);
        this.passNode = passNode;
        this.before(passNode);
        // Set GpuTexture reference if texture provided
        if (texture) {
            this.bindingNode.value = texture._gpuTexture;
        }
    }
    clone() {
        const cloned = new PassTextureNode(this.passNode, null, undefined, this.bindingNode);
        cloned.samplerNode = this.samplerNode;
        return cloned;
    }
}
/**
 * An extension of PassTextureNode which allows to manage more than one
 * internal texture. Relevant for MRT and getPreviousTexture() API.
 */
class PassMultipleTextureNode extends PassTextureNode {
    /** The output texture name. */
    textureName;
    /** Whether previous frame data should be used or not. */
    previousTexture;
    /** This flag can be used for type testing. */
    isPassMultipleTextureNode = true;
    /**
     * Constructs a new pass multiple texture node.
     *
     * @param passNode - The pass node.
     * @param textureName - The output texture name.
     * @param previousTexture - Whether previous frame data should be used.
     */
    constructor(passNode, textureName, previousTexture = false, existingBinding) {
        // Compute the unique textureId BEFORE calling super so it's used in the node ID
        const uniqueTextureId = `${passNode.passId}_${textureName}${previousTexture ? '_prev' : ''}`;
        // Pass the unique textureId to super so the node gets a unique ID
        super(passNode, null, uniqueTextureId, existingBinding);
        this.textureName = textureName;
        this.previousTexture = previousTexture;
    }
    /**
     * Updates the texture reference of this node.
     * Called in setup() to get the current texture.
     * Stores the GpuTexture — GPU resources are accessed at bind time via the texture cache.
     */
    updateTexture() {
        const texture = this.previousTexture
            ? this.passNode.getPreviousTexture(this.textureName)
            : this.passNode.getTexture(this.textureName);
        this.bindingNode.value = texture._gpuTexture;
    }
    /**
     * Clone sharing the same bindingNode so the renderer's texture updates
     * are visible to all clones (e.g. nodes returned by .sample(uv)).
     */
    clone() {
        const cloned = new PassMultipleTextureNode(this.passNode, this.textureName, this.previousTexture, this.bindingNode);
        cloned.samplerNode = this.samplerNode;
        cloned.uvNode = this.uvNode;
        return cloned;
    }
}
/**
 * Represents a render pass (sometimes called beauty pass) in context of post processing.
 * This pass produces a render for the given scene and camera and can provide multiple outputs
 * via MRT for further processing.
 */
class PassNode extends Node {
    /** @static */
    static COLOR = 'color';
    /** @static */
    static DEPTH = 'depth';
    /**
     * The scope of the pass. The scope determines whether the node outputs color or depth.
     */
    scope;
    /** A reference to the scene. */
    scene;
    /** A reference to the camera. */
    camera;
    /** Options for the internal render target. */
    options;
    /** Stable unique string used to namespace texture/sampler IDs. */
    passId;
    clearColor;
    renderTarget;
    updateBeforeType = 'frame';
    deps = [];
    wgsl = '';
    _pixelRatio = 1;
    _width = 1;
    _height = 1;
    _resolutionScale = 1;
    _mrt = null;
    _textures = {};
    _textureNodes = {};
    _previousTextures = {};
    _previousTextureNodes = {};
    _viewZNodes = {};
    _linearDepthNodes = {};
    constructor(scope, scene, camera, options = {}) {
        const pid = `_pass${_passCount++}`;
        super(vec4f$1);
        this.scope = scope;
        this.scene = scene;
        this.camera = camera;
        this.options = options;
        this.passId = pid;
        this.clearColor = options.clearColor ?? [0, 0, 0, 1];
        const renderTarget = new RenderTarget(this._width * this._pixelRatio, this._height * this._pixelRatio, {
            colorFormat: options.colorFormat ?? 'rgba16float',
            depthFormat: 'depth24plus',
            samples: options.samples ?? 1,
            count: 1,
        });
        renderTarget.texture.name = 'output';
        this.renderTarget = renderTarget;
        // Initialize _textures with output and depth
        this._textures['output'] = renderTarget.texture;
        if (renderTarget.depthTexture) {
            this._textures['depth'] = renderTarget.depthTexture;
        }
    }
    /**
     * Sets the resolution scale for the pass.
     * The resolution scale is a factor that is multiplied with the renderer's width and height.
     */
    setResolutionScale(resolutionScale) {
        this._resolutionScale = resolutionScale;
        return this;
    }
    /** Gets the current resolution scale of the pass. */
    getResolutionScale() {
        return this._resolutionScale;
    }
    /**
     * Sets the size of the pass's render target. Honors the pixel ratio.
     */
    setSize(width, height) {
        this._width = width;
        this._height = height;
        const effectiveWidth = Math.floor(this._width * this._pixelRatio * this._resolutionScale);
        const effectiveHeight = Math.floor(this._height * this._pixelRatio * this._resolutionScale);
        this.renderTarget.setSize(effectiveWidth, effectiveHeight);
    }
    /** Sets the pixel ratio for the pass's render target and updates the size. */
    setPixelRatio(pixelRatio) {
        this._pixelRatio = pixelRatio;
        this.setSize(this._width, this._height);
    }
    /** Sets the given MRT node to setup MRT for this pass. */
    setMRT(mrt) {
        this._mrt = mrt;
        return this;
    }
    /** Returns the current MRT node. */
    getMRT() {
        return this._mrt;
    }
    /**
     * Returns the texture for the given output name.
     * Creates a new texture slot if it doesn't exist.
     */
    getTexture(name) {
        let texture = this._textures[name];
        if (texture === undefined) {
            // Clone the reference texture format and create new render target texture
            const refTexture = this.renderTarget.texture;
            const image = { width: this.renderTarget.width, height: this.renderTarget.height };
            texture = new Texture(image);
            texture.format = refTexture.format;
            texture.isRenderTargetTexture = true;
            texture.generateMipmaps = false;
            texture.flipY = false;
            texture.name = name;
            this._textures[name] = texture;
            this.renderTarget.textures.push(texture);
        }
        return texture;
    }
    /**
     * Returns the texture holding the data of the previous frame for the given output name.
     */
    getPreviousTexture(name) {
        let texture = this._previousTextures[name];
        if (texture === undefined) {
            // Create a clone of the current texture for previous frame storage
            const currentTexture = this.getTexture(name);
            const image = { width: this.renderTarget.width, height: this.renderTarget.height };
            texture = new Texture(image);
            texture.format = currentTexture.format;
            texture.isRenderTargetTexture = true;
            texture.generateMipmaps = false;
            texture.flipY = false;
            texture.name = name;
            this._previousTextures[name] = texture;
        }
        return texture;
    }
    /**
     * Switches current and previous textures for the given output name.
     */
    toggleTexture(name) {
        const prevTexture = this._previousTextures[name];
        if (prevTexture !== undefined) {
            const texture = this._textures[name];
            // Swap in renderTarget.textures array (only for color textures, not depth)
            if (texture && !(texture instanceof DepthTexture)) {
                const index = this.renderTarget.textures.indexOf(texture);
                if (index !== -1 && !(prevTexture instanceof DepthTexture)) {
                    this.renderTarget.textures[index] = prevTexture;
                }
            }
            this._textures[name] = prevTexture;
            this._previousTextures[name] = texture;
            this._textureNodes[name]?.updateTexture();
            this._previousTextureNodes[name]?.updateTexture();
        }
    }
    /**
     * Returns the texture node for the given output name.
     */
    getTextureNode(name = 'output') {
        let textureNode = this._textureNodes[name];
        if (textureNode === undefined) {
            textureNode = new PassMultipleTextureNode(this, name);
            textureNode.updateTexture();
            this._textureNodes[name] = textureNode;
        }
        return textureNode;
    }
    /**
     * Returns the previous texture node for the given output name.
     */
    getPreviousTextureNode(name = 'output') {
        let textureNode = this._previousTextureNodes[name];
        if (textureNode === undefined) {
            // Ensure current texture node exists first
            if (this._textureNodes[name] === undefined) {
                this.getTextureNode(name);
            }
            textureNode = new PassMultipleTextureNode(this, name, true);
            textureNode.updateTexture();
            this._previousTextureNodes[name] = textureNode;
        }
        return textureNode;
    }
    /**
     * Returns a viewZ node of this pass.
     * Uses cameraNear/cameraFar builtin nodes for correct depth reconstruction.
     */
    getViewZNode(name = 'depth') {
        let viewZNode = this._viewZNodes[name];
        if (viewZNode === undefined) {
            const depthTextureNode = this.getTextureNode(name);
            // Get depth value from texture (TextureNode generates textureSample())
            const depth = depthTextureNode.r;
            // perspectiveDepthToViewZ formula (non-reversed depth buffer):
            // viewZ = near.mul(far).div(far.sub(near).mul(depth).sub(far))
            viewZNode = cameraNear
                .mul(cameraFar)
                .div(cameraFar.sub(cameraNear).mul(depth).sub(cameraFar));
            this._viewZNodes[name] = viewZNode;
        }
        return viewZNode;
    }
    /**
     * Returns a linear depth node of this pass.
     * Uses cameraNear/cameraFar builtin nodes for correct depth reconstruction.
     */
    getLinearDepthNode(name = 'depth') {
        let linearDepthNode = this._linearDepthNodes[name];
        if (linearDepthNode === undefined) {
            const viewZNode = this.getViewZNode(name);
            // viewZToOrthographicDepth formula:
            // linearDepth = viewZ.add(near).div(near.sub(far))
            linearDepthNode = viewZNode
                .add(cameraNear)
                .div(cameraNear.sub(cameraFar));
            this._linearDepthNodes[name] = linearDepthNode;
        }
        return linearDepthNode;
    }
    /**
     * Execute this pass's scene render before the final composite quad.
     */
    updateBefore(frame) {
        const renderer = frame.renderer;
        const encoder = frame.encoder;
        const { scene, camera } = this;
        this._pixelRatio = 1;
        this.setSize(frame.width, frame.height);
        // State save
        const currentRenderTarget = renderer.renderTarget;
        const currentMRT = renderer.mrt;
        const currentClearColor = renderer.clearColor;
        // Update global camera uniforms for depth reconstruction
        cameraNear.value = camera.near;
        cameraFar.value = camera.far;
        // Toggle previous textures for motion vectors / TAA
        for (const name in this._previousTextures) {
            this.toggleTexture(name);
        }
        // Render
        renderer.renderTarget = this.renderTarget;
        renderer.mrt = this._mrt;
        renderer.clearColor = this.clearColor;
        renderer.render(scene, camera, encoder, this.passId);
        // State restore
        renderer.renderTarget = currentRenderTarget;
        renderer.mrt = currentMRT;
        renderer.clearColor = currentClearColor;
        // Update texture resources for sampling
        this._updateTextureResources();
    }
    _updateTextureResources() {
        // Update all texture nodes with current GPU textures
        for (const name in this._textureNodes) {
            this._textureNodes[name].updateTexture();
        }
    }
    /**
     * Frees internal resources. Should be called when the node is no longer in use.
     */
    dispose() {
        this.renderTarget.dispose();
    }
}
/** creates a pass node */
const pass = (scene, camera, options) => {
    return new PassNode(PassNode.COLOR, scene, camera, options);
};

/**
 * ACES filmic tone mapping (Narkowicz 2015).
 * f(x) = clamp((x * (2.51x + 0.03)) / (x * (2.43x + 0.59) + 0.14), 0, 1)
 */
const acesToneMapping = Fn((color) => {
    const c = color.toConst('c');
    const a = c.mul(c.mul(f32(2.51)).add(vec3f(0.03))).toVar('a');
    const b = c.mul(c.mul(f32(2.43)).add(vec3f(0.59))).add(vec3f(0.14)).toVar('b');
    const result = a.div(b).clamp(vec3f(0), vec3f(1)).toVar('result');
    return result;
}, { name: 'acesToneMapping', params: [{ name: 'color', type: vec3f$1 }] });
/**
 * Reinhard tone mapping.
 * f(x) = x / (1 + x)
 */
const reinhardToneMapping = Fn((color) => {
    const result = color.div(vec3f(1).add(color)).toVar('result');
    return result;
}, { name: 'reinhardToneMapping', params: [{ name: 'color', type: vec3f$1 }] });
/**
 * sRGB EOTF (electro-optical transfer function).
 * Converts sRGB gamma-encoded values to linear-sRGB.
 */
const sRGBTransferEOTF = Fn((color) => {
    const a = color.mul(f32(0.9478672986)).add(f32(0.0521327014)).pow(vec3f(2.4)).toVar('a');
    const b = color.mul(f32(0.0773993808)).toVar('b');
    const factor = color.lessThanEqual(vec3f(0.04045)).toVar('factor');
    const result = factor.select(b, a).toVar('result');
    return result;
}, { name: 'sRGBTransferEOTF', params: [{ name: 'color', type: vec3f$1 }] });
/**
 * sRGB OETF (opto-electronic transfer function).
 * Converts linear-sRGB values to sRGB gamma-encoded.
 */
const sRGBTransferOETF = Fn((color) => {
    const a = color.pow(vec3f(0.41666)).mul(f32(1.055)).sub(f32(0.055)).toVar('a');
    const b = color.mul(f32(12.92)).toVar('b');
    const factor = color.lessThanEqual(vec3f(0.0031308)).toVar('factor');
    const result = factor.select(b, a).toVar('result');
    return result;
}, { name: 'sRGBTransferOETF', params: [{ name: 'color', type: vec3f$1 }] });

/**
 * Wrap `inputNode` in tone-mapping and color-space conversion.
 *
 * Returns a `Node<d.vec4f>` suitable for final output:
 * `renderer.render(renderOutput(scenePass.getTextureNode()))`.
 */
function renderOutput(inputNode, options = {}) {
    const toneMapping = options.toneMapping ?? 'aces';
    const colorSpace = options.colorSpace ?? 'srgb';
    const exposure = options.exposure ?? f32(1.0);
    const input = inputNode.toConst('input');
    const rgb = input.xyz.mul(exposure);
    const alpha = input.w;
    const tonemapped = applyToneMapping(rgb, toneMapping);
    const finalRgb = colorSpace === 'srgb' ? sRGBTransferOETF(tonemapped) : tonemapped;
    return vec4f(finalRgb, alpha);
}
function applyToneMapping(rgb, mode) {
    switch (mode) {
        case 'aces': return acesToneMapping(rgb);
        case 'reinhard': return reinhardToneMapping(rgb);
        case 'linear': return rgb;
        case 'none': return rgb;
    }
}

/**
 * Screen coordinate — the current fragment's xy position in pixels.
 * Equivalent to @builtin(position).xy in WGSL.
 *
 * @example
 * // Get pixel position
 * const pixelPos = screenCoordinate;
 */
const screenCoordinate = fragCoord.xy;
/**
 * Screen/viewport size in pixels. Updated per render by the renderer.
 * In renderGroup so it's shared across all objects in a frame.
 *
 * @example
 * // Get screen dimensions
 * const size = screenSize; // vec2f(width, height)
 */
const screenSize = /*@__PURE__*/ new UniformNode(new Uniform(vec2f$1, undefined, renderGroup), 'screenSize').onRenderUpdate(({ width, height }) => [width, height]);
/**
 * Normalized screen UV coordinates in [0, 1] range.
 * Computed as screenCoordinate / screenSize.
 *
 * (0, 0) is top-left, (1, 1) is bottom-right (following WebGPU conventions).
 *
 * @example
 * // Sample a texture using screen UV
 * const color = texture.sample(screenUV);
 *
 * // Use x component for horizontal effects
 * const x = screenUV.x;
 */
const screenUV = /*@__PURE__*/ (() => {
    return div(screenCoordinate, screenSize);
})();

const EDGE_STEP_COUNT = 6;
const EDGE_GUESS = 8.0;
const CONTRAST_THRESHOLD = 0.0312;
const RELATIVE_THRESHOLD = 0.063;
const SUBPIXEL_BLENDING = 1.0;
/**
 * FXAA (Fast Approximate Anti-Aliasing) post-processing effect.
 *
 * This implementation ports the Three.js TSL FXAANode to gpucat's functional DSL.
 * It uses the standard FXAA 3.11 algorithm:
 * 1. Samples luminance of neighboring pixels
 * 2. Detects edges based on contrast
 * 3. Blends pixels along detected edges to smooth jaggies
 *
 * The inverse texture size uniform is automatically updated each frame.
 *
 * @param textureNode - The texture to apply FXAA to (typically from pass.getTextureNode())
 * @returns A vec4f node containing the anti-aliased color
 *
 * @example
 * const scenePass = pass(scene, camera);
 * const fxaaOutput = fxaa(scenePass.getTextureNode());
 *
 * const postMaterial = new Material({
 *     vertex: fullscreenQuadVertex,
 *     fragment: fxaaOutput,
 * });
 */
function fxaa(textureNode) {
    // Uniform for inverse texture size, auto-updated each frame
    const invSize = uniform(vec2(0, 0), 'fxaaInvSize');
    // Lifecycle node to update invSize before rendering
    const invSizeUpdater = node().onFrameUpdate(() => {
        const tex = textureNode.bindingNode.value;
        if (tex) {
            invSize.value = [1 / tex.width, 1 / tex.height];
        }
    });
    // Edge steps array for the edge search loop
    const EDGE_STEPS = array([f32(1.0), f32(1.5), f32(2.0), f32(2.0), f32(2.0), f32(4.0)]);
    // ── Helper Functions ──────────────────────────────────────────────────────
    // Sample texture at explicit UV with level(0) to force base mip level
    // We chain .sample(uv).level() to avoid holding a TextureNode with the
    // default uvNode (which would pull in varying(uv()) as a dependency)
    const Sample = Fn((uv) => {
        return textureNode.sample(uv).level(f32(0));
    }, { name: 'FxaaSample', params: [{ name: 'uv', type: vec2f$1 }] });
    const SampleLuminance = Fn((uv) => {
        return Sample(uv).rgb.dot(vec3(0.3, 0.59, 0.11));
    }, { name: 'FxaaSampleLuminance', params: [{ name: 'uv', type: vec2f$1 }] });
    const SampleLuminanceOffset = Fn((texSize, uv, uOffset, vOffset) => {
        const shiftedUv = uv.add(texSize.mul(vec2(uOffset, vOffset)));
        return SampleLuminance(shiftedUv);
    }, {
        name: 'FxaaSampleLuminanceOffset',
        params: [
            { name: 'texSize', type: vec2f$1 },
            { name: 'uv', type: vec2f$1 },
            { name: 'uOffset', type: f32$1 },
            { name: 'vOffset', type: f32$1 },
        ]
    });
    // ── Main FXAA Function ────────────────────────────────────────────────────
    const ApplyFXAA = Fn((uv, texSize) => {
        // Sample luminance neighborhood
        const m = SampleLuminance(uv);
        const n = SampleLuminanceOffset(texSize, uv, f32(0.0), f32(-1.0));
        const e = SampleLuminanceOffset(texSize, uv, f32(1.0), f32(0.0));
        const s = SampleLuminanceOffset(texSize, uv, f32(0.0), f32(1.0));
        const w = SampleLuminanceOffset(texSize, uv, f32(-1.0), f32(0.0));
        const ne = SampleLuminanceOffset(texSize, uv, f32(1.0), f32(-1.0));
        const nw = SampleLuminanceOffset(texSize, uv, f32(-1.0), f32(-1.0));
        const se = SampleLuminanceOffset(texSize, uv, f32(1.0), f32(1.0));
        const sw = SampleLuminanceOffset(texSize, uv, f32(-1.0), f32(1.0));
        const highest = max(s, e, n, w, m);
        const lowest = min(s, e, n, w, m);
        const contrast = highest.sub(lowest).toVar('contrast');
        // Should skip pixel? (low contrast = no edge)
        const threshold = max(f32(CONTRAST_THRESHOLD), f32(RELATIVE_THRESHOLD).mul(highest));
        If(contrast.lessThan(threshold), () => {
            Return(Sample(uv));
        });
        // Determine pixel blend factor (subpixel anti-aliasing)
        const filterSum = f32(2.0).mul(s.add(e).add(n).add(w))
            .add(se.add(sw).add(ne).add(nw))
            .mul(f32(1.0 / 12.0));
        const filterDiff = abs(filterSum.sub(m));
        const filterClamped = clamp(filterDiff.div(max(contrast, f32(0.0001))), f32(0.0), f32(1.0));
        const pixelBlendFactor = smoothstep(f32(0.0), f32(1.0), filterClamped).toVar('pixelBlendFactor');
        const pixelBlend = pixelBlendFactor.mul(pixelBlendFactor).mul(f32(SUBPIXEL_BLENDING)).toVar('pixelBlend');
        // Determine edge direction (horizontal vs vertical)
        const horizontal = abs(s.add(n).sub(m.mul(f32(2.0)))).mul(f32(2.0))
            .add(abs(se.add(ne).sub(e.mul(f32(2.0)))))
            .add(abs(sw.add(nw).sub(w.mul(f32(2.0)))));
        const vertical = abs(e.add(w).sub(m.mul(f32(2.0)))).mul(f32(2.0))
            .add(abs(se.add(sw).sub(s.mul(f32(2.0)))))
            .add(abs(ne.add(nw).sub(n.mul(f32(2.0)))));
        const isHorizontal = horizontal.greaterThanEqual(vertical);
        const pLuminance = isHorizontal.select(s, e);
        const nLuminance = isHorizontal.select(n, w);
        const pGradient = abs(pLuminance.sub(m));
        const nGradient = abs(nLuminance.sub(m));
        const pixelStep = isHorizontal.select(texSize.y, texSize.x).toVar('pixelStep');
        const oppositeLuminance = f32(0).toVar('oppositeLum');
        const gradient = f32(0).toVar('gradient');
        If(pGradient.lessThan(nGradient), () => {
            pixelStep.assign(pixelStep.negate());
            oppositeLuminance.assign(nLuminance);
            gradient.assign(nGradient);
        }).Else(() => {
            oppositeLuminance.assign(pLuminance);
            gradient.assign(pGradient);
        });
        // Determine edge blend factor (edge-aware anti-aliasing)
        const uvEdge = uv.toVar('uvEdge');
        const edgeStep = vec2(0, 0).toVar('edgeStep');
        If(isHorizontal, () => {
            uvEdge.y.addAssign(pixelStep.mul(f32(0.5)));
            edgeStep.assign(vec2(texSize.x, f32(0.0)));
        }).Else(() => {
            uvEdge.x.addAssign(pixelStep.mul(f32(0.5)));
            edgeStep.assign(vec2(f32(0.0), texSize.y));
        });
        const edgeLuminance = m.add(oppositeLuminance).mul(f32(0.5));
        const gradientThreshold = gradient.mul(f32(0.25));
        // Search in positive direction
        const puv = uvEdge.add(edgeStep.mul(EDGE_STEPS.element(f32(0).toU32()))).toVar('puv');
        const pLuminanceDelta = SampleLuminance(puv).sub(edgeLuminance).toVar('pLumDelta');
        const pAtEnd = abs(pLuminanceDelta).greaterThanEqual(gradientThreshold).toVar('pAtEnd');
        Loop({ start: 1, end: EDGE_STEP_COUNT }, ({ i }) => {
            If(pAtEnd, () => {
                Break();
            });
            puv.addAssign(edgeStep.mul(EDGE_STEPS.element(i)));
            pLuminanceDelta.assign(SampleLuminance(puv).sub(edgeLuminance));
            pAtEnd.assign(abs(pLuminanceDelta).greaterThanEqual(gradientThreshold));
        });
        If(pAtEnd.not(), () => {
            puv.addAssign(edgeStep.mul(f32(EDGE_GUESS)));
        });
        // Search in negative direction
        const nuv = uvEdge.sub(edgeStep.mul(EDGE_STEPS.element(f32(0).toU32()))).toVar('nuv');
        const nLuminanceDelta = SampleLuminance(nuv).sub(edgeLuminance).toVar('nLumDelta');
        const nAtEnd = abs(nLuminanceDelta).greaterThanEqual(gradientThreshold).toVar('nAtEnd');
        Loop({ start: 1, end: EDGE_STEP_COUNT }, ({ i }) => {
            If(nAtEnd, () => {
                Break();
            });
            nuv.subAssign(edgeStep.mul(EDGE_STEPS.element(i)));
            nLuminanceDelta.assign(SampleLuminance(nuv).sub(edgeLuminance));
            nAtEnd.assign(abs(nLuminanceDelta).greaterThanEqual(gradientThreshold));
        });
        If(nAtEnd.not(), () => {
            nuv.subAssign(edgeStep.mul(f32(EDGE_GUESS)));
        });
        // Calculate distances
        const pDistance = f32(0).toVar('pDist');
        const nDistance = f32(0).toVar('nDist');
        If(isHorizontal, () => {
            pDistance.assign(puv.x.sub(uv.x));
            nDistance.assign(uv.x.sub(nuv.x));
        }).Else(() => {
            pDistance.assign(puv.y.sub(uv.y));
            nDistance.assign(uv.y.sub(nuv.y));
        });
        const shortestDistance = f32(0).toVar('shortestDist');
        const deltaSign = bool(false).toVar('deltaSign');
        If(pDistance.lessThanEqual(nDistance), () => {
            shortestDistance.assign(pDistance);
            deltaSign.assign(pLuminanceDelta.greaterThanEqual(f32(0.0)));
        }).Else(() => {
            shortestDistance.assign(nDistance);
            deltaSign.assign(nLuminanceDelta.greaterThanEqual(f32(0.0)));
        });
        // Calculate edge blend factor
        const edgeBlend = f32(0).toVar('edgeBlend');
        const mDeltaSign = m.sub(edgeLuminance).greaterThanEqual(f32(0.0));
        If(deltaSign.equal(mDeltaSign), () => {
            edgeBlend.assign(f32(0.0));
        }).Else(() => {
            edgeBlend.assign(f32(0.5).sub(shortestDistance.div(pDistance.add(nDistance))));
        });
        // Final blend
        const finalBlend = max(pixelBlend, edgeBlend).toVar('finalBlend');
        const finalUv = uv.toVar('finalUv');
        If(isHorizontal, () => {
            finalUv.y.addAssign(pixelStep.mul(finalBlend));
        }).Else(() => {
            finalUv.x.addAssign(pixelStep.mul(finalBlend));
        });
        return Sample(finalUv);
    }, {
        name: 'ApplyFXAA',
        params: [
            { name: 'uv', type: vec2f$1 },
            { name: 'texSize', type: vec2f$1 },
        ]
    });
    // Return result with lifecycle updater attached
    return ApplyFXAA(screenUV, invSize).before(invSizeUpdater);
}

/**
 * Basic struct descriptor for a non-indexed indirect draw call (`drawIndirect`) with no additional fields.
 * Memory layout (4 × u32, 16 bytes):
 *   vertexCount, instanceCount, firstVertex, firstInstance
 */
const DrawIndirect = struct('DrawIndirect', {
    vertexCount: u32$1,
    instanceCount: u32$1,
    firstVertex: u32$1,
    firstInstance: u32$1,
});
/**
 * Basic struct descriptor for an indexed indirect draw call (`drawIndexedIndirect`) with no additional fields.
 * Memory layout (5 × u32, 20 bytes):
 *   indexCount, instanceCount, firstIndex, baseVertex, firstInstance
 */
const DrawIndexedIndirect = struct('DrawIndexedIndirect', {
    indexCount: u32$1,
    instanceCount: u32$1,
    firstIndex: u32$1,
    baseVertex: u32$1,
    firstInstance: u32$1,
});

/** Model-to-world transform matrix. */
const modelWorldMatrix = /*@__PURE__*/ new UniformNode(new Uniform(mat4x4f$1, undefined, objectGroup), 'modelWorldMatrix').onObjectUpdate((frame) => frame.object.matrixWorld);
/** Normal matrix (inverse-transpose of upper-left 3x3 of model matrix). In objectGroup. */
const modelNormalMatrix = /*@__PURE__*/ new UniformNode(new Uniform(mat3x3f$1, undefined, objectGroup), 'modelNormalMatrix').onObjectUpdate((frame) => frame.object.normalMatrix);
/** helper for vertex shader: compute clip-space position from vertex position attribute and camera matrices. */
const positionClip = (() => {
    const pos = attribute('position', vec3f$1);
    const localPos = vec4f(pos, f32(1.0));
    const worldPos = mul(modelWorldMatrix, localPos);
    const viewPos = mul(cameraViewMatrix, worldPos);
    const clipPos = mul(cameraProjectionMatrix, viewPos);
    return clipPos;
})();

/**
 * Represents a fragment shader output struct with multiple @location outputs.
 * Used for MRT (Multiple Render Targets).
 *
 * Each member in the `members` array corresponds to a @location(N) output.
 * The index in the array determines the @location index.
 *
 * @example
 * // Direct usage (rare):
 * const outputs = new OutputStructNode([colorNode, normalNode, velocityNode]);
 *
 * // Typically created via mrt() helper instead.
 */
class OutputStructNode extends Node {
    /**
     * Array of output nodes. Each node maps to @location(index).
     * All nodes should produce vec4f values.
     */
    members;
    /** Type flag for runtime checking. */
    isOutputStructNode = true;
    constructor(members = []) {
        super(vec4f$1);
        this.members = members;
    }
}
class MRTNode extends OutputStructNode {
    /**
     * Dictionary of named outputs. Keys are texture names,
     * values are nodes producing vec4f values.
     */
    outputNodes;
    /** Type flag for runtime checking. */
    isMRTNode = true;
    /**
     * Resolved output names in order. Populated during setup() when
     * render target is known. Used by the compiler to emit correct
     * @location indices.
     */
    _resolvedNames = [];
    constructor(outputNodes) {
        super([]);
        this.outputNodes = outputNodes;
    }
    /**
     * Returns true if this MRT node has an output with the given name.
     */
    has(name) {
        return this.outputNodes[name] !== undefined;
    }
    /**
     * Returns the output node for the given name.
     */
    get(name) {
        return this.outputNodes[name];
    }
    /**
     * Merge another MRTNode's outputs into this one.
     * Returns a new MRTNode with combined outputs (other's outputs override this's).
     */
    merge(other) {
        return new MRTNode({ ...this.outputNodes, ...other.outputNodes });
    }
    /**
     * Resolve output names to @location indices based on render target textures.
     * Called by the compiler when the render target is known.
     *
     * @param getTextureIndex - Function that maps texture name to index (from RenderTarget)
     */
    resolveOutputs(getTextureIndex) {
        const members = [];
        const names = [];
        for (const name in this.outputNodes) {
            const index = getTextureIndex(name);
            if (index === -1) {
                console.warn(`[MRTNode] Output '${name}' not found in render target textures. Skipping.`);
                continue;
            }
            // Ensure the node outputs vec4f (wrap if needed)
            let node = this.outputNodes[name];
            if (node.type.wgslType !== 'vec4f') {
                node = vec4f(node, new LiteralNode(f32$1, 1));
            }
            members[index] = node;
            names[index] = name;
        }
        this.members = members;
        this._resolvedNames = names;
    }
}
/**
 * Create an MRT (Multiple Render Targets) node from a dictionary of outputs.
 *
 * Output names must match the `.name` property of textures in the render target.
 * The compiler maps each output to the corresponding @location(N) based on
 * texture array indices.
 *
 * @example
 * const mrtOutput = mrt({
 *     color: finalColor,
 *     normal: viewSpaceNormal,
 *     velocity: motionVector,
 * });
 *
 * const material = new Material({
 *     vertex: clipPosition,
 *     fragment: mrtOutput,
 * });
 */
function mrt(outputNodes) {
    return new MRTNode(outputNodes);
}

/**
 * StorageNode — declares a storage buffer binding in a shader.
 *
 * Two forms:
 * 1. **Named reference**: Resolved from `geometry.buffers` at render time
 * 2. **Value reference**: Buffer provided directly, can be swapped via `.value`
 *
 * Both are first-class features for different use cases:
 * - Named references enable buffer reuse across materials (same shader, different buffers per mesh)
 * - Value references enable compute-only workloads (no geometry) and explicit buffer swapping
 *
 * @example Named reference (resolved from geometry.buffers)
 * const particles = storage('particles', d.array(Particle), 'read_write');
 * // Later: geometry.setBuffer('particles', myParticleBuffer);
 *
 * @example Value reference (buffer provided directly, swappable)
 * const particles = storage(myBuffer, 'read_write');
 * particles.value = otherBuffer;  // swap buffers for double-buffering
 */
class StorageNode extends Node {
    /** Buffer name (for geometry.buffers lookup) — null if value-based */
    bufferName;
    /** Direct buffer reference — null if name-based */
    _value;
    /** The WGSL type string, e.g. 'array<mat4x4f>'. Emitted verbatim. */
    storageType;
    /** Access mode for the storage buffer. */
    access;
    /** Whether the node is atomic or not. */
    isAtomic = false;
    /** Uniform group — determines @group index. Defaults to objectGroup. */
    groupNode;
    constructor(schema, nameOrBuffer, access = 'read', groupNode = objectGroup) {
        super(schema);
        if (typeof nameOrBuffer === 'string') {
            this.bufferName = nameOrBuffer;
            this._value = null;
        }
        else {
            this.bufferName = null;
            this._value = nameOrBuffer;
        }
        this.storageType = schema.wgslType;
        this.access = access;
        this.groupNode = groupNode;
    }
    /** Whether this is a named reference (resolved from geometry.buffers) */
    get isNamedReference() {
        return this.bufferName !== null;
    }
    /** Whether this is an indirect storage buffer (has 'indirect' usage) */
    get isIndirectStorageBuffer() {
        return this._value?.usage.has('indirect') ?? false;
    }
    /** Get the current buffer value (for value-based nodes). Returns null for name-based nodes. */
    get value() {
        return this._value;
    }
    /** Set a new buffer value (for value-based nodes). Allows swapping buffers for double-buffering. */
    set value(buffer) {
        if (this.bufferName !== null) {
            throw new Error('[gpucat] Cannot set .value on a name-based storage node. Use geometry.setBuffer() instead.');
        }
        this._value = buffer;
    }
    /** Defines whether the node is atomic or not */
    setAtomic(value) {
        this.isAtomic = value;
        return this;
    }
    /** Convenience method for making this node atomic */
    toAtomic() {
        return this.setAtomic(true);
    }
    /** Convenience method for configuring read-only access */
    toReadOnly() {
        if (this.access === 'read')
            return this;
        if (this.bufferName !== null) {
            return new StorageNode(this.type, this.bufferName, 'read', this.groupNode);
        }
        else {
            return new StorageNode(this.type, this._value, 'read', this.groupNode);
        }
    }
}
function storage(nameOrBuffer, schemaOrAccess, accessArg) {
    if (typeof nameOrBuffer === 'string') {
        // Name-based: storage(name, schema, access?)
        const schema = schemaOrAccess;
        const access = accessArg ?? 'read';
        return new StorageNode(schema, nameOrBuffer, access, objectGroup);
    }
    else {
        // Value-based: storage(buffer, access?)
        const buffer = nameOrBuffer;
        const access = schemaOrAccess ?? 'read';
        return new StorageNode(buffer.schema, buffer, access, objectGroup);
    }
}

/** Elapsed time in seconds. In renderGroup. */
const timeElapsed = /*@__PURE__*/ new UniformNode(new Uniform(f32$1, undefined, renderGroup), 'timeElapsed').onRenderUpdate((frame) => frame.time);
/** Frame delta time in seconds. In renderGroup. */
const timeDelta = /*@__PURE__*/ new UniformNode(new Uniform(f32$1, undefined, renderGroup), 'timeDelta').onRenderUpdate((frame) => frame.deltaTime);

/**
 * Inline WGSL expression node.
 *
 * Used for embedding raw WGSL expressions with node dependencies.
 * The wgsl string uses $0, $1, etc. as placeholders for deps.
 *
 * @example
 * const expr = new WgslNode(d.f32, 'dot($0, $1)', [a, b]);
 * // generates: dot(a_expr, b_expr)
 */
class WgslNode extends Node {
    wgsl;
    deps;
    constructor(type, wgsl, deps) {
        super(type);
        this.wgsl = wgsl;
        this.deps = deps;
    }
    /**
     * Returns a new WgslNode with additional unreferenced deps appended.
     * Useful for pulling nodes into the graph (e.g. varyings) without
     * emitting them in the WGSL expression string.
     */
    with(...extra) {
        return new WgslNode(this.type, this.wgsl, [...this.deps, ...extra]);
    }
}
/**
 * Create an inline WGSL expression node using a tagged template literal.
 *
 * @param desc - A WgslDesc descriptor specifying the result type
 *
 * @example
 * // With WgslDesc:
 * const expr = wgsl(d.f32)`dot(${a}, ${b})`;
 * const rgbaNode = wgsl(d.vec4f)`vec4f(${rgb}, 1.0)`;
 *
 * // Preserving input type:
 * const sinNode = <D extends d.WgslDesc>(a: Node<D>) => wgsl(a.type)`sin(${a})`;
 */
function wgsl(desc) {
    return (strings, ...deps) => {
        const wgslStr = String.raw({ raw: strings }, ...deps.map((_, i) => `$${i}`));
        return new WgslNode(desc, wgslStr, deps);
    };
}

/**
 * Parse WGSL function source into a NodeFunction.
 */
function parseWgslFunction(source) {
    source = source.trim();
    const declarationRegexp = /^[fn]*\s*([a-z_0-9]+)?\s*\(([\s\S]*?)\)\s*[-]*[>]*\s*([a-z_0-9]+(?:<[\s\S]+?>)?)?/i;
    const propertiesRegexp = /([a-z_0-9]+)\s*:\s*([a-z_0-9]+(?:<[\s\S]+?>)?)/ig;
    const declaration = source.match(declarationRegexp);
    if (declaration === null || declaration.length < 2) {
        throw new Error(`[gpucat] FunctionNode: Could not parse WGSL function.\n${source.slice(0, 100)}...`);
    }
    const inputsCode = declaration[2] || '';
    const propsMatches = [];
    let match = null;
    while ((match = propertiesRegexp.exec(inputsCode)) !== null) {
        propsMatches.push({ name: match[1], type: match[2] });
    }
    const inputs = [];
    for (const { name, type } of propsMatches) {
        let resolvedType = type;
        let pointer = false;
        if (resolvedType.startsWith('ptr')) {
            resolvedType = 'pointer';
            pointer = true;
        }
        inputs.push({ name, type: resolvedType, pointer });
    }
    // find where function body starts (after the signature)
    const bodyStart = source.indexOf('{');
    const blockCode = bodyStart >= 0 ? source.substring(bodyStart) : '{}';
    const outputType = declaration[3] || 'void';
    const name = declaration[1] !== undefined ? declaration[1] : '';
    const type = outputType; // keep WGSL type as-is
    return {
        type,
        inputs,
        name,
        inputsCode,
        blockCode,
        outputType,
        getCode(fnName = name) {
            const outputPart = outputType !== 'void' ? `-> ${outputType}` : '';
            return `fn ${fnName}(${inputsCode.trim()}) ${outputPart}${blockCode}`;
        },
    };
}
class WgslFunctionNode extends Node {
    /** Type marker for runtime checking */
    isCodeNode = true;
    /** Global nodes use globalCache for deduplication */
    global = true;
    /** The native shader code */
    code;
    /** Array of included CodeNodes/FunctionNodes */
    includes;
    /** Type marker for runtime checking */
    isFunctionNode = true;
    constructor(code = '', includes = []) {
        super(wgslfn);
        this.code = code;
        this.includes = includes;
    }
    setIncludes(includes) {
        this.includes = includes;
        return this;
    }
    getIncludes() {
        return this.includes;
    }
    /**
     * Get the node function (parsed WGSL) for this function node.
     */
    getNodeFunction() {
        return parseWgslFunction(this.code);
    }
    /**
     * Returns the inputs (parameters) of this function.
     */
    getInputs() {
        return this.getNodeFunction().inputs;
    }
    /**
     * Create a CallNode that calls this function.
     * @param args - Arguments to pass (positional or named object)
     */
    call(...args) {
        const nodeFunc = this.getNodeFunction();
        const fnName = nodeFunc.name;
        const returnType = descFromWgslType(nodeFunc.outputType);
        return new CallNode(returnType, fnName, args, undefined, this);
    }
}
// Implementation
function wgslFn(source, layoutOrIncludes, includesArg) {
    // Determine layout and includes from arguments
    let layout;
    let includes = [];
    if (layoutOrIncludes) {
        if (Array.isArray(layoutOrIncludes)) {
            // Legacy: wgslFn(source, includes)
            includes = layoutOrIncludes;
        }
        else if ('output' in layoutOrIncludes) {
            // New: wgslFn(source, layout, includes?)
            layout = layoutOrIncludes;
            includes = includesArg ?? [];
        }
    }
    // Extract FunctionNode from callable includes
    const includeNodes = [];
    for (let i = 0; i < includes.length; i++) {
        const include = includes[i];
        // If it's a callable from wgslFn, extract the functionNode
        if (typeof include === 'function') {
            const fn = include.functionNode;
            if (fn) {
                includeNodes.push(fn);
            }
        }
        else if (include instanceof WgslFunctionNode) {
            includeNodes.push(include);
        }
    }
    const functionNode = new WgslFunctionNode(source.trim(), includeNodes);
    const nodeFunc = functionNode.getNodeFunction();
    const fnName = nodeFunc.name;
    // Use layout output type if provided, otherwise parse from WGSL
    const returnType = layout?.output ?? descFromWgslType(nodeFunc.outputType);
    // Return a callable that creates CallNodes
    const fn = (...args) => {
        return new CallNode(returnType, fnName, args, undefined, functionNode);
    };
    // Attach functionNode for include resolution
    fn.functionNode = functionNode;
    return fn;
}

let bindGroupIdCounter = 0;
/** Create a BindGroup from uniform group block */
function createUniformBindGroup(block) {
    const binding = {
        kind: 'uniform',
        block,
        bufferKey: null,
        lastFrameId: -1,
        lastRenderId: -1,
        currentBuffer: null,
        scratchBuffer: null,
    };
    return {
        id: bindGroupIdCounter++,
        name: block.groupName,
        groupIndex: block.groupIndex,
        shared: block.shared,
        bindings: [binding],
        isBindGroup: true,
    };
}
/** Create a BindGroup for storage/texture/sampler bindings in a group */
function createResourceBindGroup(name, groupIndex, shared, storage, textures, samplers) {
    const bindings = [];
    for (const entry of storage) {
        bindings.push({ kind: 'storage', entry, lastBuffer: null });
    }
    for (const entry of textures) {
        bindings.push({ kind: 'texture', entry, generation: 0, lastGpuTexture: null });
    }
    for (const entry of samplers) {
        bindings.push({ kind: 'sampler', entry, samplerKey: null });
    }
    return {
        id: bindGroupIdCounter++,
        name,
        groupIndex,
        shared,
        bindings,
        isBindGroup: true,
    };
}
/**
 * Clone a BindGroup (deep clone of bindings).
 * Used for non-shared groups that need per-RenderObject instances.
 */
function cloneBindGroup(source) {
    const clonedBindings = source.bindings.map((binding) => {
        switch (binding.kind) {
            case 'uniform':
                return {
                    kind: 'uniform',
                    block: binding.block,
                    bufferKey: null, // New buffer key for cloned group
                    lastFrameId: -1,
                    lastRenderId: -1,
                    currentBuffer: null,
                    scratchBuffer: null,
                };
            case 'storage':
                return {
                    kind: 'storage',
                    entry: binding.entry,
                    lastBuffer: null,
                };
            case 'texture':
                return {
                    kind: 'texture',
                    entry: binding.entry,
                    generation: 0,
                    lastGpuTexture: null,
                };
            case 'sampler':
                return {
                    kind: 'sampler',
                    entry: binding.entry,
                    samplerKey: null,
                };
        }
    });
    return {
        id: bindGroupIdCounter++,
        name: source.name,
        groupIndex: source.groupIndex,
        shared: source.shared,
        bindings: clonedBindings,
        isBindGroup: true,
    };
}

/**
 * Global cache for shared BindGroups (Three.js pattern: _bindingGroupsCache).
 *
 * Structure: WeakMap<BindingContext, Map<cacheKey, BindGroup>>
 *
 * - Outer WeakMap is keyed by context (RenderContext or ComputeContext), allowing GC when context is disposed
 * - Inner Map is keyed by a hash of uniform node IDs in the shared group
 * - All compilations using the same shared uniforms get the same BindGroup instance
 *
 * This ensures currentSets comparison works correctly - shared groups have the same `id`.
 */
const _bindingGroupsCache = new WeakMap();
/**
 * Simple string hash function (matches Three.js hashString pattern).
 */
function hashString$1(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0; // Convert to 32bit integer
    }
    return hash.toString(36);
}
/**
 * Create a NodeBuilderState from a render CompileResult.
 *
 * This builds the template BindGroups from the compile result.
 * Template groups are later cloned (non-shared) or reused (shared) via createBindings().
 *
 * @param compileResult - The compiler output
 * @param cacheKey - Pipeline cache key
 * @param context - The binding context (RenderContext) for shared bind group caching
 */
function createNodeBuilderState(compileResult, cacheKey, context) {
    // build template BindGroups from compile result
    const bindings = buildTemplateBindGroups(compileResult.uniformGroups, compileResult.storage, compileResult.textures, compileResult.samplers, context);
    return {
        // Render shaders: combined vertex+fragment in single module
        vertexCode: compileResult.code,
        fragmentCode: null, // Same module, different entry point
        // No compute
        computeCode: null,
        workgroupSize: null,
        // Bindings
        attributes: compileResult.attributes,
        vertexBufferGroups: compileResult.vertexBufferGroups,
        uniformGroups: compileResult.uniformGroups,
        storage: compileResult.storage,
        textures: compileResult.textures,
        samplers: compileResult.samplers,
        varyings: compileResult.varyings,
        builtinsUsed: compileResult.builtinsUsed,
        bindings,
        updateBeforeNodes: compileResult.updateBeforeNodes,
        updateAfterNodes: compileResult.updateAfterNodes,
        updateNodes: compileResult.updateNodes,
        cacheKey,
        isNodeBuilderState: true,
    };
}
/**
 * Create a NodeBuilderState from a compute CompileResult.
 *
 * @param compileResult - The compute compiler output
 * @param context - The binding context (ComputeContext) for shared bind group caching
 */
function createNodeBuilderStateForCompute(compileResult, context) {
    // build template BindGroups from compile result
    const bindings = buildTemplateBindGroups(compileResult.uniformGroups, compileResult.storage, [], // no textures for compute (for now)
    [], // no samplers for compute (for now)
    context);
    return {
        // No render shaders
        vertexCode: null,
        fragmentCode: null,
        // Compute shader
        computeCode: compileResult.code,
        workgroupSize: compileResult.workgroupSize,
        // Bindings
        attributes: [], // no vertex attributes for compute
        vertexBufferGroups: [], // no vertex buffer groups for compute
        uniformGroups: compileResult.uniformGroups,
        storage: compileResult.storage,
        textures: [], // no textures for compute (for now)
        samplers: [], // no samplers for compute (for now)
        varyings: [], // no varyings for compute
        builtinsUsed: compileResult.builtinsUsed,
        bindings,
        updateBeforeNodes: [], // compute doesn't have these yet
        updateAfterNodes: [],
        updateNodes: [],
        cacheKey: '', // no cache key for compute pipelines
        isNodeBuilderState: true,
    };
}
/**
 * Build template BindGroups from compile result.
 *
 * Creates one BindGroup per @group(N) index. Each group contains:
 * - Uniform buffer (if present)
 * - Storage buffers (if present)
 * - Textures (if present)
 * - Samplers (if present)
 *
 * The `shared` flag is taken from the uniform group (if present),
 * otherwise defaults to false (per-object).
 *
 * For shared uniform-only groups, uses _bindingGroupsCache to return the same
 * BindGroup instance across all compilations (Three.js pattern).
 */
function buildTemplateBindGroups(uniformGroups, storage, textures, samplers, context) {
    // Get or create the cache for this context
    let contextCache = _bindingGroupsCache.get(context);
    if (contextCache === undefined) {
        contextCache = new Map();
        _bindingGroupsCache.set(context, contextCache);
    }
    // collect all group indices
    const groupIndices = new Set();
    for (const ug of uniformGroups) {
        if (ug.members.length > 0)
            groupIndices.add(ug.groupIndex);
    }
    for (const s of storage)
        groupIndices.add(s.group);
    for (const t of textures)
        groupIndices.add(t.group);
    for (const s of samplers)
        groupIndices.add(s.group);
    // build BindGroup for each index
    const bindGroups = [];
    const sortedIndices = [...groupIndices].sort((a, b) => a - b);
    for (const groupIdx of sortedIndices) {
        // find uniform group for this index
        const uniformGroup = uniformGroups.find((g) => g.groupIndex === groupIdx && g.members.length > 0);
        // collect resources for this group
        const groupStorage = storage.filter((s) => s.group === groupIdx);
        const groupTextures = textures.filter((t) => t.group === groupIdx);
        const groupSamplers = samplers.filter((s) => s.group === groupIdx);
        // determine shared flag (from uniform group if present, otherwise false)
        const shared = uniformGroup?.shared ?? false;
        if (uniformGroup && groupStorage.length === 0 && groupTextures.length === 0 && groupSamplers.length === 0) {
            // uniform-only group
            if (shared) {
                // Shared group: use cache (Three.js pattern)
                // Build cache key from sorted uniform node IDs
                const members = [...uniformGroup.members].sort((a, b) => a.node.id - b.node.id);
                const cacheKeyString = members.map(m => m.node.id).join(',');
                const cacheKey = hashString$1(cacheKeyString);
                let bindGroup = contextCache.get(cacheKey);
                if (bindGroup === undefined) {
                    bindGroup = createUniformBindGroup(uniformGroup);
                    contextCache.set(cacheKey, bindGroup);
                }
                bindGroups.push(bindGroup);
            }
            else {
                // Non-shared: always create new
                bindGroups.push(createUniformBindGroup(uniformGroup));
            }
        }
        else if (uniformGroup) {
            // mixed group: uniform + other resources
            // create a combined bind group (not cached - has textures/storage which vary)
            const bindGroup = createUniformBindGroup(uniformGroup);
            // add storage/texture/sampler bindings
            for (const s of groupStorage) {
                bindGroup.bindings.push({ kind: 'storage', entry: s, lastBuffer: null });
            }
            for (const t of groupTextures) {
                bindGroup.bindings.push({ kind: 'texture', entry: t, generation: 0, lastGpuTexture: null });
            }
            for (const s of groupSamplers) {
                bindGroup.bindings.push({ kind: 'sampler', entry: s, samplerKey: null });
            }
            bindGroups.push(bindGroup);
        }
        else {
            // resource-only group (no uniform)
            bindGroups.push(createResourceBindGroup(`group${groupIdx}`, groupIdx, shared, groupStorage, groupTextures, groupSamplers));
        }
    }
    return bindGroups;
}
/**
 * Create bindings for a RenderObject from a NodeBuilderState.
 *
 * Shared groups are reused directly (same BindGroup instance)
 * Non-shared groups are cloned (new BindGroup instance per RenderObject)
 *
 * This is the key to efficient uniform buffer sharing - camera/time buffers
 * are shared across all RenderObjects, while object uniforms get their own.
 *
 * @param state the NodeBuilderState (template)
 * @returns array of BindGroups for this RenderObject
 */
function createBindings(state) {
    const bindings = [];
    for (const templateGroup of state.bindings) {
        if (templateGroup.shared) {
            // shared: reuse the same BindGroup instance
            bindings.push(templateGroup);
        }
        else {
            // non-shared: clone the BindGroup
            bindings.push(cloneBindGroup(templateGroup));
        }
    }
    return bindings;
}

/**
 * render-object.ts - Per-draw-call state container.
 *
 * Aligned with Three.js RenderObject:
 * - Central hub owning all per-draw-call state
 * - One RenderObject per unique (mesh, material, renderContext, passId) tuple
 * - Caches nodeBuilderState, pipeline, bindings, attributes
 * - Lazily initialized - starts empty, populated on first render
 *
 * Key Three.js pattern:
 * - _bindings is lazily created via getBindings()
 * - getBindings() calls NodeBuilderState.createBindings() which clones non-shared groups
 * - This ensures shared groups (camera, time) are reused across all RenderObjects
 *
 * Unlike Three.js, we use a plain object type with factory function
 * rather than a class.
 */
let renderObjectIdCounter = 0;
/**
 * Create a new RenderObject.
 *
 * @param mesh - The mesh to render
 * @param material - The material to use
 * @param scene - The scene/object containing the mesh
 * @param camera - The camera for rendering
 */
function createRenderObject(mesh, material, scene, camera, renderContext) {
    return {
        id: renderObjectIdCounter++,
        // Source references
        mesh,
        material,
        geometry: mesh.geometry,
        camera,
        scene,
        renderContext,
        passId: '',
        // Compiled state (lazy)
        nodeBuilderState: null,
        pipeline: null,
        bindGroups: null,
        _bindings: null,
        // Attribute state (lazy)
        vertexBuffers: null,
        indexBuffer: null,
        // Cache keys
        initialCacheKey: '',
        version: 0,
        materialVersion: 0,
        geometryVersion: 0,
        // Pipeline key cache
        _cachedPipelineKey: null,
        _pipelineKeyVersion: 0,
        // Disposal
        onDispose: null,
        disposed: false,
        // Type flag
        isRenderObject: true,
    };
}
/**
 * Dispose a RenderObject and clean up GPU resources.
 */
function disposeRenderObject(renderObject) {
    if (renderObject.disposed)
        return;
    renderObject.disposed = true;
    renderObject.onDispose?.();
    // Clear references
    renderObject.nodeBuilderState = null;
    renderObject.pipeline = null;
    renderObject.bindGroups = null;
    renderObject._bindings = null;
    renderObject.vertexBuffers = null;
    renderObject.indexBuffer = null;
    renderObject.onDispose = null;
}
/**
 * Get the BindGroups for a RenderObject, lazily creating them.
 *
 * Three.js pattern (RenderObject.getBindings):
 * - First access calls NodeBuilderState.createBindings()
 * - This clones non-shared groups, reuses shared groups
 * - Subsequent accesses return the cached bindings
 *
 * @param renderObject - The RenderObject
 * @returns Array of BindGroups for this RenderObject
 * @throws Error if nodeBuilderState is not set
 */
function getBindings(renderObject) {
    if (renderObject._bindings !== null) {
        return renderObject._bindings;
    }
    if (renderObject.nodeBuilderState === null) {
        throw new Error('Cannot get bindings: nodeBuilderState is not set');
    }
    // Create bindings from NodeBuilderState (clones non-shared, reuses shared)
    renderObject._bindings = createBindings(renderObject.nodeBuilderState);
    return renderObject._bindings;
}
/**
 * Compute the cache key for a RenderObject based on material and geometry.
 *
 * This is used to detect when recompilation is needed.
 * The key includes render state, geometry attributes, and context configuration.
 */
function computeRenderObjectCacheKey(material, geometry, renderContext) {
    // Build cache key from material render state
    const parts = [];
    // Material render state
    parts.push(material.transparent ? 't' : 'o');
    parts.push(material.depthTest ? 'd' : '');
    parts.push(material.depthWrite ? 'w' : '');
    parts.push(material.depthCompare);
    parts.push(material.cullMode);
    parts.push(material.alphaToCoverage ? 'a' : '');
    parts.push(`v${material.version}`);
    // Blend state (if present)
    if (material.blend) {
        parts.push('b');
        parts.push(material.blend.color?.operation ?? 'add');
        parts.push(material.blend.alpha?.operation ?? 'add');
    }
    // Geometry buffers (names and formats)
    const bufferKeys = [];
    for (const [name, buffer] of geometry.buffers) {
        bufferKeys.push(`${name}:${buffer.format ?? 'auto'}`);
    }
    bufferKeys.sort();
    parts.push(bufferKeys.join(','));
    // Index format
    if (geometry.index) {
        const fmt = getIndexFormat(geometry.index.array);
        if (fmt)
            parts.push(fmt);
    }
    // Render context (sample count, attachment config)
    parts.push(`s${renderContext.sampleCount}`);
    parts.push(renderContext.depth ? 'D' : '');
    parts.push(renderContext.stencil ? 'S' : '');
    return parts.join('|');
}
/**
 * Get or compute the cached pipeline key for a RenderObject.
 *
 * The pipeline key is used for:
 * 1. Pipeline cache lookup (avoid recomputing expensive key strings)
 * 2. Opaque sorting by pipeline (minimize setPipeline calls)
 *
 * The key is invalidated when material.version changes.
 *
 * @param renderObject - The RenderObject
 * @param samples - MSAA sample count
 * @param colorFormat - Color texture format
 * @param depthFormat - Depth texture format (undefined for no depth)
 * @param makeKeyFn - Function to compute the pipeline key (from pipelines.ts)
 * @returns The cached or newly computed pipeline key
 */
function getCachedPipelineKey(renderObject, samples, colorFormat, depthFormat, makeKeyFn) {
    const currentVersion = renderObject.material.version;
    // Check if cache is valid
    if (renderObject._cachedPipelineKey !== null &&
        renderObject._pipelineKeyVersion === currentVersion) {
        return renderObject._cachedPipelineKey;
    }
    // Recompute and cache
    const key = makeKeyFn(renderObject.material, samples, colorFormat, depthFormat);
    renderObject._cachedPipelineKey = key;
    renderObject._pipelineKeyVersion = currentVersion;
    return key;
}

/**
 * NodeFrame — unified frame context for all node update callbacks.
 *
 * Properties are set by the renderer/NodeManager before calling update methods.
 * Nodes access whatever context they need from the frame.
 */
class NodeFrame {
    /**
     * Elapsed time in seconds since renderer start.
     * Updated each frame.
     */
    time = 0;
    /**
     * Delta time in seconds since last frame.
     * Updated each frame.
     */
    deltaTime = 0;
    /**
     * Frame ID — incremented once per animation frame.
     * Used for FRAME-level update deduplication.
     */
    frameId = 0;
    /**
     * Render ID — incremented per render() call.
     * Multiple renders can happen per frame (shadows, reflections, VR).
     * Used for RENDER-level update deduplication.
     */
    renderId = 0;
    // -----------------------------------------------------------------------
    // Render Context (set before each update cycle)
    // -----------------------------------------------------------------------
    /**
     * The current renderer.
     */
    renderer = null;
    /**
     * The current camera being rendered from.
     */
    camera = null;
    /**
     * The current object (mesh) being rendered.
     * Set for OBJECT-level updates.
     */
    object = null;
    /**
     * The current scene/object being rendered.
     */
    scene = null;
    /**
     * The current material being rendered.
     */
    material = null;
    // -----------------------------------------------------------------------
    // GPU Context
    // -----------------------------------------------------------------------
    /**
     * The current GPU command encoder.
     * Used by nodes that need to encode GPU commands (PassNode, etc.)
     */
    encoder = null;
    /**
     * Render target width in pixels.
     */
    width = 0;
    /**
     * Render target height in pixels.
     */
    height = 0;
    // -----------------------------------------------------------------------
    // Internal: for tracking last update time
    // -----------------------------------------------------------------------
    _lastTime = undefined;
    // -----------------------------------------------------------------------
    // Deduplication Maps
    // -----------------------------------------------------------------------
    /**
     * Used to control Node.update() calls.
     * Maps nodes to their last update frame/render IDs.
     */
    updateMap = new WeakMap();
    /**
     * Used to control Node.updateBefore() calls.
     */
    updateBeforeMap = new WeakMap();
    /**
     * Used to control Node.updateAfter() calls.
     */
    updateAfterMap = new WeakMap();
    // -----------------------------------------------------------------------
    // Methods
    // -----------------------------------------------------------------------
    /**
     * Update timing state. Called once per animation frame.
     */
    update() {
        this.frameId++;
        const now = performance.now();
        if (this._lastTime === undefined) {
            this._lastTime = now;
        }
        this.deltaTime = (now - this._lastTime) / 1000;
        this._lastTime = now;
        this.time += this.deltaTime;
    }
    _getMaps(map, node) {
        let maps = map.get(node);
        if (!maps) {
            maps = { frameId: -1, renderId: -1 };
            map.set(node, maps);
        }
        return maps;
    }
    /**
     * Execute updateBefore for a node, respecting its updateBeforeType.
     */
    updateBeforeNode(node) {
        const updateType = node.updateBeforeType;
        if (updateType === 'none')
            return;
        const maps = this._getMaps(this.updateBeforeMap, node);
        if (updateType === 'frame') {
            if (maps.frameId !== this.frameId) {
                const prev = maps.frameId;
                maps.frameId = this.frameId;
                if (node.updateBefore(this) === false) {
                    maps.frameId = prev;
                }
            }
        }
        else if (updateType === 'render') {
            if (maps.renderId !== this.renderId) {
                const prev = maps.renderId;
                maps.renderId = this.renderId;
                if (node.updateBefore(this) === false) {
                    maps.renderId = prev;
                }
            }
        }
        else if (updateType === 'object') {
            node.updateBefore(this);
        }
    }
    /**
     * Execute update for a node, respecting its updateType.
     */
    updateNode(node) {
        const updateType = node.updateType;
        if (updateType === 'none')
            return;
        const maps = this._getMaps(this.updateMap, node);
        if (updateType === 'frame') {
            if (maps.frameId !== this.frameId) {
                const prev = maps.frameId;
                maps.frameId = this.frameId;
                if (node.update(this) === false) {
                    maps.frameId = prev;
                }
            }
        }
        else if (updateType === 'render') {
            if (maps.renderId !== this.renderId) {
                const prev = maps.renderId;
                maps.renderId = this.renderId;
                if (node.update(this) === false) {
                    maps.renderId = prev;
                }
            }
        }
        else if (updateType === 'object') {
            node.update(this);
        }
    }
    /**
     * Execute updateAfter for a node, respecting its updateAfterType.
     */
    updateAfterNode(node) {
        const updateType = node.updateAfterType;
        if (updateType === 'none')
            return;
        const maps = this._getMaps(this.updateAfterMap, node);
        if (updateType === 'frame') {
            if (maps.frameId !== this.frameId) {
                const prev = maps.frameId;
                maps.frameId = this.frameId;
                if (node.updateAfter(this) === false) {
                    maps.frameId = prev;
                }
            }
        }
        else if (updateType === 'render') {
            if (maps.renderId !== this.renderId) {
                const prev = maps.renderId;
                maps.renderId = this.renderId;
                if (node.updateAfter(this) === false) {
                    maps.renderId = prev;
                }
            }
        }
        else if (updateType === 'object') {
            node.updateAfter(this);
        }
    }
}
/**
 * Create a new NodeFrame instance.
 */
function createNodeFrame() {
    return new NodeFrame();
}

/**
 * wgsl-utils.ts — WGSL code generation utilities shared across node compilation.
 *
 * These are pure functions that convert JavaScript values to WGSL syntax strings.
 */
/**
 * Generate a WGSL literal string for a constant value.
 *
 * @param type - The WGSL type (e.g., 'f32', 'vec3f', 'mat4x4f')
 * @param value - The value as a number, array of numbers, or string
 * @returns The WGSL literal string
 */
function constLiteral(type, value) {
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number') {
        switch (type) {
            case 'f32':
                return Number.isInteger(value) ? `${value}.0` : `${value}`;
            case 'f16':
                return Number.isInteger(value) ? `${value}.0h` : `${value}h`;
            case 'i32':
                return `${Math.trunc(value)}i`;
            case 'u32':
                return `${Math.trunc(value)}u`;
            case 'bool':
                return value !== 0 ? 'true' : 'false';
            default:
                return `${value}`;
        }
    }
    const components = value.map((v) => {
        if (type.startsWith('vec') && type.endsWith('f'))
            return Number.isInteger(v) ? `${v}.0` : `${v}`;
        if (type.startsWith('vec') && type.endsWith('h'))
            return Number.isInteger(v) ? `${v}.0h` : `${v}h`;
        if (type.startsWith('vec') && type.endsWith('i'))
            return `${Math.trunc(v)}i`;
        if (type.startsWith('vec') && type.endsWith('u'))
            return `${Math.trunc(v)}u`;
        if (type === 'vec2<bool>' || type === 'vec3<bool>' || type === 'vec4<bool>')
            return v !== 0 ? 'true' : 'false';
        if (type.startsWith('mat') && type.endsWith('h'))
            return Number.isInteger(v) ? `${v}.0h` : `${v}h`;
        if (type.startsWith('mat'))
            return Number.isInteger(v) ? `${v}.0` : `${v}`;
        return `${v}`;
    });
    if (components.length === 0)
        return `${type}()`;
    return `${type}(${components.join(', ')})`;
}

/* public apis */
function compile(slots) {
    // create contexts for both stages
    const vertexCtx = createContext('vertex', true);
    const fragmentCtx = createContext('fragment', true);
    const hasFragment = slots.color !== null;
    // collect all roots
    const roots = [slots.position];
    if (slots.color)
        roots.push(slots.color);
    if (slots.depth)
        roots.push(slots.depth);
    // single discovery pass across all roots
    const discovered = discover(roots);
    vertexCtx.usageCount = discovered.usageCount;
    vertexCtx.mutatedNodes = discovered.mutatedNodes;
    vertexCtx.fnDefs = discovered.fnDefs;
    vertexCtx.wgslFnDefs = discovered.wgslFnDefs;
    vertexCtx.structDefs = discovered.structDefs;
    vertexCtx.storageNames = discovered.storageNames;
    vertexCtx.textures = discovered.textures;
    vertexCtx.samplers = discovered.samplers;
    vertexCtx.uniforms = discovered.uniforms;
    vertexCtx.storages = discovered.storages;
    vertexCtx.privateVars = discovered.privateVars;
    vertexCtx.workgroupVars = discovered.workgroupVars;
    fragmentCtx.usageCount = discovered.usageCount;
    fragmentCtx.mutatedNodes = discovered.mutatedNodes;
    fragmentCtx.fnDefs = discovered.fnDefs;
    fragmentCtx.wgslFnDefs = discovered.wgslFnDefs;
    fragmentCtx.structDefs = discovered.structDefs;
    fragmentCtx.storageNames = discovered.storageNames;
    fragmentCtx.textures = discovered.textures;
    fragmentCtx.samplers = discovered.samplers;
    fragmentCtx.uniforms = discovered.uniforms;
    fragmentCtx.storages = discovered.storages;
    fragmentCtx.privateVars = discovered.privateVars;
    fragmentCtx.workgroupVars = discovered.workgroupVars;
    // pre-collect varyings from fragment roots (so vertex shader knows what to output)
    if (hasFragment) {
        const fragmentRoots = [slots.color];
        collectVaryings(fragmentRoots, vertexCtx);
    }
    // generate vertex shader
    const vertexBody = generateVertexShader(slots, vertexCtx);
    // generate fragment shader (skip for depth-only pipelines)
    let fragmentBody = '';
    if (hasFragment) {
        fragmentBody = generateFragmentShader(slots.color, fragmentCtx, vertexCtx.varyings);
        // No need to merge bindings anymore - they're shared via discovered.*
    }
    // emit all bindings using Three.js pattern (each group gets its own @group index)
    const { wgsl: bindingsWgsl, uniformBlocks, storageEntries, textureEntries: textures, samplerEntries: samplers } = emitAllBindings(vertexCtx);
    // emit module-scope variables (var<private>)
    const moduleScopeVarsWgsl = emitModuleScopeVars(vertexCtx);
    // emit functions
    const wgslFnsCode = emitWgslFunctions(vertexCtx);
    const dslFnsCode = emitDslFunctions(vertexCtx);
    // assemble full shader
    const codeParts = [
        '// Bindings (uniforms, storage, textures, samplers)',
        bindingsWgsl,
        '// Module-scope variables',
        moduleScopeVarsWgsl,
        '// WGSL Functions',
        wgslFnsCode,
        '// DSL Functions',
        dslFnsCode,
        '// Vertex Shader',
        vertexBody,
    ];
    if (hasFragment) {
        codeParts.push('', '// Fragment Shader', fragmentBody);
    }
    const code = codeParts.filter(Boolean).join('\n');
    // collect graph info
    const graphNodes = new Map();
    const graphEdges = new Map();
    const graphInfo = new Map();
    for (const [id, node] of discovered.allNodes) {
        graphNodes.set(id, node);
        graphEdges.set(id, getChildren(node).map(c => c.id));
        graphInfo.set(id, {
            stages: [],
            cseVar: vertexCtx.nodeVars.get(id) ?? fragmentCtx.nodeVars.get(id),
            usageCount: discovered.usageCount.get(id) ?? 0,
            expression: undefined,
        });
    }
    // build varying entries
    const varyingEntries = [];
    let loc = 0;
    for (const [name, { node }] of vertexCtx.varyings) {
        varyingEntries.push({
            name,
            type: node.type.wgslType,
            location: loc++,
            interpolationType: node.interpolationType ?? null,
            interpolationSampling: node.interpolationSampling ?? null,
        });
    }
    // Build attributes array — unified, all entries already in ctx.attributes
    const allAttributes = Array.from(vertexCtx.attributes.values());
    // Group attributes by underlying buffer for efficient vertex buffer binding
    const vertexBufferGroups = groupAttributesByBuffer(allAttributes);
    return {
        code,
        vertexEntryPoint: 'vs_main',
        fragmentEntryPoint: hasFragment ? 'fs_main' : null,
        attributes: allAttributes,
        vertexBufferGroups,
        varyings: varyingEntries,
        uniformGroups: uniformBlocks,
        storage: storageEntries,
        textures,
        samplers,
        builtinsUsed: new Set([...vertexCtx.builtins, ...fragmentCtx.builtins]),
        updateBeforeNodes: discovered.updateBeforeNodes,
        updateAfterNodes: discovered.updateAfterNodes,
        updateNodes: discovered.updateNodes,
        graphNodes,
        graphEdges,
        graphInfo,
    };
}
function compileCompute(node) {
    const ctx = createContext('compute', false);
    // trace the FnNode to get roots
    const fn = node.fn;
    const traced = fn.trace();
    // filter out undefined (void functions have no output)
    const roots = [traced.body, traced.output].filter((n) => n != null);
    // single discovery pass
    const discovered = discover(roots);
    ctx.usageCount = discovered.usageCount;
    ctx.mutatedNodes = discovered.mutatedNodes;
    ctx.fnDefs = discovered.fnDefs;
    ctx.wgslFnDefs = discovered.wgslFnDefs;
    ctx.structDefs = discovered.structDefs;
    ctx.storageNames = discovered.storageNames;
    ctx.textures = discovered.textures;
    ctx.samplers = discovered.samplers;
    ctx.uniforms = discovered.uniforms;
    ctx.storages = discovered.storages;
    ctx.privateVars = discovered.privateVars;
    ctx.workgroupVars = discovered.workgroupVars;
    // generate compute shader body
    const computeBody = generateComputeShader(node, ctx);
    // emit all bindings using Three.js pattern (each group gets its own @group index)
    const { wgsl: bindingsWgsl, uniformBlocks, storageEntries } = emitAllBindings(ctx);
    // emit module-scope variables (var<private>, var<workgroup>)
    const moduleScopeVarsWgsl = emitModuleScopeVars(ctx);
    // emit functions
    const wgslFnsCode = emitWgslFunctions(ctx);
    const dslFnsCode = emitDslFunctions(ctx);
    // assemble full shader
    const code = [
        '// Bindings (uniforms, storage, textures, samplers)',
        bindingsWgsl,
        '// Module-scope variables',
        moduleScopeVarsWgsl,
        '// WGSL Functions',
        wgslFnsCode,
        '// DSL Functions',
        dslFnsCode,
        '// Compute Shader',
        computeBody,
    ].filter(Boolean).join('\n');
    // convert storage entries to compute format
    const computeStorage = storageEntries.map((e) => ({
        node: e.node,
        name: e.name,
        type: e.type,
        access: e.access,
        group: e.group,
        binding: e.binding,
    }));
    return {
        code,
        storage: computeStorage,
        workgroupSize: node.workgroupSize ?? [64, 1, 1],
        builtinsUsed: ctx.builtins,
        uniformGroups: uniformBlocks,
    };
}
function createContext(stage, isRender) {
    return {
        stage,
        isRender,
        uniforms: new Map(),
        storages: new Map(),
        storageNames: new Map(),
        textures: new Map(),
        samplers: new Map(),
        attributes: new Map(),
        attrCounter: 0,
        varyings: new Map(),
        builtins: new Set(),
        privateVars: new Map(),
        workgroupVars: new Map(),
        structs: new Map(),
        structDefs: new Map(),
        usageCount: new Map(),
        mutatedNodes: new Set(),
        nodeVars: new Map(),
        varCounter: 0,
        indentLevel: 1,
        code: [],
        fnDefs: new Map(),
        wgslFnDefs: new Map(),
        graphNodes: new Map(),
        graphEdges: new Map(),
        graphInfo: new Map(),
    };
}
/** Get all child nodes for traversal */
function getChildren(node) {
    const children = [];
    // _beforeNodes are dependencies that must be processed before this node.
    // They're part of the graph but don't generate sub-expressions for this node.
    if (node._beforeNodes) {
        children.push(...node._beforeNodes);
    }
    if (node instanceof BinopNode) {
        children.push(node.left, node.right);
    }
    else if (node instanceof CallNode) {
        children.push(...node.args);
    }
    else if (node instanceof ConstructNode) {
        children.push(...node.args);
    }
    else if (node instanceof FieldNode) {
        children.push(node.object);
    }
    else if (node instanceof IndexNode) {
        children.push(node.array, node.index);
    }
    else if (node instanceof VaryingNode) {
        // VaryingNode.node is a SubBuildNode wrapping the source
        children.push(node.node);
    }
    else if (node instanceof AssignNode) {
        children.push(node.target, node.value);
    }
    else if (node instanceof LetNode || node instanceof VarNode) {
        children.push(node.init);
    }
    else if (node instanceof PrivateVarNode) {
        if (node.init)
            children.push(node.init);
    }
    else if (node instanceof WorkgroupVarNode) ;
    else if (node instanceof CondNode) {
        children.push(node.condition, node.ifTrue);
        if (node.ifFalse)
            children.push(node.ifFalse);
    }
    else if (node instanceof WgslNode) {
        children.push(...node.deps);
    }
    else if (node instanceof ReturnNode) {
        children.push(node.value);
    }
    else if (node instanceof InspectorNode) {
        children.push(node.wrappedNode);
    }
    else if (node instanceof PassNode) {
        // PassNode delegates to its texture node during code generation
        const textureNode = node.scope === 'color' ? node.getTextureNode() : node.getLinearDepthNode();
        children.push(textureNode);
    }
    else if (node instanceof TextureBindingNode) ;
    else if (node instanceof TextureNode) {
        // TextureNode owns a bindingNode for the texture var declaration
        children.push(node.bindingNode);
        if (node.samplerNode) {
            children.push(node.samplerNode);
        }
        if (node.uvNode) {
            children.push(node.uvNode);
        }
        if (node.levelNode) {
            children.push(node.levelNode);
        }
        if (node.biasNode) {
            children.push(node.biasNode);
        }
        if (node.gradNode) {
            children.push(node.gradNode[0], node.gradNode[1]);
        }
        if (node.offsetNode) {
            children.push(node.offsetNode);
        }
        if (node.loadCoords) {
            children.push(node.loadCoords);
        }
        if (node.loadLevel) {
            children.push(node.loadLevel);
        }
    }
    else if (node instanceof CubeTextureNode) {
        children.push(node.bindingNode);
        if (node.samplerNode) {
            children.push(node.samplerNode);
        }
        if (node.directionNode) {
            children.push(node.directionNode);
        }
        if (node.levelNode) {
            children.push(node.levelNode);
        }
        if (node.biasNode) {
            children.push(node.biasNode);
        }
        if (node.gradNode) {
            children.push(node.gradNode[0], node.gradNode[1]);
        }
    }
    else if (node instanceof DepthTextureNode) {
        children.push(node.bindingNode);
        if (node.samplerNode) {
            children.push(node.samplerNode);
        }
        if (node.uvNode) {
            children.push(node.uvNode);
        }
        if (node.levelNode) {
            children.push(node.levelNode);
        }
        if (node.offsetNode) {
            children.push(node.offsetNode);
        }
        if (node.loadCoords) {
            children.push(node.loadCoords);
        }
        if (node.loadLevel) {
            children.push(node.loadLevel);
        }
    }
    else if (node instanceof ArrayTextureNode) {
        children.push(node.bindingNode);
        if (node.samplerNode) {
            children.push(node.samplerNode);
        }
        if (node.uvNode) {
            children.push(node.uvNode);
        }
        children.push(node.layerNode);
        if (node.levelNode) {
            children.push(node.levelNode);
        }
        if (node.biasNode) {
            children.push(node.biasNode);
        }
        if (node.gradNode) {
            children.push(node.gradNode[0], node.gradNode[1]);
        }
        if (node.offsetNode) {
            children.push(node.offsetNode);
        }
        if (node.loadCoords) {
            children.push(node.loadCoords);
        }
        if (node.loadLevel) {
            children.push(node.loadLevel);
        }
    }
    else if (node instanceof MRTNode) {
        // MRTNode stores outputs in outputNodes dict (members only populated post-resolve)
        children.push(...Object.values(node.outputNodes));
    }
    else if (node instanceof OutputStructNode) {
        children.push(...node.members);
    }
    else if (node instanceof LoopNode) {
        children.push(node.body);
    }
    else if (node instanceof IfNode) {
        children.push(node.condition);
        children.push(...node.thenBody.body);
        for (const branch of node.elseIfBranches) {
            children.push(branch.condition);
            children.push(...branch.body.body);
        }
        if (node.elseBody) {
            children.push(...node.elseBody.body);
        }
    }
    else if (node instanceof StackNode) {
        children.push(...node.body);
    }
    return children;
}
/**
 * Group attributes by their underlying buffer for efficient vertex buffer binding.
 *
 * Attributes sharing the same buffer (either by name for geometry-based, or by
 * buffer reference for direct) are grouped together. This enables:
 * - One GPUVertexBufferLayout with multiple attributes
 * - One setVertexBuffer() call per unique buffer
 *
 * @param entries - Flat array of AttributeEntry from compilation
 * @returns Array of VertexBufferGroup, one per unique buffer
 */
function groupAttributesByBuffer(entries) {
    // Use separate maps for name-based and buffer-based grouping
    const nameGroups = new Map();
    const bufferGroups = new Map();
    for (const entry of entries) {
        let group;
        if (entry.kind === 'geometry') {
            // Name-based grouping
            const geomName = entry.name;
            group = nameGroups.get(geomName);
            if (!group) {
                group = {
                    name: geomName,
                    buffer: null,
                    stride: entry.stride,
                    instanced: entry.instanced,
                    attributes: [],
                };
                nameGroups.set(geomName, group);
            }
        }
        else {
            // Buffer-based grouping
            const buffer = entry.node.buffer;
            group = bufferGroups.get(buffer);
            if (!group) {
                group = {
                    name: null,
                    buffer,
                    stride: entry.stride,
                    instanced: entry.instanced,
                    attributes: [],
                };
                bufferGroups.set(buffer, group);
            }
        }
        // Validate stride/instanced match within group
        if (group.stride !== entry.stride) {
            throw new Error(`[gpucat] Interleaved attributes sharing buffer must have matching stride. ` +
                `Got ${entry.stride} but group has ${group.stride}.`);
        }
        if (group.instanced !== entry.instanced) {
            throw new Error(`[gpucat] Interleaved attributes sharing buffer must have matching instanced flag.`);
        }
        group.attributes.push({
            type: entry.type,
            offset: entry.offset,
            shaderLocation: entry.location,
        });
    }
    // Combine both maps into a single array, preserving order (name-based first, then buffer-based)
    return [...nameGroups.values(), ...bufferGroups.values()];
}
function discover(roots) {
    const usageCount = new Map();
    const mutatedNodes = new Set();
    const fnDefs = new Map();
    const wgslFnDefs = new Map();
    const structDefs = new Map();
    const storageNames = new Map();
    const textures = new Map();
    const samplers = new Map(); // keyed by settingsKey
    const uniforms = new Map();
    const storages = new Map();
    const privateVars = new Map();
    const workgroupVars = new Map();
    const allNodes = new Map();
    const updateBeforeNodes = [];
    const updateAfterNodes = [];
    const updateNodes = [];
    const visited = new Set();
    function registerStructDef(def) {
        if (structDefs.has(def.wgslType))
            return;
        for (const nested of def.nestedDefs.values()) {
            registerStructDef(nested);
        }
        structDefs.set(def.wgslType, def);
    }
    function markTargetChain(node) {
        mutatedNodes.add(node.id);
        if (node instanceof FieldNode) {
            markTargetChain(node.object);
        }
        else if (node instanceof IndexNode) {
            markTargetChain(node.array);
        }
    }
    function registerSampler(samplerNode) {
        const key = samplerNode.settingsKey;
        if (!samplers.has(key)) {
            samplers.set(key, samplerNode);
        }
    }
    function registerTextureWithSampler(textureNode) {
        // Register the texture binding
        const binding = textureNode.bindingNode;
        const name = binding.textureId;
        if (!textures.has(name)) {
            textures.set(name, binding);
        }
        // For sampling modes (not 'load'), ensure a sampler exists and register it
        if (textureNode.samplingMode !== 'load') {
            let samplerNode = textureNode.samplerNode;
            if (!samplerNode) {
                // Create default sampler (same logic as generateTexture had)
                samplerNode = new SamplerNode(sampler$1, name, binding.groupNode);
                textureNode.samplerNode = samplerNode;
            }
            registerSampler(samplerNode);
        }
    }
    function visit(node) {
        // usage counting
        usageCount.set(node.id, (usageCount.get(node.id) ?? 0) + 1);
        // exit if visited
        if (visited.has(node.id))
            return;
        visited.add(node.id);
        // collect all nodes
        allNodes.set(node.id, node);
        // collect update lifecycle nodes
        if (node.updateBeforeType !== 'none' && node.updateBefore) {
            updateBeforeNodes.push(node);
        }
        if (node.updateAfterType !== 'none' && node.updateAfter) {
            updateAfterNodes.push(node);
        }
        if (node.updateType !== 'none' && node.update) {
            updateNodes.push(node);
        }
        // mutated nodes: walk assignment target chains
        if (node instanceof AssignNode) {
            markTargetChain(node.target);
        }
        // function discovery
        if (node instanceof CallNode && node.fnNode) {
            const fn = node.fnNode;
            if (!fnDefs.has(fn.fnName)) {
                const traced = fn.trace();
                fnDefs.set(fn.fnName, { fn, traced });
                visit(traced.body);
                visit(traced.output);
            }
        }
        if (node instanceof CallNode && node.wgslFnNode) {
            const fn = node.wgslFnNode;
            if (!wgslFnDefs.has(fn.code)) {
                wgslFnDefs.set(fn.code, fn);
                for (const inc of fn.includes) {
                    if (inc instanceof WgslFunctionNode && !wgslFnDefs.has(inc.code)) {
                        wgslFnDefs.set(inc.code, inc);
                    }
                }
            }
        }
        // storage + struct definition discovery
        if (node instanceof StorageNode) {
            if (!storageNames.has(node.id)) {
                storageNames.set(node.id, `_storage${storageNames.size}`);
            }
            // Also register storage for binding emission
            const storageName = storageNames.get(node.id);
            if (!storages.has(storageName)) {
                storages.set(storageName, node);
            }
            const bufType = node.type;
            if (isStructDef(bufType)) {
                registerStructDef(bufType);
            }
            else if ((isArrayDesc(bufType) || isSizedArrayDesc(bufType)) && isStructDef(bufType.element)) {
                registerStructDef(bufType.element);
            }
        }
        // Binding discovery: textures, samplers, uniforms
        if (node instanceof TextureBindingNode) {
            const name = node.textureId;
            if (!textures.has(name)) {
                textures.set(name, node);
            }
        }
        if (node instanceof TextureNode) {
            registerTextureWithSampler(node);
        }
        if (node instanceof CubeTextureNode) {
            registerTextureWithSampler(node);
        }
        if (node instanceof DepthTextureNode) {
            registerTextureWithSampler(node);
        }
        if (node instanceof ArrayTextureNode) {
            registerTextureWithSampler(node);
        }
        if (node instanceof SamplerNode) {
            registerSampler(node);
        }
        if (node instanceof UniformNode) {
            const name = node.name;
            const group = node.groupNode;
            if (!uniforms.has(name)) {
                uniforms.set(name, { node, group });
            }
        }
        // Module-scope variable discovery
        if (node instanceof PrivateVarNode) {
            if (!privateVars.has(node.id)) {
                privateVars.set(node.id, node);
            }
        }
        if (node instanceof WorkgroupVarNode) {
            if (!workgroupVars.has(node.id)) {
                workgroupVars.set(node.id, node);
            }
        }
        // visit children
        for (const child of getChildren(node)) {
            visit(child);
        }
    }
    for (const root of roots) {
        visit(root);
    }
    return {
        usageCount, mutatedNodes, fnDefs, wgslFnDefs, structDefs, storageNames,
        allNodes, updateBeforeNodes, updateAfterNodes, updateNodes,
        textures, samplers, uniforms, storages, privateVars, workgroupVars
    };
}
/** Pre-collect VaryingNodes from roots and generate their vertex expressions. */
function collectVaryings(roots, ctx) {
    const visited = new Set();
    function visit(node) {
        if (visited.has(node.id))
            return;
        visited.add(node.id);
        if (node instanceof VaryingNode) {
            const name = node.name ?? `v_${node.id}`;
            if (!ctx.varyings.has(name)) {
                // generate vertex expression for this varying
                const sourceNode = node.node.node;
                const sourceExpr = generateExpr(ctx, sourceNode);
                ctx.varyings.set(name, { node, vertexExpr: sourceExpr });
            }
        }
        for (const child of getChildren(node)) {
            visit(child);
        }
    }
    for (const root of roots) {
        visit(root);
    }
}
function wgslAlign(type) {
    if (type === 'f32' || type === 'i32' || type === 'u32')
        return 4;
    if (type === 'f16')
        return 2;
    if (type.startsWith('vec2'))
        return 8;
    if (type.startsWith('vec3') || type.startsWith('vec4'))
        return 16;
    if (type.startsWith('mat'))
        return 16;
    return 4;
}
function wgslSize(type) {
    if (type === 'f32' || type === 'i32' || type === 'u32')
        return 4;
    if (type === 'f16')
        return 2;
    if (type.startsWith('vec2'))
        return 8;
    if (type.startsWith('vec3'))
        return 12;
    if (type.startsWith('vec4'))
        return 16;
    if (type === 'mat2x2f' || type === 'mat2x2h')
        return 16;
    if (type === 'mat3x3f' || type === 'mat3x3h')
        return 48;
    if (type === 'mat4x4f' || type === 'mat4x4h')
        return 64;
    return 4;
}
/* expression generation */
function generateExpr(ctx, node) {
    // Record node for graph
    ctx.graphNodes.set(node.id, node);
    // CSE: if already computed and multi-use, return variable name
    if (ctx.nodeVars.has(node.id)) {
        return ctx.nodeVars.get(node.id);
    }
    let expr;
    if (node instanceof LiteralNode) {
        expr = constLiteral(node.type.wgslType, node.value);
    }
    else if (node instanceof UniformNode) {
        expr = generateUniform(ctx, node);
    }
    else if (node instanceof AttributeNode) {
        expr = generateAttribute(ctx, node);
    }
    else if (node instanceof StorageNode) {
        expr = generateStorage(ctx, node);
    }
    else if (node instanceof PassNode) {
        // PassNode used as expression delegates to its texture node (like three.js setup())
        const textureNode = node.scope === 'color' ? node.getTextureNode() : node.getLinearDepthNode();
        expr = generateExpr(ctx, textureNode);
    }
    else if (node instanceof TextureBindingNode) {
        expr = generateTextureBinding(ctx, node);
    }
    else if (node instanceof TextureNode) {
        expr = generateTexture(ctx, node);
    }
    else if (node instanceof CubeTextureNode) {
        expr = generateCubeTexture(ctx, node);
    }
    else if (node instanceof DepthTextureNode) {
        expr = generateDepthTexture(ctx, node);
    }
    else if (node instanceof ArrayTextureNode) {
        expr = generateArrayTexture(ctx, node);
    }
    else if (node instanceof SamplerNode) {
        expr = generateSampler(ctx, node);
    }
    else if (node instanceof VaryingNode) {
        expr = generateVarying(ctx, node);
    }
    else if (node instanceof BinopNode) {
        const left = generateExpr(ctx, node.left);
        const right = generateExpr(ctx, node.right);
        expr = `(${left} ${node.op} ${right})`;
    }
    else if (node instanceof CallNode) {
        expr = generateCall(ctx, node);
    }
    else if (node instanceof ArrayNode) {
        const args = node.elements.map(e => generateExpr(ctx, e));
        expr = `array<${node.type.element.wgslType}, ${node.elements.length}>(${args.join(', ')})`;
    }
    else if (node instanceof ConstructNode) {
        const args = node.args.map(a => generateExpr(ctx, a));
        expr = `${node.type.wgslType}(${args.join(', ')})`;
    }
    else if (node instanceof FieldNode) {
        const obj = generateExpr(ctx, node.object);
        expr = `${obj}.${node.fieldName}`;
    }
    else if (node instanceof IndexNode) {
        const arr = generateExpr(ctx, node.array);
        const idx = generateExpr(ctx, node.index);
        expr = `${arr}[${idx}]`;
    }
    else if (node instanceof BuiltinNode) {
        expr = generateBuiltin(ctx, node);
    }
    else if (node instanceof ComputeIndexNode) {
        expr = 'computeIndex';
    }
    else if (node instanceof CondNode) {
        const cond = generateExpr(ctx, node.condition);
        const t = generateExpr(ctx, node.ifTrue);
        const f = node.ifFalse ? generateExpr(ctx, node.ifFalse) : `${node.type.wgslType}()`;
        expr = `select(${f}, ${t}, ${cond})`;
    }
    else if (node instanceof WgslNode) {
        // inline WGSL with $0, $1, ... placeholders
        let wgsl = node.wgsl;
        for (let i = 0; i < node.deps.length; i++) {
            const depExpr = generateExpr(ctx, node.deps[i]);
            wgsl = wgsl.replace(new RegExp(`\\$${i}`, 'g'), depExpr);
        }
        expr = wgsl;
    }
    else if (node instanceof LetNode) {
        // LetNode as expression returns the variable name
        // If not yet declared, emit the declaration now
        if (!ctx.nodeVars.has(node.id)) {
            const init = generateExpr(ctx, node.init);
            ctx.code.push(`    let ${node.varName} = ${init};`);
            ctx.nodeVars.set(node.id, node.varName);
        }
        expr = node.varName;
    }
    else if (node instanceof VarNode) {
        // VarNode as expression returns the variable name
        // If not yet declared, emit the declaration now
        if (!ctx.nodeVars.has(node.id)) {
            const init = generateExpr(ctx, node.init);
            ctx.code.push(`    var ${node.varName} = ${init};`);
            ctx.nodeVars.set(node.id, node.varName);
        }
        expr = node.varName;
    }
    else if (node instanceof PrivateVarNode) {
        // PrivateVarNode is module-scope, emitted separately
        // Just return the variable name - declaration is in emitModuleScopeVars
        ctx.nodeVars.set(node.id, node.varName);
        expr = node.varName;
    }
    else if (node instanceof WorkgroupVarNode) {
        // WorkgroupVarNode is module-scope, emitted separately
        // Validate it's only used in compute shaders
        if (ctx.stage !== 'compute') {
            throw new Error(`[builder] WorkgroupVarNode '${node.varName}' can only be used in compute shaders, but was used in ${ctx.stage} stage.`);
        }
        ctx.nodeVars.set(node.id, node.varName);
        expr = node.varName;
    }
    else if (node instanceof ParamNode) {
        expr = node.paramName ?? `p${node.paramIndex}`;
    }
    else if (node instanceof InspectorNode) {
        // inspector is transparent - just generate the wrapped node
        expr = generateExpr(ctx, node.wrappedNode);
    }
    else if (node instanceof OutputStructNode || node instanceof MRTNode) {
        // these are handled specially at the fragment output level
        expr = `/* OutputStruct */`;
    }
    else {
        console.warn(`[builder] Unknown node kind for expr: ${node.constructor.name}`, node);
        expr = `/* unknown: ${node.constructor.name} */`;
    }
    // CSE: if multi-use, extract to variable
    const usage = ctx.usageCount.get(node.id) ?? 1;
    if (usage > 1 && !ctx.nodeVars.has(node.id) && !isTrivialExpr(node) && !isNonCopyable(node)) {
        const varName = `_v${ctx.varCounter++}`;
        const keyword = ctx.mutatedNodes.has(node.id) ? 'var' : 'let';
        ctx.code.push(`    ${keyword} ${varName} = ${expr};`);
        ctx.nodeVars.set(node.id, varName);
        // record CSE info for graph
        const info = ctx.graphInfo.get(node.id);
        if (info) {
            info.cseVar = varName;
        }
        return varName;
    }
    return expr;
}
/** Check if a type descriptor contains atomic types (recursively) */
function containsAtomics(desc) {
    if (isAtomicDesc(desc))
        return true;
    if (isStructDesc(desc)) {
        for (const fieldDesc of Object.values(desc.fields)) {
            if (containsAtomics(fieldDesc))
                return true;
        }
    }
    if (isArrayDesc(desc) || isSizedArrayDesc(desc)) {
        return containsAtomics(desc.element);
    }
    return false;
}
/** Check if expression is trivial enough that repeating it is cheap (no need to extract) */
function isTrivialExpr(node) {
    return (node instanceof LiteralNode ||
        node instanceof LetNode ||
        node instanceof VarNode ||
        node instanceof PrivateVarNode ||
        node instanceof WorkgroupVarNode ||
        node instanceof ParamNode ||
        node instanceof BuiltinNode ||
        node instanceof FieldNode ||
        // binding references are global names
        node instanceof StorageNode ||
        node instanceof UniformNode ||
        node instanceof TextureBindingNode ||
        node instanceof SamplerNode ||
        node instanceof AttributeNode);
}
/** Check if a node's type cannot be copied into a let binding */
function isNonCopyable(node) {
    if (containsAtomics(node.type))
        return true;
    if (isStorageElementAccess(node))
        return true;
    return false;
}
/** Check if node is an access into storage (IndexNode into StorageNode, or FieldNode/IndexNode chain from one) */
function isStorageElementAccess(node) {
    if (node instanceof IndexNode) {
        if (node.array instanceof StorageNode)
            return true;
        // Also check if indexing into something that's itself a storage access
        return isStorageElementAccess(node.array);
    }
    if (node instanceof FieldNode)
        return isStorageElementAccess(node.object);
    return false;
}
/* binding generation */
function generateUniform(ctx, node) {
    const name = node.name;
    const group = node.groupNode;
    ctx.uniforms.set(name, { node, group });
    return `uniforms_${group.name}.${name}`;
}
function generateAttribute(ctx, node) {
    if (ctx.stage !== 'vertex') {
        const attrName = node.name ?? `(unnamed attribute id=${node.id})`;
        throw new Error(`[builder] AttributeNode '${attrName}' can only be used in vertex stage, but was used in ${ctx.stage} stage. ` +
            `Use varying() to pass vertex data to fragment stage. ` +
            `Common cause: TextureNode with default uvNode (which uses uv() attribute) being sampled in fragment shader without explicit UV coordinates. ` +
            `Fix: use textureNode.sample(yourUV) with a varying or fragment-stage UV.`);
    }
    // Deduplicate by node.id — same node always returns the same WGSL name
    const existing = ctx.attributes.get(node.id);
    if (existing) {
        return `input.${existing.shaderName}`;
    }
    const location = ctx.attributes.size;
    const index = ctx.attrCounter++;
    if (node.isNamedReference) {
        const geomName = node.name;
        const shaderName = `_${geomName}_${index}`;
        ctx.attributes.set(node.id, {
            kind: 'geometry',
            name: geomName,
            shaderName,
            type: node.type.wgslType,
            location,
            node,
            stride: node.stride,
            offset: node.offset,
            instanced: node.instanced,
        });
        return `input.${shaderName}`;
    }
    else {
        const shaderName = `_buf_${index}`;
        ctx.attributes.set(node.id, {
            kind: 'buffer',
            name: null,
            shaderName,
            type: node.type.wgslType,
            location,
            node,
            stride: node.stride,
            offset: node.offset,
            instanced: node.instanced,
        });
        return `input.${shaderName}`;
    }
}
function generateStorage(ctx, node) {
    // name was assigned globally during discover()
    const name = ctx.storageNames.get(node.id);
    // register in storages map for binding emission (idempotent)
    if (!ctx.storages.has(name)) {
        ctx.storages.set(name, node);
    }
    return name;
}
function generateTextureBinding(ctx, node) {
    const name = node.textureId;
    if (!ctx.textures.has(name)) {
        ctx.textures.set(name, node);
    }
    return name;
}
function generateTexture(ctx, node) {
    const binding = node.bindingNode;
    const name = generateTextureBinding(ctx, binding);
    // textureLoad mode - no sampler needed
    if (node.samplingMode === 'load') {
        if (!node.loadCoords) {
            throw new Error(`[builder] TextureNode '${name}' in load mode has no loadCoords`);
        }
        const coordsExpr = generateExpr(ctx, node.loadCoords);
        const levelExpr = node.loadLevel ? generateExpr(ctx, node.loadLevel) : '0';
        return `textureLoad(${name}, ${coordsExpr}, ${levelExpr})`;
    }
    // Sampling modes require a sampler
    // If no samplerNode exists (e.g., PassTextureNode), create a default one
    let samplerNode = node.samplerNode;
    if (!samplerNode) {
        samplerNode = new SamplerNode(sampler$1, name, binding.groupNode);
        // Store it on the node so it's consistent across calls
        node.samplerNode = samplerNode;
    }
    // Register the sampler (this handles deduplication by settingsKey)
    const samplerName = generateSampler(ctx, samplerNode);
    // Sampling modes - require UV coordinates
    if (!node.uvNode) {
        throw new Error(`[builder] TextureNode '${name}' has no uvNode. Set uvNode or use texture.sample(uvNode).`);
    }
    const uvExpr = generateExpr(ctx, node.uvNode);
    // Build offset suffix if present (2D/2D-array only)
    const offsetSuffix = node.offsetNode ? `, ${generateExpr(ctx, node.offsetNode)}` : '';
    // textureSampleGrad
    if (node.samplingMode === 'grad') {
        if (!node.gradNode) {
            throw new Error(`[builder] TextureNode '${name}' in grad mode has no gradNode`);
        }
        const ddx = generateExpr(ctx, node.gradNode[0]);
        const ddy = generateExpr(ctx, node.gradNode[1]);
        return `textureSampleGrad(${name}, ${samplerName}, ${uvExpr}, ${ddx}, ${ddy}${offsetSuffix})`;
    }
    // textureSampleBias
    if (node.samplingMode === 'bias') {
        if (!node.biasNode) {
            throw new Error(`[builder] TextureNode '${name}' in bias mode has no biasNode`);
        }
        const bias = generateExpr(ctx, node.biasNode);
        return `textureSampleBias(${name}, ${samplerName}, ${uvExpr}, ${bias}${offsetSuffix})`;
    }
    // textureSampleLevel
    if (node.samplingMode === 'level') {
        if (!node.levelNode) {
            throw new Error(`[builder] TextureNode '${name}' in level mode has no levelNode`);
        }
        const level = generateExpr(ctx, node.levelNode);
        return `textureSampleLevel(${name}, ${samplerName}, ${uvExpr}, ${level}${offsetSuffix})`;
    }
    // textureSample (default)
    return `textureSample(${name}, ${samplerName}, ${uvExpr}${offsetSuffix})`;
}
function generateCubeTexture(ctx, node) {
    const binding = node.bindingNode;
    const name = generateTextureBinding(ctx, binding);
    // Cube textures don't support textureLoad - only sampling modes
    // Sampling modes require a sampler
    let samplerNode = node.samplerNode;
    if (!samplerNode) {
        samplerNode = new SamplerNode(sampler$1, name, binding.groupNode);
        node.samplerNode = samplerNode;
    }
    // Register the sampler (this handles deduplication by settingsKey)
    const samplerName = generateSampler(ctx, samplerNode);
    // Cube textures require a direction vector (vec3f)
    if (!node.directionNode) {
        throw new Error(`[builder] CubeTextureNode '${name}' has no directionNode. Use cubeTexture.sample(direction).`);
    }
    const dirExpr = generateExpr(ctx, node.directionNode);
    // Cube textures do NOT support offset
    // textureSampleGrad (vec3f gradients for cube textures)
    if (node.samplingMode === 'grad') {
        if (!node.gradNode) {
            throw new Error(`[builder] CubeTextureNode '${name}' in grad mode has no gradNode`);
        }
        const ddx = generateExpr(ctx, node.gradNode[0]);
        const ddy = generateExpr(ctx, node.gradNode[1]);
        return `textureSampleGrad(${name}, ${samplerName}, ${dirExpr}, ${ddx}, ${ddy})`;
    }
    // textureSampleBias
    if (node.samplingMode === 'bias') {
        if (!node.biasNode) {
            throw new Error(`[builder] CubeTextureNode '${name}' in bias mode has no biasNode`);
        }
        const bias = generateExpr(ctx, node.biasNode);
        return `textureSampleBias(${name}, ${samplerName}, ${dirExpr}, ${bias})`;
    }
    // textureSampleLevel
    if (node.samplingMode === 'level') {
        if (!node.levelNode) {
            throw new Error(`[builder] CubeTextureNode '${name}' in level mode has no levelNode`);
        }
        const level = generateExpr(ctx, node.levelNode);
        return `textureSampleLevel(${name}, ${samplerName}, ${dirExpr}, ${level})`;
    }
    // textureSample (default)
    return `textureSample(${name}, ${samplerName}, ${dirExpr})`;
}
function generateDepthTexture(ctx, node) {
    const binding = node.bindingNode;
    const name = generateTextureBinding(ctx, binding);
    // textureLoad mode — no sampler needed
    if (node.samplingMode === 'load') {
        if (!node.loadCoords) {
            throw new Error(`[builder] DepthTextureNode '${name}' in load mode has no loadCoords`);
        }
        const coordsExpr = generateExpr(ctx, node.loadCoords);
        const levelExpr = node.loadLevel ? generateExpr(ctx, node.loadLevel) : '0';
        return `textureLoad(${name}, ${coordsExpr}, ${levelExpr})`;
    }
    // Sampling modes require a sampler
    let samplerNode = node.samplerNode;
    if (!samplerNode) {
        samplerNode = new SamplerNode(sampler$1, name, binding.groupNode);
        node.samplerNode = samplerNode;
    }
    const samplerName = generateSampler(ctx, samplerNode);
    if (!node.uvNode) {
        throw new Error(`[builder] DepthTextureNode '${name}' has no uvNode. Set uvNode or use depthTexture.sample(uvNode).`);
    }
    const uvExpr = generateExpr(ctx, node.uvNode);
    const offsetSuffix = node.offsetNode ? `, ${generateExpr(ctx, node.offsetNode)}` : '';
    // textureSampleLevel (i32 level for depth textures)
    if (node.samplingMode === 'level') {
        if (!node.levelNode) {
            throw new Error(`[builder] DepthTextureNode '${name}' in level mode has no levelNode`);
        }
        const level = generateExpr(ctx, node.levelNode);
        return `textureSampleLevel(${name}, ${samplerName}, ${uvExpr}, ${level}${offsetSuffix})`;
    }
    // textureSample (default) — returns f32
    return `textureSample(${name}, ${samplerName}, ${uvExpr}${offsetSuffix})`;
}
function generateArrayTexture(ctx, node) {
    const binding = node.bindingNode;
    const name = generateTextureBinding(ctx, binding);
    const layerExpr = generateExpr(ctx, node.layerNode);
    // textureLoad mode — no sampler needed
    // WGSL: textureLoad(t, coords, array_index, level)
    if (node.samplingMode === 'load') {
        if (!node.loadCoords) {
            throw new Error(`[builder] ArrayTextureNode '${name}' in load mode has no loadCoords`);
        }
        const coordsExpr = generateExpr(ctx, node.loadCoords);
        const levelExpr = node.loadLevel ? generateExpr(ctx, node.loadLevel) : '0';
        return `textureLoad(${name}, ${coordsExpr}, ${layerExpr}, ${levelExpr})`;
    }
    // Sampling modes require a sampler
    let samplerNode = node.samplerNode;
    if (!samplerNode) {
        samplerNode = new SamplerNode(sampler$1, name, binding.groupNode);
        node.samplerNode = samplerNode;
    }
    const samplerName = generateSampler(ctx, samplerNode);
    if (!node.uvNode) {
        throw new Error(`[builder] ArrayTextureNode '${name}' has no uvNode. Set uvNode or use arrayTexture.sample(uvNode).`);
    }
    const uvExpr = generateExpr(ctx, node.uvNode);
    const offsetSuffix = node.offsetNode ? `, ${generateExpr(ctx, node.offsetNode)}` : '';
    // textureSampleGrad(t, s, coords, array_index, ddx, ddy [, offset])
    if (node.samplingMode === 'grad') {
        if (!node.gradNode) {
            throw new Error(`[builder] ArrayTextureNode '${name}' in grad mode has no gradNode`);
        }
        const ddx = generateExpr(ctx, node.gradNode[0]);
        const ddy = generateExpr(ctx, node.gradNode[1]);
        return `textureSampleGrad(${name}, ${samplerName}, ${uvExpr}, ${layerExpr}, ${ddx}, ${ddy}${offsetSuffix})`;
    }
    // textureSampleBias(t, s, coords, array_index, bias [, offset])
    if (node.samplingMode === 'bias') {
        if (!node.biasNode) {
            throw new Error(`[builder] ArrayTextureNode '${name}' in bias mode has no biasNode`);
        }
        const bias = generateExpr(ctx, node.biasNode);
        return `textureSampleBias(${name}, ${samplerName}, ${uvExpr}, ${layerExpr}, ${bias}${offsetSuffix})`;
    }
    // textureSampleLevel(t, s, coords, array_index, level [, offset])
    if (node.samplingMode === 'level') {
        if (!node.levelNode) {
            throw new Error(`[builder] ArrayTextureNode '${name}' in level mode has no levelNode`);
        }
        const level = generateExpr(ctx, node.levelNode);
        return `textureSampleLevel(${name}, ${samplerName}, ${uvExpr}, ${layerExpr}, ${level}${offsetSuffix})`;
    }
    // textureSample(t, s, coords, array_index [, offset])
    return `textureSample(${name}, ${samplerName}, ${uvExpr}, ${layerExpr}${offsetSuffix})`;
}
function generateSampler(ctx, node) {
    const key = node.settingsKey;
    // Register sampler for binding emission (deduplicated by settings)
    if (!ctx.samplers.has(key)) {
        ctx.samplers.set(key, node);
    }
    // Return the sampler variable name (uses the registered sampler's ID for deduplication)
    const registeredSampler = ctx.samplers.get(key);
    return `${registeredSampler.samplerId}_sampler`;
}
function generateVarying(ctx, node) {
    if (ctx.stage === 'compute') {
        throw new Error(`[builder] VaryingNode not allowed in compute shaders`);
    }
    const name = node.name ?? `v_${node.id}`;
    if (ctx.stage === 'vertex') {
        // in vertex: generate the source expression (unwrap SubBuildNode)
        const sourceNode = node.node.node; // SubBuildNode.node is the actual source
        const sourceExpr = generateExpr(ctx, sourceNode);
        ctx.varyings.set(name, { node, vertexExpr: sourceExpr });
        return sourceExpr;
    }
    else {
        // in fragment: read from input
        // make sure varying is registered
        if (!ctx.varyings.has(name)) {
            ctx.varyings.set(name, { node, vertexExpr: '' });
        }
        return `input.${name}`;
    }
}
function generateBuiltin(ctx, node) {
    ctx.builtins.add(node.builtinKind);
    const builtinMap = {
        'vertex_index': 'input.vertex_index',
        'instance_index': 'input.instance_index',
        'global_invocation_id': 'global_id',
        'local_invocation_id': 'local_id',
        'local_invocation_index': 'local_index',
        'workgroup_id': 'workgroup_id',
        'num_workgroups': 'num_workgroups',
        'position': ctx.stage === 'fragment' ? 'input.position' : 'output.position',
    };
    return builtinMap[node.builtinKind] ?? `/* unknown builtin: ${node.builtinKind} */`;
}
/* function call generation */
function generateCall(ctx, node) {
    // if this calls an FnNode, make sure it's registered
    if (node.fnNode) {
        const fn = node.fnNode;
        if (!ctx.fnDefs.has(fn.fnName)) {
            const traced = fn.trace();
            ctx.fnDefs.set(fn.fnName, { fn, traced });
        }
    }
    // if this calls a WgslFunctionNode, make sure it's registered
    if (node.wgslFnNode) {
        const fn = node.wgslFnNode;
        if (!ctx.wgslFnDefs.has(fn.code)) {
            ctx.wgslFnDefs.set(fn.code, fn);
            // also register includes
            for (const inc of fn.includes) {
                if (inc instanceof WgslFunctionNode && !ctx.wgslFnDefs.has(inc.code)) {
                    ctx.wgslFnDefs.set(inc.code, inc);
                }
            }
        }
    }
    const args = node.args.map(a => generateExpr(ctx, a));
    // handle special cases
    if (node.fn === 'negate' && args.length === 1) {
        return `(-${args[0]})`;
    }
    if (node.fn === 'not' && args.length === 1) {
        return `(!${args[0]})`;
    }
    // atomic functions need pointer reference
    const atomicFns = [
        'atomicAdd', 'atomicSub', 'atomicMax', 'atomicMin',
        'atomicAnd', 'atomicOr', 'atomicXor',
        'atomicStore', 'atomicLoad', 'atomicExchange', 'atomicCompareExchangeWeak',
    ];
    if (atomicFns.includes(node.fn) && args.length >= 1) {
        const [ptr, ...rest] = args;
        return `${node.fn}(&${ptr}, ${rest.join(', ')})`;
    }
    return `${node.fn}(${args.join(', ')})`;
}
/* statement generation */
function generateStmt(ctx, node) {
    const ind = '    '.repeat(ctx.indentLevel);
    if (node instanceof LetNode) {
        const init = generateExpr(ctx, node.init);
        ctx.code.push(`${ind}let ${node.varName} = ${init};`);
        ctx.nodeVars.set(node.id, node.varName);
    }
    else if (node instanceof VarNode) {
        const init = generateExpr(ctx, node.init);
        ctx.code.push(`${ind}var ${node.varName} = ${init};`);
        ctx.nodeVars.set(node.id, node.varName);
    }
    else if (node instanceof AssignNode) {
        const target = generateExpr(ctx, node.target);
        const value = generateExpr(ctx, node.value);
        ctx.code.push(`${ind}${target} = ${value};`);
    }
    else if (node instanceof IfNode) {
        generateIfStmt(ctx, node);
    }
    else if (node instanceof LoopNode) {
        generateLoopStmt(ctx, node);
    }
    else if (node instanceof BreakNode) {
        ctx.code.push(`${ind}break;`);
    }
    else if (node instanceof ContinueNode) {
        ctx.code.push(`${ind}continue;`);
    }
    else if (node instanceof DiscardNode) {
        ctx.code.push(`${ind}discard;`);
    }
    else if (node instanceof ReturnNode) {
        if (node.value.type.wgslType === 'void') {
            ctx.code.push(`${ind}return;`);
        }
        else {
            const val = generateExpr(ctx, node.value);
            ctx.code.push(`${ind}return ${val};`);
        }
    }
    else if (node instanceof StackNode) {
        for (const child of node.body) {
            generateStmt(ctx, child);
        }
    }
    else {
        // treat as expression statement
        const expr = generateExpr(ctx, node);
        if (expr && !expr.startsWith('/*')) {
            ctx.code.push(`${ind}${expr};`);
        }
    }
}
function generateIfStmt(ctx, node) {
    const ind = '    '.repeat(ctx.indentLevel);
    const cond = generateExpr(ctx, node.condition);
    ctx.code.push(`${ind}if (${cond}) {`);
    ctx.indentLevel++;
    for (const child of node.thenBody.body) {
        generateStmt(ctx, child);
    }
    ctx.indentLevel--;
    // Handle else-if branches
    for (const branch of node.elseIfBranches) {
        const branchCond = generateExpr(ctx, branch.condition);
        ctx.code.push(`${ind}} else if (${branchCond}) {`);
        ctx.indentLevel++;
        for (const child of branch.body.body) {
            generateStmt(ctx, child);
        }
        ctx.indentLevel--;
    }
    // Handle else branch
    if (node.elseBody && node.elseBody.body.length > 0) {
        ctx.code.push(`${ind}} else {`);
        ctx.indentLevel++;
        for (const child of node.elseBody.body) {
            generateStmt(ctx, child);
        }
        ctx.indentLevel--;
    }
    ctx.code.push(`${ind}}`);
}
function generateLoopStmt(ctx, node) {
    const { config, loopVar, body } = node;
    // Generate a unique WGSL variable name for this loop
    const depth = ctx.indentLevel - 1;
    const wgslVarName = `i_${depth}_${ctx.varCounter++}`;
    // Register the loop variable so references resolve to the WGSL name
    ctx.nodeVars.set(loopVar.id, wgslVarName);
    // Build loop header based on config type
    let loopHeader;
    if (typeof config === 'number') {
        loopHeader = `for (var ${wgslVarName}: i32 = 0i; ${wgslVarName} < ${config}i; ${wgslVarName}++)`;
    }
    else if (config instanceof LiteralNode || config instanceof UniformNode) {
        const endExpr = generateExpr(ctx, config);
        loopHeader = `for (var ${wgslVarName}: i32 = 0i; ${wgslVarName} < ${endExpr}; ${wgslVarName}++)`;
    }
    else if (typeof config === 'object' && config !== null && !(config instanceof LiteralNode) && !(config instanceof UniformNode)) {
        const cfg = config;
        const typeDesc = cfg.type ?? i32$1;
        const typeStr = typeDesc.wgslType;
        const getExpr = (v) => {
            if (v === undefined)
                return undefined;
            if (typeof v === 'number')
                return constLiteral(typeStr, v);
            return generateExpr(ctx, v);
        };
        const startExpr = getExpr(cfg.start) ?? '0i';
        const endExpr = getExpr(cfg.end) ?? '0i';
        const condition = cfg.condition ?? '<';
        loopHeader = `for (var ${wgslVarName}: ${typeStr} = ${startExpr}; ${wgslVarName} ${condition} ${endExpr}; ${wgslVarName}++)`;
    }
    else {
        loopHeader = `/* unknown loop range type */`;
    }
    // Emit loop with pre-captured body
    const ind = '    '.repeat(ctx.indentLevel);
    ctx.code.push(`${ind}${loopHeader} {`);
    ctx.indentLevel++;
    for (const stmt of body.body) {
        generateStmt(ctx, stmt);
    }
    ctx.indentLevel--;
    ctx.code.push(`${ind}}`);
}
/* wgsl code assembly */
/**
 * Emit module-scope variable declarations (var<private> and var<workgroup>).
 * These are emitted before bindings in the shader.
 */
function emitModuleScopeVars(ctx) {
    const lines = [];
    // Emit private variables
    for (const [, node] of ctx.privateVars) {
        if (node.init) {
            // With initializer - need to generate init expression in a temporary context
            // Since these are module-scope, we can't use function-scope expressions directly
            // The init must be a const-expression (compile-time constant)
            const initExpr = generateModuleScopeInitExpr(node.init);
            lines.push(`var<private> ${node.varName}: ${node.type.wgslType} = ${initExpr};`);
        }
        else {
            // Without initializer
            lines.push(`var<private> ${node.varName}: ${node.type.wgslType};`);
        }
    }
    // Emit workgroup variables (only in compute shaders - already validated in generateExpr)
    for (const [, node] of ctx.workgroupVars) {
        // Workgroup variables cannot have initializers in WGSL
        lines.push(`var<workgroup> ${node.varName}: ${node.type.wgslType};`);
    }
    return lines.length > 0 ? lines.join('\n') + '\n' : '';
}
/**
 * Generate a const-expression for module-scope variable initializers.
 * Module-scope initializers must be const-expressions (compile-time constants).
 */
function generateModuleScopeInitExpr(node) {
    if (node instanceof LiteralNode) {
        return constLiteral(node.type.wgslType, node.value);
    }
    else if (node instanceof ConstructNode) {
        const args = node.args.map(a => generateModuleScopeInitExpr(a));
        return `${node.type.wgslType}(${args.join(', ')})`;
    }
    else if (node instanceof BinopNode) {
        const left = generateModuleScopeInitExpr(node.left);
        const right = generateModuleScopeInitExpr(node.right);
        return `(${left} ${node.op} ${right})`;
    }
    else if (node instanceof CallNode) {
        // Only const-evaluable built-in functions are allowed
        const args = node.args.map(a => generateModuleScopeInitExpr(a));
        return `${node.fn}(${args.join(', ')})`;
    }
    else {
        throw new Error(`[builder] Module-scope variable initializer must be a const-expression. ` +
            `Got ${node.constructor.name}. Only literals, constructors, and const-evaluable ` +
            `built-in functions are allowed.`);
    }
}
/**
 * Emit all bindings (uniforms, storage, textures, samplers) following Three.js pattern.
 *
 * Three.js pattern:
 * - Each named group (render, object, etc.) gets its own @group(N) index
 * - Groups are sorted by UniformGroup.order
 * - The @group(N) index is the SORTED ARRAY POSITION, not the order value directly
 * - Within each group, bindings get sequential @binding(M) indices starting from 0
 */
function emitAllBindings(ctx) {
    // step 1: collect all resources by their group
    const groupsByName = new Map();
    // helper to get or create a group
    const getGroup = (groupNode) => {
        const name = groupNode.name;
        if (!groupsByName.has(name)) {
            groupsByName.set(name, {
                groupNode,
                groupIndex: groupNode.order, // temporary, will be reassigned after sorting
                uniforms: [],
                storages: [],
                textures: [],
                samplers: [],
            });
        }
        return groupsByName.get(name);
    };
    // collect uniforms
    for (const [_name, { node, group }] of ctx.uniforms) {
        getGroup(group).uniforms.push(node);
    }
    // collect storage buffers
    for (const [name, node] of ctx.storages) {
        getGroup(node.groupNode).storages.push({ name, node });
    }
    // collect textures
    for (const [name, node] of ctx.textures) {
        getGroup(node.groupNode).textures.push({ name, node });
    }
    // collect samplers (deduplicated by settingsKey)
    for (const [_settingsKey, node] of ctx.samplers) {
        const name = node.samplerId;
        getGroup(node.groupNode).samplers.push({ name, node });
    }
    // step 2: sort groups by their order, then assign sequential group indices
    // This follows Three.js pattern: @group(N) is the sorted array position
    const sortedGroups = [...groupsByName.values()].sort((a, b) => a.groupNode.order - b.groupNode.order);
    // Reassign groupIndex to be the sorted array position
    for (let i = 0; i < sortedGroups.length; i++) {
        sortedGroups[i].groupIndex = i;
    }
    // step 3: emit WGSL and build result arrays
    const lines = [];
    const uniformBlocks = [];
    const storageEntries = [];
    const textureEntries = [];
    const samplerEntries = [];
    // emit struct definitions required by storage bindings (topological order)
    for (const [_typeName, def] of ctx.structDefs) {
        lines.push(`struct ${def.wgslType} {`);
        for (const member of def.members) {
            lines.push(`    ${member.name}: ${member.type.wgslType},`);
        }
        lines.push(`}`);
        lines.push('');
    }
    for (const group of sortedGroups) {
        const groupIndex = group.groupIndex;
        const groupName = group.groupNode.name;
        let bindingIndex = 0;
        // emit uniform struct and binding (if any uniforms)
        if (group.uniforms.length > 0) {
            lines.push(`struct Uniforms_${groupName} {`);
            const members = [];
            let offset = 0;
            for (const u of group.uniforms) {
                const align = wgslAlign(u.type.wgslType);
                const size = wgslSize(u.type.wgslType);
                // align offset
                offset = Math.ceil(offset / align) * align;
                lines.push(`    ${u.name}: ${u.type.wgslType},`);
                members.push({
                    uniformId: u.name,
                    schema: u.type,
                    offset,
                    size,
                    node: u,
                });
                offset += size;
            }
            lines.push(`}`);
            lines.push(`@group(${groupIndex}) @binding(${bindingIndex}) var<uniform> uniforms_${groupName}: Uniforms_${groupName};`);
            lines.push('');
            // Compute struct alignment (max alignment of all members)
            let structAlign = 4;
            for (const u of group.uniforms) {
                structAlign = Math.max(structAlign, wgslAlign(u.type.wgslType));
            }
            // Round up totalBytes to struct alignment
            const totalBytes = Math.ceil(offset / structAlign) * structAlign;
            uniformBlocks.push({
                groupName,
                groupIndex,
                binding: bindingIndex,
                shared: group.groupNode.shared,
                members,
                totalBytes,
                groupNode: group.groupNode,
            });
            bindingIndex++;
        }
        // emit storage bindings
        for (const { name, node } of group.storages) {
            const access = ctx.stage === 'compute' ? node.access : 'read';
            const accessStr = access === 'read_write' ? 'read_write' : 'read';
            lines.push(`@group(${groupIndex}) @binding(${bindingIndex}) var<storage, ${accessStr}> ${name}: ${node.storageType};`);
            storageEntries.push({
                node,
                name,
                type: node.storageType,
                access,
                group: groupIndex,
                binding: bindingIndex,
            });
            bindingIndex++;
        }
        // emit texture and sampler bindings
        for (const { name, node } of group.textures) {
            lines.push(`@group(${groupIndex}) @binding(${bindingIndex}) var ${name}: ${node.type.wgslType};`);
            textureEntries.push({
                textureId: name,
                type: node.type.wgslType,
                group: groupIndex,
                binding: bindingIndex,
                node,
            });
            bindingIndex++;
        }
        for (const { name, node } of group.samplers) {
            // node is now a SamplerNode - get sampler type from its compare property
            const samplerType = node.compare ? 'sampler_comparison' : 'sampler';
            lines.push(`@group(${groupIndex}) @binding(${bindingIndex}) var ${name}_sampler: ${samplerType};`);
            samplerEntries.push({
                samplerId: `${name}_sampler`,
                type: samplerType,
                group: groupIndex,
                binding: bindingIndex,
                samplerNode: node,
            });
            bindingIndex++;
        }
    }
    return {
        wgsl: lines.join('\n'),
        uniformBlocks,
        storageEntries,
        textureEntries,
        samplerEntries,
    };
}
function emitWgslFunctions(ctx) {
    const lines = [];
    const emitted = new Set();
    // emit wgslFn functions in dependency order
    for (const [_code, fn] of ctx.wgslFnDefs) {
        // emit includes first
        for (const inc of fn.includes) {
            if (inc instanceof WgslFunctionNode && !emitted.has(inc.code)) {
                lines.push(inc.code.trim());
                lines.push('');
                emitted.add(inc.code);
            }
        }
        if (!emitted.has(fn.code)) {
            lines.push(fn.code.trim());
            lines.push('');
            emitted.add(fn.code);
        }
    }
    return lines.join('\n');
}
function emitDslFunctions(ctx) {
    const lines = [];
    for (const [name, { fn, traced }] of ctx.fnDefs) {
        // build parameter list
        const params = traced.params.map((p, i) => {
            const pName = p.paramName ?? `p${i}`;
            return `${pName}: ${p.type.wgslType}`;
        }).join(', ');
        // generate function body
        const fnCtx = createContext(ctx.stage, ctx.isRender);
        fnCtx.usageCount = ctx.usageCount;
        fnCtx.fnDefs = ctx.fnDefs;
        fnCtx.wgslFnDefs = ctx.wgslFnDefs;
        fnCtx.textures = ctx.textures;
        fnCtx.samplers = ctx.samplers;
        fnCtx.uniforms = ctx.uniforms;
        fnCtx.storages = ctx.storages;
        // register param names in context
        for (const p of traced.params) {
            fnCtx.nodeVars.set(p.id, p.paramName ?? `p${p.paramIndex}`);
        }
        // generate statements from body
        for (const stmt of traced.body.body) {
            generateStmt(fnCtx, stmt);
        }
        // generate return expression
        const returnExpr = generateExpr(fnCtx, traced.output);
        lines.push(`fn ${name}(${params}) -> ${fn.type.wgslType} {`);
        lines.push(...fnCtx.code);
        if (fn.type.wgslType !== 'void') {
            lines.push(`    return ${returnExpr};`);
        }
        lines.push(`}`);
        lines.push('');
    }
    return lines.join('\n');
}
/* vertex shader generation */
function generateVertexShader(slots, ctx) {
    const lines = [];
    // generate position expression
    const posExpr = generateExpr(ctx, slots.position);
    // check if we have any vertex inputs (attributes or builtins)
    const hasVertexIndex = ctx.builtins.has('vertex_index');
    const hasInstanceIndex = ctx.builtins.has('instance_index');
    const hasInputs = ctx.attributes.size > 0 || hasVertexIndex || hasInstanceIndex;
    // emit input struct only if we have inputs (WGSL structs must have at least one member)
    if (hasInputs) {
        lines.push('struct VertexInput {');
        for (const [, attr] of ctx.attributes) {
            lines.push(`    @location(${attr.location}) ${attr.shaderName}: ${attr.type},`);
        }
        if (hasVertexIndex) {
            lines.push(`    @builtin(vertex_index) vertex_index: u32,`);
        }
        if (hasInstanceIndex) {
            lines.push(`    @builtin(instance_index) instance_index: u32,`);
        }
        lines.push('}');
        lines.push('');
    }
    // emit output struct
    lines.push('struct VertexOutput {');
    lines.push('    @builtin(position) position: vec4f,');
    let varyingLoc = 0;
    for (const [name, { node }] of ctx.varyings) {
        let interp = '';
        if (node.interpolationType) {
            interp = ` @interpolate(${node.interpolationType}`;
            if (node.interpolationSampling) {
                interp += `, ${node.interpolationSampling}`;
            }
            interp += ')';
        }
        lines.push(`    @location(${varyingLoc})${interp} ${name}: ${node.type.wgslType},`);
        varyingLoc++;
    }
    lines.push('}');
    lines.push('');
    // emit main function - omit input parameter if no inputs
    lines.push('@vertex');
    if (hasInputs) {
        lines.push('fn vs_main(input: VertexInput) -> VertexOutput {');
    }
    else {
        lines.push('fn vs_main() -> VertexOutput {');
    }
    lines.push('    var output: VertexOutput;');
    lines.push(...ctx.code);
    lines.push(`    output.position = ${posExpr};`);
    // assign varyings
    for (const [name, { vertexExpr }] of ctx.varyings) {
        lines.push(`    output.${name} = ${vertexExpr};`);
    }
    lines.push('    return output;');
    lines.push('}');
    return lines.join('\n');
}
/* fragment shader generation */
function generateFragmentShader(colorNode, ctx, varyings) {
    const lines = [];
    // copy varyings from vertex stage
    for (const [name, data] of varyings) {
        if (!ctx.varyings.has(name)) {
            ctx.varyings.set(name, data);
        }
    }
    // generate color expression
    const colorExpr = generateExpr(ctx, colorNode);
    // check if we have any fragment inputs (varyings or builtins)
    const hasFragCoord = ctx.builtins.has('position');
    const hasInputs = ctx.varyings.size > 0 || hasFragCoord;
    // emit input struct only if we have inputs (WGSL structs must have at least one member)
    if (hasInputs) {
        lines.push('struct FragmentInput {');
        if (hasFragCoord) {
            lines.push('    @builtin(position) position: vec4f,');
        }
        let varyingLoc = 0;
        for (const [name, { node }] of ctx.varyings) {
            let interp = '';
            if (node.interpolationType) {
                interp = ` @interpolate(${node.interpolationType}`;
                if (node.interpolationSampling) {
                    interp += `, ${node.interpolationSampling}`;
                }
                interp += ')';
            }
            lines.push(`    @location(${varyingLoc})${interp} ${name}: ${node.type.wgslType},`);
            varyingLoc++;
        }
        lines.push('}');
        lines.push('');
    }
    // check for MRT
    const isMRT = colorNode instanceof MRTNode;
    const mrtNode = isMRT ? colorNode : null;
    // Pre-generate all MRT output expressions NOW so that CSE let-declarations
    // are pushed into ctx.code before we emit the function body.
    // (For non-MRT, colorExpr above already did this.)
    let mrtExprs = null;
    if (isMRT && mrtNode) {
        mrtExprs = [];
        if (mrtNode.members.length > 0) {
            for (let i = 0; i < mrtNode.members.length; i++) {
                const member = mrtNode.members[i];
                if (!member)
                    continue;
                const name = mrtNode._resolvedNames[i] || `output_${i}`;
                const expr = generateExpr(ctx, member);
                mrtExprs.push({ name, expr });
            }
        }
        else {
            for (const name in mrtNode.outputNodes) {
                const expr = generateExpr(ctx, mrtNode.outputNodes[name]);
                mrtExprs.push({ name, expr });
            }
        }
    }
    if (isMRT && mrtNode) {
        // generate MRT output struct with all outputs
        lines.push('struct FragmentOutput {');
        // use members array (populated by resolveOutputs) for @location order
        // fall back to outputNodes keys if members not resolved yet
        if (mrtNode.members.length > 0) {
            // members are resolved - use them in order
            for (let i = 0; i < mrtNode.members.length; i++) {
                const member = mrtNode.members[i];
                if (!member)
                    continue; // sparse array possible
                const name = mrtNode._resolvedNames[i] || `output_${i}`;
                const wgslType = member.type.wgslType === 'vec4f' ? 'vec4f' : 'vec4f'; // MRT always outputs vec4f
                lines.push(`    @location(${i}) ${name}: ${wgslType},`);
            }
        }
        else {
            // fallback: use outputNodes directly (unresolved order)
            let loc = 0;
            for (const name in mrtNode.outputNodes) {
                lines.push(`    @location(${loc}) ${name}: vec4f,`);
                loc++;
            }
        }
        lines.push('}');
    }
    lines.push('');
    // emit main function - omit input parameter if no inputs
    lines.push('@fragment');
    if (isMRT && mrtNode) {
        if (hasInputs) {
            lines.push('fn fs_main(input: FragmentInput) -> FragmentOutput {');
        }
        else {
            lines.push('fn fs_main() -> FragmentOutput {');
        }
        lines.push('    var output: FragmentOutput;');
    }
    else {
        if (hasInputs) {
            lines.push('fn fs_main(input: FragmentInput) -> @location(0) vec4f {');
        }
        else {
            lines.push('fn fs_main() -> @location(0) vec4f {');
        }
    }
    lines.push(...ctx.code);
    if (isMRT && mrtExprs) {
        // Use pre-generated expressions (generated before ctx.code was emitted)
        for (const { name, expr } of mrtExprs) {
            lines.push(`    output.${name} = ${expr};`);
        }
        lines.push('    return output;');
    }
    else {
        lines.push(`    return ${colorExpr};`);
    }
    lines.push('}');
    return lines.join('\n');
}
/* compute shader generation */
function generateComputeShader(node, ctx) {
    const lines = [];
    // trace the FnNode
    const fn = node.fn;
    const traced = fn.trace();
    // generate statements from body
    for (const stmt of traced.body.body) {
        generateStmt(ctx, stmt);
    }
    // generate output if non-void
    if (fn.type.wgslType !== 'void') {
        const outputExpr = generateExpr(ctx, traced.output);
        ctx.code.push(`    // Output: ${outputExpr}`);
    }
    // build workgroup size
    const wgSize = node.workgroupSize ?? [64, 1, 1];
    const [WX, WY, WZ] = wgSize;
    // check if computeIndex is used
    const usesComputeIndex = (ctx.usageCount.get(computeIndex.id) ?? 0) > 0;
    if (usesComputeIndex) {
        // computeIndex depends on global_id and num_workgroups
        ctx.builtins.add('global_invocation_id');
        ctx.builtins.add('num_workgroups');
        // emit private variable for computeIndex
        lines.push('var<private> computeIndex: u32;');
        lines.push('');
    }
    // emit main function
    lines.push(`@compute @workgroup_size(${WX}, ${WY}, ${WZ})`);
    lines.push('fn cs_main(');
    const builtinParams = [];
    if (ctx.builtins.has('global_invocation_id')) {
        builtinParams.push('    @builtin(global_invocation_id) global_id: vec3u');
    }
    if (ctx.builtins.has('local_invocation_id')) {
        builtinParams.push('    @builtin(local_invocation_id) local_id: vec3u');
    }
    if (ctx.builtins.has('local_invocation_index')) {
        builtinParams.push('    @builtin(local_invocation_index) local_index: u32');
    }
    if (ctx.builtins.has('workgroup_id')) {
        builtinParams.push('    @builtin(workgroup_id) workgroup_id: vec3u');
    }
    if (ctx.builtins.has('num_workgroups')) {
        builtinParams.push('    @builtin(num_workgroups) num_workgroups: vec3u');
    }
    lines.push(builtinParams.join(',\n'));
    lines.push(') {');
    // compute linearized index at start of function (only if used)
    if (usesComputeIndex) {
        lines.push(`    computeIndex = global_id.x + global_id.y * (${WX}u * num_workgroups.x) + global_id.z * (${WX}u * num_workgroups.x) * (${WY}u * num_workgroups.y);`);
    }
    lines.push(...ctx.code);
    lines.push('}');
    return lines.join('\n');
}

/** create a new NodeManager state */
function createNodeManagerState() {
    return {
        nodeStates: new WeakMap(),
        computeStates: new Map(),
        nodeFrame: createNodeFrame(),
    };
}
/**
 * Get the NodeFrame for rendering a specific RenderObject.
 * Sets the frame's context properties from the RenderObject.
 */
function getNodeFrameForRender(state, renderObject) {
    const frame = state.nodeFrame;
    frame.object = renderObject.mesh;
    frame.camera = renderObject.camera;
    frame.material = renderObject.material;
    frame.scene = renderObject.scene;
    // renderer, encoder, width, height are set by the renderer before calling
    return frame;
}
/**
 * Set the NodeBuilderState for a RenderObject.
 */
function setNodeBuilderState(state, renderObject, nodeState) {
    state.nodeStates.set(renderObject, nodeState);
    renderObject.nodeBuilderState = nodeState;
}
/**
 * Compile and set the NodeBuilderState for a RenderObject.
 *
 * @param state the NodeManager state
 * @param renderObject the RenderObject to compile for
 * @param cacheKey the pipeline cache key
 * @returns the compiled NodeBuilderState and the raw CompileResult
 */
function compileNodeState(state, renderObject, cacheKey) {
    const material = renderObject.material;
    // compile the material's node graph
    const compileResult = compile({
        position: material.vertexNode,
        color: material.fragmentNode,
        depth: material.depthNode,
    });
    // create NodeBuilderState from compile result (pass renderContext for shared bind group caching)
    const nodeState = createNodeBuilderState(compileResult, cacheKey, renderObject.renderContext);
    // store in manager and on render object
    setNodeBuilderState(state, renderObject, nodeState);
    // record versions at compilation time for change detection
    renderObject.materialVersion = material.version;
    renderObject.geometryVersion = renderObject.geometry.version;
    return { nodeState, compileResult };
}
/**
 * Check if a RenderObject needs node recompilation.
 *
 * Uses version comparison instead of string key comparison for performance.
 * Recompilation is needed when material or geometry version has changed
 * since last compilation.
 */
function needsNodeUpdate(_state, renderObject) {
    // No nodeBuilderState means never compiled
    if (!renderObject.nodeBuilderState)
        return true;
    // Check if material or geometry has changed since last compilation
    return (renderObject.material.version !== renderObject.materialVersion ||
        renderObject.geometry.version !== renderObject.geometryVersion);
}
/**
 * Run updateBefore for a RenderObject's nodes.
 *
 * updateBefore is called before the draw call for nodes that need to
 * perform GPU work (compute passes, render to texture, etc.)
 *
 * @param state the NodeManager state
 * @param renderObject the RenderObject
 */
function updateBefore(state, renderObject) {
    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState)
        return;
    const frame = getNodeFrameForRender(state, renderObject);
    for (const node of nodeState.updateBeforeNodes) {
        frame.updateBeforeNode(node);
    }
}
/**
 * Run update for a RenderObject's nodes.
 *
 * update is called to execute node logic each frame/render/object.
 * (e.g., InspectorNode registering with inspector)
 *
 * @param state the NodeManager state
 * @param renderObject the RenderObject
 */
function updateForRender$1(state, renderObject) {
    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState)
        return;
    const frame = getNodeFrameForRender(state, renderObject);
    for (const node of nodeState.updateNodes) {
        frame.updateNode(node);
    }
}
/**
 * Run updateAfter for a RenderObject's nodes.
 *
 * updateAfter is called after the draw call for cleanup, readback, etc.
 *
 * @param state the NodeManager state
 * @param renderObject the RenderObject
 */
function updateAfter(state, renderObject) {
    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState)
        return;
    const frame = getNodeFrameForRender(state, renderObject);
    for (const node of nodeState.updateAfterNodes) {
        frame.updateAfterNode(node);
    }
}
/**
 * Get the NodeBuilderState for a ComputeNode.
 * Compiles the compute shader if not already compiled.
 *
 * @param state the NodeManager state
 * @param computeNode the ComputeNode
 * @param context the BindingContext for shared bind group caching
 * @returns the NodeBuilderState
 */
function getForCompute$1(state, computeNode, context) {
    let nodeState = state.computeStates.get(computeNode.id);
    if (!nodeState) {
        nodeState = compileComputeNode(state, computeNode, context);
    }
    return nodeState;
}
/**
 * Update uniform nodes for a ComputeNode before dispatch.
 * Calls the update() method on all updateNodes.
 *
 * Note: The node must already be compiled via getForCompute().
 *
 * @param state the NodeManager state
 * @param computeNode the ComputeNode
 */
function updateForCompute(state, computeNode) {
    const nodeState = state.computeStates.get(computeNode.id);
    if (!nodeState)
        return; // Not compiled yet - should not happen in normal flow
    const frame = state.nodeFrame;
    for (const node of nodeState.updateNodes) {
        frame.updateNode(node);
    }
}
/**
 * Compile a ComputeNode and cache the result.
 *
 * @param state the NodeManager state
 * @param computeNode the ComputeNode to compile
 * @param context the BindingContext for shared bind group caching
 * @returns the compiled NodeBuilderState
 */
function compileComputeNode(state, computeNode, context) {
    const compileResult = compileCompute(computeNode);
    // extract update nodes from the compile result
    // for compute, we use the uniform update callbacks
    const updateNodes = [];
    for (const ug of compileResult.uniformGroups) {
        for (const member of ug.members) {
            const node = member.node;
            if (node.update) {
                updateNodes.push({
                    id: node.id,
                    updateType: node.updateType ?? 'frame',
                    update: (frame) => {
                        node.update(frame);
                        return true;
                    },
                });
            }
        }
    }
    // Create NodeBuilderState for compute with context for shared bind group caching
    const nodeState = createNodeBuilderStateForCompute(compileResult, context);
    // Inject the extracted updateNodes
    nodeState.updateNodes = updateNodes;
    state.computeStates.set(computeNode.id, nodeState);
    return nodeState;
}
/**
 * Remove the cached NodeBuilderState for a ComputeNode.
 * Called when a ComputeNode is disposed.
 *
 * @param state the NodeManager state
 * @param computeNode the ComputeNode being disposed
 */
function deleteForCompute(state, computeNode) {
    state.computeStates.delete(computeNode.id);
}

/** create a bind group layout cache */
function createBindGroupLayoutCache() {
    return { cache: new Map() };
}
/**
 * Get or create a bind group layout for the given entries.
 * Uses a stable hash of the entries as the cache key.
 */
function getBindGroupLayout(cache, device, entries) {
    const key = makeBindGroupLayoutKey(entries);
    let layout = cache.cache.get(key);
    if (!layout) {
        layout = device.createBindGroupLayout({ entries });
        cache.cache.set(key, layout);
    }
    return layout;
}
function makeBindGroupLayoutKey(entries) {
    const normalized = entries.map(e => ({
        b: e.binding,
        v: e.visibility,
        buf: e.buffer ? { t: e.buffer.type } : null,
        sam: e.sampler ? { t: e.sampler.type } : null,
        tex: e.texture ? { s: e.texture.sampleType, v: e.texture.viewDimension } : null,
        stor: e.storageTexture ? { f: e.storageTexture.format, a: e.storageTexture.access, v: e.storageTexture.viewDimension } : null,
    }));
    return hashString(JSON.stringify(normalized));
}
function hashString(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return (hash >>> 0).toString(36);
}
/**
 * Build bind group layouts from NodeBuilderState bindings for compute pipelines.
 *
 * @param device - The GPU device
 * @param bindings - The bindings from NodeBuilderState
 * @param layoutCache - Cache for bind group layouts
 * @returns Array of GPUBindGroupLayout in group index order
 */
function buildComputeBindGroupLayouts(device, bindings, layoutCache) {
    const vis = GPUShaderStage.COMPUTE;
    // Sort bindings by group index
    const sortedBindings = [...bindings].sort((a, b) => a.groupIndex - b.groupIndex);
    const layouts = [];
    for (const bindGroup of sortedBindings) {
        const entries = [];
        for (const binding of bindGroup.bindings) {
            switch (binding.kind) {
                case 'uniform':
                    entries.push({
                        binding: binding.block.binding,
                        visibility: vis,
                        buffer: { type: 'uniform' },
                    });
                    break;
                case 'storage':
                    entries.push({
                        binding: binding.entry.binding,
                        visibility: vis,
                        buffer: {
                            type: binding.entry.access === 'read_write'
                                ? 'storage'
                                : 'read-only-storage',
                        },
                    });
                    break;
                case 'texture': {
                    const texLayout = {};
                    const wgslType = binding.entry.type;
                    if (wgslType.includes('cube_array'))
                        texLayout.viewDimension = 'cube-array';
                    else if (wgslType.includes('cube'))
                        texLayout.viewDimension = 'cube';
                    else if (wgslType.includes('2d_array'))
                        texLayout.viewDimension = '2d-array';
                    else if (wgslType.includes('3d'))
                        texLayout.viewDimension = '3d';
                    if (wgslType.startsWith('texture_depth'))
                        texLayout.sampleType = 'depth';
                    entries.push({
                        binding: binding.entry.binding,
                        visibility: vis,
                        texture: texLayout,
                    });
                    break;
                }
                case 'sampler':
                    entries.push({
                        binding: binding.entry.binding,
                        visibility: vis,
                        sampler: { type: binding.entry.type === 'sampler_comparison' ? 'comparison' : 'filtering' },
                    });
                    break;
            }
        }
        // Sort entries by binding index for consistent cache keys
        entries.sort((a, b) => a.binding - b.binding);
        layouts.push(getBindGroupLayout(layoutCache, device, entries));
    }
    return layouts;
}

const DEPTH_FORMAT = 'depth24plus';
/**
 * Create a pipelines state.
 */
function createPipelinesState() {
    return {
        bindGroupLayoutCache: createBindGroupLayoutCache(),
        renderPipelines: new Map(),
        computePipelines: new Map(),
    };
}
/**
 * Get cache statistics.
 */
function getStats(state) {
    return {
        renderCount: state.renderPipelines.size,
        computeCount: state.computePipelines.size,
        bindGroupLayoutCount: state.bindGroupLayoutCache.cache.size,
    };
}
/**
 * Get or create a render pipeline for a RenderObject.
 *
 * @param state - The pipelines state
 * @param renderObject - The RenderObject (must have nodeBuilderState set)
 * @param bindGroupLayouts - The bind group layouts for the pipeline
 * @param colorFormat - The color texture format
 * @param depthFormat - The depth texture format (null for no depth)
 * @param promises - Optional array to collect async compilation promises (for compileAsync)
 * @returns The render pipeline entry
 */
function getForRender(state, device, renderObject, bindGroupLayouts, colorFormat, depthFormat, promises = null) {
    const cacheKey = getCachedPipelineKey(renderObject, renderObject.renderContext.sampleCount, colorFormat, depthFormat ?? undefined, makeRenderPipelineKey);
    let entry = state.renderPipelines.get(cacheKey);
    if (entry)
        return entry;
    // Create new entry
    const nodeState = renderObject.nodeBuilderState;
    entry = {
        pipeline: null,
        cacheKey,
    };
    state.renderPipelines.set(cacheKey, entry);
    // Build pipeline descriptor
    const descriptor = buildRenderPipelineDescriptor(device, renderObject, nodeState, bindGroupLayouts, colorFormat, depthFormat);
    if (promises === null) {
        // Sync compilation
        entry.pipeline = device.createRenderPipeline(descriptor);
    }
    else {
        // Async compilation
        const p = (async () => {
            try {
                entry.pipeline = await device.createRenderPipelineAsync(descriptor);
            }
            catch (err) {
                console.error('[pipelines] render pipeline compilation failed:', err);
            }
        })();
        promises.push(p);
    }
    return entry;
}
function buildRenderPipelineDescriptor(device, renderObject, nodeState, bindGroupLayouts, colorFormat, depthFormat) {
    const material = renderObject.material;
    const geometry = renderObject.geometry;
    const renderContext = renderObject.renderContext;
    // Build vertex buffer layouts from geometry attributes
    const vertexBufferLayouts = buildVertexBufferLayouts(geometry, nodeState);
    // Create pipeline layout
    const pipelineLayout = device.createPipelineLayout({
        bindGroupLayouts,
    });
    // Create shader module (vertexCode contains combined vertex+fragment shader)
    const shaderCode = nodeState.vertexCode;
    const shaderModule = device.createShaderModule({
        code: shaderCode,
    });
    shaderModule.getCompilationInfo().then((info) => {
        for (const msg of info.messages) {
            if (msg.type === 'error') {
                console.error(`[gpucat shader error] line ${msg.lineNum}: ${msg.message}\n${shaderCode}`);
            }
        }
    });
    // Build color targets (supports MRT). Empty for depth-only pipelines.
    const targetCount = getTargetCount(material.fragmentNode);
    const colorTargets = [];
    for (let i = 0; i < targetCount; i++) {
        colorTargets.push({
            format: colorFormat,
            blend: material.transparent ? getDefaultBlendState() : undefined,
            writeMask: GPUColorWrite.ALL,
        });
    }
    // Build pipeline descriptor
    // For depth-only pipelines (null fragmentNode), omit the fragment stage entirely.
    // WebGPU spec section 23.2.8 explicitly supports "No Color Output" mode:
    // the pipeline still rasterizes and produces depth values from vertex positions.
    const fragment = targetCount > 0
        ? {
            module: shaderModule,
            entryPoint: 'fs_main',
            targets: colorTargets,
        }
        : undefined;
    return {
        layout: pipelineLayout,
        vertex: {
            module: shaderModule,
            entryPoint: 'vs_main',
            buffers: vertexBufferLayouts,
        },
        fragment,
        primitive: {
            topology: 'triangle-list',
            cullMode: material.cullMode,
            frontFace: 'ccw',
        },
        depthStencil: depthFormat
            ? {
                format: depthFormat,
                depthWriteEnabled: material.depthWrite,
                depthCompare: material.depthTest ? material.depthCompare : 'always',
                depthBias: material.depthBias,
                depthBiasSlopeScale: material.depthBiasSlopeScale,
                depthBiasClamp: material.depthBiasClamp,
            }
            : undefined,
        multisample: {
            count: renderContext.sampleCount >= 4 ? 4 : 1,
            alphaToCoverageEnabled: material.alphaToCoverage,
        },
    };
}
/**
 * Get or create a compute pipeline for a ComputeNode.
 *
 * @param state - The pipelines state
 * @param node - The ComputeNode
 * @param computeContext - The ComputeContext for bind group caching
 * @param promises - Optional array to collect async compilation promises (for compileAsync)
 * @returns The compute pipeline entry
 */
function getForCompute(state, device, nodes, node, computeContext, promises = null) {
    const key = node.id;
    let entry = state.computePipelines.get(key);
    if (entry)
        return entry;
    // Set up disposal callback if not already set
    if (!node._onDispose) {
        node._onDispose = () => {
            deleteForCompute(nodes, node);
            state.computePipelines.delete(node.id);
        };
    }
    // Use NodeManager to get compiled compute state (pass context for bind group caching)
    const nodeBuilderState = getForCompute$1(nodes, node, computeContext);
    // Build bind group layouts from NodeBuilderState bindings
    const bindGroupLayouts = buildComputeBindGroupLayouts(device, nodeBuilderState.bindings, state.bindGroupLayoutCache);
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts });
    const shaderModule = device.createShaderModule({ code: nodeBuilderState.computeCode });
    entry = {
        pipeline: null,
        nodeBuilderState,
    };
    state.computePipelines.set(key, entry);
    const descriptor = {
        layout: pipelineLayout,
        compute: { module: shaderModule, entryPoint: 'cs_main' },
    };
    if (promises === null) {
        // Sync compilation
        entry.pipeline = device.createComputePipeline(descriptor);
    }
    else {
        // Async compilation
        const p = (async () => {
            try {
                entry.pipeline = await device.createComputePipelineAsync(descriptor);
            }
            catch (err) {
                console.error('[pipelines] compute pipeline compilation failed:', err);
            }
        })();
        promises.push(p);
    }
    return entry;
}
/**
 * Look up an existing compute pipeline entry without compiling.
 * Returns null if the pipeline hasn't been created yet.
 *
 * @param state - The pipelines state
 * @param node - The ComputeNode
 * @returns The compute pipeline entry, or null if not compiled yet
 */
function lookupCompute(state, node) {
    return state.computePipelines.get(node.id) ?? null;
}
/**
 * Get the number of render targets for a fragment node.
 * Returns 0 for depth-only pipelines (null fragment node).
 */
function getTargetCount(fragmentNode) {
    if (fragmentNode === null)
        return 0;
    if (fragmentNode instanceof OutputStructNode) {
        return Math.max(1, fragmentNode.members.length);
    }
    return 1;
}
/**
 * Stable cache key for a material + MSAA sample count + color format + optional depth format.
 */
function makeRenderPipelineKey(material, samples, format, depthFormat = 'depth24plus') {
    const posId = material.vertexNode ? material.vertexNode.id : '__default__';
    const colId = material.fragmentNode ? material.fragmentNode.id : '__depthOnly__';
    const depId = material.depthNode ? material.depthNode.id : '__none__';
    const rs = [
        material.transparent ? 1 : 0,
        material.depthWrite ? 1 : 0,
        material.depthTest ? 1 : 0,
        material.depthCompare,
        material.cullMode,
        material.alphaToCoverage ? 1 : 0,
        material.depthBias,
        material.depthBiasSlopeScale,
        material.depthBiasClamp,
        getTargetCount(material.fragmentNode),
        samples,
        format,
        depthFormat ?? 'none',
        material.blend ? JSON.stringify(material.blend) : 'none',
    ].join('|');
    return `${posId}::${colId}::${depId}::${rs}`;
}
/**
 * Build vertex buffer layouts from geometry and NodeBuilderState.
 * Uses vertexBufferGroups to produce one GPUVertexBufferLayout per unique buffer.
 */
function buildVertexBufferLayouts(geometry, nodeState) {
    const layouts = [];
    for (const group of nodeState.vertexBufferGroups) {
        const gpuAttributes = [];
        // Per-attribute format always comes from the WGSL type
        for (const attr of group.attributes) {
            const format = wgslTypeToVertexFormat(attr.type);
            gpuAttributes.push({
                format,
                offset: attr.offset,
                shaderLocation: attr.shaderLocation,
            });
        }
        // Compute arrayStride — use explicit stride if set, otherwise derive from buffer or first attribute
        let arrayStride;
        if (group.stride > 0) {
            arrayStride = group.stride;
        }
        else if (group.name !== null) {
            const buffer = geometry.buffers.get(group.name);
            if (!buffer)
                continue;
            arrayStride = getBytesPerElement(buffer.format);
        }
        else {
            const firstAttr = group.attributes[0];
            arrayStride = wgslTypeItemSize(firstAttr.type) * 4;
        }
        layouts.push({
            arrayStride,
            stepMode: group.instanced ? 'instance' : 'vertex',
            attributes: gpuAttributes,
        });
    }
    return layouts;
}
/**
 * Get bytes per element for a vertex format.
 */
function getBytesPerElement(format) {
    if (!format)
        return 16; // Default to vec4
    const formatSizes = {
        float32: 4,
        float32x2: 8,
        float32x3: 12,
        float32x4: 16,
        sint32: 4,
        sint32x2: 8,
        sint32x3: 12,
        sint32x4: 16,
        uint32: 4,
        uint32x2: 8,
        uint32x3: 12,
        uint32x4: 16,
        sint16x2: 4,
        sint16x4: 8,
        uint16x2: 4,
        uint16x4: 8,
        sint8x2: 2,
        sint8x4: 4,
        uint8x2: 2,
        uint8x4: 4,
    };
    return formatSizes[format] ?? 16;
}
/**
 * Convert WGSL type to GPU vertex format.
 */
function wgslTypeToVertexFormat(type) {
    switch (type) {
        case 'f32':
            return 'float32';
        case 'vec2f':
            return 'float32x2';
        case 'vec3f':
            return 'float32x3';
        case 'vec4f':
            return 'float32x4';
        case 'i32':
            return 'sint32';
        case 'vec2i':
            return 'sint32x2';
        case 'vec3i':
            return 'sint32x3';
        case 'vec4i':
            return 'sint32x4';
        case 'u32':
            return 'uint32';
        case 'vec2u':
            return 'uint32x2';
        case 'vec3u':
            return 'uint32x3';
        case 'vec4u':
            return 'uint32x4';
        default:
            return 'float32x4';
    }
}
/**
 * Get the item size (number of components) for a WGSL type.
 */
function wgslTypeItemSize(type) {
    switch (type) {
        case 'f32':
        case 'i32':
        case 'u32':
            return 1;
        case 'vec2f':
        case 'vec2i':
        case 'vec2u':
            return 2;
        case 'vec3f':
        case 'vec3i':
        case 'vec3u':
            return 3;
        case 'vec4f':
        case 'vec4i':
        case 'vec4u':
            return 4;
        default:
            return 4;
    }
}
/**
 * Get default blend state for transparent materials.
 */
function getDefaultBlendState() {
    return {
        color: {
            srcFactor: 'src-alpha',
            dstFactor: 'one-minus-src-alpha',
            operation: 'add',
        },
        alpha: {
            srcFactor: 'one',
            dstFactor: 'one-minus-src-alpha',
            operation: 'add',
        },
    };
}

/**
 * Mipmap generation utilities using direct WebGPU pipelines.
 *
 * Three.js aligned: mirrors WebGPUTexturePassUtils.js
 *
 * Uses render passes to downsample each mip level from the previous one.
 * Pipelines are cached per texture format for efficiency.
 */
// WGSL shader for mipmap generation - fullscreen triangle with texture sampling
const MIPMAP_SHADER = /* wgsl */ `
struct Varys {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
}

@group(0) @binding(0) var imgSampler: sampler;
@group(0) @binding(1) var img: texture_2d<f32>;

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> Varys {
    // Fullscreen triangle: vertices at (-1,-1), (3,-1), (-1,3)
    var pos = array<vec2f, 3>(
        vec2f(-1.0, -1.0),
        vec2f(3.0, -1.0),
        vec2f(-1.0, 3.0)
    );

    var out: Varys;
    out.position = vec4f(pos[vertexIndex], 0.0, 1.0);
    // UV: map clip space to texture space
    // Clip Y=-1 (bottom) -> V=1, Clip Y=+1 (top) -> V=0
    out.uv = pos[vertexIndex] * vec2f(0.5, -0.5) + vec2f(0.5, 0.5);
    return out;
}

@fragment
fn fs_main(v: Varys) -> @location(0) vec4f {
    return textureSample(img, imgSampler, v.uv);
}
`;
// Shader for cube texture mipmap generation (samples from cube, renders to 2D face)
const MIPMAP_CUBE_SHADER = /* wgsl */ `
struct Varys {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
    @location(1) @interpolate(flat) face: u32,
}

@group(0) @binding(0) var imgSampler: sampler;
@group(0) @binding(1) var img: texture_cube<f32>;
@group(0) @binding(2) var<uniform> faceIndex: u32;

// Face direction matrices - convert 2D UV to 3D cube direction
// Each row: [right.x, up.x, forward.x], [right.y, up.y, forward.y], [right.z, up.z, forward.z]
const FACE_DIRS = array<mat3x3f, 6>(
    mat3x3f(vec3f( 0,  0, -1), vec3f( 0, -1,  0), vec3f( 1,  0,  0)),  // +X
    mat3x3f(vec3f( 0,  0,  1), vec3f( 0, -1,  0), vec3f(-1,  0,  0)),  // -X
    mat3x3f(vec3f( 1,  0,  0), vec3f( 0,  0,  1), vec3f( 0,  1,  0)),  // +Y
    mat3x3f(vec3f( 1,  0,  0), vec3f( 0,  0, -1), vec3f( 0, -1,  0)),  // -Y
    mat3x3f(vec3f( 1,  0,  0), vec3f( 0, -1,  0), vec3f( 0,  0,  1)),  // +Z
    mat3x3f(vec3f(-1,  0,  0), vec3f( 0, -1,  0), vec3f( 0,  0, -1)),  // -Z
);

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> Varys {
    var pos = array<vec2f, 3>(
        vec2f(-1.0, -1.0),
        vec2f(3.0, -1.0),
        vec2f(-1.0, 3.0)
    );

    var out: Varys;
    out.position = vec4f(pos[vertexIndex], 0.0, 1.0);
    out.uv = pos[vertexIndex] * vec2f(0.5, -0.5) + vec2f(0.5, 0.5);
    out.face = faceIndex;
    return out;
}

@fragment
fn fs_cube(v: Varys) -> @location(0) vec4f {
    // Convert UV to direction using face matrix
    let uv = v.uv * 2.0 - 1.0;
    let dir = FACE_DIRS[v.face] * vec3f(uv, 1.0);
    return textureSample(img, imgSampler, normalize(dir));
}
`;
/**
 * Create mipmap generation state for a device.
 */
function createMipmapState(device) {
    const sampler = device.createSampler({
        minFilter: 'linear',
        magFilter: 'linear',
    });
    const shaderModule2D = device.createShaderModule({
        label: 'mipmap-2d',
        code: MIPMAP_SHADER,
    });
    const shaderModuleCube = device.createShaderModule({
        label: 'mipmap-cube',
        code: MIPMAP_CUBE_SHADER,
    });
    // Uniform buffer for face index (cube maps)
    const faceIndexBuffer = device.createBuffer({
        label: 'mipmap-face-index',
        size: 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    return {
        device,
        sampler,
        pipelines2D: new Map(),
        pipelinesCube: new Map(),
        shaderModule2D,
        shaderModuleCube,
        faceIndexBuffer,
    };
}
/**
 * Get or create a render pipeline for 2D mipmap generation.
 */
function getPipeline2D(state, format) {
    let pipeline = state.pipelines2D.get(format);
    if (pipeline)
        return pipeline;
    pipeline = state.device.createRenderPipeline({
        label: `mipmap-2d-${format}`,
        layout: 'auto',
        vertex: {
            module: state.shaderModule2D,
            entryPoint: 'vs_main',
        },
        fragment: {
            module: state.shaderModule2D,
            entryPoint: 'fs_main',
            targets: [{ format }],
        },
        primitive: {
            topology: 'triangle-list',
        },
    });
    state.pipelines2D.set(format, pipeline);
    return pipeline;
}
/**
 * Get or create a render pipeline for cube mipmap generation.
 */
function getPipelineCube(state, format) {
    let pipeline = state.pipelinesCube.get(format);
    if (pipeline)
        return pipeline;
    pipeline = state.device.createRenderPipeline({
        label: `mipmap-cube-${format}`,
        layout: 'auto',
        vertex: {
            module: state.shaderModuleCube,
            entryPoint: 'vs_main',
        },
        fragment: {
            module: state.shaderModuleCube,
            entryPoint: 'fs_cube',
            targets: [{ format }],
        },
        primitive: {
            topology: 'triangle-list',
        },
    });
    state.pipelinesCube.set(format, pipeline);
    return pipeline;
}
/**
 * Generate mipmaps for a 2D texture.
 *
 * @param state - Mipmap generation state
 * @param texture - The GPU texture to generate mipmaps for
 * @param encoder - Optional command encoder (creates one if not provided)
 */
function generateMipmaps2D(state, texture, encoder) {
    const { device, sampler } = state;
    const format = texture.format;
    const mipLevelCount = texture.mipLevelCount;
    if (mipLevelCount <= 1)
        return;
    const pipeline = getPipeline2D(state, format);
    const ownEncoder = !encoder;
    encoder = encoder ?? device.createCommandEncoder({ label: 'mipmap-encoder' });
    // Generate each mip level from the previous one
    for (let mipLevel = 1; mipLevel < mipLevelCount; mipLevel++) {
        // Create view of source mip (level - 1)
        const srcView = texture.createView({
            baseMipLevel: mipLevel - 1,
            mipLevelCount: 1,
        });
        // Create view of destination mip
        const dstView = texture.createView({
            baseMipLevel: mipLevel,
            mipLevelCount: 1,
        });
        // Create bind group for this mip level
        const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: sampler },
                { binding: 1, resource: srcView },
            ],
        });
        // Render pass to generate this mip level
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                    view: dstView,
                    loadOp: 'clear',
                    storeOp: 'store',
                }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();
    }
    if (ownEncoder) {
        device.queue.submit([encoder.finish()]);
    }
}
/**
 * Generate mipmaps for a cube texture.
 *
 * @param state - Mipmap generation state
 * @param texture - The GPU cube texture to generate mipmaps for
 * @param encoder - Optional command encoder (creates one if not provided)
 */
function generateMipmapsCube(state, texture, encoder) {
    const { device, sampler, faceIndexBuffer } = state;
    const format = texture.format;
    const mipLevelCount = texture.mipLevelCount;
    if (mipLevelCount <= 1)
        return;
    const pipeline = getPipelineCube(state, format);
    const ownEncoder = !encoder;
    encoder = encoder ?? device.createCommandEncoder({ label: 'mipmap-cube-encoder' });
    // Generate each mip level from the previous one
    for (let mipLevel = 1; mipLevel < mipLevelCount; mipLevel++) {
        // Create cube view of source mip (level - 1)
        const srcView = texture.createView({
            dimension: 'cube',
            baseMipLevel: mipLevel - 1,
            mipLevelCount: 1,
        });
        // Process each face
        for (let face = 0; face < 6; face++) {
            // Update face index uniform
            device.queue.writeBuffer(faceIndexBuffer, 0, new Uint32Array([face]));
            // Create 2D view of destination face at this mip level
            const dstView = texture.createView({
                dimension: '2d',
                baseMipLevel: mipLevel,
                mipLevelCount: 1,
                baseArrayLayer: face,
                arrayLayerCount: 1,
            });
            // Create bind group for this face
            const bindGroup = device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: sampler },
                    { binding: 1, resource: srcView },
                    { binding: 2, resource: { buffer: faceIndexBuffer } },
                ],
            });
            // Render pass to generate this face's mip level
            const pass = encoder.beginRenderPass({
                colorAttachments: [{
                        view: dstView,
                        loadOp: 'clear',
                        storeOp: 'store',
                    }],
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.draw(3);
            pass.end();
        }
    }
    if (ownEncoder) {
        device.queue.submit([encoder.finish()]);
    }
}
/**
 * Generate mipmaps for a 2D array texture.
 *
 * Each layer is mipmapped independently using the same 2D pipeline.
 * For each mip level, iterates all layers: creates a 2D source view of layer L
 * at mip N-1 and a 2D destination view of layer L at mip N, then renders a
 * fullscreen downsample pass.
 *
 * @param state - Mipmap generation state
 * @param texture - The GPU array texture to generate mipmaps for
 * @param layerCount - Number of array layers
 * @param encoder - Optional command encoder (creates one if not provided)
 */
function generateMipmapsArray(state, texture, layerCount, encoder) {
    const { device, sampler } = state;
    const format = texture.format;
    const mipLevelCount = texture.mipLevelCount;
    if (mipLevelCount <= 1)
        return;
    const pipeline = getPipeline2D(state, format);
    const ownEncoder = !encoder;
    encoder = encoder ?? device.createCommandEncoder({ label: 'mipmap-array-encoder' });
    for (let mipLevel = 1; mipLevel < mipLevelCount; mipLevel++) {
        for (let layer = 0; layer < layerCount; layer++) {
            const srcView = texture.createView({
                dimension: '2d',
                baseMipLevel: mipLevel - 1,
                mipLevelCount: 1,
                baseArrayLayer: layer,
                arrayLayerCount: 1,
            });
            const dstView = texture.createView({
                dimension: '2d',
                baseMipLevel: mipLevel,
                mipLevelCount: 1,
                baseArrayLayer: layer,
                arrayLayerCount: 1,
            });
            const bindGroup = device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: sampler },
                    { binding: 1, resource: srcView },
                ],
            });
            const pass = encoder.beginRenderPass({
                colorAttachments: [{
                        view: dstView,
                        loadOp: 'clear',
                        storeOp: 'store',
                    }],
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.draw(3);
            pass.end();
        }
    }
    if (ownEncoder) {
        device.queue.submit([encoder.finish()]);
    }
}
/**
 * Generate mipmaps for a texture (auto-detects 2D vs cube vs array).
 *
 * @param state - Mipmap generation state
 * @param texture - The GPU texture to generate mipmaps for
 * @param isCube - Whether this is a cube texture
 * @param arrayLayerCount - Number of array layers (>1 triggers array path)
 * @param encoder - Optional command encoder
 */
function generateMipmaps(state, texture, isCube = false, arrayLayerCount = 0, encoder) {
    if (isCube) {
        generateMipmapsCube(state, texture, encoder);
    }
    else if (arrayLayerCount > 1) {
        generateMipmapsArray(state, texture, arrayLayerCount, encoder);
    }
    else {
        generateMipmaps2D(state, texture, encoder);
    }
}

/**
 * textures.ts — GPUTexture/GPUSampler cache and upload helpers.
 *
 * Uses WeakMap-based caching keyed by GpuTexture object.
 * Tracks texture.version for cache invalidation.
 * Samplers are shared/cached by parameter key for efficiency.
 *
 * Flow:
 * 1. `updateTexture()` is called during binding updates (before draw)
 * 2. Checks texture.version — skips if already up to date
 * 3. Creates GPU texture if needed
 * 4. Uploads image data if source.dataReady
 * 5. Updates version tracking (textureData.version = texture.version)
 */
function createTextureCache() {
    return {
        textureMap: new WeakMap(),
        samplerCache: new Map(),
        defaultTextures: new Map(),
        mipmapState: null,
        textureCount: 0,
        samplerCount: 0,
    };
}
/**
 * Set up the _onDispose callback on a GpuTexture to destroy its GPU texture.
 * Only sets the callback once (idempotent).
 */
function setupDispose(cache, texture) {
    if (texture._onDispose)
        return;
    texture._onDispose = () => {
        const data = cache.textureMap.get(texture);
        if (data && !data.isDefaultTexture) {
            data.texture.destroy();
        }
    };
}
/**
 * Get or create mipmap generation state (lazy initialization).
 */
function getMipmapState(cache, device) {
    if (!cache.mipmapState) {
        cache.mipmapState = createMipmapState(device);
    }
    return cache.mipmapState;
}
/**
 * Update a texture — checks source version and uploads if needed.
 * Returns the TextureData for the texture.
 */
function updateTexture(cache, device, texture) {
    let data = cache.textureMap.get(texture);
    // Skip if already initialized and texture version matches
    if (data?.initialized && data.version === texture.version) {
        return data;
    }
    const isCube = texture.viewDimension === 'cube' || texture.viewDimension === 'cube-array';
    const isArray = texture.viewDimension === '2d-array';
    // Check if source data is ready
    // For cube textures, check all face sources
    // For array textures, check all layer sources
    // For regular textures, check the single source
    const notReady = isCube
        ? !areCubeSourcesReady(texture)
        : isArray
            ? !areArraySourcesReady(texture)
            : !isSourceReady(texture.source);
    if (notReady) {
        if (!data) {
            const format = texture.format;
            const defaultTex = getDefaultTexture(cache, device, format);
            data = {
                texture: defaultTex,
                version: 0,
                generation: 0,
                initialized: true,
                isDefaultTexture: true,
            };
            cache.textureMap.set(texture, data);
        }
        return data;
    }
    // First time or was using default — create real GPU texture
    if (!data || data.isDefaultTexture) {
        const gpuTextureResource = createGPUTexture(device, texture);
        if (!data) {
            data = {
                texture: gpuTextureResource,
                version: texture.version,
                generation: texture.version,
                initialized: true,
                isDefaultTexture: false,
            };
            cache.textureMap.set(texture, data);
            cache.textureCount++;
        }
        else {
            // Was default, now real — update generation
            data.texture = gpuTextureResource;
            data.generation = texture.version;
            data.isDefaultTexture = false;
            cache.textureCount++;
        }
        // Set up disposal callback to destroy the GPU texture
        setupDispose(cache, texture);
    }
    // Upload image data
    uploadTextureData(device, texture, data);
    // Generate mipmaps if requested and texture has multiple mip levels
    if (texture.generateMipmaps && data.texture.mipLevelCount > 1) {
        const mipmapState = getMipmapState(cache, device);
        generateMipmaps(mipmapState, data.texture, isCube, isArray ? texture.depthOrArrayLayers : 0);
    }
    // Update texture version
    data.version = texture.version;
    data.initialized = true;
    return data;
}
/** Check if a single source is ready */
function isSourceReady(source) {
    if (!source)
        return false;
    if (!source.dataReady)
        return false;
    const data = source.data;
    if (!data)
        return false;
    // Check for incomplete HTMLImageElement
    if (data.complete === false)
        return false;
    return true;
}
/** Check if all cube face sources are ready (6 faces) */
function areCubeSourcesReady(texture) {
    if (texture.sources.length < 6)
        return false;
    for (let i = 0; i < 6; i++) {
        if (!isSourceReady(texture.sources[i]))
            return false;
    }
    return true;
}
/** Check if array texture source is ready (packed source or per-layer sources) */
function areArraySourcesReady(texture) {
    // Packed source mode: single source contains all layers
    if (texture.source) {
        return isSourceReady(texture.source);
    }
    // Per-layer sources mode
    if (texture.sources.length < texture.depthOrArrayLayers)
        return false;
    for (let i = 0; i < texture.depthOrArrayLayers; i++) {
        if (!isSourceReady(texture.sources[i]))
            return false;
    }
    return true;
}
/**
 * Create a GPUTexture for a GpuTexture.
 */
function createGPUTexture(device, texture) {
    // Calculate mip level count if generating mipmaps
    const mipLevelCount = texture.generateMipmaps
        ? Math.floor(Math.log2(Math.max(texture.width, texture.height))) + 1
        : texture.mipLevelCount;
    const gpuTexture = device.createTexture({
        dimension: texture.dimension,
        size: [texture.width, texture.height, texture.depthOrArrayLayers],
        format: texture.format,
        usage: texture.usage | GPUTextureUsage.RENDER_ATTACHMENT, // RENDER_ATTACHMENT needed for mipmap generation
        mipLevelCount,
        sampleCount: texture.sampleCount,
    });
    return gpuTexture;
}
/**
 * Upload image data to a GPU texture.
 * Routes to the appropriate upload function based on viewDimension.
 */
function uploadTextureData(device, texture, data) {
    const viewDim = texture.viewDimension;
    if (viewDim === 'cube' || viewDim === 'cube-array') {
        uploadCubeTextureData(device, texture, data);
        return;
    }
    if (viewDim === '2d-array') {
        uploadArrayTextureData(device, texture, data);
        return;
    }
    // Regular 2D texture - use primary source
    const source = texture.source;
    if (!source || !source.data)
        return;
    const sourceData = source.data;
    const width = texture.width;
    const height = texture.height;
    // Check if it's typed array data (DataTexture pattern)
    if (isTypedArrayData(sourceData)) {
        const bytesPerPixel = getBytesPerPixel(texture.format);
        device.queue.writeTexture({ texture: data.texture }, sourceData.buffer, { offset: sourceData.byteOffset, bytesPerRow: width * bytesPerPixel, rowsPerImage: height }, [width, height]);
    }
    else if (isExternalImage(sourceData)) {
        // HTMLImageElement, ImageBitmap, Canvas, Video, etc.
        device.queue.copyExternalImageToTexture({ source: sourceData }, { texture: data.texture, premultipliedAlpha: texture.premultiplyAlpha }, [width, height]);
    }
}
/** Check if source data is a typed array (from DataTextureImage) */
function isTypedArrayData(data) {
    if (!data || typeof data !== 'object')
        return false;
    const d = data;
    return d.data !== undefined && ArrayBuffer.isView(d.data);
}
/** Check if source data is an external image (copyable to GPU) */
function isExternalImage(data) {
    if (!data || typeof data !== 'object')
        return false;
    // Check for known browser types
    return ((typeof ImageBitmap !== 'undefined' && data instanceof ImageBitmap) ||
        (typeof HTMLCanvasElement !== 'undefined' && data instanceof HTMLCanvasElement) ||
        (typeof OffscreenCanvas !== 'undefined' && data instanceof OffscreenCanvas) ||
        (typeof HTMLVideoElement !== 'undefined' && data instanceof HTMLVideoElement) ||
        (typeof VideoFrame !== 'undefined' && data instanceof VideoFrame) ||
        (typeof ImageData !== 'undefined' && data instanceof ImageData));
}
/**
 * Upload cube texture data — copies each of the 6 face images to the
 * corresponding array layer of the GPU texture.
 *
 * Face order: +X, -X, +Y, -Y, +Z, -Z (matches sources array).
 */
function uploadCubeTextureData(device, texture, data) {
    const sources = texture.sources;
    if (sources.length < 6)
        return;
    const width = texture.width;
    const height = texture.height;
    for (let faceIndex = 0; faceIndex < 6; faceIndex++) {
        const source = sources[faceIndex];
        if (!source.dataReady)
            continue;
        const faceData = source.data;
        if (!faceData)
            continue;
        if (isExternalImage(faceData)) {
            device.queue.copyExternalImageToTexture({ source: faceData }, {
                texture: data.texture,
                premultipliedAlpha: texture.premultiplyAlpha,
                origin: { x: 0, y: 0, z: faceIndex },
            }, [width, height]);
        }
    }
}
/**
 * Upload array texture data — copies each layer's data to the corresponding
 * array layer of the GPU texture.
 *
 * Supports two modes:
 * 1. Per-layer sources: texture.sources contains one Source per layer
 * 2. Packed source: texture.source contains all layers packed sequentially
 */
function uploadArrayTextureData(device, texture, data) {
    const width = texture.width;
    const height = texture.height;
    const bytesPerPixel = getBytesPerPixel(texture.format);
    const layerCount = texture.depthOrArrayLayers;
    // Mode 1: Per-layer sources array
    if (texture.sources.length > 0) {
        for (let layer = 0; layer < texture.sources.length && layer < layerCount; layer++) {
            const source = texture.sources[layer];
            if (!source.dataReady)
                continue;
            const layerData = source.data;
            if (!layerData)
                continue;
            if (isTypedArrayData(layerData)) {
                const srcData = layerData.data;
                device.queue.writeTexture({ texture: data.texture, origin: { x: 0, y: 0, z: layer } }, srcData.buffer, {
                    offset: srcData.byteOffset,
                    bytesPerRow: width * bytesPerPixel,
                    rowsPerImage: height,
                }, [width, height]);
            }
            else if (isExternalImage(layerData)) {
                device.queue.copyExternalImageToTexture({ source: layerData }, {
                    texture: data.texture,
                    premultipliedAlpha: texture.premultiplyAlpha,
                    origin: { x: 0, y: 0, z: layer },
                }, [width, height]);
            }
        }
        return;
    }
    // Mode 2: Single packed source with all layers
    const source = texture.source;
    if (!source || !source.dataReady)
        return;
    const sourceData = source.data;
    if (!sourceData || !isTypedArrayData(sourceData))
        return;
    const srcData = sourceData.data;
    // Upload all layers in one call
    device.queue.writeTexture({ texture: data.texture }, srcData.buffer, {
        offset: srcData.byteOffset,
        bytesPerRow: width * bytesPerPixel,
        rowsPerImage: height,
    }, [width, height, layerCount]);
}
/**
 * Get bytes per pixel for a format (simplified — handles common formats).
 */
function getBytesPerPixel(format) {
    switch (format) {
        case 'r8unorm':
        case 'r8snorm':
        case 'r8uint':
        case 'r8sint':
            return 1;
        case 'r16uint':
        case 'r16sint':
        case 'r16float':
        case 'rg8unorm':
        case 'rg8snorm':
        case 'rg8uint':
        case 'rg8sint':
            return 2;
        case 'r32uint':
        case 'r32sint':
        case 'r32float':
        case 'rg16uint':
        case 'rg16sint':
        case 'rg16float':
        case 'rgba8unorm':
        case 'rgba8unorm-srgb':
        case 'rgba8snorm':
        case 'rgba8uint':
        case 'rgba8sint':
        case 'bgra8unorm':
        case 'bgra8unorm-srgb':
            return 4;
        case 'rg32uint':
        case 'rg32sint':
        case 'rg32float':
        case 'rgba16uint':
        case 'rgba16sint':
        case 'rgba16float':
            return 8;
        case 'rgba32uint':
        case 'rgba32sint':
        case 'rgba32float':
            return 16;
        default:
            return 4; // Fallback
    }
}
/**
 * Get or create a 1x1 default placeholder texture.
 */
function getDefaultTexture(cache, device, format) {
    let tex = cache.defaultTextures.get(format);
    if (tex)
        return tex;
    tex = device.createTexture({
        size: [1, 1],
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // Write white pixel (or neutral value for non-color formats)
    const bytesPerPixel = getBytesPerPixel(format);
    const data = new Uint8Array(bytesPerPixel);
    data.fill(255); // White / max value
    device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: bytesPerPixel }, [1, 1]);
    cache.defaultTextures.set(format, tex);
    return tex;
}
/**
 * Get or create a sampler from Sampler settings.
 */
function getSampler(cache, device, gpuSampler) {
    const key = gpuSampler.settingsKey;
    let data = cache.samplerCache.get(key);
    if (data) {
        data.usedTimes++;
        return data.sampler;
    }
    // WebGPU constraint: anisotropy > 1 requires all filters to be 'linear'
    let { minFilter, magFilter, mipmapFilter, maxAnisotropy } = gpuSampler;
    if (maxAnisotropy > 1) {
        if (minFilter !== 'linear' || magFilter !== 'linear' || mipmapFilter !== 'linear') {
            maxAnisotropy = 1;
        }
    }
    const sampler = device.createSampler({
        magFilter,
        minFilter,
        mipmapFilter,
        addressModeU: gpuSampler.addressModeU,
        addressModeV: gpuSampler.addressModeV,
        addressModeW: gpuSampler.addressModeW,
        maxAnisotropy,
        compare: gpuSampler.compare,
    });
    cache.samplerCache.set(key, { sampler, usedTimes: 1 });
    cache.samplerCount++;
    return sampler;
}
/**
 * Get cached TextureData for a GpuTexture.
 * Returns null if not in cache (call updateTexture first).
 */
function getTextureData(cache, texture) {
    return cache.textureMap.get(texture) ?? null;
}
/**
 * Set the GPU texture resource for a render target texture.
 * Called by the renderer when creating/resizing render targets.
 *
 * Unlike regular textures which upload source data, render target textures
 * have their GPUTexture created externally and registered here.
 */
function setRenderTargetTexture(cache, texture, gpuTextureResource) {
    const existing = cache.textureMap.get(texture);
    if (existing) {
        // Update existing entry with new GPU texture (e.g., after resize)
        existing.texture = gpuTextureResource;
        existing.generation++;
        existing.initialized = true;
        existing.isDefaultTexture = false;
    }
    else {
        // First time - create new entry
        cache.textureMap.set(texture, {
            texture: gpuTextureResource,
            version: texture.version,
            generation: 1,
            initialized: true,
            isDefaultTexture: false,
        });
        cache.textureCount++;
        setupDispose(cache, texture);
    }
}

// Layout Cache
const layoutCache = new WeakMap();
function getLayout(schema, addressSpace) {
    let byAddressSpace = layoutCache.get(schema);
    if (!byAddressSpace) {
        byAddressSpace = new Map();
        layoutCache.set(schema, byAddressSpace);
    }
    let layout = byAddressSpace.get(addressSpace);
    if (!layout) {
        layout = compileLayout(schema, addressSpace);
        byAddressSpace.set(addressSpace, layout);
    }
    return layout;
}
function toDataView(src) {
    if (src instanceof ArrayBuffer) {
        return new DataView(src);
    }
    return new DataView(src.buffer, src.byteOffset, src.byteLength);
}
/**
 * Pack a value into a new ArrayBuffer.
 *
 * @example
 * const buf = pack(Particle, { position: [1, 2, 3], health: 100 });
 * const f32 = new Float32Array(buf);
 */
function pack(schema, value, addressSpace = 'storage') {
    const layout = getLayout(schema, addressSpace);
    const buf = new ArrayBuffer(layout.totalSize);
    layout.write(new DataView(buf), 0, value);
    return buf;
}
/**
 * Pack an array of values into a new ArrayBuffer.
 *
 * @example
 * const buf = packArray(Particle, particles);
 * const f32 = new Float32Array(buf);
 */
function packArray(schema, items, addressSpace = 'storage') {
    const layout = getLayout(schema, addressSpace);
    const buf = new ArrayBuffer(layout.stride * items.length);
    const view = new DataView(buf);
    for (let i = 0; i < items.length; i++) {
        layout.write(view, i * layout.stride, items[i]);
    }
    return buf;
}
/**
 * Pack a value into an existing buffer at a byte offset.
 *
 * @example
 * const buf = new ArrayBuffer(1024);
 * packTo(Particle, buf, 0, particle1);
 * packTo(Particle, buf, stride, particle2);
 */
function packTo(schema, dest, offset, value, addressSpace = 'storage') {
    const layout = getLayout(schema, addressSpace);
    layout.write(toDataView(dest), offset, value);
}
/**
 * Unpack a value from a buffer.
 *
 * @example
 * const particle = unpack(Particle, buf);
 * const secondParticle = unpack(Particle, buf, stride);
 */
function unpack(schema, src, offset = 0, addressSpace = 'storage') {
    const layout = getLayout(schema, addressSpace);
    return layout.read(toDataView(src), offset);
}
/**
 * Unpack an array of values from a buffer.
 *
 * @example
 * const particles = unpackArray(Particle, buf, 100);
 */
function unpackArray(schema, src, count, offset = 0, addressSpace = 'storage') {
    const layout = getLayout(schema, addressSpace);
    const view = toDataView(src);
    const items = new Array(count);
    for (let i = 0; i < count; i++) {
        items[i] = layout.read(view, offset + i * layout.stride);
    }
    return items;
}
/**
 * Get the byte size of a schema.
 *
 * @example
 * const size = layoutSizeOf(Particle); // 32
 */
function layoutSizeOf(schema, addressSpace = 'storage') {
    return getLayout(schema, addressSpace).totalSize;
}
/**
 * Get the stride (size with tail padding) for array elements.
 *
 * @example
 * const stride = layoutStrideOf(Particle); // 32
 */
function layoutStrideOf(schema, addressSpace = 'storage') {
    return getLayout(schema, addressSpace).stride;
}
// Internal: DataView-based pack/unpack (used by bindings.ts)
/** Pack a value into a DataView. */
function packToView(schema, view, offset, value, addressSpace = 'storage') {
    const layout = getLayout(schema, addressSpace);
    layout.write(view, offset, value);
}
// Alignment and Size (address-space aware)
function roundUp(n, align) {
    return Math.ceil(n / align) * align;
}
/**
 * Get alignment for a schema in the given address space.
 * Uniform has stricter rules: structs and arrays round up to 16.
 */
function alignOf(schema, addressSpace) {
    // For uniform address space, structs and array elements need roundUp(16, align)
    if (addressSpace === 'uniform') {
        if (isStructDesc(schema)) {
            return roundUp(storageAlignOf(schema), 16);
        }
        if (isSizedArrayDesc(schema) || isArrayDesc(schema)) {
            return roundUp(alignOf(schema.element, addressSpace), 16);
        }
    }
    return storageAlignOf(schema);
}
/**
 * Storage layout alignment (std430).
 */
function storageAlignOf(schema) {
    if (isStructDesc(schema)) {
        let maxAlign = 4;
        for (const field of Object.values(schema.fields)) {
            maxAlign = Math.max(maxAlign, storageAlignOf(field));
        }
        return maxAlign;
    }
    if (isSizedArrayDesc(schema) || isArrayDesc(schema)) {
        return storageAlignOf(schema.element);
    }
    if (isAtomicDesc(schema))
        return 4;
    const t = schema.wgslType;
    // f16 types
    if (t === 'f16' || t === 'vec2h')
        return 4;
    if (t === 'vec3h' || t === 'vec4h')
        return 8;
    if (t === 'mat2x2h')
        return 4;
    if (t === 'mat2x3h' || t === 'mat3x2h')
        return 8;
    if (t === 'mat2x4h' || t === 'mat4x2h')
        return 8;
    if (t === 'mat3x3h' || t === 'mat3x4h' || t === 'mat4x3h' || t === 'mat4x4h')
        return 8;
    // Scalars
    if (t === 'f32' || t === 'i32' || t === 'u32' || t === 'bool')
        return 4;
    // vec2
    if (t === 'vec2f' || t === 'vec2i' || t === 'vec2u' || t === 'vec2<bool>')
        return 8;
    // vec3/vec4
    if (t === 'vec3f' || t === 'vec3i' || t === 'vec3u' || t === 'vec3<bool>')
        return 16;
    if (t === 'vec4f' || t === 'vec4i' || t === 'vec4u' || t === 'vec4<bool>')
        return 16;
    // Matrices f32
    if (t === 'mat2x2f')
        return 8;
    if (t === 'mat3x2f' || t === 'mat4x2f')
        return 8;
    if (t === 'mat2x3f' || t === 'mat3x3f' || t === 'mat4x3f')
        return 16;
    if (t === 'mat2x4f' || t === 'mat3x4f' || t === 'mat4x4f')
        return 16;
    throw new Error(`[gpucat] alignOf: unsupported type '${t}'`);
}
/**
 * Get size for a schema in the given address space.
 */
function sizeOf(schema, addressSpace) {
    if (isStructDesc(schema)) {
        const structAlign = alignOf(schema, addressSpace);
        let offset = 0;
        for (const field of Object.values(schema.fields)) {
            offset = roundUp(offset, alignOf(field, addressSpace));
            offset += sizeOf(field, addressSpace);
        }
        return roundUp(offset, structAlign);
    }
    if (isSizedArrayDesc(schema)) {
        const elementStride = arrayElementStrideOf(schema.element, addressSpace);
        return schema.length * elementStride;
    }
    if (isArrayDesc(schema)) {
        throw new Error('[gpucat] sizeOf: cannot compute size of runtime-sized array');
    }
    if (isAtomicDesc(schema))
        return 4;
    const t = schema.wgslType;
    // Scalars
    if (t === 'f16')
        return 2;
    if (t === 'f32' || t === 'i32' || t === 'u32' || t === 'bool')
        return 4;
    // vec2
    if (t === 'vec2h')
        return 4;
    if (t === 'vec2f' || t === 'vec2i' || t === 'vec2u' || t === 'vec2<bool>')
        return 8;
    // vec3
    if (t === 'vec3h')
        return 6;
    if (t === 'vec3f' || t === 'vec3i' || t === 'vec3u' || t === 'vec3<bool>')
        return 12;
    // vec4
    if (t === 'vec4h')
        return 8;
    if (t === 'vec4f' || t === 'vec4i' || t === 'vec4u' || t === 'vec4<bool>')
        return 16;
    // Matrices f32 - column stride based on row count
    if (t === 'mat2x2f')
        return 2 * 8; // 2 cols * vec2 stride
    if (t === 'mat3x2f')
        return 3 * 8;
    if (t === 'mat4x2f')
        return 4 * 8;
    if (t === 'mat2x3f')
        return 2 * 16; // 2 cols * vec3 padded to vec4
    if (t === 'mat3x3f')
        return 3 * 16;
    if (t === 'mat4x3f')
        return 4 * 16;
    if (t === 'mat2x4f')
        return 2 * 16; // 2 cols * vec4
    if (t === 'mat3x4f')
        return 3 * 16;
    if (t === 'mat4x4f')
        return 4 * 16;
    // Matrices f16
    if (t === 'mat2x2h')
        return 2 * 4; // 2 cols * vec2h stride
    if (t === 'mat3x2h')
        return 3 * 4;
    if (t === 'mat4x2h')
        return 4 * 4;
    if (t === 'mat2x3h')
        return 2 * 8; // 2 cols * vec3h padded
    if (t === 'mat3x3h')
        return 3 * 8;
    if (t === 'mat4x3h')
        return 4 * 8;
    if (t === 'mat2x4h')
        return 2 * 8; // 2 cols * vec4h
    if (t === 'mat3x4h')
        return 3 * 8;
    if (t === 'mat4x4h')
        return 4 * 8;
    throw new Error(`[gpucat] sizeOf: unsupported type '${t}'`);
}
/**
 * Get stride (size with alignment padding) for array elements.
 */
function strideOf(schema, addressSpace) {
    return roundUp(sizeOf(schema, addressSpace), alignOf(schema, addressSpace));
}
/**
 * Get stride for elements within an array (different from strideOf for uniform arrays).
 * Uniform arrays require 16-byte minimum element stride.
 */
function arrayElementStrideOf(elementSchema, addressSpace) {
    const baseStride = strideOf(elementSchema, addressSpace);
    if (addressSpace === 'uniform') {
        return roundUp(baseStride, 16);
    }
    return baseStride;
}
// ---------------------------------------------------------------------------
// Code Generation - Writers
// ---------------------------------------------------------------------------
/**
 * Emit write statements for a schema.
 */
function emitWrites(ctx, schema, accessor) {
    if (isStructDesc(schema)) {
        emitStructWrites(ctx, schema, accessor);
    }
    else if (isSizedArrayDesc(schema)) {
        emitArrayWrites(ctx, schema, accessor);
    }
    else {
        emitPrimitiveWrite(ctx, schema, accessor);
    }
}
function emitStructWrites(ctx, schema, accessor) {
    for (const [key, fieldSchema] of Object.entries(schema.fields)) {
        ctx.offset = roundUp(ctx.offset, alignOf(fieldSchema, ctx.addressSpace));
        emitWrites(ctx, fieldSchema, `${accessor}.${key}`);
    }
    // Struct tail padding
    const structAlign = alignOf(schema, ctx.addressSpace);
    ctx.offset = roundUp(ctx.offset, structAlign);
}
function emitArrayWrites(ctx, schema, accessor) {
    const stride = arrayElementStrideOf(schema.element, ctx.addressSpace);
    const startOffset = ctx.offset;
    for (let i = 0; i < schema.length; i++) {
        ctx.offset = startOffset + i * stride;
        emitWrites(ctx, schema.element, `${accessor}[${i}]`);
    }
    // Position after the array (accounts for tail padding of last element)
    ctx.offset = startOffset + schema.length * stride;
}
function emitPrimitiveWrite(ctx, schema, accessor) {
    const t = schema.wgslType;
    const off = ctx.offset;
    // Scalars
    if (t === 'f32') {
        ctx.lines.push(`v.setFloat32(o+${off},${accessor},true);`);
        ctx.offset += 4;
        return;
    }
    if (t === 'i32') {
        ctx.lines.push(`v.setInt32(o+${off},${accessor},true);`);
        ctx.offset += 4;
        return;
    }
    if (t === 'u32' || t === 'bool') {
        ctx.lines.push(`v.setUint32(o+${off},${accessor},true);`);
        ctx.offset += 4;
        return;
    }
    if (t === 'f16') {
        ctx.lines.push(`v.setUint16(o+${off},f16(${accessor}),true);`);
        ctx.offset += 2;
        return;
    }
    // vec2
    if (t === 'vec2f') {
        ctx.lines.push(`v.setFloat32(o+${off},${accessor}[0],true);`);
        ctx.lines.push(`v.setFloat32(o+${off + 4},${accessor}[1],true);`);
        ctx.offset += 8;
        return;
    }
    if (t === 'vec2i') {
        ctx.lines.push(`v.setInt32(o+${off},${accessor}[0],true);`);
        ctx.lines.push(`v.setInt32(o+${off + 4},${accessor}[1],true);`);
        ctx.offset += 8;
        return;
    }
    if (t === 'vec2u' || t === 'vec2<bool>') {
        ctx.lines.push(`v.setUint32(o+${off},${accessor}[0],true);`);
        ctx.lines.push(`v.setUint32(o+${off + 4},${accessor}[1],true);`);
        ctx.offset += 8;
        return;
    }
    if (t === 'vec2h') {
        ctx.lines.push(`v.setUint16(o+${off},f16(${accessor}[0]),true);`);
        ctx.lines.push(`v.setUint16(o+${off + 2},f16(${accessor}[1]),true);`);
        ctx.offset += 4;
        return;
    }
    // vec3
    if (t === 'vec3f') {
        ctx.lines.push(`v.setFloat32(o+${off},${accessor}[0],true);`);
        ctx.lines.push(`v.setFloat32(o+${off + 4},${accessor}[1],true);`);
        ctx.lines.push(`v.setFloat32(o+${off + 8},${accessor}[2],true);`);
        ctx.offset += 12;
        return;
    }
    if (t === 'vec3i') {
        ctx.lines.push(`v.setInt32(o+${off},${accessor}[0],true);`);
        ctx.lines.push(`v.setInt32(o+${off + 4},${accessor}[1],true);`);
        ctx.lines.push(`v.setInt32(o+${off + 8},${accessor}[2],true);`);
        ctx.offset += 12;
        return;
    }
    if (t === 'vec3u' || t === 'vec3<bool>') {
        ctx.lines.push(`v.setUint32(o+${off},${accessor}[0],true);`);
        ctx.lines.push(`v.setUint32(o+${off + 4},${accessor}[1],true);`);
        ctx.lines.push(`v.setUint32(o+${off + 8},${accessor}[2],true);`);
        ctx.offset += 12;
        return;
    }
    if (t === 'vec3h') {
        ctx.lines.push(`v.setUint16(o+${off},f16(${accessor}[0]),true);`);
        ctx.lines.push(`v.setUint16(o+${off + 2},f16(${accessor}[1]),true);`);
        ctx.lines.push(`v.setUint16(o+${off + 4},f16(${accessor}[2]),true);`);
        ctx.offset += 6;
        return;
    }
    // vec4
    if (t === 'vec4f') {
        ctx.lines.push(`v.setFloat32(o+${off},${accessor}[0],true);`);
        ctx.lines.push(`v.setFloat32(o+${off + 4},${accessor}[1],true);`);
        ctx.lines.push(`v.setFloat32(o+${off + 8},${accessor}[2],true);`);
        ctx.lines.push(`v.setFloat32(o+${off + 12},${accessor}[3],true);`);
        ctx.offset += 16;
        return;
    }
    if (t === 'vec4i') {
        ctx.lines.push(`v.setInt32(o+${off},${accessor}[0],true);`);
        ctx.lines.push(`v.setInt32(o+${off + 4},${accessor}[1],true);`);
        ctx.lines.push(`v.setInt32(o+${off + 8},${accessor}[2],true);`);
        ctx.lines.push(`v.setInt32(o+${off + 12},${accessor}[3],true);`);
        ctx.offset += 16;
        return;
    }
    if (t === 'vec4u' || t === 'vec4<bool>') {
        ctx.lines.push(`v.setUint32(o+${off},${accessor}[0],true);`);
        ctx.lines.push(`v.setUint32(o+${off + 4},${accessor}[1],true);`);
        ctx.lines.push(`v.setUint32(o+${off + 8},${accessor}[2],true);`);
        ctx.lines.push(`v.setUint32(o+${off + 12},${accessor}[3],true);`);
        ctx.offset += 16;
        return;
    }
    if (t === 'vec4h') {
        ctx.lines.push(`v.setUint16(o+${off},f16(${accessor}[0]),true);`);
        ctx.lines.push(`v.setUint16(o+${off + 2},f16(${accessor}[1]),true);`);
        ctx.lines.push(`v.setUint16(o+${off + 4},f16(${accessor}[2]),true);`);
        ctx.lines.push(`v.setUint16(o+${off + 6},f16(${accessor}[3]),true);`);
        ctx.offset += 8;
        return;
    }
    // Matrices f32 - column major
    if (t.startsWith('mat') && t.endsWith('f')) {
        emitMatrixWriteF32(ctx, t, accessor);
        return;
    }
    // Matrices f16
    if (t.startsWith('mat') && t.endsWith('h')) {
        emitMatrixWriteF16(ctx, t, accessor);
        return;
    }
    // Atomic
    if (isAtomicDesc(schema)) {
        const inner = schema.inner.wgslType;
        if (inner === 'i32') {
            ctx.lines.push(`v.setInt32(o+${off},${accessor},true);`);
        }
        else {
            ctx.lines.push(`v.setUint32(o+${off},${accessor},true);`);
        }
        ctx.offset += 4;
        return;
    }
    throw new Error(`[gpucat] emitPrimitiveWrite: unsupported type '${t}'`);
}
function emitMatrixWriteF32(ctx, t, accessor) {
    // matCxRf: C columns, R rows
    const match = t.match(/mat(\d)x(\d)f/);
    if (!match)
        throw new Error(`Invalid matrix type: ${t}`);
    const cols = parseInt(match[1], 10);
    const rows = parseInt(match[2], 10);
    // Column stride: vec2=8, vec3/4=16
    const colStride = rows === 2 ? 8 : 16;
    let off = ctx.offset;
    for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
            const idx = c * rows + r;
            ctx.lines.push(`v.setFloat32(o+${off + r * 4},${accessor}[${idx}],true);`);
        }
        off += colStride;
    }
    ctx.offset = off;
}
function emitMatrixWriteF16(ctx, t, accessor) {
    const match = t.match(/mat(\d)x(\d)h/);
    if (!match)
        throw new Error(`Invalid matrix type: ${t}`);
    const cols = parseInt(match[1], 10);
    const rows = parseInt(match[2], 10);
    // Column stride for f16: vec2h=4, vec3h/4h=8
    const colStride = rows === 2 ? 4 : 8;
    let off = ctx.offset;
    for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
            const idx = c * rows + r;
            ctx.lines.push(`v.setUint16(o+${off + r * 2},f16(${accessor}[${idx}]),true);`);
        }
        off += colStride;
    }
    ctx.offset = off;
}
// ---------------------------------------------------------------------------
// Code Generation - Readers
// ---------------------------------------------------------------------------
/**
 * Emit read expression for a schema. Returns a JS expression string.
 */
function emitReads(ctx, schema) {
    if (isStructDesc(schema)) {
        return emitStructRead(ctx, schema);
    }
    else if (isSizedArrayDesc(schema)) {
        return emitArrayRead(ctx, schema);
    }
    else {
        return emitPrimitiveRead(ctx, schema);
    }
}
function emitStructRead(ctx, schema) {
    const fields = [];
    for (const [key, fieldSchema] of Object.entries(schema.fields)) {
        ctx.offset = roundUp(ctx.offset, alignOf(fieldSchema, ctx.addressSpace));
        const valueExpr = emitReads(ctx, fieldSchema);
        fields.push(`${key}:${valueExpr}`);
    }
    // Struct tail padding
    const structAlign = alignOf(schema, ctx.addressSpace);
    ctx.offset = roundUp(ctx.offset, structAlign);
    return `{${fields.join(',')}}`;
}
function emitArrayRead(ctx, schema) {
    const elements = [];
    const stride = arrayElementStrideOf(schema.element, ctx.addressSpace);
    const startOffset = ctx.offset;
    for (let i = 0; i < schema.length; i++) {
        ctx.offset = startOffset + i * stride;
        elements.push(emitReads(ctx, schema.element));
    }
    // Position after the array
    ctx.offset = startOffset + schema.length * stride;
    return `[${elements.join(',')}]`;
}
function emitPrimitiveRead(ctx, schema) {
    const t = schema.wgslType;
    const off = ctx.offset;
    // Scalars
    if (t === 'f32') {
        ctx.offset += 4;
        return `v.getFloat32(o+${off},true)`;
    }
    if (t === 'i32') {
        ctx.offset += 4;
        return `v.getInt32(o+${off},true)`;
    }
    if (t === 'u32' || t === 'bool') {
        ctx.offset += 4;
        return `v.getUint32(o+${off},true)`;
    }
    if (t === 'f16') {
        ctx.offset += 2;
        return `f16r(v.getUint16(o+${off},true))`;
    }
    // vec2
    if (t === 'vec2f') {
        ctx.offset += 8;
        return `[v.getFloat32(o+${off},true),v.getFloat32(o+${off + 4},true)]`;
    }
    if (t === 'vec2i') {
        ctx.offset += 8;
        return `[v.getInt32(o+${off},true),v.getInt32(o+${off + 4},true)]`;
    }
    if (t === 'vec2u' || t === 'vec2<bool>') {
        ctx.offset += 8;
        return `[v.getUint32(o+${off},true),v.getUint32(o+${off + 4},true)]`;
    }
    if (t === 'vec2h') {
        ctx.offset += 4;
        return `[f16r(v.getUint16(o+${off},true)),f16r(v.getUint16(o+${off + 2},true))]`;
    }
    // vec3
    if (t === 'vec3f') {
        ctx.offset += 12;
        return `[v.getFloat32(o+${off},true),v.getFloat32(o+${off + 4},true),v.getFloat32(o+${off + 8},true)]`;
    }
    if (t === 'vec3i') {
        ctx.offset += 12;
        return `[v.getInt32(o+${off},true),v.getInt32(o+${off + 4},true),v.getInt32(o+${off + 8},true)]`;
    }
    if (t === 'vec3u' || t === 'vec3<bool>') {
        ctx.offset += 12;
        return `[v.getUint32(o+${off},true),v.getUint32(o+${off + 4},true),v.getUint32(o+${off + 8},true)]`;
    }
    if (t === 'vec3h') {
        ctx.offset += 6;
        return `[f16r(v.getUint16(o+${off},true)),f16r(v.getUint16(o+${off + 2},true)),f16r(v.getUint16(o+${off + 4},true))]`;
    }
    // vec4
    if (t === 'vec4f') {
        ctx.offset += 16;
        return `[v.getFloat32(o+${off},true),v.getFloat32(o+${off + 4},true),v.getFloat32(o+${off + 8},true),v.getFloat32(o+${off + 12},true)]`;
    }
    if (t === 'vec4i') {
        ctx.offset += 16;
        return `[v.getInt32(o+${off},true),v.getInt32(o+${off + 4},true),v.getInt32(o+${off + 8},true),v.getInt32(o+${off + 12},true)]`;
    }
    if (t === 'vec4u' || t === 'vec4<bool>') {
        ctx.offset += 16;
        return `[v.getUint32(o+${off},true),v.getUint32(o+${off + 4},true),v.getUint32(o+${off + 8},true),v.getUint32(o+${off + 12},true)]`;
    }
    if (t === 'vec4h') {
        ctx.offset += 8;
        return `[f16r(v.getUint16(o+${off},true)),f16r(v.getUint16(o+${off + 2},true)),f16r(v.getUint16(o+${off + 4},true)),f16r(v.getUint16(o+${off + 6},true))]`;
    }
    // Matrices f32
    if (t.startsWith('mat') && t.endsWith('f')) {
        return emitMatrixReadF32(ctx, t);
    }
    // Matrices f16
    if (t.startsWith('mat') && t.endsWith('h')) {
        return emitMatrixReadF16(ctx, t);
    }
    // Atomic
    if (isAtomicDesc(schema)) {
        ctx.offset += 4;
        const inner = schema.inner.wgslType;
        if (inner === 'i32') {
            return `v.getInt32(o+${off},true)`;
        }
        else {
            return `v.getUint32(o+${off},true)`;
        }
    }
    throw new Error(`[gpucat] emitPrimitiveRead: unsupported type '${t}'`);
}
function emitMatrixReadF32(ctx, t) {
    const match = t.match(/mat(\d)x(\d)f/);
    if (!match)
        throw new Error(`Invalid matrix type: ${t}`);
    const cols = parseInt(match[1], 10);
    const rows = parseInt(match[2], 10);
    const colStride = rows === 2 ? 8 : 16;
    const elements = [];
    let off = ctx.offset;
    for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
            elements.push(`v.getFloat32(o+${off + r * 4},true)`);
        }
        off += colStride;
    }
    ctx.offset = off;
    return `[${elements.join(',')}]`;
}
function emitMatrixReadF16(ctx, t) {
    const match = t.match(/mat(\d)x(\d)h/);
    if (!match)
        throw new Error(`Invalid matrix type: ${t}`);
    const cols = parseInt(match[1], 10);
    const rows = parseInt(match[2], 10);
    const colStride = rows === 2 ? 4 : 8;
    const elements = [];
    let off = ctx.offset;
    for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
            elements.push(`f16r(v.getUint16(o+${off + r * 2},true))`);
        }
        off += colStride;
    }
    ctx.offset = off;
    return `[${elements.join(',')}]`;
}
// ---------------------------------------------------------------------------
// f16 conversion helpers (injected into generated code)
// ---------------------------------------------------------------------------
/**
 * Convert f32 to f16 bits.
 */
function f32ToF16Bits(value) {
    const f32 = new Float32Array(1);
    const u32 = new Uint32Array(f32.buffer);
    f32[0] = value;
    const bits = u32[0];
    const sign = (bits >> 31) & 0x1;
    const exp32 = (bits >> 23) & 0xff;
    const mant32 = bits & 0x7fffff;
    let exp16;
    let mant16;
    if (exp32 === 0) {
        exp16 = 0;
        mant16 = 0;
    }
    else if (exp32 === 0xff) {
        exp16 = 0x1f;
        mant16 = mant32 ? 0x200 : 0;
    }
    else {
        const newExp = exp32 - 127 + 15;
        if (newExp >= 0x1f) {
            exp16 = 0x1f;
            mant16 = 0;
        }
        else if (newExp <= 0) {
            exp16 = 0;
            mant16 = 0;
        }
        else {
            exp16 = newExp;
            mant16 = mant32 >> 13;
        }
    }
    return (sign << 15) | (exp16 << 10) | mant16;
}
/**
 * Convert f16 bits to f32.
 */
function f16BitsToF32(bits) {
    const sign = (bits >> 15) & 0x1;
    const exp16 = (bits >> 10) & 0x1f;
    const mant16 = bits & 0x3ff;
    let exp32;
    let mant32;
    if (exp16 === 0) {
        if (mant16 === 0) {
            exp32 = 0;
            mant32 = 0;
        }
        else {
            // Subnormal
            let e = -1;
            let m = mant16;
            while ((m & 0x400) === 0) {
                m <<= 1;
                e -= 1;
            }
            exp32 = 127 - 15 + e + 1;
            mant32 = (m & 0x3ff) << 13;
        }
    }
    else if (exp16 === 0x1f) {
        exp32 = 0xff;
        mant32 = mant16 ? 0x400000 : 0;
    }
    else {
        exp32 = exp16 - 15 + 127;
        mant32 = mant16 << 13;
    }
    const u32 = new Uint32Array(1);
    const f32 = new Float32Array(u32.buffer);
    u32[0] = (sign << 31) | (exp32 << 23) | mant32;
    return f32[0];
}
// ---------------------------------------------------------------------------
// Layout Compilation
// ---------------------------------------------------------------------------
function compileLayout(schema, addressSpace) {
    // Generate writer
    const writeCtx = { addressSpace, offset: 0, lines: [] };
    emitWrites(writeCtx, schema, 'd');
    const totalSize = sizeOf(schema, addressSpace);
    const stride = strideOf(schema, addressSpace);
    const writeCode = `return function(v,o,d){${writeCtx.lines.join('')}}`;
    // Generate reader
    const readCtx = { addressSpace, offset: 0};
    const readExpr = emitReads(readCtx, schema);
    const readCode = `return function(v,o){return ${readExpr}}`;
    // Compile functions with f16 helpers in scope
    const write = new Function('f16', writeCode)(f32ToF16Bits);
    const read = new Function('f16r', readCode)(f16BitsToF32);
    return { totalSize, stride, write, read };
}

/** Create a new Bindings state */
function createBindingsState() {
    return {
        layoutCache: createBindGroupLayoutCache(),
        data: new WeakMap(),
    };
}
/**
 * Derive GPUTextureBindingLayout from the WGSL type string.
 * Maps texture type names to the correct sampleType and viewDimension.
 */
function getTextureLayoutFromType(wgslType) {
    const layout = {};
    // View dimension
    if (wgslType.includes('cube_array')) {
        layout.viewDimension = 'cube-array';
    }
    else if (wgslType.includes('cube')) {
        layout.viewDimension = 'cube';
    }
    else if (wgslType.includes('2d_array')) {
        layout.viewDimension = '2d-array';
    }
    else if (wgslType.includes('3d')) {
        layout.viewDimension = '3d';
    }
    // default is '2d'
    // Sample type
    if (wgslType.startsWith('texture_depth')) {
        layout.sampleType = 'depth';
    }
    // default is 'float'
    return layout;
}
/**
 * Get or create BindGroupData for a BindGroup.
 * This is the DataMap pattern - auto-creates data on first access.
 */
function getData(state, bindGroup) {
    let data = state.data.get(bindGroup);
    if (!data) {
        data = {
            bindGroup: null,
            bindGroupLayout: null,
            needsUpdate: true,
        };
        state.data.set(bindGroup, data);
    }
    return data;
}
/** Update all bindings for a RenderObject. */
function updateRenderBindings(state, renderObject, frame, device, bufferCache, textureCache) {
    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState)
        return;
    // Get BindGroups for this RenderObject (shared groups reused, non-shared cloned)
    const bindGroups = getBindings(renderObject);
    // Update each BindGroup
    const gpuBindGroups = [];
    for (const bindGroup of bindGroups) {
        // Initialize bind group layout if needed
        initBindGroup(state, bindGroup, device, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT);
        // Update uniforms and check if bind group needs rebuild
        const data = getData(state, bindGroup);
        updateRenderBindGroup(data, bindGroup, renderObject, frame, device, bufferCache, textureCache);
        if (data.needsUpdate || !data.bindGroup) {
            rebuildGPUBindGroup(device, bufferCache, textureCache, bindGroup, data, renderObject.geometry);
            data.needsUpdate = false;
        }
        if (data.bindGroup) {
            gpuBindGroups.push(data.bindGroup);
        }
    }
    // Store on RenderObject
    renderObject.bindGroups = gpuBindGroups;
}
/** Update all bindings for a compute pass and return GPUBindGroups. */
function updateComputeBindings(state, nodeBuilderState, frame, device, bufferCache, textureCache) {
    const gpuBindGroups = [];
    for (const bindGroup of nodeBuilderState.bindings) {
        // Initialize bind group layout if needed
        initBindGroup(state, bindGroup, device, GPUShaderStage.COMPUTE);
        // Update bindings
        const data = getData(state, bindGroup);
        updateComputeBindGroup(data, bufferCache, textureCache, device, bindGroup, frame);
        // Rebuild GPU bind group if needed
        if (data.needsUpdate || !data.bindGroup) {
            rebuildGPUBindGroup(device, bufferCache, textureCache, bindGroup, data, null);
            data.needsUpdate = false;
        }
        if (data.bindGroup) {
            gpuBindGroups.push(data.bindGroup);
        }
    }
    return gpuBindGroups;
}
/** Initialize bindings for a RenderObject. */
function initRenderBindings(state, renderObject, device) {
    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState)
        return;
    // Get BindGroups for this RenderObject
    const bindGroups = getBindings(renderObject);
    // Initialize each BindGroup
    for (const bindGroup of bindGroups) {
        initBindGroup(state, bindGroup, device, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT);
    }
}
/** Get the bind group layouts for a RenderObject. Used for pipeline creation. */
function getRenderBindGroupLayouts(state, renderObject) {
    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState)
        return [];
    // Get BindGroups for this RenderObject
    const bindGroups = getBindings(renderObject);
    // Build layouts array - array index matches @group(N) since groups are sorted
    const layouts = [];
    for (const bindGroup of bindGroups) {
        const data = getData(state, bindGroup);
        if (data.bindGroupLayout) {
            layouts.push(data.bindGroupLayout);
        }
    }
    return layouts;
}
/** Initialize a BindGroup (create layout). Called once per BindGroup. */
function initBindGroup(state, bindGroup, device, visibility) {
    const data = getData(state, bindGroup);
    // already initialized
    if (data.bindGroupLayout)
        return;
    // build bind group layout entries
    const entries = buildLayoutEntries(bindGroup, visibility);
    // get or create the layout
    data.bindGroupLayout = getBindGroupLayout(state.layoutCache, device, entries);
}
/** Build bind group layout entries for a BindGroup. */
function buildLayoutEntries(bindGroup, visibility) {
    const entries = [];
    for (const binding of bindGroup.bindings) {
        switch (binding.kind) {
            case 'uniform':
                entries.push({
                    binding: binding.block.binding,
                    visibility,
                    buffer: { type: 'uniform' },
                });
                break;
            case 'storage':
                entries.push({
                    binding: binding.entry.binding,
                    visibility,
                    buffer: {
                        type: binding.entry.access === 'read_write'
                            ? 'storage'
                            : 'read-only-storage',
                    },
                });
                break;
            case 'texture': {
                const texLayout = getTextureLayoutFromType(binding.entry.type);
                entries.push({
                    binding: binding.entry.binding,
                    visibility,
                    texture: texLayout,
                });
                break;
            }
            case 'sampler':
                entries.push({
                    binding: binding.entry.binding,
                    visibility,
                    sampler: {
                        type: binding.entry.type === 'sampler_comparison' ? 'comparison' : 'filtering',
                    },
                });
                break;
        }
    }
    // Sort by binding index
    entries.sort((a, b) => a.binding - b.binding);
    return entries;
}
/** Update a BindGroup (uniforms, textures, etc.).  Called every frame */
function updateRenderBindGroup(data, bindGroup, renderObject, frame, device, bufferCache, textureCache) {
    for (const binding of bindGroup.bindings) {
        switch (binding.kind) {
            case 'uniform':
                updateUniformBinding(bufferCache, device, binding, frame, data, renderObject.material);
                break;
            case 'texture':
                updateTextureBinding(textureCache, device, binding, data);
                break;
            case 'sampler':
                updateSamplerBinding(textureCache, device, binding, data);
                break;
            case 'storage':
                updateStorageBinding(bufferCache, device, binding, data, renderObject.geometry);
                break;
        }
    }
}
/** Update a uniform binding */
function updateUniformBinding(bufferCache, device, binding, frame, data, material = null) {
    const block = binding.block;
    // Deduplication gate: skip if this binding was already processed at the current frame/render ID.
    // Based on groupNode.updateType:
    //   'frame'  - check frameId (once per animation frame)
    //   'render' - check renderId (once per render() call)
    //   'object' - always process (content changes per-mesh)
    //   'none'   - always process
    if (block.groupNode.shared) {
        const updateType = block.groupNode.updateType;
        if (updateType === 'frame') {
            if (binding.lastFrameId === frame.frameId)
                return;
            binding.lastFrameId = frame.frameId;
        }
        else if (updateType === 'render') {
            if (binding.lastRenderId === frame.renderId)
                return;
            binding.lastRenderId = frame.renderId;
        }
        // 'object' and 'none' always process
    }
    // invoke update callbacks with the NodeFrame
    invokeUniformGroupCallbacks(block, frame);
    // create buffer key if needed
    if (!binding.bufferKey) {
        binding.bufferKey = {};
    }
    // Ensure we have preallocated double buffers
    const requiredBytes = block.totalBytes;
    if (!binding.currentBuffer || binding.currentBuffer.byteLength !== requiredBytes) {
        binding.currentBuffer = new ArrayBuffer(requiredBytes);
        binding.scratchBuffer = new ArrayBuffer(requiredBytes);
    }
    // Pack into scratch buffer, then compare with current
    const changed = packAndCompare(block, binding.currentBuffer, binding.scratchBuffer, material);
    const uploaded = !!getRaw(bufferCache, binding.bufferKey);
    if (changed || !uploaded) {
        if (changed) {
            // Swap buffers: scratch becomes current
            const temp = binding.currentBuffer;
            binding.currentBuffer = binding.scratchBuffer;
            binding.scratchBuffer = temp;
        }
        const U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
        const f32View = new Float32Array(binding.currentBuffer);
        const result = uploadRaw(bufferCache, device, binding.bufferKey, f32View, U);
        // Only rebuild bind group if buffer was created/resized (not just written to)
        if (result.created) {
            data.needsUpdate = true;
        }
    }
}
/**
 * Pack uniforms into scratch buffer and compare against current buffer.
 * Uses compiled layout for correct WGSL alignment.
 * Returns true if any values changed.
 */
function packAndCompare(block, currentBuffer, scratchBuffer, material) {
    const view = new DataView(scratchBuffer);
    // Pack each uniform member using compiled layout
    for (const m of block.members) {
        let value = m.node.uniform.value;
        if (value === null && material) {
            const matUniform = material.uniforms.get(m.node.name);
            if (matUniform) {
                value = matUniform.value;
            }
        }
        if (value === null || value === undefined)
            continue;
        // Cast needed: UniformValue is broader than Infer<schema> but matches at runtime
        packToView(m.schema, view, m.offset, value, 'uniform');
    }
    // Compare buffers byte-by-byte using typed arrays
    const current = new Uint32Array(currentBuffer);
    const scratch = new Uint32Array(scratchBuffer);
    const len = current.length;
    for (let i = 0; i < len; i++) {
        if (current[i] !== scratch[i]) {
            return true;
        }
    }
    return false;
}
/** Update a texture binding. */
function updateTextureBinding(textureCache, device, binding, data) {
    const textureNode = binding.entry.node;
    const gpuTexture = textureNode.value;
    if (gpuTexture === null)
        return;
    // For render target textures, the GPU resource is set externally via setRenderTargetTexture().
    // For regular textures, updateTexture() handles upload.
    // Both cases: check generation to detect changes.
    if (!gpuTexture.isRenderTargetTexture) {
        // Regular texture - upload source data
        const texData = updateTexture(textureCache, device, gpuTexture);
        if (binding.generation !== texData.generation) {
            binding.generation = texData.generation;
            data.needsUpdate = true;
        }
    }
    else {
        // Render target texture - resource set externally, check cache for changes
        const texData = getTextureData(textureCache, gpuTexture);
        if (texData) {
            if (binding.generation !== texData.generation) {
                binding.generation = texData.generation;
                data.needsUpdate = true;
            }
        }
    }
}
/** Update a sampler binding. */
function updateSamplerBinding(textureCache, device, binding, data) {
    const samplerNode = binding.entry.samplerNode;
    const gpuSampler = samplerNode.value;
    // Create/get sampler from GpuSampler settings (this caches by settingsKey)
    getSampler(textureCache, device, gpuSampler);
    getSampler(textureCache, device, gpuSampler);
    // Check for sampler changes using settingsKey
    const samplerKey = gpuSampler.settingsKey;
    if (binding.samplerKey !== samplerKey) {
        binding.samplerKey = samplerKey;
        data.needsUpdate = true;
    }
}
/** Update a storage binding - detect buffer swaps and flush data to GPU. */
function updateStorageBinding(bufferCache, device, binding, data, geometry) {
    const node = binding.entry.node;
    const buffer = resolveStorageBuffer(node, geometry);
    // If buffer identity changed, need to rebuild bind group
    if (buffer !== binding.lastBuffer) {
        binding.lastBuffer = buffer;
        data.needsUpdate = true;
    }
    // Flush pending data to GPU (version check / partial ranges handled inside)
    ensureUploaded(bufferCache, device, buffer);
}
/** Rebuild the GPU bind group for a BindGroup */
function rebuildGPUBindGroup(device, bufferCache, textureCache, bindGroup, data, geometry) {
    if (!data.bindGroupLayout)
        return;
    const entries = [];
    for (const binding of bindGroup.bindings) {
        switch (binding.kind) {
            case 'uniform': {
                if (binding.bufferKey) {
                    const buffer = getRaw(bufferCache, binding.bufferKey);
                    if (buffer) {
                        entries.push({ binding: binding.block.binding, resource: { buffer } });
                    }
                }
                break;
            }
            case 'storage': {
                const buffer = resolveStorageBuffer(binding.entry.node, geometry);
                const buf = getUploaded(bufferCache, buffer);
                if (buf) {
                    entries.push({ binding: binding.entry.binding, resource: { buffer: buf } });
                }
                break;
            }
            case 'texture': {
                const textureNode = binding.entry.node;
                const gpuTexture = textureNode.value;
                if (!gpuTexture)
                    break;
                // Get GPU texture from cache
                const texData = getTextureData(textureCache, gpuTexture);
                if (texData) {
                    const view = texData.texture.createView({ dimension: gpuTexture.viewDimension });
                    entries.push({ binding: binding.entry.binding, resource: view });
                }
                break;
            }
            case 'sampler': {
                const samplerNode = binding.entry.samplerNode;
                const gpuSampler = samplerNode.value;
                if (!gpuSampler)
                    break;
                // Get GPU sampler from cache using settingsKey
                const samplerData = textureCache.samplerCache.get(gpuSampler.settingsKey);
                if (samplerData) {
                    entries.push({ binding: binding.entry.binding, resource: samplerData.sampler });
                }
                break;
            }
        }
    }
    // Sort entries by binding
    entries.sort((a, b) => a.binding - b.binding);
    if (entries.length > 0) {
        data.bindGroup = device.createBindGroup({
            layout: data.bindGroupLayout,
            entries,
        });
    }
}
/** Invoke update callbacks on uniform nodes in a group. */
function invokeUniformGroupCallbacks(block, frame) {
    for (const m of block.members) {
        const node = m.node;
        if (node.update) {
            // Use NodeFrame's updateNode which respects updateType and deduplicates:
            // - FRAME: runs once per frameId
            // - RENDER: runs once per renderId  
            // - OBJECT: runs every time (per mesh)
            // The callback itself assigns node.value and bumps node.version (see UniformNode.onUpdate)
            frame.updateNode(node);
        }
    }
}
/** Update a compute BindGroup (uniforms, textures, samplers, storage). */
function updateComputeBindGroup(data, bufferCache, textureCache, device, bindGroup, frame) {
    for (const binding of bindGroup.bindings) {
        switch (binding.kind) {
            case 'uniform':
                updateUniformBinding(bufferCache, device, binding, frame, data);
                break;
            case 'storage':
                updateStorageBinding(bufferCache, device, binding, data, null);
                break;
            case 'texture':
                updateTextureBinding(textureCache, device, binding, data);
                break;
            case 'sampler':
                updateSamplerBinding(textureCache, device, binding, data);
                break;
        }
    }
}

/** Create a new empty ChainMap */
function create$9() {
    return {
        weakMaps: new Map(),
    };
}
/** Get the root WeakMap for a given key length, creating it if necessary */
function getWeakMap(map, keyLength) {
    let weakMap = map.weakMaps.get(keyLength);
    if (weakMap === undefined) {
        weakMap = new WeakMap();
        map.weakMaps.set(keyLength, weakMap);
    }
    return weakMap;
}
/**
 * Get a value from the ChainMap by composite key.
 * @param map the ChainMap to query
 * @param keys array of objects forming the composite key
 * @returns the cached value, or undefined if not found
 */
function get(map, keys) {
    if (keys.length === 0)
        return undefined;
    let current = getWeakMap(map, keys.length);
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const next = current.get(key);
        if (next === undefined) {
            return undefined;
        }
        current = next;
    }
    return current;
}
/**
 * Set a value in the ChainMap by composite key.
 * @param map the ChainMap to modify
 * @param keys array of objects forming the composite key
 * @param value the value to cache
 */
function set$3(map, keys, value) {
    if (keys.length === 0)
        return;
    let current = getWeakMap(map, keys.length);
    // Navigate/create intermediate WeakMaps
    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        let next = current.get(key);
        if (next === undefined) {
            next = new WeakMap();
            current.set(key, next);
        }
        current = next;
    }
    // Set the value at the final key
    current.set(keys[keys.length - 1], value);
}
/**
 * Delete a value from the ChainMap by composite key.
 * @param map the ChainMap to modify
 * @param keys array of objects forming the composite key
 * @returns true if the value existed and was deleted, false otherwise
 */
function del(map, keys) {
    if (keys.length === 0)
        return false;
    let current = getWeakMap(map, keys.length);
    // Navigate to the parent of the final key
    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        const next = current.get(key);
        if (next === undefined) {
            return false;
        }
        current = next;
    }
    // Delete the final key
    return current.delete(keys[keys.length - 1]);
}

/**
 * Create a new Geometries state.
 */
function createGeometriesState() {
    return {
        bufferCall: new WeakMap(),
        currentCallId: 0,
        geometryData: new WeakMap(),
        wireframes: new WeakMap(),
        memory: {
            geometries: 0,
            buffers: 0,
            indexBuffers: 0,
            indirectBuffers: 0,
        },
    };
}
/**
 * Increment the call ID at the start of each render call.
 * This enables per-frame deduplication.
 */
function incrementCallId(state) {
    state.currentCallId++;
}
/**
 * Update a buffer, uploading to GPU if needed.
 * Implements per-frame deduplication - each buffer is uploaded at most once per frame.
 *
 * Version tracking is delegated to buffers.ts — we only track per-frame deduplication here.
 */
function updateBuffer(state, bufferCache, device, buffer, type) {
    const callId = state.currentCallId;
    // Check if already updated this frame
    const lastCallId = state.bufferCall.get(buffer);
    if (lastCallId === callId) {
        return; // Already updated this frame
    }
    // Mark as updated for this frame
    state.bufferCall.set(buffer, callId);
    // Route to unified upload function in buffers.ts
    // buffers.ts handles version tracking internally
    switch (type) {
        case 'vertex':
        case 'indirect':
            ensureUploaded(bufferCache, device, buffer);
            break;
        // Note: 'index' type uses updateIndex() instead
    }
}
/**
 * Update an index buffer, uploading to GPU if needed.
 */
function updateIndex(state, bufferCache, device, index) {
    const callId = state.currentCallId;
    // Check if already updated this frame
    const lastCallId = state.bufferCall.get(index);
    if (lastCallId === callId) {
        return; // Already updated this frame
    }
    // Mark as updated for this frame
    state.bufferCall.set(index, callId);
    ensureUploaded(bufferCache, device, index);
}
/**
 * Delete a buffer from the deduplication tracking.
 * Note: This doesn't destroy the GPU buffer - buffers.ts handles that via WeakMap GC.
 */
function deleteBuffer(state, buffer) {
    state.bufferCall.delete(buffer);
}
/**
 * Initialize a geometry for rendering.
 *
 * This uploads all vertex buffers and the index buffer (if present).
 * Called once when a geometry is first encountered.
 */
function initGeometry(state, bufferCache, device, geometry) {
    let data = state.geometryData.get(geometry);
    if (data && data.initialized) {
        return; // already initialized
    }
    // create tracking data
    if (!data) {
        data = {
            initialized: false,
        };
        state.geometryData.set(geometry, data);
        state.memory.geometries++;
    }
    // upload all vertex buffers
    for (const [_name, buffer] of geometry.buffers) {
        if (buffer.usage.has('vertex')) {
            updateBuffer(state, bufferCache, device, buffer, 'vertex');
            state.memory.buffers++;
        }
    }
    // upload index buffer if present
    if (geometry.index) {
        updateIndex(state, bufferCache, device, geometry.index);
        state.memory.indexBuffers++;
    }
    // upload indirect buffer if present
    if (geometry.indirect) {
        updateBuffer(state, bufferCache, device, geometry.indirect, 'indirect');
        state.memory.indirectBuffers++;
    }
    data.initialized = true;
    // set up disposal callback
    geometry._onDispose = () => {
        disposeGeometry(state, geometry);
    };
}
/**
 * Update a geometry for rendering.
 *
 * This checks for version changes and re-uploads modified buffers.
 * Called every frame for each visible geometry.
 *
 * Note: Version tracking is handled by buffers.ts. We just ensure each
 * buffer goes through the upload path (with per-frame deduplication).
 */
function updateForRender(state, bufferCache, device, renderObject) {
    const geometry = renderObject.geometry;
    let data = state.geometryData.get(geometry);
    // initialize if needed
    if (!data || !data.initialized) {
        initGeometry(state, bufferCache, device, geometry);
        return; // initGeometry already uploads everything
    }
    // Update all vertex buffers (buffers.ts handles version checking)
    for (const [_name, buffer] of geometry.buffers) {
        if (buffer.usage.has('vertex')) {
            updateBuffer(state, bufferCache, device, buffer, 'vertex');
        }
    }
    // Update index buffer if present
    if (geometry.index) {
        updateIndex(state, bufferCache, device, geometry.index);
    }
    // Update indirect buffer if present
    if (geometry.indirect) {
        updateBuffer(state, bufferCache, device, geometry.indirect, 'indirect');
    }
}
/**
 * Dispose a geometry and clean up tracking.
 */
function disposeGeometry(state, geometry) {
    const data = state.geometryData.get(geometry);
    if (!data)
        return;
    // delete buffer tracking
    for (const [_name, buffer] of geometry.buffers) {
        deleteBuffer(state, buffer);
    }
    // delete index buffer tracking
    if (geometry.index) {
        deleteBuffer(state, geometry.index);
    }
    // delete wireframe index buffer if it exists
    const wireframeIndex = state.wireframes.get(geometry);
    if (wireframeIndex) {
        deleteBuffer(state, wireframeIndex);
        state.wireframes.delete(geometry);
    }
    // remove tracking data
    state.geometryData.delete(geometry);
    state.memory.geometries--;
}

/**
 * render-objects.ts - RenderObject manager with ChainMap caching.
 *
 * Coordinates initialization of NodeBuilderState, pipeline, bindings.
 * Subsystem dependencies (nodes, geometries, bindings, pipelines, device,
 * bufferCache, textureCache) are passed as function parameters — not stored
 * in state.
 */
/**
 * Create a new RenderObjects state.
 */
function createRenderObjectsState() {
    return {
        chainMaps: new Map(),
        renderObjects: new Set(),
    };
}
/**
 * Get or create the ChainMap for a pass.
 */
function getChainMap(state, passId) {
    let map = state.chainMaps.get(passId);
    if (!map) {
        map = create$9();
        state.chainMaps.set(passId, map);
    }
    return map;
}
/**
 * Get or create a RenderObject for the given parameters.
 *
 * This is the main entry point for obtaining a RenderObject. It:
 * 1. Looks up existing RenderObject in ChainMap cache
 * 2. Creates new RenderObject if not found
 */
function getRenderObject(state, mesh, material, scene, camera, renderContext, passId = 'default') {
    const map = getChainMap(state, passId);
    const keys = [mesh, material, renderContext];
    // Try to get existing RenderObject
    let renderObject = get(map, keys);
    if (!renderObject) {
        // Create new RenderObject
        renderObject = createRenderObject(mesh, material, scene, camera, renderContext);
        // Compute and store initial cache key
        renderObject.initialCacheKey = computeRenderObjectCacheKey(material, mesh.geometry, renderContext);
        // Tag with the pass this RO belongs to
        renderObject.passId = passId;
        // Set up disposal callback
        renderObject.onDispose = () => {
            del(map, keys);
            state.renderObjects.delete(renderObject);
        };
        // Set up material disposal callback (like geometries.ts does for geometry)
        if (!material._onDispose) {
            material._onDispose = () => {
                disposeRenderObjectsForMaterial(state, material);
            };
        }
        // Cache it
        set$3(map, keys, renderObject);
        state.renderObjects.add(renderObject);
    }
    else {
        // Update mutable references that may have changed
        renderObject.camera = camera;
        renderObject.scene = scene;
        renderObject.passId = passId;
    }
    return renderObject;
}
/**
 * Initialize a RenderObject for rendering.
 *
 * This ensures the RenderObject has:
 * - NodeBuilderState (compiled shader)
 * - Pipeline
 * - Bindings
 * - Geometry attributes uploaded
 *
 * Call this before rendering with a RenderObject.
 *
 * @returns true if initialization succeeded
 */
function initRenderObject(nodes, geometriesState, bindingsState, pipelinesState, device, bufferCache, renderObject, colorFormat, depthFormat) {
    const material = renderObject.material;
    const geometry = renderObject.geometry;
    const renderContext = renderObject.renderContext;
    // Check if we need to (re)compile using fast version comparison
    if (needsNodeUpdate(nodes, renderObject)) {
        // Only compute cache key when we actually need to recompile
        const cacheKey = computeRenderObjectCacheKey(material, geometry, renderContext);
        // Compile node graph
        compileNodeState(nodes, renderObject, cacheKey);
    }
    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState) {
        console.warn('[RenderObjects] Failed to compile NodeBuilderState');
        return false;
    }
    // Initialize bindings (creates bind group layouts)
    initRenderBindings(bindingsState, renderObject, device);
    // Get bind group layouts for pipeline creation
    const bindGroupLayouts = getRenderBindGroupLayouts(bindingsState, renderObject);
    // Check if we need to create/update pipeline
    if (!renderObject.pipeline) {
        // Create pipeline using the unified pipelines system (sync)
        const entry = getForRender(pipelinesState, device, renderObject, bindGroupLayouts, colorFormat, depthFormat, null);
        renderObject.pipeline = entry.pipeline;
    }
    // Update geometry attributes
    updateForRender(geometriesState, bufferCache, device, renderObject);
    return true;
}
/**
 * Update a RenderObject for rendering.
 *
 * This is called each frame to:
 * - Update uniform buffers
 * - Rebuild bind groups if needed
 */
function updateRenderObject(bindingsState, geometriesState, device, bufferCache, textureCache, renderObject, frame) {
    // Update bindings (uniforms, bind groups)
    updateRenderBindings(bindingsState, renderObject, frame, device, bufferCache, textureCache);
    // Update geometry if needed
    updateForRender(geometriesState, bufferCache, device, renderObject);
}
/**
 * Initialize a RenderObject for pre-warming with async pipeline compilation.
 *
 * This is similar to initRenderObject but collects pipeline compilation promises
 * for non-blocking compilation. Use this in renderer.compile() to pre-warm all
 * pipelines without blocking the main thread.
 *
 * @returns true if initialization succeeded (pipeline may still be compiling)
 */
function initRenderObjectWithPromises(nodes, geometriesState, bindingsState, pipelinesState, device, bufferCache, renderObject, colorFormat, depthFormat, promises) {
    const material = renderObject.material;
    const geometry = renderObject.geometry;
    const renderContext = renderObject.renderContext;
    // Check if we need to (re)compile using fast version comparison
    if (needsNodeUpdate(nodes, renderObject)) {
        // Only compute cache key when we actually need to recompile
        const cacheKey = computeRenderObjectCacheKey(material, geometry, renderContext);
        // Compile node graph (sync - this is fast)
        compileNodeState(nodes, renderObject, cacheKey);
    }
    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState) {
        console.warn('[RenderObjects] Failed to compile NodeBuilderState');
        return false;
    }
    // Initialize bindings (creates bind group layouts)
    initRenderBindings(bindingsState, renderObject, device);
    // Get bind group layouts for pipeline creation
    const bindGroupLayouts = getRenderBindGroupLayouts(bindingsState, renderObject);
    // Check if we need to create/update pipeline
    if (!renderObject.pipeline) {
        // Create pipeline asynchronously using the unified pipelines system
        const entry = getForRender(pipelinesState, device, renderObject, bindGroupLayouts, colorFormat, depthFormat, promises);
        // Pipeline will be set when promise resolves, but we track the entry
        // The actual pipeline assignment happens after promises resolve
        promises.push(Promise.resolve().then(() => {
            if (entry.pipeline) {
                renderObject.pipeline = entry.pipeline;
            }
        }));
    }
    // Update geometry attributes
    updateForRender(geometriesState, bufferCache, device, renderObject);
    return true;
}
/** Dispose all RenderObjects for a specific material. */
function disposeRenderObjectsForMaterial(state, material) {
    for (const renderObject of state.renderObjects) {
        if (renderObject.material === material) {
            disposeRenderObject(renderObject);
        }
    }
}
/** Get statistics about RenderObjects. */
function getRenderObjectsStats(state) {
    const perPass = {};
    // count render objects per pass (approximate - we can't enumerate ChainMap)
    for (const passId of state.chainMaps.keys()) {
        perPass[passId] = 0;
    }
    // count from the set
    for (const ro of state.renderObjects) {
        const p = ro.passId || 'default';
        if (p in perPass)
            perPass[p]++;
        else
            perPass[p] = 1;
    }
    return {
        total: state.renderObjects.size,
        perPass,
    };
}

/**
 * RendererInspector.ts — Stats-collecting inspector layer.
 *
 * Extends InspectorBase with per-frame stats accumulation, a rolling frame
 * history buffer (512 frames), and optional GPU timestamp-query support.
 *
 * Architecture:
 *   - begin(frameId) resets per-frame counters and records a CPU timestamp.
 *   - finish(frameId) seals the frame record and optionally resolves GPU timestamps.
 *   - beginRender/finishRender track CPU wall-time per render pass.
 *   - beginCompute/finishCompute track CPU wall-time per compute dispatch.
 *   - resolveFrame() returns the most recent fully-resolved FrameRecord.
 *
 * GPU timestamp queries (optional):
 *   If the 'timestamp-query' feature is available, the renderer passes
 *   hasTimestamps=true to init(). We allocate a GPUQuerySet and a resolve
 *   buffer and read them back asynchronously after each submit.
 *   Each pass gets two slots: [begin, end]. Max 64 passes per frame.
 */
const FRAME_HISTORY = 512;
const MAX_PASSES_PER_FRAME = 64;
// ---------------------------------------------------------------------------
// RendererInspector
// ---------------------------------------------------------------------------
class RendererInspector extends InspectorBase {
    /** Rolling ring buffer of frame records. */
    frames = new Array(FRAME_HISTORY).fill(null);
    /** Index of the most recently completed frame in the ring buffer. */
    frameHead = -1;
    /** Live registry of compute nodes seen by the inspector. */
    computeNodes = new Map();
    // GPU timestamp state
    hasTimestamps = false;
    _querySet = null;
    _resolveBuffer = null;
    _readbackBuffer = null;
    // FPS tracking
    _lastFinishTime = 0;
    _deltaTimes = [];
    get fps() {
        const deltas = this._deltaTimes;
        if (deltas.length === 0)
            return 0;
        let timeSum = 0;
        let frameSum = 0;
        for (let i = deltas.length - 1; i >= 0; i--) {
            timeSum += deltas[i];
            frameSum++;
            if (timeSum >= 1000)
                break;
        }
        return frameSum * 1000 / timeSum;
    }
    // Per-frame working state
    _frameStart = 0;
    _currentQuerySlot = 0;
    _pendingInspectables = [];
    _pendingScenes = [];
    // Timeline entry stack - entries nest inside the current stack top
    // The stack holds "in-progress" entries that haven't been closed yet
    _entryStack = [];
    // Root-level timeline entries (completed top-level entries go here)
    _rootTimeline = [];
    // Map of name → stack of open entries with that name (handles same-name passes)
    _entryRefs = new Map();
    init() {
        if (!this.renderer)
            return;
        const device = this.renderer._device;
        this.hasTimestamps = device?.features?.has('timestamp-query') ?? false;
        if (this.hasTimestamps && device) {
            this._querySet = device.createQuerySet({
                type: 'timestamp',
                count: MAX_PASSES_PER_FRAME * 2,
            });
            const resolveSize = MAX_PASSES_PER_FRAME * 2 * 8; // 2 timestamps × 8 bytes (BigInt64)
            this._resolveBuffer = device.createBuffer({
                size: resolveSize,
                usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
            });
            this._readbackBuffer = device.createBuffer({
                size: resolveSize,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });
        }
    }
    begin(frameId) {
        this._frameStart = performance.now();
        this._currentQuerySlot = 0;
        this._pendingInspectables = [];
        this._pendingScenes = [];
        this._entryStack = [];
        this._rootTimeline = [];
        this._entryRefs.clear();
    }
    finish(frameId) {
        if (!this.renderer)
            return;
        const now = performance.now();
        const cpuMs = now - this._frameStart;
        // FPS tracking
        if (this._lastFinishTime > 0) {
            this._deltaTimes.push(now - this._lastFinishTime);
            if (this._deltaTimes.length > 60)
                this._deltaTimes.shift();
        }
        this._lastFinishTime = now;
        // Close any unclosed entries (shouldn't happen, but be safe)
        while (this._entryStack.length > 0) {
            this._closeCurrentEntry(now);
        }
        const record = {
            frameId,
            cpuMs,
            gpuMs: null,
            timeline: [...this._rootTimeline],
            bufferStats: getBufferCacheStats(this.renderer._buffers),
            pipelineStats: getStats(this.renderer._pipelines),
            renderObjectStats: getRenderObjectsStats(this.renderer._renderObjects),
            inspectableNodes: [...this._pendingInspectables],
            scenes: [...this._pendingScenes],
        };
        this.frameHead = (this.frameHead + 1) % FRAME_HISTORY;
        this.frames[this.frameHead] = record;
        // Async GPU timestamp resolution
        if (this.hasTimestamps && this._querySet && this._resolveBuffer && this._readbackBuffer && this.renderer._device) {
            this._resolveTimestamps(frameId, record);
        }
    }
    beginRender(passId, _frameId) {
        const now = performance.now();
        const slot = this._currentQuerySlot++;
        const entry = {
            kind: 'render',
            name: passId,
            startTime: now - this._frameStart,
            cpuMs: 0,
            gpuMs: null,
            querySlot: slot,
            children: [],
        };
        this._pushEntry(entry);
    }
    finishRender(passId, _frameId) {
        this._finishEntry(passId);
    }
    getTimestampWrites(passId) {
        if (!this.hasTimestamps || !this._querySet)
            return undefined;
        // Find the most recently opened entry with this name
        const stack = this._entryRefs.get(passId);
        const entry = stack?.[stack.length - 1];
        if (!entry || entry.kind === 'marker')
            return undefined;
        const slot = entry.querySlot;
        return {
            querySet: this._querySet,
            beginningOfPassWriteIndex: slot * 2,
            endOfPassWriteIndex: slot * 2 + 1,
        };
    }
    beginCompute(node, _frameId) {
        const nodeId = node.id;
        this.computeNodes.set(nodeId, node);
        const now = performance.now();
        const slot = this._currentQuerySlot++;
        const entry = {
            kind: 'compute',
            name: nodeId,
            startTime: now - this._frameStart,
            cpuMs: 0,
            gpuMs: null,
            querySlot: slot,
            children: [],
        };
        this._pushEntry(entry);
    }
    finishCompute(nodeId, _frameId) {
        this._finishEntry(nodeId);
    }
    inspect(node) {
        this._pendingInspectables.push(node);
    }
    beginRenderScene(passId, scene, samples, colorFormat, _frameId) {
        // Deduplicate: if the same passId fires more than once this frame (shouldn't
        // happen, but be safe) just overwrite so we always have the latest.
        const existing = this._pendingScenes.findIndex(s => s.passId === passId);
        const record = { passId, scene, samples, colorFormat };
        if (existing >= 0) {
            this._pendingScenes[existing] = record;
        }
        else {
            this._pendingScenes.push(record);
        }
    }
    // -----------------------------------------------------------------------
    // Public perf API - for user code to add markers
    // -----------------------------------------------------------------------
    /** Public API for adding performance markers from user code */
    perf = {
        /**
         * Start a named performance marker. Can be nested.
         * Any render/compute passes or child markers will be added as children.
         */
        start: (name) => {
            const now = performance.now();
            const entry = {
                kind: 'marker',
                name,
                startTime: now - this._frameStart,
                cpuMs: 0,
                children: [],
            };
            this._pushEntry(entry);
        },
        /**
         * End a named performance marker.
         * Calculates duration and closes the marker.
         */
        end: (name) => {
            this._finishEntry(name);
        },
    };
    // -----------------------------------------------------------------------
    // Timeline entry management
    // -----------------------------------------------------------------------
    /** Push an entry onto the stack, nesting it under current parent if any */
    _pushEntry(entry) {
        const parent = this._entryStack[this._entryStack.length - 1];
        if (parent) {
            parent.children.push(entry);
        }
        else {
            this._rootTimeline.push(entry);
        }
        this._entryStack.push(entry);
        const stack = this._entryRefs.get(entry.name);
        if (stack) {
            stack.push(entry);
        }
        else {
            this._entryRefs.set(entry.name, [entry]);
        }
    }
    /** Finish an entry by name - calculates duration and pops from stack */
    _finishEntry(name) {
        const stack = this._entryRefs.get(name);
        if (!stack || stack.length === 0)
            return;
        const entry = stack.pop();
        if (stack.length === 0)
            this._entryRefs.delete(name);
        const now = performance.now();
        entry.cpuMs = now - this._frameStart - entry.startTime;
        const idx = this._entryStack.lastIndexOf(entry);
        if (idx >= 0) {
            this._entryStack.splice(idx, 1);
        }
    }
    /** Close the current top entry (used for unclosed entries at frame end) */
    _closeCurrentEntry(now) {
        const entry = this._entryStack.pop();
        if (!entry)
            return;
        entry.cpuMs = now - this._frameStart - entry.startTime;
        const stack = this._entryRefs.get(entry.name);
        if (stack) {
            const idx = stack.lastIndexOf(entry);
            if (idx >= 0)
                stack.splice(idx, 1);
            if (stack.length === 0)
                this._entryRefs.delete(entry.name);
        }
    }
    // -----------------------------------------------------------------------
    // Public query API
    // -----------------------------------------------------------------------
    /** Returns the most recent completed FrameRecord, or null. */
    resolveFrame() {
        if (this.frameHead < 0)
            return null;
        return this.frames[this.frameHead];
    }
    /** Returns a slice of the last `count` frame records, oldest first. */
    getRecentFrames(count) {
        const result = [];
        for (let i = 0; i < Math.min(count, FRAME_HISTORY); i++) {
            const idx = (this.frameHead - i + FRAME_HISTORY) % FRAME_HISTORY;
            const f = this.frames[idx];
            if (f)
                result.unshift(f);
        }
        return result;
    }
    // -----------------------------------------------------------------------
    // GPU timestamp resolution
    // -----------------------------------------------------------------------
    /** Collect all GPU entries (render/compute) from timeline tree, mapped by querySlot */
    _collectGpuEntries(entries, out) {
        for (const entry of entries) {
            if (entry.kind === 'render' || entry.kind === 'compute') {
                out.set(entry.querySlot, entry);
            }
            if (entry.children.length > 0) {
                this._collectGpuEntries(entry.children, out);
            }
        }
    }
    /**
     * Resolves GPU timestamps for a frame.
     * Checks buffer.mapState before using, skips if not 'unmapped'.
     */
    _resolveTimestamps(frameId, record) {
        const device = this.renderer._device;
        // Collect GPU entries from timeline
        const gpuEntries = new Map();
        this._collectGpuEntries(record.timeline, gpuEntries);
        const slotCount = Math.min(gpuEntries.size, MAX_PASSES_PER_FRAME);
        if (slotCount === 0)
            return;
        const rb = this._readbackBuffer;
        // Check mapState before using buffer
        if (rb.mapState !== 'unmapped')
            return;
        // Find the max slot used to know how many to resolve
        let maxSlot = 0;
        for (const slot of gpuEntries.keys()) {
            if (slot > maxSlot)
                maxSlot = slot;
        }
        const slotsToResolve = maxSlot + 1;
        const encoder = device.createCommandEncoder();
        encoder.resolveQuerySet(this._querySet, 0, slotsToResolve * 2, this._resolveBuffer, 0);
        encoder.copyBufferToBuffer(this._resolveBuffer, 0, rb, 0, slotsToResolve * 2 * 8);
        device.queue.submit([encoder.finish()]);
        rb.mapAsync(GPUMapMode.READ, 0, slotsToResolve * 2 * 8).then(() => {
            const data = new BigUint64Array(rb.getMappedRange(0, slotsToResolve * 2 * 8));
            let totalGpuNs = 0n;
            for (const [slot, entry] of gpuEntries) {
                const beginNs = data[slot * 2];
                const endNs = data[slot * 2 + 1];
                if (endNs <= beginNs)
                    continue; // unwritten or bogus timestamp
                const durationNs = endNs - beginNs;
                entry.gpuMs = Number(durationNs) / 1_000_000;
                totalGpuNs += durationNs;
            }
            record.gpuMs = Number(totalGpuNs) / 1_000_000;
            rb.unmap();
        }).catch(() => {
            if (rb.mapState === 'mapped')
                rb.unmap();
        });
    }
}

/**
 * style.ts — Injects the inspector CSS into the document once.
 * CSS targets the actual class/id names emitted by profiler.ts, tab.ts,
 * list.ts, item.ts, graph.ts, values.ts and the tab files.
 */
let injected = false;
function injectStyle() {
    if (injected || typeof document === 'undefined')
        return;
    injected = true;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
}
const CSS = `
/* ============================================================
   gpucat Inspector — CSS variables (scoped to profiler shell)
   ============================================================ */

#profiler-shell,
.detached-tab-panel {
	--background-color: #1a1a1a;
	--panel-bg: #1e1e1e;
	--header-bg: #252525;
	--border-color: #383838;
	--text-primary: #e0e0e0;
	--text-secondary: #888;
	--text-muted: #555;
	--accent-color: #4a9eff;
	--accent-dim: #1e3d6e;
	--color-fps: rgba(74, 158, 255, 0.7);
	--color-call: rgba(156, 39, 176, 0.7);
	--color-green: #4caf50;
	--color-yellow: #ffc107;
	--color-red: #f44336;
	--color-orange: #ff9800;
	font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
	font-size: 12px;
	color: var(--text-primary);
	box-sizing: border-box;
}

#profiler-shell *,
.detached-tab-panel * {
	box-sizing: border-box;
}

/* ============================================================
   Toggle button (the FPS pill that floats in the corner)
   ============================================================ */

#profiler-toggle {
	position: fixed;
	bottom: 0;
	left: 0;
	z-index: 1001;
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 4px 10px 4px 6px;
	background: var(--header-bg);
	border: 1px solid var(--border-color);
	border-bottom: none;
	border-radius: 6px 6px 0 0;
	color: var(--text-primary);
	cursor: pointer;
	font-family: inherit;
	font-size: 12px;
	line-height: 1;
	user-select: none;
	white-space: nowrap;
	min-height: 28px;
}

#profiler-toggle:hover {
	background: #2a2a2a;
}

#profiler-toggle.position-right {
	bottom: auto;
	top: 0;
	left: auto;
	right: 0;
	border-radius: 0 0 0 6px;
	border-bottom: 1px solid var(--border-color);
	border-right: none;
}

#fps-counter {
	font-variant-numeric: tabular-nums;
	font-weight: bold;
	color: var(--accent-color);
	min-width: 2ch;
	text-align: right;
}

.fps-label {
	font-size: 10px;
	color: var(--text-muted);
	text-transform: uppercase;
}

#toggle-icon svg {
	display: block;
	opacity: 0.6;
}

#toggle-text {
	display: flex;
	align-items: center;
	gap: 3px;
}

/* Builtin tabs container inside the toggle button */
#builtin-tabs-container {
	display: flex;
	align-items: center;
	gap: 2px;
}

.builtin-tab-btn {
	background: none;
	border: 1px solid transparent;
	border-radius: 4px;
	color: var(--text-secondary);
	cursor: pointer;
	padding: 3px 5px;
	font-size: 11px;
	line-height: 1;
	font-family: inherit;
	display: flex;
	align-items: center;
}

.builtin-tab-btn:hover {
	background: rgba(255,255,255,0.08);
	color: var(--text-primary);
}

.builtin-tab-btn.active {
	border-color: var(--accent-color);
	color: var(--accent-color);
}

/* ============================================================
   Mini panel (builtin tab popover above the toggle button)
   ============================================================ */

#profiler-mini-panel {
	position: fixed;
	bottom: 28px;
	left: 0;
	z-index: 1000;
	background: var(--panel-bg);
	border: 1px solid var(--border-color);
	border-radius: 6px 6px 0 0;
	min-width: 300px;
	max-width: 420px;
	max-height: 80vh;
	display: none;
	overflow: hidden;
	flex-direction: column;
	box-shadow: 0 -4px 16px rgba(0,0,0,0.4);
}

#profiler-mini-panel.visible {
	display: flex;
}

#profiler-mini-panel.position-right {
	bottom: auto;
	top: 32px;
	left: auto;
	right: 0;
	border-radius: 0 0 6px 6px;
	box-shadow: 0 4px 16px rgba(0,0,0,0.4);
}

#profiler-mini-panel.panel-open {
	/* keep visible when main panel is open too */
}

.mini-panel-content {
	flex: 1;
	overflow: auto;
	min-height: 0;
}

/* ============================================================
   Main panel
   ============================================================ */

#profiler-panel {
	position: fixed;
	bottom: 0;
	left: 0;
	width: 100%;
	height: 350px;
	z-index: 1000;
	background: var(--panel-bg);
	border-top: 1px solid var(--border-color);
	display: none;
	flex-direction: column;
	overflow: hidden;
	transition: height 0.15s ease, width 0.15s ease;
}

#profiler-panel.visible {
	display: flex;
}

#profiler-panel.position-right {
	bottom: auto;
	top: 0;
	left: auto;
	right: 0;
	width: 450px;
	height: 100%;
	border-top: none;
	border-left: 1px solid var(--border-color);
}

#profiler-panel.position-bottom {
	bottom: 0;
	top: auto;
	left: 0;
	right: auto;
	width: 100%;
	border-top: 1px solid var(--border-color);
	border-left: none;
}

/* Maximized state */
#profiler-panel.maximized {
	transition: none;
}

/* No tabs — shrink panel to header only */
#profiler-panel.no-tabs .profiler-content-wrapper {
	display: none;
}

/* ============================================================
   Panel resizer handle
   ============================================================ */

.panel-resizer {
	position: absolute;
	background: transparent;
	z-index: 10;
}

#profiler-panel.position-bottom .panel-resizer {
	top: 0;
	left: 0;
	right: 0;
	height: 4px;
	cursor: ns-resize;
}

#profiler-panel.position-right .panel-resizer {
	top: 0;
	left: 0;
	bottom: 0;
	width: 4px;
	cursor: ew-resize;
}

.panel-resizer:hover {
	background: rgba(74, 158, 255, 0.3);
}

/* ============================================================
   Panel header (tab bar + controls)
   ============================================================ */

.profiler-header {
	display: flex;
	align-items: stretch;
	background: var(--header-bg);
	border-bottom: 1px solid var(--border-color);
	flex-shrink: 0;
	overflow: hidden;
	min-height: 34px;
}

.profiler-tabs {
	display: flex;
	align-items: stretch;
	overflow-x: auto;
	overflow-y: hidden;
	flex: 1;
	gap: 0;
	scrollbar-width: none;
}

.profiler-tabs::-webkit-scrollbar {
	display: none;
}

.tab-btn {
	padding: 0 14px;
	background: none;
	border: none;
	border-bottom: 2px solid transparent;
	color: var(--text-secondary);
	cursor: grab;
	font-family: inherit;
	font-size: 12px;
	white-space: nowrap;
	user-select: none;
	flex-shrink: 0;
	display: flex;
	align-items: center;
	transition: color 0.1s;
	min-height: 34px;
}

.tab-btn:hover {
	color: var(--text-primary);
	background: rgba(255,255,255,0.04);
}

.tab-btn.active {
	color: var(--accent-color);
	border-bottom-color: var(--accent-color);
}

.tab-btn.no-detach {
	cursor: default;
}

.profiler-controls {
	display: flex;
	align-items: center;
	gap: 2px;
	padding: 0 6px;
	flex-shrink: 0;
}

.profiler-controls button {
	background: none;
	border: 1px solid transparent;
	border-radius: 4px;
	color: var(--text-secondary);
	cursor: pointer;
	padding: 3px 6px;
	font-size: 12px;
	line-height: 1;
	font-family: inherit;
	display: flex;
	align-items: center;
	min-height: 24px;
}

.profiler-controls button:hover {
	background: rgba(255,255,255,0.08);
	color: var(--text-primary);
	border-color: var(--border-color);
}

#floating-btn.active {
	color: var(--accent-color);
}

/* ============================================================
   Content wrapper + tab content panes
   ============================================================ */

.profiler-content-wrapper {
	flex: 1;
	position: relative;
	display: flex;
	flex-direction: column;
	min-height: 0;
}

.profiler-content {
	display: none;
	flex-direction: column;
	width: 100%;
	height: 100%;
	position: absolute;
	top: 0; left: 0; right: 0; bottom: 0;
}

.profiler-content.active {
	display: flex;
}

/* ============================================================
   Detached tab windows
   ============================================================ */

.detached-tab-panel {
	position: fixed;
	width: 400px;
	height: 300px;
	background: var(--panel-bg);
	border: 1px solid var(--border-color);
	border-radius: 6px;
	box-shadow: 0 8px 32px rgba(0,0,0,0.5);
	display: flex;
	flex-direction: column;
	overflow: hidden;
	z-index: 1002;
}

.detached-tab-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 6px 8px;
	background: var(--header-bg);
	border-bottom: 1px solid var(--border-color);
	cursor: grab;
	flex-shrink: 0;
	user-select: none;
	font-size: 12px;
	color: var(--text-primary);
	min-height: 30px;
}

.detached-tab-header:active {
	cursor: grabbing;
}

.detached-header-controls {
	display: flex;
	align-items: center;
	gap: 4px;
}

.detached-reattach-btn {
	background: none;
	border: 1px solid var(--border-color);
	border-radius: 4px;
	color: var(--text-secondary);
	cursor: pointer;
	padding: 2px 6px;
	font-size: 13px;
	line-height: 1;
}

.detached-reattach-btn:hover {
	background: rgba(255,255,255,0.08);
	color: var(--text-primary);
}

.detached-tab-content {
	flex: 1;
	overflow: hidden;
	display: flex;
	flex-direction: column;
	min-height: 0;
	position: relative;
}

.detached-tab-content .profiler-content {
	position: relative;
	top: auto; left: auto; right: auto; bottom: auto;
	flex: 1;
	min-height: 0;
}

/* Detached resizer handles */
.detached-tab-resizer {
	position: absolute;
	bottom: 0;
	right: 0;
	width: 12px;
	height: 12px;
	cursor: se-resize;
	z-index: 5;
}

.detached-tab-resizer::after {
	content: '';
	position: absolute;
	bottom: 2px;
	right: 2px;
	width: 8px;
	height: 8px;
	border-right: 2px solid var(--border-color);
	border-bottom: 2px solid var(--border-color);
}

.detached-tab-resizer-top    { position:absolute; top:0; left:4px; right:4px; height:4px; cursor:n-resize; z-index:5; }
.detached-tab-resizer-bottom { position:absolute; bottom:0; left:4px; right:4px; height:4px; cursor:s-resize; z-index:5; }
.detached-tab-resizer-left   { position:absolute; left:0; top:4px; bottom:4px; width:4px; cursor:w-resize; z-index:5; }
.detached-tab-resizer-right  { position:absolute; right:0; top:4px; bottom:4px; width:4px; cursor:e-resize; z-index:5; }

.detached-tab-resizer-top:hover,
.detached-tab-resizer-bottom:hover,
.detached-tab-resizer-left:hover,
.detached-tab-resizer-right:hover {
	background: rgba(74, 158, 255, 0.25);
}

/* ============================================================
   List component  (.list-container, .list-header, .list-header-cell)
   ============================================================ */

.list-container {
	width: 100%;
	min-width: 0;
}

.list-header {
	display: grid;
	padding: 5px 8px;
	font-size: 10px;
	color: var(--text-muted);
	text-transform: uppercase;
	letter-spacing: 0.05em;
	border-bottom: 1px solid var(--border-color);
	background: var(--header-bg);
	position: sticky;
	top: 0;
	z-index: 1;
}

.list-header-cell {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

/* ============================================================
   Item component
   ============================================================ */

.list-item-wrapper {
	width: 100%;
}

.list-item-row {
	display: grid;
	padding: 3px 8px;
	cursor: default;
	align-items: center;
	min-height: 26px;
}

.list-item-row:hover {
	background: rgba(255,255,255,0.04);
}

.list-item-row.collapsible {
	cursor: pointer;
}

.list-item-row.actionable {
	cursor: pointer;
}

.list-item-row.no-hover:hover {
	background: none;
}

.list-item-cell {
	display: flex;
	align-items: center;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	gap: 4px;
	color: var(--text-primary);
	font-size: 12px;
}

.list-item-cell:not(:first-child) {
	color: var(--text-secondary);
	justify-content: flex-end;
}

/* Section separator (first item in list / group header) */
.list-item-wrapper.header-wrapper > .list-item-row {
	background: var(--header-bg);
	color: var(--text-secondary);
	font-size: 11px;
	border-top: 1px solid var(--border-color);
}

.list-item-wrapper.section-start > .list-item-row {
	border-top: 1px solid var(--border-color);
}

/* Collapse toggler arrow */
.item-toggler {
	display: inline-block;
	width: 14px;
	flex-shrink: 0;
	font-size: 9px;
	color: var(--text-muted);
	text-align: center;
}

.item-toggler::before {
	content: '▶';
}

.list-item-row.open .item-toggler::before {
	content: '▼';
}

/* Children container */
.list-children-container {
	overflow: hidden;
}

.list-children-container.closed {
	display: none;
}

/* Children indented slightly */
.list-children-container .list-item-row {
	padding-left: 24px;
}

.list-children-container .list-children-container .list-item-row {
	padding-left: 40px;
}

.list-children-container .list-children-container .list-children-container .list-item-row {
	padding-left: 56px;
}

/* ============================================================
   Scrollable wrapper inside tab content
   ============================================================ */

.list-scroll-wrapper {
	flex: 1;
	overflow: auto;
	min-height: 0;
	min-width: 0;
}

/* ============================================================
   Graph (SVG rolling chart)
   ============================================================ */

.graph-container {
	width: 100%;
	height: 60px;
	min-height: 60px;
	flex-shrink: 0;
	background: var(--background-color);
	border-bottom: 1px solid var(--border-color);
	display: block;
	position: relative;
}

.graph-svg {
	display: block;
	width: 100%;
	height: 100%;
	position: absolute;
	top: 0;
	left: 0;
}

.graph-path {
	fill-opacity: 0.2;
	stroke-width: 1.5;
}

/* ============================================================
   Value widgets (param-control, custom-checkbox, etc.)
   ============================================================ */

.param-control {
	display: flex;
	align-items: center;
	gap: 4px;
	width: 100%;
}

.param-control input[type="number"] {
	background: #111;
	border: 1px solid var(--border-color);
	border-radius: 3px;
	color: var(--text-primary);
	font-family: inherit;
	font-size: 11px;
	padding: 2px 4px;
	width: 80px;
	outline: none;
	text-align: right;
}

.param-control input[type="number"]:focus {
	border-color: var(--accent-color);
}

.param-control input[type="range"] {
	flex: 1;
	accent-color: var(--accent-color);
	cursor: pointer;
	min-width: 0;
}

.param-control select {
	background: #111;
	border: 1px solid var(--border-color);
	border-radius: 3px;
	color: var(--text-primary);
	font-family: inherit;
	font-size: 11px;
	padding: 2px 4px;
	cursor: pointer;
	outline: none;
	flex: 1;
}

.param-control input[type="color"] {
	width: 30px;
	height: 22px;
	border: 1px solid var(--border-color);
	border-radius: 3px;
	cursor: pointer;
	padding: 1px;
	background: none;
}

.param-control button {
	background: rgba(255,255,255,0.07);
	border: 1px solid var(--border-color);
	border-radius: 3px;
	color: var(--text-primary);
	cursor: pointer;
	font-family: inherit;
	font-size: 11px;
	padding: 3px 10px;
	width: 100%;
}

.param-control button:hover {
	background: var(--accent-dim);
	border-color: var(--accent-color);
}

/* Custom checkbox */
.custom-checkbox {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	cursor: pointer;
	user-select: none;
	font-size: 11px;
}

.custom-checkbox input[type="checkbox"] {
	display: none;
}

.checkmark {
	display: inline-block;
	width: 14px;
	height: 14px;
	border: 1px solid var(--border-color);
	border-radius: 3px;
	background: #111;
	flex-shrink: 0;
	position: relative;
}

.custom-checkbox input[type="checkbox"]:checked + .checkmark {
	background: var(--accent-color);
	border-color: var(--accent-color);
}

.custom-checkbox input[type="checkbox"]:checked + .checkmark::after {
	content: '';
	position: absolute;
	left: 4px;
	top: 1px;
	width: 4px;
	height: 8px;
	border: 2px solid #fff;
	border-top: none;
	border-left: none;
	transform: rotate(45deg);
}

/* .value span (stat value text) */
.value {
	font-variant-numeric: tabular-nums;
	color: var(--text-secondary);
}

/* ============================================================
   Console tab
   ============================================================ */

.console-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 5px 8px;
	background: var(--header-bg);
	border-bottom: 1px solid var(--border-color);
	flex-shrink: 0;
	gap: 6px;
}

.console-filter-input {
	flex: 1;
	background: #111;
	border: 1px solid var(--border-color);
	border-radius: 3px;
	color: var(--text-primary);
	font-family: inherit;
	font-size: 11px;
	padding: 3px 6px;
	outline: none;
}

.console-filter-input:focus {
	border-color: var(--accent-color);
}

.console-buttons-group {
	display: flex;
	align-items: center;
	gap: 4px;
}

.console-copy-button {
	background: rgba(255,255,255,0.06);
	border: 1px solid var(--border-color);
	border-radius: 4px;
	color: var(--text-secondary);
	cursor: pointer;
	padding: 3px 6px;
	font-size: 11px;
	font-family: inherit;
	display: flex;
	align-items: center;
	gap: 4px;
}

.console-copy-button:hover {
	background: rgba(255,255,255,0.1);
	color: var(--text-primary);
}

.console-copy-button.copied {
	color: var(--color-green);
	border-color: var(--color-green);
}

#console-log {
	flex: 1;
	overflow-y: auto;
	padding: 4px 0;
}

.log-message {
	padding: 4px 10px;
	border-bottom: 1px solid rgba(255,255,255,0.04);
	word-break: break-all;
	line-height: 1.5;
	font-size: 11px;
	color: var(--text-primary);
}

.log-message.warn {
	color: var(--color-yellow);
	background: rgba(255,193,7,0.05);
}

.log-message.error {
	color: var(--color-red);
	background: rgba(244,67,54,0.05);
}

.log-message.hidden {
	display: none;
}

.log-prefix {
	font-weight: bold;
	opacity: 0.8;
}

.log-code {
	font-family: inherit;
	background: rgba(255,255,255,0.08);
	border-radius: 2px;
	padding: 0 3px;
	font-size: 11px;
}

/* ============================================================
   Parameters tab — .parameters class on list-container
   ============================================================ */

.parameters .list-item-row {
	grid-template-columns: .5fr 1fr;
}

/* ============================================================
   Scrollbars (inside panels)
   ============================================================ */

#profiler-panel ::-webkit-scrollbar,
.detached-tab-panel ::-webkit-scrollbar,
#profiler-mini-panel ::-webkit-scrollbar {
	width: 6px;
	height: 6px;
}

#profiler-panel ::-webkit-scrollbar-track,
.detached-tab-panel ::-webkit-scrollbar-track,
#profiler-mini-panel ::-webkit-scrollbar-track {
	background: transparent;
}

#profiler-panel ::-webkit-scrollbar-thumb,
.detached-tab-panel ::-webkit-scrollbar-thumb,
#profiler-mini-panel ::-webkit-scrollbar-thumb {
	background: var(--border-color);
	border-radius: 3px;
}

#profiler-panel ::-webkit-scrollbar-thumb:hover,
.detached-tab-panel ::-webkit-scrollbar-thumb:hover {
	background: var(--text-muted);
}

/* ============================================================
   Timeline tab layout
   ============================================================ */

.timeline-body {
	display: flex;
	flex-direction: column;
	flex: 1;
	min-height: 0;
	width: 100%;
}

.timeline-graph-slider {
	height: 100%;
	width: 100%;
	position: relative;
	cursor: crosshair;
	outline: none;
}

.timeline-hover-indicator {
	position: absolute;
	top: 0;
	bottom: 0;
	width: 1px;
	background: rgba(255,255,255,0.3);
	pointer-events: none;
	display: none;
	z-index: 9;
	transform: translateX(-50%);
}

.timeline-playhead {
	position: absolute;
	top: 0;
	bottom: 0;
	width: 2px;
	background: var(--color-red);
	box-shadow: 0 0 4px rgba(255,0,0,0.5);
	pointer-events: none;
	display: none;
	z-index: 10;
	transform: translateX(-50%);
}

.timeline-playhead-handle {
	position: absolute;
	top: 0;
	left: 50%;
	transform: translate(-50%, 0);
	width: 0;
	height: 0;
	border-left: 6px solid transparent;
	border-right: 6px solid transparent;
	border-top: 8px solid var(--color-red);
}

.timeline-main-area {
	flex: 1;
	display: flex;
	flex-direction: column;
	overflow: hidden;
	min-height: 0;
}

.timeline-track {
	flex: 1;
	overflow-y: auto;
	padding: 6px;
	background: var(--background-color);
}

.timeline-empty-hint {
	display: flex;
	align-items: center;
	justify-content: center;
	height: 100%;
	color: var(--text-muted);
	font-size: 12px;
	text-align: center;
	padding: 16px;
}

/* ============================================================
   Scene Hierarchy tab — type badges + selection highlight
   ============================================================ */

.hierarchy-type-badge {
	display: inline-block;
	font-size: 10px;
	font-weight: 600;
	letter-spacing: 0.04em;
	padding: 1px 5px;
	border-radius: 3px;
	white-space: nowrap;
	text-transform: uppercase;
	background: rgba(255,255,255,0.07);
	color: var(--text-muted);
}

.hierarchy-type-badge--mesh {
	background: rgba(74,158,255,0.15);
	color: var(--accent-color);
}

.hierarchy-type-badge--scene {
	background: rgba(76,175,80,0.15);
	color: var(--color-green);
}

.hierarchy-type-badge--object3d {
	background: rgba(255,152,0,0.12);
	color: var(--color-orange);
}

.list-item-row.hierarchy-selected {
	background: rgba(74,158,255,0.12);
}

.list-item-row.hierarchy-selected:hover {
	background: rgba(74,158,255,0.18);
}

/* ============================================================
   Scene hierarchy — row layout
   ============================================================ */

.scene-hierarchy-layout {
	display: flex;
	flex-direction: row;
	width: 100%;
	height: 100%;
	min-height: 0;
	overflow: hidden;
}

.scene-hierarchy-list {
	flex-shrink: 0;
	width: 220px;
	min-width: 160px;
	border-right: 1px solid var(--border-color);
	overflow-y: auto;
	overflow-x: hidden;
}

/* ============================================================
   Shader panel — right-side WGSL viewer
   ============================================================ */

.shader-container {
	flex: 1;
	display: flex;
	flex-direction: column;
	border-left: none;
	min-width: 0;
	overflow: hidden;
}

.mesh-detail-panel {
	overflow-y: auto;
}

.shader-panel {
	display: flex;
	flex-direction: column;
	height: 100%;
	min-height: 0;
	background: var(--background-color);
}

.shader-toolbar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 4px 8px;
	background: var(--header-bg);
	border-bottom: 1px solid var(--border-color);
	flex-shrink: 0;
	gap: 6px;
}

.shader-stage-group {
	display: flex;
	align-items: center;
	gap: 2px;
}

.shader-stage-btn {
	background: none;
	border: 1px solid transparent;
	border-radius: 4px;
	color: var(--text-secondary);
	cursor: pointer;
	font-family: inherit;
	font-size: 11px;
	padding: 3px 8px;
	line-height: 1;
	transition: color 0.1s;
}

.shader-stage-btn:hover {
	background: rgba(255,255,255,0.06);
	color: var(--text-primary);
}

.shader-stage-btn.active {
	border-color: var(--accent-color);
	color: var(--accent-color);
}

.shader-copy-btn {
	margin-left: auto;
}

.shader-code-scroll {
	flex: 1;
	overflow: auto;
	min-height: 0;
	min-width: 0;
}

pre.shader-code {
	margin: 0;
	padding: 8px 12px;
	font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
	font-size: 11px;
	line-height: 1.55;
	white-space: pre;
	color: var(--text-primary);
	background: var(--background-color);
	tab-size: 4;
	/* NOT overflow:auto here — scroll is on the wrapper so Chrome doesn't
	   intercept click-drag as a scroll gesture, blocking text selection */
	overflow: visible;
	user-select: text;
	-webkit-user-select: text;
	cursor: text;
}

/* WGSL syntax highlight spans */
.wgsl-keyword  { color: #c792ea; }
.wgsl-type     { color: #82aaff; }
.wgsl-builtin  { color: #89ddff; }
.wgsl-comment  { color: #546e7a; font-style: italic; }
.wgsl-number   { color: #f78c6c; }
.wgsl-attribute { color: #c3e88d; }

/* ============================================================
   Shader probe — hoverable lines + floating popover
   ============================================================ */

.shader-line {
    display: block;
    white-space: pre;
    user-select: text;
    -webkit-user-select: text;
    cursor: text;
}

.shader-line:hover {
    background: rgba(255,255,255,0.05);
}

.probe-popover {
    position: fixed;
    z-index: 99999;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    background: var(--panel-bg, #1e1e1e);
    border: 1px solid var(--border-color, #383838);
    border-radius: 6px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    pointer-events: none;
    min-width: 160px;
    max-width: 180px;
}

.probe-popover-label {
    font-size: 10px;
    color: var(--text-muted, #666);
    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.probe-popover-canvas canvas {
    border-radius: 4px;
    display: block;
}

/* ============================================================
   Draw Calls tab — detail panel, kv tables, nav link
   ============================================================ */

.dc-detail-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
}

.dc-detail-toolbar {
    display: flex;
    align-items: center;
    padding: 4px 8px;
    background: var(--header-bg);
    border-bottom: 1px solid var(--border-color);
    flex-shrink: 0;
    gap: 6px;
}

/* Sub-tab panes: hidden by default, flex-column when active */
.dc-detail-pane {
    display: none;
    flex: 1;
    flex-direction: column;
    overflow: auto;
    min-height: 0;
}

.dc-detail-pane.active {
    display: flex;
}

/* The ShaderPanel inside the Shader pane needs to fill height */
.dc-detail-pane .shader-panel {
    flex: 1;
    min-height: 0;
}

.dc-kv-table {
    width: 100%;
    padding: 8px;
    flex-shrink: 0;
}

.dc-kv-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    padding: 3px 0;
    border-bottom: 1px solid var(--border-color);
}

.dc-kv-key {
    color: var(--text-muted);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.dc-kv-val {
    color: var(--text-primary);
    font-size: 11px;
    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.dc-section-header {
    padding: 6px 8px;
    font-size: 10px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: .05em;
    background: var(--header-bg);
    border-bottom: 1px solid var(--border-color);
    flex-shrink: 0;
}

.dc-nav-link {
    font-size: 10px;
    color: var(--accent-color);
    cursor: pointer;
    padding: 2px 6px;
    border: 1px solid var(--accent-dim);
    border-radius: 3px;
    background: none;
    font-family: inherit;
    flex-shrink: 0;
    margin-left: 6px;
    line-height: 1;
}

.dc-nav-link:hover {
    background: var(--accent-dim);
}

/* ============================================================
   GUI controller system (.gui-*, .gui-controller, etc.)
   ============================================================ */

.gui-parameters-container {
	padding: 4px 0;
}

.gui {
	font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
	font-size: 12px;
	color: var(--text-primary);
	user-select: none;
	-webkit-user-select: none;
}

.gui-root {
	/* Root GUI when used standalone — no extra styles needed in inspector context */
}

.gui-title {
	display: flex;
	align-items: center;
	width: 100%;
	padding: 5px 8px;
	background: var(--header-bg);
	border: none;
	border-top: 1px solid var(--border-color);
	border-bottom: 1px solid var(--border-color);
	color: var(--text-secondary);
	cursor: pointer;
	font-family: inherit;
	font-size: 11px;
	font-weight: normal;
	text-align: left;
	text-transform: uppercase;
	letter-spacing: 0.05em;
	line-height: 1;
	min-height: 26px;
}

.gui-title:hover {
	color: var(--text-primary);
	background: #2a2a2a;
}

/* Arrow indicator using aria-expanded */
.gui-title::before {
	content: '▶';
	display: inline-block;
	font-size: 9px;
	margin-right: 6px;
	color: var(--text-muted);
	transition: transform 0.15s ease;
}

.gui-title[aria-expanded="true"]::before {
	transform: rotate(90deg);
}

.gui-children {
	overflow: hidden;
}

/* Animated open/close */
.gui-transition .gui-children {
	transition: height 0.15s ease;
}

.gui-closed .gui-children {
	display: none;
}

.gui-transition.gui-closed .gui-children {
	display: block; /* keep block during animation so height transition works */
}

/* ── Controller rows ────────────────────────────────────── */

.gui-controller {
	display: grid;
	grid-template-columns: 0.5fr 1fr;
	align-items: center;
	padding: 3px 8px;
	min-height: 26px;
	border-bottom: 1px solid rgba(56, 56, 56, 0.4);
}

.gui-controller:hover {
	background: rgba(255, 255, 255, 0.04);
}

.gui-controller.gui-disabled {
	opacity: 0.45;
	pointer-events: none;
}

/* BooleanController uses <label> as root — full row is clickable */
label.gui-controller {
	cursor: pointer;
}

.gui-name {
	color: var(--text-primary);
	font-size: 12px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	padding-right: 6px;
}

.gui-widget {
	display: flex;
	align-items: center;
	min-width: 0;
}

/* ── Number ─────────────────────────────────────────────── */

/* $input is type="text" (type="number" only on coarse pointer devices) */
.gui-number .gui-widget input {
	background: #111;
	border: 1px solid var(--border-color);
	border-radius: 3px;
	color: var(--text-primary);
	font-family: inherit;
	font-size: 11px;
	padding: 2px 4px;
	width: 100%;
	outline: none;
	text-align: right;
}

.gui-number .gui-widget input:focus {
	border-color: var(--accent-color);
}

/* Slider layout: fill bar + number input side by side */
.gui-has-slider .gui-widget {
	gap: 6px;
}

.gui-slider {
	position: relative;
	flex: 1;
	height: 22px;
	background: #111;
	border: 1px solid var(--border-color);
	border-radius: 3px;
	cursor: ew-resize;
	overflow: hidden;
}

.gui-fill {
	position: absolute;
	top: 0;
	left: 0;
	height: 100%;
	background: var(--accent-dim);
	pointer-events: none;
}

.gui-slider:hover .gui-fill {
	background: rgba(74, 158, 255, 0.35);
}

/* .gui-active is toggled on $slider during drag (not .gui-dragging) */
.gui-slider.gui-active {
	border-color: var(--accent-color);
}

.gui-has-slider .gui-widget input {
	flex-shrink: 0;
	width: 54px;
}

/* ── Boolean ────────────────────────────────────────────── */

.gui-boolean input[type="checkbox"] {
	display: none;
}

.gui-boolean .gui-checkmark {
	display: inline-block;
	width: 14px;
	height: 14px;
	border: 1px solid var(--border-color);
	border-radius: 3px;
	background: #111;
	flex-shrink: 0;
	position: relative;
}

.gui-boolean input[type="checkbox"]:checked + .gui-checkmark {
	background: var(--accent-color);
	border-color: var(--accent-color);
}

.gui-boolean input[type="checkbox"]:checked + .gui-checkmark::after {
	content: '';
	position: absolute;
	left: 4px;
	top: 1px;
	width: 4px;
	height: 8px;
	border: 2px solid #fff;
	border-top: none;
	border-left: none;
	transform: rotate(45deg);
}

/* ── String ─────────────────────────────────────────────── */

.gui-string input[type="text"] {
	background: #111;
	border: 1px solid var(--border-color);
	border-radius: 3px;
	color: var(--text-primary);
	font-family: inherit;
	font-size: 11px;
	padding: 2px 4px;
	width: 100%;
	outline: none;
}

.gui-string input[type="text"]:focus {
	border-color: var(--accent-color);
}

/* ── Color ──────────────────────────────────────────────── */

.gui-color .gui-widget {
	gap: 5px;
}

.gui-color-display {
	width: 22px;
	height: 18px;
	border: 1px solid var(--border-color);
	border-radius: 3px;
	cursor: pointer;
	flex-shrink: 0;
	position: relative;
	overflow: hidden;
}

.gui-color-display input[type="color"] {
	position: absolute;
	top: -4px;
	left: -4px;
	width: calc(100% + 8px);
	height: calc(100% + 8px);
	border: none;
	padding: 0;
	cursor: pointer;
	opacity: 0;
}

.gui-color input[type="text"] {
	background: #111;
	border: 1px solid var(--border-color);
	border-radius: 3px;
	color: var(--text-primary);
	font-family: inherit;
	font-size: 11px;
	padding: 2px 4px;
	flex: 1;
	min-width: 0;
	outline: none;
}

.gui-color input[type="text"]:focus {
	border-color: var(--accent-color);
}

/* ── Option / Select ────────────────────────────────────── */

.gui-option select {
	background: #111;
	border: 1px solid var(--border-color);
	border-radius: 3px;
	color: var(--text-primary);
	font-family: inherit;
	font-size: 11px;
	padding: 2px 4px;
	cursor: pointer;
	outline: none;
	width: 100%;
}

/* ── Function / Button ──────────────────────────────────── */

.gui-function {
	grid-template-columns: 1fr;
}

.gui-function button {
	background: rgba(255, 255, 255, 0.07);
	border: 1px solid var(--border-color);
	border-radius: 3px;
	color: var(--text-primary);
	cursor: pointer;
	font-family: inherit;
	font-size: 11px;
	padding: 4px 10px;
	width: 100%;
	text-align: left;
}

.gui-function button:hover {
	background: var(--accent-dim);
	border-color: var(--accent-color);
}

/* Nested GUI folder inside another GUI */
.gui-children .gui {
	border-top: 1px solid var(--border-color);
}

.gui-children .gui .gui-title {
	padding-left: 16px;
	font-size: 10px;
}
`;

class Profiler {
    domElement;
    toggleButton;
    builtinTabsContainer;
    miniPanel;
    panel;
    tabsContainer;
    contentWrapper;
    floatingBtn;
    maximizeBtn;
    tabs = {};
    activeTabId = null;
    isResizing = false;
    lastHeightBottom = 350;
    lastWidthRight = 450;
    position = 'bottom';
    detachedWindows = [];
    isMobile;
    maxZIndex = 1002;
    nextTabOriginalIndex = 0;
    isLoadingLayout = false;
    pendingDetachedTabs = null;
    constructor() {
        this.isMobile = this.detectMobile();
        injectStyle();
        this.setupShell();
        this.setupResizing();
        if (this.isMobile) {
            this.setupOrientationListener();
        }
        this.setupWindowResizeListener();
    }
    detectMobile() {
        const userAgent = navigator.userAgent || navigator.vendor || window.opera;
        const isMobileUA = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(userAgent);
        const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
        const isSmallScreen = window.innerWidth <= 768;
        return isMobileUA || (isTouchDevice && isSmallScreen);
    }
    setupOrientationListener() {
        const handleOrientationChange = () => {
            const isLandscape = window.innerWidth > window.innerHeight;
            const targetPosition = isLandscape ? 'right' : 'bottom';
            if (this.position !== targetPosition) {
                this.setPosition(targetPosition);
            }
        };
        handleOrientationChange();
        window.addEventListener('orientationchange', handleOrientationChange);
        window.addEventListener('resize', handleOrientationChange);
    }
    setupWindowResizeListener() {
        const constrainDetachedWindows = () => {
            this.detachedWindows.forEach(dw => this.constrainWindowToBounds(dw.panel));
        };
        const constrainMainPanel = () => {
            if (this.panel.classList.contains('maximized'))
                return;
            const windowWidth = window.innerWidth;
            const windowHeight = window.innerHeight;
            if (this.position === 'bottom') {
                const currentHeight = this.panel.offsetHeight;
                const maxHeight = windowHeight - 50;
                if (currentHeight > maxHeight) {
                    this.panel.style.height = `${maxHeight}px`;
                    this.lastHeightBottom = maxHeight;
                }
            }
            else if (this.position === 'right') {
                const currentWidth = this.panel.offsetWidth;
                const maxWidth = windowWidth - 50;
                if (currentWidth > maxWidth) {
                    this.panel.style.width = `${maxWidth}px`;
                    this.lastWidthRight = maxWidth;
                }
            }
        };
        window.addEventListener('resize', () => {
            constrainDetachedWindows();
            constrainMainPanel();
        });
    }
    constrainWindowToBounds(windowPanel) {
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;
        const panelWidth = windowPanel.offsetWidth;
        const panelHeight = windowPanel.offsetHeight;
        let left = parseFloat(windowPanel.style.left) || windowPanel.offsetLeft || 0;
        let top = parseFloat(windowPanel.style.top) || windowPanel.offsetTop || 0;
        const halfWidth = panelWidth / 2;
        const halfHeight = panelHeight / 2;
        if (left + panelWidth > windowWidth + halfWidth)
            left = windowWidth + halfWidth - panelWidth;
        if (left < -halfWidth)
            left = -halfWidth;
        if (top + panelHeight > windowHeight + halfHeight)
            top = windowHeight + halfHeight - panelHeight;
        if (top < -halfHeight)
            top = -halfHeight;
        windowPanel.style.left = `${left}px`;
        windowPanel.style.top = `${top}px`;
    }
    setupShell() {
        this.domElement = document.createElement('div');
        this.domElement.id = 'profiler-shell';
        this.toggleButton = document.createElement('button');
        this.toggleButton.id = 'profiler-toggle';
        this.toggleButton.innerHTML = `
<span id="builtin-tabs-container"></span>
<span id="toggle-text">
	<span id="fps-counter">-</span>
	<span class="fps-label">FPS</span>
</span>
<span id="toggle-icon">
	<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M11.5 20h-6.5a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v5.5" /><path d="M9 17h2" /><path d="M18 18m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" /><path d="M20.2 20.2l1.8 1.8" /></svg>
</span>
`;
        this.toggleButton.onclick = () => this.togglePanel();
        this.builtinTabsContainer = this.toggleButton.querySelector('#builtin-tabs-container');
        this.miniPanel = document.createElement('div');
        this.miniPanel.id = 'profiler-mini-panel';
        this.miniPanel.className = 'profiler-mini-panel';
        this.panel = document.createElement('div');
        this.panel.id = 'profiler-panel';
        const header = document.createElement('div');
        header.className = 'profiler-header';
        this.tabsContainer = document.createElement('div');
        this.tabsContainer.className = 'profiler-tabs';
        const controls = document.createElement('div');
        controls.className = 'profiler-controls';
        this.floatingBtn = document.createElement('button');
        this.floatingBtn.id = 'floating-btn';
        this.floatingBtn.title = 'Switch to Right Side';
        this.floatingBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="15" y1="3" x2="15" y2="21"></line></svg>';
        this.floatingBtn.onclick = () => this.togglePosition();
        if (this.isMobile) {
            this.floatingBtn.style.display = 'none';
            this.panel.classList.add('hide-position-toggle');
        }
        this.maximizeBtn = document.createElement('button');
        this.maximizeBtn.id = 'maximize-btn';
        this.maximizeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
        this.maximizeBtn.onclick = () => this.toggleMaximize();
        const hideBtn = document.createElement('button');
        hideBtn.id = 'hide-panel-btn';
        hideBtn.textContent = '-';
        hideBtn.onclick = () => this.togglePanel();
        controls.append(this.floatingBtn, this.maximizeBtn, hideBtn);
        header.append(this.tabsContainer, controls);
        this.contentWrapper = document.createElement('div');
        this.contentWrapper.className = 'profiler-content-wrapper';
        const resizer = document.createElement('div');
        resizer.className = 'panel-resizer';
        this.panel.append(resizer, header, this.contentWrapper);
        this.domElement.append(this.toggleButton, this.miniPanel, this.panel);
        this.panel.classList.add(`position-${this.position}`);
        // Toggle pill and mini-panel are always anchored top-right,
        // independent of which direction the panel opens.
        this.toggleButton.classList.add('position-right');
        this.miniPanel.classList.add('position-right');
    }
    setupResizing() {
        const resizer = this.panel.querySelector('.panel-resizer');
        const onStart = (e) => {
            this.isResizing = true;
            this.panel.classList.add('resizing');
            resizer.setPointerCapture(e.pointerId);
            const startX = e.clientX;
            const startY = e.clientY;
            const startHeight = this.panel.offsetHeight;
            const startWidth = this.panel.offsetWidth;
            const onMove = (moveEvent) => {
                if (!this.isResizing)
                    return;
                moveEvent.preventDefault();
                if (this.position === 'bottom') {
                    const newHeight = startHeight - (moveEvent.clientY - startY);
                    if (newHeight > 100 && newHeight < window.innerHeight - 50) {
                        this.panel.style.height = `${newHeight}px`;
                    }
                }
                else if (this.position === 'right') {
                    const newWidth = startWidth - (moveEvent.clientX - startX);
                    if (newWidth > 200 && newWidth < window.innerWidth - 50) {
                        this.panel.style.width = `${newWidth}px`;
                    }
                }
            };
            const onEnd = () => {
                this.isResizing = false;
                this.panel.classList.remove('resizing');
                resizer.removeEventListener('pointermove', onMove);
                resizer.removeEventListener('pointerup', onEnd);
                resizer.removeEventListener('pointercancel', onEnd);
                if (!this.panel.classList.contains('maximized')) {
                    if (this.position === 'bottom')
                        this.lastHeightBottom = this.panel.offsetHeight;
                    else if (this.position === 'right')
                        this.lastWidthRight = this.panel.offsetWidth;
                    this.saveLayout();
                }
            };
            resizer.addEventListener('pointermove', onMove);
            resizer.addEventListener('pointerup', onEnd);
            resizer.addEventListener('pointercancel', onEnd);
        };
        resizer.addEventListener('pointerdown', onStart);
    }
    toggleMaximize() {
        if (this.panel.classList.contains('maximized')) {
            this.panel.classList.remove('maximized');
            if (this.position === 'bottom') {
                this.panel.style.height = `${this.lastHeightBottom}px`;
                this.panel.style.width = '100%';
            }
            else if (this.position === 'right') {
                this.panel.style.height = '100%';
                this.panel.style.width = `${this.lastWidthRight}px`;
            }
            this.maximizeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
        }
        else {
            if (this.position === 'bottom')
                this.lastHeightBottom = this.panel.offsetHeight;
            else if (this.position === 'right')
                this.lastWidthRight = this.panel.offsetWidth;
            this.panel.classList.add('maximized');
            if (this.position === 'bottom') {
                this.panel.style.height = '100vh';
                this.panel.style.width = '100%';
            }
            else if (this.position === 'right') {
                this.panel.style.height = '100%';
                this.panel.style.width = '100vw';
            }
            this.maximizeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>';
        }
    }
    addTab(tab) {
        this.tabs[tab.id] = tab;
        tab.originalIndex = this.nextTabOriginalIndex++;
        if (tab.allowDetach === false) {
            tab.button.classList.add('no-detach');
        }
        tab.onVisibilityChange = () => this.updatePanelSize();
        this.setupTabDragAndDrop(tab);
        if (!tab.builtin) {
            this.tabsContainer.appendChild(tab.button);
        }
        this.contentWrapper.appendChild(tab.content);
        if (!tab.isVisible) {
            tab.button.style.display = 'none';
            tab.content.style.display = 'none';
        }
        if (tab.builtin) {
            this.addBuiltinTab(tab);
        }
        this.updatePanelSize();
    }
    addBuiltinTab(tab) {
        const builtinButton = document.createElement('button');
        builtinButton.className = 'builtin-tab-btn';
        if (tab.icon) {
            builtinButton.innerHTML = tab.icon;
        }
        else {
            builtinButton.textContent = tab.button.textContent.charAt(0).toUpperCase();
        }
        builtinButton.title = tab.button.textContent;
        const miniContent = document.createElement('div');
        miniContent.className = 'mini-panel-content';
        miniContent.style.display = 'none';
        tab.builtinButton = builtinButton;
        tab.miniContent = miniContent;
        this.miniPanel.appendChild(miniContent);
        builtinButton.onclick = (e) => {
            e.stopPropagation();
            const isCurrentlyActive = miniContent.style.display !== 'none' && miniContent.children.length > 0;
            this.miniPanel.querySelectorAll('.mini-panel-content').forEach(content => {
                content.style.display = 'none';
            });
            this.builtinTabsContainer.querySelectorAll('.builtin-tab-btn').forEach(btn => {
                btn.classList.remove('active');
            });
            if (isCurrentlyActive) {
                this.miniPanel.classList.remove('visible');
                miniContent.style.display = 'none';
            }
            else {
                builtinButton.classList.add('active');
                if (!miniContent.firstChild) {
                    const actualContent = tab.content.querySelector('.list-scroll-wrapper') || tab.content.firstElementChild;
                    if (actualContent) {
                        miniContent.appendChild(actualContent);
                    }
                }
                miniContent.style.display = 'block';
                this.miniPanel.classList.add('visible');
            }
        };
        this.builtinTabsContainer.appendChild(builtinButton);
        tab.builtinButton = builtinButton;
        tab.miniContent = miniContent;
        tab.profiler = this;
        if (!tab.isVisible) {
            builtinButton.style.display = 'none';
            miniContent.style.display = 'none';
            const hasVisibleBuiltinButtons = Array.from(this.builtinTabsContainer.querySelectorAll('.builtin-tab-btn'))
                .some(btn => btn.style.display !== 'none');
            if (!hasVisibleBuiltinButtons) {
                this.builtinTabsContainer.style.display = 'none';
            }
        }
    }
    updatePanelSize() {
        const hasVisibleTabs = Object.values(this.tabs).some(tab => !tab.isDetached && tab.isVisible);
        if (!hasVisibleTabs) {
            this.panel.classList.add('no-tabs');
            if (this.panel.classList.contains('maximized')) {
                this.panel.classList.remove('maximized');
                this.maximizeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
            }
            if (this.position === 'bottom')
                this.panel.style.height = '38px';
            else if (this.position === 'right')
                this.panel.style.width = '45px';
        }
        else {
            this.panel.classList.remove('no-tabs');
            if (Object.keys(this.tabs).length > 0) {
                if (this.position === 'bottom') {
                    const currentHeight = parseInt(this.panel.style.height);
                    if (currentHeight === 38)
                        this.panel.style.height = `${this.lastHeightBottom}px`;
                }
                else if (this.position === 'right') {
                    const currentWidth = parseInt(this.panel.style.width);
                    if (currentWidth === 45)
                        this.panel.style.width = `${this.lastWidthRight}px`;
                }
            }
        }
    }
    setupTabDragAndDrop(tab) {
        if (this.isMobile) {
            tab.button.addEventListener('click', () => this.setActiveTab(tab.id));
            return;
        }
        if (tab.allowDetach === false) {
            tab.button.addEventListener('click', () => this.setActiveTab(tab.id));
            tab.button.style.cursor = 'default';
            return;
        }
        let isDragging = false;
        let startX = 0, startY = 0;
        let hasMoved = false;
        let previewWindow = null;
        const dragThreshold = 10;
        const onDragStart = (e) => {
            startX = e.clientX;
            startY = e.clientY;
            isDragging = false;
            hasMoved = false;
            tab.button.setPointerCapture(e.pointerId);
        };
        const onDragMove = (e) => {
            const deltaX = Math.abs(e.clientX - startX);
            const deltaY = Math.abs(e.clientY - startY);
            if (!isDragging && (deltaX > dragThreshold || deltaY > dragThreshold)) {
                isDragging = true;
                tab.button.style.cursor = 'grabbing';
                tab.button.style.opacity = '0.5';
                tab.button.style.transform = 'scale(1.05)';
                previewWindow = this.createPreviewWindow(tab, e.clientX, e.clientY);
                previewWindow.style.opacity = '0.8';
            }
            if (isDragging && previewWindow) {
                hasMoved = true;
                e.preventDefault();
                previewWindow.style.left = `${e.clientX - 200}px`;
                previewWindow.style.top = `${e.clientY - 20}px`;
            }
        };
        const onDragEnd = () => {
            if (isDragging && hasMoved && previewWindow) {
                if (previewWindow.parentNode)
                    previewWindow.parentNode.removeChild(previewWindow);
                const finalX = parseInt(previewWindow.style.left) + 200;
                const finalY = parseInt(previewWindow.style.top) + 20;
                this.detachTab(tab, finalX, finalY);
            }
            else if (!hasMoved) {
                this.setActiveTab(tab.id);
                if (previewWindow?.parentNode)
                    previewWindow.parentNode.removeChild(previewWindow);
            }
            else if (previewWindow?.parentNode) {
                previewWindow.parentNode.removeChild(previewWindow);
            }
            tab.button.style.opacity = '';
            tab.button.style.transform = '';
            tab.button.style.cursor = '';
            isDragging = false;
            hasMoved = false;
            previewWindow = null;
            tab.button.removeEventListener('pointermove', onDragMove);
            tab.button.removeEventListener('pointerup', onDragEnd);
            tab.button.removeEventListener('pointercancel', onDragEnd);
        };
        tab.button.addEventListener('pointerdown', (e) => {
            onDragStart(e);
            tab.button.addEventListener('pointermove', onDragMove);
            tab.button.addEventListener('pointerup', onDragEnd);
            tab.button.addEventListener('pointercancel', onDragEnd);
        });
        tab.button.style.cursor = 'grab';
    }
    createPreviewWindow(tab, x, y) {
        const windowPanel = document.createElement('div');
        windowPanel.className = 'detached-tab-panel';
        windowPanel.style.left = `${x - 200}px`;
        windowPanel.style.top = `${y - 20}px`;
        windowPanel.style.pointerEvents = 'none';
        this.maxZIndex++;
        windowPanel.style.setProperty('z-index', String(this.maxZIndex), 'important');
        const windowHeader = document.createElement('div');
        windowHeader.className = 'detached-tab-header';
        const title = document.createElement('span');
        title.textContent = tab.button.textContent.replace('⇱', '').trim();
        windowHeader.appendChild(title);
        const headerControls = document.createElement('div');
        headerControls.className = 'detached-header-controls';
        const reattachBtn = document.createElement('button');
        reattachBtn.className = 'detached-reattach-btn';
        reattachBtn.innerHTML = '↩';
        headerControls.appendChild(reattachBtn);
        windowHeader.appendChild(headerControls);
        const windowContent = document.createElement('div');
        windowContent.className = 'detached-tab-content';
        const resizer = document.createElement('div');
        resizer.className = 'detached-tab-resizer';
        windowPanel.appendChild(resizer);
        windowPanel.appendChild(windowHeader);
        windowPanel.appendChild(windowContent);
        document.body.appendChild(windowPanel);
        return windowPanel;
    }
    detachTab(tab, x, y) {
        if (tab.isDetached || tab.allowDetach === false)
            return;
        const allButtons = Array.from(this.tabsContainer.children);
        const tabIdsInOrder = allButtons.map(btn => Object.keys(this.tabs).find(id => this.tabs[id].button === btn)).filter((id) => id !== undefined);
        const currentIndex = tabIdsInOrder.indexOf(tab.id);
        let newActiveTab = null;
        if (this.activeTabId === tab.id) {
            tab.setActive(false);
            const remainingTabs = tabIdsInOrder.filter(id => id !== tab.id && !this.tabs[id].isDetached && this.tabs[id].isVisible);
            if (remainingTabs.length > 0) {
                for (let i = currentIndex - 1; i >= 0; i--) {
                    if (remainingTabs.includes(tabIdsInOrder[i])) {
                        newActiveTab = tabIdsInOrder[i];
                        break;
                    }
                }
                if (!newActiveTab) {
                    for (let i = currentIndex + 1; i < tabIdsInOrder.length; i++) {
                        if (remainingTabs.includes(tabIdsInOrder[i])) {
                            newActiveTab = tabIdsInOrder[i];
                            break;
                        }
                    }
                }
                if (!newActiveTab)
                    newActiveTab = remainingTabs[0];
            }
        }
        if (tab.button.parentNode)
            tab.button.parentNode.removeChild(tab.button);
        if (tab.content.parentNode)
            tab.content.parentNode.removeChild(tab.content);
        const detachedWindow = this.createDetachedWindow(tab, x, y);
        this.detachedWindows.push(detachedWindow);
        tab.isDetached = true;
        tab.detachedWindow = detachedWindow;
        if (newActiveTab)
            this.setActiveTab(newActiveTab);
        else if (this.activeTabId === tab.id)
            this.activeTabId = null;
        this.updatePanelSize();
        this.saveLayout();
    }
    createDetachedWindow(tab, x, y) {
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;
        const estimatedWidth = 400;
        const estimatedHeight = 300;
        let constrainedX = x - 200;
        let constrainedY = y - 20;
        if (constrainedX + estimatedWidth > windowWidth)
            constrainedX = windowWidth - estimatedWidth;
        if (constrainedX < 0)
            constrainedX = 0;
        if (constrainedY + estimatedHeight > windowHeight)
            constrainedY = windowHeight - estimatedHeight;
        if (constrainedY < 0)
            constrainedY = 0;
        const windowPanel = document.createElement('div');
        windowPanel.className = 'detached-tab-panel';
        windowPanel.style.left = `${constrainedX}px`;
        windowPanel.style.top = `${constrainedY}px`;
        if (!this.panel.classList.contains('visible')) {
            windowPanel.style.opacity = '0';
            windowPanel.style.visibility = 'hidden';
            windowPanel.style.pointerEvents = 'none';
        }
        if (!tab.isVisible)
            windowPanel.style.display = 'none';
        const windowHeader = document.createElement('div');
        windowHeader.className = 'detached-tab-header';
        const title = document.createElement('span');
        title.textContent = tab.button.textContent.replace('⇱', '').trim();
        windowHeader.appendChild(title);
        const headerControls = document.createElement('div');
        headerControls.className = 'detached-header-controls';
        const reattachBtn = document.createElement('button');
        reattachBtn.className = 'detached-reattach-btn';
        reattachBtn.innerHTML = '↩';
        reattachBtn.title = 'Reattach to main panel';
        reattachBtn.onclick = () => this.reattachTab(tab);
        headerControls.appendChild(reattachBtn);
        windowHeader.appendChild(headerControls);
        const windowContent = document.createElement('div');
        windowContent.className = 'detached-tab-content';
        windowContent.appendChild(tab.content);
        tab.content.style.display = '';
        tab.content.classList.add('active');
        const resizerTop = document.createElement('div');
        resizerTop.className = 'detached-tab-resizer-top';
        const resizerRight = document.createElement('div');
        resizerRight.className = 'detached-tab-resizer-right';
        const resizerBottom = document.createElement('div');
        resizerBottom.className = 'detached-tab-resizer-bottom';
        const resizerLeft = document.createElement('div');
        resizerLeft.className = 'detached-tab-resizer-left';
        const resizerCorner = document.createElement('div');
        resizerCorner.className = 'detached-tab-resizer';
        windowPanel.appendChild(resizerTop);
        windowPanel.appendChild(resizerRight);
        windowPanel.appendChild(resizerBottom);
        windowPanel.appendChild(resizerLeft);
        windowPanel.appendChild(resizerCorner);
        windowPanel.appendChild(windowHeader);
        windowPanel.appendChild(windowContent);
        document.body.appendChild(windowPanel);
        this.setupDetachedWindowDrag(windowPanel, windowHeader, tab);
        this.setupDetachedWindowResize(windowPanel, resizerTop, resizerRight, resizerBottom, resizerLeft, resizerCorner);
        windowPanel.style.setProperty('z-index', String(this.maxZIndex), 'important');
        return { panel: windowPanel, tab };
    }
    bringWindowToFront(windowPanel) {
        this.maxZIndex++;
        windowPanel.style.setProperty('z-index', String(this.maxZIndex), 'important');
    }
    setupDetachedWindowDrag(windowPanel, header, tab) {
        let isDragging = false;
        let startX = 0, startY = 0, startLeft = 0, startTop = 0;
        windowPanel.addEventListener('pointerdown', () => this.bringWindowToFront(windowPanel));
        const onDragStart = (e) => {
            if (e.target.classList.contains('detached-reattach-btn'))
                return;
            this.bringWindowToFront(windowPanel);
            isDragging = true;
            header.style.cursor = 'grabbing';
            header.setPointerCapture(e.pointerId);
            startX = e.clientX;
            startY = e.clientY;
            const rect = windowPanel.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;
        };
        const onDragMove = (e) => {
            if (!isDragging)
                return;
            e.preventDefault();
            const deltaX = e.clientX - startX;
            const deltaY = e.clientY - startY;
            let newLeft = startLeft + deltaX;
            let newTop = startTop + deltaY;
            const ww = window.innerWidth, wh = window.innerHeight;
            const pw = windowPanel.offsetWidth, ph = windowPanel.offsetHeight;
            const hw = pw / 2, hh = ph / 2;
            if (newLeft + pw > ww + hw)
                newLeft = ww + hw - pw;
            if (newLeft < -hw)
                newLeft = -hw;
            if (newTop + ph > wh + hh)
                newTop = wh + hh - ph;
            if (newTop < -hh)
                newTop = -hh;
            windowPanel.style.left = `${newLeft}px`;
            windowPanel.style.top = `${newTop}px`;
            const panelRect = this.panel.getBoundingClientRect();
            const isOverPanel = e.clientX >= panelRect.left && e.clientX <= panelRect.right &&
                e.clientY >= panelRect.top && e.clientY <= panelRect.bottom;
            windowPanel.style.opacity = isOverPanel ? '0.5' : '';
            this.panel.style.outline = isOverPanel ? '2px solid var(--accent-color)' : '';
        };
        const onDragEnd = (e) => {
            if (!isDragging)
                return;
            isDragging = false;
            header.style.cursor = '';
            windowPanel.style.opacity = '';
            this.panel.style.outline = '';
            if (e.clientX !== undefined && e.clientY !== undefined) {
                const panelRect = this.panel.getBoundingClientRect();
                const isOverPanel = e.clientX >= panelRect.left && e.clientX <= panelRect.right &&
                    e.clientY >= panelRect.top && e.clientY <= panelRect.bottom;
                if (isOverPanel && tab)
                    this.reattachTab(tab);
                else
                    this.saveLayout();
            }
            header.removeEventListener('pointermove', onDragMove);
            header.removeEventListener('pointerup', onDragEnd);
            header.removeEventListener('pointercancel', onDragEnd);
        };
        header.addEventListener('pointerdown', (e) => {
            onDragStart(e);
            header.addEventListener('pointermove', onDragMove);
            header.addEventListener('pointerup', onDragEnd);
            header.addEventListener('pointercancel', onDragEnd);
        });
        header.style.cursor = 'grab';
    }
    setupDetachedWindowResize(windowPanel, resizerTop, resizerRight, resizerBottom, resizerLeft, resizerCorner) {
        const minWidth = 250;
        const minHeight = 150;
        const setupResizer = (resizer, direction) => {
            let isResizing = false;
            let startX = 0, startY = 0, startWidth = 0, startHeight = 0, startLeft = 0, startTop = 0;
            const onResizeStart = (e) => {
                e.preventDefault();
                e.stopPropagation();
                isResizing = true;
                this.bringWindowToFront(windowPanel);
                resizer.setPointerCapture(e.pointerId);
                startX = e.clientX;
                startY = e.clientY;
                startWidth = windowPanel.offsetWidth;
                startHeight = windowPanel.offsetHeight;
                startLeft = windowPanel.offsetLeft;
                startTop = windowPanel.offsetTop;
            };
            const onResizeMove = (e) => {
                if (!isResizing)
                    return;
                e.preventDefault();
                const deltaX = e.clientX - startX;
                const deltaY = e.clientY - startY;
                const ww = window.innerWidth, wh = window.innerHeight;
                if (direction === 'right' || direction === 'corner') {
                    const newWidth = startWidth + deltaX;
                    if (newWidth >= minWidth && newWidth <= ww - startLeft)
                        windowPanel.style.width = `${newWidth}px`;
                }
                if (direction === 'bottom' || direction === 'corner') {
                    const newHeight = startHeight + deltaY;
                    if (newHeight >= minHeight && newHeight <= wh - startTop)
                        windowPanel.style.height = `${newHeight}px`;
                }
                if (direction === 'left') {
                    const newWidth = startWidth - deltaX;
                    if (newWidth >= minWidth) {
                        const newLeft = startLeft + deltaX;
                        if (newLeft >= 0 && newLeft <= startLeft + startWidth - minWidth) {
                            windowPanel.style.width = `${newWidth}px`;
                            windowPanel.style.left = `${newLeft}px`;
                        }
                    }
                }
                if (direction === 'top') {
                    const newHeight = startHeight - deltaY;
                    if (newHeight >= minHeight) {
                        const newTop = startTop + deltaY;
                        if (newTop >= 0 && newTop <= startTop + startHeight - minHeight) {
                            windowPanel.style.height = `${newHeight}px`;
                            windowPanel.style.top = `${newTop}px`;
                        }
                    }
                }
            };
            const onResizeEnd = () => {
                isResizing = false;
                resizer.removeEventListener('pointermove', onResizeMove);
                resizer.removeEventListener('pointerup', onResizeEnd);
                resizer.removeEventListener('pointercancel', onResizeEnd);
                this.saveLayout();
            };
            resizer.addEventListener('pointerdown', (e) => {
                onResizeStart(e);
                resizer.addEventListener('pointermove', onResizeMove);
                resizer.addEventListener('pointerup', onResizeEnd);
                resizer.addEventListener('pointercancel', onResizeEnd);
            });
        };
        setupResizer(resizerTop, 'top');
        setupResizer(resizerRight, 'right');
        setupResizer(resizerBottom, 'bottom');
        setupResizer(resizerLeft, 'left');
        setupResizer(resizerCorner, 'corner');
    }
    reattachTab(tab) {
        if (!tab.isDetached)
            return;
        if (tab.detachedWindow) {
            const index = this.detachedWindows.indexOf(tab.detachedWindow);
            if (index > -1)
                this.detachedWindows.splice(index, 1);
            if (tab.detachedWindow.panel.parentNode)
                tab.detachedWindow.panel.parentNode.removeChild(tab.detachedWindow.panel);
            tab.detachedWindow = null;
        }
        tab.isDetached = false;
        const allTabsSorted = Object.values(this.tabs)
            .filter(t => t.originalIndex !== undefined && t.isVisible)
            .sort((a, b) => (a.originalIndex ?? 0) - (b.originalIndex ?? 0));
        const currentButtons = Array.from(this.tabsContainer.children);
        let insertIndex = 0;
        for (const t of allTabsSorted) {
            if (t.id === tab.id)
                break;
            if (!t.isDetached)
                insertIndex++;
        }
        if (insertIndex >= currentButtons.length || currentButtons.length === 0) {
            this.tabsContainer.appendChild(tab.button);
        }
        else {
            this.tabsContainer.insertBefore(tab.button, currentButtons[insertIndex]);
        }
        this.contentWrapper.appendChild(tab.content);
        tab.content.style.display = '';
        this.setActiveTab(tab.id);
        this.updatePanelSize();
        this.saveLayout();
    }
    setActiveTab(id) {
        if (this.activeTabId && this.tabs[this.activeTabId] && !this.tabs[this.activeTabId].isDetached) {
            this.tabs[this.activeTabId].setActive(false);
        }
        this.activeTabId = id;
        if (this.tabs[id])
            this.tabs[id].setActive(true);
        this.saveLayout();
    }
    togglePanel() {
        this.panel.classList.toggle('visible');
        this.toggleButton.classList.toggle('panel-open');
        this.miniPanel.classList.toggle('panel-open');
        const isVisible = this.panel.classList.contains('visible');
        this.detachedWindows.forEach(dw => {
            if (isVisible) {
                dw.panel.style.opacity = '';
                dw.panel.style.visibility = '';
                dw.panel.style.pointerEvents = '';
            }
            else {
                dw.panel.style.opacity = '0';
                dw.panel.style.visibility = 'hidden';
                dw.panel.style.pointerEvents = 'none';
            }
        });
        this.saveLayout();
    }
    togglePosition() {
        this.setPosition(this.position === 'bottom' ? 'right' : 'bottom');
    }
    setPosition(targetPosition) {
        if (this.position === targetPosition)
            return;
        this.panel.style.transition = 'none';
        const isMaximized = this.panel.classList.contains('maximized');
        if (targetPosition === 'right') {
            this.position = 'right';
            this.floatingBtn.classList.add('active');
            this.floatingBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><path d="M3 15h18"></path></svg>';
            this.floatingBtn.title = 'Switch to Bottom';
            this.panel.classList.remove('position-bottom');
            this.panel.classList.add('position-right');
            this.panel.style.bottom = '';
            this.panel.style.top = '0';
            this.panel.style.right = '0';
            this.panel.style.left = '';
            this.panel.style.width = isMaximized ? '100vw' : `${this.lastWidthRight}px`;
            this.panel.style.height = '100%';
        }
        else {
            this.position = 'bottom';
            this.floatingBtn.classList.remove('active');
            this.floatingBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="15" y1="3" x2="15" y2="21"></line></svg>';
            this.floatingBtn.title = 'Switch to Right Side';
            this.panel.classList.remove('position-right');
            this.panel.classList.add('position-bottom');
            this.panel.style.top = '';
            this.panel.style.right = '';
            this.panel.style.bottom = '0';
            this.panel.style.left = '0';
            this.panel.style.width = '100%';
            this.panel.style.height = isMaximized ? '100vh' : `${this.lastHeightBottom}px`;
        }
        setTimeout(() => { this.panel.style.transition = ''; }, 50);
        this.updatePanelSize();
        this.saveLayout();
    }
    saveLayout() {
        if (this.isLoadingLayout)
            return;
        const layout = {
            position: this.position,
            lastHeightBottom: this.lastHeightBottom,
            lastWidthRight: this.lastWidthRight,
            activeTabId: this.activeTabId,
            detachedTabs: [],
            isVisible: this.panel.classList.contains('visible'),
        };
        this.detachedWindows.forEach(dw => {
            const { panel: p, tab } = dw;
            layout.detachedTabs.push({
                tabId: tab.id,
                originalIndex: tab.originalIndex ?? 0,
                left: parseFloat(p.style.left) || p.offsetLeft || 0,
                top: parseFloat(p.style.top) || p.offsetTop || 0,
                width: p.offsetWidth,
                height: p.offsetHeight,
            });
        });
        try {
            const savedData = localStorage.getItem('gpucat-inspector');
            const data = JSON.parse(savedData || '{}');
            data.layout = layout;
            localStorage.setItem('gpucat-inspector', JSON.stringify(data));
        }
        catch (e) {
            console.warn('Failed to save profiler layout:', e);
        }
    }
    loadLayout() {
        this.isLoadingLayout = true;
        try {
            const savedData = localStorage.getItem('gpucat-inspector');
            if (!savedData)
                return;
            const parsedData = JSON.parse(savedData);
            const layout = parsedData.layout;
            if (!layout)
                return;
            if (layout.detachedTabs?.length > 0) {
                const ww = window.innerWidth, wh = window.innerHeight;
                layout.detachedTabs = layout.detachedTabs.map(d => {
                    let { left, top, width, height } = d;
                    if (width > ww)
                        width = ww - 100;
                    if (height > wh)
                        height = wh - 100;
                    const hw = width / 2, hh = height / 2;
                    if (left + width > ww + hw)
                        left = ww + hw - width;
                    if (left < -hw)
                        left = -hw;
                    if (top + height > wh + hh)
                        top = wh + hh - height;
                    if (top < -hh)
                        top = -hh;
                    return { ...d, left, top, width, height };
                });
            }
            if (layout.position)
                this.position = layout.position;
            if (layout.lastHeightBottom)
                this.lastHeightBottom = layout.lastHeightBottom;
            if (layout.lastWidthRight)
                this.lastWidthRight = layout.lastWidthRight;
            const ww = window.innerWidth, wh = window.innerHeight;
            if (this.lastHeightBottom > wh - 50)
                this.lastHeightBottom = wh - 50;
            if (this.lastWidthRight > ww - 50)
                this.lastWidthRight = ww - 50;
            if (this.position === 'right') {
                this.floatingBtn.classList.add('active');
                this.floatingBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><path d="M3 15h18"></path></svg>';
                this.floatingBtn.title = 'Switch to Bottom';
                this.panel.classList.remove('position-bottom');
                this.panel.classList.add('position-right');
                this.panel.style.bottom = '';
                this.panel.style.top = '0';
                this.panel.style.right = '0';
                this.panel.style.left = '';
                this.panel.style.width = `${this.lastWidthRight}px`;
                this.panel.style.height = '100%';
            }
            else {
                this.panel.style.height = `${this.lastHeightBottom}px`;
            }
            if (layout.isVisible) {
                this.panel.classList.add('visible');
                this.toggleButton.classList.add('panel-open');
            }
            if (layout.activeTabId)
                this.setActiveTab(layout.activeTabId);
            if (layout.detachedTabs?.length > 0) {
                this.pendingDetachedTabs = layout.detachedTabs;
                this.restoreDetachedTabs();
            }
            this.updatePanelSize();
            if (this.panel.classList.contains('visible')) {
                this.miniPanel.classList.add('panel-open');
            }
        }
        catch (e) {
            console.warn('Failed to load profiler layout:', e);
        }
        finally {
            this.isLoadingLayout = false;
        }
    }
    restoreDetachedTabs() {
        if (!this.pendingDetachedTabs?.length)
            return;
        this.pendingDetachedTabs.forEach(d => {
            const tab = this.tabs[d.tabId];
            if (!tab || tab.isDetached)
                return;
            if (d.originalIndex !== undefined)
                tab.originalIndex = d.originalIndex;
            if (tab.button.parentNode)
                tab.button.parentNode.removeChild(tab.button);
            if (tab.content.parentNode)
                tab.content.parentNode.removeChild(tab.content);
            const dw = this.createDetachedWindow(tab, 0, 0);
            dw.panel.style.left = `${d.left}px`;
            dw.panel.style.top = `${d.top}px`;
            dw.panel.style.width = `${d.width}px`;
            dw.panel.style.height = `${d.height}px`;
            this.constrainWindowToBounds(dw.panel);
            this.detachedWindows.push(dw);
            tab.isDetached = true;
            tab.detachedWindow = dw;
        });
        this.pendingDetachedTabs = null;
        this.detachedWindows.forEach(dw => {
            const z = parseInt(getComputedStyle(dw.panel).zIndex) || 0;
            if (z > this.maxZIndex)
                this.maxZIndex = z;
        });
        const needsNewActiveTab = !this.activeTabId || !this.tabs[this.activeTabId] ||
            this.tabs[this.activeTabId].isDetached || !this.tabs[this.activeTabId].isVisible;
        if (needsNewActiveTab) {
            const available = Object.keys(this.tabs).filter(id => !this.tabs[id].isDetached && this.tabs[id].isVisible);
            if (available.length > 0) {
                const buttons = Array.from(this.tabsContainer.children);
                const ordered = buttons.map(btn => Object.keys(this.tabs).find(id => this.tabs[id].button === btn))
                    .filter((id) => id !== undefined && !this.tabs[id].isDetached && this.tabs[id].isVisible);
                this.setActiveTab(ordered[0] || available[0]);
            }
            else {
                this.activeTabId = null;
            }
        }
        this.updatePanelSize();
    }
}

function createValueSpan(id = null) {
    const span = document.createElement('span');
    span.className = 'value';
    if (id !== null)
        span.id = id;
    return span;
}
function setText(element, text) {
    const el = element instanceof HTMLElement ? element : (element ? document.getElementById(element) : null);
    if (el && el.textContent !== text)
        el.textContent = text;
}

class Tab {
    id;
    button;
    content;
    isActive;
    isVisible;
    isDetached;
    detachedWindow;
    allowDetach;
    builtin;
    icon;
    builtinButton;
    miniContent;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    profiler;
    onVisibilityChange;
    originalIndex;
    constructor(title, options = {}) {
        this.id = title.toLowerCase();
        this.button = document.createElement('button');
        this.button.className = 'tab-btn';
        this.button.textContent = title;
        this.content = document.createElement('div');
        this.content.id = `${this.id}-content`;
        this.content.className = 'profiler-content';
        this.isActive = false;
        this.isVisible = true;
        this.isDetached = false;
        this.detachedWindow = null;
        this.allowDetach = options.allowDetach !== undefined ? options.allowDetach : true;
        this.builtin = options.builtin !== undefined ? options.builtin : false;
        this.icon = options.icon || null;
        this.builtinButton = null;
        this.miniContent = null;
        this.profiler = null;
        this.onVisibilityChange = null;
    }
    setActive(isActive) {
        this.button.classList.toggle('active', isActive);
        this.content.classList.toggle('active', isActive);
        this.isActive = isActive;
    }
    show() {
        this.content.style.display = '';
        this.button.style.display = '';
        this.isVisible = true;
        if (this.isDetached && this.detachedWindow) {
            this.detachedWindow.panel.style.display = '';
        }
        if (this.onVisibilityChange)
            this.onVisibilityChange();
        this.showBuiltin();
    }
    hide() {
        this.content.style.display = 'none';
        this.button.style.display = 'none';
        this.isVisible = false;
        if (this.isDetached && this.detachedWindow) {
            this.detachedWindow.panel.style.display = 'none';
        }
        if (this.onVisibilityChange)
            this.onVisibilityChange();
        this.hideBuiltin();
    }
    showBuiltin() {
        if (!this.builtin)
            return;
        if (this.profiler && this.profiler.builtinTabsContainer) {
            this.profiler.builtinTabsContainer.style.display = '';
        }
        if (this.builtinButton)
            this.builtinButton.style.display = '';
        if (this.miniContent && this.profiler) {
            this.profiler.miniPanel.querySelectorAll('.mini-panel-content').forEach((c) => {
                c.style.display = 'none';
            });
            this.profiler.builtinTabsContainer.querySelectorAll('.builtin-tab-btn').forEach((btn) => {
                btn.classList.remove('active');
            });
            if (this.builtinButton)
                this.builtinButton.classList.add('active');
            if (!this.miniContent.firstChild) {
                const actualContent = this.content.querySelector('.list-scroll-wrapper') || this.content.firstElementChild;
                if (actualContent)
                    this.miniContent.appendChild(actualContent);
            }
            this.miniContent.style.display = 'block';
            this.profiler.miniPanel.classList.add('visible');
        }
    }
    hideBuiltin() {
        if (!this.builtin)
            return;
        if (this.builtinButton)
            this.builtinButton.style.display = 'none';
        if (this.miniContent) {
            this.miniContent.style.display = 'none';
            if (this.miniContent.firstChild) {
                this.content.appendChild(this.miniContent.firstChild);
            }
        }
        if (this.builtinButton)
            this.builtinButton.classList.remove('active');
        if (this.profiler) {
            const hasVisible = Array.from(this.profiler.miniPanel.querySelectorAll('.mini-panel-content'))
                .some(c => c.style.display !== 'none');
            if (!hasVisible)
                this.profiler.miniPanel.classList.remove('visible');
            const hasVisibleBtns = Array.from(this.profiler.builtinTabsContainer.querySelectorAll('.builtin-tab-btn'))
                .some(btn => btn.style.display !== 'none');
            if (!hasVisibleBtns)
                this.profiler.builtinTabsContainer.style.display = 'none';
        }
    }
}

class Controller {
    parent;
    object;
    property;
    initialValue;
    domElement;
    $name;
    $widget;
    $disable;
    _disabled = false;
    _hidden = false;
    _listening = false;
    _name;
    _onChange;
    _onFinishChange;
    _changed = false;
    _listenCallbackID;
    _listenPrevValue;
    constructor(parent, object, property, className, elementType = 'div') {
        this.parent = parent;
        this.object = object;
        this.property = property;
        this.initialValue = this.getValue();
        this.domElement = document.createElement(elementType);
        this.domElement.classList.add('gui-controller', className);
        this.$name = document.createElement('div');
        this.$name.classList.add('gui-name');
        this.$widget = document.createElement('div');
        this.$widget.classList.add('gui-widget');
        this.$disable = this.$widget;
        this.domElement.appendChild(this.$name);
        this.domElement.appendChild(this.$widget);
        this.domElement.addEventListener('keydown', e => e.stopPropagation());
        this.domElement.addEventListener('keyup', e => e.stopPropagation());
        this.parent.children.push(this);
        this.parent.controllers.push(this);
        this.parent.$children.appendChild(this.domElement);
        this._listenCallback = this._listenCallback.bind(this);
        this._name = property;
        this.name(property);
    }
    name(name) {
        this._name = name;
        this.$name.textContent = name;
        return this;
    }
    onChange(callback) {
        this._onChange = callback;
        return this;
    }
    _callOnChange() {
        this.parent._callOnChange(this);
        if (this._onChange !== undefined) {
            this._onChange.call(this, this.getValue());
        }
        this._changed = true;
    }
    onFinishChange(callback) {
        this._onFinishChange = callback;
        return this;
    }
    _callOnFinishChange() {
        if (this._changed) {
            this.parent._callOnFinishChange(this);
            if (this._onFinishChange !== undefined) {
                this._onFinishChange.call(this, this.getValue());
            }
        }
        this._changed = false;
    }
    reset() {
        this.setValue(this.initialValue);
        this._callOnFinishChange();
        return this;
    }
    enable(enabled = true) {
        return this.disable(!enabled);
    }
    disable(disabled = true) {
        if (disabled === this._disabled)
            return this;
        this._disabled = disabled;
        this.domElement.classList.toggle('gui-disabled', disabled);
        this.$disable.toggleAttribute('disabled', disabled);
        return this;
    }
    show(show = true) {
        this._hidden = !show;
        this.domElement.style.display = this._hidden ? 'none' : '';
        return this;
    }
    hide() {
        return this.show(false);
    }
    // No-ops on base — overridden in NumberController
    min(_min) { return this; }
    max(_max) { return this; }
    step(_step) { return this; }
    decimals(_decimals) { return this; }
    listen(listen = true) {
        this._listening = listen;
        if (this._listenCallbackID !== undefined) {
            cancelAnimationFrame(this._listenCallbackID);
            this._listenCallbackID = undefined;
        }
        if (this._listening) {
            this._listenCallback();
        }
        return this;
    }
    _listenCallback() {
        this._listenCallbackID = requestAnimationFrame(this._listenCallback);
        const curValue = this.save();
        if (curValue !== this._listenPrevValue) {
            this.updateDisplay();
        }
        this._listenPrevValue = curValue;
    }
    getValue() {
        return this.object[this.property];
    }
    setValue(value) {
        if (this.getValue() !== value) {
            this.object[this.property] = value;
            this._callOnChange();
            this.updateDisplay();
        }
        return this;
    }
    updateDisplay() {
        return this;
    }
    save() {
        return this.getValue();
    }
    load(value) {
        this.setValue(value);
        this._callOnFinishChange();
        return this;
    }
    destroy() {
        this.listen(false);
        this.parent.children.splice(this.parent.children.indexOf(this), 1);
        this.parent.controllers.splice(this.parent.controllers.indexOf(this), 1);
        this.parent.$children.removeChild(this.domElement);
    }
}

class NumberController extends Controller {
    $input;
    $slider;
    $fill;
    _min;
    _max;
    _step = 0.1;
    _stepExplicit = false;
    _decimals;
    _hasSlider = false;
    _inputFocused = false;
    constructor(parent, object, property, min, max, step) {
        super(parent, object, property, 'gui-number');
        this.$input = document.createElement('input');
        this.$input.setAttribute('type', 'text');
        this.$input.setAttribute('aria-labelledby', this.$name.id);
        if (window.matchMedia('(pointer: coarse)').matches) {
            this.$input.setAttribute('type', 'number');
            this.$input.setAttribute('step', 'any');
        }
        this.$widget.appendChild(this.$input);
        this.$disable = this.$input;
        this._initInputHandlers();
        this.min(min);
        this.max(max);
        const stepExplicit = step !== undefined;
        this.step(stepExplicit ? step : this._getImplicitStep(), stepExplicit);
        this.updateDisplay();
    }
    min(min) {
        this._min = min;
        this._onUpdateMinMax();
        return this;
    }
    max(max) {
        this._max = max;
        this._onUpdateMinMax();
        return this;
    }
    step(step, explicit = true) {
        this._step = step;
        this._stepExplicit = explicit;
        return this;
    }
    decimals(decimals) {
        this._decimals = decimals;
        this.updateDisplay();
        return this;
    }
    updateDisplay() {
        const value = this.getValue();
        if (this._hasSlider && this.$fill) {
            let percent = (value - this._min) / (this._max - this._min);
            percent = Math.max(0, Math.min(percent, 1));
            this.$fill.style.width = percent * 100 + '%';
        }
        if (!this._inputFocused) {
            this.$input.value = this._decimals === undefined ? String(value) : value.toFixed(this._decimals);
        }
        return this;
    }
    _initInputHandlers() {
        const onInput = () => {
            const value = parseFloat(this.$input.value);
            if (isNaN(value))
                return;
            this.setValue(this._clamp(this._stepExplicit ? this._snap(value) : value));
        };
        const increment = (delta) => {
            const value = parseFloat(this.$input.value);
            if (isNaN(value))
                return;
            this._snapClampSetValue(value + delta);
            this.$input.value = String(this.getValue());
        };
        const onKeyDown = (e) => {
            if (e.key === 'Enter')
                this.$input.blur();
            if (e.code === 'ArrowUp') {
                e.preventDefault();
                increment(this._step * this._arrowKeyMultiplier(e));
            }
            if (e.code === 'ArrowDown') {
                e.preventDefault();
                increment(this._step * this._arrowKeyMultiplier(e) * -1);
            }
        };
        const onWheel = (e) => {
            if (this._inputFocused) {
                e.preventDefault();
                increment(this._step * this._normalizeMouseWheel(e));
            }
        };
        let testingForVerticalDrag = false;
        let initClientX = 0, initClientY = 0, prevClientY = 0, initValue = 0, dragDelta = 0;
        const DRAG_THRESH = 5;
        const onMouseDown = (e) => {
            initClientX = e.clientX;
            initClientY = prevClientY = e.clientY;
            testingForVerticalDrag = true;
            initValue = this.getValue();
            dragDelta = 0;
            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
        };
        const onMouseMove = (e) => {
            if (testingForVerticalDrag) {
                const dx = e.clientX - initClientX;
                const dy = e.clientY - initClientY;
                if (Math.abs(dy) > DRAG_THRESH) {
                    e.preventDefault();
                    this.$input.blur();
                    testingForVerticalDrag = false;
                    this._setDraggingStyle(true, 'vertical');
                }
                else if (Math.abs(dx) > DRAG_THRESH) {
                    onMouseUp();
                }
            }
            if (!testingForVerticalDrag) {
                const dy = e.clientY - prevClientY;
                dragDelta -= dy * this._step * this._arrowKeyMultiplier(e);
                if (this._max !== undefined && initValue + dragDelta > this._max)
                    dragDelta = this._max - initValue;
                if (this._min !== undefined && initValue + dragDelta < this._min)
                    dragDelta = this._min - initValue;
                this._snapClampSetValue(initValue + dragDelta);
            }
            prevClientY = e.clientY;
        };
        const onMouseUp = () => {
            this._setDraggingStyle(false, 'vertical');
            this._callOnFinishChange();
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };
        const onFocus = () => { this._inputFocused = true; };
        const onBlur = () => {
            this._inputFocused = false;
            this.updateDisplay();
            this._callOnFinishChange();
        };
        this.$input.addEventListener('input', onInput);
        this.$input.addEventListener('keydown', onKeyDown);
        this.$input.addEventListener('wheel', onWheel, { passive: false });
        this.$input.addEventListener('mousedown', onMouseDown);
        this.$input.addEventListener('focus', onFocus);
        this.$input.addEventListener('blur', onBlur);
    }
    _initSlider() {
        this._hasSlider = true;
        this.$slider = document.createElement('div');
        this.$slider.classList.add('gui-slider');
        this.$fill = document.createElement('div');
        this.$fill.classList.add('gui-fill');
        this.$slider.appendChild(this.$fill);
        this.$widget.insertBefore(this.$slider, this.$input);
        this.domElement.classList.add('gui-has-slider');
        const map = (v, a, b, c, d) => (v - a) / (b - a) * (d - c) + c;
        const setValueFromX = (clientX) => {
            const rect = this.$slider.getBoundingClientRect();
            const value = map(clientX, rect.left, rect.right, this._min, this._max);
            this._snapClampSetValue(value);
        };
        const mouseDown = (e) => {
            this._setDraggingStyle(true);
            setValueFromX(e.clientX);
            window.addEventListener('mousemove', mouseMove);
            window.addEventListener('mouseup', mouseUp);
        };
        const mouseMove = (e) => setValueFromX(e.clientX);
        const mouseUp = () => {
            this._callOnFinishChange();
            this._setDraggingStyle(false);
            window.removeEventListener('mousemove', mouseMove);
            window.removeEventListener('mouseup', mouseUp);
        };
        let testingForScroll = false, prevClientX = 0, prevClientY = 0;
        const beginTouchDrag = (e) => {
            e.preventDefault();
            this._setDraggingStyle(true);
            setValueFromX(e.touches[0].clientX);
            testingForScroll = false;
        };
        const onTouchStart = (e) => {
            if (e.touches.length > 1)
                return;
            if (this._hasScrollBar) {
                prevClientX = e.touches[0].clientX;
                prevClientY = e.touches[0].clientY;
                testingForScroll = true;
            }
            else {
                beginTouchDrag(e);
            }
            window.addEventListener('touchmove', onTouchMove, { passive: false });
            window.addEventListener('touchend', onTouchEnd);
        };
        const onTouchMove = (e) => {
            if (testingForScroll) {
                const dx = e.touches[0].clientX - prevClientX;
                const dy = e.touches[0].clientY - prevClientY;
                if (Math.abs(dx) > Math.abs(dy)) {
                    beginTouchDrag(e);
                }
                else {
                    window.removeEventListener('touchmove', onTouchMove);
                    window.removeEventListener('touchend', onTouchEnd);
                }
            }
            else {
                e.preventDefault();
                setValueFromX(e.touches[0].clientX);
            }
        };
        const onTouchEnd = () => {
            this._callOnFinishChange();
            this._setDraggingStyle(false);
            window.removeEventListener('touchmove', onTouchMove);
            window.removeEventListener('touchend', onTouchEnd);
        };
        let wheelFinishChangeTimeout;
        const callOnFinishChange = this._callOnFinishChange.bind(this);
        const WHEEL_DEBOUNCE_TIME = 400;
        const onWheel = (e) => {
            const isVertical = Math.abs(e.deltaX) < Math.abs(e.deltaY);
            if (isVertical && this._hasScrollBar)
                return;
            e.preventDefault();
            const delta = this._normalizeMouseWheel(e) * this._step;
            this._snapClampSetValue(this.getValue() + delta);
            this.$input.value = String(this.getValue());
            clearTimeout(wheelFinishChangeTimeout);
            wheelFinishChangeTimeout = setTimeout(callOnFinishChange, WHEEL_DEBOUNCE_TIME);
        };
        this.$slider.addEventListener('mousedown', mouseDown);
        this.$slider.addEventListener('touchstart', onTouchStart, { passive: false });
        this.$slider.addEventListener('wheel', onWheel, { passive: false });
    }
    _setDraggingStyle(active, axis = 'horizontal') {
        if (this.$slider)
            this.$slider.classList.toggle('gui-active', active);
        document.body.classList.toggle('gui-dragging', active);
        document.body.classList.toggle(`gui-${axis}`, active);
    }
    _getImplicitStep() {
        if (this._hasMin && this._hasMax) {
            return (this._max - this._min) / 1000;
        }
        return 0.1;
    }
    _onUpdateMinMax() {
        if (!this._hasSlider && this._hasMin && this._hasMax) {
            if (!this._stepExplicit) {
                this.step(this._getImplicitStep(), false);
            }
            this._initSlider();
            this.updateDisplay();
        }
    }
    _normalizeMouseWheel(e) {
        let { deltaX, deltaY } = e;
        const wheelEvent = e;
        if (Math.floor(e.deltaY) !== e.deltaY && wheelEvent.wheelDelta) {
            deltaX = 0;
            deltaY = -wheelEvent.wheelDelta / 120;
            deltaY *= this._stepExplicit ? 1 : 10;
        }
        return deltaX + -deltaY;
    }
    _arrowKeyMultiplier(e) {
        let mult = this._stepExplicit ? 1 : 10;
        if (e.shiftKey)
            mult *= 10;
        else if (e.altKey)
            mult /= 10;
        return mult;
    }
    _snap(value) {
        let offset = 0;
        if (this._hasMin)
            offset = this._min;
        else if (this._hasMax)
            offset = this._max;
        value -= offset;
        value = Math.round(value / this._step) * this._step;
        value += offset;
        return parseFloat(value.toPrecision(15));
    }
    _clamp(value) {
        if (this._min !== undefined && value < this._min)
            value = this._min;
        if (this._max !== undefined && value > this._max)
            value = this._max;
        return value;
    }
    _snapClampSetValue(value) {
        this.setValue(this._clamp(this._snap(value)));
    }
    get _hasScrollBar() {
        const root = this.parent.root.$children;
        return root.scrollHeight > root.clientHeight;
    }
    get _hasMin() {
        return this._min !== undefined;
    }
    get _hasMax() {
        return this._max !== undefined;
    }
}

class BooleanController extends Controller {
    $input;
    constructor(parent, object, property) {
        super(parent, object, property, 'gui-boolean', 'label');
        this.$input = document.createElement('input');
        this.$input.setAttribute('type', 'checkbox');
        this.$input.setAttribute('aria-labelledby', this.$name.id);
        const $checkmark = document.createElement('span');
        $checkmark.classList.add('gui-checkmark');
        this.$widget.appendChild(this.$input);
        this.$widget.appendChild($checkmark);
        this.$disable = this.$input;
        this.$input.addEventListener('change', () => {
            this.setValue(this.$input.checked);
            this._callOnFinishChange();
        });
        this.updateDisplay();
    }
    updateDisplay() {
        this.$input.checked = this.getValue();
        return this;
    }
}

class StringController extends Controller {
    $input;
    constructor(parent, object, property) {
        super(parent, object, property, 'gui-string');
        this.$input = document.createElement('input');
        this.$input.setAttribute('type', 'text');
        this.$input.setAttribute('aria-labelledby', this.$name.id);
        this.$widget.appendChild(this.$input);
        this.$disable = this.$input;
        this.$input.addEventListener('input', () => {
            this.setValue(this.$input.value);
        });
        this.$input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter')
                this.$input.blur();
        });
        this.$input.addEventListener('blur', () => {
            this._callOnFinishChange();
        });
        this.updateDisplay();
    }
    updateDisplay() {
        this.$input.value = this.getValue();
        return this;
    }
}

function isColorObject(v) {
    return typeof v === 'object' && v !== null && 'r' in v && 'g' in v && 'b' in v;
}
function isColorArray(v) {
    return Array.isArray(v) && v.length === 3;
}
function toHexString(value, rgbScale) {
    if (typeof value === 'number') {
        return '#' + value.toString(16).padStart(6, '0');
    }
    if (typeof value === 'string') {
        if (value.startsWith('#') && value.length === 7)
            return value;
        if (value.startsWith('#') && value.length === 4) {
            return '#' + value[1] + value[1] + value[2] + value[2] + value[3] + value[3];
        }
        const m = value.match(/rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
        if (m) {
            return '#' + [m[1], m[2], m[3]].map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
        }
        return value;
    }
    if (isColorObject(value)) {
        const r = Math.round((value.r / rgbScale) * 255);
        const g = Math.round((value.g / rgbScale) * 255);
        const b = Math.round((value.b / rgbScale) * 255);
        return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
    }
    if (isColorArray(value)) {
        const [r, g, b] = value.map(c => Math.round((c / rgbScale) * 255));
        return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
    }
    return '#ffffff';
}
function fromHexString(hex, target, rgbScale) {
    if (typeof target === 'number') {
        return parseInt(hex.slice(1), 16);
    }
    if (typeof target === 'string') {
        return hex;
    }
    const r = parseInt(hex.slice(1, 3), 16) / 255 * rgbScale;
    const g = parseInt(hex.slice(3, 5), 16) / 255 * rgbScale;
    const b = parseInt(hex.slice(5, 7), 16) / 255 * rgbScale;
    if (isColorObject(target)) {
        target.r = r;
        target.g = g;
        target.b = b;
        return target;
    }
    if (isColorArray(target)) {
        target[0] = r;
        target[1] = g;
        target[2] = b;
        return target;
    }
    return hex;
}
class ColorController extends Controller {
    $input;
    $text;
    $display;
    _rgbScale;
    _initialValueHexString;
    _textFocused = false;
    constructor(parent, object, property, rgbScale = 1) {
        super(parent, object, property, 'gui-color');
        this._rgbScale = rgbScale;
        this.$display = document.createElement('div');
        this.$display.classList.add('gui-color-display');
        this.$input = document.createElement('input');
        this.$input.setAttribute('type', 'color');
        this.$input.setAttribute('tabindex', '-1');
        this.$input.setAttribute('aria-labelledby', this.$name.id);
        this.$text = document.createElement('input');
        this.$text.setAttribute('type', 'text');
        this.$text.setAttribute('spellcheck', 'false');
        this.$text.setAttribute('aria-labelledby', this.$name.id);
        this.$display.appendChild(this.$input);
        this.$widget.appendChild(this.$display);
        this.$widget.appendChild(this.$text);
        this.$disable = this.$text;
        this._initialValueHexString = this.save();
        this.$input.addEventListener('input', () => {
            this._setValueFromHexString(this.$input.value);
        });
        this.$input.addEventListener('blur', () => {
            this._callOnFinishChange();
        });
        this.$text.addEventListener('input', () => {
            const normalized = this._tryNormalizeColorString(this.$text.value);
            if (normalized)
                this._setValueFromHexString(normalized);
        });
        this.$text.addEventListener('focus', () => {
            this._textFocused = true;
            this.$text.select();
        });
        this.$text.addEventListener('blur', () => {
            this._textFocused = false;
            this.updateDisplay();
            this._callOnFinishChange();
        });
        this.updateDisplay();
    }
    reset() {
        this._setValueFromHexString(this._initialValueHexString);
        return this;
    }
    save() {
        return toHexString(this.getValue(), this._rgbScale);
    }
    load(value) {
        this._setValueFromHexString(toHexString(value, this._rgbScale));
        this._callOnFinishChange();
        return this;
    }
    updateDisplay() {
        const hex = toHexString(this.getValue(), this._rgbScale);
        this.$input.value = hex;
        if (!this._textFocused) {
            this.$text.value = hex.substring(1);
        }
        this.$display.style.backgroundColor = hex;
        return this;
    }
    _setValueFromHexString(hex) {
        const current = this.getValue();
        if (typeof current === 'string' || typeof current === 'number') {
            const newValue = fromHexString(hex, current, this._rgbScale);
            if (newValue !== current) {
                this.object[this.property] = newValue;
                this._callOnChange();
                this.updateDisplay();
            }
        }
        else {
            // Mutates in place for objects/arrays, so always fire change
            fromHexString(hex, current, this._rgbScale);
            this._callOnChange();
            this.updateDisplay();
        }
    }
    _tryNormalizeColorString(str) {
        str = str.trim();
        if (/^#?[0-9a-fA-F]{6}$/.test(str)) {
            return str.startsWith('#') ? str : '#' + str;
        }
        if (/^#?[0-9a-fA-F]{3}$/.test(str)) {
            const s = str.replace('#', '');
            return '#' + s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
        }
        const m = str.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
        if (m) {
            return '#' + [m[1], m[2], m[3]].map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
        }
        return null;
    }
}

class OptionController extends Controller {
    $select;
    $display;
    _values = [];
    _names = [];
    constructor(parent, object, property, options) {
        super(parent, object, property, 'gui-option');
        this.$select = document.createElement('select');
        this.$select.setAttribute('aria-labelledby', this.$name.id);
        this.$display = document.createElement('div');
        this.$display.classList.add('gui-display');
        this.$select.addEventListener('change', () => {
            this.setValue(this._values[this.$select.selectedIndex]);
            this._callOnFinishChange();
        });
        this.$select.addEventListener('focus', () => {
            this.$display.classList.add('gui-focus');
        });
        this.$select.addEventListener('blur', () => {
            this.$display.classList.remove('gui-focus');
        });
        this.$widget.appendChild(this.$select);
        this.$widget.appendChild(this.$display);
        this.$disable = this.$select;
        this.options(options);
    }
    options(options) {
        this._values = Array.isArray(options) ? options : Object.values(options);
        this._names = Array.isArray(options) ? options.map(String) : Object.keys(options);
        this.$select.replaceChildren();
        this._names.forEach(name => {
            const $option = document.createElement('option');
            $option.textContent = name;
            this.$select.appendChild($option);
        });
        this.updateDisplay();
        return this;
    }
    updateDisplay() {
        const value = this.getValue();
        const index = this._values.indexOf(value);
        this.$select.selectedIndex = index;
        this.$display.textContent = index === -1 ? String(value) : this._names[index];
        return this;
    }
}

class FunctionController extends Controller {
    $button;
    constructor(parent, object, property) {
        super(parent, object, property, 'gui-function');
        this.$button = document.createElement('button');
        this.$button.appendChild(this.$name);
        this.$widget.appendChild(this.$button);
        this.$button.addEventListener('click', (e) => {
            e.preventDefault();
            this.getValue().call(this.object);
            this._callOnChange();
        });
        this.$button.addEventListener('touchstart', () => { }, { passive: true });
        this.$disable = this.$button;
    }
}

class GUI {
    parent;
    root;
    children;
    controllers;
    folders;
    domElement;
    $title;
    $children;
    _closed = false;
    _hidden = false;
    _title;
    _closeFolders;
    _onChange;
    _onFinishChange;
    _onOpenClose;
    constructor({ parent, title = 'Controls', closeFolders = false, container } = {}) {
        this.parent = parent;
        this.root = parent ? parent.root : this;
        this.children = [];
        this.controllers = [];
        this.folders = [];
        this._title = title;
        this._closeFolders = closeFolders;
        this.domElement = document.createElement('div');
        this.domElement.classList.add('gui');
        this.$title = document.createElement('button');
        this.$title.classList.add('gui-title');
        this.$title.setAttribute('aria-expanded', 'true');
        this.$title.addEventListener('click', () => this._openAnimated(this._closed));
        this.$title.addEventListener('touchstart', () => { }, { passive: true });
        this.$children = document.createElement('div');
        this.$children.classList.add('gui-children');
        this.domElement.appendChild(this.$title);
        this.domElement.appendChild(this.$children);
        this.title(title);
        if (parent) {
            parent.children.push(this);
            parent.folders.push(this);
            parent.$children.appendChild(this.domElement);
            return;
        }
        this.domElement.classList.add('gui-root');
        if (container) {
            container.appendChild(this.domElement);
        }
    }
    add(object, property, $1, max, step) {
        if ($1 !== null && typeof $1 === 'object' || Array.isArray($1)) {
            return new OptionController(this, object, property, $1);
        }
        const value = object[property];
        switch (typeof value) {
            case 'number':
                return new NumberController(this, object, property, $1, max, step);
            case 'boolean':
                return new BooleanController(this, object, property);
            case 'string':
                return new StringController(this, object, property);
            case 'function':
                return new FunctionController(this, object, property);
        }
        console.error('GUI.add failed — unsupported type', { object, property, value });
        // Return a no-op controller to avoid crashing call sites
        return new Controller(this, object, property, 'gui-unknown');
    }
    addColor(object, property, rgbScale = 1) {
        return new ColorController(this, object, property, rgbScale);
    }
    addFolder(title) {
        const folder = new GUI({ parent: this, title });
        if (this.root._closeFolders)
            folder.close();
        return folder;
    }
    open(open = true) {
        this._setClosed(!open);
        this.$title.setAttribute('aria-expanded', String(!this._closed));
        this.domElement.classList.toggle('gui-closed', this._closed);
        return this;
    }
    close() {
        return this.open(false);
    }
    show(show = true) {
        this._hidden = !show;
        this.domElement.style.display = this._hidden ? 'none' : '';
        return this;
    }
    hide() {
        return this.show(false);
    }
    title(title) {
        this._title = title;
        this.$title.textContent = title;
        return this;
    }
    reset(recursive = true) {
        const controllers = recursive ? this.controllersRecursive() : this.controllers;
        controllers.forEach(c => c.reset());
        return this;
    }
    onChange(callback) {
        this._onChange = callback;
        return this;
    }
    _callOnChange(controller) {
        if (this.parent) {
            this.parent._callOnChange(controller);
        }
        if (this._onChange !== undefined) {
            this._onChange.call(this, {
                object: controller.object,
                property: controller.property,
                value: controller.getValue(),
                controller,
            });
        }
    }
    onFinishChange(callback) {
        this._onFinishChange = callback;
        return this;
    }
    _callOnFinishChange(controller) {
        if (this.parent) {
            this.parent._callOnFinishChange(controller);
        }
        if (this._onFinishChange !== undefined) {
            this._onFinishChange.call(this, {
                object: controller.object,
                property: controller.property,
                value: controller.getValue(),
                controller,
            });
        }
    }
    onOpenClose(callback) {
        this._onOpenClose = callback;
        return this;
    }
    _callOnOpenClose(changedGUI) {
        if (this.parent) {
            this.parent._callOnOpenClose(changedGUI);
        }
        if (this._onOpenClose !== undefined) {
            this._onOpenClose.call(this, changedGUI);
        }
    }
    destroy() {
        if (this.parent) {
            this.parent.children.splice(this.parent.children.indexOf(this), 1);
            this.parent.folders.splice(this.parent.folders.indexOf(this), 1);
        }
        if (this.domElement.parentElement) {
            this.domElement.parentElement.removeChild(this.domElement);
        }
        Array.from(this.children).forEach(c => c.destroy());
    }
    controllersRecursive() {
        let result = Array.from(this.controllers);
        this.folders.forEach(f => { result = result.concat(f.controllersRecursive()); });
        return result;
    }
    foldersRecursive() {
        let result = Array.from(this.folders);
        this.folders.forEach(f => { result = result.concat(f.foldersRecursive()); });
        return result;
    }
    _setClosed(closed) {
        if (this._closed === closed)
            return;
        this._closed = closed;
        this._callOnOpenClose(this);
    }
    _openAnimated(open = true) {
        this._setClosed(!open);
        this.$title.setAttribute('aria-expanded', String(!this._closed));
        requestAnimationFrame(() => {
            const initialHeight = this.$children.clientHeight;
            this.$children.style.height = initialHeight + 'px';
            this.domElement.classList.add('gui-transition');
            const onTransitionEnd = (e) => {
                if (e.target !== this.$children)
                    return;
                this.$children.style.height = '';
                this.domElement.classList.remove('gui-transition');
                this.$children.removeEventListener('transitionend', onTransitionEnd);
            };
            this.$children.addEventListener('transitionend', onTransitionEnd);
            const targetHeight = !open ? 0 : this.$children.scrollHeight;
            this.domElement.classList.toggle('gui-closed', !open);
            requestAnimationFrame(() => {
                this.$children.style.height = targetHeight + 'px';
            });
        });
    }
}

class Parameters extends Tab {
    _container;
    constructor(options = {}) {
        super(options.name || 'Parameters', options);
        const container = document.createElement('div');
        container.className = 'gui-parameters-container';
        this.content.appendChild(container);
        this._container = container;
    }
    createGroup(name) {
        const gui = new GUI({ title: name });
        this._container.appendChild(gui.domElement);
        return gui;
    }
}

class List {
    headers;
    children;
    domElement;
    id;
    gridStyleElement;
    constructor(...headers) {
        this.headers = headers;
        this.children = [];
        this.domElement = document.createElement('div');
        this.domElement.className = 'list-container';
        this.domElement.style.padding = '10px';
        this.id = `list-${Math.random().toString(36).substr(2, 9)}`;
        this.domElement.dataset.listId = this.id;
        this.gridStyleElement = document.createElement('style');
        this.domElement.appendChild(this.gridStyleElement);
        const headerRow = document.createElement('div');
        headerRow.className = 'list-header';
        this.headers.forEach(headerText => {
            const headerCell = document.createElement('div');
            headerCell.className = 'list-header-cell';
            headerCell.textContent = headerText;
            headerRow.appendChild(headerCell);
        });
        this.domElement.appendChild(headerRow);
    }
    setGridStyle(gridTemplate) {
        this.gridStyleElement.textContent = `
[data-list-id="${this.id}"] > .list-header,
[data-list-id="${this.id}"] .list-item-row {
    grid-template-columns: ${gridTemplate};
}
`;
    }
    add(item) {
        if (item.parent !== null)
            item.parent.remove(item);
        item.domElement.classList.add('header-wrapper', 'section-start');
        item.parent = this;
        this.children.push(item);
        this.domElement.appendChild(item.domElement);
    }
    remove(item) {
        const index = this.children.indexOf(item);
        if (index !== -1) {
            this.children.splice(index, 1);
            this.domElement.removeChild(item.domElement);
            item.parent = null;
        }
        return this;
    }
}

class Graph {
    maxPoints;
    lines;
    limit;
    limitIndex;
    domElement;
    constructor(maxPoints = 512) {
        this.maxPoints = maxPoints;
        this.lines = {};
        this.limit = 0;
        this.limitIndex = 0;
        this.domElement = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        this.domElement.setAttribute('class', 'graph-svg');
    }
    addLine(id, color) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('class', 'graph-path');
        path.style.stroke = color;
        path.style.fill = color;
        this.domElement.appendChild(path);
        this.lines[id] = { path, color, points: [] };
    }
    addPoint(lineId, value) {
        const line = this.lines[lineId];
        if (!line)
            return;
        line.points.push(value);
        if (line.points.length > this.maxPoints)
            line.points.shift();
        if (value > this.limit) {
            this.limit = value;
            this.limitIndex = 0;
        }
    }
    resetLimit() {
        this.limit = 0;
        this.limitIndex = 0;
    }
    update() {
        const svgWidth = this.domElement.clientWidth;
        const svgHeight = this.domElement.clientHeight;
        if (svgWidth === 0)
            return;
        const pointStep = svgWidth / (this.maxPoints - 1);
        for (const id in this.lines) {
            const line = this.lines[id];
            let pathString = `M 0,${svgHeight}`;
            for (let i = 0; i < line.points.length; i++) {
                const x = i * pointStep;
                const y = svgHeight - (line.points[i] / this.limit) * svgHeight;
                pathString += ` L ${x},${y}`;
            }
            pathString += ` L ${(line.points.length - 1) * pointStep},${svgHeight} Z`;
            const offset = svgWidth - ((line.points.length - 1) * pointStep);
            line.path.setAttribute('transform', `translate(${offset}, 0)`);
            line.path.setAttribute('d', pathString);
        }
        if (this.limitIndex++ > this.maxPoints)
            this.resetLimit();
    }
}

class Item {
    children;
    isOpen;
    childrenContainer;
    parent;
    domElement;
    itemRow;
    userData;
    data;
    constructor(...data) {
        this.children = [];
        this.isOpen = true;
        this.childrenContainer = null;
        this.parent = null;
        this.domElement = document.createElement('div');
        this.domElement.className = 'list-item-wrapper';
        this.itemRow = document.createElement('div');
        this.itemRow.className = 'list-item-row';
        this.userData = {};
        this.data = data.map(d => (d instanceof HTMLElement ? d : String(d)));
        this.data.forEach(cellData => {
            const cell = document.createElement('div');
            cell.className = 'list-item-cell';
            if (cellData instanceof HTMLElement) {
                cell.appendChild(cellData);
            }
            else {
                cell.append(String(cellData));
            }
            this.itemRow.appendChild(cell);
        });
        this.domElement.appendChild(this.itemRow);
        this.onItemClick = this.onItemClick.bind(this);
    }
    onItemClick(e) {
        if (e.target.closest('button, a, input, label'))
            return;
        this.toggle();
    }
    add(item, index = this.children.length) {
        if (item.parent !== null)
            item.parent.remove(item);
        item.parent = this;
        this.children.splice(index, 0, item);
        this.itemRow.classList.add('collapsible');
        if (!this.childrenContainer) {
            this.childrenContainer = document.createElement('div');
            this.childrenContainer.className = 'list-children-container';
            this.childrenContainer.classList.toggle('closed', !this.isOpen);
            this.domElement.appendChild(this.childrenContainer);
            this.itemRow.addEventListener('click', this.onItemClick);
        }
        this.childrenContainer.insertBefore(item.domElement, this.childrenContainer.children[index] || null);
        this.updateToggler();
        return this;
    }
    remove(item) {
        const index = this.children.indexOf(item);
        if (index !== -1) {
            this.children.splice(index, 1);
            this.childrenContainer.removeChild(item.domElement);
            item.parent = null;
            if (this.children.length === 0) {
                this.itemRow.classList.remove('collapsible');
                this.itemRow.removeEventListener('click', this.onItemClick);
                this.childrenContainer.remove();
                this.childrenContainer = null;
            }
            this.updateToggler();
        }
        return this;
    }
    updateToggler() {
        const firstCell = this.itemRow.querySelector('.list-item-cell:first-child');
        let toggler = this.itemRow.querySelector('.item-toggler');
        if (this.children.length > 0) {
            if (!toggler) {
                toggler = document.createElement('span');
                toggler.className = 'item-toggler';
                firstCell?.prepend(toggler);
            }
            if (this.isOpen)
                this.itemRow.classList.add('open');
        }
        else if (toggler) {
            toggler.remove();
        }
    }
    toggle() {
        this.isOpen = !this.isOpen;
        this.itemRow.classList.toggle('open', this.isOpen);
        if (this.childrenContainer) {
            this.childrenContainer.classList.toggle('closed', !this.isOpen);
        }
        return this;
    }
    close() {
        if (this.isOpen)
            this.toggle();
        return this;
    }
}

class Performance extends Tab {
    graph;
    graphStats;
    frameStats;
    _entryItems = new Map();
    _list;
    constructor(options = {}) {
        super('Performance', options);
        // Graph pinned above the list — full width, fixed height
        const graphContainer = document.createElement('div');
        graphContainer.className = 'graph-container';
        const graph = new Graph();
        graph.addLine('fps', 'var(--color-fps)');
        graphContainer.appendChild(graph.domElement);
        this.content.appendChild(graphContainer);
        // Scrollable list below the graph
        const perfList = new List('Name', 'CPU (ms)', 'GPU (ms)');
        perfList.setGridStyle('minmax(200px, 2fr) 80px 80px');
        perfList.domElement.style.minWidth = '400px';
        const scrollWrapper = document.createElement('div');
        scrollWrapper.className = 'list-scroll-wrapper';
        scrollWrapper.appendChild(perfList.domElement);
        this.content.appendChild(scrollWrapper);
        // Graph stats row (FPS counter)
        const graphStats = new Item('Graph', createValueSpan(), createValueSpan('graph-fps-counter'));
        perfList.add(graphStats);
        // Frame stats item (totals row)
        const frameStats = new Item('Frame Stats', createValueSpan(), createValueSpan());
        perfList.add(frameStats);
        this.graph = graph;
        this.graphStats = graphStats;
        this.frameStats = frameStats;
        this._list = perfList;
    }
    updateGraph(inspector) {
        this.graph.addPoint('fps', inspector.fps);
        this.graph.update();
    }
    updateText(inspector, frame) {
        setText('graph-fps-counter', inspector.fps.toFixed() + ' FPS');
        // Update frame totals
        setText(this.frameStats.data[1], frame.cpuMs.toFixed(2));
        setText(this.frameStats.data[2], frame.gpuMs !== null ? frame.gpuMs.toFixed(2) : '-');
        // Track which entry names appeared this frame
        const seenNames = new Set();
        // Sort timeline by startTime for chronological display
        const sortedTimeline = [...frame.timeline].sort((a, b) => a.startTime - b.startTime);
        // Process timeline entries recursively
        this._updateEntries(sortedTimeline, this.frameStats, seenNames, '');
        // Remove items for entries no longer in this frame
        for (const [name, item] of this._entryItems) {
            if (!seenNames.has(name)) {
                if (item.parent)
                    item.parent.remove(item);
                this._entryItems.delete(name);
            }
        }
        void this._list; // suppress unused warning — list is owned by DOM
    }
    /** Recursively update/create items for timeline entries */
    _updateEntries(entries, parentItem, seenNames, pathPrefix) {
        for (const entry of entries) {
            // Create unique path for nested entries
            const entryPath = pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name;
            seenNames.add(entryPath);
            let item = this._entryItems.get(entryPath);
            if (!item) {
                const nameSpan = createValueSpan();
                // Add kind indicator prefix
                const kindPrefix = entry.kind === 'marker' ? '◆ ' : entry.kind === 'compute' ? '⚙ ' : '▶ ';
                nameSpan.textContent = kindPrefix + entry.name;
                const cpuSpan = createValueSpan();
                const gpuSpan = createValueSpan();
                item = new Item(nameSpan, cpuSpan, gpuSpan);
                parentItem.add(item);
                this._entryItems.set(entryPath, item);
            }
            // Update values
            setText(item.data[1], entry.cpuMs.toFixed(2));
            // GPU time only for render/compute entries
            if (entry.kind === 'render' || entry.kind === 'compute') {
                setText(item.data[2], entry.gpuMs !== null ? entry.gpuMs.toFixed(2) : '-');
            }
            else {
                setText(item.data[2], '-');
            }
            // Process children recursively
            if (entry.children.length > 0) {
                const sortedChildren = [...entry.children].sort((a, b) => a.startTime - b.startTime);
                this._updateEntries(sortedChildren, item, seenNames, entryPath);
            }
        }
    }
}

class Memory extends Tab {
    graph;
    memoryStats;
    gpuBuffers;
    rawBuffers;
    renderPipelines;
    computePipelines;
    constructor(options = {}) {
        super('Memory', options);
        // Graph pinned above the list — full width, fixed height
        const graphContainer = document.createElement('div');
        graphContainer.className = 'graph-container';
        const graph = new Graph();
        graph.addLine('total', 'var(--color-yellow)');
        graphContainer.appendChild(graph.domElement);
        this.content.appendChild(graphContainer);
        // Scrollable list below the graph
        const memoryList = new List('Name', 'Count');
        memoryList.setGridStyle('minmax(200px, 2fr) 80px');
        memoryList.domElement.style.minWidth = '300px';
        const scrollWrapper = document.createElement('div');
        scrollWrapper.className = 'list-scroll-wrapper';
        scrollWrapper.appendChild(memoryList.domElement);
        this.content.appendChild(scrollWrapper);
        // Stats tree
        const memoryStats = new Item('Renderer Info', '');
        memoryStats.domElement.firstChild.classList.add('no-hover');
        memoryList.add(memoryStats);
        const gpuBuffers = new Item('GPU Buffers', createValueSpan());
        const rawBuffers = new Item('Raw Buffers', createValueSpan());
        const renderPipelines = new Item('Render Pipelines', createValueSpan());
        const computePipelines = new Item('Compute Pipelines', createValueSpan());
        memoryStats.add(gpuBuffers);
        memoryStats.add(rawBuffers);
        memoryStats.add(renderPipelines);
        memoryStats.add(computePipelines);
        this.graph = graph;
        this.memoryStats = memoryStats;
        this.gpuBuffers = gpuBuffers;
        this.rawBuffers = rawBuffers;
        this.renderPipelines = renderPipelines;
        this.computePipelines = computePipelines;
    }
    updateGraph(inspector) {
        const renderer = inspector.getRenderer();
        if (!renderer)
            return;
        const bs = getBufferCacheStats(renderer._buffers);
        const total = bs.bufferCount + bs.rawCount;
        this.graph.addPoint('total', total);
        if (this.graph.limit === 0)
            this.graph.limit = 1;
        this.graph.update();
    }
    updateText(inspector) {
        const renderer = inspector.getRenderer();
        if (!renderer)
            return;
        const bs = getBufferCacheStats(renderer._buffers);
        const ps = getStats(renderer._pipelines);
        const ros = getRenderObjectsStats(renderer._renderObjects);
        setText(this.gpuBuffers.data[1], bs.bufferCount.toString());
        setText(this.rawBuffers.data[1], bs.rawCount.toString());
        setText(this.renderPipelines.data[1], `${ps.renderCount} render, ${ros.total} objects`);
        setText(this.computePipelines.data[1], `${ps.computeCount} compute`);
    }
}

const LIMIT = 500;
class Timeline extends Tab {
    isRecording = false;
    frames = [];
    currentFrame = null;
    isHierarchicalView = true;
    graph;
    graphSlider;
    hoverIndicator;
    playhead;
    timelineTrack;
    recordButton;
    recordRefreshButton;
    viewModeButton;
    frameInfo;
    collapsedGroups;
    selectedFrameIndex = -1;
    isTrackingLatest = true;
    isManualScrubbing = false;
    fixedScreenX = 0;
    constructor(options = {}) {
        super('Timeline', options);
        this.graph = new Graph(LIMIT);
        this.graph.addLine('fps', 'var(--color-fps)');
        this.graph.addLine('calls', 'var(--color-call)');
        this._buildHeader();
        this._buildUI();
        window.addEventListener('resize', () => {
            if (!this.isRecording && this.frames.length > 0) {
                this.renderSlider();
            }
        });
    }
    _buildHeader() {
        const header = document.createElement('div');
        header.className = 'console-header';
        this.recordButton = document.createElement('button');
        this.recordButton.className = 'console-copy-button';
        this.recordButton.title = 'Record';
        this.recordButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="4" fill="currentColor"></circle></svg>';
        this.recordButton.style.padding = '0 10px';
        this.recordButton.style.lineHeight = '24px';
        this.recordButton.style.display = 'flex';
        this.recordButton.style.alignItems = 'center';
        this.recordButton.addEventListener('click', () => this.toggleRecording());
        const clearButton = document.createElement('button');
        clearButton.className = 'console-copy-button';
        clearButton.title = 'Clear';
        clearButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>';
        clearButton.style.padding = '0 10px';
        clearButton.style.lineHeight = '24px';
        clearButton.style.display = 'flex';
        clearButton.style.alignItems = 'center';
        clearButton.addEventListener('click', () => this.clear());
        const exportButton = document.createElement('button');
        exportButton.className = 'console-copy-button';
        exportButton.title = 'Export Timeline Data';
        exportButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>';
        exportButton.style.padding = '0 10px';
        exportButton.style.lineHeight = '24px';
        exportButton.style.display = 'flex';
        exportButton.style.alignItems = 'center';
        exportButton.addEventListener('click', () => this.exportTimeline());
        this.viewModeButton = document.createElement('button');
        this.viewModeButton.className = 'console-copy-button';
        this.viewModeButton.title = 'Toggle View Mode';
        this.viewModeButton.textContent = 'Mode: Hierarchy';
        this.viewModeButton.style.padding = '0 10px';
        this.viewModeButton.style.lineHeight = '24px';
        this.viewModeButton.addEventListener('click', () => {
            this.isHierarchicalView = !this.isHierarchicalView;
            this.viewModeButton.textContent = this.isHierarchicalView ? 'Mode: Hierarchy' : 'Mode: Counts';
            if (this.selectedFrameIndex !== undefined && this.selectedFrameIndex !== -1) {
                this.selectFrame(this.selectedFrameIndex);
            }
        });
        this.recordRefreshButton = document.createElement('button');
        this.recordRefreshButton.className = 'console-copy-button';
        this.recordRefreshButton.title = 'Refresh & Record';
        this.recordRefreshButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><circle cx="12" cy="12" r="3" fill="currentColor"></circle></svg>';
        this.recordRefreshButton.style.padding = '0 10px';
        this.recordRefreshButton.style.lineHeight = '24px';
        this.recordRefreshButton.style.display = 'flex';
        this.recordRefreshButton.style.alignItems = 'center';
        this.recordRefreshButton.addEventListener('click', () => {
            const storage = JSON.parse(localStorage.getItem('gpucat-inspector') || '{}');
            storage.timeline = storage.timeline || {};
            storage.timeline.recording = true;
            localStorage.setItem('gpucat-inspector', JSON.stringify(storage));
            window.location.reload();
        });
        const buttonsGroup = document.createElement('div');
        buttonsGroup.className = 'console-buttons-group';
        buttonsGroup.appendChild(this.viewModeButton);
        buttonsGroup.appendChild(this.recordButton);
        buttonsGroup.appendChild(this.recordRefreshButton);
        buttonsGroup.appendChild(clearButton);
        buttonsGroup.appendChild(exportButton);
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.padding = '6px';
        header.style.borderBottom = '1px solid var(--border-color)';
        const titleElement = document.createElement('div');
        titleElement.textContent = 'Backend Calls Timeline';
        titleElement.style.color = 'var(--text-primary)';
        titleElement.style.alignSelf = 'center';
        titleElement.style.paddingLeft = '5px';
        this.frameInfo = document.createElement('span');
        this.frameInfo.style.marginLeft = '15px';
        this.frameInfo.style.fontFamily = 'monospace';
        this.frameInfo.style.color = 'var(--text-secondary)';
        this.frameInfo.style.fontSize = '12px';
        titleElement.appendChild(this.frameInfo);
        header.appendChild(titleElement);
        header.appendChild(buttonsGroup);
        this.content.appendChild(header);
    }
    _buildUI() {
        const container = document.createElement('div');
        container.className = 'timeline-body';
        const graphContainer = document.createElement('div');
        graphContainer.className = 'graph-container';
        graphContainer.style.borderBottom = '1px solid var(--border-color)';
        this.graphSlider = document.createElement('div');
        this.graphSlider.className = 'timeline-graph-slider';
        graphContainer.appendChild(this.graphSlider);
        this.graph.domElement.style.width = '100%';
        this.graph.domElement.style.height = '100%';
        this.graphSlider.appendChild(this.graph.domElement);
        this.hoverIndicator = document.createElement('div');
        this.hoverIndicator.className = 'timeline-hover-indicator';
        this.graphSlider.appendChild(this.hoverIndicator);
        this.playhead = document.createElement('div');
        this.playhead.className = 'timeline-playhead';
        const playheadHandle = document.createElement('div');
        playheadHandle.className = 'timeline-playhead-handle';
        this.playhead.appendChild(playheadHandle);
        this.graphSlider.appendChild(this.playhead);
        this.graphSlider.tabIndex = 0;
        let isDragging = false;
        const updatePlayheadFromEvent = (e) => {
            if (this.frames.length === 0)
                return;
            const rect = this.graphSlider.getBoundingClientRect();
            let x = e.clientX - rect.left;
            x = Math.max(0, Math.min(x, rect.width));
            this.fixedScreenX = x;
            const pointCount = this.graph.lines['calls'].points.length;
            if (pointCount === 0)
                return;
            const pointStep = rect.width / (this.graph.maxPoints - 1);
            const offset = rect.width - ((pointCount - 1) * pointStep);
            let localFrameIndex = Math.round((x - offset) / pointStep);
            localFrameIndex = Math.max(0, Math.min(localFrameIndex, pointCount - 1));
            this.isTrackingLatest = localFrameIndex >= pointCount - 2;
            let frameIndex = localFrameIndex;
            if (this.frames.length > pointCount)
                frameIndex += this.frames.length - pointCount;
            this.playhead.style.display = 'block';
            this.selectFrame(frameIndex);
        };
        this.graphSlider.addEventListener('mousedown', (e) => {
            isDragging = true;
            this.isManualScrubbing = true;
            this.graphSlider.focus();
            updatePlayheadFromEvent(e);
        });
        this.graphSlider.addEventListener('mouseenter', () => {
            if (this.frames.length > 0 && !this.isRecording) {
                this.hoverIndicator.style.display = 'block';
            }
        });
        this.graphSlider.addEventListener('mouseleave', () => {
            this.hoverIndicator.style.display = 'none';
        });
        this.graphSlider.addEventListener('mousemove', (e) => {
            if (this.frames.length === 0 || this.isRecording)
                return;
            const rect = this.graphSlider.getBoundingClientRect();
            let x = e.clientX - rect.left;
            x = Math.max(0, Math.min(x, rect.width));
            const pointCount = this.graph.lines['calls'].points.length;
            if (pointCount > 0) {
                const pointStep = rect.width / (this.graph.maxPoints - 1);
                const offset = rect.width - ((pointCount - 1) * pointStep);
                let localFrameIndex = Math.round((x - offset) / pointStep);
                localFrameIndex = Math.max(0, Math.min(localFrameIndex, pointCount - 1));
                let snappedX = offset + localFrameIndex * pointStep;
                snappedX = Math.max(1, Math.min(snappedX, rect.width - 1));
                this.hoverIndicator.style.left = snappedX + 'px';
            }
            else {
                this.hoverIndicator.style.left = Math.max(1, Math.min(x, rect.width - 1)) + 'px';
            }
        });
        this.graphSlider.addEventListener('keydown', (e) => {
            if (this.frames.length === 0 || this.isRecording)
                return;
            let newIndex = this.selectedFrameIndex;
            if (e.key === 'ArrowLeft') {
                newIndex = Math.max(0, this.selectedFrameIndex - 1);
                e.preventDefault();
            }
            else if (e.key === 'ArrowRight') {
                newIndex = Math.min(this.frames.length - 1, this.selectedFrameIndex + 1);
                e.preventDefault();
            }
            if (newIndex !== this.selectedFrameIndex) {
                this.selectFrame(newIndex);
                const pointCount = this.graph.lines['calls'].points.length;
                if (pointCount > 0) {
                    let localIndex = newIndex;
                    if (this.frames.length > pointCount)
                        localIndex = newIndex - (this.frames.length - pointCount);
                    this.isTrackingLatest = localIndex >= pointCount - 2;
                    const rect = this.graphSlider.getBoundingClientRect();
                    const pointStep = rect.width / (this.graph.maxPoints - 1);
                    const offset = rect.width - ((pointCount - 1) * pointStep);
                    this.fixedScreenX = offset + localIndex * pointStep;
                }
            }
        });
        window.addEventListener('mousemove', (e) => {
            if (!isDragging)
                return;
            updatePlayheadFromEvent(e);
            const rect = this.graphSlider.getBoundingClientRect();
            let x = e.clientX - rect.left;
            x = Math.max(0, Math.min(x, rect.width));
            const pointCount = this.graph.lines['calls'].points.length;
            if (pointCount > 0) {
                const pointStep = rect.width / (this.graph.maxPoints - 1);
                const offset = rect.width - ((pointCount - 1) * pointStep);
                let localFrameIndex = Math.round((x - offset) / pointStep);
                localFrameIndex = Math.max(0, Math.min(localFrameIndex, pointCount - 1));
                let snappedX = offset + localFrameIndex * pointStep;
                snappedX = Math.max(1, Math.min(snappedX, rect.width - 1));
                this.hoverIndicator.style.left = snappedX + 'px';
            }
            else {
                this.hoverIndicator.style.left = Math.max(1, Math.min(x, rect.width - 1)) + 'px';
            }
        });
        window.addEventListener('mouseup', () => {
            isDragging = false;
            this.isManualScrubbing = false;
        });
        container.appendChild(graphContainer);
        const mainArea = document.createElement('div');
        mainArea.className = 'timeline-main-area';
        this.timelineTrack = document.createElement('div');
        this.timelineTrack.className = 'timeline-track';
        this._showEmptyHint();
        mainArea.appendChild(this.timelineTrack);
        container.appendChild(mainArea);
        this.content.appendChild(container);
    }
    /** Called by Inspector.ts to set up auto-start from localStorage. */
    setRenderer(_renderer) {
        const storage = JSON.parse(localStorage.getItem('gpucat-inspector') || '{}');
        if (storage.timeline?.recording) {
            storage.timeline.recording = false;
            localStorage.setItem('gpucat-inspector', JSON.stringify(storage));
            this.toggleRecording();
        }
    }
    toggleRecording() {
        this.isRecording = !this.isRecording;
        if (this.isRecording) {
            this.recordButton.title = 'Stop';
            this.recordButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>';
            this.recordButton.style.color = 'var(--color-red)';
            this.startRecording();
        }
        else {
            this.recordButton.title = 'Record';
            this.recordButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="4" fill="currentColor"></circle></svg>';
            this.recordButton.style.color = '';
            this.stopRecording();
            this.renderSlider();
        }
    }
    startRecording() {
        this.frames = [];
        this.currentFrame = null;
        this.selectedFrameIndex = -1;
        this.fixedScreenX = 0;
        this.isTrackingLatest = true;
        this.isManualScrubbing = false;
        this.clear();
        this.frameInfo.textContent = 'Recording...';
        // Actual call interception is done by Inspector overriding begin/beginRender/etc.
        // and calling timeline.onCall(method, label).
    }
    stopRecording() {
        // Nothing to undo — no monkey-patching happened.
        if (this.currentFrame) ;
    }
    /**
     * Called by Inspector when a new frame begins or a pass/compute begins/ends.
     * `method` is e.g. 'begin', 'beginRender', 'finishRender', 'beginCompute', 'finishCompute'.
     * `label` is e.g. the frameId string or a passId.
     */
    onCall(method, label, fps = 0) {
        if (!this.isRecording)
            return;
        if (method === 'begin') {
            // A new frame started — seal the previous frame
            if (this.currentFrame) {
                this.currentFrame.fps = fps;
                if (!isFinite(this.currentFrame.fps))
                    this.currentFrame.fps = 0;
            }
            this.currentFrame = { id: label, calls: [], fps: 0 };
            this.frames.push(this.currentFrame);
            if (this.frames.length > LIMIT)
                this.frames.shift();
            return;
        }
        if (!this.currentFrame)
            return;
        this.currentFrame.calls.push({ method: label ? `${method} - ${label}` : method });
    }
    clear() {
        this.frames = [];
        this.timelineTrack.innerHTML = '';
        this._showEmptyHint();
        this.playhead.style.display = 'none';
        this.frameInfo.textContent = '';
        this.graph.lines['calls'].points = [];
        this.graph.lines['fps'].points = [];
        this.graph.resetLimit();
        this.graph.update();
    }
    exportTimeline() {
        if (this.frames.length === 0) {
            console.warn('[gpucat] No timeline data to export');
            return;
        }
        const data = JSON.stringify(this.frames, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `gpucat-timeline-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }
    _showEmptyHint() {
        const hint = document.createElement('div');
        hint.className = 'timeline-empty-hint';
        hint.textContent = 'Click \u25CF Record to capture backend calls';
        this.timelineTrack.appendChild(hint);
    }
    renderSlider() {
        if (this.frames.length === 0) {
            this.playhead.style.display = 'none';
            this.frameInfo.textContent = '';
            return;
        }
        this.graph.lines['calls'].points = [];
        this.graph.lines['fps'].points = [];
        this.graph.resetLimit();
        let framesToRender = this.frames;
        if (framesToRender.length > this.graph.maxPoints) {
            framesToRender = framesToRender.slice(-this.graph.maxPoints);
            this.frames = framesToRender;
        }
        for (let i = 0; i < framesToRender.length; i++) {
            this.graph.addPoint('calls', framesToRender[i].calls.length);
            this.graph.addPoint('fps', framesToRender[i].fps || 0);
        }
        this.graph.update();
        this.playhead.style.display = 'block';
        let targetFrame = 0;
        if (this.selectedFrameIndex !== -1 && this.selectedFrameIndex < this.frames.length) {
            targetFrame = this.selectedFrameIndex;
        }
        else if (this.frames.length > 0) {
            targetFrame = this.frames.length - 1;
        }
        this.selectFrame(targetFrame);
    }
    selectFrame(index) {
        if (index < 0 || index >= this.frames.length)
            return;
        this.selectedFrameIndex = index;
        const frame = this.frames[index];
        this.renderTimelineTrack(frame);
        this.frameInfo.textContent = `Frame: ${frame.id} [${frame.calls.length} calls] [${(frame.fps || 0).toFixed(1)} FPS]`;
        const rect = this.graphSlider.getBoundingClientRect();
        const pointCount = this.graph.lines['calls'].points.length;
        if (pointCount > 0) {
            const pointStep = rect.width / (this.graph.maxPoints - 1);
            let localIndex = index;
            if (this.frames.length > pointCount)
                localIndex = index - (this.frames.length - pointCount);
            const offset = rect.width - ((pointCount - 1) * pointStep);
            let xPos = offset + (localIndex * pointStep);
            xPos = Math.max(1, Math.min(xPos, rect.width - 1));
            this.playhead.style.left = xPos + 'px';
            this.playhead.style.display = 'block';
        }
    }
    renderTimelineTrack(frame) {
        this.timelineTrack.innerHTML = '';
        if (!frame || frame.calls.length === 0)
            return;
        if (!this.collapsedGroups)
            this.collapsedGroups = new Set();
        const frag = document.createDocumentFragment();
        if (this.isHierarchicalView) {
            const groupedCalls = [];
            let currentGroup = null;
            for (const call of frame.calls) {
                const isStructural = call.method.startsWith('begin') || call.method.startsWith('finish');
                if (currentGroup && currentGroup.method === call.method && !isStructural) {
                    currentGroup.count++;
                }
                else {
                    currentGroup = { method: call.method, count: 1 };
                    groupedCalls.push(currentGroup);
                }
            }
            let currentIndent = 0;
            const indentSize = 24;
            const elementStack = [
                { element: frag, isCollapsed: false, id: '' }
            ];
            for (let i = 0; i < groupedCalls.length; i++) {
                const call = groupedCalls[i];
                const block = document.createElement('div');
                block.style.cssText = `padding:4px 8px;margin:2px 0;margin-left:${currentIndent * indentSize}px;border-left:4px solid ${this._getColorForMethod(call.method)};background:rgba(255,255,255,0.03);font-family:monospace;font-size:12px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center`;
                const currentParent = elementStack[elementStack.length - 1];
                if (!currentParent.isCollapsed)
                    frag.appendChild(block);
                if (call.method.startsWith('begin')) {
                    const groupId = currentParent.id + '/' + call.method + '-' + i;
                    const isCollapsed = this.collapsedGroups.has(groupId);
                    const arrow = document.createElement('span');
                    arrow.textContent = isCollapsed ? '[ + ]' : '[ - ]';
                    arrow.style.cssText = 'font-size:10px;margin-right:10px;cursor:pointer;width:26px;display:inline-block;text-align:center';
                    block.appendChild(arrow);
                    block.style.cursor = 'pointer';
                    const title = document.createElement('span');
                    title.textContent = call.method + (call.count > 1 ? ` ( ${call.count} )` : '');
                    block.appendChild(title);
                    block.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (isCollapsed)
                            this.collapsedGroups.delete(groupId);
                        else
                            this.collapsedGroups.add(groupId);
                        this.renderTimelineTrack(this.frames[this.selectedFrameIndex]);
                    });
                    currentIndent++;
                    elementStack.push({ element: block, isCollapsed: currentParent.isCollapsed || isCollapsed, id: groupId });
                }
                else if (call.method.startsWith('finish')) {
                    block.textContent = call.method + (call.count > 1 ? ` ( ${call.count} )` : '');
                    currentIndent = Math.max(0, currentIndent - 1);
                    elementStack.pop();
                }
                else {
                    block.textContent = call.method + (call.count > 1 ? ` ( ${call.count} )` : '');
                }
            }
        }
        else {
            const callCounts = {};
            for (const call of frame.calls) {
                if (call.method.startsWith('finish'))
                    continue;
                callCounts[call.method] = (callCounts[call.method] || 0) + 1;
            }
            const sorted = Object.keys(callCounts)
                .map(method => ({ method, count: callCounts[method] }))
                .sort((a, b) => b.count - a.count);
            for (const call of sorted) {
                const block = document.createElement('div');
                block.style.cssText = `padding:4px 8px;margin:2px 0;border-left:4px solid ${this._getColorForMethod(call.method)};background:rgba(255,255,255,0.03);font-family:monospace;font-size:12px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis`;
                block.textContent = call.method + (call.count > 1 ? ` ( ${call.count} )` : '');
                frag.appendChild(block);
            }
        }
        this.timelineTrack.appendChild(frag);
    }
    _getColorForMethod(method) {
        if (method.startsWith('begin'))
            return 'var(--color-green)';
        if (method.startsWith('finish') || method.startsWith('destroy'))
            return 'var(--color-red)';
        if (method.startsWith('draw') || method.startsWith('drawIndexed') || method.startsWith('drawIndirect') || method.startsWith('drawIndexedIndirect'))
            return 'var(--color-yellow)';
        if (method.startsWith('dispatch'))
            return 'var(--color-yellow)';
        if (method.startsWith('compute') || method.startsWith('create') || method.startsWith('generate'))
            return 'var(--color-yellow)';
        if (method.startsWith('set'))
            return 'var(--color-fps)';
        return 'var(--text-secondary)';
    }
}

class Console extends Tab {
    filters;
    filterText;
    logContainer;
    constructor(options = {}) {
        super('Console', options);
        this.filters = { info: true, warn: true, error: true };
        this.filterText = '';
        this._buildHeader();
        this.logContainer = document.createElement('div');
        this.logContainer.id = 'console-log';
        this.content.appendChild(this.logContainer);
    }
    _buildHeader() {
        const header = document.createElement('div');
        header.className = 'console-header';
        const filterInput = document.createElement('input');
        filterInput.type = 'text';
        filterInput.className = 'console-filter-input';
        filterInput.placeholder = 'Filter...';
        filterInput.addEventListener('input', (e) => {
            this.filterText = e.target.value.toLowerCase();
            this.applyFilters();
        });
        const copyButton = document.createElement('button');
        copyButton.className = 'console-copy-button';
        copyButton.title = 'Copy all';
        copyButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
        copyButton.addEventListener('click', () => this.copyAll(copyButton));
        const buttonsGroup = document.createElement('div');
        buttonsGroup.className = 'console-buttons-group';
        Object.keys(this.filters).forEach(type => {
            const label = document.createElement('label');
            label.className = 'custom-checkbox';
            label.style.color = `var(--${type === 'info' ? 'text-primary' : 'color-' + (type === 'warn' ? 'yellow' : 'red')})`;
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = this.filters[type];
            checkbox.dataset.type = type;
            const checkmark = document.createElement('span');
            checkmark.className = 'checkmark';
            label.appendChild(checkbox);
            label.appendChild(checkmark);
            label.append(type.charAt(0).toUpperCase() + type.slice(1));
            buttonsGroup.appendChild(label);
        });
        buttonsGroup.addEventListener('change', (e) => {
            const target = e.target;
            const type = target.dataset.type;
            if (type in this.filters) {
                this.filters[type] = target.checked;
                this.applyFilters();
            }
        });
        buttonsGroup.appendChild(copyButton);
        header.appendChild(filterInput);
        header.appendChild(buttonsGroup);
        this.content.appendChild(header);
    }
    applyFilters() {
        const messages = this.logContainer.querySelectorAll('.log-message');
        messages.forEach(msg => {
            const type = msg.dataset.type;
            const text = (msg.dataset.rawText ?? '').toLowerCase();
            const showByType = this.filters[type];
            const showByText = text.includes(this.filterText);
            msg.classList.toggle('hidden', !(showByType && showByText));
        });
    }
    copyAll(button) {
        const win = this.logContainer.ownerDocument.defaultView;
        const selection = win?.getSelection();
        const selectedText = selection?.toString() ?? '';
        const textInConsole = selectedText && this.logContainer.contains(selection?.anchorNode ?? null);
        let text;
        if (textInConsole) {
            text = selectedText;
        }
        else {
            const messages = this.logContainer.querySelectorAll('.log-message:not(.hidden)');
            text = Array.from(messages).map(msg => msg.dataset.rawText ?? '').join('\n');
        }
        navigator.clipboard.writeText(text);
        button.classList.add('copied');
        setTimeout(() => button.classList.remove('copied'), 350);
    }
    _getIcon(type, subType) {
        if (subType === 'tip')
            return '\u{1F4AD}';
        if (subType === 'tsl')
            return '\u2728';
        if (subType === 'webgpurenderer')
            return '\u{1F3A8}';
        if (type === 'warn')
            return '\u26A0\uFE0F';
        if (type === 'error')
            return '\u{1F534}';
        return '\u2139\uFE0F';
    }
    _formatMessage(type, text) {
        const fragment = document.createDocumentFragment();
        const prefixMatch = text.match(/^([\w\.]+:\s)/);
        let content = text;
        if (prefixMatch) {
            const fullPrefix = prefixMatch[0];
            const parts = fullPrefix.slice(0, -2).split('.');
            const shortPrefix = (parts.length > 1 ? parts[parts.length - 1] : parts[0]) + ':';
            const icon = this._getIcon(type, shortPrefix.split(':')[0].toLowerCase());
            fragment.appendChild(document.createTextNode(icon + ' '));
            const prefixSpan = document.createElement('span');
            prefixSpan.className = 'log-prefix';
            prefixSpan.textContent = shortPrefix;
            fragment.appendChild(prefixSpan);
            content = text.substring(fullPrefix.length);
        }
        const parts = content.split(/(".*?"|'.*?'|`.*?`)/g).map(p => p.trim()).filter(Boolean);
        parts.forEach((part, index) => {
            if (/^("|'|`)/.test(part)) {
                const codeSpan = document.createElement('span');
                codeSpan.className = 'log-code';
                codeSpan.textContent = part.slice(1, -1);
                fragment.appendChild(codeSpan);
            }
            else {
                let p = part;
                if (index > 0)
                    p = ' ' + p;
                if (index < parts.length - 1)
                    p += ' ';
                fragment.appendChild(document.createTextNode(p));
            }
        });
        return fragment;
    }
    addMessage(type, text) {
        const msg = document.createElement('div');
        msg.className = `log-message ${type}`;
        msg.dataset.type = type;
        msg.dataset.rawText = text;
        msg.appendChild(this._formatMessage(type, text));
        const showByType = this.filters[type] ?? true;
        const showByText = text.toLowerCase().includes(this.filterText);
        msg.classList.toggle('hidden', !(showByType && showByText));
        this.logContainer.appendChild(msg);
        this.logContainer.scrollTop = this.logContainer.scrollHeight;
        if (this.logContainer.children.length > 200) {
            this.logContainer.removeChild(this.logContainer.firstChild);
        }
    }
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------
function loadState() {
    try {
        const data = JSON.parse(localStorage.getItem('gpucat-inspector') || '{}');
        const settings = data.settings || {};
        return { showFPS: settings.showFPS ?? true };
    }
    catch {
        return { showFPS: true };
    }
}
function saveState(state) {
    try {
        const data = JSON.parse(localStorage.getItem('gpucat-inspector') || '{}');
        data.settings = state;
        localStorage.setItem('gpucat-inspector', JSON.stringify(data));
    }
    catch (e) {
        console.error('Failed to save settings:', e);
    }
}
// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------
class Settings extends Parameters {
    constructor() {
        super({ name: 'Settings' });
        const state = loadState();
        const generalGroup = this.createGroup('General');
        generalGroup.add(state, 'showFPS').onChange(() => {
            saveState(state);
        });
    }
}

class Material {
    /** Material name, for debugging. */
    name;
    /** vec4f clip-space position. */
    vertexNode;
    /** Fragment output. Can be vec4f, OutputStructNode for MRT, or null for depth-only. */
    fragmentNode;
    /** f32 depth override — written to @builtin(frag_depth) */
    depthNode;
    /** Controls draw sort order (opaque vs transparent) AND the default for depthWrite. */
    transparent;
    /** Optional blend state. Only meaningful when transparent=true or custom blending. */
    blend;
    /** Whether depth testing is active. When false, depthCompare is forced to 'always'. */
    depthTest;
    /** Whether to write to the depth buffer. Default: true for opaque, false for transparent. */
    depthWrite;
    /** Depth comparison function. Default 'less'. Forced to 'always' when depthTest=false. */
    depthCompare;
    /** Back-face culling mode. Default 'back'. */
    cullMode;
    /** Alpha-to-coverage. Meaningful only when renderer.samples > 1. Default false. */
    alphaToCoverage;
    /** Constant depth bias in depth buffer precision steps. Default 0. */
    depthBias;
    /** Depth bias scaled by the fragment's slope (dz/dx, dz/dy). Default 0. */
    depthBiasSlopeScale;
    /** Maximum absolute depth bias value. Default 0 (no clamp). */
    depthBiasClamp;
    /**
     * Named uniforms for this material.
     * Used for name-based uniform resolution: uniform('roughness', d.f32) resolves
     * to material.uniforms.get('roughness') at render time.
     */
    uniforms = new Map();
    constructor(opts) {
        this.name = opts.name ?? '';
        this.vertexNode = opts.vertex;
        this.fragmentNode = opts.fragment ?? null;
        this.depthNode = opts.depth;
        this.transparent = opts.transparent ?? false;
        this.blend = opts.blend;
        this.depthTest = opts.depthTest ?? true;
        this.depthWrite = opts.depthWrite ?? !this.transparent;
        this.depthCompare = opts.depthCompare ?? 'less';
        this.cullMode = opts.cullMode ?? 'back';
        this.alphaToCoverage = opts.alphaToCoverage ?? false;
        this.depthBias = opts.depthBias ?? 0;
        this.depthBiasSlopeScale = opts.depthBiasSlopeScale ?? 0;
        this.depthBiasClamp = opts.depthBiasClamp ?? 0;
    }
    /**
     * Incremented whenever the material's node graph configuration changes in a
     * way that requires a shader recompile.  The renderer includes this in the
     * RenderObject cache key so that bumping it triggers recompilation on the
     * next frame.
     */
    version = 0;
    /**
     * Setting needsUpdate = true increments version, which causes the renderer
     * to recompile the material's shader on the next frame.
     */
    set needsUpdate(value) {
        if (value === true)
            this.version++;
    }
    /**
     * Set to true after dispose() is called.
     * The renderer checks this flag to skip rendering and clean up GPU resources.
     */
    disposed = false;
    /**
     * Internal callback set by the renderer to clean up GPU resources (e.g., pipelines).
     * @internal
     */
    _onDispose = null;
    /**
     * Frees GPU-related resources allocated for this material.
     * Call this method when the material is no longer used.
     * Mirrors Three.js Material.dispose().
     */
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this._onDispose?.();
    }
}

/**
 * viewer.ts — Inspector Viewer tab.
 *
 * Three.js aligned: mirrors examples/jsm/inspector/tabs/Viewer.js
 *
 * Pattern:
 *   getCanvasDataByNode() — creates a CanvasTarget + wraps the node as vec4(vec3(node), 1)
 *                           + builds a Material. Cached per node, never recreated.
 *   update()              — for each canvasData:
 *                             1. save renderer state (renderTarget, mrt, clearColor)
 *                             2. reset state (setMRT(null), clearColor black)
 *                             3. setCanvasTarget(canvasData.canvasTarget)
 *                             4. renderer.renderQuad(canvasData.material, encoder)
 *                             5. renderer.setCanvasTarget(previousTarget)
 *                             6. restoreRendererState(savedState)
 *
 * renderQuad() is used instead of renderer.render(wrappedNode) to avoid
 * triggering updateBefore() on PassNodes, which would cause a stack overflow
 * by recursively rendering the scene inside the inspector viewer.
 *
 * Three.js equivalent: canvasData.quad.render(renderer) — QuadMesh.render()
 * calls renderer.render(scene, camera) directly without updateBefore.
 */
// ---------------------------------------------------------------------------
// Viewer Tab
// ---------------------------------------------------------------------------
class Viewer extends Tab {
    nodeList;
    nodes;
    /** Cached item DOM rows, keyed by canvasData.id */
    _itemLibrary = new Map();
    /** Cached folder items, keyed by path name. Three.js aligned: folderLibrary */
    _folderLibrary = new Map();
    /** Current list of canvasData shown in the viewer */
    _currentDataList = [];
    constructor(options = {}) {
        super('Viewer', options);
        const nodeList = new List('Viewer', 'Name');
        nodeList.setGridStyle('150px minmax(200px, 2fr)');
        nodeList.domElement.style.minWidth = '400px';
        const scrollWrapper = document.createElement('div');
        scrollWrapper.className = 'list-scroll-wrapper';
        scrollWrapper.appendChild(nodeList.domElement);
        this.content.appendChild(scrollWrapper);
        const nodes = new Item('Nodes');
        nodeList.add(nodes);
        this.nodeList = nodeList;
        this.nodes = nodes;
    }
    // -----------------------------------------------------------------------
    // Public API — called by Inspector each frame
    // -----------------------------------------------------------------------
    /**
     * Get or create a folder item for the given path name.
     * Three.js aligned: mirrors Viewer.getFolder().
     */
    getFolder(name) {
        let folder = this._folderLibrary.get(name);
        if (folder === undefined) {
            folder = new Item(name);
            this._folderLibrary.set(name, folder);
            this.nodeList.add(folder);
        }
        return folder;
    }
    /**
     * Update the viewer: render every inspectable node into its preview canvas.
     * Three.js aligned: mirrors Viewer.update(renderer, canvasDataList).
     *
     * For each canvasData:
     *   1. Save renderer state (renderTarget, mrt, clearColor)
     *   2. Reset state — setMRT(null), clearColor → black
     *   3. renderer.setCanvasTarget(canvasData.canvasTarget)
     *   4. renderer.renderQuad(canvasData.material, encoder)  ← no updateBefore!
     *   5. renderer.setCanvasTarget(previousTarget)
     *   6. Restore renderer state
     *
     * Using renderQuad() instead of render(node) is the critical difference:
     * render(node) calls updateBefore() which triggers PassNode.updateBefore()
     * causing a stack overflow. renderQuad() skips updateBefore entirely,
     * mirroring how Three.js uses QuadMesh.render() → renderer.render(scene, camera).
     */
    update(inspector, canvasDataList) {
        if (!this.isActive && !this.isDetached)
            return;
        const renderer = inspector.getRenderer();
        if (!renderer)
            return;
        // --- Remove items for nodes no longer in the list ---
        // Three.js aligned: remove old items + clean up empty folders
        const previousDataList = [...this._currentDataList];
        for (const canvasData of previousDataList) {
            if (this._itemLibrary.has(canvasData.id) && canvasDataList.indexOf(canvasData) === -1) {
                const item = this._itemLibrary.get(canvasData.id);
                const parent = item.parent;
                if (parent) {
                    parent.remove(item);
                    // Three.js aligned: remove empty folder from nodeList
                    if (canvasData.path && this._folderLibrary.has(canvasData.path)) {
                        const folder = this._folderLibrary.get(canvasData.path);
                        if (folder.children?.length === 0) {
                            if (folder.parent)
                                folder.parent.remove(folder);
                            this._folderLibrary.delete(canvasData.path);
                        }
                    }
                }
                this._itemLibrary.delete(canvasData.id);
            }
        }
        this._currentDataList = canvasDataList;
        // --- Add / render each node ---
        // Three.js aligned: indexes tracks insertion order within each folder
        const indexes = {};
        for (const canvasData of canvasDataList) {
            const item = this._addNodeItem(canvasData);
            const path = canvasData.path;
            if (path) {
                const folder = this.getFolder(path);
                if (indexes[path] === undefined) {
                    indexes[path] = 0;
                }
                if (!item.parent || item.parent !== folder) {
                    folder.add(item);
                }
                indexes[path]++;
            }
            else {
                if (!item.parent) {
                    this.nodes.add(item);
                }
            }
            // Save renderer state — mirrors RendererUtils.resetRendererState()
            const savedState = renderer.saveRendererState();
            // Reset to clean defaults for the preview render
            renderer.mrt = null;
            renderer.renderTarget = null;
            renderer.clearColor = [0, 0, 0, 1];
            // Swap to preview canvas target
            const previousTarget = renderer.getCanvasTarget();
            renderer.setCanvasTarget(canvasData.canvasTarget);
            // Render the preview quad
            canvasData.quadMesh.render(renderer);
            // Restore canvas target and renderer state
            renderer.setCanvasTarget(previousTarget);
            renderer.restoreRendererState(savedState);
        }
    }
    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------
    _addNodeItem(canvasData) {
        let item = this._itemLibrary.get(canvasData.id);
        if (!item) {
            const domElement = canvasData.canvasTarget.domElement;
            item = new Item(domElement, canvasData.name);
            item.itemRow.children[1].style.justifyContent = 'flex-start';
            this._itemLibrary.set(canvasData.id, item);
        }
        return item;
    }
}
// ---------------------------------------------------------------------------
// Module-level helpers — used by Inspector.getCanvasDataByNode()
// ---------------------------------------------------------------------------
/**
 * Split a camelCase / PascalCase name into space-separated words.
 *
 * Examples:
 *   'tonemappedOutput'  → 'Tonemapped Output'
 *   'NormalsViewSpace'  → 'Normals View Space'
 */
function splitCamelCase(str) {
    return str
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/^./, s => s.toUpperCase());
}
/**
 * Split a name containing '/' into { path, name } components.
 *
 * The last segment is `name`; everything before is `path` (or undefined if
 * there is no '/' in the string).
 *
 * Examples:
 *   'MRT/Output'  → { path: 'MRT', name: 'Output' }
 *   'Normals'     → { path: undefined, name: 'Normals' }
 */
function splitPath(str) {
    const idx = str.lastIndexOf('/');
    if (idx === -1)
        return { path: undefined, name: str };
    return { path: str.slice(0, idx), name: str.slice(idx + 1) };
}
/**
 * Convert any node to a vec4f suitable for fullscreen preview display.
 */
function nodeToVec4f(node) {
    const t = node.type.wgslType;
    // ---- scalars ----
    if (t === 'f32') {
        return wgsl(vec4f$1) `vec4f(${node}, ${node}, ${node}, 1.0)`;
    }
    if (t === 'i32' || t === 'u32' || t === 'bool') {
        return wgsl(vec4f$1) `vec4f(f32(${node}), f32(${node}), f32(${node}), 1.0)`;
    }
    // ---- vec2 ----
    if (t === 'vec2f') {
        return wgsl(vec4f$1) `vec4f((${node}).x, (${node}).y, 0.0, 1.0)`;
    }
    if (t === 'vec2i' || t === 'vec2u') {
        return wgsl(vec4f$1) `vec4f(f32((${node}).x), f32((${node}).y), 0.0, 1.0)`;
    }
    // ---- vec3 ----
    if (t === 'vec3f') {
        return wgsl(vec4f$1) `vec4f((${node}).xyz, 1.0)`;
    }
    if (t === 'vec3i' || t === 'vec3u') {
        return wgsl(vec4f$1) `vec4f(f32((${node}).x), f32((${node}).y), f32((${node}).z), 1.0)`;
    }
    // ---- vec4 ----
    if (t === 'vec4f') {
        return wgsl(vec4f$1) `vec4f((${node}).xyz, 1.0)`;
    }
    if (t === 'vec4i' || t === 'vec4u') {
        return wgsl(vec4f$1) `vec4f(f32((${node}).x), f32((${node}).y), f32((${node}).z), 1.0)`;
    }
    // ---- matrices — show first column as RGB ----
    if (t.startsWith('mat')) {
        return wgsl(vec4f$1) `vec4f(f32((${node})[0][0]), f32((${node})[0][1]), f32((${node})[0][2]), 1.0)`;
    }
    // ---- texture / sampler / unknown — assume textureSample gives vec4f ----
    return wgsl(vec4f$1) `vec4f((${node}).xyz, 1.0)`;
}
/**
 * Create a fullscreen preview material for the given node.
 * Uses QuadMesh geometry (position attribute) and converts the node to vec4f.
 */
function createPreviewMaterial(node) {
    const posAttr = attribute('position', vec3f$1);
    const posNode = vec4f(posAttr, f32(1));
    const fragNode = nodeToVec4f(node);
    return new Material({
        vertex: posNode,
        fragment: fragNode,
        depthWrite: false,
        depthTest: false,
    });
}

const EPSILON = 0.000001;

/**
 * Creates a new, empty vec2
 *
 * @returns a new 2D vector
 */
function create$8() {
    return [0, 0];
}

/**
 * Creates a new, empty vec3
 *
 * @returns a new 3D vector
 */
function create$7() {
    return [0, 0, 0];
}
/**
 * Creates a new vec3 initialized with values from an existing vector
 *
 * @param a vector to clone
 * @returns a new 3D vector
 */
function clone$2(a) {
    const out = [0, 0, 0];
    out[0] = a[0];
    out[1] = a[1];
    out[2] = a[2];
    return out;
}
/**
 * Calculates the length of a vec3
 *
 * @param a vector to calculate length of
 * @returns length of a
 */
function length(a) {
    const x = a[0];
    const y = a[1];
    const z = a[2];
    return Math.sqrt(x * x + y * y + z * z);
}
/**
 * Creates a new vec3 initialized with the given values
 *
 * @param x X component
 * @param y Y component
 * @param z Z component
 * @returns a new 3D vector
 */
function fromValues(x, y, z) {
    const out = [0, 0, 0];
    out[0] = x;
    out[1] = y;
    out[2] = z;
    return out;
}
/**
 * Copy the values from one vec3 to another
 *
 * @param out the receiving vector
 * @param a the source vector
 * @returns out
 */
function copy$5(out, a) {
    out[0] = a[0];
    out[1] = a[1];
    out[2] = a[2];
    return out;
}
/**
 * Set the components of a vec3 to the given values
 *
 * @param out the receiving vector
 * @param x X component
 * @param y Y component
 * @param z Z component
 * @returns out
 */
function set$2(out, x, y, z) {
    out[0] = x;
    out[1] = y;
    out[2] = z;
    return out;
}
/**
 * Sets the components of a vec3 from a buffer
 * @param out the receiving vector
 * @param buffer the source buffer
 * @param startIndex the starting index in the buffer
 * @returns out
 */
function fromBuffer(out, buffer, startIndex) {
    out[0] = buffer[startIndex];
    out[1] = buffer[startIndex + 1];
    out[2] = buffer[startIndex + 2];
    return out;
}
/**
 * Adds two vec3's
 *
 * @param out the receiving vector
 * @param a the first operand
 * @param b the second operand
 * @returns out
 */
function add(out, a, b) {
    out[0] = a[0] + b[0];
    out[1] = a[1] + b[1];
    out[2] = a[2] + b[2];
    return out;
}
/**
 * Subtracts vector b from vector a
 *
 * @param out the receiving vector
 * @param a the first operand
 * @param b the second operand
 * @returns out
 */
function subtract(out, a, b) {
    out[0] = a[0] - b[0];
    out[1] = a[1] - b[1];
    out[2] = a[2] - b[2];
    return out;
}
/**
 * Scales a vec3 by a scalar number
 *
 * @param out the receiving vector
 * @param a the vector to scale
 * @param b amount to scale the vector by
 * @returns out
 */
function scale(out, a, b) {
    out[0] = a[0] * b;
    out[1] = a[1] * b;
    out[2] = a[2] * b;
    return out;
}
/**
 * Adds two vec3's after scaling the second operand by a scalar value
 *
 * @param out the receiving vector
 * @param a the first operand
 * @param b the second operand
 * @param scale the amount to scale b by before adding
 * @returns out
 */
function scaleAndAdd(out, a, b, scale) {
    out[0] = a[0] + b[0] * scale;
    out[1] = a[1] + b[1] * scale;
    out[2] = a[2] + b[2] * scale;
    return out;
}
/**
 * Calculates the euclidian distance between two vec3's
 *
 * @param a the first operand
 * @param b the second operand
 * @returns distance between a and b
 */
function distance(a, b) {
    const x = b[0] - a[0];
    const y = b[1] - a[1];
    const z = b[2] - a[2];
    return Math.sqrt(x * x + y * y + z * z);
}
/**
 * Calculates the squared euclidian distance between two vec3's
 *
 * @param a the first operand
 * @param b the second operand
 * @returns squared distance between a and b
 */
function squaredDistance(a, b) {
    const x = b[0] - a[0];
    const y = b[1] - a[1];
    const z = b[2] - a[2];
    return x * x + y * y + z * z;
}
/**
 * Negates the components of a vec3
 *
 * @param out the receiving vector
 * @param a vector to negate
 * @returns out
 */
function negate(out, a) {
    out[0] = -a[0];
    out[1] = -a[1];
    out[2] = -a[2];
    return out;
}
/**
 * Normalize a vec3
 *
 * @param out the receiving vector
 * @param a vector to normalize
 * @returns out
 */
function normalize$3(out, a) {
    const x = a[0];
    const y = a[1];
    const z = a[2];
    let len = x * x + y * y + z * z;
    if (len > 0) {
        //TODO: evaluate use of glm_invsqrt here?
        len = 1 / Math.sqrt(len);
    }
    out[0] = a[0] * len;
    out[1] = a[1] * len;
    out[2] = a[2] * len;
    return out;
}
/**
 * Calculates the dot product of two vec3's
 *
 * @param a the first operand
 * @param b the second operand
 * @returns dot product of a and b
 */
function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
/**
 * Computes the cross product of two vec3's
 *
 * @param out the receiving vector
 * @param a the first operand
 * @param b the second operand
 * @returns out
 */
function cross(out, a, b) {
    const ax = a[0];
    const ay = a[1];
    const az = a[2];
    const bx = b[0];
    const by = b[1];
    const bz = b[2];
    out[0] = ay * bz - az * by;
    out[1] = az * bx - ax * bz;
    out[2] = ax * by - ay * bx;
    return out;
}
/**
 * Transforms the vec3 with a mat4.
 * 4th vector component is implicitly '1'
 *
 * @param out the receiving vector
 * @param a the vector to transform
 * @param m matrix to transform with
 * @returns out
 */
function transformMat4$1(out, a, m) {
    const x = a[0];
    const y = a[1];
    const z = a[2];
    let w = m[3] * x + m[7] * y + m[11] * z + m[15];
    w = w || 1.0;
    out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
    return out;
}
/**
 * Transforms the vec3 with a quat
 * Can also be used for dual quaternions. (Multiply it with the real part)
 *
 * @param out the receiving vector
 * @param a the vector to transform
 * @param q quaternion to transform with
 * @returns out
 */
function transformQuat(out, a, q) {
    // benchmarks: https://jsperf.com/quaternion-transform-vec3-implementations-fixed
    const qx = q[0];
    const qy = q[1];
    const qz = q[2];
    const qw = q[3];
    const x = a[0];
    const y = a[1];
    const z = a[2];
    // var qvec = [qx, qy, qz];
    // var uv = vec3.cross([], qvec, a);
    let uvx = qy * z - qz * y;
    let uvy = qz * x - qx * z;
    let uvz = qx * y - qy * x;
    // var uuv = vec3.cross([], qvec, uv);
    let uuvx = qy * uvz - qz * uvy;
    let uuvy = qz * uvx - qx * uvz;
    let uuvz = qx * uvy - qy * uvx;
    // vec3.scale(uv, uv, 2 * w);
    const w2 = qw * 2;
    uvx *= w2;
    uvy *= w2;
    uvz *= w2;
    // vec3.scale(uuv, uuv, 2);
    uuvx *= 2;
    uuvy *= 2;
    uuvz *= 2;
    // return vec3.add(out, a, vec3.add(out, uv, uuv));
    out[0] = x + uvx + uuvx;
    out[1] = y + uvy + uuvy;
    out[2] = z + uvz + uuvz;
    return out;
}

/**
 * Copy the values from one vec4 to another
 *
 * @param out the receiving vector
 * @param a the source vector
 * @returns out
 */
function copy$4(out, a) {
    out[0] = a[0];
    out[1] = a[1];
    out[2] = a[2];
    out[3] = a[3];
    return out;
}
/**
 * Normalize a vec4
 *
 * @param out the receiving vector
 * @param a vector to normalize
 * @returns out
 */
function normalize$2(out, a) {
    const x = a[0];
    const y = a[1];
    const z = a[2];
    const w = a[3];
    let len = x * x + y * y + z * z + w * w;
    if (len > 0) {
        len = 1 / Math.sqrt(len);
    }
    out[0] = x * len;
    out[1] = y * len;
    out[2] = z * len;
    out[3] = w * len;
    return out;
}

/**
 * Creates a new identity mat4
 *
 * @returns a new 4x4 matrix
 */
function create$6() {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
/**
 * Copy the values from one mat4 to another
 *
 * @param out the receiving matrix
 * @param a the source matrix
 * @returns out
 */
function copy$3(out, a) {
    out[0] = a[0];
    out[1] = a[1];
    out[2] = a[2];
    out[3] = a[3];
    out[4] = a[4];
    out[5] = a[5];
    out[6] = a[6];
    out[7] = a[7];
    out[8] = a[8];
    out[9] = a[9];
    out[10] = a[10];
    out[11] = a[11];
    out[12] = a[12];
    out[13] = a[13];
    out[14] = a[14];
    out[15] = a[15];
    return out;
}
/**
 * Set a mat4 to the identity matrix
 *
 * @param out the receiving matrix
 * @returns out
 */
function identity(out) {
    out[0] = 1;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
    out[5] = 1;
    out[6] = 0;
    out[7] = 0;
    out[8] = 0;
    out[9] = 0;
    out[10] = 1;
    out[11] = 0;
    out[12] = 0;
    out[13] = 0;
    out[14] = 0;
    out[15] = 1;
    return out;
}
/**
 * Inverts a mat4
 *
 * @param out the receiving matrix
 * @param a the source matrix
 * @returns out, or null if source matrix is not invertible
 */
function invert(out, a) {
    const a00 = a[0];
    const a01 = a[1];
    const a02 = a[2];
    const a03 = a[3];
    const a10 = a[4];
    const a11 = a[5];
    const a12 = a[6];
    const a13 = a[7];
    const a20 = a[8];
    const a21 = a[9];
    const a22 = a[10];
    const a23 = a[11];
    const a30 = a[12];
    const a31 = a[13];
    const a32 = a[14];
    const a33 = a[15];
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;
    // Calculate the determinant
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) {
        return null;
    }
    det = 1.0 / det;
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return out;
}
/**
 * Multiplies two mat4s
 *
 * @param out the receiving matrix
 * @param a the first operand
 * @param b the second operand
 * @returns out
 */
function multiply(out, a, b) {
    const a00 = a[0];
    const a01 = a[1];
    const a02 = a[2];
    const a03 = a[3];
    const a10 = a[4];
    const a11 = a[5];
    const a12 = a[6];
    const a13 = a[7];
    const a20 = a[8];
    const a21 = a[9];
    const a22 = a[10];
    const a23 = a[11];
    const a30 = a[12];
    const a31 = a[13];
    const a32 = a[14];
    const a33 = a[15];
    // Cache only the current line of the second matrix
    let b0 = b[0];
    let b1 = b[1];
    let b2 = b[2];
    let b3 = b[3];
    out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    b0 = b[4];
    b1 = b[5];
    b2 = b[6];
    b3 = b[7];
    out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    b0 = b[8];
    b1 = b[9];
    b2 = b[10];
    b3 = b[11];
    out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    b0 = b[12];
    b1 = b[13];
    b2 = b[14];
    b3 = b[15];
    out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    return out;
}
/**
 * Creates a matrix from a quaternion rotation, vector translation and vector scale
 * This is equivalent to (but much faster than):
 *
 *     mat4.identity(dest);
 *     mat4.translate(dest, dest, vec);
 *     let quatMat = mat4.create();
 *     mat4.fromQuat(quatMat, quat);
 *     mat4.multiply(dest, dest, quatMat);
 *     mat4.scale(dest, dest, scale)
 *
 * @param out mat4 receiving operation result
 * @param q Rotation quaternion
 * @param v Translation vector
 * @param s Scaling vector
 * @returns out
 */
function fromRotationTranslationScale(out, q, v, s) {
    // Quaternion math
    const x = q[0];
    const y = q[1];
    const z = q[2];
    const w = q[3];
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const xy = x * y2;
    const xz = x * z2;
    const yy = y * y2;
    const yz = y * z2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;
    const sx = s[0];
    const sy = s[1];
    const sz = s[2];
    out[0] = (1 - (yy + zz)) * sx;
    out[1] = (xy + wz) * sx;
    out[2] = (xz - wy) * sx;
    out[3] = 0;
    out[4] = (xy - wz) * sy;
    out[5] = (1 - (xx + zz)) * sy;
    out[6] = (yz + wx) * sy;
    out[7] = 0;
    out[8] = (xz + wy) * sz;
    out[9] = (yz - wx) * sz;
    out[10] = (1 - (xx + yy)) * sz;
    out[11] = 0;
    out[12] = v[0];
    out[13] = v[1];
    out[14] = v[2];
    out[15] = 1;
    return out;
}
/**
 * Generates a perspective projection matrix suitable for WebGPU with the given bounds.
 * The near/far clip planes correspond to a normalized device coordinate Z range of [0, 1],
 * which matches WebGPU/Vulkan/DirectX/Metal's clip volume.
 * Passing null/undefined/no value for far will generate infinite projection matrix.
 *
 * @param out mat4 frustum matrix will be written into
 * @param fovy Vertical field of view in radians
 * @param aspect Aspect ratio. typically viewport width/height
 * @param near Near bound of the frustum
 * @param far Far bound of the frustum, can be null or Infinity
 * @returns out
 */
function perspectiveZO(out, fovy, aspect, near, far) {
    const f = 1.0 / Math.tan(fovy / 2);
    out[0] = f / aspect;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
    out[5] = f;
    out[6] = 0;
    out[7] = 0;
    out[8] = 0;
    out[9] = 0;
    out[11] = -1;
    out[12] = 0;
    out[13] = 0;
    out[15] = 0;
    if (far != null && far !== Number.POSITIVE_INFINITY) {
        const nf = 1 / (near - far);
        out[10] = far * nf;
        out[14] = far * near * nf;
    }
    else {
        out[10] = -1;
        out[14] = -near;
    }
    return out;
}
/**
 * Generates a orthogonal projection matrix with the given bounds.
 * The near/far clip planes correspond to a normalized device coordinate Z range of [0, 1],
 * which matches WebGPU/Vulkan/DirectX/Metal's clip volume.
 *
 * @param out mat4 frustum matrix will be written into
 * @param left Left bound of the frustum
 * @param right Right bound of the frustum
 * @param bottom Bottom bound of the frustum
 * @param top Top bound of the frustum
 * @param near Near bound of the frustum
 * @param far Far bound of the frustum
 * @returns out
 */
function orthoZO(out, left, right, bottom, top, near, far) {
    const lr = 1 / (left - right);
    const bt = 1 / (bottom - top);
    const nf = 1 / (near - far);
    out[0] = -2 * lr;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
    out[5] = -2 * bt;
    out[6] = 0;
    out[7] = 0;
    out[8] = 0;
    out[9] = 0;
    out[10] = nf;
    out[11] = 0;
    out[12] = (left + right) * lr;
    out[13] = (top + bottom) * bt;
    out[14] = near * nf;
    out[15] = 1;
    return out;
}
/**
 * Generates a matrix that makes something look at something else.
 *
 * @param out mat4 frustum matrix will be written into
 * @param eye Position of the viewer
 * @param target Point the viewer is looking at
 * @param up vec3 pointing up
 * @returns out
 */
function targetTo(out, eye, target, up) {
    const eyex = eye[0];
    const eyey = eye[1];
    const eyez = eye[2];
    const upx = up[0];
    const upy = up[1];
    const upz = up[2];
    let z0 = eyex - target[0];
    let z1 = eyey - target[1];
    let z2 = eyez - target[2];
    let len = z0 * z0 + z1 * z1 + z2 * z2;
    if (len > 0) {
        len = 1 / Math.sqrt(len);
        z0 *= len;
        z1 *= len;
        z2 *= len;
    }
    let x0 = upy * z2 - upz * z1;
    let x1 = upz * z0 - upx * z2;
    let x2 = upx * z1 - upy * z0;
    len = x0 * x0 + x1 * x1 + x2 * x2;
    if (len > 0) {
        len = 1 / Math.sqrt(len);
        x0 *= len;
        x1 *= len;
        x2 *= len;
    }
    out[0] = x0;
    out[1] = x1;
    out[2] = x2;
    out[3] = 0;
    out[4] = z1 * x2 - z2 * x1;
    out[5] = z2 * x0 - z0 * x2;
    out[6] = z0 * x1 - z1 * x0;
    out[7] = 0;
    out[8] = z0;
    out[9] = z1;
    out[10] = z2;
    out[11] = 0;
    out[12] = eyex;
    out[13] = eyey;
    out[14] = eyez;
    out[15] = 1;
    return out;
}

/**
 * Creates a new identity mat3
 *
 * @returns a new 3x3 matrix
 */
function create$5() {
    return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}
/**
 * Copies the upper-left 3x3 values into the given mat3.
 *
 * @param out the receiving 3x3 matrix
 * @param a   the source 4x4 matrix
 * @returns out
 */
function fromMat4$1(out, a) {
    out[0] = a[0];
    out[1] = a[1];
    out[2] = a[2];
    out[3] = a[4];
    out[4] = a[5];
    out[5] = a[6];
    out[6] = a[8];
    out[7] = a[9];
    out[8] = a[10];
    return out;
}
/**
 * Calculates a 3x3 normal matrix (transpose inverse) from the 4x4 matrix
 *
 * @param out mat3 receiving operation result
 * @param a Mat4 to derive the normal matrix from
 *
 * @returns out
 */
function normalFromMat4(out, a) {
    const a00 = a[0];
    const a01 = a[1];
    const a02 = a[2];
    const a03 = a[3];
    const a10 = a[4];
    const a11 = a[5];
    const a12 = a[6];
    const a13 = a[7];
    const a20 = a[8];
    const a21 = a[9];
    const a22 = a[10];
    const a23 = a[11];
    const a30 = a[12];
    const a31 = a[13];
    const a32 = a[14];
    const a33 = a[15];
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;
    // Calculate the determinant
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) {
        return null;
    }
    det = 1.0 / det;
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[2] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[3] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[4] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[5] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[6] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[7] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[8] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    return out;
}

/**
 * Creates a new identity quat
 *
 * @returns a new quaternion
 */
function create$4() {
    return [0, 0, 0, 1];
}
/**
 * Sets a quat from the given angle and rotation axis,
 * then returns it.
 *
 * @param out the receiving quaternion
 * @param axis the axis around which to rotate
 * @param rad the angle in radians
 * @returns out
 **/
function setAxisAngle(out, axis, rad) {
    rad *= 0.5;
    const s = Math.sin(rad);
    out[0] = s * axis[0];
    out[1] = s * axis[1];
    out[2] = s * axis[2];
    out[3] = Math.cos(rad);
    return out;
}
/**
 * Calculates the conjugate of a quat
 * If the quaternion is normalized, this function is faster than quat.inverse and produces the same result.
 *
 * @param out the receiving quaternion
 * @param a quat to calculate conjugate of
 * @returns out
 */
function conjugate(out, a) {
    out[0] = -a[0];
    out[1] = -a[1];
    out[2] = -a[2];
    out[3] = a[3];
    return out;
}
/**
 * Creates a quaternion from the given 3x3 rotation matrix.
 *
 * NOTE: The resultant quaternion is not normalized, so you should be sure
 * to renormalize the quaternion yourself where necessary.
 *
 * @param out the receiving quaternion
 * @param m rotation matrix
 * @returns out
 */
function fromMat3(out, m) {
    // Algorithm in Ken Shoemake's article in 1987 SIGGRAPH course notes
    // article "Quaternion Calculus and Fast Animation".
    const fTrace = m[0] + m[4] + m[8];
    let fRoot;
    if (fTrace > 0.0) {
        // |w| > 1/2, may as well choose w > 1/2
        fRoot = Math.sqrt(fTrace + 1.0); // 2w
        out[3] = 0.5 * fRoot;
        fRoot = 0.5 / fRoot; // 1/(4w)
        out[0] = (m[5] - m[7]) * fRoot;
        out[1] = (m[6] - m[2]) * fRoot;
        out[2] = (m[1] - m[3]) * fRoot;
    }
    else {
        // |w| <= 1/2
        let i = 0;
        if (m[4] > m[0])
            i = 1;
        if (m[8] > m[i * 3 + i])
            i = 2;
        const j = (i + 1) % 3;
        const k = (i + 2) % 3;
        fRoot = Math.sqrt(m[i * 3 + i] - m[j * 3 + j] - m[k * 3 + k] + 1.0);
        out[i] = 0.5 * fRoot;
        fRoot = 0.5 / fRoot;
        out[3] = (m[j * 3 + k] - m[k * 3 + j]) * fRoot;
        out[j] = (m[j * 3 + i] + m[i * 3 + j]) * fRoot;
        out[k] = (m[k * 3 + i] + m[i * 3 + k]) * fRoot;
    }
    return out;
}
/**
 * Calculates a quaternion from a 4x4 rotation matrix
 * Extracts the 3x3 rotation part and calls fromMat3
 *
 * @param out the receiving quaternion
 * @param m rotation matrix
 * @returns out
 */
function fromMat4(out, m) {
    const m3 = create$5();
    fromMat4$1(m3, m);
    return fromMat3(out, m3);
}
/**
 * Copy the values from one quat to another
 *
 * @param out the receiving quaternion
 * @param a the source quaternion
 * @returns out
 */
const copy$2 = copy$4;
/**
 * Normalize a quat
 *
 * @param out the receiving quaternion
 * @param a quaternion to normalize
 * @returns out
 */
const normalize$1 = normalize$2;
/**
 * Sets a quaternion to represent the shortest rotation from one
 * vector to another.
 *
 * Both vectors are assumed to be unit length.
 *
 * @param out the receiving quaternion.
 * @param a the initial vector
 * @param b the destination vector
 * @returns out
 */
const rotationTo = /* @__PURE__ */ (() => {
    const tmpvec3 = create$7();
    const xUnitVec3 = fromValues(1, 0, 0);
    const yUnitVec3 = fromValues(0, 1, 0);
    return (out, a, b) => {
        const dot$1 = dot(a, b);
        if (dot$1 < -0.999999) {
            cross(tmpvec3, xUnitVec3, a);
            if (length(tmpvec3) < 0.000001)
                cross(tmpvec3, yUnitVec3, a);
            normalize$3(tmpvec3, tmpvec3);
            setAxisAngle(out, tmpvec3, Math.PI);
            return out;
        }
        if (dot$1 > 0.999999) {
            out[0] = 0;
            out[1] = 0;
            out[2] = 0;
            out[3] = 1;
            return out;
        }
        cross(tmpvec3, a, b);
        out[0] = tmpvec3[0];
        out[1] = tmpvec3[1];
        out[2] = tmpvec3[2];
        out[3] = 1 + dot$1;
        return normalize$1(out, out);
    };
})();

const _transformMat4_corner = /*@__PURE__*/ create$7();
/**
 * Transform a bounding box by a 4x4 matrix
 * Transforms all 8 corners and creates a new AABB that encompasses them
 * @param out - The output Box3
 * @param box - The input Box3
 * @param mat - The 4x4 transformation matrix
 * @returns The transformed Box3
 */
function transformMat4(out, box, mat) {
    out[0] = Number.POSITIVE_INFINITY;
    out[1] = Number.POSITIVE_INFINITY;
    out[2] = Number.POSITIVE_INFINITY;
    out[3] = Number.NEGATIVE_INFINITY;
    out[4] = Number.NEGATIVE_INFINITY;
    out[5] = Number.NEGATIVE_INFINITY;
    // transform all 8 corners of the box and expand the output AABB
    for (let i = 0; i < 8; i++) {
        _transformMat4_corner[0] = (i & 1) === 0 ? box[0] : box[3];
        _transformMat4_corner[1] = (i & 2) === 0 ? box[1] : box[4];
        _transformMat4_corner[2] = (i & 4) === 0 ? box[2] : box[5];
        transformMat4$1(_transformMat4_corner, _transformMat4_corner, mat);
        if (_transformMat4_corner[0] < out[0])
            out[0] = _transformMat4_corner[0];
        if (_transformMat4_corner[0] > out[3])
            out[3] = _transformMat4_corner[0];
        if (_transformMat4_corner[1] < out[1])
            out[1] = _transformMat4_corner[1];
        if (_transformMat4_corner[1] > out[4])
            out[4] = _transformMat4_corner[1];
        if (_transformMat4_corner[2] < out[2])
            out[2] = _transformMat4_corner[2];
        if (_transformMat4_corner[2] > out[5])
            out[5] = _transformMat4_corner[2];
    }
    return out;
}
new Array(27); // 9 axes * 3 components

/**
 * Creates a new plane with normal (0, 1, 0) and constant 0
 * @returns A new plane
 */
function create$3() {
    return { normal: [0, 1, 0], constant: 0 };
}
/**
 * Clones a plane
 * @param plane - The plane to clone
 * @returns A new plane
 */
function clone$1(plane) {
    return {
        normal: clone$2(plane.normal),
        constant: plane.constant,
    };
}
/**
 * Copies one plane to another
 * @param out - The output plane
 * @param plane - The source plane
 * @returns The output plane
 */
function copy$1(out, plane) {
    copy$5(out.normal, plane.normal);
    out.constant = plane.constant;
    return out;
}
/**
 * Normalizes a plane (ensures the normal vector is unit length)
 * @param out - The output plane
 * @param plane - The input plane
 * @returns The normalized plane
 */
function normalize(out, plane) {
    const invMagnitude = 1.0 / length(plane.normal);
    scale(out.normal, plane.normal, invMagnitude);
    out.constant = plane.constant * invMagnitude;
    return out;
}
/**
 * Calculates the signed distance from a point to the plane
 * @param plane - The plane
 * @param point - The point
 * @returns The signed distance (positive = in direction of normal)
 */
function distanceToPoint(plane, point) {
    return dot(plane.normal, point) + plane.constant;
}

/**
 * Creates a new spherical coordinate at r=1, theta=0, phi=0
 *
 * @returns a new Spherical
 */
function create$2() {
    return [1, 0, 0];
}
/**
 * Sets the components of a Spherical
 *
 * @param out the receiving Spherical
 * @param r radial distance
 * @param theta azimuthal angle in the XZ plane from +Z (radians)
 * @param phi polar angle from +Y axis (radians)
 * @returns out
 */
function set$1(out, r, theta, phi) {
    out[0] = r;
    out[1] = theta;
    out[2] = phi;
    return out;
}
/**
 * Sets a Spherical from Cartesian Vec3 coordinates (Three.js / OpenGL convention):
 *   r     = sqrt(x² + y² + z²)
 *   theta = atan2(x, z)   (azimuthal angle in XZ plane from +Z)
 *   phi   = acos(y / r)   (polar angle from +Y)
 *
 * @param out the receiving Spherical
 * @param v the source Vec3
 * @returns out
 */
function setFromVec3(out, v) {
    const x = v[0];
    const y = v[1];
    const z = v[2];
    const r = Math.sqrt(x * x + y * y + z * z);
    out[0] = r;
    out[1] = r === 0 ? 0 : Math.atan2(x, z);
    out[2] = r === 0 ? 0 : Math.acos(Math.max(-1, Math.min(1, y / r)));
    return out;
}
/**
 * Clamps phi to the range [EPSILON, π - EPSILON] to avoid coordinate
 * singularities at the poles (gimbal lock / division by zero).
 * r and theta are left unchanged.
 *
 * @param out the receiving Spherical
 * @param a the source Spherical
 * @returns out
 */
function makeSafe(out, a) {
    const EPS = EPSILON;
    out[0] = a[0];
    out[1] = a[1];
    out[2] = Math.max(EPS, Math.min(Math.PI - EPS, a[2]));
    return out;
}
/**
 * Converts spherical coordinates to a Cartesian Vec3 (Three.js / OpenGL convention):
 *   x = r * sin(phi) * sin(theta)
 *   y = r * cos(phi)
 *   z = r * sin(phi) * cos(theta)
 *
 * @param out the receiving Vec3
 * @param a the source Spherical
 * @returns out
 */
function toVec3(out, a) {
    const r = a[0];
    const theta = a[1];
    const phi = a[2];
    const sinPhi = Math.sin(phi);
    out[0] = r * sinPhi * Math.sin(theta);
    out[1] = r * Math.cos(phi);
    out[2] = r * sinPhi * Math.cos(theta);
    return out;
}

/**
 * Creates a new Raycast3 with default values (origin at (0,0,0), direction (0,0,0), length 1.
 * @returns A new Raycast3.
 */
function create$1() {
    return {
        origin: create$7(),
        direction: fromValues(0, 0, 0),
        length: 1,
    };
}
/**
 * Sets the components of a Raycast3.
 * @param out The output Raycast3.
 * @param origin The origin Vec3.
 * @param direction The direction Vec3.
 * @param length The length of the ray.
 * @returns The output Raycast3.
 */
function set(out, origin, direction, length) {
    copy$5(out.origin, origin);
    copy$5(out.direction, direction);
    out.length = length;
    return out;
}
/**
 * Creates a new IntersectsTriangleResult with default values.
 * @returns A new IntersectsTriangleResult.
 */
function createIntersectsTriangleResult() {
    return {
        fraction: 0,
        hit: false,
        frontFacing: false,
    };
}
/**
 * Ray-triangle intersection test.
 * Based on https://github.com/pmjoniak/GeometricTools/blob/master/GTEngine/Include/Mathematics/GteIntrRay3Triangle3.h
 *
 * @param out output object to store result (hit boolean, fraction, frontFacing)
 * @param ray ray to test (with origin, direction, and length)
 * @param a first vertex of triangle
 * @param b second vertex of triangle
 * @param c third vertex of triangle
 * @param backfaceCulling if true, backfaces will not be considered hits
 */
function intersectsTriangle(out, ray, a, b, c, backfaceCulling) {
    // compute edge1 = b - a
    const e1x = b[0] - a[0];
    const e1y = b[1] - a[1];
    const e1z = b[2] - a[2];
    // compute edge2 = c - a
    const e2x = c[0] - a[0];
    const e2y = c[1] - a[1];
    const e2z = c[2] - a[2];
    // compute normal = edge1 × edge2
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    // determine front vs back facing
    const dx = ray.direction[0];
    const dy = ray.direction[1];
    const dz = ray.direction[2];
    let DdN = dx * nx + dy * ny + dz * nz;
    let sign;
    if (DdN > 0) {
        sign = 1;
    }
    else if (DdN < 0) {
        // frontface
        sign = -1;
        DdN = -DdN;
    }
    else {
        // ray is parallel to triangle
        out.hit = false;
        out.fraction = 0;
        out.frontFacing = false;
        return;
    }
    // compute diff = ray.origin - a
    const diffx = ray.origin[0] - a[0];
    const diffy = ray.origin[1] - a[1];
    const diffz = ray.origin[2] - a[2];
    // compute barycentric coordinate b1
    // DdQxE2 = sign * D · (diff × edge2)
    const diffCrossE2x = diffy * e2z - diffz * e2y;
    const diffCrossE2y = diffz * e2x - diffx * e2z;
    const diffCrossE2z = diffx * e2y - diffy * e2x;
    const DdQxE2 = sign * (dx * diffCrossE2x + dy * diffCrossE2y + dz * diffCrossE2z);
    if (DdQxE2 < 0) {
        out.hit = false;
        out.fraction = 0;
        out.frontFacing = false;
        return;
    }
    // compute barycentric coordinate b2
    // DdE1xQ = sign * D · (edge1 × diff)
    const e1CrossDiffx = e1y * diffz - e1z * diffy;
    const e1CrossDiffy = e1z * diffx - e1x * diffz;
    const e1CrossDiffz = e1x * diffy - e1y * diffx;
    const DdE1xQ = sign * (dx * e1CrossDiffx + dy * e1CrossDiffy + dz * e1CrossDiffz);
    if (DdE1xQ < 0) {
        out.hit = false;
        out.fraction = 0;
        out.frontFacing = false;
        return;
    }
    // check if b1 + b2 > 1
    if (DdQxE2 + DdE1xQ > DdN) {
        out.hit = false;
        out.fraction = 0;
        out.frontFacing = false;
        return;
    }
    // compute intersection distance
    const QdN = -sign * (diffx * nx + diffy * ny + diffz * nz);
    if (QdN < 0) {
        out.hit = false;
        out.fraction = 0;
        out.frontFacing = false;
        return;
    }
    const t = QdN / DdN;
    // check if intersection is within ray length
    if (t <= ray.length) {
        out.hit = true;
        out.fraction = t / ray.length;
        out.frontFacing = sign < 0;
    }
    else {
        out.hit = false;
        out.fraction = 0;
        out.frontFacing = false;
    }
}
/**
 * Test if a ray intersects an axis-aligned bounding box.
 * Uses slab-based algorithm that handles parallel rays correctly.
 *
 * @param ray Ray to test (with origin, direction, and length)
 * @param aabb AABB to test against
 * @returns true if ray intersects the AABB, false otherwise
 */
function intersectsBox3$1(ray, aabb) {
    let tmin = 0;
    let tmax = ray.length;
    for (let i = 0; i < 3; i++) {
        const d = ray.direction[i];
        if (Math.abs(d) < 1e-10) {
            // ray is parallel to slab: check if origin is within slab
            if (ray.origin[i] < aabb[i] || ray.origin[i] > aabb[i + 3]) {
                return false;
            }
        }
        else {
            // compute intersection times with slab
            const invD = 1 / d;
            let t0 = (aabb[i] - ray.origin[i]) * invD;
            let t1 = (aabb[i + 3] - ray.origin[i]) * invD;
            if (invD < 0) {
                const temp = t0;
                t0 = t1;
                t1 = temp;
            }
            tmin = Math.max(tmin, t0);
            tmax = Math.min(tmax, t1);
            if (tmax < tmin) {
                return false;
            }
        }
    }
    return true;
}

let objectIdCounter = 0;
const _lookAt_tmp = create$6();
class Object3D {
    objectId = objectIdCounter++;
    name = '';
    visible = true;
    renderOrder = 0;
    position = [0, 0, 0];
    quaternion = [0, 0, 0, 1];
    scale = [1, 1, 1];
    parent = null;
    children = [];
    matrix = create$6();
    matrixWorld = create$6();
    normalMatrix = create$5();
    matrixVersion = 0;
    add(child) {
        if (child.parent)
            child.parent.remove(child);
        child.parent = this;
        this.children.push(child);
        return this;
    }
    remove(child) {
        const idx = this.children.indexOf(child);
        if (idx !== -1) {
            this.children.splice(idx, 1);
            child.parent = null;
        }
        return this;
    }
    removeFromParent() {
        const parent = this.parent;
        if (parent !== null) {
            parent.remove(this);
        }
        return this;
    }
    lookAt(target, up = [0, 1, 0]) {
        targetTo(_lookAt_tmp, this.position, target, up);
        fromMat4(this.quaternion, _lookAt_tmp);
    }
    updateWorldMatrix() {
        fromRotationTranslationScale(this.matrix, this.quaternion, this.position, this.scale);
        if (this.parent) {
            multiply(this.matrixWorld, this.parent.matrixWorld, this.matrix);
        }
        else {
            copy$3(this.matrixWorld, this.matrix);
        }
        normalFromMat4(this.normalMatrix, this.matrixWorld);
        this.matrixVersion++;
        for (const child of this.children) {
            child.updateWorldMatrix();
        }
    }
    /**
     * Abstract method for raycasting. Override in subclasses (e.g., Mesh) to
     * implement intersection testing. Base implementation does nothing.
     *
     * @param _raycaster - The Raycaster instance
     * @param _intersects - Array to push intersection results into
     */
    raycast(_raycaster, _intersects) {
        // Base Object3D does nothing - subclasses override
    }
}

const _invViewProj = create$6();
class Camera extends Object3D {
    near = 0.1;
    far = 100;
    projectionMatrix = create$6();
    matrixWorldInverse = create$6();
    constructor() {
        super();
        this.name = 'Camera';
    }
    /** recompute the matrixWorldInverse from the current matrixWorld. */
    updateViewMatrix() {
        if (invert(this.matrixWorldInverse, this.matrixWorld) === null) {
            identity(this.matrixWorldInverse);
        }
    }
}
/**
 * Unproject a point from NDC (normalized device coordinates) to world space.
 * NDC: x,y in [-1, 1], z in [0, 1] where 0 is near plane, 1 is far plane (WebGPU convention).
 */
function unproject(out, ndc, camera) {
    multiply(_invViewProj, camera.projectionMatrix, camera.matrixWorldInverse);
    invert(_invViewProj, _invViewProj);
    transformMat4$1(out, ndc, _invViewProj);
    return out;
}

// Reusable temp objects
const _target = [0, 0, 0];
const _direction = [0, 0, 0];
class Raycaster {
    ray;
    near;
    far;
    constructor(origin, direction, near = 0, far = Infinity) {
        this.ray = create$1();
        if (origin)
            copy$5(this.ray.origin, origin);
        if (direction)
            copy$5(this.ray.direction, direction);
        this.ray.length = far;
        this.near = near;
        this.far = far;
    }
    set(origin, direction) {
        copy$5(this.ray.origin, origin);
        copy$5(this.ray.direction, direction);
    }
    setFromCamera(coords, camera) {
        const isOrthographic = 'isOrthographicCamera' in camera && camera.isOrthographicCamera;
        if (isOrthographic) {
            // Orthographic: origin on near plane, direction is camera's forward
            unproject(this.ray.origin, [coords[0], coords[1], 0], camera);
            // Get camera forward direction from matrixWorld
            const e = camera.matrixWorld;
            set$2(_direction, -e[8], -e[9], -e[10]);
            normalize$3(this.ray.direction, _direction);
        }
        else {
            // Perspective: origin at camera position, direction toward unprojected point
            copy$5(this.ray.origin, camera.position);
            // Unproject a point on the far plane and compute direction
            unproject(_target, [coords[0], coords[1], 1], camera);
            subtract(_direction, _target, this.ray.origin);
            normalize$3(this.ray.direction, _direction);
        }
        this.ray.length = this.far;
    }
    intersectObject(object, recursive = true, intersects = []) {
        intersect(object, this, intersects, recursive);
        intersects.sort(ascSort);
        return intersects;
    }
    intersectObjects(objects, recursive = true, intersects = []) {
        for (const object of objects) {
            intersect(object, this, intersects, recursive);
        }
        intersects.sort(ascSort);
        return intersects;
    }
}
function ascSort(a, b) {
    return a.distance - b.distance;
}
function intersect(object, raycaster, intersects, recursive) {
    if (object.visible === false)
        return;
    object.raycast(raycaster, intersects);
    if (recursive) {
        for (const child of object.children) {
            intersect(child, raycaster, intersects, true);
        }
    }
}
// ============================================================================
// Helpers for Mesh.raycast() - exported for use by Mesh
// ============================================================================
const _inverseMatrix = create$6();
const _localRay = create$1();
const _localOrigin = [0, 0, 0];
const _localDir = [0, 0, 0];
const _intersectionResult = createIntersectsTriangleResult();
const _intersectionPoint = [0, 0, 0];
const _intersectionPointWorld = [0, 0, 0];
const _vA = [0, 0, 0];
const _vB = [0, 0, 0];
const _vC = [0, 0, 0];
const _edge1 = [0, 0, 0];
const _edge2 = [0, 0, 0];
const _faceNormal = [0, 0, 0];
/**
 * Transform a ray into the local space of an object.
 * Returns the local ray for intersection testing.
 */
function transformRayToLocalSpace(raycaster, matrixWorld) {
    invert(_inverseMatrix, matrixWorld);
    // Transform origin (point)
    transformMat4$1(_localOrigin, raycaster.ray.origin, _inverseMatrix);
    // Transform direction (vector, not point) - use mat3 of inverse matrix
    // For direction vectors we need to transform by the inverse-transpose,
    // but for orthonormal transforms (no non-uniform scale), inverse works.
    // We extract upper 3x3 and transform.
    const m = _inverseMatrix;
    const dx = raycaster.ray.direction[0];
    const dy = raycaster.ray.direction[1];
    const dz = raycaster.ray.direction[2];
    _localDir[0] = m[0] * dx + m[4] * dy + m[8] * dz;
    _localDir[1] = m[1] * dx + m[5] * dy + m[9] * dz;
    _localDir[2] = m[2] * dx + m[6] * dy + m[10] * dz;
    normalize$3(_localDir, _localDir);
    set(_localRay, _localOrigin, _localDir, raycaster.far);
    return _localRay;
}
/**
 * Test ray-triangle intersection and add to intersects if hit.
 * Positions are in local space, ray should be in local space.
 */
function checkTriangleIntersection(object, raycaster, localRay, matrixWorld, a, b, c, positions, indices, uvs, intersects, faceIndex) {
    // Get vertex positions
    const ia = indices ? indices[a] : a;
    const ib = indices ? indices[b] : b;
    const ic = indices ? indices[c] : c;
    fromBuffer(_vA, positions, ia * 3);
    fromBuffer(_vB, positions, ib * 3);
    fromBuffer(_vC, positions, ic * 3);
    // Test intersection (double-sided, no backface culling)
    intersectsTriangle(_intersectionResult, localRay, _vA, _vB, _vC);
    if (!_intersectionResult.hit)
        return;
    // Compute intersection point in local space
    const t = _intersectionResult.fraction;
    scaleAndAdd(_intersectionPoint, localRay.origin, localRay.direction, t * localRay.length);
    // Transform to world space
    transformMat4$1(_intersectionPointWorld, _intersectionPoint, matrixWorld);
    // Check distance against near/far
    const distance$1 = distance(raycaster.ray.origin, _intersectionPointWorld);
    if (distance$1 < raycaster.near || distance$1 > raycaster.far)
        return;
    // Compute face normal
    subtract(_edge1, _vB, _vA);
    subtract(_edge2, _vC, _vA);
    cross(_faceNormal, _edge1, _edge2);
    normalize$3(_faceNormal, _faceNormal);
    // Build intersection result
    const intersection = {
        distance: distance$1,
        point: clone$2(_intersectionPointWorld),
        object,
        faceIndex,
        face: {
            a: ia,
            b: ib,
            c: ic,
            normal: clone$2(_faceNormal),
        },
    };
    // Compute UV if available (barycentric interpolation)
    if (uvs) {
        const uv = computeBarycentricUV(_intersectionPoint, _vA, _vB, _vC, ia, ib, ic, uvs);
        if (uv)
            intersection.uv = uv;
    }
    intersects.push(intersection);
}
/**
 * Compute UV coordinates at intersection point using barycentric interpolation.
 */
function computeBarycentricUV(point, vA, vB, vC, ia, ib, ic, uvs) {
    // Compute barycentric coordinates
    const v0 = [0, 0, 0];
    const v1 = [0, 0, 0];
    const v2 = [0, 0, 0];
    subtract(v0, vC, vA);
    subtract(v1, vB, vA);
    subtract(v2, point, vA);
    const dot00 = dot(v0, v0);
    const dot01 = dot(v0, v1);
    const dot02 = dot(v0, v2);
    const dot11 = dot(v1, v1);
    const dot12 = dot(v1, v2);
    const denom = dot00 * dot11 - dot01 * dot01;
    if (Math.abs(denom) < 1e-10)
        return null;
    const invDenom = 1 / denom;
    const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
    const v = (dot00 * dot12 - dot01 * dot02) * invDenom;
    const w = 1 - u - v;
    // Interpolate UVs
    const uvA_u = uvs[ia * 2];
    const uvA_v = uvs[ia * 2 + 1];
    const uvB_u = uvs[ib * 2];
    const uvB_v = uvs[ib * 2 + 1];
    const uvC_u = uvs[ic * 2];
    const uvC_v = uvs[ic * 2 + 1];
    return [
        w * uvA_u + v * uvB_u + u * uvC_u,
        w * uvA_v + v * uvB_v + u * uvC_v,
    ];
}

const _worldSphereCenter = [0, 0, 0];
class Mesh extends Object3D {
    geometry;
    material;
    count = 1;
    frustumCulled = true;
    constructor(geometry, material) {
        super();
        this.geometry = geometry;
        this.material = material;
    }
    raycast(raycaster, intersects) {
        const geometry = this.geometry;
        const matrixWorld = this.matrixWorld;
        // get position buffer - required for raycasting
        const positionBuffer = geometry.getBuffer('position');
        if (!positionBuffer?.array)
            return;
        const positions = positionBuffer.array;
        // early-out: bounding sphere test in world space
        if (geometry.boundingSphere) {
            const sphere = geometry.boundingSphere;
            // transform sphere center to world space
            transformMat4$1(_worldSphereCenter, sphere.center, matrixWorld);
            // get world scale to transform radius (approximate for non-uniform scale)
            const sx = Math.hypot(matrixWorld[0], matrixWorld[1], matrixWorld[2]);
            const sy = Math.hypot(matrixWorld[4], matrixWorld[5], matrixWorld[6]);
            const sz = Math.hypot(matrixWorld[8], matrixWorld[9], matrixWorld[10]);
            const worldRadius = sphere.radius * Math.max(sx, sy, sz);
            // quick sphere-ray distance test
            const rayToCenter = [0, 0, 0];
            subtract(rayToCenter, _worldSphereCenter, raycaster.ray.origin);
            const tca = dot(rayToCenter, raycaster.ray.direction);
            const d2 = dot(rayToCenter, rayToCenter) - tca * tca;
            if (d2 > worldRadius * worldRadius)
                return;
        }
        // transform ray to local space
        const localRay = transformRayToLocalSpace(raycaster, matrixWorld);
        // early-out: bounding box test in local space
        if (geometry.boundingBox) {
            if (!intersectsBox3$1(localRay, geometry.boundingBox))
                return;
        }
        // get optional index buffer and UV buffer
        const indexBuffer = geometry.index;
        const indices = indexBuffer?.array ?? null;
        const uvBuffer = geometry.getBuffer('uv');
        const uvs = uvBuffer?.array ?? null;
        // triangle intersection tests
        if (indices) {
            // indexed geometry
            const count = Math.min(indices.length, geometry.drawRange.start + (geometry.drawRange.count === Infinity ? indices.length : geometry.drawRange.count));
            for (let i = geometry.drawRange.start; i < count; i += 3) {
                checkTriangleIntersection(this, raycaster, localRay, matrixWorld, i, i + 1, i + 2, positions, indices, uvs, intersects, Math.floor(i / 3));
            }
        }
        else {
            // non-indexed geometry
            const vertexCount = positions.length / 3;
            const count = Math.min(vertexCount, geometry.drawRange.start + (geometry.drawRange.count === Infinity ? vertexCount : geometry.drawRange.count));
            for (let i = geometry.drawRange.start; i < count; i += 3) {
                checkTriangleIntersection(this, raycaster, localRay, matrixWorld, i, i + 1, i + 2, positions, null, uvs, intersects, Math.floor(i / 3));
            }
        }
    }
}

class Geometry {
    /** Buffers mapped by name. Can be vertex attributes, storage buffers, or any buffer type. @see setBuffer() @see removeBuffer() */
    buffers = new Map();
    /** Optional index buffer. Must have 'index' usage. @see setIndex(). */
    index = undefined;
    /**
     * Range of vertices/indices to draw.
     * `start` maps to `firstVertex` (non-indexed) or `firstIndex` (indexed).
     * `count` is the number of vertices/indices. Defaults to `Infinity` (full buffer).
     */
    drawRange = { start: 0, count: Infinity };
    /** Geometry ersion counter. Auto-incremented when buffers are added/removed */
    version = 0;
    /**
     * Optional indirect draw buffer. When set, the renderer calls
     * drawIndirect / drawIndexedIndirect using this buffer instead of
     * draw / drawIndexed. `mesh.count` is ignored when this is set.
     * Must have 'indirect' usage.
     * @see setIndirect
     */
    indirect = undefined;
    /**
     * Byte offset into the indirect buffer where draw parameters begin.
     * Useful when non-indirect data precedes the DrawIndirect/DrawIndexedIndirect structs.
     * Defaults to 0.
     */
    indirectOffset = 0;
    /**
     * Axis-aligned bounding box in local space.
     * Set by createBoxGeometry / createSphereGeometry / createPlaneGeometry.
     * You may set this manually for custom geometry to enable frustum culling.
     */
    boundingBox = undefined;
    /**
     * Bounding sphere in local space.
     * Set by createBoxGeometry / createSphereGeometry / createPlaneGeometry.
     * You may set this manually for custom geometry to enable frustum culling.
     */
    boundingSphere = undefined;
    /**
     * Set to true after dispose() is called.
     * The renderer checks this flag to skip rendering and clean up GPU resources.
     */
    disposed = false;
    /**
     * Internal callback set by the renderer to clean up GPU resources.
     * @internal
     */
    _onDispose = null;
    /**
     * Get a named buffer with optional type narrowing.
     */
    getBuffer(name) {
        return this.buffers.get(name);
    }
    /**
     * Set a named buffer.
     * Works for vertex attributes, storage buffers, or any buffer type.
     * Automatically bumps version when a new buffer name is added.
     * For REF_COUNTED buffers, increments usage count.
     *
     * @example Vertex attribute
     * geometry.setBuffer('position', new GpuBuffer(d.vec3f, { data: positions, usage: 'vertex' }));
     *
     * @example Storage buffer
     * geometry.setBuffer('particles', new GpuBuffer(d.array(Particle), { data: new Float32Array(1000 * stride), usage: 'storage' }));
     */
    setBuffer(name, buffer) {
        const existing = this.buffers.get(name);
        if (existing && existing !== buffer) {
            existing.decreaseUsages();
        }
        const isNew = !existing;
        this.buffers.set(name, buffer);
        if (existing !== buffer) {
            buffer.increaseUsages();
        }
        if (isNew) {
            this.version++;
        }
        return this;
    }
    /**
     * Remove a buffer by name.
     * Automatically bumps version when a buffer is removed.
     * For REF_COUNTED buffers, decrements usage count.
     */
    removeBuffer(name) {
        const buffer = this.buffers.get(name);
        if (buffer) {
            buffer.decreaseUsages();
            this.buffers.delete(name);
            this.version++;
        }
        return this;
    }
    /**
     * Set the indirect draw buffer.
     * For REF_COUNTED buffers, manages usage count properly.
     * @param buffer The indirect buffer, or undefined to clear.
     * @param offset Byte offset into the buffer where draw parameters begin.
     */
    setIndirect(buffer, offset = 0) {
        const existing = this.indirect;
        if (existing && existing !== buffer) {
            existing.decreaseUsages();
        }
        this.indirect = buffer;
        this.indirectOffset = offset;
        if (buffer && existing !== buffer) {
            buffer.increaseUsages();
        }
        return this;
    }
    /**
     * Set the index buffer.
     * For REF_COUNTED buffers, manages usage count properly.
     * @param buffer The index buffer, or undefined to clear. Must have 'index' usage.
     */
    setIndex(buffer) {
        const existing = this.index;
        if (existing && existing !== buffer) {
            existing.decreaseUsages();
        }
        this.index = buffer;
        if (buffer && existing !== buffer) {
            buffer.increaseUsages();
        }
        return this;
    }
    /**
     * Frees GPU-related resources allocated for this geometry.
     * For REF_COUNTED buffers, decrements usage count (may trigger buffer disposal).
     * Call this method when the geometry is no longer used.
     */
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        for (const buffer of this.buffers.values()) {
            buffer.decreaseUsages();
        }
        this.index?.decreaseUsages();
        this.indirect?.decreaseUsages();
        this._onDispose?.();
    }
}

const BOX_VERTEX_COUNT = 24; // 6 faces * 4 vertices
const BOX_INDEX_COUNT = 36; // 6 faces * 6 indices
function writeFace(positions, normals, uvs, indices, faceIndex, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz) {
    const base = faceIndex * 4;
    const pi = base * 3;
    const ui = base * 2;
    const ii = faceIndex * 6;
    positions[pi] = ax;
    positions[pi + 1] = ay;
    positions[pi + 2] = az;
    positions[pi + 3] = bx;
    positions[pi + 4] = by;
    positions[pi + 5] = bz;
    positions[pi + 6] = cx;
    positions[pi + 7] = cy;
    positions[pi + 8] = cz;
    positions[pi + 9] = dx;
    positions[pi + 10] = dy;
    positions[pi + 11] = dz;
    normals[pi] = nx;
    normals[pi + 1] = ny;
    normals[pi + 2] = nz;
    normals[pi + 3] = nx;
    normals[pi + 4] = ny;
    normals[pi + 5] = nz;
    normals[pi + 6] = nx;
    normals[pi + 7] = ny;
    normals[pi + 8] = nz;
    normals[pi + 9] = nx;
    normals[pi + 10] = ny;
    normals[pi + 11] = nz;
    uvs[ui] = 0;
    uvs[ui + 1] = 0;
    uvs[ui + 2] = 1;
    uvs[ui + 3] = 0;
    uvs[ui + 4] = 1;
    uvs[ui + 5] = 1;
    uvs[ui + 6] = 0;
    uvs[ui + 7] = 1;
    indices[ii] = base;
    indices[ii + 1] = base + 1;
    indices[ii + 2] = base + 2;
    indices[ii + 3] = base;
    indices[ii + 4] = base + 2;
    indices[ii + 5] = base + 3;
}
function createBoxGeometry(width = 1, height = 1, depth = 1) {
    const hw = width / 2;
    const hh = height / 2;
    const hd = depth / 2;
    const positions = new Float32Array(BOX_VERTEX_COUNT * 3);
    const normals = new Float32Array(BOX_VERTEX_COUNT * 3);
    const uvs = new Float32Array(BOX_VERTEX_COUNT * 2);
    const indices = new Uint16Array(BOX_INDEX_COUNT);
    // +X
    writeFace(positions, normals, uvs, indices, 0, hw, -hh, -hd, hw, hh, -hd, hw, hh, hd, hw, -hh, hd, 1, 0, 0);
    // -X
    writeFace(positions, normals, uvs, indices, 1, -hw, -hh, hd, -hw, hh, hd, -hw, hh, -hd, -hw, -hh, -hd, -1, 0, 0);
    // +Y
    writeFace(positions, normals, uvs, indices, 2, -hw, hh, -hd, -hw, hh, hd, hw, hh, hd, hw, hh, -hd, 0, 1, 0);
    // -Y
    writeFace(positions, normals, uvs, indices, 3, -hw, -hh, hd, -hw, -hh, -hd, hw, -hh, -hd, hw, -hh, hd, 0, -1, 0);
    // +Z
    writeFace(positions, normals, uvs, indices, 4, -hw, -hh, hd, hw, -hh, hd, hw, hh, hd, -hw, hh, hd, 0, 0, 1);
    // -Z
    writeFace(positions, normals, uvs, indices, 5, hw, -hh, -hd, -hw, -hh, -hd, -hw, hh, -hd, hw, hh, -hd, 0, 0, -1);
    const geom = new Geometry();
    geom.setBuffer('position', createVertexBuffer(vec3f$1, positions));
    geom.setBuffer('normal', createVertexBuffer(vec3f$1, normals));
    geom.setBuffer('uv', createVertexBuffer(vec2f$1, uvs));
    geom.index = createIndexBuffer(indices);
    geom.boundingBox = [-hw, -hh, -hd, hw, hh, hd];
    geom.boundingSphere = { center: [0, 0, 0], radius: Math.sqrt(hw * hw + hh * hh + hd * hd) };
    return geom;
}
function createSphereGeometry(radius = 0.5, widthSegments = 16, heightSegments = 8) {
    const cols = widthSegments + 1;
    const rows = heightSegments + 1;
    const vertexCount = cols * rows;
    const indexCount = widthSegments * heightSegments * 6;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const indices = new Uint16Array(indexCount);
    let vi = 0;
    for (let iy = 0; iy < rows; iy++) {
        const v = iy / heightSegments;
        const phi = v * Math.PI;
        const sinPhi = Math.sin(phi);
        const cosPhi = Math.cos(phi);
        for (let ix = 0; ix < cols; ix++) {
            const u = ix / widthSegments;
            const theta = u * Math.PI * 2;
            const nx = Math.cos(theta) * sinPhi;
            const ny = cosPhi;
            const nz = Math.sin(theta) * sinPhi;
            const pi = vi * 3;
            const ui = vi * 2;
            positions[pi] = nx * radius;
            positions[pi + 1] = ny * radius;
            positions[pi + 2] = nz * radius;
            normals[pi] = nx;
            normals[pi + 1] = ny;
            normals[pi + 2] = nz;
            uvs[ui] = u;
            uvs[ui + 1] = v;
            vi++;
        }
    }
    let ii = 0;
    for (let iy = 0; iy < heightSegments; iy++) {
        for (let ix = 0; ix < widthSegments; ix++) {
            const a = iy * cols + ix;
            const b = a + cols;
            // CCW winding when viewed from outside the sphere
            indices[ii] = a;
            indices[ii + 1] = a + 1;
            indices[ii + 2] = b;
            indices[ii + 3] = b;
            indices[ii + 4] = a + 1;
            indices[ii + 5] = b + 1;
            ii += 6;
        }
    }
    const geom = new Geometry();
    geom.setBuffer('position', createVertexBuffer(vec3f$1, positions));
    geom.setBuffer('normal', createVertexBuffer(vec3f$1, normals));
    geom.setBuffer('uv', createVertexBuffer(vec2f$1, uvs));
    geom.index = createIndexBuffer(indices);
    geom.boundingBox = [-radius, -radius, -radius, radius, radius, radius];
    geom.boundingSphere = { center: [0, 0, 0], radius };
    return geom;
}
/**
 * Creates a plane geometry in the XY plane (facing +Z).
 *
 * Vertices span [-width/2, width/2] in X and [-height/2, height/2] in Y, at z=0.
 * Normals point +Z. Triangles wound CCW when viewed from +Z.
 * Matches three.js PlaneGeometry orientation.
 *
 * @param width - Total width along X. Defaults to 1.
 * @param height - Total height along Y. Defaults to 1.
 * @param widthSegments - Subdivisions along X. Defaults to 1.
 * @param heightSegments - Subdivisions along Y. Defaults to 1.
 */
function createPlaneGeometry(width = 1, height = 1, widthSegments = 1, heightSegments = 1) {
    const hw = width / 2;
    const hh = height / 2;
    const cols = widthSegments + 1;
    const rows = heightSegments + 1;
    const vertexCount = cols * rows;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    // generate vertices top-to-bottom (iy=0 is top), left-to-right
    // y is negated so iy=0 → +hh (top), iy=max → -hh (bottom)
    for (let iy = 0; iy < rows; iy++) {
        const v = iy / heightSegments;
        const y = hh - v * height; // top to bottom
        for (let ix = 0; ix < cols; ix++) {
            const u = ix / widthSegments;
            const x = -hw + u * width;
            const idx = iy * cols + ix;
            positions[idx * 3 + 0] = x;
            positions[idx * 3 + 1] = y;
            positions[idx * 3 + 2] = 0;
            normals[idx * 3 + 0] = 0;
            normals[idx * 3 + 1] = 0;
            normals[idx * 3 + 2] = 1;
            uvs[idx * 2 + 0] = u;
            uvs[idx * 2 + 1] = v;
        }
    }
    // two triangles per quad, wound CCW when viewed from +Z
    const indexCount = widthSegments * heightSegments * 6;
    const indices = vertexCount <= 65536 ? new Uint16Array(indexCount) : new Uint32Array(indexCount);
    let i = 0;
    for (let iy = 0; iy < heightSegments; iy++) {
        for (let ix = 0; ix < widthSegments; ix++) {
            const a = iy * cols + ix; // top-left
            const b = a + cols; // bottom-left
            const c = b + 1; // bottom-right
            const d = a + 1; // top-right
            // CCW from +Z: a → b → d, then b → c → d
            indices[i++] = a;
            indices[i++] = b;
            indices[i++] = d;
            indices[i++] = b;
            indices[i++] = c;
            indices[i++] = d;
        }
    }
    const geom = new Geometry();
    geom.setBuffer('position', createVertexBuffer(vec3f$1, positions));
    geom.setBuffer('normal', createVertexBuffer(vec3f$1, normals));
    geom.setBuffer('uv', createVertexBuffer(vec2f$1, uvs));
    geom.index = createIndexBuffer(indices);
    geom.boundingBox = [-hw, -hh, 0, hw, hh, 0];
    geom.boundingSphere = {
        center: [0, 0, 0],
        radius: Math.sqrt(hw * hw + hh * hh),
    };
    return geom;
}
/**
 * Creates a fullscreen triangle geometry for post-processing passes.
 *
 * Uses an oversized triangle technique for efficiency (3 vertices instead of 6).
 * The triangle covers clip space from (-1,-1) to (3,-1) to (-1,3), ensuring
 * full viewport coverage after clipping.
 *
 * UV coordinates follow WebGPU conventions:
 *   - (0, 0) at top-left of texture
 *   - (1, 1) at bottom-right of texture
 *
 * Since clip space Y=-1 is bottom and Y=+1 is top, but texture V=0 is top and V=1 is bottom,
 * we map: bottom-left clip (-1,-1) → UV (0,1), top-left clip (-1,3) → UV (0,-1).
 *
 * @param flipY - Whether to flip UV coordinates along the vertical axis. Defaults to false.
 */
function createFullscreenTriangleGeometry(flipY = false) {
    // Oversized triangle positions in clip space
    // vi=0 → (-1, -1)   vi=1 → (3, -1)   vi=2 → (-1, 3)
    const positions = new Float32Array([
        -1,
        -1,
        0, // bottom-left clip
        3,
        -1,
        0, // bottom-right clip (oversized)
        -1,
        3,
        0, // top-left clip (oversized)
    ]);
    // UV coordinates: map clip space to texture space
    // Clip Y=-1 (bottom) → texture V=1 (bottom)
    // Clip Y=+1 (top)    → texture V=0 (top)
    // Using oversized triangle, V goes from 1 to -1 (will be clipped to 0-1)
    const uvsData = flipY
        ? new Float32Array([0, -1, 2, -1, 0, 1]) // flipped
        : new Float32Array([0, 1, 2, 1, 0, -1]); // standard: bottom-left→(0,1), bottom-right→(2,1), top-left→(0,-1)
    const geom = new Geometry();
    geom.setBuffer('position', createVertexBuffer(vec3f$1, positions));
    geom.setBuffer('uv', createVertexBuffer(vec2f$1, uvsData));
    geom.drawRange.count = 3;
    return geom;
}

/**
 * Shared fullscreen triangle geometry with position and uv vertex buffers.
 * Three.js aligned: mirrors the private QuadGeometry in QuadMesh.js.
 */
const _geometry = /* @__PURE__ */ createFullscreenTriangleGeometry();
/**
 * Shared camera for fullscreen rendering.
 * The vertex shader positions are driven by the geometry buffers directly
 * in clip space, so no projection is applied.
 */
const _camera = /* @__PURE__ */ new Camera();
_camera.name = '__quadCamera__';
/**
 * QuadMesh is a helper for rendering fullscreen effects.
 *
 * It wraps a fullscreen triangle geometry and provides a `render()` method
 * that draws the quad to the renderer's current target (canvas or render target).
 *
 * Three.js aligned: mirrors src/renderers/common/QuadMesh.js
 *
 * Usage:
 * ```ts
 * const quad = new QuadMesh(postProcessMaterial);
 * quad.render(renderer);
 * ```
 *
 * The intended usage is to reuse a single quad mesh for rendering
 * subsequent passes by just reassigning the `material` reference.
 */
class QuadMesh extends Mesh {
    /**
     * The camera used to render the quad mesh.
     */
    camera = _camera;
    /**
     * Type flag for identification.
     */
    isQuadMesh = true;
    /**
     * @param material - The material to render the quad with.
     */
    constructor(material) {
        super(_geometry, material);
        this.name = '__quadMesh__';
    }
    /**
     * Renders the quad mesh to the renderer's current target.
     *
     * Uses the renderer's current state:
     * - Canvas target (set via `renderer.setCanvasTarget()`)
     * - Render target (set via `renderer.setRenderTarget()`)
     * - Clear color
     * - MSAA samples (only for default canvas target)
     *
     * @param renderer - The WebGPU renderer.
     * @param encoder - Optional command encoder. If not provided, creates and submits one.
     */
    render(renderer, encoder) {
        renderer.render(this, this.camera, encoder);
    }
}

/**
 * scene-hierarchy.ts — Inspector Scene Hierarchy tab.
 *
 * Walks the Object3D tree for every scene record in a frame and displays it
 * as a collapsible tree using the existing List/Item UI components.
 *
 * Key design constraints:
 *  - DOM is NOT rebuilt from scratch each frame.
 *    A Map<objectId, HierarchyNode> tracks live nodes. Only structural changes
 *    (add / remove) mutate the DOM; transforms etc. are updated in-place.
 *  - Clicking a Mesh row opens a detail panel to the right of the hierarchy
 *    showing geometry info, material render state, instance count, and a
 *    "→ Draw Call" navigation button.
 *  - The tab auto-shows itself when scenes are present (mirrors Viewer pattern).
 */
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Human-readable type label for an Object3D. */
function typeLabel(obj) {
    if (obj instanceof Mesh)
        return 'Mesh';
    if (obj.constructor?.name === 'Scene')
        return 'Scene';
    return 'Object3D';
}
/** Display name — prefer obj.name, fall back to type + objectId. */
function displayName(obj) {
    return obj.name || `${typeLabel(obj)} #${obj.objectId}`;
}
/** Build the type-badge span element. */
function makeTypeBadge(label) {
    const badge = document.createElement('span');
    badge.className = `hierarchy-type-badge hierarchy-type-badge--${label.toLowerCase()}`;
    badge.textContent = label;
    return badge;
}
/** Create a section header div using the dc-section-header class. */
function makeSectionHeader(text) {
    const el = document.createElement('div');
    el.className = 'dc-section-header';
    el.textContent = text;
    return el;
}
/** Create a key/value row using the dc-kv-* classes. */
function makeKVRow(key, value) {
    const row = document.createElement('div');
    row.className = 'dc-kv-row';
    const k = document.createElement('span');
    k.className = 'dc-kv-key';
    k.textContent = key;
    const v = document.createElement('span');
    v.className = 'dc-kv-val';
    v.textContent = value;
    row.appendChild(k);
    row.appendChild(v);
    return row;
}
// ---------------------------------------------------------------------------
// SceneHierarchy Tab
// ---------------------------------------------------------------------------
class SceneHierarchy extends Tab {
    list;
    /** objectId → HierarchyNode for every currently-displayed object */
    _nodes = new Map();
    /** Item roots, one per scene (keyed by passId) */
    _sceneRoots = new Map();
    /** Currently selected mesh */
    _selectedMesh = null;
    /** The inspector reference passed into update() — used for navigation */
    _inspector = null;
    /** Right-side detail panel — shown when a Mesh is selected */
    _detailPanel;
    constructor() {
        super('Scene');
        const list = new List('Name', 'Type');
        list.setGridStyle('1fr auto');
        const scrollWrapper = document.createElement('div');
        scrollWrapper.className = 'list-scroll-wrapper scene-hierarchy-list';
        scrollWrapper.appendChild(list.domElement);
        this._detailPanel = document.createElement('div');
        this._detailPanel.className = 'shader-container mesh-detail-panel';
        this._detailPanel.style.display = 'none';
        // Row layout: list on the left, detail panel on the right
        const layout = document.createElement('div');
        layout.className = 'scene-hierarchy-layout';
        layout.appendChild(scrollWrapper);
        layout.appendChild(this._detailPanel);
        this.content.appendChild(layout);
        this.list = list;
    }
    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------
    /**
     * Called by Inspector._processFrame() whenever scenes are present.
     * Diffs the tree against the current DOM state and updates in-place.
     */
    update(inspector, scenes) {
        this._inspector = inspector;
        // Build the set of passIds we expect to show
        const activePassIds = new Set(scenes.map(s => s.passId));
        // Remove scene roots that are no longer present
        for (const [passId, rootItem] of this._sceneRoots) {
            if (!activePassIds.has(passId)) {
                this.list.remove(rootItem);
                this._sceneRoots.delete(passId);
                // Clean up all HierarchyNodes belonging to this scene
                for (const [id, hn] of this._nodes) {
                    if (hn.sceneRecord.passId === passId) {
                        this._nodes.delete(id);
                    }
                }
            }
        }
        // Sync each scene
        for (const sr of scenes) {
            this._syncScene(inspector, sr);
        }
    }
    // -----------------------------------------------------------------------
    // Tree diffing
    // -----------------------------------------------------------------------
    _syncScene(inspector, sr) {
        // Ensure a root item exists for this pass
        let rootItem = this._sceneRoots.get(sr.passId);
        if (!rootItem) {
            const badge = makeTypeBadge('Scene');
            const nameEl = document.createElement('span');
            nameEl.className = 'hierarchy-name';
            nameEl.textContent = displayName(sr.scene);
            rootItem = new Item(nameEl, badge);
            this._sceneRoots.set(sr.passId, rootItem);
            this.list.add(rootItem);
        }
        else {
            // Update scene name in case it changed
            const nameEl = rootItem.itemRow.querySelector('.hierarchy-name');
            if (nameEl)
                nameEl.textContent = displayName(sr.scene);
        }
        // Register / refresh the scene root in our node map
        const existing = this._nodes.get(sr.scene.objectId);
        if (!existing) {
            this._nodes.set(sr.scene.objectId, {
                objectId: sr.scene.objectId,
                object: sr.scene,
                item: rootItem,
                children: new Map(),
                sceneRecord: sr,
            });
        }
        this._syncChildren(inspector, sr.scene, rootItem, sr);
    }
    /** Recursively diff children of `parent` against `parentItem`. */
    _syncChildren(_inspector, parent, parentItem, sr) {
        const parentNode = this._nodes.get(parent.objectId);
        if (!parentNode)
            return;
        const liveChildIds = new Set(parent.children.map(c => c.objectId));
        // Remove items whose objects are no longer children
        for (const [id, hn] of parentNode.children) {
            if (!liveChildIds.has(id)) {
                parentItem.remove(hn.item);
                parentNode.children.delete(id);
                this._nodes.delete(id);
            }
        }
        // Add / update each current child
        for (const child of parent.children) {
            let hn = parentNode.children.get(child.objectId);
            if (!hn) {
                // New child — create item
                const badge = makeTypeBadge(typeLabel(child));
                const nameEl = document.createElement('span');
                nameEl.className = 'hierarchy-name';
                nameEl.textContent = displayName(child);
                const item = new Item(nameEl, badge);
                item.itemRow.classList.add('actionable');
                // Capture for closure
                const capturedChild = child;
                const capturedSr = sr;
                item.itemRow.addEventListener('click', (e) => {
                    // Don't trigger if click was on the toggler
                    if (e.target.closest('.item-toggler'))
                        return;
                    this._onItemClick(capturedChild, capturedSr, item);
                });
                parentItem.add(item);
                hn = {
                    objectId: child.objectId,
                    object: child,
                    item,
                    children: new Map(),
                    sceneRecord: sr,
                };
                parentNode.children.set(child.objectId, hn);
                this._nodes.set(child.objectId, hn);
            }
            else {
                // Existing child — update name in case it changed
                const nameEl = hn.item.itemRow.querySelector('.hierarchy-name');
                if (nameEl)
                    nameEl.textContent = displayName(child);
            }
            // Recurse into grandchildren
            this._syncChildren(_inspector, child, hn.item, sr);
        }
    }
    // -----------------------------------------------------------------------
    // Selection & detail panel
    // -----------------------------------------------------------------------
    _onItemClick(obj, _sr, item) {
        // Clear previous selection highlight
        if (this._selectedMesh) {
            const prevHn = this._nodes.get(this._selectedMesh.objectId);
            prevHn?.item.itemRow.classList.remove('hierarchy-selected');
        }
        if (obj instanceof Mesh) {
            this._selectedMesh = obj;
            item.itemRow.classList.add('hierarchy-selected');
            this._buildMeshDetail(obj);
            this._detailPanel.style.display = 'flex';
        }
        else {
            this._selectedMesh = null;
            this._detailPanel.innerHTML = '';
            this._detailPanel.style.display = 'none';
        }
    }
    /**
     * Populate `_detailPanel` with geometry info, material render state,
     * instance count, and a "→ Draw Call" navigation button for `mesh`.
     * The panel is rebuilt from scratch on each selection change.
     */
    _buildMeshDetail(mesh) {
        const panel = this._detailPanel;
        panel.innerHTML = '';
        const geo = mesh.geometry;
        const mat = mesh.material;
        // ------------------------------------------------------------------
        // Geometry section
        // ------------------------------------------------------------------
        panel.appendChild(makeSectionHeader('Geometry'));
        const table = document.createElement('div');
        table.className = 'dc-kv-table';
        table.appendChild(makeKVRow('drawRange.start', String(geo.drawRange.start)));
        table.appendChild(makeKVRow('drawRange.count', String(geo.drawRange.count)));
        // Index info
        if (geo.index && geo.index.array) {
            table.appendChild(makeKVRow('indices', String(geo.index.array.length)));
            table.appendChild(makeKVRow('index format', getIndexFormat(geo.index.array) ?? 'unknown'));
        }
        else {
            table.appendChild(makeKVRow('indices', 'none'));
        }
        // Buffers
        const bufferNames = Array.from(geo.buffers.keys());
        if (bufferNames.length > 0) {
            for (const name of bufferNames) {
                const buffer = geo.buffers.get(name);
                const fmt = buffer.format ?? `itemSize=${buffer.itemSize}`;
                table.appendChild(makeKVRow(`buffer: ${name}`, fmt));
            }
        }
        else {
            table.appendChild(makeKVRow('buffers', 'none'));
        }
        // Bounding box — Box3 is [minX, minY, minZ, maxX, maxY, maxZ]
        if (geo.boundingBox) {
            const bb = geo.boundingBox;
            const minStr = `(${bb[0].toFixed(2)}, ${bb[1].toFixed(2)}, ${bb[2].toFixed(2)})`;
            const maxStr = `(${bb[3].toFixed(2)}, ${bb[4].toFixed(2)}, ${bb[5].toFixed(2)})`;
            table.appendChild(makeKVRow('bbox min', minStr));
            table.appendChild(makeKVRow('bbox max', maxStr));
        }
        panel.appendChild(table);
        // ------------------------------------------------------------------
        // Material section
        // ------------------------------------------------------------------
        panel.appendChild(makeSectionHeader('Material'));
        const matTable = document.createElement('div');
        matTable.className = 'dc-kv-table';
        matTable.appendChild(makeKVRow('transparent', String(mat.transparent)));
        matTable.appendChild(makeKVRow('depthTest', String(mat.depthTest)));
        matTable.appendChild(makeKVRow('depthWrite', String(mat.depthWrite)));
        matTable.appendChild(makeKVRow('depthCompare', mat.depthCompare));
        matTable.appendChild(makeKVRow('cullMode', mat.cullMode));
        matTable.appendChild(makeKVRow('alphaToCoverage', String(mat.alphaToCoverage)));
        if (mat.blend) {
            const b = mat.blend;
            const colorOp = b.color ? `${b.color.operation ?? 'add'} (src:${b.color.srcFactor ?? 'one'} dst:${b.color.dstFactor ?? 'zero'})` : 'default';
            const alphaOp = b.alpha ? `${b.alpha.operation ?? 'add'} (src:${b.alpha.srcFactor ?? 'one'} dst:${b.alpha.dstFactor ?? 'zero'})` : 'default';
            matTable.appendChild(makeKVRow('blend.color', colorOp));
            matTable.appendChild(makeKVRow('blend.alpha', alphaOp));
        }
        else {
            matTable.appendChild(makeKVRow('blend', 'none'));
        }
        panel.appendChild(matTable);
        // ------------------------------------------------------------------
        // Instance section
        // ------------------------------------------------------------------
        panel.appendChild(makeSectionHeader('Instance'));
        const instTable = document.createElement('div');
        instTable.className = 'dc-kv-table';
        instTable.appendChild(makeKVRow('count', String(mesh.count)));
        panel.appendChild(instTable);
        // ------------------------------------------------------------------
        // Navigation button
        // ------------------------------------------------------------------
        const navBtn = document.createElement('button');
        navBtn.className = 'dc-nav-link';
        navBtn.title = "Jump to this mesh's draw call";
        navBtn.textContent = '→ Draw Call';
        navBtn.style.margin = '12px 8px 8px';
        navBtn.addEventListener('click', () => {
            const inspector = this._inspector;
            if (!inspector)
                return;
            const renderer = inspector.getRenderer();
            if (!renderer)
                return;
            for (const ro of renderer._renderObjects.renderObjects) {
                if (ro.mesh === mesh) {
                    inspector.navigateToRO(ro);
                    return;
                }
            }
        });
        panel.appendChild(navBtn);
    }
}

/**
 * probe-wgsl.ts — WGSL string patching helpers for the shader value probe.
 *
 * The probe re-uses the source mesh's vertex shader verbatim (including camera
 * transforms) so that the probe canvas renders the mesh from the real camera's
 * point of view.  Only fs_main is patched to output a single vec4f showing the
 * chosen intermediate variable.
 */
// ---------------------------------------------------------------------------
// extractProbeTarget — parse a hovered WGSL line into a ProbeTarget
// ---------------------------------------------------------------------------
/**
 * Given the raw text of a single WGSL source line, return a ProbeTarget
 * describing what expression to probe and where to truncate the body,
 * or null if the line is not probeable.
 *
 * Supported patterns (all with optional leading whitespace):
 *   let _vN = <expr>;               → probe _vN, anchor on let line
 *   var name : type = <expr>;       → probe name, anchor on var line
 *   name = <expr>;                  → probe <expr>, anchor on this line
 *   _out.field = <expr>;            → probe <expr>, anchor on this line
 *   out.field = <expr>;             → probe <expr>, anchor on this line
 *   return <expr>;                  → probe <expr>, anchor on return
 */
function extractProbeTarget(line) {
    const trimmed = line.trim();
    // Skip blank / comments / structural lines
    if (!trimmed)
        return null;
    if (trimmed.startsWith('//') || trimmed.startsWith('/*'))
        return null;
    if (trimmed.startsWith('struct ') ||
        trimmed.startsWith('@') ||
        trimmed.startsWith('fn ') ||
        trimmed === '{' ||
        trimmed === '}')
        return null;
    // Skip lines that produce nothing useful to probe
    if (trimmed === 'discard;' || trimmed.startsWith('if (!('))
        return null;
    if (/^var\s+\w+\s*:\s*FragmentOutput\s*;/.test(trimmed))
        return null;
    if (/^var\s+\w+\s*:\s*VertexOutput\s*;/.test(trimmed))
        return null;
    // `let identifier [: type] = <expr>;`
    const letMatch = trimmed.match(/^let\s+(\w+)\s*(?::\s*[\w<>, ]+\s*)?=\s*([\s\S]+?)\s*;?\s*$/);
    if (letMatch) {
        return { expr: letMatch[1], anchor: letMatch[1], anchorKind: 'let_var' };
    }
    // `var identifier [: type] [= <expr>];`  — only probe if there's an initialiser
    const varMatch = trimmed.match(/^var\s+(\w+)\s*(?::\s*[\w<>, ]+\s*)?=\s*([\s\S]+?)\s*;?\s*$/);
    if (varMatch) {
        return { expr: varMatch[1], anchor: varMatch[1], anchorKind: 'let_var' };
    }
    // `return <expr>;`
    const returnMatch = trimmed.match(/^return\s+([\s\S]+?)\s*;?\s*$/);
    if (returnMatch) {
        const retExpr = returnMatch[1];
        // Skip `return _out;` — _out is a FragmentOutput struct, not a vec value
        if (/^\w+$/.test(retExpr) && retExpr.startsWith('_out'))
            return null;
        return { expr: retExpr, anchor: '__return__', anchorKind: 'return' };
    }
    // `<lhs> = <rhs>;`  — any assignment: covers `_out.color = _v2`, `out.pos = _v0`, `myVar = expr`
    const assignMatch = trimmed.match(/^([\w.[\]]+)\s*=\s*([\s\S]+?)\s*;?\s*$/);
    if (assignMatch) {
        const rhs = assignMatch[2];
        return { expr: rhs, anchor: trimmed, anchorKind: 'assignment' };
    }
    return null;
}
/**
 * Parse every `struct Name { ... }` block out of the full WGSL source and
 * return a StructFieldMap.  Handles:
 *   - `@builtin(position) position : vec4f,`
 *   - `@location(N) [interpolation attrs] name : type,`
 *   - bare `name : type,` (no attribute)
 *
 * This is intentionally domain-specific to our own generated WGSL so we
 * don't need a full parser — we just need the structs compile.ts emits.
 */
function buildStructFieldMap(wgsl) {
    const result = new Map();
    // Iterate over every `struct <Name> { ... }` block.
    // We do a depth-tracked scan so nested braces don't trip us up.
    const structRe = /\bstruct\s+(\w+)\s*\{/g;
    let m;
    while ((m = structRe.exec(wgsl)) !== null) {
        const structName = m[1];
        const bodyStart = m.index + m[0].length;
        // Walk forward to find the matching closing brace
        let depth = 1;
        let i = bodyStart;
        while (i < wgsl.length && depth > 0) {
            if (wgsl[i] === '{')
                depth++;
            else if (wgsl[i] === '}')
                depth--;
            i++;
        }
        const body = wgsl.slice(bodyStart, i - 1);
        const fieldMap = new Map();
        // Each field is one line: optional attrs, then `name : type,`
        for (const rawLine of body.split('\n')) {
            const line = rawLine.trim();
            if (!line || line.startsWith('//'))
                continue;
            // Strip leading attribute(s): @builtin(...), @location(N), @interpolate(...)
            const stripped = line.replace(/(?:@\w+\s*(?:\([^)]*\))?\s*)+/, '').trim();
            // Now expect `name : type[,]`
            const fieldMatch = stripped.match(/^(\w+)\s*:\s*([\w<>, ]+?)\s*,?\s*$/);
            if (fieldMatch) {
                fieldMap.set(fieldMatch[1], fieldMatch[2].trim());
            }
        }
        if (fieldMap.size > 0)
            result.set(structName, fieldMap);
    }
    return result;
}
// ---------------------------------------------------------------------------
// Type inference helpers
// ---------------------------------------------------------------------------
/**
 * Remove one layer of balanced outer parentheses if they wrap the whole string.
 * `((a + b))` → `(a + b)` → caller will recurse again.
 */
function stripOuterParens(s) {
    if (!s.startsWith('(') || !s.endsWith(')'))
        return s;
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '(')
            depth++;
        else if (s[i] === ')') {
            depth--;
            if (depth === 0 && i < s.length - 1)
                return s; // closing paren is not the last char
        }
    }
    return s.slice(1, -1).trim();
}
/**
 * Infer the WGSL type of a value expression from its syntax.
 * Scans the expression prefix and any `var name : type;` declarations
 * found in the full WGSL body.  Also resolves `in.fieldName` and
 * `_out.fieldName` via the struct field map parsed from the full WGSL.
 *
 * This is intentionally best-effort — unknown falls back to vec4f coercion.
 */
function inferType(expr, fullBody, varDecls, structFields) {
    const e = expr.trim();
    // Direct lookup from `var name : type;` declarations in the body,
    // or from `in.fieldName` entries pre-seeded by buildProbeWGSL.
    if (/^\w+(?:\.\w+)?$/.test(e) && varDecls.has(e)) {
        return normaliseType(varDecls.get(e));
    }
    // Swizzle access: `in.v_norm.xyz`, `someVec.xy`, `_v0.x`,
    // `textureSample(t, s, uv).xyz`, `someCall(a, b).w`, etc.
    //
    // We can't use a simple regex because the base may contain parentheses
    // (function calls, nested exprs).  Instead we scan from the end: if the
    // expression ends with `.<swizzle>` and the swizzle chars are all valid
    // xyzw/rgba components, split there and recurse on the base.
    const trailingSwizzle = e.match(/\.([xyzwrgba]{1,4})$/);
    if (trailingSwizzle) {
        const swizzle = trailingSwizzle[1];
        const base = e.slice(0, e.length - swizzle.length - 1); // drop ".<swizzle>"
        if (base.length > 0) {
            const baseKind = inferType(base, fullBody, varDecls, structFields);
            if (baseKind !== 'unknown') {
                const swLen = swizzle.length;
                if (swLen === 1)
                    return 'f32';
                if (swLen === 2)
                    return 'vec2f';
                if (swLen === 3)
                    return 'vec3f';
                if (swLen === 4)
                    return 'vec4f';
            }
        }
    }
    // `in.fieldName` — look up the FragmentInput struct (or any struct the
    // `in` parameter is typed as).  We also handle `_out.fieldName` via
    // FragmentOutput for completeness.
    const memberMatch = e.match(/^(\w+)\.(\w+)$/);
    if (memberMatch) {
        const [, objName, fieldName] = memberMatch;
        // Determine the struct name for this object by scanning the full WGSL
        // for the `fn fs_main(... objName : StructName ...)` parameter list.
        const paramRe = new RegExp(`\\b${escapeRegex(objName)}\\s*:\\s*(\\w+)\\b`);
        const paramMatch = fullBody.match(paramRe);
        if (paramMatch) {
            const structName = paramMatch[1];
            const fields = structFields.get(structName);
            if (fields?.has(fieldName)) {
                return normaliseType(fields.get(fieldName));
            }
        }
        // Fallback: try all structs for a field name match (covers unambiguous names)
        for (const fields of structFields.values()) {
            if (fields.has(fieldName)) {
                return normaliseType(fields.get(fieldName));
            }
        }
    }
    // Constructor prefix: vec4f(...), vec3f(...), vec2f(...), f32(...), etc.
    const ctorMatch = e.match(/^(vec4[fi]?|vec3[fi]?|vec2[fi]?|vec4|vec3|vec2|f32|f16|i32|u32|bool)\s*[(<]/);
    if (ctorMatch)
        return normaliseType(ctorMatch[1]);
    // texture* functions always return vec4f
    if (/^texture(Sample|Load|Fetch)\b/.test(e))
        return 'vec4f';
    // Float / int literal: 0.0, -1.5, 3.14f, 0.5h → f32; 42u → u32; 42i → i32
    if (/^-?[0-9]*\.[0-9]+(?:[eE][+-]?[0-9]+)?[fh]?$/.test(e))
        return 'f32';
    if (/^-?[0-9]+[fh]$/.test(e))
        return 'f32';
    if (/^-?[0-9]+u$/.test(e))
        return 'u32';
    if (/^-?[0-9]+i$/.test(e))
        return 'i32';
    // Strictly scalar builtins (always return f32 regardless of arg types)
    if (/^(dot|length|distance|determinant)\s*\(/.test(e))
        return 'f32';
    // Builtins that return a bool
    if (/^(any|all)\s*\(/.test(e))
        return 'bool';
    // Builtins that only accept float scalars/vectors and return the same type.
    // When the argument resolves to 'unknown' we fall back to 'f32' rather than
    // propagating 'unknown', because these functions are never called on non-float
    // types in generated WGSL and a bare `(expr)` would produce a type mismatch.
    const scalarFloatBuiltins = /^(sin|cos|tan|asin|acos|atan|exp|exp2|log|log2|sqrt|inverseSqrt|degrees|radians|ceil|floor|round|trunc|fract|sign|abs)\s*\(/;
    const scalarFloatMatch = e.match(scalarFloatBuiltins);
    if (scalarFloatMatch) {
        const afterOpen = e.slice(scalarFloatMatch[0].length);
        const closeIdx = afterOpen.indexOf(')');
        const arg = closeIdx >= 0 ? afterOpen.slice(0, closeIdx).trim() : afterOpen.trim();
        if (arg) {
            const t = inferType(arg, fullBody, varDecls, structFields);
            if (t !== 'unknown')
                return t;
        }
        // Argument unresolvable — these builtins always return f32 in our context
        return 'f32';
    }
    // Builtins that return same type as their first argument (polymorphic).
    // We recurse into ALL arguments until we find a non-unknown type, because
    // the first arg may itself be unresolvable (e.g. a raw literal like 0.0
    // is abstract-float, but the second arg might be a typed variable).
    const polyMatch = e.match(/^(atan2|ceil|clamp|cross|fma|max|min|mix|modf|normalize|pow|reflect|refract|round|select|smoothstep|step)\s*\(/);
    if (polyMatch) {
        const afterOpen = e.slice(polyMatch[0].length);
        // Walk comma-separated args (depth-aware) and return first resolved type.
        let depth = 0;
        let argStart = 0;
        for (let i = 0; i <= afterOpen.length; i++) {
            const ch = afterOpen[i];
            if (ch === '(' || ch === '[' || ch === '<') {
                depth++;
                continue;
            }
            if (ch === ')' || ch === ']' || ch === '>') {
                if (depth === 0 || i === afterOpen.length) {
                    const arg = afterOpen.slice(argStart, i).trim();
                    if (arg) {
                        const t = inferType(arg, fullBody, varDecls, structFields);
                        if (t !== 'unknown')
                            return t;
                    }
                    break;
                }
                depth--;
                continue;
            }
            if (ch === ',' && depth === 0) {
                const arg = afterOpen.slice(argStart, i).trim();
                if (arg) {
                    const t = inferType(arg, fullBody, varDecls, structFields);
                    if (t !== 'unknown')
                        return t;
                }
                argStart = i + 1;
            }
        }
    }
    // Strip outer parentheses and retry (handles `((a * b) + c)` style exprs)
    const stripped = stripOuterParens(e);
    if (stripped !== e)
        return inferType(stripped, fullBody, varDecls, structFields);
    // Arithmetic / compound expression — walk tokens to find a typed operand.
    // The first word token that resolves via varDecls wins.
    const firstToken = e.match(/^(\w+)/)?.[1];
    if (firstToken && varDecls.has(firstToken)) {
        return normaliseType(varDecls.get(firstToken));
    }
    // Scan the full body for `let name [: type] = <rhs>;` or `var name [: type] = <rhs>;`
    // Try constructor prefix first; if that fails, recurse into the RHS expression.
    if (/^\w+$/.test(e)) {
        const declRe = new RegExp(`\\b(?:let|var)\\s+${escapeRegex(e)}\\s*(?::\\s*[\\w<>, ]+?\\s*)?=\\s*([^;]+?)\\s*;`);
        const lm = fullBody.match(declRe);
        if (lm) {
            const rhs = lm[1].trim();
            // Fast path: obvious constructor prefix
            const ctorMatch = rhs.match(/^(vec4[fi]?|vec3[fi]?|vec2[fi]?|vec4|vec3|vec2|f32|f16|i32|u32|bool)\s*[(<]/);
            if (ctorMatch)
                return normaliseType(ctorMatch[1]);
            // Slow path: recurse into the RHS (guards against infinite loop via varDecls check above)
            const rhsKind = inferType(rhs, fullBody, varDecls, structFields);
            if (rhsKind !== 'unknown')
                return rhsKind;
        }
    }
    // Scan expression for any vec constructor literal — catches `(a * vec3f(...) + b)` etc.
    const vecInExpr = e.match(/\b(vec4[fi]?|vec3[fi]?|vec2[fi]?|vec4f|vec3f|vec2f|vec4|vec3|vec2)\s*\(/);
    if (vecInExpr)
        return normaliseType(vecInExpr[1]);
    // Scan expression for any var whose type we know
    for (const [name, type] of varDecls) {
        if (new RegExp(`\\b${escapeRegex(name)}\\b`).test(e)) {
            return normaliseType(type);
        }
    }
    return 'unknown';
}
function normaliseType(t) {
    if (t.startsWith('vec4'))
        return 'vec4f';
    if (t.startsWith('vec3'))
        return 'vec3f';
    if (t.startsWith('vec2'))
        return 'vec2f';
    if (t === 'f32' || t === 'f16')
        return 'f32';
    if (t === 'i32')
        return 'i32';
    if (t === 'u32')
        return 'u32';
    if (t === 'bool')
        return 'bool';
    return 'unknown';
}
/**
 * Emit the WGSL expression that converts a value of the given inferred type
 * into a `vec4f` suitable for the probe render target.
 */
function coerceToVec4f(expr, kind) {
    switch (kind) {
        case 'vec4f': return `(${expr})`;
        case 'vec3f': return `vec4f((${expr}), 1.0f)`;
        case 'vec2f': return `vec4f((${expr}), 0.0f, 1.0f)`;
        case 'f32': return `vec4f(vec3f(${expr}), 1.0f)`;
        case 'i32': return `vec4f(vec3f(f32(${expr})), 1.0f)`;
        case 'u32': return `vec4f(vec3f(f32(${expr})), 1.0f)`;
        case 'bool': return `vec4f(vec3f(f32(${expr})), 1.0f)`;
        // unknown — pass through bare, same as fragcoord's fallback.
        // If the expression is already vec4f this is correct.  If it's
        // something else the shader compiler will surface a clear error
        // rather than silently emitting a wrong value (or failing with a
        // cryptic "wrong number of components" message from the extra 1.0f).
        default: return `(${expr})`;
    }
}
// ---------------------------------------------------------------------------
// buildProbeWGSL — patch combined WGSL to output a single probe variable
// ---------------------------------------------------------------------------
/**
 * Patch the combined WGSL emitted by compile.ts so that:
 *  1. Everything up to and including the original vs_main is kept verbatim.
 *     The probe uses the real vertex shader so the mesh renders correctly
 *     from the camera's point of view with proper transforms.
 *  2. A `return <coercion>;` is injected immediately after the target line
 *     in fs_main; remaining lines become dead code (WGSL allows unreachable
 *     statements after a return).
 *  3. The function return type is changed to `-> @location(0) vec4f`.
 *  4. FragmentOutput / VertexOutput struct var declarations in the body are stripped.
 *
 * Returns the patched WGSL string, or null if patching fails.
 */
function buildProbeWGSL(code, target) {
    // -----------------------------------------------------------------------
    // 1. Locate @fragment entry-point.
    // -----------------------------------------------------------------------
    const fragmentAttrRe = /(?:^|\n)(@fragment\s*\n)/;
    const fragmentAttrMatch = code.match(fragmentAttrRe);
    if (!fragmentAttrMatch || fragmentAttrMatch.index === undefined)
        return null;
    const fsStart = fragmentAttrMatch.index + (fragmentAttrMatch[0].length - fragmentAttrMatch[1].length);
    // -----------------------------------------------------------------------
    // 2. Everything before @fragment is kept verbatim (preamble + vs_main).
    // -----------------------------------------------------------------------
    const beforeFs = code.slice(0, fsStart).trimEnd();
    // -----------------------------------------------------------------------
    // 3. Locate fs_main body start and capture original parameter list.
    // -----------------------------------------------------------------------
    const fsSection = code.slice(fsStart);
    const fnHeaderMatch = fsSection.match(/fn\s+fs_main\s*\([^)]*\)\s*->(?:[^{]*)\{/);
    if (!fnHeaderMatch || fnHeaderMatch.index === undefined)
        return null;
    // Keep the original parameter (e.g. "in : FragmentInput") so in.xxx refs work.
    const fnHeaderParamMatch = fsSection.match(/fn\s+fs_main\s*\(([^)]*)\)/);
    const fsParam = fnHeaderParamMatch ? fnHeaderParamMatch[1].trim() : '';
    const bodyStart = fsStart + fnHeaderMatch.index + fnHeaderMatch[0].length;
    const rawBody = code.slice(bodyStart);
    const bodyLines = rawBody.split('\n');
    // -----------------------------------------------------------------------
    // 4. Build var-decl map from `var name : type;` lines in the full body,
    //    and parse struct field maps from the full WGSL (for in.fieldName etc).
    // -----------------------------------------------------------------------
    const varDecls = new Map();
    for (const bl of bodyLines) {
        const trimmed = bl.trim();
        // `var name : type;` — explicit type, no initializer
        const vmNoInit = trimmed.match(/^var\s+(\w+)\s*:\s*([\w<>, ]+?)\s*;/);
        if (vmNoInit) {
            varDecls.set(vmNoInit[1], vmNoInit[2]);
            continue;
        }
        // `var name [: type] = <rhs>;` — explicit type annotation OR infer from RHS constructor
        const vmInit = trimmed.match(/^var\s+(\w+)\s*(?::\s*([\w<>, ]+?)\s*)?=\s*([\s\S]+?)\s*;?\s*$/);
        if (vmInit) {
            const [, name, explicitType, rhs] = vmInit;
            if (explicitType) {
                varDecls.set(name, explicitType);
            }
            else {
                const ctorMatch = rhs.trim().match(/^(vec4[fi]?|vec3[fi]?|vec2[fi]?|vec4|vec3|vec2|f32|f16|i32|u32|bool)\s*[(<]/);
                if (ctorMatch)
                    varDecls.set(name, ctorMatch[1]);
            }
            continue;
        }
        // `let name [: type] = <rhs>;` — infer type from explicit annotation or RHS constructor
        const lm = trimmed.match(/^let\s+(\w+)\s*(?::\s*([\w<>, ]+?)\s*)?=\s*([\s\S]+?)\s*;?\s*$/);
        if (lm) {
            const [, name, explicitType, rhs] = lm;
            if (explicitType) {
                varDecls.set(name, explicitType);
            }
            else {
                // Infer from obvious RHS constructor prefix (vec4f(...), vec3f(...), etc.)
                const ctorMatch = rhs.trim().match(/^(vec4[fi]?|vec3[fi]?|vec2[fi]?|vec4|vec3|vec2|f32|f16|i32|u32|bool)\s*[(<]/);
                if (ctorMatch)
                    varDecls.set(name, ctorMatch[1]);
            }
        }
    }
    const structFields = buildStructFieldMap(code);
    // Expand varDecls with `obj.fieldName → type` entries from struct params.
    // This lets inferType resolve `in.v_elevation`, `in.v_norm`, etc. directly
    // via its plain varDecls lookup when the expression is `in.fieldName`.
    // fsParam is e.g. "in : FragmentInput" or "in : FragmentInput, ..."
    for (const paramDecl of fsParam.split(',')) {
        const pm = paramDecl.trim().match(/^(\w+)\s*:\s*(\w+)$/);
        if (!pm)
            continue;
        const [, paramName, structName] = pm;
        const fields = structFields.get(structName);
        if (!fields)
            continue;
        for (const [fieldName, fieldType] of fields) {
            varDecls.set(`${paramName}.${fieldName}`, fieldType);
        }
    }
    // -----------------------------------------------------------------------
    // 5. Infer the type of the probed expression and emit safe coercion.
    //    We do this before the walk so the injected return line is ready.
    // -----------------------------------------------------------------------
    const kind = inferType(target.expr, rawBody, varDecls, structFields);
    const returnVec4 = coerceToVec4f(target.expr, kind);
    const injectedReturn = `    return ${returnVec4};`;
    // -----------------------------------------------------------------------
    // 6. Walk body lines, truncating at the anchor.
    //
    //    We emit lines up to and including the anchor, inject our return
    //    immediately after, then stop.  This avoids dead-code warnings and
    //    the MRT-specific type error where `return _out;` (type FragmentOutput)
    //    would conflict with the patched `-> @location(0) vec4f` return type.
    //
    //    Variables in WGSL are always declared before use, so truncation never
    //    loses a definition that the probed expression depends on.
    //
    //    Special cases:
    //    - `var _out : FragmentOutput;` is kept only when the probed expression
    //      references `_out` (e.g. user selected `_out.diffuse`).
    //    - `return _out;` and other FragmentOutput returns are always dropped
    //      — they appear at the end of the body, past our injected return.
    // -----------------------------------------------------------------------
    const exprUsesOut = /\b_out\b/.test(target.expr);
    const keptLines = [];
    let found = false;
    for (const bodyLine of bodyLines) {
        const trimmed = bodyLine.trim();
        // Stop at closing brace of fs_main
        if (trimmed === '}')
            break;
        // Once we've injected our return, stop emitting — no dead code.
        if (found)
            break;
        // Strip `var _out : FragmentOutput;` unless the probe expr uses `_out`.
        if (/^var\s+\w+\s*:\s*(?:Fragment|Vertex)Output\s*;/.test(trimmed)) {
            if (!exprUsesOut)
                continue;
        }
        // Drop `return _out;` — MRT body always ends with this, it returns
        // FragmentOutput which is incompatible with our patched `-> vec4f`.
        // extractProbeTarget already blocks probing this line directly, so
        // we only ever hit it as a trailing line we need to skip.
        if (/^return\s+_out\s*;/.test(trimmed))
            continue;
        switch (target.anchorKind) {
            case 'return':
                if (trimmed.startsWith('return')) {
                    // Replace the original return with our probe return.
                    keptLines.push(injectedReturn);
                    found = true;
                }
                else {
                    keptLines.push(bodyLine);
                }
                break;
            case 'let_var': {
                keptLines.push(bodyLine);
                const isTarget = new RegExp(`^(?:let|var)\\s+${escapeRegex(target.anchor)}\\b`).test(trimmed);
                if (isTarget) {
                    keptLines.push(injectedReturn);
                    found = true;
                }
                break;
            }
            case 'assignment': {
                keptLines.push(bodyLine);
                if (trimmed === target.anchor) {
                    keptLines.push(injectedReturn);
                    found = true;
                }
                break;
            }
        }
    }
    if (!found)
        return null;
    // -----------------------------------------------------------------------
    // 7. Assemble patched fs_main.
    // -----------------------------------------------------------------------
    const probeFsBody = keptLines.join('\n');
    const probeFsMain = [
        `@fragment`,
        `fn fs_main(${fsParam}) -> @location(0) vec4f {`,
        probeFsBody,
        `}`,
    ].join('\n');
    // -----------------------------------------------------------------------
    // 8. Final assembly: original preamble + vs_main, then patched fs_main.
    // -----------------------------------------------------------------------
    return [beforeFs, '', probeFsMain].join('\n');
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * shader-panel.ts — Inline WGSL shader viewer for the Inspector.
 *
 * Given a RenderObject, it:
 *  1. Splits nodeBuilderState.code into vertex/fragment sections.
 *  2. Applies basic WGSL syntax highlighting in a <pre> display layer.
 *  3. Provides stage-select buttons (Vertex / Fragment / Full) and Copy button.
 *  4. Shows "Compiling…" when no compiled RenderObject exists yet.
 *  5. Hovering a probeable fragment-stage line shows a floating popover with
 *     a live 140×140 preview canvas next to the cursor.
 */
// ---------------------------------------------------------------------------
// WGSL Syntax Highlighting
// ---------------------------------------------------------------------------
/** Lightweight regex-based WGSL highlighter. Returns an HTML string. */
function highlightWGSL(code) {
    // Escape HTML first so we can safely inject spans
    const escaped = code
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    return escaped
        // Line comments
        .replace(/(\/\/[^\n]*)/g, '<span class="wgsl-comment">$1</span>')
        // Block comments (non-greedy)
        .replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="wgsl-comment">$1</span>')
        // Attributes  @builtin @location @group @binding @vertex @fragment @compute
        .replace(/(@\w+)/g, '<span class="wgsl-attribute">$1</span>')
        // Keywords
        .replace(/\b(fn|let|var|const|struct|return|if|else|for|while|loop|break|continue|switch|case|default|discard|override|enable|alias|import|true|false|null)\b/g, '<span class="wgsl-keyword">$1</span>')
        // Built-in types
        .replace(/\b(bool|i32|u32|f32|f16|vec2|vec3|vec4|vec2f|vec3f|vec4f|vec2i|vec3i|vec4i|vec2u|vec3u|vec4u|mat2x2|mat3x3|mat4x4|mat2x2f|mat3x3f|mat4x4f|array|atomic|texture_2d|texture_depth_2d|texture_storage_2d|sampler|sampler_comparison|ptr|ref)\b/g, '<span class="wgsl-type">$1</span>')
        // Built-in functions
        .replace(/\b(abs|acos|asin|atan|atan2|ceil|clamp|cos|cross|degrees|distance|dot|exp|exp2|floor|fma|fract|inverseSqrt|length|log|log2|max|min|mix|modf|normalize|pow|radians|reflect|refract|round|sign|sin|smoothstep|sqrt|step|tan|trunc|bitcast|select|arrayLength|textureLoad|textureSample|textureSampleBias|textureSampleCompare|textureSampleGrad|textureSampleLevel|textureStore|textureDimensions|dpdx|dpdy|fwidth|pack4x8snorm|pack4x8unorm|unpack4x8snorm|unpack4x8unorm)\b/g, '<span class="wgsl-builtin">$1</span>')
        // Numeric literals (hex, float, int)
        .replace(/\b(0x[0-9a-fA-F]+|[0-9]*\.[0-9]+(?:[eE][+-]?[0-9]+)?[fh]?|[0-9]+[uif]?)\b/g, '<span class="wgsl-number">$1</span>');
}
/**
 * Split combined WGSL (as emitted by compile.ts) into vertex / fragment
 * sections. The combined code has `@vertex\nfn vs_main` and
 * `@fragment\nfn fs_main` entry-point markers.
 */
function splitStages(code) {
    const vertexMatch = code.match(/@vertex\s*\nfn\s+vs_main/);
    const fragmentMatch = code.match(/@fragment\s*\nfn\s+fs_main/);
    if (!vertexMatch || !fragmentMatch) {
        return { vertex: code, fragment: code, full: code, compute: '' };
    }
    const vsStart = code.indexOf(vertexMatch[0]);
    const fsStart = code.indexOf(fragmentMatch[0]);
    const vertexSection = code.slice(vsStart, fsStart).trimEnd();
    const fragmentSection = code.slice(fsStart).trimEnd();
    return {
        vertex: vertexSection,
        fragment: fragmentSection,
        full: code,
        compute: '',
    };
}
class ShaderPanel {
    domElement;
    _codeBlock;
    _stageButtons = new Map();
    _currentStage = 'vertex';
    _stages = null;
    /** Raw compute shader code (used in compute mode). */
    _computeCode = null;
    /** The raw code string last written to innerHTML — skips re-render if unchanged. */
    _lastRenderedCode = null;
    /** The RenderObject found during the last update() call. */
    _renderObject = null;
    /** Inspector reference — set on first update() call. */
    _inspector = null;
    // -----------------------------------------------------------------------
    // Probe popover — floats next to the cursor while hovering a probeable line
    // -----------------------------------------------------------------------
    /** Floating popover element, appended to document.body. */
    _popover;
    _popoverLabel;
    _popoverCanvasSlot;
    /** varName currently shown in the popover (to avoid redundant setProbe calls). */
    _hoverVarName = null;
    /** Whether the popover is currently visible. */
    _popoverVisible = false;
    /**
     * When true the current probe was triggered by a text selection, not a
     * hover.  Mousemove events will NOT clear it — only a mousedown outside
     * the code block (or a new selection) will.
     */
    _selectionLocked = false;
    constructor(mode = 'render') {
        const container = document.createElement('div');
        container.className = 'shader-panel';
        // --- Toolbar ---
        const toolbar = document.createElement('div');
        toolbar.className = 'shader-toolbar';
        const stageGroup = document.createElement('div');
        stageGroup.className = 'shader-stage-group';
        if (mode === 'render') {
            const stages = ['vertex', 'fragment', 'full'];
            for (const stage of stages) {
                const btn = document.createElement('button');
                btn.className = 'shader-stage-btn';
                btn.textContent = stage.charAt(0).toUpperCase() + stage.slice(1);
                btn.addEventListener('click', () => this._selectStage(stage));
                stageGroup.appendChild(btn);
                this._stageButtons.set(stage, btn);
            }
        }
        else {
            // Compute mode: single "Compute" stage button (always active)
            const btn = document.createElement('button');
            btn.className = 'shader-stage-btn active';
            btn.textContent = 'Compute';
            stageGroup.appendChild(btn);
            this._stageButtons.set('compute', btn);
            this._currentStage = 'compute';
        }
        const copyBtn = document.createElement('button');
        copyBtn.className = 'console-copy-button shader-copy-btn';
        copyBtn.title = 'Copy shader';
        copyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
        copyBtn.addEventListener('click', () => this._copyCode(copyBtn));
        toolbar.appendChild(stageGroup);
        toolbar.appendChild(copyBtn);
        // --- Code area ---
        const codeScroll = document.createElement('div');
        codeScroll.className = 'shader-code-scroll';
        const codeBlock = document.createElement('pre');
        codeBlock.className = 'shader-code';
        codeBlock.innerHTML = '<span class="wgsl-comment">// Compiling…</span>';
        codeBlock.style.userSelect = 'text';
        codeBlock.style.webkitUserSelect = 'text';
        // Probe hover/selection only enabled in render mode
        if (mode === 'render') {
            codeScroll.addEventListener('mousemove', (e) => this._onLineHover(e));
            codeScroll.addEventListener('mouseleave', () => this._onMouseLeave());
            codeBlock.addEventListener('mouseup', () => this._onSelectionEnd());
            // Clicking outside the panel dismisses a selection-locked probe.
            document.addEventListener('mousedown', (e) => {
                if (this._selectionLocked && !container.contains(e.target)) {
                    this._hidePopover();
                }
            });
        }
        codeScroll.appendChild(codeBlock);
        container.appendChild(toolbar);
        container.appendChild(codeScroll);
        // --- Floating probe popover (appended to body, shared across all instances) ---
        const popover = document.createElement('div');
        popover.className = 'probe-popover';
        popover.style.display = 'none';
        const popoverLabel = document.createElement('span');
        popoverLabel.className = 'probe-popover-label';
        const popoverCanvasSlot = document.createElement('div');
        popoverCanvasSlot.className = 'probe-popover-canvas';
        popover.appendChild(popoverLabel);
        popover.appendChild(popoverCanvasSlot);
        document.body.appendChild(popover);
        this._popover = popover;
        this._popoverLabel = popoverLabel;
        this._popoverCanvasSlot = popoverCanvasSlot;
        this.domElement = container;
        this._codeBlock = codeBlock;
        // Select initial stage (render mode starts at vertex, compute at compute)
        if (mode === 'render') {
            this._selectStage('vertex');
        }
    }
    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------
    /**
     * Update the panel for the given mesh.
     * Finds the compiled RenderObject in the renderer's renderObjects set.
     */
    update(inspector, mesh, _sceneRecord) {
        this._inspector = inspector;
        const renderer = inspector.getRenderer();
        if (!renderer) {
            this._setCompiling();
            return;
        }
        // Search the live RenderObjects set for a matching mesh
        let ro = null;
        for (const candidate of renderer._renderObjects.renderObjects) {
            if (candidate.mesh === mesh && candidate.nodeBuilderState) {
                ro = candidate;
                break;
            }
        }
        if (ro === null) {
            this._setCompiling();
            return;
        }
        this._renderObject = ro;
        this._stages = splitStages(ro.nodeBuilderState.vertexCode);
        this._renderCurrentStage();
    }
    /**
     * Update the panel directly from a RenderObject.
     * Used by the DrawCalls tab where we already have the RO.
     */
    updateFromRO(inspector, ro) {
        this._inspector = inspector;
        if (!ro.nodeBuilderState) {
            this._setCompiling();
            return;
        }
        // Skip expensive re-render if the RO and code haven't changed
        if (this._renderObject === ro)
            return;
        this._renderObject = ro;
        this._stages = splitStages(ro.nodeBuilderState.vertexCode);
        this._renderCurrentStage();
    }
    /**
     * Update the panel with compute shader WGSL code.
     * Used by the ComputeCalls tab.
     */
    updateFromCompute(code) {
        // Skip expensive re-render if the code hasn't changed
        if (this._computeCode === code)
            return;
        this._computeCode = code;
        this._stages = { vertex: '', fragment: '', full: '', compute: code };
        this._currentStage = 'compute';
        this._renderCurrentStage();
    }
    /**
     * The stage currently shown in the panel.
     */
    get currentStage() {
        return this._currentStage;
    }
    // -----------------------------------------------------------------------
    // Private — stage selection
    // -----------------------------------------------------------------------
    _selectStage(stage) {
        this._currentStage = stage;
        this._lastRenderedCode = null;
        this._selectionLocked = false;
        this._hidePopover();
        this._hoverVarName = null;
        for (const [s, btn] of this._stageButtons) {
            btn.classList.toggle('active', s === stage);
        }
        if (this._stages) {
            this._renderCurrentStage();
        }
    }
    _renderCurrentStage() {
        if (!this._stages)
            return;
        const code = this._stages[this._currentStage];
        // Don't rebuild the DOM (and wipe any text selection) if the code hasn't changed
        if (code === this._lastRenderedCode)
            return;
        this._lastRenderedCode = code;
        const lines = code.split('\n');
        const html = lines
            .map((line, i) => {
            const highlighted = highlightWGSL(line);
            return `<span class="shader-line" data-line="${i}">${highlighted}</span>`;
        })
            .join('');
        this._codeBlock.innerHTML = html;
    }
    // -----------------------------------------------------------------------
    // Private — hover / probe
    // -----------------------------------------------------------------------
    _onMouseLeave() {
        if (!this._selectionLocked) {
            this._hidePopover();
        }
    }
    _onLineHover(e) {
        // If a selection is locked, just reposition the popover as cursor moves
        if (this._selectionLocked) {
            if (this._popoverVisible)
                this._positionPopover(e.clientX, e.clientY);
            return;
        }
        // Probing only works for the fragment stage — vertex variables don't
        // exist in fs_main, so attempts on other stages produce a broken canvas.
        if (this._currentStage !== 'fragment') {
            this._hidePopover();
            return;
        }
        // Walk up from the hovered element to find the nearest .shader-line span
        let target = e.target;
        while (target && target !== this._codeBlock) {
            if (target.classList.contains('shader-line'))
                break;
            target = target.parentElement;
        }
        if (!target || target === this._codeBlock) {
            this._hidePopover();
            return;
        }
        const lineIndexStr = target.dataset['line'];
        if (lineIndexStr === undefined) {
            this._hidePopover();
            return;
        }
        const lineIndex = parseInt(lineIndexStr, 10);
        if (!this._stages) {
            this._hidePopover();
            return;
        }
        const lines = this._stages[this._currentStage].split('\n');
        const lineText = lines[lineIndex] ?? '';
        const probeTarget = extractProbeTarget(lineText);
        if (!probeTarget) {
            this._hidePopover();
            return;
        }
        // Position the popover near the cursor, keeping it on-screen
        this._positionPopover(e.clientX, e.clientY);
        // Only rebuild the probe canvas when the hovered expression changes
        if (probeTarget.expr === this._hoverVarName && this._popoverVisible)
            return;
        this._hoverVarName = probeTarget.expr;
        const ro = this._renderObject;
        if (!ro || !this._inspector) {
            this._hidePopover();
            return;
        }
        const probeCanvas = this._inspector.setProbe(probeTarget, ro);
        if (!probeCanvas) {
            this._hidePopover();
            return;
        }
        // Update popover content
        this._popoverLabel.textContent = probeTarget.expr;
        this._popoverCanvasSlot.innerHTML = '';
        this._popoverCanvasSlot.appendChild(probeCanvas);
        this._showPopover();
    }
    _positionPopover(cursorX, cursorY) {
        const pop = this._popover;
        const offset = 16;
        const vpW = window.innerWidth;
        const vpH = window.innerHeight;
        // Temporarily show to get natural dimensions
        const wasHidden = pop.style.display === 'none';
        if (wasHidden) {
            pop.style.visibility = 'hidden';
            pop.style.display = 'flex';
        }
        const pw = pop.offsetWidth || 180;
        const ph = pop.offsetHeight || 200;
        if (wasHidden) {
            pop.style.display = 'none';
            pop.style.visibility = '';
        }
        let left = cursorX + offset;
        let top = cursorY + offset;
        // Flip left if it would overflow right edge
        if (left + pw > vpW - 8)
            left = cursorX - pw - offset;
        // Clamp top
        if (top + ph > vpH - 8)
            top = vpH - ph - 8;
        if (top < 8)
            top = 8;
        pop.style.left = `${left}px`;
        pop.style.top = `${top}px`;
    }
    _showPopover() {
        this._popover.style.display = 'flex';
        this._popoverVisible = true;
    }
    _hidePopover() {
        this._popover.style.display = 'none';
        this._popoverVisible = false;
        this._hoverVarName = null;
        this._selectionLocked = false;
        this._inspector?.clearProbe();
    }
    /**
     * Called on `mouseup` inside the code block.  If the user has selected
     * a non-empty text range, treat the selected text as the probe expression.
     */
    _onSelectionEnd() {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) {
            this._selectionLocked = false;
            return;
        }
        // Probing only works for the fragment stage
        if (this._currentStage !== 'fragment') {
            this._selectionLocked = false;
            return;
        }
        const selectedText = sel.toString().trim();
        if (!selectedText) {
            this._selectionLocked = false;
            return;
        }
        // Walk up from anchorNode to find the .shader-line span
        let node = sel.anchorNode;
        let lineSpan = null;
        while (node && node !== this._codeBlock) {
            if (node instanceof HTMLElement && node.classList.contains('shader-line')) {
                lineSpan = node;
                break;
            }
            node = node.parentElement;
        }
        if (!lineSpan || !this._stages) {
            this._selectionLocked = false;
            return;
        }
        const lineIndexStr = lineSpan.dataset['line'];
        if (lineIndexStr === undefined) {
            this._selectionLocked = false;
            return;
        }
        const lineIndex = parseInt(lineIndexStr, 10);
        const lines = this._stages[this._currentStage].split('\n');
        const anchorLineText = lines[lineIndex] ?? '';
        const trimmedAnchor = anchorLineText.trim();
        let probeTarget;
        const letAnchorMatch = trimmedAnchor.match(/^let\s+(\w+)\s*(?::\s*[\w<>, ]+\s*)?=/);
        if (letAnchorMatch) {
            probeTarget = {
                expr: selectedText,
                anchor: letAnchorMatch[1],
                anchorKind: 'let_var',
            };
        }
        else if (trimmedAnchor.startsWith('return')) {
            probeTarget = {
                expr: selectedText,
                anchor: '__return__',
                anchorKind: 'return',
            };
        }
        else {
            probeTarget = {
                expr: selectedText,
                anchor: trimmedAnchor,
                anchorKind: 'assignment',
            };
        }
        const ro = this._renderObject;
        if (!ro || !this._inspector)
            return;
        // Avoid rebuilding if same selection
        const selKey = selectedText;
        if (selKey === this._hoverVarName && this._selectionLocked && this._popoverVisible)
            return;
        const probeCanvas = this._inspector.setProbe(probeTarget, ro);
        if (!probeCanvas)
            return;
        this._selectionLocked = true;
        this._hoverVarName = selKey;
        // Position near the selection (use caret coords as approximation)
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        this._positionPopover(rect.right, rect.bottom);
        this._popoverLabel.textContent = selectedText;
        this._popoverCanvasSlot.innerHTML = '';
        this._popoverCanvasSlot.appendChild(probeCanvas);
        this._showPopover();
    }
    _setCompiling() {
        this._stages = null;
        this._renderObject = null;
        this._lastRenderedCode = null;
        this._codeBlock.innerHTML = '<span class="wgsl-comment">// Compiling…</span>';
        this._hidePopover();
    }
    _copyCode(btn) {
        const src = this._stages ? this._stages[this._currentStage] : null;
        if (!src)
            return;
        navigator.clipboard.writeText(src);
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 350);
    }
}

/**
 * draw-calls.ts — Inspector "Draw Calls" tab.
 *
 * Surfaces renderer-level RenderObject data — one entry per GPU draw call.
 * ROs are grouped under their render pass (via ro.passId).
 *
 * When a RO is selected a detail panel appears with three sub-tabs:
 *   [Shader]   — reuses ShaderPanel (with probe hover/selection support)
 *   [Pipeline] — material / render-context state table
 *   [Bindings] — bind group layout table (uniform groups, textures, samplers, storage)
 *
 * Update strategy (60 fps concern):
 *   update() diffs by ro.id — only adds/removes items on structural changes.
 *   The static detail panel is only rebuilt when _selectedRO changes.
 */
// ---------------------------------------------------------------------------
// DrawCalls Tab
// ---------------------------------------------------------------------------
class DrawCalls extends Tab {
    list;
    /** ro.id → RONode for every currently-displayed RenderObject */
    _roNodes = new Map();
    /** Pass header items keyed by passId */
    _passHeaders = new Map();
    /** Currently selected RO */
    _selectedRO = null;
    // --- Detail panel ---
    _detailPanel;
    _detailSubBtns = new Map();
    _shaderPane;
    _pipelinePane;
    _bindingsPane;
    _shaderPanel;
    _currentSubTab = 'shader';
    constructor() {
        super('Draw Calls');
        // --- List (left column) ---
        const list = new List('Draw Call');
        list.setGridStyle('1fr');
        const scrollWrapper = document.createElement('div');
        scrollWrapper.className = 'list-scroll-wrapper scene-hierarchy-list';
        scrollWrapper.appendChild(list.domElement);
        // --- Detail panel (right column) ---
        const detailPanel = document.createElement('div');
        detailPanel.className = 'dc-detail-panel';
        detailPanel.style.display = 'none';
        // Sub-tab toolbar
        const toolbar = document.createElement('div');
        toolbar.className = 'dc-detail-toolbar';
        const subTabGroup = document.createElement('div');
        subTabGroup.className = 'shader-stage-group';
        const subTabs = ['shader', 'pipeline', 'bindings'];
        for (const st of subTabs) {
            const btn = document.createElement('button');
            btn.className = 'shader-stage-btn';
            btn.textContent = st.charAt(0).toUpperCase() + st.slice(1);
            btn.addEventListener('click', () => this._showDetailSubTab(st));
            subTabGroup.appendChild(btn);
            this._detailSubBtns.set(st, btn);
        }
        toolbar.appendChild(subTabGroup);
        detailPanel.appendChild(toolbar);
        // Shader pane
        this._shaderPanel = new ShaderPanel();
        const shaderPane = document.createElement('div');
        shaderPane.className = 'dc-detail-pane';
        shaderPane.appendChild(this._shaderPanel.domElement);
        this._shaderPane = shaderPane;
        // Pipeline pane
        const pipelinePane = document.createElement('div');
        pipelinePane.className = 'dc-detail-pane';
        this._pipelinePane = pipelinePane;
        // Bindings pane
        const bindingsPane = document.createElement('div');
        bindingsPane.className = 'dc-detail-pane';
        this._bindingsPane = bindingsPane;
        detailPanel.appendChild(shaderPane);
        detailPanel.appendChild(pipelinePane);
        detailPanel.appendChild(bindingsPane);
        this._detailPanel = detailPanel;
        // --- Root layout (list | detail) ---
        const layout = document.createElement('div');
        layout.className = 'scene-hierarchy-layout';
        layout.appendChild(scrollWrapper);
        layout.appendChild(detailPanel);
        this.content.appendChild(layout);
        this.list = list;
        // Activate initial sub-tab
        this._showDetailSubTab('shader');
    }
    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------
    /**
     * Called by Inspector._processFrame() every frame.
     * Only diffs by ro.id — does NOT repaint the detail panel unless the
     * selected RO changed.
     *
     * Structure: pass header items are top-level in the List; RO items are
     * children of their respective pass header (Item.add).  This gives proper
     * indent and uses the existing header-wrapper styling automatically.
     */
    update(inspector, renderer) {
        const liveROs = renderer._renderObjects.renderObjects;
        // ------------------------------------------------------------------
        // 1. Build a snapshot: passId → RO[] (skip internal meshes)
        // ------------------------------------------------------------------
        const passBuckets = new Map();
        for (const ro of liveROs) {
            if (_isInternalMesh(ro))
                continue;
            const passId = ro.passId || 'default';
            let bucket = passBuckets.get(passId);
            if (!bucket) {
                bucket = [];
                passBuckets.set(passId, bucket);
            }
            bucket.push(ro);
        }
        // ------------------------------------------------------------------
        // 2. Remove stale pass headers (and their children are auto-removed)
        // ------------------------------------------------------------------
        for (const [passId, headerItem] of this._passHeaders) {
            if (!passBuckets.has(passId)) {
                this.list.remove(headerItem);
                this._passHeaders.delete(passId);
                // Clean up tracked RO nodes that belonged to this pass
                for (const [id, node] of this._roNodes) {
                    if (node.passId === passId) {
                        this._roNodes.delete(id);
                        if (this._selectedRO?.id === id) {
                            this._selectedRO = null;
                            this._detailPanel.style.display = 'none';
                        }
                    }
                }
            }
        }
        // ------------------------------------------------------------------
        // 3. Remove stale RO items that disappeared from their pass
        // ------------------------------------------------------------------
        const liveIds = new Set();
        for (const bucket of passBuckets.values()) {
            for (const ro of bucket)
                liveIds.add(ro.id);
        }
        for (const [id, node] of this._roNodes) {
            if (!liveIds.has(id)) {
                // Remove from parent header item
                const headerItem = this._passHeaders.get(node.passId);
                headerItem?.remove(node.item);
                this._roNodes.delete(id);
                if (this._selectedRO?.id === id) {
                    this._selectedRO = null;
                    this._detailPanel.style.display = 'none';
                }
            }
        }
        // ------------------------------------------------------------------
        // 4. Ensure pass header items exist and add new RO children
        // ------------------------------------------------------------------
        for (const [passId, ros] of passBuckets) {
            // Ensure pass header exists in the List
            if (!this._passHeaders.has(passId)) {
                const nameEl = document.createElement('span');
                nameEl.className = 'hierarchy-name';
                nameEl.textContent = passId;
                const headerItem = new Item(nameEl);
                // Keep it open by default (header shows its children)
                this.list.add(headerItem);
                this._passHeaders.set(passId, headerItem);
            }
            const headerItem = this._passHeaders.get(passId);
            for (const ro of ros) {
                if (this._roNodes.has(ro.id))
                    continue;
                const nameEl = document.createElement('span');
                nameEl.className = 'hierarchy-name';
                nameEl.textContent = _roDisplayName(ro);
                const item = new Item(nameEl);
                item.itemRow.classList.add('actionable');
                const capturedRO = ro;
                item.itemRow.addEventListener('click', (e) => {
                    if (e.target.closest('.item-toggler'))
                        return;
                    this.selectRO(capturedRO, inspector);
                });
                // Nest under the pass header
                headerItem.add(item);
                this._roNodes.set(ro.id, {
                    id: ro.id,
                    ro,
                    item,
                    passId,
                });
            }
        }
        // ------------------------------------------------------------------
        // 5. Refresh shader panel if a RO is currently selected
        // ------------------------------------------------------------------
        if (this._selectedRO) {
            this._shaderPanel.updateFromRO(inspector, this._selectedRO);
        }
    }
    /**
     * Select a RO programmatically (also called on click).
     * Highlights the item and populates the detail panel.
     */
    selectRO(ro, inspector) {
        // Clear previous highlight
        if (this._selectedRO) {
            const prev = this._roNodes.get(this._selectedRO.id);
            prev?.item.itemRow.classList.remove('hierarchy-selected');
        }
        this._selectedRO = ro;
        const node = this._roNodes.get(ro.id);
        if (node)
            node.item.itemRow.classList.add('hierarchy-selected');
        // Show and populate detail panel
        this._detailPanel.style.display = 'flex';
        this._populateDetail(ro, inspector);
    }
    // -----------------------------------------------------------------------
    // Detail panel population
    // -----------------------------------------------------------------------
    _populateDetail(ro, inspector) {
        // Shader pane — delegate to ShaderPanel (reuses probe support)
        this._shaderPanel.updateFromRO(inspector, ro);
        // Pipeline pane
        this._pipelinePane.innerHTML = '';
        this._pipelinePane.appendChild(_buildPipelineTable(ro));
        // Bindings pane
        this._bindingsPane.innerHTML = '';
        if (ro.nodeBuilderState) {
            this._bindingsPane.appendChild(buildBindingsTable(ro.nodeBuilderState));
        }
        else {
            const hint = document.createElement('div');
            hint.className = 'dc-section-header';
            hint.textContent = 'Not yet compiled';
            this._bindingsPane.appendChild(hint);
        }
        // Keep active sub-tab visible
        this._showDetailSubTab(this._currentSubTab);
    }
    _showDetailSubTab(tab) {
        this._currentSubTab = tab;
        for (const [st, btn] of this._detailSubBtns) {
            btn.classList.toggle('active', st === tab);
        }
        const panes = {
            shader: this._shaderPane,
            pipeline: this._pipelinePane,
            bindings: this._bindingsPane,
        };
        for (const [st, pane] of Object.entries(panes)) {
            pane.classList.toggle('active', st === tab);
        }
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function _isInternalMesh(ro) {
    // Skip gpucat-internal meshes (e.g. fullscreen quad used by post-processing)
    const name = ro.mesh.name ?? '';
    return name.startsWith('__') && name.endsWith('__');
}
function _roDisplayName(ro) {
    const meshName = ro.mesh.name || `Mesh #${ro.mesh.objectId}`;
    return meshName;
}
// ---------------------------------------------------------------------------
// Pipeline table
// ---------------------------------------------------------------------------
function _buildPipelineTable(ro) {
    const container = document.createElement('div');
    container.className = 'dc-kv-table';
    const m = ro.material;
    const rc = ro.renderContext;
    const rows = [
        ['transparent', String(m.transparent)],
        ['depthTest', String(m.depthTest)],
        ['depthWrite', String(m.depthWrite)],
        ['depthCompare', m.depthCompare],
        ['cullMode', m.cullMode],
        ['alphaToCoverage', String(m.alphaToCoverage)],
        ['blend', m.blend ? JSON.stringify(m.blend) : 'none'],
        ['sampleCount', String(rc.sampleCount)],
        ['depth', String(rc.depth)],
        ['stencil', String(rc.stencil)],
    ];
    // Geometry / draw params
    const geo = ro.geometry;
    rows.push(['drawRange.start', String(geo.drawRange.start)]);
    rows.push(['drawRange.count', String(geo.drawRange.count)]);
    if (geo.index && geo.index.array) {
        rows.push(['indexFormat', getIndexFormat(geo.index.array) ?? 'unknown']);
        rows.push(['indexCount', String(geo.index.array.length)]);
    }
    rows.push(['instanceCount', String(ro.mesh.count)]);
    for (const [k, v] of rows) {
        container.appendChild(kvRow(k, v));
    }
    return container;
}
// ---------------------------------------------------------------------------
// Bindings table (exported for reuse by ComputeCalls)
// ---------------------------------------------------------------------------
function buildBindingsTable(state) {
    const container = document.createElement('div');
    const { uniformGroups, textures, samplers, storage, vertexBufferGroups, varyings, builtinsUsed, } = state;
    // --- Vertex Buffer Groups ---
    if (vertexBufferGroups.length > 0) {
        container.appendChild(sectionHeader('Vertex Buffers'));
        const table = document.createElement('div');
        table.className = 'dc-kv-table';
        for (let i = 0; i < vertexBufferGroups.length; i++) {
            const group = vertexBufferGroups[i];
            const source = group.name !== null ? group.name : 'buffer';
            const stepMode = group.instanced ? 'instance' : 'vertex';
            table.appendChild(kvRow(`slot ${i} (${source})`, `stride=${group.stride}, ${stepMode}, ${group.attributes.length} attr${group.attributes.length > 1 ? 's' : ''}`));
            for (const attr of group.attributes) {
                const memberEl = document.createElement('div');
                memberEl.className = 'dc-kv-row';
                memberEl.style.paddingLeft = '16px';
                const k = document.createElement('span');
                k.className = 'dc-kv-key';
                k.textContent = `  @location(${attr.shaderLocation})`;
                const v = document.createElement('span');
                v.className = 'dc-kv-val';
                v.textContent = `${attr.type}, offset=${attr.offset}`;
                memberEl.appendChild(k);
                memberEl.appendChild(v);
                table.appendChild(memberEl);
            }
        }
        container.appendChild(table);
    }
    // --- Varyings ---
    if (varyings.length > 0) {
        container.appendChild(sectionHeader('Varyings'));
        const table = document.createElement('div');
        table.className = 'dc-kv-table';
        for (const v of varyings) {
            let interp = '';
            if (v.interpolationType) {
                interp = ` @interpolate(${v.interpolationType}`;
                if (v.interpolationSampling)
                    interp += `, ${v.interpolationSampling}`;
                interp += ')';
            }
            table.appendChild(kvRow(`@location(${v.location}) ${v.name}`, `${v.type}${interp}`));
        }
        container.appendChild(table);
    }
    // --- Builtins ---
    if (builtinsUsed.size > 0) {
        container.appendChild(sectionHeader('Builtins'));
        const table = document.createElement('div');
        table.className = 'dc-kv-table';
        for (const b of builtinsUsed) {
            table.appendChild(kvRow(`@builtin(${b})`, ''));
        }
        container.appendChild(table);
    }
    // --- Uniform groups ---
    if (uniformGroups.length > 0) {
        container.appendChild(sectionHeader('Uniform Groups'));
        const table = document.createElement('div');
        table.className = 'dc-kv-table';
        for (const ug of uniformGroups) {
            table.appendChild(kvRow(`@group(${ug.groupIndex}) ${ug.groupName}`, `${ug.totalBytes} bytes, ${ug.members.length} members`));
            for (const m of ug.members) {
                const memberEl = document.createElement('div');
                memberEl.className = 'dc-kv-row';
                memberEl.style.paddingLeft = '16px';
                const k = document.createElement('span');
                k.className = 'dc-kv-key';
                k.textContent = `  ${m.uniformId}`;
                const v = document.createElement('span');
                v.className = 'dc-kv-val';
                v.textContent = `${m.schema.wgslType} (${m.size}b)`;
                memberEl.appendChild(k);
                memberEl.appendChild(v);
                table.appendChild(memberEl);
            }
        }
        container.appendChild(table);
    }
    // --- Textures ---
    if (textures.length > 0) {
        container.appendChild(sectionHeader('Textures'));
        const table = document.createElement('div');
        table.className = 'dc-kv-table';
        for (const t of textures) {
            table.appendChild(kvRow(`@group(${t.group}) @binding(${t.binding})`, `${t.type} (${t.textureId})`));
        }
        container.appendChild(table);
    }
    // --- Samplers ---
    if (samplers.length > 0) {
        container.appendChild(sectionHeader('Samplers'));
        const table = document.createElement('div');
        table.className = 'dc-kv-table';
        for (const s of samplers) {
            table.appendChild(kvRow(`@group(${s.group}) @binding(${s.binding})`, s.type));
        }
        container.appendChild(table);
    }
    // --- Storage ---
    if (storage.length > 0) {
        container.appendChild(sectionHeader('Storage Buffers'));
        const table = document.createElement('div');
        table.className = 'dc-kv-table';
        for (const st of storage) {
            table.appendChild(kvRow(`@group(${st.group}) @binding(${st.binding}) ${st.name}`, `${st.type} [${st.access}]`));
        }
        container.appendChild(table);
    }
    if (vertexBufferGroups.length === 0 &&
        varyings.length === 0 &&
        builtinsUsed.size === 0 &&
        uniformGroups.length === 0 &&
        textures.length === 0 &&
        samplers.length === 0 &&
        storage.length === 0) {
        const hint = document.createElement('div');
        hint.className = 'dc-section-header';
        hint.textContent = 'No bindings';
        container.appendChild(hint);
    }
    return container;
}
// ---------------------------------------------------------------------------
// DOM helpers (exported for reuse by ComputeCalls)
// ---------------------------------------------------------------------------
function kvRow(key, value) {
    const row = document.createElement('div');
    row.className = 'dc-kv-row';
    const k = document.createElement('span');
    k.className = 'dc-kv-key';
    k.textContent = key;
    const v = document.createElement('span');
    v.className = 'dc-kv-val';
    v.textContent = value;
    row.appendChild(k);
    row.appendChild(v);
    return row;
}
function sectionHeader(text) {
    const el = document.createElement('div');
    el.className = 'dc-section-header';
    el.textContent = text;
    return el;
}

/**
 * compute-calls.ts — Inspector "Compute Calls" tab.
 *
 * Surfaces compute node data — one entry per compute dispatch.
 *
 * When a compute node is selected, a detail panel appears with two sub-tabs:
 *   [Shader]   — displays the compute WGSL using ShaderPanel in compute mode
 *   [Bindings] — bind group layout table (uniform groups, storage buffers)
 *
 * Mirrors the structure of draw-calls.ts.
 */
// ---------------------------------------------------------------------------
// ComputeCalls Tab
// ---------------------------------------------------------------------------
class ComputeCalls extends Tab {
    list;
    /** node.id → ComputeNodeRecord for every currently-displayed ComputeNode */
    _nodeRecords = new Map();
    /** Currently selected ComputeNode */
    _selectedNode = null;
    // --- Detail panel ---
    _detailPanel;
    _detailSubBtns = new Map();
    _shaderPane;
    _bindingsPane;
    _shaderPanel;
    _metaPane;
    _currentSubTab = 'shader';
    constructor() {
        super('Compute');
        // --- List (left column) ---
        const list = new List('Compute Node');
        list.setGridStyle('1fr');
        const scrollWrapper = document.createElement('div');
        scrollWrapper.className = 'list-scroll-wrapper scene-hierarchy-list';
        scrollWrapper.appendChild(list.domElement);
        // --- Detail panel (right column) ---
        const detailPanel = document.createElement('div');
        detailPanel.className = 'dc-detail-panel';
        detailPanel.style.display = 'none';
        // Metadata row (workgroup size)
        const metaPane = document.createElement('div');
        metaPane.className = 'dc-meta-pane';
        this._metaPane = metaPane;
        // Sub-tab toolbar
        const toolbar = document.createElement('div');
        toolbar.className = 'dc-detail-toolbar';
        const subTabGroup = document.createElement('div');
        subTabGroup.className = 'shader-stage-group';
        const subTabs = ['shader', 'bindings'];
        for (const st of subTabs) {
            const btn = document.createElement('button');
            btn.className = 'shader-stage-btn';
            btn.textContent = st.charAt(0).toUpperCase() + st.slice(1);
            btn.addEventListener('click', () => this._showDetailSubTab(st));
            subTabGroup.appendChild(btn);
            this._detailSubBtns.set(st, btn);
        }
        toolbar.appendChild(subTabGroup);
        detailPanel.appendChild(metaPane);
        detailPanel.appendChild(toolbar);
        // Shader pane (using ShaderPanel in compute mode)
        this._shaderPanel = new ShaderPanel('compute');
        const shaderPane = document.createElement('div');
        shaderPane.className = 'dc-detail-pane';
        shaderPane.appendChild(this._shaderPanel.domElement);
        this._shaderPane = shaderPane;
        // Bindings pane
        const bindingsPane = document.createElement('div');
        bindingsPane.className = 'dc-detail-pane';
        this._bindingsPane = bindingsPane;
        detailPanel.appendChild(shaderPane);
        detailPanel.appendChild(bindingsPane);
        this._detailPanel = detailPanel;
        // --- Root layout (list | detail) ---
        const layout = document.createElement('div');
        layout.className = 'scene-hierarchy-layout';
        layout.appendChild(scrollWrapper);
        layout.appendChild(detailPanel);
        this.content.appendChild(layout);
        this.list = list;
        // Activate initial sub-tab
        this._showDetailSubTab('shader');
    }
    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------
    /**
     * Called by Inspector._processFrame() every frame when compute passes exist.
     * Diffs by node.id — only adds/removes items on structural changes.
     */
    update(inspector, renderer) {
        const liveNodes = inspector.computeNodes;
        // ------------------------------------------------------------------
        // 1. Remove stale node items
        // ------------------------------------------------------------------
        for (const [id, record] of this._nodeRecords) {
            if (!liveNodes.has(id)) {
                this.list.remove(record.item);
                this._nodeRecords.delete(id);
                if (this._selectedNode?.id === id) {
                    this._selectedNode = null;
                    this._detailPanel.style.display = 'none';
                }
            }
        }
        // ------------------------------------------------------------------
        // 2. Add new node items
        // ------------------------------------------------------------------
        for (const [id, node] of liveNodes) {
            if (this._nodeRecords.has(id))
                continue;
            const nameEl = document.createElement('span');
            nameEl.className = 'hierarchy-name';
            nameEl.textContent = _nodeDisplayName(node);
            const item = new Item(nameEl);
            item.itemRow.classList.add('actionable');
            const capturedNode = node;
            item.itemRow.addEventListener('click', (e) => {
                if (e.target.closest('.item-toggler'))
                    return;
                this.selectNode(capturedNode, inspector, renderer);
            });
            this.list.add(item);
            this._nodeRecords.set(id, {
                id,
                node,
                item,
            });
        }
        // ------------------------------------------------------------------
        // 3. Refresh detail panel if a node is currently selected
        // ------------------------------------------------------------------
        if (this._selectedNode && liveNodes.has(this._selectedNode.id)) {
            this._refreshShaderPanel(renderer);
        }
    }
    /**
     * Select a compute node programmatically (also called on click).
     * Highlights the item and populates the detail panel.
     */
    selectNode(node, inspector, renderer) {
        // Clear previous highlight
        if (this._selectedNode) {
            const prev = this._nodeRecords.get(this._selectedNode.id);
            prev?.item.itemRow.classList.remove('hierarchy-selected');
        }
        this._selectedNode = node;
        const record = this._nodeRecords.get(node.id);
        if (record)
            record.item.itemRow.classList.add('hierarchy-selected');
        // Show and populate detail panel
        this._detailPanel.style.display = 'flex';
        this._populateDetail(node, inspector, renderer);
    }
    // -----------------------------------------------------------------------
    // Detail panel population
    // -----------------------------------------------------------------------
    _populateDetail(node, _inspector, renderer) {
        // Metadata pane — workgroup size
        this._metaPane.innerHTML = '';
        const ws = node.workgroupSize;
        const metaTable = document.createElement('div');
        metaTable.className = 'dc-kv-table';
        metaTable.appendChild(kvRow('Workgroup Size', `[${ws[0]}, ${ws[1]}, ${ws[2]}]`));
        this._metaPane.appendChild(metaTable);
        // Shader pane — delegate to ShaderPanel (compute mode)
        this._refreshShaderPanel(renderer);
        // Bindings pane
        this._bindingsPane.innerHTML = '';
        const entry = lookupCompute(renderer._pipelines, node);
        if (entry) {
            const nbs = entry.nodeBuilderState;
            this._bindingsPane.appendChild(buildBindingsTable(nbs));
        }
        else {
            const hint = document.createElement('div');
            hint.className = 'dc-section-header';
            hint.textContent = 'Not yet compiled';
            this._bindingsPane.appendChild(hint);
        }
        // Keep active sub-tab visible
        this._showDetailSubTab(this._currentSubTab);
    }
    _refreshShaderPanel(renderer) {
        if (!this._selectedNode)
            return;
        const entry = lookupCompute(renderer._pipelines, this._selectedNode);
        if (entry) {
            this._shaderPanel.updateFromCompute(entry.nodeBuilderState.computeCode);
        }
    }
    _showDetailSubTab(tab) {
        this._currentSubTab = tab;
        for (const [st, btn] of this._detailSubBtns) {
            btn.classList.toggle('active', st === tab);
        }
        const panes = {
            shader: this._shaderPane,
            bindings: this._bindingsPane,
        };
        for (const [st, pane] of Object.entries(panes)) {
            pane.classList.toggle('active', st === tab);
        }
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function _nodeDisplayName(node) {
    if (node.name)
        return node.name;
    const id = node.id;
    if (id.length > 32) {
        return id.slice(0, 29) + '...';
    }
    return id;
}

// Max number of flat entries retained during recording (~3 min at 60fps with ~20 entries/frame)
const MAX_ENTRIES = 200_000;
// Entries narrower than this in CSS pixels are skipped in the detail view — no point drawing sub-pixel bars
const MIN_BAR_PX = 1;
// Layout
const ROW_HEIGHT = 20;
const ROW_GAP = 2;
const TOOLBAR_HEIGHT = 28;
const OVERVIEW_HEIGHT = 40;
const RULER_HEIGHT = 24;
const TRACK_LABEL_WIDTH = 40;
const TRACK_PADDING = 8;
const MIN_CPU_TRACK_HEIGHT = 120;
const MIN_VIEWPORT_WIDTH_PX = 4;
// Colors
const COLORS = {
    marker: '#9c7ce5',
    render: '#64b5f6',
    compute: '#ffb74d',
    gpu: '#81c784',
    bg: '#1a1a1a',
    trackBg: '#222222',
    trackBgAlt: '#252525',
    ruler: '#2d2d2d',
    toolbar: '#2d2d2d',
    text: '#e0e0e0',
    textDim: '#888888',
    grid: '#3a3a3a',
    gridMajor: '#4a4a4a',
    border: '#555555',
    now: '#ff5252',
    viewport: 'rgba(100, 180, 255, 0.25)',
    viewportBorder: 'rgba(100, 180, 255, 0.6)',
    recording: '#f44336',
};
/** Get gpuMs from a FlatEntry (reads from source for live updates) */
function getGpuMs(entry) {
    if (!entry.sourceEntry || entry.sourceEntry.kind === 'marker')
        return null;
    return entry.sourceEntry.gpuMs;
}
/** Get gpuStartMs for a FlatEntry (CPU end time = GPU start time) */
function getGpuStartMs(entry) {
    const gpuMs = getGpuMs(entry);
    if (gpuMs === null || gpuMs <= 0)
        return null;
    return entry.startMs + entry.durationMs;
}
class PerformanceTimeline extends Tab {
    _canvas;
    _ctx;
    _tooltip;
    _toolbar;
    _recordBtn;
    _clearBtn;
    _statusText;
    // Recording state
    _isRecording = false;
    _entries = [];
    _recordingStartMs = 0;
    _recordingEndMs = 0;
    /** Whether the timeline is currently recording. */
    get isRecording() {
        return this._isRecording;
    }
    // Viewport state (in ms, relative to recording start)
    _viewportStartMs = 0;
    _viewportDurationMs = 2000; // Visible window width in ms
    _followNow = true;
    // Interaction state
    _isDraggingViewport = false;
    _dragStartX = 0;
    _dragStartViewportMs = 0;
    _isPanningDetail = false;
    _panStartX = 0;
    _panStartViewportMs = 0;
    _maxCpuDepth = 0;
    _needsRender = false;
    _rafId = 0;
    constructor(options = {}) {
        super('Perf Timeline', options);
        // Note: don't set display here - it's controlled by .profiler-content.active class
        this.content.style.position = 'relative';
        this.content.style.flexDirection = 'column';
        this.content.style.height = '100%';
        this.content.style.background = COLORS.bg;
        this.content.style.overflow = 'hidden';
        this.content.style.userSelect = 'none';
        // Toolbar
        this._toolbar = document.createElement('div');
        this._toolbar.style.cssText = `
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 8px;
            background: ${COLORS.toolbar};
            border-bottom: 1px solid ${COLORS.border};
            height: ${TOOLBAR_HEIGHT}px;
            box-sizing: border-box;
        `;
        this._recordBtn = document.createElement('button');
        this._recordBtn.innerHTML = '&#9679; Record';
        this._recordBtn.style.cssText = this._buttonStyle();
        this._recordBtn.addEventListener('click', () => this._toggleRecording());
        this._clearBtn = document.createElement('button');
        this._clearBtn.textContent = 'Clear';
        this._clearBtn.style.cssText = this._buttonStyle();
        this._clearBtn.addEventListener('click', () => this._clear());
        this._statusText = document.createElement('span');
        this._statusText.style.cssText = `
            font: 11px monospace;
            color: ${COLORS.textDim};
            margin-left: auto;
        `;
        this._updateStatus();
        this._toolbar.appendChild(this._recordBtn);
        this._toolbar.appendChild(this._clearBtn);
        this._toolbar.appendChild(this._statusText);
        this.content.appendChild(this._toolbar);
        // Canvas
        this._canvas = document.createElement('canvas');
        this._canvas.style.cssText = 'width: 100%; flex: 1; display: block;';
        this.content.appendChild(this._canvas);
        this._ctx = this._canvas.getContext('2d');
        // Tooltip
        this._tooltip = document.createElement('div');
        this._tooltip.style.cssText = `
            position: absolute;
            background: #333;
            color: ${COLORS.text};
            padding: 8px 10px;
            border-radius: 4px;
            font: 11px/1.4 monospace;
            pointer-events: none;
            z-index: 1000;
            display: none;
            border: 1px solid ${COLORS.border};
            box-shadow: 0 2px 8px rgba(0,0,0,0.4);
            white-space: nowrap;
        `;
        this.content.appendChild(this._tooltip);
        // Event listeners
        this._canvas.addEventListener('mousedown', this._onMouseDown.bind(this));
        this._canvas.addEventListener('mousemove', this._onMouseMove.bind(this));
        this._canvas.addEventListener('mouseup', this._onMouseUp.bind(this));
        this._canvas.addEventListener('mouseleave', this._onMouseLeave.bind(this));
        this._canvas.addEventListener('wheel', this._onWheel.bind(this), { passive: false });
        const ro = new ResizeObserver(() => this._scheduleRender());
        ro.observe(this.content);
    }
    _buttonStyle() {
        return `
            padding: 3px 10px;
            font: 11px monospace;
            background: #404040;
            color: ${COLORS.text};
            border: 1px solid ${COLORS.border};
            border-radius: 3px;
            cursor: pointer;
        `;
    }
    _toggleRecording() {
        this._isRecording = !this._isRecording;
        if (this._isRecording) {
            this._entries = [];
            this._recordingStartMs = performance.now();
            this._recordingEndMs = this._recordingStartMs;
            this._viewportStartMs = 0;
            this._followNow = true;
            this._recordBtn.innerHTML = '&#9632; Stop';
            this._recordBtn.style.color = COLORS.recording;
        }
        else {
            this._recordBtn.innerHTML = '&#9679; Record';
            this._recordBtn.style.color = COLORS.text;
            this._followNow = false;
            this._scheduleRender();
        }
        this._updateStatus();
    }
    _clear() {
        this._entries = [];
        this._recordingStartMs = performance.now();
        this._recordingEndMs = this._recordingStartMs;
        this._viewportStartMs = 0;
        this._maxCpuDepth = 0;
        this._followNow = true;
        this._updateStatus();
        this._scheduleRender();
    }
    _updateStatus() {
        const duration = (this._recordingEndMs - this._recordingStartMs) / 1000;
        const entries = this._entries.length;
        if (this._isRecording) {
            this._statusText.innerHTML = `<span style="color:${COLORS.recording}">&#9679;</span> Recording: ${duration.toFixed(1)}s | ${entries} entries`;
        }
        else if (entries > 0) {
            this._statusText.textContent = `Recorded: ${duration.toFixed(1)}s | ${entries} entries`;
        }
        else {
            this._statusText.textContent = 'Click Record to start';
        }
    }
    update(_inspector, frame) {
        if (!this._isRecording)
            return;
        const now = performance.now();
        const frameStartMs = now - frame.cpuMs;
        this._flattenFrame(frame.timeline, frameStartMs);
        this._recordingEndMs = now;
        // Evict oldest entries if we've exceeded the cap, sliding the recording window forward
        if (this._entries.length > MAX_ENTRIES) {
            const drop = this._entries.length - MAX_ENTRIES;
            const shiftMs = this._entries[drop].startMs;
            this._entries = this._entries.slice(drop);
            for (const e of this._entries)
                e.startMs -= shiftMs;
            this._recordingStartMs += shiftMs;
            this._viewportStartMs = Math.max(0, this._viewportStartMs - shiftMs);
        }
        // Auto-follow "now" if enabled
        if (this._followNow) {
            const recordingDuration = this._recordingEndMs - this._recordingStartMs;
            this._viewportStartMs = Math.max(0, recordingDuration - this._viewportDurationMs);
        }
        this._updateStatus();
        // Don't render while recording — render once when recording stops
    }
    _flattenFrame(entries, frameStartMs, depth = 0) {
        for (const entry of entries) {
            const absStartMs = frameStartMs + entry.startTime;
            const relStartMs = absStartMs - this._recordingStartMs;
            this._entries.push({
                name: entry.name,
                kind: entry.kind,
                depth,
                startMs: relStartMs,
                durationMs: entry.cpuMs,
                sourceEntry: entry.kind !== 'marker' ? entry : null,
            });
            if (depth > this._maxCpuDepth)
                this._maxCpuDepth = depth;
            if (entry.children.length > 0) {
                this._flattenFrame(entry.children, frameStartMs, depth + 1);
            }
        }
    }
    scheduleRender() {
        this._scheduleRender();
    }
    _scheduleRender() {
        if (this._needsRender)
            return;
        this._needsRender = true;
        if (this._rafId)
            cancelAnimationFrame(this._rafId);
        this._rafId = requestAnimationFrame(() => {
            this._needsRender = false;
            this._render();
        });
    }
    _render() {
        const canvas = this._canvas;
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = rect.width;
        const h = rect.height;
        if (w === 0 || h === 0)
            return;
        if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
            canvas.width = w * dpr;
            canvas.height = h * dpr;
        }
        const ctx = this._ctx;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // Clear
        ctx.fillStyle = COLORS.bg;
        ctx.fillRect(0, 0, w, h);
        const recordingDuration = this._recordingEndMs - this._recordingStartMs;
        if (recordingDuration <= 0 || this._entries.length === 0) {
            ctx.fillStyle = COLORS.textDim;
            ctx.font = '12px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(this._isRecording ? 'Recording...' : 'No data recorded', w / 2, h / 2);
            ctx.textAlign = 'left';
            return;
        }
        // Layout
        const rulerY = OVERVIEW_HEIGHT;
        const detailY = OVERVIEW_HEIGHT + RULER_HEIGHT;
        const detailH = h - detailY;
        const chartWidth = w - TRACK_LABEL_WIDTH;
        // Draw overview
        this._drawOverview(ctx, w, OVERVIEW_HEIGHT, recordingDuration, chartWidth);
        // Draw ruler
        this._drawRuler(ctx, w, rulerY, chartWidth);
        // Draw detail tracks
        this._drawDetail(ctx, w, detailY, detailH, chartWidth);
        // Draw "now" line if recording and following
        if (this._isRecording && this._followNow) {
            ctx.strokeStyle = COLORS.now;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(w - 1, rulerY);
            ctx.lineTo(w - 1, h);
            ctx.stroke();
        }
    }
    _drawOverview(ctx, w, h, recordingDuration, chartWidth) {
        // Background
        ctx.fillStyle = COLORS.ruler;
        ctx.fillRect(0, 0, w, h);
        // Mini bars - simplified view
        const pxPerMs = chartWidth / recordingDuration;
        const barHeight = 4;
        for (const entry of this._entries) {
            if (entry.kind === 'marker')
                continue; // Skip markers in overview for clarity
            const x = TRACK_LABEL_WIDTH + entry.startMs * pxPerMs;
            const barW = Math.max(entry.durationMs * pxPerMs, 1);
            const y = h / 2 - barHeight / 2 + (entry.depth * 2);
            ctx.fillStyle = COLORS[entry.kind];
            ctx.fillRect(x, y, barW, barHeight);
        }
        // Viewport indicator
        const viewportX = TRACK_LABEL_WIDTH + (this._viewportStartMs / recordingDuration) * chartWidth;
        const viewportW = Math.max((this._viewportDurationMs / recordingDuration) * chartWidth, MIN_VIEWPORT_WIDTH_PX);
        ctx.fillStyle = COLORS.viewport;
        ctx.fillRect(viewportX, 0, viewportW, h);
        ctx.strokeStyle = COLORS.viewportBorder;
        ctx.lineWidth = 1;
        ctx.strokeRect(viewportX, 0, viewportW, h);
        // Resize handles
        ctx.fillStyle = COLORS.viewportBorder;
        ctx.fillRect(viewportX, 0, 3, h);
        ctx.fillRect(viewportX + viewportW - 3, 0, 3, h);
        // Label
        ctx.fillStyle = COLORS.textDim;
        ctx.font = '9px monospace';
        ctx.fillText('Overview', 4, 12);
    }
    _drawRuler(ctx, w, y, chartWidth) {
        ctx.fillStyle = COLORS.ruler;
        ctx.fillRect(0, y, w, RULER_HEIGHT);
        ctx.strokeStyle = COLORS.grid;
        ctx.fillStyle = COLORS.textDim;
        ctx.font = '10px monospace';
        ctx.lineWidth = 1;
        const pxPerMs = chartWidth / this._viewportDurationMs;
        const gridInterval = this._calculateGridInterval(this._viewportDurationMs, chartWidth);
        const viewportEndMs = this._viewportStartMs + this._viewportDurationMs;
        const recordingDuration = this._recordingEndMs - this._recordingStartMs;
        // Offset for when recording is shorter than viewport (entries should appear near right edge)
        let drawOffsetPx = 0;
        if (this._isRecording && this._followNow && recordingDuration < this._viewportDurationMs) {
            drawOffsetPx = (this._viewportDurationMs - recordingDuration) * pxPerMs;
        }
        const firstGrid = Math.ceil(this._viewportStartMs / gridInterval) * gridInterval;
        for (let ms = firstGrid; ms <= viewportEndMs; ms += gridInterval) {
            const x = TRACK_LABEL_WIDTH + (ms - this._viewportStartMs) * pxPerMs + drawOffsetPx;
            if (x < TRACK_LABEL_WIDTH || x > w)
                continue;
            ctx.beginPath();
            ctx.moveTo(x, y + RULER_HEIGHT - 6);
            ctx.lineTo(x, y + RULER_HEIGHT);
            ctx.stroke();
            // Format label based on zoom level and whether we're following live
            const label = this._formatTimeLabel(ms, recordingDuration, gridInterval);
            ctx.fillText(label, x + 2, y + RULER_HEIGHT - 9);
        }
    }
    _formatTimeLabel(ms, recordingDuration, gridInterval) {
        // When following live, show time relative to "now"
        if (this._isRecording && this._followNow) {
            const relativeMs = ms - recordingDuration;
            if (Math.abs(relativeMs) < 1) {
                return 'now';
            }
            return this._formatMs(relativeMs, gridInterval);
        }
        // Otherwise show absolute time from recording start
        return this._formatMs(ms, gridInterval);
    }
    _formatMs(ms, gridInterval) {
        const absMs = Math.abs(ms);
        const sign = ms < 0 ? '-' : '';
        // Show decimal precision based on grid interval
        if (gridInterval < 0.1) {
            // Sub-0.1ms (microsecond range): show 3 decimal places
            if (absMs < 1000) {
                return `${sign}${absMs.toFixed(3)}ms`;
            }
            return `${sign}${(absMs / 1000).toFixed(4)}s`;
        }
        else if (gridInterval < 1) {
            // Sub-1ms intervals: show 2 decimal places
            if (absMs < 1000) {
                return `${sign}${absMs.toFixed(2)}ms`;
            }
            return `${sign}${(absMs / 1000).toFixed(3)}s`;
        }
        else if (gridInterval < 10) {
            // Sub-10ms intervals: show 2 decimal places
            if (absMs < 1000) {
                return `${sign}${absMs.toFixed(2)}ms`;
            }
            return `${sign}${(absMs / 1000).toFixed(3)}s`;
        }
        else if (gridInterval < 100) {
            // 10-100ms intervals: show 1 decimal place
            if (absMs < 1000) {
                return `${sign}${absMs.toFixed(1)}ms`;
            }
            return `${sign}${(absMs / 1000).toFixed(2)}s`;
        }
        else {
            // Coarser intervals: integer ms or 1 decimal second
            if (absMs < 1000) {
                return `${sign}${Math.round(absMs)}ms`;
            }
            return `${sign}${(absMs / 1000).toFixed(1)}s`;
        }
    }
    _calculateGridInterval(durationMs, widthPx) {
        const targetPx = 80; // Target pixels between grid lines
        const msPerPx = durationMs / widthPx;
        const targetMs = msPerPx * targetPx;
        // Intervals from microseconds to seconds for extreme zoom levels
        const intervals = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
        for (const interval of intervals) {
            if (interval >= targetMs)
                return interval;
        }
        return 10000;
    }
    _drawDetail(ctx, w, y, h, chartWidth) {
        // Track backgrounds
        const cpuTrackH = Math.max((this._maxCpuDepth + 1) * (ROW_HEIGHT + ROW_GAP) + TRACK_PADDING * 2, MIN_CPU_TRACK_HEIGHT);
        const gpuTrackY = y + cpuTrackH;
        const gpuTrackH = ROW_HEIGHT + TRACK_PADDING * 2;
        ctx.fillStyle = COLORS.trackBg;
        ctx.fillRect(0, y, w, cpuTrackH);
        ctx.fillStyle = COLORS.trackBgAlt;
        ctx.fillRect(0, gpuTrackY, w, gpuTrackH);
        // Track labels
        ctx.fillStyle = COLORS.textDim;
        ctx.font = 'bold 10px monospace';
        ctx.fillText('CPU', 6, y + 14);
        ctx.fillText('GPU', 6, gpuTrackY + 14);
        // Separator
        ctx.strokeStyle = COLORS.gridMajor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, gpuTrackY);
        ctx.lineTo(w, gpuTrackY);
        ctx.stroke();
        // Grid lines
        this._drawGridLines(ctx, w, y, h, chartWidth);
        // When following "now", we want entries positioned so "now" (recordingDuration) is at the right edge
        // viewportStartMs may be 0 when recording is short, but we still want entries near the right
        const recordingDuration = this._recordingEndMs - this._recordingStartMs;
        const pxPerMs = chartWidth / this._viewportDurationMs;
        // Offset to apply: when following and recording < viewport, shift entries right
        let drawOffsetPx = 0;
        if (this._isRecording && this._followNow && recordingDuration < this._viewportDurationMs) {
            // "now" should be at right edge, so offset = (viewportDuration - recordingDuration) worth of pixels
            drawOffsetPx = (this._viewportDurationMs - recordingDuration) * pxPerMs;
        }
        const viewportEndMs = this._viewportStartMs + this._viewportDurationMs;
        for (const entry of this._entries) {
            const entryEndMs = entry.startMs + entry.durationMs;
            if (entryEndMs < this._viewportStartMs || entry.startMs > viewportEndMs)
                continue;
            const barW = entry.durationMs * pxPerMs;
            if (barW < MIN_BAR_PX)
                continue;
            // CPU bar
            const x = TRACK_LABEL_WIDTH + (entry.startMs - this._viewportStartMs) * pxPerMs + drawOffsetPx;
            const barY = y + TRACK_PADDING + entry.depth * (ROW_HEIGHT + ROW_GAP);
            this._drawBar(ctx, x, barY, Math.max(barW, 2), ROW_HEIGHT, entry.kind, entry.name);
            // GPU bar (read from source entry for live async updates)
            const gpuMs = getGpuMs(entry);
            const gpuStartMs = getGpuStartMs(entry);
            if (gpuMs !== null && gpuMs > 0 && gpuStartMs !== null) {
                const gpuBarW = gpuMs * pxPerMs;
                if (gpuBarW >= MIN_BAR_PX) {
                    const gpuX = TRACK_LABEL_WIDTH + (gpuStartMs - this._viewportStartMs) * pxPerMs + drawOffsetPx;
                    const gpuY = gpuTrackY + TRACK_PADDING;
                    this._drawBar(ctx, gpuX, gpuY, Math.max(gpuBarW, 2), ROW_HEIGHT, 'gpu', entry.name);
                }
            }
        }
    }
    _drawGridLines(ctx, w, startY, h, chartWidth) {
        ctx.strokeStyle = COLORS.grid;
        ctx.lineWidth = 0.5;
        ctx.setLineDash([2, 4]);
        const pxPerMs = chartWidth / this._viewportDurationMs;
        const gridInterval = this._calculateGridInterval(this._viewportDurationMs, chartWidth);
        const firstGrid = Math.ceil(this._viewportStartMs / gridInterval) * gridInterval;
        const viewportEndMs = this._viewportStartMs + this._viewportDurationMs;
        // Offset for when recording is shorter than viewport
        const recordingDuration = this._recordingEndMs - this._recordingStartMs;
        let drawOffsetPx = 0;
        if (this._isRecording && this._followNow && recordingDuration < this._viewportDurationMs) {
            drawOffsetPx = (this._viewportDurationMs - recordingDuration) * pxPerMs;
        }
        for (let ms = firstGrid; ms <= viewportEndMs; ms += gridInterval) {
            const x = TRACK_LABEL_WIDTH + (ms - this._viewportStartMs) * pxPerMs + drawOffsetPx;
            if (x < TRACK_LABEL_WIDTH || x > w)
                continue;
            ctx.beginPath();
            ctx.moveTo(x, startY);
            ctx.lineTo(x, startY + h);
            ctx.stroke();
        }
        ctx.setLineDash([]);
    }
    _drawBar(ctx, x, y, w, h, kind, label) {
        const color = COLORS[kind] || COLORS.marker;
        const r = 2;
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, r);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.3)';
        ctx.lineWidth = 1;
        ctx.stroke();
        if (w > 30) {
            ctx.fillStyle = 'rgba(0,0,0,0.8)';
            ctx.font = '10px monospace';
            const maxChars = Math.floor((w - 6) / 6);
            const text = label.length > maxChars ? label.slice(0, maxChars - 1) + '…' : label;
            ctx.fillText(text, x + 3, y + h - 5);
        }
    }
    // --- Interaction ---
    _onMouseDown(e) {
        const rect = this._canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        // Check if clicking in overview (viewport drag)
        if (y < OVERVIEW_HEIGHT) {
            this._isDraggingViewport = true;
            this._dragStartX = x;
            this._dragStartViewportMs = this._viewportStartMs;
            this._followNow = false;
            e.preventDefault();
            return;
        }
        // Pan the detail view (anywhere below overview)
        this._isPanningDetail = true;
        this._panStartX = x;
        this._panStartViewportMs = this._viewportStartMs;
        this._followNow = false;
        e.preventDefault();
    }
    _onMouseMove(e) {
        const rect = this._canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const w = rect.width;
        const chartWidth = w - TRACK_LABEL_WIDTH;
        const recordingDuration = this._recordingEndMs - this._recordingStartMs;
        const maxStart = Math.max(0, recordingDuration - this._viewportDurationMs);
        if (this._isDraggingViewport && recordingDuration > 0) {
            const dx = x - this._dragStartX;
            const msPerPx = recordingDuration / chartWidth;
            const newStart = this._dragStartViewportMs + dx * msPerPx;
            this._viewportStartMs = Math.max(0, Math.min(newStart, maxStart));
            this._scheduleRender();
            return;
        }
        if (this._isPanningDetail && recordingDuration > 0) {
            const dx = this._panStartX - x; // Inverted for natural panning
            const msPerPx = this._viewportDurationMs / chartWidth;
            const newStart = this._panStartViewportMs + dx * msPerPx;
            this._viewportStartMs = Math.max(0, Math.min(newStart, maxStart));
            this._scheduleRender();
            return;
        }
        // Tooltip
        this._updateTooltip(e, x, y, w);
    }
    _onMouseUp() {
        this._isDraggingViewport = false;
        this._isPanningDetail = false;
    }
    _onMouseLeave() {
        this._isDraggingViewport = false;
        this._isPanningDetail = false;
        this._tooltip.style.display = 'none';
    }
    _onWheel(e) {
        e.preventDefault();
        const rect = this._canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const w = rect.width;
        const chartWidth = w - TRACK_LABEL_WIDTH;
        const recordingDuration = this._recordingEndMs - this._recordingStartMs;
        if (recordingDuration <= 0)
            return;
        const maxStart = Math.max(0, recordingDuration - this._viewportDurationMs);
        // Shift + scroll = pan, otherwise zoom
        if (e.shiftKey) {
            // Pan horizontally
            const panMs = e.deltaY * (this._viewportDurationMs / chartWidth) * 2;
            this._viewportStartMs = Math.max(0, Math.min(this._viewportStartMs + panMs, maxStart));
            this._followNow = false;
        }
        else {
            // Zoom centered on mouse position
            const zoomFactor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
            const mouseRelX = (x - TRACK_LABEL_WIDTH) / chartWidth;
            const mouseMs = this._viewportStartMs + mouseRelX * this._viewportDurationMs;
            // Allow zooming down to 0.1ms viewport (absurdly detailed) and up to 2x recording length
            const newDuration = Math.max(0.1, Math.min(recordingDuration * 2, this._viewportDurationMs * zoomFactor));
            // Keep mouse position fixed during zoom
            const newStart = mouseMs - mouseRelX * newDuration;
            const newMaxStart = Math.max(0, recordingDuration - newDuration);
            this._viewportDurationMs = newDuration;
            this._viewportStartMs = Math.max(0, Math.min(newStart, newMaxStart));
            this._followNow = false;
        }
        this._scheduleRender();
    }
    _updateTooltip(e, x, y, w) {
        if (y < OVERVIEW_HEIGHT + RULER_HEIGHT) {
            this._tooltip.style.display = 'none';
            return;
        }
        const chartWidth = w - TRACK_LABEL_WIDTH;
        const pxPerMs = chartWidth / this._viewportDurationMs;
        const viewportEndMs = this._viewportStartMs + this._viewportDurationMs;
        const detailY = OVERVIEW_HEIGHT + RULER_HEIGHT;
        const cpuTrackH = Math.max((this._maxCpuDepth + 1) * (ROW_HEIGHT + ROW_GAP) + TRACK_PADDING * 2, MIN_CPU_TRACK_HEIGHT);
        const gpuTrackY = detailY + cpuTrackH;
        for (let i = this._entries.length - 1; i >= 0; i--) {
            const entry = this._entries[i];
            const entryEndMs = entry.startMs + entry.durationMs;
            if (entryEndMs < this._viewportStartMs || entry.startMs > viewportEndMs)
                continue;
            const ex = TRACK_LABEL_WIDTH + (entry.startMs - this._viewportStartMs) * pxPerMs;
            const ew = Math.max(entry.durationMs * pxPerMs, 2);
            const ey = detailY + TRACK_PADDING + entry.depth * (ROW_HEIGHT + ROW_GAP);
            if (x >= ex && x <= ex + ew && y >= ey && y <= ey + ROW_HEIGHT) {
                this._showTooltip(e, entry, false);
                return;
            }
            const gpuMs = getGpuMs(entry);
            const gpuStartMs = getGpuStartMs(entry);
            if (gpuMs !== null && gpuMs > 0 && gpuStartMs !== null) {
                const gx = TRACK_LABEL_WIDTH + (gpuStartMs - this._viewportStartMs) * pxPerMs;
                const gw = Math.max(gpuMs * pxPerMs, 2);
                const gy = gpuTrackY + TRACK_PADDING;
                if (x >= gx && x <= gx + gw && y >= gy && y <= gy + ROW_HEIGHT) {
                    this._showTooltip(e, entry, true);
                    return;
                }
            }
        }
        this._tooltip.style.display = 'none';
    }
    _showTooltip(e, entry, isGpu) {
        const kindLabel = entry.kind.charAt(0).toUpperCase() + entry.kind.slice(1);
        let html = `<div style="font-weight:bold;margin-bottom:4px">${entry.name}</div>`;
        html += `<div style="color:${COLORS.textDim}">Type: ${kindLabel}</div>`;
        const gpuMs = getGpuMs(entry);
        if (isGpu) {
            html += `<div>GPU: <span style="color:${COLORS.gpu}">${gpuMs?.toFixed(2)}ms</span></div>`;
        }
        else {
            html += `<div>CPU: <span style="color:${COLORS[entry.kind]}">${entry.durationMs.toFixed(2)}ms</span></div>`;
            if (gpuMs !== null) {
                html += `<div>GPU: <span style="color:${COLORS.gpu}">${gpuMs.toFixed(2)}ms</span></div>`;
            }
        }
        this._tooltip.innerHTML = html;
        this._tooltip.style.display = 'block';
        const contentRect = this.content.getBoundingClientRect();
        let tooltipX = e.clientX - contentRect.left + 12;
        let tooltipY = e.clientY - contentRect.top + 12;
        const tooltipW = this._tooltip.offsetWidth;
        const tooltipH = this._tooltip.offsetHeight;
        if (tooltipX + tooltipW > contentRect.width - 10) {
            tooltipX = e.clientX - contentRect.left - tooltipW - 12;
        }
        if (tooltipY + tooltipH > contentRect.height - 10) {
            tooltipY = e.clientY - contentRect.top - tooltipH - 12;
        }
        this._tooltip.style.left = `${tooltipX}px`;
        this._tooltip.style.top = `${tooltipY}px`;
    }
}

/** The HTMLCanvasElement target for the renderer to draw into. Wraps a canvas and its WebGPU context. */
class CanvasTarget {
    /** The canvas element this target wraps. */
    domElement;
    /**
     * True when this is the renderer's default (main) canvas target.
     * Set by the renderer after construction; the inspector preview targets are not default.
     * The renderer sets isDefaultCanvasTarget = true on the initial target.
     */
    isDefaultCanvasTarget = false;
    /** Width in logical pixels. */
    _width;
    /** Height in logical pixels. */
    _height;
    /** Pixel ratio for high-DPI displays. */
    _pixelRatio = 1;
    /** Lazily-created WebGPU canvas context. Null until getContext() is called. */
    _context = null;
    constructor(canvas) {
        this.domElement = canvas;
        this._width = canvas.width;
        this._height = canvas.height;
    }
    /**
     * Get (or lazily create) the WebGPU canvas context and configure it.
     * Safe to call multiple times — returns the cached context after first call.
     * WebGPURenderer lazily reads the context from the current canvasTarget.
     *
     * @param device the GPUDevice to configure the context with.
     * @param format the preferred canvas format (e.g. 'bgra8unorm').
     * @param alphaMode the alpha mode for the context (default 'opaque').
     */
    getContext(device, format, alphaMode = 'opaque') {
        if (!this._context) {
            const ctx = this.domElement.getContext('webgpu');
            if (!ctx) {
                throw new Error('[CanvasTarget] Failed to get WebGPU context from canvas.');
            }
            ctx.configure({ device, format, alphaMode });
            this._context = ctx;
        }
        return this._context;
    }
    /**
     * Unconfigure and release the WebGPU context. Called when the target is disposed
     * or replaced. After this, getContext() will create a fresh context.
     */
    unconfigure() {
        if (this._context) {
            this._context.unconfigure();
            this._context = null;
        }
    }
    /**
     * Get the pixel ratio.
     */
    getPixelRatio() {
        return this._pixelRatio;
    }
    /**
     * Set the pixel ratio and resize the canvas to match.
     */
    setPixelRatio(value) {
        if (this._pixelRatio === value)
            return;
        this._pixelRatio = value;
        this.setSize(this._width, this._height);
    }
    /**
     * Returns the drawing buffer size in physical pixels (honors pixel ratio).
     */
    getDrawingBufferSize() {
        return {
            width: Math.floor(this._width * this._pixelRatio),
            height: Math.floor(this._height * this._pixelRatio),
        };
    }
    /**
     * Returns the size in logical pixels (does not honor pixel ratio).
     */
    getSize() {
        return { width: this._width, height: this._height };
    }
    /**
     * Set the size of the canvas in logical pixels.
     * Updates domElement.width/height (physical) and fires 'resize'.
     */
    setSize(width, height, updateStyle = true) {
        this._width = width;
        this._height = height;
        this.domElement.width = Math.floor(width * this._pixelRatio);
        this.domElement.height = Math.floor(height * this._pixelRatio);
        if (updateStyle) {
            this.domElement.style.width = `${width}px`;
            this.domElement.style.height = `${height}px`;
        }
    }
    /**
     * Set the drawing buffer size directly (width, height, pixelRatio all at once).
     */
    setDrawingBufferSize(width, height, pixelRatio) {
        this._width = width;
        this._height = height;
        this._pixelRatio = pixelRatio;
        this.domElement.width = Math.floor(width * pixelRatio);
        this.domElement.height = Math.floor(height * pixelRatio);
        this.setSize(width, height, false);
    }
    /**
     * Dispose this target: unconfigure the GPU context and fire 'dispose'.
     */
    dispose() {
        this.unconfigure();
    }
}

/**
 * Inspector.ts — Full gpucat Inspector UI shell.
 *
 * Extends RendererInspector with:
 *  - A Profiler UI panel housing all tabs
 *  - Display cycle updates (text at 250ms, graph at 20ms)
 *  - Timeline recording via overridden begin/beginRender/finishRender/beginCompute/finishCompute hooks
 *  - Console monkey-patching of console.warn / console.error
 *  - Viewer tab: inspectable node canvases
 */
class Inspector extends RendererInspector {
    profiler;
    performance;
    performanceTimeline;
    memory;
    console;
    parameters;
    viewer;
    timeline;
    settings;
    sceneHierarchy;
    drawCalls;
    computeCalls;
    _displayCycle;
    _lastUpdateTime = 0;
    /** Cache of CanvasData per inspectable node. */
    _canvasNodes = new Map();
    /** Active probe entry, if any. */
    _activeProbe = null;
    constructor() {
        super();
        injectStyle();
        const profiler = new Profiler();
        const parameters = new Parameters({
            builtin: true,
            icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M14 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /><path d="M4 6l8 0" /><path d="M16 6l4 0" /><path d="M8 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /><path d="M4 12l2 0" /><path d="M10 12l10 0" /><path d="M17 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /><path d="M4 18l11 0" /><path d="M19 18l1 0" /></svg>'
        });
        parameters.hide();
        profiler.addTab(parameters);
        const viewer = new Viewer();
        viewer.hide();
        profiler.addTab(viewer);
        const sceneHierarchy = new SceneHierarchy();
        sceneHierarchy.hide();
        profiler.addTab(sceneHierarchy);
        const drawCalls = new DrawCalls();
        drawCalls.hide();
        profiler.addTab(drawCalls);
        const computeCalls = new ComputeCalls();
        computeCalls.hide();
        profiler.addTab(computeCalls);
        const performance = new Performance();
        profiler.addTab(performance);
        const performanceTimeline = new PerformanceTimeline();
        profiler.addTab(performanceTimeline);
        const memory = new Memory();
        profiler.addTab(memory);
        const timeline = new Timeline();
        profiler.addTab(timeline);
        const consoleTab = new Console();
        profiler.addTab(consoleTab);
        const settings = new Settings();
        profiler.addTab(settings);
        profiler.loadLayout();
        if (!profiler.activeTabId) {
            profiler.setActiveTab(performance.id);
        }
        this.profiler = profiler;
        this.performance = performance;
        this.performanceTimeline = performanceTimeline;
        this.memory = memory;
        this.console = consoleTab;
        this.parameters = parameters;
        this.viewer = viewer;
        this.timeline = timeline;
        this.settings = settings;
        this.sceneHierarchy = sceneHierarchy;
        this.drawCalls = drawCalls;
        this.computeCalls = computeCalls;
        this._displayCycle = {
            text: { needsUpdate: false, duration: 250, time: 0 },
            graph: { needsUpdate: false, duration: 20, time: 0 },
        };
    }
    get domElement() {
        return this.profiler.domElement;
    }
    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------
    setRenderer(renderer) {
        super.setRenderer(renderer);
        if (renderer !== null) {
            // Forward console warnings / errors into the console tab
            const origWarn = console.warn.bind(console);
            const origError = console.error.bind(console);
            const self = this;
            console.warn = (...args) => {
                const msg = args.map(String).join(' ');
                self.console.addMessage('warn', msg);
                origWarn(...args);
            };
            console.error = (...args) => {
                const msg = args.map(String).join(' ');
                self.console.addMessage('error', msg);
                origError(...args);
            };
            this.timeline.setRenderer(renderer);
        }
    }
    init() {
        super.init();
        this.console.addMessage('info', 'gpucat WebGPU Renderer [ "WebGPU" ]');
        const renderer = this.getRenderer();
        if (this.domElement.parentElement === null && renderer?.domElement.parentElement !== null) {
            renderer.domElement.parentElement.appendChild(this.domElement);
        }
    }
    // -----------------------------------------------------------------------
    // Timeline hooks — forward calls to timeline.onCall()
    // -----------------------------------------------------------------------
    begin(frameId) {
        super.begin(frameId);
        if (this.timeline.isRecording) {
            this.timeline.onCall('begin', String(frameId), this.fps);
        }
    }
    beginRender(passId, frameId) {
        super.beginRender(passId, frameId);
        if (this.timeline.isRecording) {
            this.timeline.onCall('beginRender', passId);
        }
    }
    finishRender(passId, frameId) {
        super.finishRender(passId, frameId);
        if (this.timeline.isRecording) {
            this.timeline.onCall('finishRender', passId);
        }
    }
    beginCompute(node, frameId) {
        super.beginCompute(node, frameId);
        if (this.timeline.isRecording) {
            this.timeline.onCall('beginCompute', node.id);
        }
    }
    finishCompute(nodeId, frameId) {
        super.finishCompute(nodeId, frameId);
        if (this.timeline.isRecording) {
            this.timeline.onCall('finishCompute', nodeId);
        }
    }
    setPipeline(label) {
        if (this.timeline.isRecording) {
            this.timeline.onCall('setPipeline', label);
        }
    }
    setBindGroup(index, label) {
        if (this.timeline.isRecording) {
            this.timeline.onCall('setBindGroup', `[${index}] ${label}`);
        }
    }
    setVertexBuffer(slot) {
        if (this.timeline.isRecording) {
            this.timeline.onCall('setVertexBuffer', String(slot));
        }
    }
    setIndexBuffer() {
        if (this.timeline.isRecording) {
            this.timeline.onCall('setIndexBuffer', '');
        }
    }
    draw(vertexCount, instanceCount) {
        if (this.timeline.isRecording) {
            this.timeline.onCall('draw', `${vertexCount}v × ${instanceCount}i`);
        }
    }
    drawIndexed(indexCount, instanceCount) {
        if (this.timeline.isRecording) {
            this.timeline.onCall('drawIndexed', `${indexCount}idx × ${instanceCount}i`);
        }
    }
    drawIndirect() {
        if (this.timeline.isRecording) {
            this.timeline.onCall('drawIndirect', '');
        }
    }
    drawIndexedIndirect() {
        if (this.timeline.isRecording) {
            this.timeline.onCall('drawIndexedIndirect', '');
        }
    }
    dispatchWorkgroups(x, y, z) {
        if (this.timeline.isRecording) {
            this.timeline.onCall('dispatchWorkgroups', `${x}×${y}×${z}`);
        }
    }
    dispatchWorkgroupsIndirect(_buffer, offset) {
        if (this.timeline.isRecording) {
            this.timeline.onCall('dispatchWorkgroupsIndirect', `offset=${offset}`);
        }
    }
    finish(frameId) {
        super.finish(frameId);
        const record = this.resolveFrame();
        if (record)
            this._processFrame(record);
    }
    // -----------------------------------------------------------------------
    // createParameters — expose dat.GUI-style groups via the Parameters tab
    // -----------------------------------------------------------------------
    createParameters(name) {
        // Activate the mini-panel (top-right floating panel) without showing
        // the Parameters tab inside the main profiler panel.  showBuiltin()
        // moves the list content into the mini-panel overlay and makes it
        // visible, while leaving isVisible=false so the tab button never
        // appears in the docked panel's tab bar.
        this.parameters.showBuiltin();
        return this.parameters.createGroup(name);
    }
    // -----------------------------------------------------------------------
    // Probe API — shader value live inspector
    // -----------------------------------------------------------------------
    /**
     * Set the active probe to the given variable expression in the given mesh's
     * compiled WGSL.  Builds a new probe pipeline (patched WGSL + same bind
     * group layouts), creates a 140×140 CanvasTarget, and wires it to render
     * every frame in _processFrame.
     *
     * Returns the probe canvas element so the caller can display it, or null
     * if patching / pipeline creation fails.
     */
    setProbe(target, sourceRO) {
        const renderer = this.getRenderer();
        if (!renderer)
            return null;
        const code = sourceRO.nodeBuilderState?.vertexCode;
        if (!code)
            return null;
        const cacheKey = `${target.expr}::${target.anchorKind}::${sourceRO.id}::gen`;
        // Return existing probe canvas if already built for same key
        if (this._activeProbe?.cacheKey === cacheKey) {
            return this._activeProbe.canvas;
        }
        // Discard previous probe
        this.clearProbe();
        // Patch WGSL
        const patchedCode = buildProbeWGSL(code, target);
        if (!patchedCode)
            return null;
        console.groupCollapsed(`[gpucat probe] patched WGSL for "${target.expr}"`);
        console.log(patchedCode);
        console.groupEnd();
        // Build probe pipeline: same bind group layouts, patched shader
        const bindGroupLayouts = getRenderBindGroupLayouts(renderer._bindings, sourceRO);
        if (bindGroupLayouts.length === 0) {
            console.warn('[gpucat probe] bind group layouts not yet initialised — try clicking again after the first frame renders');
            return null;
        }
        const pipelineLayout = renderer._device.createPipelineLayout({ bindGroupLayouts });
        const shaderModule = renderer._device.createShaderModule({ code: patchedCode });
        // Log WGSL compilation errors asynchronously (same pattern as render-objects.ts)
        shaderModule.getCompilationInfo().then((info) => {
            for (const msg of info.messages) {
                const log = msg.type === 'error' ? console.error : console.warn;
                log(`[gpucat probe shader ${msg.type}] line ${msg.lineNum}: ${msg.message}`);
            }
        });
        const format = navigator.gpu.getPreferredCanvasFormat();
        const depthFormat = 'depth24plus';
        // Real vertex buffer layouts so the pipeline accepts the actual mesh geometry.
        const vertexBufferLayouts = buildVertexBufferLayouts(sourceRO.geometry, sourceRO.nodeBuilderState);
        let pipeline;
        try {
            pipeline = renderer._device.createRenderPipeline({
                layout: pipelineLayout,
                vertex: {
                    module: shaderModule,
                    entryPoint: 'vs_main',
                    buffers: vertexBufferLayouts,
                },
                fragment: {
                    module: shaderModule,
                    entryPoint: 'fs_main',
                    targets: [{ format }],
                },
                primitive: { topology: 'triangle-list', cullMode: 'none' },
                depthStencil: {
                    format: depthFormat,
                    depthWriteEnabled: true,
                    depthCompare: 'less',
                },
            });
        }
        catch (e) {
            console.error('[gpucat probe] Failed to create probe pipeline:', e);
            return null;
        }
        // Create preview canvas + depth texture
        const canvas = document.createElement('canvas');
        canvas.style.display = 'block';
        canvas.style.borderRadius = '4px';
        const canvasTarget = new CanvasTarget(canvas);
        canvasTarget.setSize(140, 140);
        const depthTexture = renderer._device.createTexture({
            size: [140, 140, 1],
            format: depthFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this._activeProbe = {
            expr: target.expr,
            patchedCode,
            pipeline,
            canvasTarget,
            canvas,
            sourceRO,
            depthTexture,
            cacheKey,
        };
        return canvas;
    }
    /** Remove the active probe. */
    clearProbe() {
        if (this._activeProbe) {
            this._activeProbe.canvasTarget.dispose();
            this._activeProbe.depthTexture.destroy();
            this._activeProbe = null;
        }
    }
    // -----------------------------------------------------------------------
    // navigateToRO — jump to a RenderObject in the Draw Calls tab
    // -----------------------------------------------------------------------
    navigateToRO(ro) {
        this.profiler.setActiveTab(this.drawCalls.id);
        if (!this.drawCalls.isVisible)
            this.drawCalls.show();
        this.drawCalls.selectRO(ro, this);
    }
    // -----------------------------------------------------------------------
    // Private: per-frame update dispatch
    // -----------------------------------------------------------------------
    _processFrame(record) {
        const now = performance.now();
        const deltaMs = now - (this._lastUpdateTime || now);
        this._lastUpdateTime = now;
        this._tickCycle(this._displayCycle.text, deltaMs);
        this._tickCycle(this._displayCycle.graph, deltaMs);
        // Check if main panel is visible (expanded)
        const panelVisible = this.profiler.panel.classList.contains('visible');
        // Always capture every frame when recording - must not be throttled
        if (this.performanceTimeline.isRecording) {
            this.performanceTimeline.update(this, record);
        }
        if (this._displayCycle.text.needsUpdate) {
            // Always update FPS counter (visible in toggle button)
            setText('fps-counter', this.fps.toFixed());
            // Only update detailed stats when panel is visible
            if (panelVisible) {
                this.performance.updateText(this, record);
                this.memory.updateText(this);
                if (this.performanceTimeline.isActive && !this.performanceTimeline.isRecording) {
                    this.performanceTimeline.scheduleRender();
                }
            }
            this._displayCycle.text.needsUpdate = false;
        }
        if (this._displayCycle.graph.needsUpdate) {
            // Only update graphs when panel is visible
            if (panelVisible) {
                this.performance.updateGraph(this);
                this.memory.updateGraph(this);
            }
            this._displayCycle.graph.needsUpdate = false;
        }
        // Skip expensive tree traversals when panel is collapsed
        if (!panelVisible) {
            return;
        }
        if (record.inspectableNodes.length > 0) {
            this.viewer.show();
            this.resolveViewer(record.inspectableNodes);
        }
        if (record.scenes.length > 0) {
            this.sceneHierarchy.show();
            this.sceneHierarchy.update(this, record.scenes);
        }
        const renderer = this.getRenderer();
        if (renderer && renderer._renderObjects.renderObjects.size > 0) {
            this.drawCalls.show();
            this.drawCalls.update(this, renderer);
        }
        // Update compute calls tab if compute passes were dispatched this frame
        if (renderer && this.computeNodes.size > 0) {
            this.computeCalls.show();
            this.computeCalls.update(this, renderer);
        }
        // Render probe canvas (if active) using a fresh command encoder so we
        // don't re-enter the main render pipeline.
        this._renderProbe();
    }
    /**
     * Build canvasData for each inspectable node and call viewer.update().
     */
    resolveViewer(nodes) {
        const renderer = this.getRenderer();
        if (!renderer)
            return;
        const canvasDataList = nodes.map(node => this.getCanvasDataByNode(node));
        this.viewer.update(this, canvasDataList);
    }
    /**
     * Get or create the CanvasData for an inspectable node.
     * Creates a 140×140 CanvasTarget, wraps the node as vec4(vec3(node), 1),
     * and builds a fullscreen Material. Cached per node — never recreated.
     *
     * Three.js aligned: mirrors Inspector.getCanvasDataByNode().
     * - setPixelRatio(window.devicePixelRatio) on the canvas target
     * - splitCamelCase + splitPath to derive { path, name } from the node label
     */
    getCanvasDataByNode(node) {
        let canvasData = this._canvasNodes.get(node);
        if (canvasData === undefined) {
            const canvas = document.createElement('canvas');
            canvas.style.display = 'block';
            canvas.style.borderRadius = '4px';
            const canvasTarget = new CanvasTarget(canvas);
            canvasTarget.setPixelRatio(window.devicePixelRatio);
            canvasTarget.setSize(140, 140);
            const id = node.id;
            const rawName = node.getName();
            const { path, name } = splitPath(splitCamelCase(rawName));
            const material = createPreviewMaterial(node.wrappedNode);
            const quadMesh = new QuadMesh(material);
            quadMesh.name = 'Viewer - ' + name;
            canvasData = {
                id,
                name,
                path,
                node,
                quadMesh,
                canvasTarget,
            };
            this._canvasNodes.set(node, canvasData);
        }
        return canvasData;
    }
    _tickCycle(cycle, deltaMs) {
        cycle.time += deltaMs;
        if (cycle.time >= cycle.duration) {
            cycle.needsUpdate = true;
            cycle.time = 0;
        }
    }
    /**
     * Encode and submit a single render pass for the active probe.
     * Uses the real mesh vertex/index buffers and bind groups (which include
     * camera uniforms updated this frame) so the probe renders the mesh from
     * the camera's point of view with the chosen expression as the color output.
     */
    _renderProbe() {
        const probe = this._activeProbe;
        if (!probe)
            return;
        const renderer = this.getRenderer();
        if (!renderer)
            return;
        const ro = probe.sourceRO;
        if (ro.mesh.count === 0)
            return;
        // Bind groups updated this frame by the main render loop (camera at [0])
        const bindGroups = ro.bindGroups;
        if (!bindGroups || bindGroups.length === 0)
            return;
        // Vertex buffers must be uploaded already (main render loop does this)
        const nodeState = ro.nodeBuilderState;
        if (!nodeState)
            return;
        const format = navigator.gpu.getPreferredCanvasFormat();
        const ctx = probe.canvasTarget.getContext(renderer._device, format, 'opaque');
        const targetTexture = ctx.getCurrentTexture();
        const encoder = renderer._device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                    view: targetTexture.createView(),
                    clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1 },
                    loadOp: 'clear',
                    storeOp: 'store',
                }],
            depthStencilAttachment: {
                view: probe.depthTexture.createView(),
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
        });
        pass.setPipeline(probe.pipeline);
        // Bind groups (camera, object uniforms, textures — same as main draw)
        for (let i = 0; i < bindGroups.length; i++) {
            pass.setBindGroup(i, bindGroups[i]);
        }
        // Vertex buffers — look up uploaded GPU buffers from the geometry
        let slot = 0;
        const geometry = ro.geometry;
        const bufferCache = renderer._buffers;
        for (const group of nodeState.vertexBufferGroups) {
            if (group.name !== null) {
                // Geometry-based group - resolve buffer by name
                const bufAttr = geometry.buffers.get(group.name);
                if (bufAttr) {
                    const gpuBuf = ensureUploaded(bufferCache, renderer._device, bufAttr);
                    pass.setVertexBuffer(slot, gpuBuf);
                }
            }
            else {
                // Direct buffer group
                const gpuBuffer = group.buffer;
                if (!gpuBuffer) {
                    throw new Error(`[gpucat] VertexBufferGroup has no buffer`);
                }
                const arr = gpuBuffer.array;
                if (arr) {
                    const gpuBuf = uploadRaw(bufferCache, renderer._device, gpuBuffer, arr, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST).buffer;
                    pass.setVertexBuffer(slot, gpuBuf);
                }
            }
            slot++;
        }
        // Issue draw call — mirrors renderer.ts issueDraws exactly, including
        // indirect draw support.  The indirect GPU buffer was already written by
        // the compute pass this frame; getUploaded() does a non-uploading lookup.
        if (geometry.index) {
            const idxBuf = ensureUploaded(bufferCache, renderer._device, geometry.index);
            pass.setIndexBuffer(idxBuf, getIndexFormat(geometry.index.array));
            if (geometry.indirect) {
                const indBuf = getUploaded(bufferCache, geometry.indirect);
                if (indBuf) {
                    const byteStride = geometry.indirect.itemSize * 4;
                    for (let d = 0; d < geometry.indirect.count; d++) {
                        pass.drawIndexedIndirect(indBuf, d * byteStride);
                    }
                }
            }
            else {
                pass.drawIndexed(Math.min(geometry.drawRange.count, geometry.index.array.length), ro.mesh.count, geometry.drawRange.start);
            }
        }
        else {
            if (geometry.indirect) {
                const indBuf = getUploaded(bufferCache, geometry.indirect);
                if (indBuf) {
                    const byteStride = geometry.indirect.itemSize * 4;
                    for (let d = 0; d < geometry.indirect.count; d++) {
                        pass.drawIndirect(indBuf, d * byteStride);
                    }
                }
            }
            else {
                pass.draw(geometry.drawRange.count, ro.mesh.count, geometry.drawRange.start);
            }
        }
        pass.end();
        renderer._device.queue.submit([encoder.finish()]);
    }
}

const STATE = {
    NONE: -1,
    ROTATE: 0,
    DOLLY: 1,
    PAN: 2,
    TOUCH_ROTATE: 3,
    TOUCH_PAN: 4,
    TOUCH_DOLLY_PAN: 5,
    TOUCH_DOLLY_ROTATE: 6,
};
const MOUSE = {
    ROTATE: 0,
    DOLLY: 1,
    PAN: 2,
};
const TOUCH = {
    ROTATE: 0,
    PAN: 1,
    DOLLY_PAN: 2,
    DOLLY_ROTATE: 3,
};
// ---------------------------------------------------------------------------
// Module-level scratch variables (avoid per-frame allocation)
// ---------------------------------------------------------------------------
const _v = [0, 0, 0];
const _twoPI = 2 * Math.PI;
const _EPS = 0.000001;
const _TILT_LIMIT = Math.cos(70 * (Math.PI / 180));
// ---------------------------------------------------------------------------
// mat4 column extraction helpers (column-major, gl-matrix layout)
// col 0: indices 0-3, col 1: 4-7, col 2: 8-11, col 3: 12-15
// ---------------------------------------------------------------------------
function mat4GetColumn(out, m, col) {
    const base = col * 4;
    out[0] = m[base];
    out[1] = m[base + 1];
    out[2] = m[base + 2];
    return out;
}
// ---------------------------------------------------------------------------
// OrbitControls
// ---------------------------------------------------------------------------
/**
 * OrbitControls — mirrors Three.js OrbitControls.
 *
 * Orbit: left mouse / one-finger touch.
 * Zoom:  middle mouse / wheel / two-finger pinch.
 * Pan:   right mouse / left mouse + ctrl|meta|shift / two-finger drag / arrow keys.
 *
 * Call `update()` each frame when `enableDamping` or `autoRotate` are `true`.
 */
class OrbitControls {
    /** The camera being controlled. */
    object;
    /** The DOM element used for event listeners. */
    domElement = null;
    /** Whether the controls are active. */
    enabled = true;
    // ---- target / cursor --------------------------------------------------
    /** The point the camera orbits around. */
    target = [0, 0, 0];
    /**
     * The focus point of the `minTargetRadius` / `maxTargetRadius` limits.
     */
    cursor = [0, 0, 0];
    // ---- distance limits (perspective) ------------------------------------
    minDistance = 0;
    maxDistance = Infinity;
    // ---- zoom limits (orthographic) ----------------------------------------
    minZoom = 0;
    maxZoom = Infinity;
    // ---- target radius limits ---------------------------------------------
    minTargetRadius = 0;
    maxTargetRadius = Infinity;
    // ---- polar angle limits -----------------------------------------------
    /** Minimum polar angle (radians), default 0. */
    minPolarAngle = 0;
    /** Maximum polar angle (radians), default Math.PI. */
    maxPolarAngle = Math.PI;
    // ---- azimuth limits ---------------------------------------------------
    minAzimuthAngle = -Infinity;
    maxAzimuthAngle = Infinity;
    // ---- damping ----------------------------------------------------------
    enableDamping = false;
    dampingFactor = 0.05;
    // ---- zoom -------------------------------------------------------------
    enableZoom = true;
    zoomSpeed = 1.0;
    zoomToCursor = false;
    // ---- rotate -----------------------------------------------------------
    enableRotate = true;
    rotateSpeed = 1.0;
    keyRotateSpeed = 1.0;
    // ---- pan --------------------------------------------------------------
    enablePan = true;
    panSpeed = 1.0;
    /** When true the camera pans in screen space; otherwise in world-up plane. */
    screenSpacePanning = true;
    keyPanSpeed = 7.0;
    // ---- auto-rotate ------------------------------------------------------
    autoRotate = false;
    /** 2.0 ≈ 30 s per orbit at 60 fps */
    autoRotateSpeed = 2.0;
    // ---- key bindings -----------------------------------------------------
    keys = {
        LEFT: 'ArrowLeft',
        UP: 'ArrowUp',
        RIGHT: 'ArrowRight',
        BOTTOM: 'ArrowDown',
    };
    // ---- mouse / touch action map ----------------------------------------
    mouseButtons = {
        LEFT: MOUSE.ROTATE,
        MIDDLE: MOUSE.DOLLY,
        RIGHT: MOUSE.PAN,
    };
    touches = {
        ONE: TOUCH.ROTATE,
        TWO: TOUCH.DOLLY_PAN,
    };
    // ---- saved state (for reset()) ----------------------------------------
    target0;
    position0;
    zoom0;
    // ---- internal state ---------------------------------------------------
    state = STATE.NONE;
    /** @internal */ _cursorStyle = 'auto';
    /** @internal */ _domElementKeyEvents = null;
    /** @internal */ _lastPosition = [0, 0, 0];
    /** @internal */ _lastQuaternion = [0, 0, 0, 1];
    /** @internal */ _lastTargetPosition = [0, 0, 0];
    // quaternion to align camera.up with world +Y and its inverse
    /** @internal */ _quat;
    /** @internal */ _quatInverse;
    /** @internal */ _spherical = create$2();
    /** @internal */ _sphericalDelta = create$2();
    /** @internal */ _scale = 1;
    /** @internal */ _panOffset = [0, 0, 0];
    /** @internal */ _rotateStart = create$8();
    /** @internal */ _rotateEnd = create$8();
    /** @internal */ _rotateDelta = create$8();
    /** @internal */ _panStart = create$8();
    /** @internal */ _panEnd = create$8();
    /** @internal */ _panDelta = create$8();
    /** @internal */ _dollyStart = create$8();
    /** @internal */ _dollyEnd = create$8();
    /** @internal */ _dollyDelta = create$8();
    /** @internal */ _dollyDirection = [0, 0, 0];
    /** @internal */ _mouse = create$8();
    /** @internal */ _performCursorZoom = false;
    /** @internal */ _pointers = [];
    /** @internal */ _pointerPositions = {};
    /** @internal */ _controlActive = false;
    // Bound event handlers stored so they can be removed later
    /** @internal */ _onPointerMove;
    /** @internal */ _onPointerDown;
    /** @internal */ _onPointerUp;
    /** @internal */ _onContextMenu;
    /** @internal */ _onMouseWheel;
    /** @internal */ _onKeyDown;
    /** @internal */ _onTouchStart;
    /** @internal */ _onTouchMove;
    /** @internal */ _onMouseDown;
    /** @internal */ _onMouseMove;
    /** @internal */ _interceptControlDown;
    /** @internal */ _interceptControlUp;
    // EventTarget listeners
    _listeners = new Map();
    constructor(object, domElement = null) {
        this.object = object;
        // Build the quaternion that rotates camera.up → world +Y
        const up = [0, 1, 0];
        // camera.up equivalent: we use +Y by default since Object3D doesn't carry an "up" field
        // (same as Three.js default).  Users can override _quat / _quatInverse after construction
        // if they need a different up axis.
        this._quat = rotationTo(create$4(), up, up); // identity — up already is +Y
        this._quatInverse = conjugate(create$4(), this._quat);
        // Saved state snapshots
        this.target0 = clone$2(this.target);
        this.position0 = clone$2(object.position);
        this.zoom0 = object.fov ?? 1; // use fov as proxy for zoom
        // Bind handlers
        this._onPointerDown = _onPointerDown.bind(this);
        this._onPointerMove = _onPointerMove.bind(this);
        this._onPointerUp = _onPointerUp.bind(this);
        this._onContextMenu = _onContextMenu.bind(this);
        this._onMouseWheel = _onMouseWheel.bind(this);
        this._onKeyDown = _onKeyDown.bind(this);
        this._onTouchStart = _onTouchStart.bind(this);
        this._onTouchMove = _onTouchMove.bind(this);
        this._onMouseDown = _onMouseDown.bind(this);
        this._onMouseMove = _onMouseMove.bind(this);
        this._interceptControlDown = _interceptControlDown.bind(this);
        this._interceptControlUp = _interceptControlUp.bind(this);
        if (domElement !== null) {
            this.connect(domElement);
        }
        this.update();
    }
    // -------------------------------------------------------------------------
    // EventEmitter surface
    // -------------------------------------------------------------------------
    addEventListener(type, listener) {
        if (!this._listeners.has(type))
            this._listeners.set(type, new Set());
        this._listeners.get(type).add(listener);
    }
    removeEventListener(type, listener) {
        this._listeners.get(type)?.delete(listener);
    }
    dispatchEvent(type) {
        const set = this._listeners.get(type);
        if (!set)
            return;
        const event = { type, target: this };
        for (const listener of set) {
            listener(event);
        }
    }
    // -------------------------------------------------------------------------
    // Cursor style
    // -------------------------------------------------------------------------
    get cursorStyle() {
        return this._cursorStyle;
    }
    set cursorStyle(type) {
        this._cursorStyle = type;
        if (this.domElement) {
            this.domElement.style.cursor = type === 'grab' ? 'grab' : 'auto';
        }
    }
    // -------------------------------------------------------------------------
    // Connect / disconnect / dispose
    // -------------------------------------------------------------------------
    connect(element) {
        this.domElement = element;
        element.addEventListener('pointerdown', this._onPointerDown);
        element.addEventListener('pointercancel', this._onPointerUp);
        element.addEventListener('contextmenu', this._onContextMenu);
        element.addEventListener('wheel', this._onMouseWheel, { passive: false });
        const doc = element.getRootNode();
        doc.addEventListener('keydown', this._interceptControlDown, {
            passive: true,
            capture: true,
        });
        element.style.touchAction = 'none';
    }
    disconnect() {
        const element = this.domElement;
        if (!element)
            return;
        element.removeEventListener('pointerdown', this._onPointerDown);
        (element.ownerDocument ?? element).removeEventListener('pointermove', this._onPointerMove);
        (element.ownerDocument ?? element).removeEventListener('pointerup', this._onPointerUp);
        element.removeEventListener('pointercancel', this._onPointerUp);
        element.removeEventListener('wheel', this._onMouseWheel);
        element.removeEventListener('contextmenu', this._onContextMenu);
        this.stopListenToKeyEvents();
        const doc = element.getRootNode();
        doc.removeEventListener('keydown', this._interceptControlDown, {
            capture: true,
        });
        element.style.touchAction = 'auto';
    }
    dispose() {
        this.disconnect();
    }
    // -------------------------------------------------------------------------
    // Getters
    // -------------------------------------------------------------------------
    getPolarAngle() {
        return this._spherical[2];
    }
    getAzimuthalAngle() {
        return this._spherical[1];
    }
    getDistance() {
        return distance(this.object.position, this.target);
    }
    // -------------------------------------------------------------------------
    // Key event helpers
    // -------------------------------------------------------------------------
    listenToKeyEvents(domElement) {
        domElement.addEventListener('keydown', this._onKeyDown);
        this._domElementKeyEvents = domElement;
    }
    stopListenToKeyEvents() {
        if (this._domElementKeyEvents !== null) {
            this._domElementKeyEvents.removeEventListener('keydown', this._onKeyDown);
            this._domElementKeyEvents = null;
        }
    }
    // -------------------------------------------------------------------------
    // Save / reset state
    // -------------------------------------------------------------------------
    saveState() {
        copy$5(this.target0, this.target);
        copy$5(this.position0, this.object.position);
        this.zoom0 = this.object.fov ?? 1;
    }
    reset() {
        copy$5(this.target, this.target0);
        copy$5(this.object.position, this.position0);
        const cam = this.object;
        if (typeof cam.fov === 'number') {
            cam.fov = this.zoom0;
            cam.updateProjectionMatrix();
        }
        this.dispatchEvent('change');
        this.update();
        this.state = STATE.NONE;
    }
    // -------------------------------------------------------------------------
    // Programmatic controls
    // -------------------------------------------------------------------------
    pan(deltaX, deltaY) {
        this._pan(deltaX, deltaY);
        this.update();
    }
    dollyIn(dollyScale) {
        this._dollyIn(dollyScale);
        this.update();
    }
    dollyOut(dollyScale) {
        this._dollyOut(dollyScale);
        this.update();
    }
    rotateLeft(angle) {
        this._rotateLeft(angle);
        this.update();
    }
    rotateUp(angle) {
        this._rotateUp(angle);
        this.update();
    }
    // -------------------------------------------------------------------------
    // update() — call every frame when damping/autoRotate are enabled
    // -------------------------------------------------------------------------
    update(deltaTime = null) {
        const position = this.object.position;
        // offset = position - target, rotated to Y-up space
        subtract(_v, position, this.target);
        transformQuat(_v, _v, this._quat);
        setFromVec3(this._spherical, _v);
        if (this.autoRotate && this.state === STATE.NONE) {
            this._rotateLeft(this._getAutoRotationAngle(deltaTime));
        }
        if (this.enableDamping) {
            this._spherical[1] += this._sphericalDelta[1] * this.dampingFactor;
            this._spherical[2] += this._sphericalDelta[2] * this.dampingFactor;
        }
        else {
            this._spherical[1] += this._sphericalDelta[1];
            this._spherical[2] += this._sphericalDelta[2];
        }
        // Clamp azimuth
        let aMin = this.minAzimuthAngle;
        let aMax = this.maxAzimuthAngle;
        if (isFinite(aMin) && isFinite(aMax)) {
            if (aMin < -Math.PI)
                aMin += _twoPI;
            else if (aMin > Math.PI)
                aMin -= _twoPI;
            if (aMax < -Math.PI)
                aMax += _twoPI;
            else if (aMax > Math.PI)
                aMax -= _twoPI;
            if (aMin <= aMax) {
                this._spherical[1] = Math.max(aMin, Math.min(aMax, this._spherical[1]));
            }
            else {
                this._spherical[1] =
                    this._spherical[1] > (aMin + aMax) / 2
                        ? Math.max(aMin, this._spherical[1])
                        : Math.min(aMax, this._spherical[1]);
            }
        }
        // Clamp polar
        this._spherical[2] = Math.max(this.minPolarAngle, Math.min(this.maxPolarAngle, this._spherical[2]));
        makeSafe(this._spherical, this._spherical);
        // Pan offset
        if (this.enableDamping) {
            scaleAndAdd(this.target, this.target, this._panOffset, this.dampingFactor);
        }
        else {
            add(this.target, this.target, this._panOffset);
        }
        // Clamp target distance from cursor
        subtract(this.target, this.target, this.cursor);
        const tLen = length(this.target);
        const tLenClamped = Math.max(this.minTargetRadius, Math.min(this.maxTargetRadius, tLen));
        if (tLen > 0) {
            scale(this.target, this.target, tLenClamped / tLen);
        }
        add(this.target, this.target, this.cursor);
        let zoomChanged = false;
        // Radius / zoom update
        const isPerspective = _isPerspective(this.object);
        if (this.zoomToCursor && this._performCursorZoom) {
            this._spherical[0] = this._clampDistance(this._spherical[0]);
        }
        else {
            const prevRadius = this._spherical[0];
            this._spherical[0] = this._clampDistance(this._spherical[0] * this._scale);
            zoomChanged = prevRadius !== this._spherical[0];
        }
        // Convert back to Cartesian and rotate to camera-up space
        toVec3(_v, this._spherical);
        transformQuat(_v, _v, this._quatInverse);
        add(position, this.target, _v);
        this.object.lookAt(this.target);
        // Apply damping decay
        if (this.enableDamping) {
            this._sphericalDelta[1] *= 1 - this.dampingFactor;
            this._sphericalDelta[2] *= 1 - this.dampingFactor;
            scale(this._panOffset, this._panOffset, 1 - this.dampingFactor);
        }
        else {
            set$1(this._sphericalDelta, 0, 0, 0);
            set$2(this._panOffset, 0, 0, 0);
        }
        // Zoom-to-cursor adjustment for perspective camera
        if (this.zoomToCursor && this._performCursorZoom && isPerspective) {
            const prevRadius = length(_v);
            const newRadius = this._clampDistance(prevRadius * this._scale);
            const radiusDelta = prevRadius - newRadius;
            if (radiusDelta !== 0) {
                scaleAndAdd(this.object.position, this.object.position, this._dollyDirection, radiusDelta);
                this.object.updateWorldMatrix();
                zoomChanged = true;
            }
            // Reposition target in front of camera
            if (this.screenSpacePanning) {
                // target = camera.position + camera forward * newRadius
                // forward is -Z column of camera matrix (column 2, negated)
                mat4GetColumn(_v, this.object.matrix, 2);
                negate(_v, _v);
                normalize$3(_v, _v);
                scaleAndAdd(this.target, this.object.position, _v, newRadius);
            }
            else {
                // intersect the camera ray with the horizontal plane at target.y
                mat4GetColumn(_v, this.object.matrix, 2);
                negate(_v, _v);
                normalize$3(_v, _v);
                const upDot = Math.abs(_v[1]);
                if (upDot < _TILT_LIMIT) {
                    // recalculate target by look-at result
                    this.object.lookAt(this.target);
                }
                else {
                    // plane normal is up=[0,1,0], plane constant = target.y
                    const denom = _v[1];
                    if (Math.abs(denom) > _EPS) {
                        const t = (this.target[1] - this.object.position[1]) / denom;
                        this.target[0] = this.object.position[0] + _v[0] * t;
                        this.target[1] = this.object.position[1] + _v[1] * t;
                        this.target[2] = this.object.position[2] + _v[2] * t;
                    }
                }
            }
        }
        this._scale = 1;
        this._performCursorZoom = false;
        // Update camera matrices
        this.object.updateWorldMatrix();
        this.object.updateViewMatrix();
        // Check if anything actually changed
        const dx = squaredDistance(this._lastPosition, this.object.position);
        const dq = 8 *
            (1 -
                Math.abs(this._lastQuaternion[0] * this.object.quaternion[0] +
                    this._lastQuaternion[1] * this.object.quaternion[1] +
                    this._lastQuaternion[2] * this.object.quaternion[2] +
                    this._lastQuaternion[3] * this.object.quaternion[3]));
        const dt = squaredDistance(this._lastTargetPosition, this.target);
        if (zoomChanged || dx > _EPS || dq > _EPS || dt > _EPS) {
            this.dispatchEvent('change');
            copy$5(this._lastPosition, this.object.position);
            copy$2(this._lastQuaternion, this.object.quaternion);
            copy$5(this._lastTargetPosition, this.target);
            return true;
        }
        return false;
    }
    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------
    /** @internal */ _getAutoRotationAngle(deltaTime) {
        if (deltaTime !== null) {
            return ((_twoPI / 60) * this.autoRotateSpeed) * deltaTime;
        }
        return (_twoPI / 60 / 60) * this.autoRotateSpeed;
    }
    /** @internal */ _getZoomScale(delta) {
        const normalizedDelta = Math.abs(delta * 0.01);
        return Math.pow(0.95, this.zoomSpeed * normalizedDelta);
    }
    _rotateLeft(angle) {
        this._sphericalDelta[1] -= angle;
    }
    _rotateUp(angle) {
        this._sphericalDelta[2] -= angle;
    }
    /** @internal */ _panLeft(distance, objectMatrix) {
        mat4GetColumn(_v, objectMatrix, 0);
        scale(_v, _v, -distance);
        add(this._panOffset, this._panOffset, _v);
    }
    /** @internal */ _panUp(distance, objectMatrix) {
        if (this.screenSpacePanning) {
            mat4GetColumn(_v, objectMatrix, 1);
        }
        else {
            // Use (up × right) = world-up-projected pan direction
            mat4GetColumn(_v, objectMatrix, 0);
            const up = [0, 1, 0];
            cross(_v, up, _v);
        }
        scale(_v, _v, distance);
        add(this._panOffset, this._panOffset, _v);
    }
    // deltaX and deltaY in pixels (right/down positive)
    _pan(deltaX, deltaY) {
        const element = this.domElement;
        const cam = this.object;
        if (_isPerspective(this.object) && element) {
            const position = this.object.position;
            subtract(_v, position, this.target);
            let targetDistance = length(_v);
            // fov is in radians
            targetDistance *= Math.tan(cam.fov / 2);
            this._panLeft((2 * deltaX * targetDistance) / element.clientHeight, this.object.matrix);
            this._panUp((2 * deltaY * targetDistance) / element.clientHeight, this.object.matrix);
        }
        else {
            // Fallback — disable pan for unknown camera type
            console.warn('OrbitControls: unknown camera type — pan disabled.');
            this.enablePan = false;
        }
    }
    _dollyOut(dollyScale) {
        this._scale /= dollyScale;
    }
    _dollyIn(dollyScale) {
        this._scale *= dollyScale;
    }
    /** @internal */ _updateZoomParameters(x, y) {
        if (!this.zoomToCursor || !this.domElement)
            return;
        this._performCursorZoom = true;
        const rect = this.domElement.getBoundingClientRect();
        const dx = x - rect.left;
        const dy = y - rect.top;
        this._mouse[0] = (dx / rect.width) * 2 - 1;
        this._mouse[1] = -(dy / rect.height) * 2 + 1;
        // Dolly direction: un-project the mouse position through the camera.
        // We approximate by setting dollyDirection to normalized (offset from camera to target)
        // adjusted by mouse NDC. Matches Three.js approach of projecting through the camera.
        // Since we don't have a full unproject here, we compute it from the view direction.
        subtract(this._dollyDirection, this.target, this.object.position);
        normalize$3(this._dollyDirection, this._dollyDirection);
    }
    /** @internal */ _clampDistance(dist) {
        return Math.max(this.minDistance, Math.min(this.maxDistance, dist));
    }
    // ---- mouse event handlers -------------------------------------------
    _handleMouseDownRotate(event) {
        this._rotateStart[0] = event.clientX;
        this._rotateStart[1] = event.clientY;
    }
    _handleMouseDownDolly(event) {
        this._updateZoomParameters(event.clientX, event.clientY);
        this._dollyStart[0] = event.clientX;
        this._dollyStart[1] = event.clientY;
    }
    _handleMouseDownPan(event) {
        this._panStart[0] = event.clientX;
        this._panStart[1] = event.clientY;
    }
    _handleMouseMoveRotate(event) {
        this._rotateEnd[0] = event.clientX;
        this._rotateEnd[1] = event.clientY;
        this._rotateDelta[0] =
            (this._rotateEnd[0] - this._rotateStart[0]) * this.rotateSpeed;
        this._rotateDelta[1] =
            (this._rotateEnd[1] - this._rotateStart[1]) * this.rotateSpeed;
        const element = this.domElement;
        const height = element ? element.clientHeight : 1;
        this._rotateLeft((_twoPI * this._rotateDelta[0]) / height);
        this._rotateUp((_twoPI * this._rotateDelta[1]) / height);
        this._rotateStart[0] = this._rotateEnd[0];
        this._rotateStart[1] = this._rotateEnd[1];
        this.update();
    }
    _handleMouseMoveDolly(event) {
        this._dollyEnd[0] = event.clientX;
        this._dollyEnd[1] = event.clientY;
        this._dollyDelta[0] = this._dollyEnd[0] - this._dollyStart[0];
        this._dollyDelta[1] = this._dollyEnd[1] - this._dollyStart[1];
        if (this._dollyDelta[1] > 0) {
            this._dollyOut(this._getZoomScale(this._dollyDelta[1]));
        }
        else if (this._dollyDelta[1] < 0) {
            this._dollyIn(this._getZoomScale(this._dollyDelta[1]));
        }
        this._dollyStart[0] = this._dollyEnd[0];
        this._dollyStart[1] = this._dollyEnd[1];
        this.update();
    }
    _handleMouseMovePan(event) {
        this._panEnd[0] = event.clientX;
        this._panEnd[1] = event.clientY;
        this._panDelta[0] = (this._panEnd[0] - this._panStart[0]) * this.panSpeed;
        this._panDelta[1] = (this._panEnd[1] - this._panStart[1]) * this.panSpeed;
        this._pan(this._panDelta[0], this._panDelta[1]);
        this._panStart[0] = this._panEnd[0];
        this._panStart[1] = this._panEnd[1];
        this.update();
    }
    _handleMouseWheel(event) {
        this._updateZoomParameters(event.clientX, event.clientY);
        if (event.deltaY < 0) {
            this._dollyIn(this._getZoomScale(event.deltaY));
        }
        else if (event.deltaY > 0) {
            this._dollyOut(this._getZoomScale(event.deltaY));
        }
        this.update();
    }
    _handleKeyDown(event) {
        let needsUpdate = false;
        switch (event.code) {
            case this.keys.UP:
                if (event.ctrlKey || event.metaKey || event.shiftKey) {
                    if (this.enableRotate) {
                        const h = this.domElement ? this.domElement.clientHeight : 1;
                        this._rotateUp((_twoPI * this.keyRotateSpeed) / h);
                    }
                }
                else if (this.enablePan) {
                    this._pan(0, this.keyPanSpeed);
                }
                needsUpdate = true;
                break;
            case this.keys.BOTTOM:
                if (event.ctrlKey || event.metaKey || event.shiftKey) {
                    if (this.enableRotate) {
                        const h = this.domElement ? this.domElement.clientHeight : 1;
                        this._rotateUp((-_twoPI * this.keyRotateSpeed) / h);
                    }
                }
                else if (this.enablePan) {
                    this._pan(0, -this.keyPanSpeed);
                }
                needsUpdate = true;
                break;
            case this.keys.LEFT:
                if (event.ctrlKey || event.metaKey || event.shiftKey) {
                    if (this.enableRotate) {
                        const h = this.domElement ? this.domElement.clientHeight : 1;
                        this._rotateLeft((_twoPI * this.keyRotateSpeed) / h);
                    }
                }
                else if (this.enablePan) {
                    this._pan(this.keyPanSpeed, 0);
                }
                needsUpdate = true;
                break;
            case this.keys.RIGHT:
                if (event.ctrlKey || event.metaKey || event.shiftKey) {
                    if (this.enableRotate) {
                        const h = this.domElement ? this.domElement.clientHeight : 1;
                        this._rotateLeft((-_twoPI * this.keyRotateSpeed) / h);
                    }
                }
                else if (this.enablePan) {
                    this._pan(-this.keyPanSpeed, 0);
                }
                needsUpdate = true;
                break;
        }
        if (needsUpdate) {
            event.preventDefault();
            this.update();
        }
    }
    // ---- touch event handlers -------------------------------------------
    _handleTouchStartRotate(event) {
        if (this._pointers.length === 1) {
            this._rotateStart[0] = event.pageX;
            this._rotateStart[1] = event.pageY;
        }
        else {
            const pos = this._getSecondPointerPosition(event);
            this._rotateStart[0] = 0.5 * (event.pageX + pos[0]);
            this._rotateStart[1] = 0.5 * (event.pageY + pos[1]);
        }
    }
    _handleTouchStartPan(event) {
        if (this._pointers.length === 1) {
            this._panStart[0] = event.pageX;
            this._panStart[1] = event.pageY;
        }
        else {
            const pos = this._getSecondPointerPosition(event);
            this._panStart[0] = 0.5 * (event.pageX + pos[0]);
            this._panStart[1] = 0.5 * (event.pageY + pos[1]);
        }
    }
    _handleTouchStartDolly(event) {
        const pos = this._getSecondPointerPosition(event);
        const dx = event.pageX - pos[0];
        const dy = event.pageY - pos[1];
        this._dollyStart[0] = 0;
        this._dollyStart[1] = Math.sqrt(dx * dx + dy * dy);
    }
    _handleTouchStartDollyPan(event) {
        if (this.enableZoom)
            this._handleTouchStartDolly(event);
        if (this.enablePan)
            this._handleTouchStartPan(event);
    }
    _handleTouchStartDollyRotate(event) {
        if (this.enableZoom)
            this._handleTouchStartDolly(event);
        if (this.enableRotate)
            this._handleTouchStartRotate(event);
    }
    _handleTouchMoveRotate(event) {
        if (this._pointers.length === 1) {
            this._rotateEnd[0] = event.pageX;
            this._rotateEnd[1] = event.pageY;
        }
        else {
            const pos = this._getSecondPointerPosition(event);
            this._rotateEnd[0] = 0.5 * (event.pageX + pos[0]);
            this._rotateEnd[1] = 0.5 * (event.pageY + pos[1]);
        }
        this._rotateDelta[0] =
            (this._rotateEnd[0] - this._rotateStart[0]) * this.rotateSpeed;
        this._rotateDelta[1] =
            (this._rotateEnd[1] - this._rotateStart[1]) * this.rotateSpeed;
        const h = this.domElement ? this.domElement.clientHeight : 1;
        this._rotateLeft((_twoPI * this._rotateDelta[0]) / h);
        this._rotateUp((_twoPI * this._rotateDelta[1]) / h);
        this._rotateStart[0] = this._rotateEnd[0];
        this._rotateStart[1] = this._rotateEnd[1];
    }
    _handleTouchMovePan(event) {
        if (this._pointers.length === 1) {
            this._panEnd[0] = event.pageX;
            this._panEnd[1] = event.pageY;
        }
        else {
            const pos = this._getSecondPointerPosition(event);
            this._panEnd[0] = 0.5 * (event.pageX + pos[0]);
            this._panEnd[1] = 0.5 * (event.pageY + pos[1]);
        }
        this._panDelta[0] = (this._panEnd[0] - this._panStart[0]) * this.panSpeed;
        this._panDelta[1] = (this._panEnd[1] - this._panStart[1]) * this.panSpeed;
        this._pan(this._panDelta[0], this._panDelta[1]);
        this._panStart[0] = this._panEnd[0];
        this._panStart[1] = this._panEnd[1];
    }
    _handleTouchMoveDolly(event) {
        const pos = this._getSecondPointerPosition(event);
        const dx = event.pageX - pos[0];
        const dy = event.pageY - pos[1];
        const distance = Math.sqrt(dx * dx + dy * dy);
        this._dollyEnd[0] = 0;
        this._dollyEnd[1] = distance;
        this._dollyDelta[0] = 0;
        this._dollyDelta[1] = Math.pow(this._dollyEnd[1] / this._dollyStart[1], this.zoomSpeed);
        this._dollyOut(this._dollyDelta[1]);
        this._dollyStart[0] = this._dollyEnd[0];
        this._dollyStart[1] = this._dollyEnd[1];
        const centerX = (event.pageX + pos[0]) * 0.5;
        const centerY = (event.pageY + pos[1]) * 0.5;
        this._updateZoomParameters(centerX, centerY);
    }
    _handleTouchMoveDollyPan(event) {
        if (this.enableZoom)
            this._handleTouchMoveDolly(event);
        if (this.enablePan)
            this._handleTouchMovePan(event);
    }
    _handleTouchMoveDollyRotate(event) {
        if (this.enableZoom)
            this._handleTouchMoveDolly(event);
        if (this.enableRotate)
            this._handleTouchMoveRotate(event);
    }
    // ---- pointer tracking -----------------------------------------------
    _addPointer(event) {
        this._pointers.push(event.pointerId);
    }
    _removePointer(event) {
        delete this._pointerPositions[event.pointerId];
        const idx = this._pointers.indexOf(event.pointerId);
        if (idx !== -1)
            this._pointers.splice(idx, 1);
    }
    _isTrackingPointer(event) {
        return this._pointers.includes(event.pointerId);
    }
    _trackPointer(event) {
        let pos = this._pointerPositions[event.pointerId];
        if (pos === undefined) {
            pos = create$8();
            this._pointerPositions[event.pointerId] = pos;
        }
        pos[0] = event.pageX;
        pos[1] = event.pageY;
    }
    _getSecondPointerPosition(event) {
        const pointerId = event.pointerId === this._pointers[0] ? this._pointers[1] : this._pointers[0];
        return this._pointerPositions[pointerId] ?? create$8();
    }
    _customWheelEvent(event) {
        const newEvent = {
            clientX: event.clientX,
            clientY: event.clientY,
            deltaY: event.deltaY,
        };
        switch (event.deltaMode) {
            case 1: // LINE_MODE
                newEvent.deltaY *= 16;
                break;
            case 2: // PAGE_MODE
                newEvent.deltaY *= 100;
                break;
        }
        // Pinch-to-zoom via ctrl key + scroll on trackpads
        if (event.ctrlKey && !this._controlActive) {
            newEvent.deltaY *= 10;
        }
        return newEvent;
    }
}
// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------
function _isPerspective(camera) {
    return typeof camera.fov === 'number';
}
// ---------------------------------------------------------------------------
// Module-level event handler functions (bound in constructor)
// ---------------------------------------------------------------------------
function _onPointerDown(event) {
    if (!this.enabled)
        return;
    if (this._pointers.length === 0) {
        const el = this.domElement;
        el.setPointerCapture(event.pointerId);
        const doc = el.ownerDocument ?? el;
        doc.addEventListener('pointermove', this._onPointerMove);
        doc.addEventListener('pointerup', this._onPointerUp);
    }
    if (this._isTrackingPointer(event))
        return;
    this._addPointer(event);
    if (event.pointerType === 'touch') {
        this._onTouchStart(event);
    }
    else {
        this._onMouseDown(event);
    }
    if (this._cursorStyle === 'grab') {
        this.domElement.style.cursor = 'grabbing';
    }
}
function _onPointerMove(event) {
    if (!this.enabled)
        return;
    if (event.pointerType === 'touch') {
        this._onTouchMove(event);
    }
    else {
        this._onMouseMove(event);
    }
}
function _onPointerUp(event) {
    this._removePointer(event);
    if (this._pointers.length === 0) {
        const el = this.domElement;
        el.releasePointerCapture(event.pointerId);
        const doc = el.ownerDocument ?? el;
        doc.removeEventListener('pointermove', this._onPointerMove);
        doc.removeEventListener('pointerup', this._onPointerUp);
        this.dispatchEvent('end');
        this.state = STATE.NONE;
        if (this._cursorStyle === 'grab') {
            el.style.cursor = 'grab';
        }
    }
    else if (this._pointers.length === 1) {
        const pointerId = this._pointers[0];
        const pos = this._pointerPositions[pointerId];
        if (pos) {
            this._onTouchStart({
                pointerId,
                pageX: pos[0],
                pageY: pos[1],
                pointerType: 'touch',
            });
        }
    }
}
function _onMouseDown(event) {
    let mouseAction;
    switch (event.button) {
        case 0:
            mouseAction = this.mouseButtons.LEFT;
            break;
        case 1:
            mouseAction = this.mouseButtons.MIDDLE;
            break;
        case 2:
            mouseAction = this.mouseButtons.RIGHT;
            break;
        default:
            mouseAction = -1;
    }
    switch (mouseAction) {
        case MOUSE.DOLLY:
            if (!this.enableZoom)
                return;
            this._handleMouseDownDolly(event);
            this.state = STATE.DOLLY;
            break;
        case MOUSE.ROTATE:
            if (event.ctrlKey || event.metaKey || event.shiftKey) {
                if (!this.enablePan)
                    return;
                this._handleMouseDownPan(event);
                this.state = STATE.PAN;
            }
            else {
                if (!this.enableRotate)
                    return;
                this._handleMouseDownRotate(event);
                this.state = STATE.ROTATE;
            }
            break;
        case MOUSE.PAN:
            if (event.ctrlKey || event.metaKey || event.shiftKey) {
                if (!this.enableRotate)
                    return;
                this._handleMouseDownRotate(event);
                this.state = STATE.ROTATE;
            }
            else {
                if (!this.enablePan)
                    return;
                this._handleMouseDownPan(event);
                this.state = STATE.PAN;
            }
            break;
        default:
            this.state = STATE.NONE;
    }
    if (this.state !== STATE.NONE) {
        this.dispatchEvent('start');
    }
}
function _onMouseMove(event) {
    switch (this.state) {
        case STATE.ROTATE:
            if (!this.enableRotate)
                return;
            this._handleMouseMoveRotate(event);
            break;
        case STATE.DOLLY:
            if (!this.enableZoom)
                return;
            this._handleMouseMoveDolly(event);
            break;
        case STATE.PAN:
            if (!this.enablePan)
                return;
            this._handleMouseMovePan(event);
            break;
    }
}
function _onMouseWheel(event) {
    if (!this.enabled || !this.enableZoom || this.state !== STATE.NONE)
        return;
    event.preventDefault();
    this.dispatchEvent('start');
    this._handleMouseWheel(this._customWheelEvent(event));
    this.dispatchEvent('end');
}
function _onKeyDown(event) {
    if (!this.enabled)
        return;
    this._handleKeyDown(event);
}
function _onTouchStart(event) {
    this._trackPointer(event);
    switch (this._pointers.length) {
        case 1:
            switch (this.touches.ONE) {
                case TOUCH.ROTATE:
                    if (!this.enableRotate)
                        return;
                    this._handleTouchStartRotate(event);
                    this.state = STATE.TOUCH_ROTATE;
                    break;
                case TOUCH.PAN:
                    if (!this.enablePan)
                        return;
                    this._handleTouchStartPan(event);
                    this.state = STATE.TOUCH_PAN;
                    break;
                default:
                    this.state = STATE.NONE;
            }
            break;
        case 2:
            switch (this.touches.TWO) {
                case TOUCH.DOLLY_PAN:
                    if (!this.enableZoom && !this.enablePan)
                        return;
                    this._handleTouchStartDollyPan(event);
                    this.state = STATE.TOUCH_DOLLY_PAN;
                    break;
                case TOUCH.DOLLY_ROTATE:
                    if (!this.enableZoom && !this.enableRotate)
                        return;
                    this._handleTouchStartDollyRotate(event);
                    this.state = STATE.TOUCH_DOLLY_ROTATE;
                    break;
                default:
                    this.state = STATE.NONE;
            }
            break;
        default:
            this.state = STATE.NONE;
    }
    if (this.state !== STATE.NONE) {
        this.dispatchEvent('start');
    }
}
function _onTouchMove(event) {
    this._trackPointer(event);
    switch (this.state) {
        case STATE.TOUCH_ROTATE:
            if (!this.enableRotate)
                return;
            this._handleTouchMoveRotate(event);
            this.update();
            break;
        case STATE.TOUCH_PAN:
            if (!this.enablePan)
                return;
            this._handleTouchMovePan(event);
            this.update();
            break;
        case STATE.TOUCH_DOLLY_PAN:
            if (!this.enableZoom && !this.enablePan)
                return;
            this._handleTouchMoveDollyPan(event);
            this.update();
            break;
        case STATE.TOUCH_DOLLY_ROTATE:
            if (!this.enableZoom && !this.enableRotate)
                return;
            this._handleTouchMoveDollyRotate(event);
            this.update();
            break;
        default:
            this.state = STATE.NONE;
    }
}
function _onContextMenu(event) {
    if (!this.enabled)
        return;
    event.preventDefault();
}
function _interceptControlDown(event) {
    if (event.key === 'Control') {
        this._controlActive = true;
        const doc = this.domElement.getRootNode();
        doc.addEventListener('keyup', this._interceptControlUp, {
            passive: true,
            capture: true,
        });
    }
}
function _interceptControlUp(event) {
    if (event.key === 'Control') {
        this._controlActive = false;
        const doc = this.domElement.getRootNode();
        doc.removeEventListener('keyup', this._interceptControlUp, {
            capture: true,
        });
    }
}

class Scene extends Object3D {
    constructor() {
        super();
        this.name = 'Scene';
    }
}

class PerspectiveCamera extends Camera {
    fov;
    aspect;
    constructor(fov = Math.PI / 4, aspect = 1.0, near = 0.1, far = 1000.0) {
        super();
        this.name = 'PerspectiveCamera';
        this.fov = fov;
        this.aspect = aspect;
        this.near = near;
        this.far = far;
        this.updateProjectionMatrix();
    }
    /** Recompute the projection matrix from current fov / aspect / near / far. */
    updateProjectionMatrix() {
        perspectiveZO(this.projectionMatrix, this.fov, this.aspect, this.near, this.far);
    }
}

/**
 * Camera that uses orthographic projection.
 *
 * In this projection mode, an object's size in the rendered image stays constant
 * regardless of its distance from the camera. Useful for 2D scenes, UI, and
 * post-processing passes.
 *
 * Three.js aligned: mirrors THREE.OrthographicCamera.
 * Uses WebGPU depth range (0→1) via orthoZO, matching PerspectiveCamera's perspectiveZO.
 *
 * ```ts
 * const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
 * ```
 */
class OrthographicCamera extends Camera {
    isOrthographicCamera = true;
    left;
    right;
    top;
    bottom;
    zoom = 1;
    view = null;
    /**
     * @param left   - Left plane of the frustum.
     * @param right  - Right plane of the frustum.
     * @param top    - Top plane of the frustum.
     * @param bottom - Bottom plane of the frustum.
     * @param near   - Near plane. Unlike perspective cameras, 0 is valid here.
     * @param far    - Far plane.
     */
    constructor(left = -1, right = 1, top = 1, bottom = -1, near = 0.1, far = 2000) {
        super();
        this.name = 'OrthographicCamera';
        this.left = left;
        this.right = right;
        this.top = top;
        this.bottom = bottom;
        this.near = near;
        this.far = far;
        this.updateProjectionMatrix();
    }
    /**
     * Sets an offset into a larger frustum for multi-window / multi-monitor setups.
     *
     * @param fullWidth  - Full width of the multiview setup.
     * @param fullHeight - Full height of the multiview setup.
     * @param x          - Horizontal offset of the subcamera.
     * @param y          - Vertical offset of the subcamera.
     * @param width      - Width of the subcamera.
     * @param height     - Height of the subcamera.
     */
    setViewOffset(fullWidth, fullHeight, x, y, width, height) {
        if (this.view === null) {
            this.view = {
                enabled: true,
                fullWidth: 1,
                fullHeight: 1,
                offsetX: 0,
                offsetY: 0,
                width: 1,
                height: 1,
            };
        }
        this.view.enabled = true;
        this.view.fullWidth = fullWidth;
        this.view.fullHeight = fullHeight;
        this.view.offsetX = x;
        this.view.offsetY = y;
        this.view.width = width;
        this.view.height = height;
        this.updateProjectionMatrix();
    }
    /** Removes any view offset and recomputes the projection matrix. */
    clearViewOffset() {
        if (this.view !== null) {
            this.view.enabled = false;
        }
        this.updateProjectionMatrix();
    }
    /** Recompute the projection matrix from current frustum planes, zoom, and view offset. */
    updateProjectionMatrix() {
        const dx = (this.right - this.left) / (2 * this.zoom);
        const dy = (this.top - this.bottom) / (2 * this.zoom);
        const cx = (this.right + this.left) / 2;
        const cy = (this.top + this.bottom) / 2;
        let left = cx - dx;
        let right = cx + dx;
        let top = cy + dy;
        let bottom = cy - dy;
        if (this.view !== null && this.view.enabled) {
            const scaleW = (this.right - this.left) / this.view.fullWidth / this.zoom;
            const scaleH = (this.top - this.bottom) / this.view.fullHeight / this.zoom;
            left += scaleW * this.view.offsetX;
            right = left + scaleW * this.view.width;
            top -= scaleH * this.view.offsetY;
            bottom = top - scaleH * this.view.height;
        }
        // WebGPU depth range is 0→1, so use orthoZO (zero-to-one) to match perspectiveZO.
        orthoZO(this.projectionMatrix, left, right, bottom, top, this.near, this.far);
    }
}

/**
 * A texture for cubemaps (environment maps, skyboxes, etc).
 *
 * Stores 6 faces: +X, -X, +Y, -Y, +Z, -Z.
 * Sampled using a 3D direction vector.
 */
class CubeTexture {
    /** Type flag for runtime checking */
    isCubeTexture = true;
    /** The underlying GPU texture resource */
    _gpuTexture;
    /** The underlying sampler */
    _gpuSampler;
    /** Optional name for debugging */
    name = '';
    /**
     * Mapping mode - determines default UV vector.
     * - 'reflection': uses reflect(viewDir, normal)
     * - 'refraction': uses refract(viewDir, normal, ior)
     */
    mapping;
    /**
     * Constructs a new CubeTexture.
     *
     * @param faces - Array of 6 images for cube faces (+X, -X, +Y, -Y, +Z, -Z)
     * @param options - Texture options
     */
    constructor(faces = [], options = {}) {
        // Determine size from first face
        const firstFace = faces[0];
        let size = 1;
        if (firstFace) {
            if (firstFace instanceof Source) {
                size = firstFace.width || 1;
            }
            else if (typeof firstFace === 'object' && firstFace !== null && 'width' in firstFace) {
                size = firstFace.width || 1;
            }
        }
        this._gpuTexture = new GpuTexture(textureCube(), {
            size,
            faces: faces.map(f => f instanceof Source ? f : new Source(f)),
            format: options.format,
            generateMipmaps: options.generateMipmaps ?? true,
            flipY: options.flipY ?? false,
        });
        this._gpuSampler = new GpuSampler({
            addressModeU: options.wrapS ?? 'clamp-to-edge',
            addressModeV: options.wrapT ?? 'clamp-to-edge',
            addressModeW: 'clamp-to-edge',
            magFilter: options.magFilter ?? 'linear',
            minFilter: options.minFilter ?? 'linear',
            mipmapFilter: options.mipmapFilter ?? 'linear',
        });
        this.mapping = options.mapping ?? 'reflection';
    }
    // ─── Convenience getters/setters ───
    get id() { return this._gpuTexture.id; }
    get width() { return this._gpuTexture.width; }
    get height() { return this._gpuTexture.height; }
    get size() { return this._gpuTexture.size; }
    /** Check if all 6 faces are present and ready */
    get isComplete() { return this._gpuTexture.isComplete; }
    /** The 6 face images as SourceData */
    get images() {
        return this._gpuTexture.sources.map(s => s.data);
    }
    set images(value) {
        this._gpuTexture.sources = value.map(img => img instanceof Source ? img : new Source(img));
        // Update size from first face
        if (value.length > 0) {
            const first = this._gpuTexture.sources[0];
            if (first) {
                this._gpuTexture.width = first.width || 1;
                this._gpuTexture.height = first.height || 1;
            }
        }
        this._gpuTexture.needsUpdate = true;
    }
    /** The 6 face Sources */
    get imageSources() {
        return this._gpuTexture.sources;
    }
    get wrapS() { return this._gpuSampler.addressModeU; }
    set wrapS(v) { this._gpuSampler.addressModeU = v; }
    get wrapT() { return this._gpuSampler.addressModeV; }
    set wrapT(v) { this._gpuSampler.addressModeV = v; }
    get magFilter() { return this._gpuSampler.magFilter; }
    set magFilter(v) { this._gpuSampler.magFilter = v; }
    get minFilter() { return this._gpuSampler.minFilter; }
    set minFilter(v) { this._gpuSampler.minFilter = v; }
    get mipmapFilter() { return this._gpuSampler.mipmapFilter; }
    set mipmapFilter(v) { this._gpuSampler.mipmapFilter = v; }
    get anisotropy() { return this._gpuSampler.maxAnisotropy; }
    set anisotropy(v) { this._gpuSampler.maxAnisotropy = v; }
    get format() { return this._gpuTexture.format; }
    set format(v) { this._gpuTexture.format = v; }
    get generateMipmaps() { return this._gpuTexture.generateMipmaps; }
    set generateMipmaps(v) { this._gpuTexture.generateMipmaps = v; }
    get flipY() { return this._gpuTexture.flipY; }
    set flipY(v) { this._gpuTexture.flipY = v; }
    get premultiplyAlpha() { return this._gpuTexture.premultiplyAlpha; }
    set premultiplyAlpha(v) { this._gpuTexture.premultiplyAlpha = v; }
    get version() { return this._gpuTexture.version; }
    set needsUpdate(v) {
        if (v)
            this._gpuTexture.needsUpdate = true;
    }
    clone() {
        const tex = new CubeTexture(this.images, {
            wrapS: this.wrapS,
            wrapT: this.wrapT,
            magFilter: this.magFilter,
            minFilter: this.minFilter,
            mipmapFilter: this.mipmapFilter,
            format: this.format,
            generateMipmaps: this.generateMipmaps,
            flipY: this.flipY,
            mapping: this.mapping,
        });
        tex.name = this.name;
        return tex;
    }
    dispose() {
        this._gpuTexture.dispose();
        this._gpuSampler.dispose();
    }
}

/**
 * A 2D texture array - multiple 2D textures stacked as layers.
 *
 * Each layer has the same dimensions. Sampled using vec2 UV + layer index.
 * Useful for: sprite atlases, terrain splatting, shadow map arrays.
 */
class ArrayTexture {
    /** Type flag for runtime checking */
    isArrayTexture = true;
    /** The underlying GPU texture resource */
    _gpuTexture;
    /** The underlying sampler */
    _gpuSampler;
    /** Optional name for debugging */
    name = '';
    /**
     * Constructs a new ArrayTexture.
     *
     * @param data - Optional raw data for all layers
     * @param width - Width of each layer
     * @param height - Height of each layer
     * @param depth - Number of layers
     * @param options - Texture options
     */
    constructor(data = null, width = 1, height = 1, depth = 1, options = {}) {
        // Create source if data provided
        const src = data !== null
            ? new Source({ data, width, height, depth })
            : null;
        // Create the underlying GpuTexture
        this._gpuTexture = new GpuTexture(texture2dArray(), {
            width,
            height,
            layers: depth,
            source: src ?? undefined,
            format: options.format,
            generateMipmaps: options.generateMipmaps ?? false,
            flipY: options.flipY ?? false,
            premultiplyAlpha: options.premultiplyAlpha ?? false,
        });
        // Create the underlying sampler with defaults for array textures
        this._gpuSampler = new GpuSampler({
            addressModeU: options.wrapS ?? 'clamp-to-edge',
            addressModeV: options.wrapT ?? 'clamp-to-edge',
            magFilter: options.magFilter ?? 'nearest',
            minFilter: options.minFilter ?? 'nearest',
            mipmapFilter: options.mipmapFilter ?? 'nearest',
            maxAnisotropy: options.anisotropy ?? 1,
        });
    }
    // ─── Convenience getters/setters that forward to internals ───
    /** Unique numeric ID */
    get id() { return this._gpuTexture.id; }
    /** Returns the width of each layer. */
    get width() { return this._gpuTexture.width; }
    /** Returns the height of each layer. */
    get height() { return this._gpuTexture.height; }
    /** Depth (number of layers) of the texture array */
    get depth() { return this._gpuTexture.depthOrArrayLayers; }
    /** The data source for this texture. */
    get source() {
        return this._gpuTexture.source;
    }
    /** Convenience getter for the source data. */
    get image() {
        return this._gpuTexture.source?.data;
    }
    /** Horizontal wrap mode (U direction). */
    get wrapS() { return this._gpuSampler.addressModeU; }
    set wrapS(v) { this._gpuSampler.addressModeU = v; }
    /** Vertical wrap mode (V direction). */
    get wrapT() { return this._gpuSampler.addressModeV; }
    set wrapT(v) { this._gpuSampler.addressModeV = v; }
    /** Magnification filter. */
    get magFilter() { return this._gpuSampler.magFilter; }
    set magFilter(v) { this._gpuSampler.magFilter = v; }
    /** Minification filter. */
    get minFilter() { return this._gpuSampler.minFilter; }
    set minFilter(v) { this._gpuSampler.minFilter = v; }
    /** Mipmap filter mode. */
    get mipmapFilter() { return this._gpuSampler.mipmapFilter; }
    set mipmapFilter(v) { this._gpuSampler.mipmapFilter = v; }
    /** Anisotropic filtering level. */
    get anisotropy() { return this._gpuSampler.maxAnisotropy; }
    set anisotropy(v) { this._gpuSampler.maxAnisotropy = v; }
    /** WebGPU texture format. */
    get format() { return this._gpuTexture.format; }
    set format(v) { this._gpuTexture.format = v; }
    /** Whether to auto-generate mipmaps. */
    get generateMipmaps() { return this._gpuTexture.generateMipmaps; }
    set generateMipmaps(v) { this._gpuTexture.generateMipmaps = v; }
    /** Whether to flip the image vertically when uploading. */
    get flipY() { return this._gpuTexture.flipY; }
    set flipY(v) { this._gpuTexture.flipY = v; }
    /** Whether to premultiply alpha. */
    get premultiplyAlpha() { return this._gpuTexture.premultiplyAlpha; }
    set premultiplyAlpha(v) { this._gpuTexture.premultiplyAlpha = v; }
    /** Version for dirty tracking. */
    get version() { return this._gpuTexture.version; }
    /** Set to `true` to trigger a GPU upload on the next render. */
    set needsUpdate(value) {
        if (value) {
            this._gpuTexture.needsUpdate = true;
            if (this._gpuTexture.source) {
                this._gpuTexture.source.needsUpdate = true;
            }
        }
    }
    /** Track which layers have been modified (forwards to GpuTexture). */
    get layerUpdates() { return this._gpuTexture.layerUpdates; }
    /** Mark a specific layer as needing update. On next upload, only this layer will be transferred. */
    addLayerUpdate(layerIndex) {
        this._gpuTexture.layerUpdates.add(layerIndex);
    }
    /** Clear the layer update tracking, called by the renderer after upload. */
    clearLayerUpdates() {
        this._gpuTexture.layerUpdates.clear();
    }
    /** Creates a clone of this texture. */
    clone() {
        const img = this.image;
        const tex = new ArrayTexture(img?.data ?? null, this.width, this.height, this.depth, {
            wrapS: this.wrapS,
            wrapT: this.wrapT,
            magFilter: this.magFilter,
            minFilter: this.minFilter,
            mipmapFilter: this.mipmapFilter,
            anisotropy: this.anisotropy,
            format: this.format,
            generateMipmaps: this.generateMipmaps,
            flipY: this.flipY,
            premultiplyAlpha: this.premultiplyAlpha,
        });
        tex.name = this.name;
        return tex;
    }
    /** Disposes of the texture and its GPU resources. */
    dispose() {
        this._gpuTexture.dispose();
        this._gpuSampler.dispose();
    }
}

function create() {
    return [
        create$3(),
        create$3(),
        create$3(),
        create$3(),
        create$3(),
        create$3(),
    ];
}
function clone(f) {
    return [
        clone$1(f[0]),
        clone$1(f[1]),
        clone$1(f[2]),
        clone$1(f[3]),
        clone$1(f[4]),
        clone$1(f[5]),
    ];
}
function copy(out, f) {
    copy$1(out[0], f[0]);
    copy$1(out[1], f[1]);
    copy$1(out[2], f[2]);
    copy$1(out[3], f[3]);
    copy$1(out[4], f[4]);
    copy$1(out[5], f[5]);
    return out;
}
function setFromViewProjectionMatrix(out, proj, view) {
    const vp = create$6();
    multiply(vp, proj, view);
    const m = vp;
    setPlane(out[0], m[0] + m[3], m[4] + m[7], m[8] + m[11], m[12] + m[15]);
    setPlane(out[1], -m[0] + m[3], -m[4] + m[7], -m[8] + m[11], -m[12] + m[15]);
    setPlane(out[2], m[1] + m[3], m[5] + m[7], m[9] + m[11], m[13] + m[15]);
    setPlane(out[3], -m[1] + m[3], -m[5] + m[7], -m[9] + m[11], -m[13] + m[15]);
    setPlane(out[4], m[2], m[6], m[10], m[14]);
    setPlane(out[5], -m[2] + m[3], -m[6] + m[7], -m[10] + m[11], -m[14] + m[15]);
    for (let i = 0; i < 6; i++) {
        normalize(out[i], out[i]);
    }
    return out;
}
function intersectsSphere(f, s) {
    const { center, radius } = s;
    for (let i = 0; i < 6; i++) {
        if (distanceToPoint(f[i], center) < -radius) {
            return false;
        }
    }
    return true;
}
function intersectsBox3(f, box) {
    const [minX, minY, minZ, maxX, maxY, maxZ] = box;
    for (let i = 0; i < 6; i++) {
        const p = f[i];
        const nx = p.normal[0];
        const ny = p.normal[1];
        const nz = p.normal[2];
        const px = nx >= 0 ? maxX : minX;
        const py = ny >= 0 ? maxY : minY;
        const pz = nz >= 0 ? maxZ : minZ;
        if (nx * px + ny * py + nz * pz + p.constant < 0) {
            return false;
        }
    }
    return true;
}
function setPlane(out, nx, ny, nz, d) {
    out.normal[0] = nx;
    out.normal[1] = ny;
    out.normal[2] = nz;
    out.constant = d;
}

var frustum = /*#__PURE__*/Object.freeze({
    __proto__: null,
    clone: clone,
    copy: copy,
    create: create,
    intersectsBox3: intersectsBox3,
    intersectsSphere: intersectsSphere,
    setFromViewProjectionMatrix: setFromViewProjectionMatrix
});

function yieldToMain() {
    // modern browsers: scheduler.yield() is the most efficient way to yield
    if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
        return scheduler.yield();
    }
    // fallback: setTimeout with 0ms delay yields to the event loop
    return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * All known WebGPU feature names as of the current spec.
 *
 * This mirrors the browser's GPUFeatureName type but as a runtime-accessible
 * object so we can iterate over its values when requesting device features.
 * Kept in sync with the WebGPU spec and Three.js's WebGPUConstants.js.
 */
const GPUFeatureName = {
    CoreFeaturesAndLimits: 'core-features-and-limits',
    DepthClipControl: 'depth-clip-control',
    Depth32FloatStencil8: 'depth32float-stencil8',
    TextureCompressionBC: 'texture-compression-bc',
    TextureCompressionBCSliced3D: 'texture-compression-bc-sliced-3d',
    TextureCompressionETC2: 'texture-compression-etc2',
    TextureCompressionASTC: 'texture-compression-astc',
    TextureCompressionASTCSliced3D: 'texture-compression-astc-sliced-3d',
    TimestampQuery: 'timestamp-query',
    IndirectFirstInstance: 'indirect-first-instance',
    ShaderF16: 'shader-f16',
    RG11B10UFloatRenderable: 'rg11b10ufloat-renderable',
    BGRA8UnormStorage: 'bgra8unorm-storage',
    Float32Filterable: 'float32-filterable',
    Float32Blendable: 'float32-blendable',
    ClipDistances: 'clip-distances',
    DualSourceBlending: 'dual-source-blending',
    Subgroups: 'subgroups',
    TextureFormatsTier1: 'texture-formats-tier1',
    TextureFormatsTier2: 'texture-formats-tier2',
};

/**
 * pass-context.ts — GPU pass configuration and caching.
 *
 * Contains context types for both render and compute passes:
 * - RenderContext: Configuration for render passes (framebuffer, clear state, viewport, etc.)
 * - ComputeContext: Configuration for compute passes (currently minimal, used for bind group caching)
 *
 * Aligned with Three.js RenderContext + RenderContexts pattern.
 *
 * Functional pattern: state object + functions.
 */
// ---------------------------------------------------------------------------
// RenderContext ID counter
// ---------------------------------------------------------------------------
let renderContextIdCounter = 0;
// ---------------------------------------------------------------------------
// ComputeContext
// ---------------------------------------------------------------------------
let computeContextIdCounter = 0;
/**
 * Create a new ComputeContext.
 */
function createComputeContext() {
    return {
        id: computeContextIdCounter++,
        isComputeContext: true,
    };
}
/**
 * Create a new RenderContext with default values.
 */
function createRenderContext() {
    return {
        id: renderContextIdCounter++,
        // MRT
        mrt: null,
        // Clear state
        clearColor: true,
        clearColorValue: { r: 0, g: 0, b: 0, a: 1 },
        clearDepth: true,
        clearDepthValue: 1,
        clearStencil: true,
        clearStencilValue: 0,
        // Attachments
        color: true,
        depth: true,
        stencil: false,
        // Viewport/scissor
        viewport: false,
        viewportValue: { x: 0, y: 0, width: 0, height: 0, minDepth: 0, maxDepth: 1 },
        scissor: false,
        scissorValue: { x: 0, y: 0, width: 0, height: 0 },
        // Dimensions
        width: 0,
        height: 0,
        // Render target
        renderTarget: null,
        textures: null,
        depthTexture: null,
        activeCubeFace: 0,
        activeMipmapLevel: 0,
        // MSAA
        sampleCount: 1,
        // Context
        camera: null,
        // Type flag
        isRenderContext: true,
    };
}
/**
 * Create a new RenderContexts state.
 */
function createRenderContextsState() {
    return {
        contexts: new Map(),
        defaultClearDepth: 1,
        defaultClearStencil: 0,
    };
}
// ---------------------------------------------------------------------------
// Cache Key Computation
// ---------------------------------------------------------------------------
/**
 * Build the attachment state portion of the cache key.
 *
 * For default framebuffer, returns 'default'.
 * For render targets, returns: `{count}:{format}:{type}:{samples}:{depth}:{stencil}`
 */
function buildAttachmentState(renderTarget) {
    if (renderTarget === null) {
        return 'default';
    }
    const format = renderTarget.colorFormat;
    const count = renderTarget.textures.length;
    const samples = renderTarget.samples;
    const depth = renderTarget.depthFormat !== null;
    const stencil = false; // TODO: Add stencil support to RenderTarget
    return `${count}:${format}:${samples}:${depth}:${stencil}`;
}
/**
 * Build the MRT state portion of the cache key.
 */
function buildMrtState(mrt) {
    if (mrt === null) {
        return 'default';
    }
    return String(mrt.id);
}
/**
 * Build the full cache key for a render context.
 */
function buildCacheKey(renderTarget, mrt, callDepth) {
    const attachmentState = buildAttachmentState(renderTarget);
    const mrtState = buildMrtState(mrt);
    return `${attachmentState}-${mrtState}-${callDepth}`;
}
/**
 * Get or create a RenderContext for the given configuration.
 *
 * Aligned with Three.js RenderContexts.get():
 * - Returns cached context if configuration matches
 * - Creates new context if not found
 * - Updates dynamic values (clear values, sample count) on each access
 *
 * @param state - The RenderContexts state
 * @param renderTarget - The render target, or null for default framebuffer
 * @param mrt - The MRT node, or null
 * @param callDepth - Nesting depth for recursive render calls
 * @returns The render context for this configuration
 */
function getRenderContext(state, renderTarget, mrt, callDepth) {
    const cacheKey = buildCacheKey(renderTarget, mrt, callDepth);
    let context = state.contexts.get(cacheKey);
    if (context === undefined) {
        context = createRenderContext();
        context.mrt = mrt;
        state.contexts.set(cacheKey, context);
    }
    // Update dynamic values on each access
    if (renderTarget !== null) {
        context.sampleCount = renderTarget.samples === 0 ? 1 : renderTarget.samples;
        context.depth = renderTarget.depthFormat !== null;
    }
    context.clearDepthValue = state.defaultClearDepth;
    context.clearStencilValue = state.defaultClearStencil;
    return context;
}

/**
 * render-list.ts - Sorted render item list with object pooling and scene collection.
 *
 * Aligned with Three.js RenderList + RenderLists:
 * - Object pooling for RenderItems (avoids GC pressure)
 * - Sorted opaque and transparent lists
 * - Cached per scene/camera using ChainMap
 * - Frustum culling integration
 * - Scene graph traversal
 *
 * RenderList collects meshes from a scene graph and sorts them for rendering:
 * - Opaque: sorted by material/pipeline key to minimize state changes
 * - Transparent: sorted back-to-front by view-space Z
 */
// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------
/** ID counter for RenderItems. */
let renderItemIdCounter = 0;
/**
 * Create a new RenderList.
 */
function createRenderList() {
    return {
        object: null,
        camera: null,
        renderItems: [],
        renderItemsIndex: 0,
        opaque: [],
        transparent: [],
        occlusionQueryCount: 0,
    };
}
/**
 * Create a new RenderLists state.
 */
function createRenderListsState() {
    return {
        lists: create$9(),
    };
}
// ---------------------------------------------------------------------------
// RenderList Access
// ---------------------------------------------------------------------------
/**
 * Get or create a RenderList for the given object and camera.
 *
 * @param state - The RenderLists state
 * @param object - The object to render (Scene, Mesh, or any Object3D)
 * @param camera - The camera to render from
 */
function getRenderList(state, object, camera) {
    const keys = [object, camera];
    let list = get(state.lists, keys);
    if (!list) {
        list = createRenderList();
        set$3(state.lists, keys, list);
    }
    return list;
}
// ---------------------------------------------------------------------------
// List Management
// ---------------------------------------------------------------------------
/**
 * Begin building a render list for a new frame.
 *
 * This resets the pool index but keeps pooled items for reuse.
 */
function beginRenderList(list, object, camera) {
    list.object = object;
    list.camera = camera;
    list.renderItemsIndex = 0;
    list.opaque.length = 0;
    list.transparent.length = 0;
    list.occlusionQueryCount = 0;
}
/**
 * Get a RenderItem from the pool (or create a new one).
 */
function getNextRenderItem(list) {
    const index = list.renderItemsIndex;
    let item = list.renderItems[index];
    if (item === undefined) {
        item = {
            id: renderItemIdCounter++,
            mesh: null,
            geometry: null,
            material: null,
            groupOrder: 0,
            renderOrder: 0,
            z: 0,
        };
        list.renderItems.push(item);
    }
    list.renderItemsIndex++;
    return item;
}
/**
 * Push a mesh into the render list.
 *
 * @param list - The RenderList
 * @param mesh - The mesh to add
 * @param geometry - The mesh's geometry
 * @param material - The mesh's material
 * @param groupOrder - Group order for layer-based sorting
 * @param z - View-space Z for transparent sorting
 */
function pushRenderItem(list, mesh, geometry, material, groupOrder, z) {
    const item = getNextRenderItem(list);
    item.mesh = mesh;
    item.geometry = geometry;
    item.material = material;
    item.groupOrder = groupOrder;
    item.renderOrder = mesh.renderOrder;
    item.z = z;
    if (material.transparent) {
        list.transparent.push(item);
    }
    else {
        list.opaque.push(item);
    }
}
// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------
/**
 * Sort the render list.
 *
 * @param list - The RenderList to sort
 * @param customOpaqueSort - Optional custom sort for opaque items
 * @param customTransparentSort - Optional custom sort for transparent items
 */
function sortRenderList(list, customOpaqueSort, customTransparentSort) {
    if (list.opaque.length > 1) {
        list.opaque.sort(painterSortStable);
    }
    if (list.transparent.length > 1) {
        list.transparent.sort(reversePainterSortStable);
    }
}
/**
 * Default sort for opaque items.
 *
 * Sort priority (matches Three.js painterSortStable):
 * 1. groupOrder (render layers)
 * 2. renderOrder (manual ordering)
 * 3. Z (front-to-back for early-z rejection)
 * 4. ID (stability)
 *
 * Note: Three.js does NOT sort by material/pipeline. Pipeline switching is
 * minimized at draw time by tracking the active pipeline in setPipeline().
 */
function painterSortStable(a, b) {
    if (a.groupOrder !== b.groupOrder) {
        return a.groupOrder - b.groupOrder;
    }
    if (a.renderOrder !== b.renderOrder) {
        return a.renderOrder - b.renderOrder;
    }
    if (a.z !== b.z) {
        return a.z - b.z;
    }
    return a.id - b.id;
}
/**
 * Default sort for transparent items (back-to-front).
 *
 * "Reverse painter sort stable" - sorts back-to-front for proper alpha blending.
 */
function reversePainterSortStable(a, b) {
    // Sort by groupOrder first (render layers)
    if (a.groupOrder !== b.groupOrder) {
        return a.groupOrder - b.groupOrder;
    }
    // Then by renderOrder
    if (a.renderOrder !== b.renderOrder) {
        return a.renderOrder - b.renderOrder;
    }
    // Then by Z (back-to-front for transparent = larger Z first)
    if (a.z !== b.z) {
        return b.z - a.z;
    }
    // Finally by ID for stability
    return a.id - b.id;
}
// ---------------------------------------------------------------------------
// Scene Collection
// ---------------------------------------------------------------------------
/** Frustum used for culling; rebuilt from VP every frame. */
const _frustum = create();
/** World-space AABB used when transforming a local bounding box. */
const _worldBox = [0, 0, 0, 0, 0, 0];
/** World-space sphere used when transforming a local bounding sphere. */
const _worldSphere = { center: [0, 0, 0], radius: 0 };
/**
 * Collect all visible meshes from a scene into a RenderList.
 *
 * This walks the object graph, performs frustum culling, and populates
 * the RenderList with opaque and transparent items.
 *
 * @param state - The RenderLists state
 * @param object - The object to collect from (Scene, Mesh, or any Object3D)
 * @param camera - The camera for frustum culling and Z sorting
 * @param overrideMaterial - When set, all meshes use this material instead of their own
 * @returns The populated and sorted RenderList
 */
function collectRenderList(state, object, camera, overrideMaterial = null) {
    const list = getRenderList(state, object, camera);
    // Begin new frame
    beginRenderList(list, object, camera);
    // Build frustum from camera matrices
    setFromViewProjectionMatrix(_frustum, camera.projectionMatrix, camera.matrixWorldInverse);
    // Walk object and collect visible meshes
    walkObject(list, object, camera, overrideMaterial);
    sortRenderList(list);
    return list;
}
/**
 * Walk the scene graph and collect visible meshes.
 */
function walkObject(list, obj, camera, overrideMaterial) {
    if (!obj.visible)
        return;
    if (obj instanceof Mesh) {
        if (isMeshVisible(obj)) {
            const material = overrideMaterial ?? obj.material;
            const z = computeViewZ(obj, camera);
            pushRenderItem(list, obj, obj.geometry, material, 0, // groupOrder - could be mesh.renderOrder or layer
            z);
        }
    }
    // Recurse into children
    for (const child of obj.children) {
        walkObject(list, child, camera, overrideMaterial);
    }
}
/**
 * Test whether a mesh should be included in the draw list.
 *
 * Uses frustum culling with bounding volumes:
 * 1. boundingSphere — cheapest test (6 dot-products)
 * 2. boundingBox — more precise but slightly more work
 * 3. no bounds — always visible (safe fallback)
 */
function isMeshVisible(mesh) {
    const geom = mesh.geometry;
    const wm = mesh.matrixWorld;
    // Skip disposed geometries
    if (geom.disposed)
        return false;
    if (!mesh.frustumCulled)
        return true;
    // --- sphere test (preferred) ------------------------------------------
    if (geom.boundingSphere !== undefined) {
        const ls = geom.boundingSphere;
        // Transform centre: ws_centre = wm * [cx, cy, cz, 1]
        const cx = ls.center[0];
        const cy = ls.center[1];
        const cz = ls.center[2];
        _worldSphere.center[0] = wm[0] * cx + wm[4] * cy + wm[8] * cz + wm[12];
        _worldSphere.center[1] = wm[1] * cx + wm[5] * cy + wm[9] * cz + wm[13];
        _worldSphere.center[2] = wm[2] * cx + wm[6] * cy + wm[10] * cz + wm[14];
        // Scale the radius by the largest axis scale extracted from the world matrix.
        const sx = Math.sqrt(wm[0] * wm[0] + wm[1] * wm[1] + wm[2] * wm[2]);
        const sy = Math.sqrt(wm[4] * wm[4] + wm[5] * wm[5] + wm[6] * wm[6]);
        const sz = Math.sqrt(wm[8] * wm[8] + wm[9] * wm[9] + wm[10] * wm[10]);
        _worldSphere.radius = ls.radius * Math.max(sx, sy, sz);
        return intersectsSphere(_frustum, _worldSphere);
    }
    // --- AABB test (fallback) -----------------------------------------------
    if (geom.boundingBox !== undefined) {
        // Transform the local AABB by the world matrix to a world-space AABB.
        transformMat4(_worldBox, geom.boundingBox, wm);
        return intersectsBox3(_frustum, _worldBox);
    }
    // --- no bounds — always draw -------------------------------------------
    return true;
}
/**
 * Compute the view-space Z of a mesh for transparent sorting.
 *
 * Uses the mesh world-position (column 12, 13, 14 of matrixWorld)
 * and the camera view matrix.
 *
 * Returns the view-space Z coordinate (negative = in front of camera in a
 * right-handed system; we sort from largest (furthest) to smallest).
 */
function computeViewZ(mesh, camera) {
    const wm = mesh.matrixWorld;
    const vm = camera.matrixWorldInverse;
    // World position of mesh origin
    const wx = wm[12];
    const wy = wm[13];
    const wz = wm[14];
    // Transform world position by view matrix (only z row needed)
    return vm[2] * wx + vm[6] * wy + vm[10] * wz + vm[14];
}

class WebGPURenderer {
    /** Whether the renderer has been initialized (adapter/device/context created) or not. @internal */
    _initialized = false;
    /** Indicates whether the device has been lost or not. When this is set to `true`, rendering isn't possible anymore. @internal */
    _isDeviceLost = false;
    /** Inspector. Replace with a RendererInspector or Inspector instance to enable profiling. */
    inspector = new InspectorBase();
    /** The canvas dom element for the current canvas target */
    get domElement() {
        return this._canvasTarget.domElement;
    }
    /** The WebGPU GPU adapter in use. */
    _adapter = null;
    /** The WebGPU GPU device in use. */
    _device = null;
    /** The WebGPU texture format used for the swapchain. */
    _format = null;
    /** MSAA sample count (0 or 1 = no MSAA). */
    samples;
    /** GPURequestAdapterOptions forwarded to navigator.gpu.requestAdapter(). */
    _adapterOptions;
    /** GPUDeviceDescriptor forwarded to adapter.requestDevice(). */
    _deviceDescriptor;
    /**
     * A callback function that is executed when a device loss occurs.
     * @example
     * renderer.onDeviceLost = (info) => {
     *     console.error('GPU device lost:', info.message);
     *     // Optionally: show error UI, attempt recovery, etc.
     * };
     */
    onDeviceLost = null;
    /** swapchain depth texture (recreated on resize) */
    _depthTexture = null;
    /** MSAA color texture (null when samples <= 1). Only used for swapchain passes */
    _msaaTexture = null;
    /** @internal */
    _buffers;
    /** @internal */
    _textures;
    /** @internal */
    _pipelines;
    /** @internal */
    _renderContexts;
    /** @internal */
    _computeContext;
    /** @internal */
    _geometries;
    /** @internal */
    _nodes;
    /** @internal */
    _bindings;
    /** @internal */
    _renderObjects;
    /** @internal */
    _renderLists;
    /** Render call depth for nested render support. 0 = top-level render. @internal */
    _renderCallDepth = 0;
    /** clear color for the final swapchain composite pass. defaults to opaque black. */
    clearColor = [0, 0, 0, 1];
    /** current MRT configuration. when set, materials using mrt() nodes write to multiple color attachments. */
    mrt = null;
    /** current render target. when set, render() renders to this target instead of the swapchain. */
    renderTarget = null;
    /** when set, all meshes in the scene render with this material instead of their own. */
    overrideMaterial = null;
    /** @internal current canvas target. the inspector viewer swaps this for preview renders. */
    _canvasTarget;
    /** swap the active canvas target (used by inspector viewer for preview renders). */
    setCanvasTarget(canvasTarget) {
        this._canvasTarget = canvasTarget;
        return this;
    }
    getCanvasTarget() {
        return this._canvasTarget;
    }
    /** @internal Pre-created device (for device sharing or testing) */
    _preDevice;
    /** @internal Pre-created adapter */
    _preAdapter;
    /** @internal Pre-specified format */
    _preFormat;
    constructor(opts = {}) {
        let samples = 0;
        if (opts.samples !== undefined) {
            samples = opts.samples <= 1 ? 0 : opts.samples;
        }
        else if (opts.antialias) {
            samples = 4;
        }
        this.samples = samples;
        this._adapterOptions = opts.adapterOptions;
        this._deviceDescriptor = opts.deviceDescriptor;
        this._preDevice = opts.device;
        this._preAdapter = opts.adapter;
        this._preFormat = opts.format;
        // Create the main canvas and wrap it as the default CanvasTarget.
        // Use provided canvas if given, otherwise create one.
        const canvas = opts.canvas ?? document.createElement('canvas');
        if (!opts.canvas) {
            canvas.style.display = 'block';
        }
        this._canvasTarget = new CanvasTarget(canvas);
        this._canvasTarget.isDefaultCanvasTarget = true;
        this._renderContexts = createRenderContextsState();
        this._computeContext = createComputeContext();
        this._nodes = createNodeManagerState();
        this._renderLists = createRenderListsState();
        this._bindings = createBindingsState();
        this._pipelines = createPipelinesState();
        this._renderObjects = createRenderObjectsState();
        this._buffers = createBufferCache();
        this._textures = createTextureCache();
        this._geometries = createGeometriesState();
    }
    /**
     * Initialise the WebGPU adapter, device, and canvas context.
     * Must be called (and awaited) before the first call to pipeline.render().
     *
     * @throws if WebGPU is not available or no suitable adapter is found.
     */
    async init() {
        if (this._initialized)
            return this;
        // use pre-created device if provided, otherwise use navigator.gpu
        if (this._preDevice) {
            this._device = this._preDevice;
            this._adapter = this._preAdapter;
            this._format = this._preFormat ?? 'bgra8unorm';
        }
        else {
            // check for WebGPU support
            if (!navigator.gpu) {
                throw new Error('[WebGPURenderer] WebGPU is not supported in this environment.');
            }
            // request adapter
            const adapter = await navigator.gpu.requestAdapter(this._adapterOptions);
            if (!adapter) {
                throw new Error('[WebGPURenderer] No WebGPU adapter found. Is WebGPU enabled?');
            }
            this._adapter = adapter;
            // request every feature the adapter supports
            const requiredFeatures = Object.values(GPUFeatureName).filter((f) => adapter.features.has(f));
            // merge with any caller-supplied descriptor, deduplicating features.
            const callerFeatures = this._deviceDescriptor?.requiredFeatures ?? [];
            const mergedFeatures = [
                ...new Set([...requiredFeatures, ...callerFeatures]),
            ];
            const deviceDescriptor = {
                ...this._deviceDescriptor,
                requiredFeatures: mergedFeatures,
            };
            this._device = await adapter.requestDevice(deviceDescriptor);
            // set up device lost handler
            this._device.lost.then((info) => {
                // ignore intentional device destruction
                if (info.reason === 'destroyed')
                    return;
                const deviceLossInfo = {
                    api: 'WebGPU',
                    message: info.message || 'Unknown reason',
                    reason: info.reason || null,
                    originalEvent: info,
                };
                console.error(`[WebGPURenderer] WebGPU Device Lost:\n` +
                    `  Message: ${deviceLossInfo.message}\n` +
                    `  Reason: ${deviceLossInfo.reason ?? 'unknown'}`);
                this._isDeviceLost = true;
                this.onDeviceLost?.(deviceLossInfo);
            });
            // initialize the main canvas target context.
            this._format = navigator.gpu.getPreferredCanvasFormat();
            this._canvasTarget.getContext(this._device, this._format, 'opaque');
        }
        const w = this.domElement.width || 1;
        const h = this.domElement.height || 1;
        this._depthTexture = this._createDepthTexture(w, h);
        if (this.samples > 1) {
            this._msaaTexture = this._createMsaaTexture(w, h);
        }
        this._initialized = true;
        this.inspector.setRenderer(this);
        this.inspector.init();
        return this;
    }
    /** recreate depth/msaa textures after a resize. */
    _onResize(width, height) {
        this._depthTexture?.destroy();
        this._depthTexture = this._createDepthTexture(width, height);
        if (this.samples > 1) {
            this._msaaTexture?.destroy();
            this._msaaTexture = this._createMsaaTexture(width, height);
        }
    }
    /** set the device pixel ratio. call before setSize(). */
    setPixelRatio(value) {
        this._canvasTarget.setPixelRatio(value);
    }
    /** call once per animation frame before any compute() or render() calls. bumps frameId, updates time/deltaTime. */
    beginFrame() {
        this._nodes.nodeFrame.update();
        const frameId = this._nodes.nodeFrame.frameId;
        this.inspector.begin(frameId);
        return frameId;
    }
    /** call once per animation frame after all compute() and render() calls. */
    endFrame() {
        this.inspector.finish(this._nodes.nodeFrame.frameId);
    }
    /** resize the canvas to logical pixel dimensions (physical = logical * pixelRatio). */
    setSize(width, height, updateStyle = true) {
        this._canvasTarget.setSize(width, height, updateStyle);
        if (!this._initialized)
            return;
        const { width: pw, height: ph } = this._canvasTarget.getDrawingBufferSize();
        this._onResize(pw, ph);
    }
    /**
     * Check if a GPU feature is available on the current device.
     *
     * @example
     * ```ts
     * if (renderer.hasFeature('shader-f16')) {
     *     // Can use f16, vec2h, vec3h, vec4h, mat*h types
     * }
     * ```
     */
    hasFeature(feature) {
        return this._device?.features?.has(feature) ?? false;
    }
    /**
     * Pre-compile render pipelines and pre-upload GPU resources for a scene.
     * Optional — resources are created on-demand during the first render if not pre-warmed.
     */
    async compile(scene, camera, samples, format) {
        if (!this._initialized) {
            throw new Error('[WebGPURenderer] compile() called before init(). Await renderer.init() first.');
        }
        const resolvedSamples = samples ?? this.samples;
        const resolvedFormat = format ?? this._format;
        // use new RenderLists system to collect visible meshes
        const renderList = collectRenderList(this._renderLists, scene, camera);
        const allItems = [...renderList.opaque, ...renderList.transparent];
        if (allItems.length === 0)
            return;
        // create a temporary RenderContext for compilation
        // this is needed because RenderObjects are cached by (mesh, material, renderContext)
        const compileContext = getRenderContext(this._renderContexts, null, null, 0);
        compileContext.sampleCount = resolvedSamples;
        compileContext.width = this.domElement.width || 1;
        compileContext.height = this.domElement.height || 1;
        const depthFormat = this.renderTarget?.depthTexture?.format ?? DEPTH_FORMAT;
        const width = compileContext.width;
        const height = compileContext.height;
        // phase 1: Kick off all async pipeline compilations in parallel
        const initPromises = [];
        for (const item of allItems) {
            if (!item.mesh || !item.material || !item.geometry)
                continue;
            // get or create RenderObject
            const renderObject = getRenderObject(this._renderObjects, item.mesh, item.material, scene, camera, compileContext, 'compile');
            // kick off async initialization (compiles shader, creates pipeline)
            const pipelinePromises = [];
            initRenderObjectWithPromises(this._nodes, this._geometries, this._bindings, this._pipelines, this._device, this._buffers, renderObject, resolvedFormat, depthFormat, pipelinePromises);
            initPromises.push(...pipelinePromises);
        }
        // wait for all pipelines to compile
        await Promise.all(initPromises);
        // phase 2: pre-upload all GPU resources, yielding between objects
        for (const item of allItems) {
            if (!item.mesh || !item.material || !item.geometry)
                continue;
            const mesh = item.mesh;
            const geometry = item.geometry;
            // get the existing RenderObject (already created and initialized above)
            const renderObject = getRenderObject(this._renderObjects, mesh, item.material, scene, camera, compileContext, 'compile');
            const nodeState = renderObject.nodeBuilderState;
            if (nodeState) {
                // upload storage buffers
                for (const s of nodeState.storage) {
                    const buffer = resolveStorageBuffer(s.node, geometry);
                    ensureUploaded(this._buffers, this._device, buffer);
                }
                // upload vertex buffers
                for (const attrEntry of nodeState.attributes) {
                    if (attrEntry.kind === 'geometry') {
                        const bufAttr = geometry.buffers.get(attrEntry.name);
                        if (bufAttr) {
                            ensureUploaded(this._buffers, this._device, bufAttr);
                        }
                    }
                    else {
                        const gpuBuffer = attrEntry.node.buffer;
                        if (!gpuBuffer) {
                            throw new Error(`[gpucat] AttributeNode has no buffer for ${attrEntry.shaderName}`);
                        }
                        const arr = gpuBuffer.array;
                        if (arr) {
                            uploadRaw(this._buffers, this._device, attrEntry.node, arr, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
                        }
                    }
                }
                // upload index buffer if present
                if (geometry.index) {
                    ensureUploaded(this._buffers, this._device, geometry.index);
                }
            }
            // upload uniforms and rebuild bind groups
            // (must be after texture upload so bind groups can reference GPU resources)
            // for pre-warming, we create a temporary frame context
            const preWarmFrame = this._nodes.nodeFrame;
            preWarmFrame.renderer = this;
            preWarmFrame.camera = camera;
            preWarmFrame.object = renderObject.mesh;
            preWarmFrame.scene = renderObject.scene;
            preWarmFrame.material = renderObject.material;
            preWarmFrame.width = width;
            preWarmFrame.height = height;
            updateRenderObject(this._bindings, this._geometries, this._device, this._buffers, this._textures, renderObject, preWarmFrame);
            // yield to main thread between objects to keep animations smooth
            await yieldToMain();
        }
    }
    /**
     * Pre-compile a compute pipeline before the render loop starts.
     * This is optional — pipelines are compiled on-demand during the first
     * dispatch if not pre-warmed.
     *
     * @param computeNode The ComputeNode to pre-compile.
     * @throws if the renderer has not been initialised yet.
     */
    async compileCompute(computeNode) {
        if (!this._initialized) {
            throw new Error('[WebGPURenderer] compileCompute() called before init(). Await renderer.init() first.');
        }
        const promises = [];
        getForCompute(this._pipelines, this._device, this._nodes, computeNode, this._computeContext, promises);
        await Promise.all(promises);
    }
    compute(node, dispatchOrIndirect) {
        if (this._isDeviceLost)
            return;
        if (!this._initialized) {
            throw new Error('[WebGPURenderer] compute() called before init(). Await renderer.init() first.');
        }
        const entry = getForCompute(this._pipelines, this._device, this._nodes, node, this._computeContext);
        const perfId = `compute: ${node.id}`;
        this.inspector.perf.start(perfId);
        const encoder = this._device.createCommandEncoder();
        if (dispatchOrIndirect instanceof GpuBuffer) {
            const gpuBuf = ensureUploaded(this._buffers, this._device, dispatchOrIndirect);
            this._dispatchComputeNode(entry, node, encoder, undefined, gpuBuf, 0);
        }
        else {
            this._dispatchComputeNode(entry, node, encoder, dispatchOrIndirect, undefined, undefined);
        }
        this._device.queue.submit([encoder.finish()]);
        this.inspector.perf.end(perfId);
    }
    _dispatchComputeNode(entry, node, encoder, dispatch, indirectBuffer, indirectOffset) {
        const { nodeBuilderState } = entry;
        const frame = this._nodes.nodeFrame;
        frame.renderer = this;
        frame.width = this.domElement.width || 1;
        frame.height = this.domElement.height || 1;
        // Update node uniforms
        this.inspector.perf.start('updateForCompute');
        updateForCompute(this._nodes, node);
        this.inspector.perf.end('updateForCompute');
        // Update all bindings and get GPUBindGroups
        const gpuBindGroups = updateComputeBindings(this._bindings, nodeBuilderState, frame, this._device, this._buffers, this._textures);
        // Notify inspector before creating pass (so timestamp writes are available)
        this.inspector.beginCompute(node, this._nodes.nodeFrame.frameId);
        // Get timestamp writes for GPU timing (if available)
        const timestampWrites = this.inspector.getTimestampWrites(node.id);
        // Encode the compute pass
        const computePass = encoder.beginComputePass({ timestampWrites });
        computePass.setPipeline(entry.pipeline);
        // Set bind groups
        for (let i = 0; i < gpuBindGroups.length; i++) {
            computePass.setBindGroup(i, gpuBindGroups[i]);
        }
        if (indirectBuffer) {
            computeDispatchWorkgroupsIndirect(computePass, this.inspector, indirectBuffer, indirectOffset ?? 0);
        }
        else {
            const [dx, dy, dz] = dispatch;
            computeDispatchWorkgroups(computePass, this.inspector, dx, dy, dz);
        }
        computePass.end();
        this.inspector.finishCompute(node.id, this._nodes.nodeFrame.frameId);
    }
    /** save the current renderer state into a plain object and return it */
    saveRendererState() {
        return {
            renderTarget: this.renderTarget,
            mrt: this.mrt,
            clearColor: [...this.clearColor],
            overrideMaterial: this.overrideMaterial,
        };
    }
    /** restore renderer state previously saved with `saveRendererState()` */
    restoreRendererState(state) {
        this.renderTarget = state.renderTarget;
        this.mrt = state.mrt;
        this.clearColor = state.clearColor;
        this.overrideMaterial = state.overrideMaterial;
    }
    /**
     * Render a scene from a camera's perspective.
     * Renders to `this.renderTarget` if set, otherwise to the swapchain.
     */
    render(scene, camera, commandEncoder, passId = 'render') {
        if (this._isDeviceLost)
            return;
        if (!this._initialized) {
            throw new Error('[WebGPURenderer] render() called before init(). Await renderer.init() first.');
        }
        // Save previous renderId to support nested renders (e.g. PassNode calling render() in updateBefore).
        // Each render() call gets its own renderId so RENDER-level updates run once per render call.
        // At top level (depth 0), just increment. When nested, save/restore parent's renderId.
        const frame = this._nodes.nodeFrame;
        const previousRenderId = frame.renderId;
        this._renderCallDepth++;
        frame.renderId++;
        this.inspector.perf.start('render');
        const renderTarget = this.renderTarget;
        const mrt = this.mrt;
        if (mrt && renderTarget) {
            mrt.resolveOutputs((name) => renderTarget.getTextureIndex(name));
        }
        const ownEncoder = !commandEncoder;
        const encoder = commandEncoder ?? this._device.createCommandEncoder();
        const samples = renderTarget?.samples ?? this.samples;
        const colorFormat = renderTarget?.colorFormat ?? this._format;
        const depthFormat = renderTarget?.depthTexture?.format ?? DEPTH_FORMAT;
        const width = this.domElement.width || 1;
        const height = this.domElement.height || 1;
        const [cr, cg, cb, ca] = this.clearColor;
        this.inspector.beginRenderScene(passId, scene, samples, colorFormat, frame.frameId);
        this.inspector.beginRender(passId, frame.frameId);
        frame.renderer = this;
        frame.camera = camera;
        frame.scene = scene;
        frame.encoder = encoder;
        frame.width = width;
        frame.height = height;
        incrementCallId(this._geometries);
        const passCtx = getRenderContext(this._renderContexts, renderTarget, mrt, 0);
        passCtx.sampleCount = samples;
        passCtx.width = width;
        passCtx.height = height;
        passCtx.camera = camera;
        passCtx.clearColorValue = { r: cr, g: cg, b: cb, a: ca };
        const clearColor = { r: cr, g: cg, b: cb, a: ca };
        const { colorAttachments, depthAttachment } = this._render_resolve(renderTarget, clearColor);
        this._device.pushErrorScope('validation');
        const preparedObjects = this._render_prepare(scene, camera, passCtx, passId, colorFormat, depthFormat, this.overrideMaterial);
        this._render_draw(encoder, preparedObjects, colorAttachments, depthAttachment, passId);
        if (ownEncoder) {
            this._device.queue.submit([encoder.finish()]);
        }
        this._device.popErrorScope().then((err) => {
            if (err)
                console.error('[WebGPU render validation error]', err.message);
        });
        this.inspector.perf.end('render');
        // Restore previous renderId only for nested renders. Top-level keeps its incremented value.
        this._renderCallDepth--;
        if (this._renderCallDepth > 0) {
            frame.renderId = previousRenderId;
        }
    }
    /** Build GPU color and depth attachments for the current render target or swapchain. */
    _render_resolve(renderTarget, clearColor) {
        const colorAttachments = [];
        if (renderTarget) {
            this._ensureRenderTargetAllocated(renderTarget);
            for (const tex of renderTarget.textures) {
                const textureData = getTextureData(this._textures, tex._gpuTexture);
                if (!textureData) {
                    throw new Error('[WebGPURenderer] Render target texture not found in cache');
                }
                colorAttachments.push({
                    view: textureData.texture.createView(),
                    clearValue: clearColor,
                    loadOp: 'clear',
                    storeOp: 'store',
                });
            }
        }
        else {
            const ctx = this._canvasTarget.getContext(this._device, this._format, 'opaque');
            const swapchainView = ctx.getCurrentTexture().createView();
            if (this.samples > 1 && this._msaaTexture) {
                colorAttachments.push({
                    view: this._msaaTexture.createView(),
                    resolveTarget: swapchainView,
                    clearValue: clearColor,
                    loadOp: 'clear',
                    storeOp: 'discard',
                });
            }
            else {
                colorAttachments.push({
                    view: swapchainView,
                    clearValue: clearColor,
                    loadOp: 'clear',
                    storeOp: 'store',
                });
            }
        }
        let depthAttachment;
        if (renderTarget) {
            if (renderTarget.depthTexture) {
                const depthTextureData = getTextureData(this._textures, renderTarget.depthTexture._gpuTexture);
                if (depthTextureData) {
                    depthAttachment = {
                        view: depthTextureData.texture.createView(),
                        depthClearValue: 1.0,
                        depthLoadOp: 'clear',
                        depthStoreOp: 'store',
                    };
                }
            }
        }
        else {
            depthAttachment = {
                view: this._depthTexture.createView(),
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            };
        }
        return { colorAttachments, depthAttachment };
    }
    /** Collect visible meshes, init render objects, and run updateBefore (may trigger nested renders). */
    _render_prepare(scene, camera, passCtx, passId, colorFormat, depthFormat, overrideMaterial) {
        this.inspector.perf.start('collectRenderList');
        const renderList = collectRenderList(this._renderLists, scene, camera, overrideMaterial);
        this.inspector.perf.end('collectRenderList');
        const preparedObjects = [];
        for (const items of [renderList.opaque, renderList.transparent]) {
            for (const item of items) {
                if (!item.mesh || !item.material || !item.geometry)
                    continue;
                const renderObject = getRenderObject(this._renderObjects, item.mesh, item.material, scene, camera, passCtx, passId);
                const initialized = initRenderObject(this._nodes, this._geometries, this._bindings, this._pipelines, this._device, this._buffers, renderObject, colorFormat, depthFormat);
                if (!initialized || !renderObject.pipeline) {
                    console.warn('[gpucat] initRenderObject failed or pipeline missing', { initialized, pipeline: renderObject.pipeline });
                    continue;
                }
                if (!renderObject.nodeBuilderState) {
                    console.warn('[gpucat] no nodeBuilderState');
                    continue;
                }
                this.inspector.perf.start('updateBefore');
                updateBefore(this._nodes, renderObject);
                this.inspector.perf.end('updateBefore');
                preparedObjects.push({ renderObject, item });
            }
        }
        return preparedObjects;
    }
    /** Begin the GPU render pass, issue all draw calls, and end the pass. */
    _render_draw(encoder, preparedObjects, colorAttachments, depthAttachment, passId) {
        const timestampWrites = this.inspector.getTimestampWrites(passId);
        const gpuPass = encoder.beginRenderPass({
            colorAttachments,
            depthStencilAttachment: depthAttachment,
            timestampWrites,
        });
        const currentSets = {
            bindingGroups: [],
            attributes: [],
            index: null,
            pipeline: null,
        };
        this.inspector.perf.start('drawCalls');
        for (const { renderObject, item } of preparedObjects) {
            const mesh = item.mesh;
            const material = item.material;
            const geometry = item.geometry;
            const nodeState = renderObject.nodeBuilderState;
            if (mesh.count === 0)
                continue;
            const frame = this._nodes.nodeFrame;
            frame.object = mesh;
            frame.material = material;
            frame.camera = renderObject.camera;
            frame.scene = renderObject.scene;
            updateForRender$1(this._nodes, renderObject);
            this.inspector.perf.start('updateForRender');
            updateRenderObject(this._bindings, this._geometries, this._device, this._buffers, this._textures, renderObject, frame);
            this.inspector.perf.end('updateForRender');
            if (renderObject.pipeline !== currentSets.pipeline) {
                passSetPipeline(gpuPass, this.inspector, renderObject.pipeline, mesh.name || material.constructor.name);
                currentSets.pipeline = renderObject.pipeline;
            }
            const bindGroups = renderObject.bindGroups;
            const logicalBindGroups = renderObject._bindings;
            if (bindGroups && logicalBindGroups) {
                for (let i = 0; i < bindGroups.length; i++) {
                    const bindGroupId = logicalBindGroups[i]?.id ?? -1;
                    if (currentSets.bindingGroups[i] !== bindGroupId) {
                        passSetBindGroup(gpuPass, this.inspector, i, bindGroups[i], mesh.name || '');
                        currentSets.bindingGroups[i] = bindGroupId;
                    }
                }
            }
            let slot = 0;
            for (const group of nodeState.vertexBufferGroups) {
                let gpuBuf;
                if (group.name !== null) {
                    // Geometry-based group - resolve buffer by name
                    const bufAttr = geometry.buffers.get(group.name);
                    if (!bufAttr) {
                        slot++;
                        continue;
                    }
                    gpuBuf = ensureUploaded(this._buffers, this._device, bufAttr);
                }
                else {
                    // Direct buffer group
                    const gpuBuffer = group.buffer;
                    if (!gpuBuffer) {
                        throw new Error(`[gpucat] VertexBufferGroup has no buffer`);
                    }
                    const arr = gpuBuffer.array;
                    if (!arr) {
                        throw new Error(`[gpucat] VertexBufferGroup buffer array is null`);
                    }
                    gpuBuf = uploadRaw(this._buffers, this._device, gpuBuffer, arr, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST).buffer;
                }
                if (currentSets.attributes[slot] !== gpuBuf) {
                    passSetVertexBuffer(gpuPass, this.inspector, slot, gpuBuf);
                    currentSets.attributes[slot] = gpuBuf;
                }
                slot++;
            }
            if (geometry.index) {
                const idxBuf = ensureUploaded(this._buffers, this._device, geometry.index);
                if (currentSets.index !== idxBuf) {
                    passSetIndexBuffer(gpuPass, this.inspector, idxBuf, getIndexFormat(geometry.index.array));
                    currentSets.index = idxBuf;
                }
                if (geometry.indirect) {
                    const indirect = geometry.indirect;
                    const indBuf = ensureUploaded(this._buffers, this._device, indirect);
                    const byteStride = indirect.itemSize * 4;
                    const baseOffset = geometry.indirectOffset;
                    for (let d = 0; d < indirect.count; d++) {
                        passDrawIndexedIndirect(gpuPass, this.inspector, indBuf, baseOffset + d * byteStride);
                    }
                }
                else {
                    const indexCount = Math.min(geometry.drawRange.count, geometry.index.array.length);
                    passDrawIndexed(gpuPass, this.inspector, indexCount, mesh.count, geometry.drawRange.start);
                }
            }
            else {
                if (geometry.indirect) {
                    const indirect = geometry.indirect;
                    const indBuf = ensureUploaded(this._buffers, this._device, indirect);
                    const byteStride = indirect.itemSize * 4;
                    const baseOffset = geometry.indirectOffset;
                    for (let d = 0; d < indirect.count; d++) {
                        passDrawIndirect(gpuPass, this.inspector, indBuf, baseOffset + d * byteStride);
                    }
                }
                else {
                    passDraw(gpuPass, this.inspector, geometry.drawRange.count, mesh.count, geometry.drawRange.start);
                }
            }
            this.inspector.perf.start('updateAfter');
            updateAfter(this._nodes, renderObject);
            this.inspector.perf.end('updateAfter');
        }
        this.inspector.perf.end('drawCalls');
        gpuPass.end();
        this.inspector.finishRender(passId, this._nodes.nodeFrame.frameId);
    }
    _ensureRenderTargetAllocated(renderTarget) {
        // Check if already allocated at correct size via texture cache
        // For depth-only render targets (count: 0), check the depth texture instead
        const firstTex = renderTarget.textures[0] ?? renderTarget.depthTexture;
        if (firstTex) {
            const existingData = getTextureData(this._textures, firstTex._gpuTexture);
            if (existingData && existingData.texture.width === renderTarget.width && existingData.texture.height === renderTarget.height) {
                return;
            }
        }
        // Dispose old resources via render target (which calls texture cache removal)
        renderTarget.dispose();
        // Allocate new GPU resources
        const sampleCount = renderTarget.samples > 1 ? renderTarget.samples : 1;
        for (const tex of renderTarget.textures) {
            const gpuTexture = this._device.createTexture({
                size: [renderTarget.width, renderTarget.height],
                format: tex.format ?? renderTarget.colorFormat,
                usage: GPUTextureUsage.RENDER_ATTACHMENT |
                    GPUTextureUsage.TEXTURE_BINDING |
                    GPUTextureUsage.COPY_SRC,
                sampleCount,
            });
            // Register in texture cache (keyed by GpuTexture)
            setRenderTargetTexture(this._textures, tex._gpuTexture, gpuTexture);
        }
        if (renderTarget.depthTexture) {
            const gpuDepthTexture = this._device.createTexture({
                size: [renderTarget.width, renderTarget.height],
                format: renderTarget.depthTexture.format, // DepthTexture always has format set
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
                sampleCount,
            });
            // Register in texture cache (keyed by GpuTexture)
            setRenderTargetTexture(this._textures, renderTarget.depthTexture._gpuTexture, gpuDepthTexture);
        }
    }
    _createDepthTexture(width, height) {
        return this._device.createTexture({
            size: [width, height],
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
            sampleCount: this.samples > 1 ? this.samples : 1,
        });
    }
    _createMsaaTexture(width, height) {
        return this._device.createTexture({
            size: [width, height],
            format: this._format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
            sampleCount: this.samples,
        });
    }
}
// ---------------------------------------------------------------------------
// Pass-command helpers — issue the real GPU encoder call AND the inspector hook
// in one place so neither renderer.ts call sites nor the inspector interface
// accumulate per-command boilerplate.
// ---------------------------------------------------------------------------
function passSetPipeline(pass, inspector, pipeline, label) {
    pass.setPipeline(pipeline);
    inspector.setPipeline(label);
}
function passSetBindGroup(pass, inspector, index, bindGroup, label) {
    pass.setBindGroup(index, bindGroup);
    inspector.setBindGroup(index, label);
}
function passSetVertexBuffer(pass, inspector, slot, buffer) {
    pass.setVertexBuffer(slot, buffer);
    inspector.setVertexBuffer(slot);
}
function passSetIndexBuffer(pass, inspector, buffer, format) {
    pass.setIndexBuffer(buffer, format);
    inspector.setIndexBuffer();
}
function passDraw(pass, inspector, vertexCount, instanceCount, firstVertex) {
    pass.draw(vertexCount, instanceCount, firstVertex);
    inspector.draw(vertexCount, instanceCount);
}
function passDrawIndexed(pass, inspector, indexCount, instanceCount, firstIndex) {
    pass.drawIndexed(indexCount, instanceCount, firstIndex);
    inspector.drawIndexed(indexCount, instanceCount);
}
function passDrawIndirect(pass, inspector, indirectBuffer, indirectOffset) {
    pass.drawIndirect(indirectBuffer, indirectOffset);
    inspector.drawIndirect();
}
function passDrawIndexedIndirect(pass, inspector, indirectBuffer, indirectOffset) {
    pass.drawIndexedIndirect(indirectBuffer, indirectOffset);
    inspector.drawIndexedIndirect();
}
function computeDispatchWorkgroups(pass, inspector, x, y, z) {
    pass.dispatchWorkgroups(x, y, z);
    inspector.dispatchWorkgroups(x, y, z);
}
function computeDispatchWorkgroupsIndirect(pass, inspector, indirectBuffer, offset) {
    pass.dispatchWorkgroupsIndirect(indirectBuffer, offset);
    inspector.dispatchWorkgroupsIndirect(indirectBuffer, offset);
}

/**
 * RenderPipeline - manages the rendering pipeline for fullscreen effects.
 *
 * Usage:
 * ```ts
 * const renderPipeline = new RenderPipeline(renderer);
 *
 * const scenePass = pass(scene, camera);
 * renderPipeline.outputNode = scenePass;
 *
 * function frame() {
 *     renderPipeline.render();
 *     requestAnimationFrame(frame);
 * }
 *
 * // cleanup
 * renderPipeline.dispose();
 * ```
 */
class RenderPipeline {
    /** reference to the renderer */
    renderer;
    /** the output node to render */
    outputNode;
    /** set to `true` to rebuild the material, e.g. when the outputNode changes */
    needsUpdate = true;
    /** material used for rendering the fullscreen quad */
    _material;
    /** the QuadMesh used for fullscreen rendering */
    _quadMesh;
    /**
     * @param renderer the renderer.
     * @param outputNode output node. Defaults to solid blue.
     */
    constructor(renderer, outputNode) {
        this.renderer = renderer;
        this.outputNode = outputNode ?? vec4f(f32(0), f32(0), f32(1), f32(1));
        // Create material with initial output node - will be updated in _update() when needsUpdate is true
        this._material = this._createMaterial(this.outputNode);
        this._quadMesh = new QuadMesh(this._material);
        this._quadMesh.name = 'RenderPipeline';
    }
    /**
     * Renders the output node to the renderer's current target.
     *
     * Call `renderer.beginFrame()` before and `renderer.endFrame()` after all
     * compute and render work for the frame. Example:
     * ```ts
     * renderer.beginFrame();
     * renderer.compute(myCompute, dispatch);
     * renderPipeline.render();
     * renderer.endFrame();
     * ```
     */
    render() {
        this._update();
        this._quadMesh.render(this.renderer);
    }
    /**
     * Dispose of resources owned by this pipeline.
     */
    dispose() {
        this._material.dispose();
    }
    /**
     * Updates the material if outputNode has changed.
     * @internal
     */
    _update() {
        if (this.needsUpdate) {
            this._material.dispose();
            this._material = this._createMaterial(this.outputNode);
            this._quadMesh.material = this._material;
            this.needsUpdate = false;
        }
    }
    /**
     * Creates a fullscreen material for the given output node.
     * @internal
     */
    _createMaterial(outputNode) {
        // position attribute - fullscreen triangle geometry provides clip-space positions
        const posAttr = attribute('position', vec3f$1);
        const posNode = vec4f(posAttr, f32(1));
        return new Material({
            name: 'RenderPipelineQuadMeshMaterial',
            vertex: posNode,
            fragment: outputNode,
            depthWrite: false,
            depthTest: false,
        });
    }
}

export { ArrayTexture, Break, BufferLifecycle, Camera, Const, Continue, CubeTexture, DepthTexture, Discard, DrawIndexedIndirect, DrawIndirect, Fn, For, Geometry, GpuBuffer, If, Inspector, Let, Loop, MOUSE, Material, Mesh, Object3D, OrbitControls, OrthographicCamera, PerspectiveCamera, Raycaster, RenderPipeline, RenderTarget, Return, Scene, TOUCH, Texture, Uniform, UniformGroup, UniformUpdateType, Var, WebGPURenderer, While, abs, acesToneMapping, add$1 as add, and, array, arrayTexture, atomicAdd, atomicAnd, atomicCompareExchangeWeak, atomicExchange, atomicLoad, atomicMax, atomicMin, atomicOr, atomicStore, atomicSub, atomicXor, attribute, bool, builtin, cameraFar, cameraNear, cameraPosition, cameraProjectionMatrix, cameraViewMatrix, ceil, clamp, color, comparisonSampler, compile, compileCompute, compute, computeIndex, cond, cos, createBoxGeometry, createFullscreenTriangleGeometry, createIndexBuffer, createIndirectBuffer, createPlaneGeometry, createSphereGeometry, createStorageBuffer, createUniformBuffer, createVertexBuffer, cross$1 as cross, cubeTexture, schema as d, depthTexture, deriveVertexFormat, div, dot$1 as dot, equal, f16, f32, field, fields, floor, fract, fragCoord, frameGroup, frustum, fxaa, getIndexFormat, globalId, greaterThan, greaterThanEqual, i32, index, instanceIndex, layoutSizeOf, layoutStrideOf, length$1 as length, lessThan, lessThanEqual, localId, localIndex, mat2x2f, mat2x2h, mat2x3f, mat2x3h, mat2x4f, mat2x4h, mat3, mat3x2f, mat3x2h, mat3x3f, mat3x3h, mat3x4f, mat3x4h, mat4, mat4x2f, mat4x2h, mat4x3f, mat4x3h, mat4x4f, mat4x4h, max, min, mix, mod, modelNormalMatrix, modelWorldMatrix, mrt, mul, normalize$4 as normalize, notEqual, numWorkgroups, objectGroup, or, pack, packArray, packTo, pass, positionClip, pow, privateVar, reinhardToneMapping, renderGroup, renderOutput, rgb, sRGBTransferEOTF, sRGBTransferOETF, sampler, screenCoordinate, screenSize, screenUV, select, sharedUniformGroup, sign, sin, smoothstep, sqrt, step, storage, struct, sub, texture, textureBinding, textureDimensions, textureGather, textureGatherCompare, textureLoad, textureNumLayers, textureNumLevels, textureSample, textureSampleBias, textureSampleCompare, textureSampleCompareLevel, textureSampleGrad, textureSampleLevel, textureStore, timeDelta, timeElapsed, transpose, u32, uniform, uniformGroup, unpack, unpackArray, unproject, varying, vec2, vec2b, vec2f, vec2h, vec2i, vec2u, vec3, vec3b, vec3f, vec3h, vec3i, vec3u, vec4, vec4b, vec4f, vec4h, vec4i, vec4u, vertexIndex, wgsl, wgslFn, workgroupId, workgroupVar };
//# sourceMappingURL=index.js.map
