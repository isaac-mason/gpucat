import type { GpuBuffer } from '../../core/gpu-buffer';
import type { Object3D } from '../../core/object3d';
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
export type DrawOptions = {
    instances?: number;
    range?: {
        start: number;
        count: number;
    };
    draws?: MeshDraw[];
    /** Draws the mesh with this material instead of its own, for this submission alone. */
    material?: Material;
};
/** One recorded draw. `kind` discriminates it from a bundle entry, in a pass or a bundle's own list. */
export type DrawRecord = {
    kind: 'draw';
    mesh: Mesh;
    material: Material;
    opts: DrawOptions | null;
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
export type DispatchOptions = {
    /** Rebinds the node's named `storage()` refs for this dispatch alone, so no pipeline is recompiled. */
    buffers?: Record<string, GpuBuffer<Any>>;
};
export type DispatchIndirectOptions = DispatchOptions & {
    offset?: number;
};
/** Exactly one of `counts` and `indirect`, as a union rather than a comment the reader has to trust. */
export type DispatchRecord = DispatchOptions & {
    kind: 'dispatch';
    node: ComputeNode;
} & ({
    counts: [number, number, number];
    indirect?: undefined;
    indirectOffset?: undefined;
} | {
    counts?: undefined;
    indirect: GpuBuffer<Any>;
    indirectOffset?: number;
});
/**
 * A render pass is resolved as it is recorded and encoded when it ends. `beginPass` opens it,
 * `recordEntry` resolves each draw (or bundle) at the call that recorded it, so it uses the values set
 * before that call, and `encodePass` encodes what was resolved. Resolving evaluates the node graph,
 * which may open and close further passes, so no GPU pass is open until `encodePass`.
 *
 * A record is handed over for the length of the call and reused for the next one, so the backend keeps
 * whatever it needs from it rather than the record itself.
 */
export type FrameBackend = {
    name: BackendName;
    /** The one canvas this backend's device can present to, or null when any canvas target is reachable. */
    deviceCanvasTarget: CanvasTarget | null;
    beginFrame(): void;
    beginPass(desc: PassDesc): void;
    /** Resolves `entry` for the pass most recently begun and not yet encoded. */
    recordEntry(entry: PassEntry): void;
    encodePass(desc: PassDesc): void;
    /** The compute mirror of `beginPass` / `recordEntry` / `encodePass`: a dispatch resolves when recorded. */
    beginComputePass(desc: ComputePassDesc): void;
    recordDispatch(record: DispatchRecord): void;
    /** The transform-feedback mirror, on WebGL2. */
    beginTransformFeedbackPass(desc: TransformFeedbackPassDesc): void;
    recordTransformFeedback(record: TransformFeedbackRecord): void;
    encodeComputePass(desc: ComputePassDesc): void;
    encodeTransformFeedbackPass(desc: TransformFeedbackPassDesc): void;
    submitFrame(): void;
    discardFrame(): void;
    /**
     * Resolves once the device has finished the submitted work. Resolve-only: the errors worth knowing
     * about arrive after it settles, so they go to `onDeviceLost` and the validation scopes instead.
     */
    awaitCompletion(): Promise<void>;
};
/** A recording render pass. Each draw resolves when recorded; `end()` opens the GPU pass, encodes and closes it. */
export type Pass = {
    readonly kind: 'render';
    /** The desc this pass was opened with; rewritten when its pool slot is reused. */
    desc: PassDesc;
    /** Handed to the backend by every `draw()`, created by the first. @internal */
    drawRecord: DrawRecord | null;
    /** Handed to the backend by every `execute()`, created by the first. @internal */
    bundleRecord: BundleRecord | null;
    /** @internal */ ended: boolean;
    /** Draws unconditionally: `mesh.visible` gates the scene walk, not a draw you recorded yourself. */
    draw(mesh: Mesh, opts?: DrawOptions): void;
    /** Replays a bundle here, keeping its order against the draws around it. */
    execute(bundle: RenderBundle): void;
    /** Walks a tree here: frustum culled, `visible` honoured, opaque before transparent. */
    scene(root: Object3D, camera?: View): void;
    end(): void;
};
/** A recording compute pass. The batch shares one GPU pass unless an inspector wants per-node timings. */
export type ComputePass = {
    readonly kind: 'compute';
    /** The desc this pass was opened with; rewritten when its pool slot is reused. */
    desc: ComputePassDesc;
    /** Handed to the backend by every dispatch, created by the first. @internal */
    record: DispatchRecord | null;
    /** @internal */ ended: boolean;
    dispatch(node: ComputeNode, counts: [number, number, number], opts?: DispatchOptions): void;
    /** `indirect` needs `'indirect'` usage, and is typically written by an earlier compute pass. */
    dispatchIndirect(node: ComputeNode, indirect: GpuBuffer<Any>, opts?: DispatchIndirectOptions): void;
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
    kind: 'transform-feedback';
    node: TransformFeedbackNode;
};
/** Any call a pass records, as an attached inspector is told of it. */
export type CallRecord = PassEntry | DispatchRecord | TransformFeedbackRecord;
/**
 * A recording transform-feedback pass, the WebGL2 mirror of `ComputePass`. WebGL2 has no encoder, so
 * the kernels run at `end()` — which is when this backend's render passes run too, so a pass placed
 * between two of them lands between them.
 */
export type TransformFeedbackPass = {
    readonly kind: 'transform-feedback';
    /** The desc this pass was opened with; rewritten when its pool slot is reused. */
    desc: TransformFeedbackPassDesc;
    /** Handed to the backend by every dispatch, created by the first. @internal */
    record: TransformFeedbackRecord | null;
    /** @internal */ ended: boolean;
    dispatch(node: TransformFeedbackNode, opts: TransformFeedbackDispatch): void;
    end(): void;
};
export type AnyPass = Pass | ComputePass | TransformFeedbackPass;
/** Holds both pass pools for the life of the renderer, so a steady-state frame allocates nothing. */
export type Frame = {
    /** @internal */ backend: FrameBackend;
    /** Set by `frame(renderer)`; `pass.scene()` needs it for the per-(scene, camera) render-list cache. @internal */
    renderer: Renderer | null;
    /** @internal */ pool: Pass[];
    /** @internal */ poolIndex: number;
    /** @internal */ computePool: ComputePass[];
    /** @internal */ computePoolIndex: number;
    /** @internal */ transformFeedbackPool: TransformFeedbackPass[];
    /** @internal */ transformFeedbackPoolIndex: number;
    /** @internal */ open: AnyPass | null;
    /** @internal */ closed: boolean;
    /** Targets this frame encoded into, so `submit` can see one disposed since. @internal */
    targets: Target[];
    /** True once this frame object has carried a submitted frame, so a reopen can be told from a first use. @internal */
    everSubmitted: boolean;
    /** Memoised by the `done` getter, so asking twice waits once and never asking waits not at all. @internal */
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
