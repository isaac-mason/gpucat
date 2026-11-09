/**
 * Clip-space coordinate system a renderer targets. The projection matrix's depth (Z) row and the
 * frustum's near plane differ between the two conventions:
 *  - WEBGL: OpenGL clip space, NDC z in [-1, 1] (perspectiveNO / orthoNO).
 *  - WEBGPU: WebGPU/D3D/Metal clip space, NDC z in [0, 1] (perspectiveZO / orthoZO).
 *
 * X and Y are identical between the two. Both renderers stamp WEBGPU onto the camera before rendering: clip space is
 * WGSL's everywhere, and the WebGL vertex stage remaps z to GL's range itself. WEBGL remains for a matrix meant for a
 * GL pipeline outside gpucat.
 */
export enum CoordinateSystem {
    WEBGL = 0,
    WEBGPU = 1,
}
