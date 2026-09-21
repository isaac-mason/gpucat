import type { GpuBuffer } from '../../core/gpu-buffer';
import type { RenderTarget } from '../../core/render-target';
import type { Material } from '../../material/material';
import type { ComputeNode } from '../../nodes/lib/core';
import type { MRTNode } from '../../nodes/lib/mrt';
import type { TransformFeedbackNode } from '../../nodes/lib/transform-feedback';
import type { Mesh, MeshDraw } from '../../objects/mesh';
import type { Any } from '../../schema/schema';
import type { CanvasTarget } from './canvas-target';
import type { Renderer } from './renderer';
import { type Target } from './target';
import type { View } from './view';
export type BackendName = 'webgl' | 'webgpu';
export type Rect = {
    x?: number;
    y?: number;
    width: number;
    height: number;
};
export type PassDesc = {
    target: Target;
    camera?: View;
    /** Omitted clears with the target's own clear colour; `false` preserves. */
    clear?: [number, number, number, number] | false;
    clearDepth?: number | false;
    clearStencil?: number | false;
    /** Cube face, 0..5 = +X, -X, +Y, -Y, +Z, -Z. Only a `CubeRenderTarget` can select one. */
    layer?: number;
    /** Mip level to render into. Only a `CubeRenderTarget` allocates a chain to select from. */
    mipLevel?: number;
    mrt?: MRTNode;
    viewport?: Rect & {
        minDepth?: number;
        maxDepth?: number;
    };
    scissor?: Rect;
    label?: string;
};
export type DrawOpts = {
    instances?: number;
    range?: {
        start: number;
        count: number;
    };
    draws?: MeshDraw[];
    /** Draws the mesh with this material instead of its own, for this submission alone. */
    material?: Material;
};
/** One recorded draw. `kind` is the seam a bundle entry joins at; see `PLAN-render-bundles.md`. */
export type DrawRecord = {
    kind: 'draw';
    mesh: Mesh;
    material: Material;
    opts: DrawOpts | null;
};
/**
 * Draws recorded once and replayed into any pass of the same attachment shape. Holds its meshes and
 * materials strongly and redraws whatever they have become, so the set is expected to be static:
 * `invalidate()` after changing it, `dispose()` when done with it.
 */
export type RenderBundle = {
    /** Names the bundle in errors and on the device objects recorded from it. */
    readonly label: string;
    readonly records: readonly PassEntry[];
    readonly count: number;
    /** Bumped by `invalidate`; a recorded device bundle compares against it to decide on a re-record. */
    version: number;
    readonly disposed: boolean;
    invalidate(): void;
    dispose(): void;
};
export type BundleRecord = {
    kind: 'bundle';
    bundle: RenderBundle;
};
/** What a pass records: a draw it was handed, or a bundle it was told to replay. */
export type PassEntry = DrawRecord | BundleRecord;
export type ComputePassDesc = {
    label?: string;
};
export type DispatchOpts = {
    /** Rebinds the node's named `storage()` refs for this dispatch alone, so no pipeline is recompiled. */
    buffers?: Record<string, GpuBuffer<Any>>;
};
export type DispatchIndirectOpts = DispatchOpts & {
    offset?: number;
};
/** Exactly one of `counts` and `indirect` is set, which `dispatch` and `dispatchIndirect` guarantee. */
export type DispatchRecord = DispatchOpts & {
    node: ComputeNode;
    counts?: [number, number, number];
    indirect?: GpuBuffer<Any>;
    indirectOffset?: number;
};
/**
 * Encoding a pass is atomic: preparing its draws evaluates the node graph, which may open and close
 * further passes, so no GPU pass may be open across it. Both encoders read `records[0..count)`.
 */
export type FrameBackend = {
    name: BackendName;
    /** The one canvas this backend's device can present to, or null when any canvas target is reachable. */
    deviceCanvasTarget: CanvasTarget | null;
    beginFrame(): void;
    encodePass(desc: PassDesc, records: readonly PassEntry[], count: number): void;
    encodeComputePass(desc: ComputePassDesc, records: readonly DispatchRecord[], count: number): void;
    encodeTransformFeedbackPass(desc: TransformFeedbackPassDesc, records: readonly TransformFeedbackRecord[], count: number): void;
    submitFrame(): void;
    discardFrame(): void;
    /**
     * Resolves once the device has finished the submitted work. Resolve-only: the errors worth knowing
     * about arrive after it settles, so they go to `onDeviceLost` and the validation scopes instead.
     */
    awaitCompletion(): Promise<void>;
};
/** A recording render pass. `end()` prepares its draws, opens the GPU pass, encodes and closes it. */
export type Pass = {
    readonly kind: 'render';
    desc: PassDesc;
    records: PassEntry[];
    count: number;
    ended: boolean;
    /** Draws unconditionally: `mesh.visible` gates the scene walk, not a draw you recorded yourself. */
    draw(mesh: Mesh, opts?: DrawOpts): void;
    /** Replays a bundle here, keeping its order against the draws around it. */
    execute(bundle: RenderBundle): void;
    end(): void;
};
/** A recording compute pass. The batch shares one GPU pass unless an inspector wants per-node timings. */
export type ComputePass = {
    readonly kind: 'compute';
    desc: ComputePassDesc;
    records: DispatchRecord[];
    count: number;
    ended: boolean;
    dispatch(node: ComputeNode, counts: [number, number, number], opts?: DispatchOpts): void;
    /** `indirect` needs `'indirect'` usage, and is typically written by an earlier compute pass. */
    dispatchIndirect(node: ComputeNode, indirect: GpuBuffer<Any>, opts?: DispatchIndirectOpts): void;
    end(): void;
};
export type TransformFeedbackPassDesc = {
    label?: string;
};
export type TransformFeedbackDispatch = {
    inputs: Record<string, GpuBuffer>;
    outputs: Record<string, GpuBuffer>;
    count: number;
    instanceCount?: number;
};
export type TransformFeedbackRecord = TransformFeedbackDispatch & {
    node: TransformFeedbackNode;
};
/**
 * A recording transform-feedback pass, the WebGL2 mirror of `ComputePass`. WebGL2 has no encoder, so
 * the kernels run at `end()` — which is when this backend's render passes run too, so a pass placed
 * between two of them lands between them.
 */
export type TransformFeedbackPass = {
    readonly kind: 'transform-feedback';
    desc: TransformFeedbackPassDesc;
    records: TransformFeedbackRecord[];
    count: number;
    ended: boolean;
    dispatch(node: TransformFeedbackNode, opts: TransformFeedbackDispatch): void;
    end(): void;
};
export type AnyPass = Pass | ComputePass | TransformFeedbackPass;
/** Holds both pass pools for the life of the renderer, so a steady-state frame allocates nothing. */
export type Frame = {
    backend: FrameBackend;
    pool: Pass[];
    poolIndex: number;
    computePool: ComputePass[];
    computePoolIndex: number;
    transformFeedbackPool: TransformFeedbackPass[];
    transformFeedbackPoolIndex: number;
    open: AnyPass | null;
    closed: boolean;
    /** Render targets this frame encoded into, so `submit` can see one disposed since. */
    targets: RenderTarget[];
    /** Memoised by the `done` getter, so asking twice waits once and never asking waits not at all. */
    completion: Promise<void> | null;
    pass(desc: PassDesc): Pass;
    compute(desc?: ComputePassDesc): ComputePass;
    transformFeedback(desc?: TransformFeedbackPassDesc): TransformFeedbackPass;
    submit(): void;
    /**
     * Resolves once the device has finished this frame's work. **Resolve-only**: it is a completion
     * signal, not a success check, because the errors worth knowing about arrive after it settles.
     * Reading it is what starts the wait, and it is only meaningful between `submit()` and the next
     * `frame()`, since the frame object is reused.
     */
    readonly done: Promise<void>;
    /** Drops everything recorded so far. A frame a throw escaped from is abandoned by the next `frame()`. */
    abandon(): void;
};
export declare function createFrame(backend: FrameBackend): Frame;
/** True between `gpu.frame()` and `frame.submit()`, when recorded work has not reached the queue yet. */
export declare function isFrameOpen(frame: Frame | null): boolean;
export declare function passLabel(pass: AnyPass): string;
/**
 * Opens the renderer's frame for recording. A free function because every other operation on a
 * renderer is one; `Frame` and `Pass` keep their verbs because they are the recording context, not
 * the device handle.
 *
 * One `Frame` per renderer for its lifetime, so a steady-state frame allocates nothing.
 */
export declare function frame(renderer: Renderer): Frame;
export declare function beginFrame(frame: Frame): void;
