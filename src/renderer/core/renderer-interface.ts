import type { Camera } from '../../camera/camera';
import type { Object3D } from '../../core/object3d';
import type { RenderTarget } from '../../core/render-target';
import type { InspectorBase } from '../../inspector/inspector-base';
import type { MRTNode } from '../../nodes/nodes';

/**
 * Backend-neutral renderer contract — the surface the node graph (via NodeFrame) needs, with no
 * WebGPU types. A PassNode renders to a texture by calling `frame.renderer.render(...)` after
 * setting the target/mrt/clearColor; core reads `inspector`. `WebGPURenderer` implements this, and
 * a future `WebGL2Renderer` will too, so nodes stay backend-agnostic.
 */
/** Which graphics backend a renderer drives. Cheap runtime discriminant for feature-detection. */
export type RendererBackend = 'webgpu' | 'webgl';

export interface Renderer {
    /** Which graphics backend this renderer drives ('webgpu' | 'webgl'). */
    readonly backend: RendererBackend;

    /** Render a scene from a camera. Nested calls (e.g. a PassNode's render-to-texture) reuse the
     *  frame's command stream internally — no encoder is threaded through. */
    render(scene: Object3D, camera: Camera, passId?: string): void;

    /** Target this render writes to; null renders to the swapchain. */
    renderTarget: RenderTarget | null;
    /** Multi-render-target config, or null. */
    mrt: MRTNode | null;
    /** Clear color as [r, g, b, a]. */
    clearColor: [number, number, number, number];
    /** Attached inspector, or null. */
    inspector: InspectorBase | null;

    /**
     * Finalize a cube render target after all six faces have been captured (e.g. generate its
     * mipmaps). Called by `CubeCamera.update()`. Backend-specific; a no-op when the target needs no
     * post-capture work. Keeps `CubeCamera` backend-agnostic.
     */
    finalizeCubeCapture?(renderTarget: RenderTarget, mipLevel: number): void;
}
