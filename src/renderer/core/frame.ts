import type { GpuBuffer } from '../../core/gpu-buffer';
import type { GpuTexture } from '../../core/gpu-texture';
import type { TextureSource } from '../../core/gpu-texture-view';
import type { Object3D } from '../../core/object3d';
import { deadAttachment } from '../../core/render-target';
import type { InspectorBase } from '../../inspector/inspector-base';
import type { Material } from '../../material/material';
import type { ComputeNode } from '../../nodes/lib/core';
import type { MRTNode } from '../../nodes/lib/mrt';
import type { TransformFeedbackNode } from '../../nodes/lib/transform-feedback';
import type { Mesh, MeshDraw } from '../../objects/mesh';
import { drawScene } from '../../scene/draw-scene';
import type { Any } from '../../schema/schema';
import type { CanvasTarget } from './canvas-target';
import type { Renderer } from './renderer';
import { isRenderTarget, type Target } from './target';
import type { View } from './view';

export type BackendName = 'webgl' | 'webgpu';

export type Rect = { x?: number; y?: number; width: number; height: number };

export type ViewportRect = Rect & { minDepth?: number; maxDepth?: number };

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
    range?: { start: number; count: number };
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

export type BinDesc = { key: BinKey; label?: string };

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
export type BinRecord = { kind: 'bin'; bin: Bin };

/**
 * Draws recorded once and replayed into any pass of the same attachment layout (colour formats, depth format, sample
 * count). They are drawn from the bundle's own camera, whatever the pass's: WebGPU bakes a bundle's bind groups when it
 * records, the camera's included, and lets a bundle inherit none from the pass. Holds its meshes and materials strongly
 * and redraws whatever they have become, so the set is expected to be static: `invalidate()` after changing it,
 * `dispose()` when done with it.
 */
export type RenderBundle = {
    /** Names the bundle in errors and on the device objects recorded from it. */
    readonly label: string;
    readonly records: readonly PassEntry[];
    readonly count: number;
    /** What its draws are drawn from; settable, as only the values it holds change, not where they live. */
    camera: View | null;
    /** Bumped by `invalidate`; a recorded device bundle compares against it to decide on a re-record. */
    version: number;
    readonly disposed: boolean;
    invalidate(): void;
    dispose(): void;
    /** Set by the backend that recorded it, to release what it holds for it. @internal */
    _onDispose: (() => void) | null;
};

export type BundleRecord = { kind: 'bundle'; bundle: RenderBundle };

/** The camera the draws after it are drawn from. */
export type CameraRecord = { kind: 'camera'; camera: View };
/** The viewport the draws after it are drawn into; undefined is the whole target. */
export type ViewportRecord = { kind: 'viewport'; viewport: ViewportRect | undefined };
/** The scissor the draws after it are clipped to; undefined is none. */
export type ScissorRecord = { kind: 'scissor'; scissor: Rect | undefined };

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
    view?: { camera: View; width: number; height: number };
};

export type DispatchOptions = {
    /** Rebinds the node's named `storage()` refs for this dispatch alone, so no pipeline is recompiled. */
    buffers?: Record<string, GpuBuffer<Any>>;
    /** Fills the node's named texture slots (`texture(slot, …)`, `storageTexture(slot, …)`) for this dispatch alone:
     *  a texture, a view of part of one, or what holds one (a render target's attachment), as a copy takes. */
    textures?: Record<string, TextureSource | { readonly _gpuTexture: GpuTexture }>;
};

export type DispatchIndirectOptions = DispatchOptions & { offset?: number };

/** Exactly one of `counts` and `indirect`, as a union rather than a comment the reader has to trust. */
export type DispatchRecord = DispatchOptions & { kind: 'dispatch'; node: ComputeNode } & (
        | { counts: [number, number, number]; indirect?: undefined; indirectOffset?: undefined }
        | { counts?: undefined; indirect: GpuBuffer<Any>; indirectOffset?: number }
    );

/** A pass's scratch record writes every field whichever arm it held, which the union alone cannot express. */
type DispatchRecordSlot = DispatchOptions & {
    kind: 'dispatch';
    node: ComputeNode;
    counts?: [number, number, number];
    indirect?: GpuBuffer<Any>;
    indirectOffset?: number;
};

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

export type TransformFeedbackPassDesc = { label?: string };

export type TransformFeedbackDispatch = {
    inputs: Record<string, GpuBuffer>;
    outputs: Record<string, GpuBuffer>;
    count: number;
    instanceCount?: number;
};

export type TransformFeedbackRecord = TransformFeedbackDispatch & { kind: 'transform-feedback'; node: TransformFeedbackNode };

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

export function createFrame(backend: FrameBackend): Frame {
    const frame: Frame = {
        backend,
        renderer: null,
        pool: [],
        poolIndex: 0,
        computePool: [],
        computePoolIndex: 0,
        transformFeedbackPool: [],
        transformFeedbackPoolIndex: 0,
        open: null,
        targets: [],
        completion: null,
        everSubmitted: false,
        closed: true,
        pass: (desc) => openRenderPass(frame, desc),
        compute: (desc) => openComputePass(frame, desc ?? {}),
        transformFeedback: (desc) => openTransformFeedbackPass(frame, desc ?? {}),
        clearBuffer: (buffer, byteOffset = 0, byteSize = buffer.byteLength - byteOffset) =>
            clearFrameBuffer(frame, buffer, byteOffset, byteSize),
        submit: () => submitFrame(frame),
        abandon: () => abandonFrame(frame),
        get done(): Promise<void> {
            if (!frame.closed) {
                throw new Error(
                    frame.everSubmitted
                        ? '[frame] done is readable between submit() and the next frame(); this one has been reopened.'
                        : '[frame] done read before submit(); there is no work to wait on yet',
                );
            }
            frame.completion ??= frame.backend.awaitCompletion();
            return frame.completion;
        },
    };
    return frame;
}

/** True between `gpu.frame()` and `frame.submit()`, when recorded work has not reached the queue yet. */
export function isFrameOpen(frame: Frame | null): boolean {
    return frame !== null && !frame.closed;
}

export function passLabel(pass: AnyPass): string {
    return pass.desc.label ?? pass.kind;
}

/**
 * Opens the renderer's frame for recording. A free function because every other operation on a
 * renderer is one; `Frame` and `Pass` keep their verbs because they are the recording context, not
 * the device handle.
 *
 * One `Frame` per renderer for its lifetime, so a steady-state frame allocates nothing.
 */
export function frame(renderer: Renderer): Frame {
    renderer._assertInitialized('frame');
    renderer._frameState ??= createFrame(renderer.backend);
    renderer._frameState.renderer = renderer;
    beginFrame(renderer._frameState);
    return renderer._frameState;
}

export function beginFrame(frame: Frame): void {
    if (!frame.closed) {
        // Recovery rather than a throw, so a frame a throw escaped from does not wedge the renderer.
        // Silent recovery would hide a missing submit() forever, which is the failure this reports.
        const dropped = frame.open === null ? '' : `, with "${passLabel(frame.open)}" still open`;
        console.warn(`[frame] the previous frame was never submitted${dropped}; dropping its work`);
        abandonFrame(frame);
    }
    frame.closed = false;
    frame.poolIndex = 0;
    frame.computePoolIndex = 0;
    frame.transformFeedbackPoolIndex = 0;
    frame.targets.length = 0;
    frame.completion = null; // the reused frame object must not hand out the last frame's promise
    frame.backend.beginFrame();
}

/** Runs before a pool slot is claimed, so a rejected open leaves the pool untouched. */
function assertCanOpen(frame: Frame, verb: string): void {
    if (frame.closed) throw new Error(`[frame] ${verb} after the frame was closed`);
    if (frame.open !== null) {
        throw new Error(`[frame] ${verb} while "${passLabel(frame.open)}" is still open; end it first`);
    }
}

function clearFrameBuffer(frame: Frame, buffer: GpuBuffer, byteOffset: number, byteSize: number): void {
    assertCanOpen(frame, 'frame.clearBuffer()');
    const what = `[frame] clearBuffer '${buffer.label ?? 'unlabelled'}'`;
    if (buffer.cpu) {
        throw new Error(`${what}: it keeps a CPU array, which the clear would leave stale; make it \`cpu: false\`.`);
    }
    if (buffer.disposed) throw new Error(`${what}: it is disposed.`);
    if (byteOffset % 4 !== 0 || byteSize % 4 !== 0) {
        throw new Error(`${what}: the offset (${byteOffset}) and size (${byteSize}) must be multiples of 4.`);
    }
    if (byteOffset < 0 || byteSize < 0 || byteOffset + byteSize > buffer.byteLength) {
        throw new Error(`${what}: bytes ${byteOffset}..${byteOffset + byteSize} overrun its ${buffer.byteLength} bytes.`);
    }
    if (byteSize === 0) return;
    frame.backend.clearBuffer(buffer, byteOffset, byteSize);
}

/** A WebGL2 context belongs to one canvas for its lifetime, so a pass naming another would draw nowhere visible. */
function assertTargetReachable(frame: Frame, desc: PassDesc): void {
    const deviceCanvas = frame.backend.deviceCanvasTarget;
    if (deviceCanvas === null || isRenderTarget(desc.target) || desc.target === deviceCanvas) return;
    throw new Error(
        '[frame] this pass names a canvas the device was not created on; a WebGL2 context cannot present ' +
            'to a second canvas. Use one pass per viewport on the device canvas, or a renderer per canvas.',
    );
}

function openRenderPass(frame: Frame, desc: PassDesc): Pass {
    assertCanOpen(frame, 'frame.pass()');
    assertTargetReachable(frame, desc);

    let pass = frame.pool[frame.poolIndex];
    if (pass === undefined) {
        pass = createRenderPass(frame, desc);
        frame.pool.push(pass);
    } else {
        pass.desc = desc;
        pass.ended = false;
    }
    pass.camera = desc.camera;
    pass.binCount = 0;
    frame.poolIndex++;
    beginOnBackend(frame, pass);
    frame.open = pass;
    return pass;
}

function createRenderPass(frame: Frame, desc: PassDesc): Pass {
    const pass: Pass = {
        kind: 'render',
        desc,
        drawRecord: null,
        bundleRecord: null,
        cameraRecord: null,
        binRecord: null,
        bins: [],
        binCount: 0,
        viewportRecord: { kind: 'viewport', viewport: undefined },
        scissorRecord: { kind: 'scissor', scissor: undefined },
        camera: desc.camera,
        ended: false,
        draw: (mesh, opts) => recordDraw(frame, pass, mesh, opts),
        execute: (bundle) => recordBundle(frame, pass, bundle),
        scene: (root, camera) => recordScene(frame, pass, root, camera),
        bin: (desc) => recordBin(frame, pass, desc),
        setCamera: (camera) => recordCamera(frame, pass, camera),
        setViewport: (viewport) => recordViewport(frame, pass, viewport),
        setScissor: (scissor) => recordScissor(frame, pass, scissor),
        end: () => endPass(frame, pass),
    };
    return pass;
}

function recordCamera(frame: Frame, pass: Pass, camera: View): void {
    if (pass.ended) throw new Error(`[pass ${passLabel(pass)}] setCamera after end()`);
    pass.camera = camera;
    let record = pass.cameraRecord;
    if (record === null) {
        record = { kind: 'camera', camera };
        pass.cameraRecord = record;
    } else {
        record.camera = camera;
    }
    resolveCall(frame, pass, record);
}

function recordBin(frame: Frame, pass: Pass, desc: BinDesc): Bin {
    if (pass.ended) throw new Error(`[pass ${passLabel(pass)}] bin after end()`);
    let bin = pass.bins[pass.binCount];
    if (bin === undefined) {
        const created: Bin = {
            kind: 'bin',
            desc,
            index: pass.binCount,
            fields: [],
            bits: [],
            keyRead: null,
            usesDepth: false,
            ended: false,
            draw: (mesh, opts) => recordDraw(frame, pass, mesh, opts, created),
        };
        bin = created;
        pass.bins.push(bin);
    }
    bin.desc = desc;
    bin.ended = false;
    if (bin.keyRead !== desc.key) readBinKey(bin, desc.key, passLabel(pass));
    pass.binCount++;

    let record = pass.binRecord;
    if (record === null) {
        record = { kind: 'bin', bin };
        pass.binRecord = record;
    } else {
        record.bin = bin;
    }
    resolveCall(frame, pass, record);
    return bin;
}

const BIN_KEY_PRESETS: Record<'state' | 'back-to-front' | 'submission', readonly BinField[]> = {
    state: ['sortKey', 'pipeline', 'material', 'geometry'],
    'back-to-front': ['sortKey', 'depthFar'],
    submission: [],
};

const BIN_FIELDS: readonly BinField[] = ['sortKey', 'pipeline', 'material', 'geometry', 'view', 'depthNear', 'depthFar'];

/** `key` into `bin`'s fields and bits, refusing a field it does not know or one named twice. */
function readBinKey(bin: Bin, key: BinKey, label: string): void {
    bin.fields.length = 0;
    bin.bits.length = 0;
    bin.usesDepth = false;
    const fields = typeof key === 'string' ? BIN_KEY_PRESETS[key] : key;
    if (fields === undefined)
        throw new Error(`[pass ${label}] bin key '${key}' is none of 'state', 'back-to-front', 'submission'`);
    for (const entry of fields) {
        let field: BinField;
        let bits = 0;
        if (typeof entry === 'string') field = entry;
        else {
            const names = Object.keys(entry) as BinField[];
            if (names.length !== 1)
                throw new Error(`[pass ${label}] a bin key field with bits names one field, not ${names.length}`);
            field = names[0]!;
            bits = entry[field]!;
            if (!Number.isInteger(bits) || bits < 1 || bits > 52) {
                throw new Error(`[pass ${label}] bin key field '${field}' takes 1 to 52 bits, not ${bits}`);
            }
        }
        if (!BIN_FIELDS.includes(field)) throw new Error(`[pass ${label}] '${field}' is not a bin key field`);
        if (bin.fields.includes(field)) throw new Error(`[pass ${label}] bin key names '${field}' twice`);
        bin.fields.push(field);
        bin.bits.push(bits);
        if (field === 'depthNear' || field === 'depthFar') bin.usesDepth = true;
    }
    bin.keyRead = key;
}

function recordViewport(frame: Frame, pass: Pass, viewport: ViewportRect | undefined): void {
    if (pass.ended) throw new Error(`[pass ${passLabel(pass)}] setViewport after end()`);
    pass.viewportRecord.viewport = viewport;
    resolveCall(frame, pass, pass.viewportRecord);
}

function recordScissor(frame: Frame, pass: Pass, scissor: Rect | undefined): void {
    if (pass.ended) throw new Error(`[pass ${passLabel(pass)}] setScissor after end()`);
    pass.scissorRecord.scissor = scissor;
    resolveCall(frame, pass, pass.scissorRecord);
}

function recordScene(frame: Frame, pass: Pass, root: Object3D, camera?: View): void {
    if (frame.renderer === null) throw new Error('[pass] scene() needs a frame opened with frame(renderer).');
    const view = camera ?? pass.camera;
    if (view === undefined) throw new Error('[pass] scene() needs a camera, on the pass desc or as its second argument.');
    drawScene(frame.renderer, pass, root, view);
}

function openComputePass(frame: Frame, desc: ComputePassDesc): ComputePass {
    assertCanOpen(frame, 'frame.compute()');
    if (frame.backend.name === 'webgl') {
        throw new Error('[frame] compute passes need the webgpu backend; WebGL2 has no compute shaders');
    }

    let pass = frame.computePool[frame.computePoolIndex];
    if (pass === undefined) {
        pass = createComputePass(frame, desc);
        frame.computePool.push(pass);
    } else {
        pass.desc = desc;
        pass.ended = false;
    }
    frame.computePoolIndex++;
    beginOnBackend(frame, pass);
    frame.open = pass;
    return pass;
}

function openTransformFeedbackPass(frame: Frame, desc: TransformFeedbackPassDesc): TransformFeedbackPass {
    assertCanOpen(frame, 'frame.transformFeedback()');
    if (frame.backend.name === 'webgpu') {
        throw new Error('[frame] transform feedback is WebGL2-only; use frame.compute() on the webgpu backend');
    }

    let pass = frame.transformFeedbackPool[frame.transformFeedbackPoolIndex];
    if (pass === undefined) {
        pass = createTransformFeedbackPass(frame, desc);
        frame.transformFeedbackPool.push(pass);
    } else {
        pass.desc = desc;
        pass.ended = false;
    }
    frame.transformFeedbackPoolIndex++;
    beginOnBackend(frame, pass);
    frame.open = pass;
    return pass;
}

function createTransformFeedbackPass(frame: Frame, desc: TransformFeedbackPassDesc): TransformFeedbackPass {
    const pass: TransformFeedbackPass = {
        kind: 'transform-feedback',
        desc,
        record: null,
        ended: false,
        dispatch: (node, opts) => recordTransformFeedback(frame, pass, node, opts),
        end: () => endPass(frame, pass),
    };
    return pass;
}

function recordTransformFeedback(
    frame: Frame,
    pass: TransformFeedbackPass,
    node: TransformFeedbackNode,
    opts: TransformFeedbackDispatch,
): void {
    if (pass.ended) throw new Error(`[pass ${passLabel(pass)}] dispatch after end()`);

    let record = pass.record;
    if (record === null) {
        record = { kind: 'transform-feedback', node, ...opts };
        pass.record = record;
    } else {
        record.node = node;
        record.inputs = opts.inputs;
        record.outputs = opts.outputs;
        record.count = opts.count;
        record.instanceCount = opts.instanceCount;
    }
    resolveCall(frame, pass, record);
}

function createComputePass(frame: Frame, desc: ComputePassDesc): ComputePass {
    const pass: ComputePass = {
        kind: 'compute',
        desc,
        record: null,
        ended: false,
        dispatch: (node, counts, opts) => recordDispatch(frame, pass, node, counts, undefined, 0, opts),
        dispatchIndirect: (node, indirect, opts) =>
            recordDispatch(frame, pass, node, undefined, indirect, opts?.offset ?? 0, opts),
        end: () => endPass(frame, pass),
    };
    return pass;
}

function recordDispatch(
    frame: Frame,
    pass: ComputePass,
    node: ComputeNode,
    counts: [number, number, number] | undefined,
    indirect: GpuBuffer<Any> | undefined,
    indirectOffset: number,
    opts: DispatchOptions | undefined,
): void {
    if (pass.ended) throw new Error(`[pass ${passLabel(pass)}] dispatch after end()`);

    let record = pass.record as DispatchRecordSlot | null;
    if (record === null) {
        record = { kind: 'dispatch', node, counts, indirect, indirectOffset, buffers: opts?.buffers, textures: opts?.textures };
        pass.record = record as DispatchRecord;
    } else {
        record.node = node;
        record.counts = counts;
        record.indirect = indirect;
        record.indirectOffset = indirectOffset;
        record.buffers = opts?.buffers;
        record.textures = opts?.textures;
    }
    resolveCall(frame, pass, record as DispatchRecord);
}

function inspectorOf(frame: Frame): InspectorBase | null {
    return frame.renderer?.inspector ?? null;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Opens `pass` on the backend, telling an attached inspector first, so a pass the backend skips or refuses is still seen. */
function beginOnBackend(frame: Frame, pass: AnyPass): void {
    const inspector = inspectorOf(frame);
    inspector?.beginRecordedPass(pass.kind, passLabel(pass));
    try {
        if (pass.kind === 'render') frame.backend.beginPass(pass.desc);
        else if (pass.kind === 'compute') frame.backend.beginComputePass(pass.desc);
        else frame.backend.beginTransformFeedbackPass(pass.desc);
    } catch (error) {
        inspector?.endRecordedPass(errorMessage(error));
        throw error;
    }
}

/**
 * Resolves a just-recorded call, so it takes the values set before it. The open pass is set aside
 * meanwhile: resolving evaluates the node graph, which may record a nested pass.
 */
function resolveCall(frame: Frame, pass: AnyPass, record: CallRecord): void {
    const inspector = inspectorOf(frame);
    inspector?.beginRecordedCall(record);
    frame.open = null;
    try {
        if (record.kind === 'dispatch') frame.backend.recordDispatch(record);
        else if (record.kind === 'transform-feedback') frame.backend.recordTransformFeedback(record);
        else frame.backend.recordEntry(record);
    } catch (error) {
        inspector?.endRecordedCall(errorMessage(error));
        throw error;
    } finally {
        frame.open = pass;
    }
    inspector?.endRecordedCall(null);
}

function recordDraw(frame: Frame, pass: Pass, mesh: Mesh, opts: BinDrawOptions | undefined, bin: Bin | null = null): void {
    if (pass.ended) throw new Error(`[pass ${passLabel(pass)}] draw after end()`);
    if (bin?.ended) throw new Error(`[pass ${passLabel(pass)}] draw into a bin after its pass ended`);
    if (bin === null && opts?.sortKey !== undefined) {
        throw new Error(
            `[pass ${passLabel(pass)}] '${mesh.name || 'mesh'}' passes a sortKey to the pass; a sortKey orders draws in a bin`,
        );
    }
    if (opts?.draws !== undefined && (opts.instances !== undefined || opts.range !== undefined)) {
        throw new Error(
            `[pass ${passLabel(pass)}] '${mesh.name || 'mesh'}' passes draws alongside instances or range; ` +
                'each MeshDraw carries its own instanceCount and index range, so the single-draw fields are unreachable.',
        );
    }

    const material = opts?.material ?? mesh.material;
    let record = pass.drawRecord;
    if (record === null) {
        record = { kind: 'draw', mesh, material, opts: opts ?? null, bin, sortKey: opts?.sortKey ?? 0 };
        pass.drawRecord = record;
    } else {
        record.mesh = mesh;
        record.material = material;
        record.opts = opts ?? null;
        record.bin = bin;
        record.sortKey = opts?.sortKey ?? 0;
    }
    resolveCall(frame, pass, record);
}

function recordBundle(frame: Frame, pass: Pass, bundle: RenderBundle): void {
    if (pass.ended) throw new Error(`[pass ${passLabel(pass)}] execute after end()`);
    if (bundle.disposed) throw new Error(`[bundle ${bundle.label}] execute after dispose()`);
    for (const entry of bundle.records) {
        if (entry.kind !== 'draw') continue;
        if (entry.material.disposed || entry.mesh.geometry.disposed) {
            const what = entry.material.disposed ? `material '${entry.material.name}'` : `the geometry of '${entry.mesh.name}'`;
            throw new Error(`[bundle ${bundle.label}] ${what} was disposed: record a new bundle with live ones`);
        }
    }

    let record = pass.bundleRecord;
    if (record === null) {
        record = { kind: 'bundle', bundle };
        pass.bundleRecord = record;
    } else {
        record.bundle = bundle;
    }
    resolveCall(frame, pass, record);
}

function endPass(frame: Frame, pass: AnyPass): void {
    if (pass.ended) throw new Error(`[pass ${passLabel(pass)}] end() called twice`);
    if (frame.closed) {
        throw new Error(
            `[pass ${passLabel(pass)}] the frame this pass belongs to was closed while it was open; ` +
                'its draws were never encoded. A frame opened between this pass and its end() is what does this.',
        );
    }
    pass.ended = true;
    if (pass.kind === 'render') for (let index = 0; index < pass.binCount; index++) pass.bins[index]!.ended = true;
    frame.open = null; // cleared first: encoding evaluates the graph, which may open a nested pass
    inspectorOf(frame)?.endRecordedPass(null);

    if (pass.kind === 'compute') {
        frame.backend.encodeComputePass(pass.desc);
    } else if (pass.kind === 'transform-feedback') {
        frame.backend.encodeTransformFeedbackPass(pass.desc);
    } else {
        const target = pass.desc.target;
        frame.targets.push(target);
        frame.backend.encodePass(pass.desc);
    }
}

function submitFrame(frame: Frame): void {
    if (frame.closed) throw new Error('[frame] submit() called twice');
    if (frame.open !== null) {
        throw new Error(`[frame] submit() while "${passLabel(frame.open)}" is still open; end it first`);
    }

    // `abandon()` is the answer to a mid-frame room swap, not a disposal race.
    for (const target of frame.targets) {
        const dead = isRenderTarget(target) ? deadAttachment(target) : target.disposed ? 'canvas' : null;
        if (dead !== null) {
            throw new Error(
                `[frame] '${dead}' was disposed after its pass recorded into it; abandon() the frame instead of disposing mid-frame.`,
            );
        }
    }

    frame.closed = true;
    frame.everSubmitted = true;
    frame.backend.submitFrame();
}

/** A recorded-but-unencoded pass is dropped with the frame; atomic encoding leaves no GPU pass open. */
function abandonFrame(frame: Frame): void {
    if (frame.closed) return;
    frame.open = null;
    frame.closed = true;
    frame.backend.discardFrame();
}
