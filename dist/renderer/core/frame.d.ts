import type { GpuBuffer } from '../../core/gpu-buffer';
import type { GpuTexture } from '../../core/gpu-texture';
import type { TextureSource } from '../../core/gpu-texture-view';
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
export type ViewportRect = Rect & {
    minDepth?: number;
    maxDepth?: number;
};
export type PassDesc = {
    target: Target;
    camera?: View;
    /** Omitted clears with the target's own clear colour; `false` preserves. */
    clear?: [number, number, number, number] | false;
    clearDepth?: number | false;
    clearStencil?: number | false;
    /**
     * `false` discards the depth when the pass ends, for a pass nothing after loads or samples it from: a tiled GPU then
     * never writes it out. Default true, as a later pass with `clearDepth: false` loads it.
     */
    storeDepth?: boolean;
    /** `storeDepth` for the stencil. */
    storeStencil?: boolean;
    /**
     * The depth (and stencil) attached read-only: tested against, never cleared, written or stored, so the pass's own
     * shaders may sample it. Its materials must not write depth or stencil.
     */
    readOnlyDepth?: boolean;
    /** The layer of the target to draw into: an array layer, a cube face (0..5 = +X, -X, +Y, -Y, +Z, -Z), or a 3D
     *  target's depth slice. Default 0; a cube pass names its face. */
    layer?: number;
    /** The mip level of the target to draw into. Default 0. */
    mipLevel?: number;
    mrt?: MRTNode;
    viewport?: ViewportRect;
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
    /** The bin it was drawn into, or null for a draw in the pass's own order. */
    bin: Bin | null;
    /** Its `sortKey` in the bin, 0 when none was given. */
    sortKey: number;
};
/**
 * What a bin orders its draws by. Each field ranks above the ones after it, and the order they were drawn in breaks
 * ties. `pipeline`, `material` and `geometry` group draws sharing what each names; `view` groups draws by the camera,
 * viewport and scissor they were drawn under; `depthNear` puts the nearest to its camera first, `depthFar` the
 * farthest; `sortKey` orders by the number a draw was given, lowest first.
 */
export type BinField = 'sortKey' | 'pipeline' | 'material' | 'geometry' | 'view' | 'depthNear' | 'depthFar';
/**
 * A field, or a field with the bits its value packs into. A depth is quantized into that many bits (16 when not given);
 * a field with more distinct values than its bits hold fails at `end()`.
 */
export type BinKeyField = BinField | Partial<Record<BinField, number>>;
/**
 * How a bin orders its draws. `'state'` is `['sortKey', 'pipeline', 'material', 'geometry']`, for opaque draws, changing
 * the costliest state least. `'back-to-front'` is `['sortKey', 'depthFar']`, for blended draws. `'submission'` keeps the
 * order they were drawn in.
 */
export type BinKey = 'state' | 'back-to-front' | 'submission' | readonly BinKeyField[];
export type BinDesc = {
    key: BinKey;
    label?: string;
};
export type BinDrawOptions = DrawOptions & {
    /** What `sortKey` in the bin's key orders this draw by: lower first. Default 0. */
    sortKey?: number;
};
/**
 * Draws a pass orders by key. Its draws run together at the point in the pass the bin was made, in the order its key
 * gives, however they were drawn into it. Each draw keeps the camera, viewport and scissor set when it was drawn.
 */
export type Bin = {
    readonly kind: 'bin';
    /** The desc this bin was made with; rewritten when its pool slot is reused. */
    desc: BinDesc;
    /** Its place among its pass's bins this frame. @internal */
    index: number;
    /** The fields its key orders by, and the bits each was given (0 for as many as it needs). @internal */
    fields: BinField[];
    /** @internal */ bits: number[];
    /** The key `fields` were read from, so a desc handed in again is not read twice. @internal */
    keyRead: BinKey | null;
    /** Whether a field needs each draw's depth from its camera. @internal */
    usesDepth: boolean;
    /** @internal */ ended: boolean;
    draw(mesh: Mesh, opts?: BinDrawOptions): void;
};
/** A bin made at this point in the pass. */
export type BinRecord = {
    kind: 'bin';
    bin: Bin;
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
/** The camera the draws after it are drawn from. */
export type CameraRecord = {
    kind: 'camera';
    camera: View;
};
/** The viewport the draws after it are drawn into; undefined is the whole target. */
export type ViewportRecord = {
    kind: 'viewport';
    viewport: ViewportRect | undefined;
};
/** The scissor the draws after it are clipped to; undefined is none. */
export type ScissorRecord = {
    kind: 'scissor';
    scissor: Rect | undefined;
};
/** What a pass records: a draw it was handed, a bundle it was told to replay, or a change to what the draws after it
 *  are drawn with. */
export type PassEntry = DrawRecord | BundleRecord | BinRecord | CameraRecord | ViewportRecord | ScissorRecord;
export type ComputePassDesc = {
    label?: string;
    /**
     * The camera and pixel size the pass's dispatches read render-scope uniforms with (the camera's matrices and
     * position, `screenSize`), as a render pass of that camera into a target that size would. Without one, a dispatch
     * reading them gets whatever the last render pass left.
     */
    view?: {
        camera: View;
        width: number;
        height: number;
    };
};
export type DispatchOptions = {
    /** Rebinds the node's named `storage()` refs for this dispatch alone, so no pipeline is recompiled. */
    buffers?: Record<string, GpuBuffer<Any>>;
    /** Fills the node's named texture slots (`texture(slot, …)`, `storageTexture(slot, …)`) for this dispatch alone:
     *  a texture, a view of part of one, or what holds one (a render target's attachment), as a copy takes. */
    textures?: Record<string, TextureSource | {
        readonly _gpuTexture: GpuTexture;
    }>;
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
    /** Zeroes `byteSize` bytes of `buffer` from `byteOffset`, in the frame's order of work, between its passes. */
    clearBuffer(buffer: GpuBuffer, byteOffset: number, byteSize: number): void;
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
    /** Handed to the backend by every `setCamera()`, created by the first. @internal */
    cameraRecord: CameraRecord | null;
    /** Handed to the backend by every `bin()`, created by the first. @internal */
    binRecord: BinRecord | null;
    /** Every bin made in this pass's slot, the first `binCount` this frame's. @internal */
    bins: Bin[];
    /** @internal */ binCount: number;
    /** Handed to the backend by every `setViewport()` and `setScissor()`. @internal */
    /** @internal */ viewportRecord: ViewportRecord;
    /** @internal */ scissorRecord: ScissorRecord;
    /** What the draws recorded next are drawn from: the desc's, until `setCamera`. @internal */
    camera: View | undefined;
    /** @internal */ ended: boolean;
    /** Draws unconditionally: `mesh.visible` gates the scene walk, not a draw you recorded yourself. */
    draw(mesh: Mesh, opts?: DrawOptions): void;
    /** Replays a bundle here, keeping its order against the draws around it. */
    execute(bundle: RenderBundle): void;
    /** Walks a tree here: frustum culled, `visible` honoured, opaque before transparent. */
    scene(root: Object3D, camera?: View): void;
    /** A bin here: what is drawn into it runs at this point in the pass, ordered by its key. */
    bin(desc: BinDesc): Bin;
    /**
     * Draws what is recorded after this from `camera`, until the next. Its matrices are uniforms of their own for
     * those draws, so one pass draws several views: a shadow atlas, cascades. The same camera again changes nothing.
     */
    setCamera(camera: View): void;
    /** Draws what is recorded after this into `viewport`, in physical pixels from the target's top left, until the
     *  next; undefined is the whole target. It must lie inside the target. */
    setViewport(viewport: ViewportRect | undefined): void;
    /** Clips what is recorded after this to `scissor`, clamped to the target, until the next; undefined is none. */
    setScissor(scissor: Rect | undefined): void;
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
    /**
     * Zeroes `byteSize` bytes of a `cpu: false` `buffer` from `byteOffset` on the GPU, at this point in the frame's
     * work: after the passes ended before it, before those after. Between passes, not in one. Omitted, the offset is
     * 0 and the size the rest of the buffer; both are multiples of 4. The GPU clears it itself, so nothing is
     * uploaded (on WebGL2, which has no buffer clear, zeroes are written).
     */
    clearBuffer(buffer: GpuBuffer, byteOffset?: number, byteSize?: number): void;
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
