import type { GpuBuffer } from '../../core/gpu-buffer';
import type { RenderTarget } from '../../core/render-target';
import type { ComputeNode } from '../../nodes/nodes';
import type * as d from '../../schema/schema';
import type { RenderItem } from './render-list';
import type { RenderObject } from './render-object';
/**
 * An opaque texture/attachment handle. Neutral core code may hold and pass these around but never
 * inspects them — the concrete type (a `GPUTexture` for WebGPU, a WebGLTexture-ish handle for a
 * future WebGL2 backend) lives entirely inside the renderer. Kept as `unknown` so no device type
 * name leaks into `render/core`.
 */
export type BackendTexture = unknown;
/** A single compute dispatch resolved to workgroup counts or an indirect buffer. */
export type BackendComputeEntry = {
    node: ComputeNode;
    dispatch?: [number, number, number];
    indirect?: GpuBuffer<d.Any>;
    indirectOffset?: number;
    buffers?: Record<string, GpuBuffer<d.Any>>;
};
/**
 * A render object that survived preparation (compiled + pipeline built), paired with the render list
 * item that produced it. `executeRenderPass` consumes these in order to issue draws. Neutral: it only
 * references the language-agnostic `RenderObject`/`RenderItem`; the device payload lives in a
 * side table keyed by `renderObject`.
 */
export type PreparedRenderObject = {
    renderObject: RenderObject;
    item: RenderItem;
};
/**
 * Neutral, per-render swapchain/attachment inputs the renderer needs to resolve attachments and drive
 * the pass. Bundled so the render-loop orchestration owns this plain data. `clearColor` is the
 * resolved [r,g,b,a] for the pass.
 */
export type RenderPassParams = {
    renderTarget: RenderTarget | null;
    clearColor: {
        r: number;
        g: number;
        b: number;
        a: number;
    };
    autoClear: boolean;
    autoClearStencil: boolean;
    clearStencilValue: number;
    /** Whether the swapchain depth format carries a stencil aspect (used only when renderTarget is null). */
    swapchainStencil: boolean;
    passId: string;
};
