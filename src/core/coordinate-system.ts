/**
 * Clip-space coordinate system a renderer targets. The projection matrix's depth (Z) row and the
 * frustum's near plane differ between the two conventions:
 *  - WEBGL: OpenGL clip space, NDC z in [-1, 1] (perspectiveNO / orthoNO).
 *  - WEBGPU: WebGPU/D3D/Metal clip space, NDC z in [0, 1] (perspectiveZO / orthoZO).
 *
 * X and Y are identical between the two. Each renderer stamps its convention onto the camera before
 * rendering (WebGPURenderer -> WEBGPU, WebGLRenderer -> WEBGL) so the same Camera classes drive both.
 */
export enum CoordinateSystem {
    WEBGL = 0,
    WEBGPU = 1,
}
