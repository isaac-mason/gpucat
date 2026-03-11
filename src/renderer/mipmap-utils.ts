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
 * Cached state for mipmap generation.
 * Created once per device and reused.
 */
export type MipmapState = {
    device: GPUDevice;
    sampler: GPUSampler;
    pipelines2D: Map<GPUTextureFormat, GPURenderPipeline>;
    pipelinesCube: Map<GPUTextureFormat, GPURenderPipeline>;
    shaderModule2D: GPUShaderModule;
    shaderModuleCube: GPUShaderModule;
    faceIndexBuffer: GPUBuffer;
};

/**
 * Create mipmap generation state for a device.
 */
export function createMipmapState(device: GPUDevice): MipmapState {
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
function getPipeline2D(state: MipmapState, format: GPUTextureFormat): GPURenderPipeline {
    let pipeline = state.pipelines2D.get(format);
    if (pipeline) return pipeline;

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
function getPipelineCube(state: MipmapState, format: GPUTextureFormat): GPURenderPipeline {
    let pipeline = state.pipelinesCube.get(format);
    if (pipeline) return pipeline;

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
export function generateMipmaps2D(
    state: MipmapState,
    texture: GPUTexture,
    encoder?: GPUCommandEncoder,
): void {
    const { device, sampler } = state;
    const format = texture.format;
    const mipLevelCount = texture.mipLevelCount;

    if (mipLevelCount <= 1) return;

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
export function generateMipmapsCube(
    state: MipmapState,
    texture: GPUTexture,
    encoder?: GPUCommandEncoder,
): void {
    const { device, sampler, faceIndexBuffer } = state;
    const format = texture.format;
    const mipLevelCount = texture.mipLevelCount;

    if (mipLevelCount <= 1) return;

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
export function generateMipmapsArray(
    state: MipmapState,
    texture: GPUTexture,
    layerCount: number,
    encoder?: GPUCommandEncoder,
): void {
    const { device, sampler } = state;
    const format = texture.format;
    const mipLevelCount = texture.mipLevelCount;

    if (mipLevelCount <= 1) return;

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
export function generateMipmaps(
    state: MipmapState,
    texture: GPUTexture,
    isCube = false,
    arrayLayerCount = 0,
    encoder?: GPUCommandEncoder,
): void {
    if (isCube) {
        generateMipmapsCube(state, texture, encoder);
    } else if (arrayLayerCount > 1) {
        generateMipmapsArray(state, texture, arrayLayerCount, encoder);
    } else {
        generateMipmaps2D(state, texture, encoder);
    }
}

/**
 * Dispose mipmap generation state.
 */
export function disposeMipmapState(state: MipmapState): void {
    state.faceIndexBuffer.destroy();
    state.pipelines2D.clear();
    state.pipelinesCube.clear();
}
