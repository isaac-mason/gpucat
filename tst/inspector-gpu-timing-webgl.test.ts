import { beforeEach, expect, test } from 'vitest';
import type { InspectableRenderer } from '../src/inspector/inspector-base';
import { RendererInspector } from '../src/inspector/renderer-inspector';

/**
 * The WebGL side of the same timing path: EXT_disjoint_timer_query_webgl2 instead of a query set.
 * The results land a frame or two later and back-patch their FrameRecord, and a disjoint event
 * (GPU power/context state change) invalidates every timing in flight — a frame that keeps only the
 * surviving passes reports a fraction of its GPU cost as the whole of it.
 */

const TIME_ELAPSED_EXT = 0x88bf;
const GPU_DISJOINT_EXT = 0x8fbb;
const QUERY_RESULT = 0x8866;
const QUERY_RESULT_AVAILABLE = 0x8867;
const NS_PER_MS = 1_000_000;

type FakeQuery = { id: number; deleted: boolean };

type FakeGL = {
    gl: WebGL2RenderingContext;
    /** Results keyed by the query the pass ran in, in ns; absent means not available yet. */
    results: Map<FakeQuery, number>;
    /** The next getParameter(GPU_DISJOINT_EXT) reads this, as the real flag self-clears. */
    disjoint: boolean;
    /** Queries opened, in order, so a test can script their results. */
    opened: FakeQuery[];
    open: FakeQuery | null;
    created: number;
    deleted: number;
};

function createFakeGL(): FakeGL {
    const state: FakeGL = {
        gl: null as unknown as WebGL2RenderingContext,
        results: new Map(),
        disjoint: false,
        opened: [],
        open: null,
        created: 0,
        deleted: 0,
    };

    state.gl = {
        QUERY_RESULT,
        QUERY_RESULT_AVAILABLE,
        getExtension: (name: string) =>
            name === 'EXT_disjoint_timer_query_webgl2' ? { TIME_ELAPSED_EXT, GPU_DISJOINT_EXT } : null,
        createQuery: (): FakeQuery => ({ id: state.created++, deleted: false }),
        deleteQuery: (q: FakeQuery) => {
            q.deleted = true;
            state.deleted++;
        },
        beginQuery: (target: number, q: FakeQuery) => {
            expect(target).toBe(TIME_ELAPSED_EXT);
            // TIME_ELAPSED queries cannot nest; a second begin would be an INVALID_OPERATION.
            expect(state.open).toBeNull();
            expect(q.deleted).toBe(false);
            state.open = q;
            state.opened.push(q);
        },
        endQuery: (target: number) => {
            expect(target).toBe(TIME_ELAPSED_EXT);
            expect(state.open).not.toBeNull();
            state.open = null;
        },
        getParameter: (pname: number) => {
            if (pname !== GPU_DISJOINT_EXT) throw new Error(`unexpected getParameter ${pname}`);
            const value = state.disjoint;
            state.disjoint = false; // reading the flag clears it, as the extension specifies
            return value;
        },
        getQueryParameter: (q: FakeQuery, pname: number) => {
            expect(q.deleted).toBe(false);
            if (pname === QUERY_RESULT_AVAILABLE) return state.results.has(q);
            return state.results.get(q) ?? 0;
        },
    } as unknown as WebGL2RenderingContext;

    return state;
}

/** The slice of a renderer the inspector's GL timing path touches. */
function fakeRenderer(gl: WebGL2RenderingContext): InspectableRenderer {
    return { api: 'webgl', backend: { gl } } as unknown as InspectableRenderer;
}

let fake: FakeGL;
let inspector: RendererInspector;

beforeEach(() => {
    fake = createFakeGL();
    inspector = new RendererInspector();
    inspector.setRenderer(fakeRenderer(fake.gl));
});

/** A pass as the WebGL frame backend drives it: prepare, then the GPU bracket around the GL work. */
function renderPass(name: string, gpuWork: () => void = () => {}): void {
    inspector.beginRender(name);
    inspector.beginGpuWork(name);
    try {
        gpuWork();
    } finally {
        inspector.endGpuWork(name);
        inspector.finishRender(name);
    }
}

/** One frame of `passes` top-level render passes, returning the queries they opened. */
function renderFrame(frameId: number, passes: string[]): FakeQuery[] {
    const before = fake.opened.length;
    inspector.begin(frameId);
    for (const pass of passes) renderPass(pass);
    inspector.finish(frameId);
    return fake.opened.slice(before);
}

test('a WebGL frame sums its passes once every timer query has landed', () => {
    const [a, b] = renderFrame(1, ['shadow', 'main']);
    expect(inspector.latestResolvedFrame()).toBeNull(); // nothing has landed yet

    fake.results.set(a!, 2 * NS_PER_MS);
    renderFrame(2, ['shadow', 'main']); // finish() polls

    // Frame 1 is incomplete while 'main' is still pending: no partial total.
    expect(inspector.frames[0]!.gpuMs).toBeNull();

    fake.results.set(b!, 3 * NS_PER_MS);
    renderFrame(3, ['shadow', 'main']);

    const frame1 = inspector.frames[0]!;
    expect(frame1.gpuMs).toBeCloseTo(5, 5);
    expect(frame1.timeline.map((e) => (e.kind === 'render' ? e.gpuMs : null))).toEqual([2, 3]);
});

test('preparing a pass is outside its GPU bracket', () => {
    inspector.begin(1);
    inspector.beginRender('main');
    // Everything between beginRender and beginGpuWork is prepare: uploads and shader compiles, whose
    // GL work must not be charged to the pass.
    expect(fake.open).toBeNull();
    expect(fake.opened).toHaveLength(0);

    inspector.beginGpuWork('main');
    expect(fake.open).not.toBeNull();
    inspector.endGpuWork('main');
    inspector.finishRender('main');
    inspector.finish(1);

    expect(fake.opened).toHaveLength(1);
});

test('a pass prepared inside another pass is timed on its own', () => {
    // How a render-texture node lands on WebGL: the nested pass runs during the outer pass's
    // prepare, before the outer opens its bracket, so neither contains the other.
    inspector.begin(1);
    inspector.beginRender('outer');
    renderPass('inner');
    inspector.beginGpuWork('outer');
    inspector.endGpuWork('outer');
    inspector.finishRender('outer');
    inspector.finish(1);

    const [innerQuery, outerQuery] = fake.opened;
    expect(fake.opened).toHaveLength(2);
    fake.results.set(innerQuery!, 1 * NS_PER_MS);
    fake.results.set(outerQuery!, 4 * NS_PER_MS);
    renderFrame(2, ['outer']);

    const frame1 = inspector.frames[0]!;
    const outer = frame1.timeline[0]!;
    expect(outer.kind === 'render' && outer.gpuMs).toBeCloseTo(4, 5);
    const inner = outer.children[0]!;
    expect(inner.kind === 'render' && inner.gpuMs).toBeCloseTo(1, 5);
    expect(frame1.gpuMs).toBeCloseTo(5, 5); // summed, and neither span contains the other
});

test('an overlapping GPU bracket is refused rather than nesting a TIME_ELAPSED query', () => {
    inspector.begin(1);
    inspector.beginRender('outer');
    inspector.beginGpuWork('outer');
    // Nothing in the backend does this today; the guard is what keeps an INVALID_OPERATION out of
    // the GL stream if anything ever does.
    inspector.beginRender('inner');
    inspector.beginGpuWork('inner');
    inspector.endGpuWork('inner');
    inspector.finishRender('inner');
    inspector.endGpuWork('outer');
    inspector.finishRender('outer');
    inspector.finish(1);

    expect(fake.opened).toHaveLength(1);
    fake.results.set(fake.opened[0]!, 4 * NS_PER_MS);
    renderFrame(2, ['outer']);

    const frame1 = inspector.frames[0]!;
    const outer = frame1.timeline[0]!;
    expect(outer.kind === 'render' && outer.gpuMs).toBeCloseTo(4, 5);
    expect(outer.children[0]!.kind === 'render' && outer.children[0]!.gpuMs).toBeNull();
    expect(frame1.gpuMs).toBeCloseTo(4, 5); // the untimed child is not double-counted
});

test('a disjoint event drops every timing in flight, not just the readable ones', () => {
    const [a, b] = renderFrame(1, ['shadow', 'main']);

    // 'shadow' lands normally.
    fake.results.set(a!, 2 * NS_PER_MS);
    renderFrame(2, ['shadow', 'main']);
    const frame1 = inspector.frames[0]!;
    expect(frame1.timeline[0]!.kind === 'render' && frame1.timeline[0]!.gpuMs).toBeCloseTo(2, 5);

    // Now the GPU changes state. 'main' is still in flight, so its timing is invalid too — and so is
    // the 'shadow' result that already landed for the same frame.
    fake.disjoint = true;
    fake.results.set(b!, 999 * NS_PER_MS);
    renderFrame(3, ['shadow', 'main']);

    expect(frame1.gpuMs).toBeNull();
    expect(frame1.timeline.every((e) => e.kind !== 'render' || e.gpuMs === null)).toBe(true);
    expect(b!.deleted).toBe(true);
});

test('timing resumes on the frames after a disjoint event', () => {
    renderFrame(1, ['main']);
    fake.disjoint = true;
    renderFrame(2, ['main']); // poll drops frame 1's query

    const [q3] = renderFrame(3, ['main']);
    fake.results.set(q3!, 7 * NS_PER_MS);
    renderFrame(4, ['main']);

    expect(inspector.frames[2]!.gpuMs).toBeCloseTo(7, 5);
});

test('a pass whose query cannot be ended does not silence every later pass', () => {
    inspector.begin(1);
    inspector.beginRender('main');
    // The context goes while the pass is open: endQuery can't run, but the active slot must clear.
    (inspector.renderer as unknown as { backend: { gl: WebGL2RenderingContext | null } }).backend.gl = null;
    inspector.finishRender('main');
    inspector.finish(1);
    (inspector.renderer as unknown as { backend: { gl: WebGL2RenderingContext } }).backend.gl = fake.gl;
    fake.open = null; // the lost context took the open query with it

    const [q] = renderFrame(2, ['main']);
    expect(q).toBeDefined();
    fake.results.set(q!, NS_PER_MS);
    renderFrame(3, ['main']);
    expect(inspector.frames[1]!.gpuMs).toBeCloseTo(1, 5);
});

test('a transform-feedback kernel is timed and counts toward the frame', () => {
    const kernel = 'transform-feedback: particles';
    inspector.begin(1);
    inspector.perf.start('transform-feedback'); // the pass-level grouping marker, CPU only
    inspector.beginKernel(kernel);
    inspector.beginGpuWork(kernel);
    inspector.endGpuWork(kernel);
    inspector.finishKernel(kernel);
    inspector.perf.end('transform-feedback');
    renderPass('main');
    inspector.finish(1);

    const [kernelQuery, passQuery] = fake.opened;
    expect(fake.opened).toHaveLength(2);
    fake.results.set(kernelQuery!, 3 * NS_PER_MS);
    fake.results.set(passQuery!, 2 * NS_PER_MS);
    renderFrame(2, ['main']);

    const frame1 = inspector.frames[0]!;
    const group = frame1.timeline[0]!;
    expect(group.kind).toBe('marker');
    const entry = group.children[0]!;
    expect(entry.kind).toBe('compute');
    expect(entry.kind === 'compute' && entry.gpuMs).toBeCloseTo(3, 5);
    expect(frame1.gpuMs).toBeCloseTo(5, 5);
});

test('a frame of nothing but kernels still reports a GPU time', () => {
    const kernel = 'transform-feedback: particles';
    inspector.begin(1);
    inspector.beginKernel(kernel);
    inspector.beginGpuWork(kernel);
    inspector.endGpuWork(kernel);
    inspector.finishKernel(kernel);
    inspector.finish(1);

    fake.results.set(fake.opened[0]!, 6 * NS_PER_MS);
    inspector.begin(2);
    inspector.finish(2);

    expect(inspector.frames[0]!.gpuMs).toBeCloseTo(6, 5);
});

test('a kernel entry does not land in the compute-node registry', () => {
    // `computeNodes` is keyed by ComputeNode for the WebGPU Compute Calls tab; a TF node is not one.
    inspector.begin(1);
    inspector.beginKernel('transform-feedback: particles');
    inspector.finishKernel('transform-feedback: particles');
    inspector.finish(1);

    expect(inspector.computeNodes.size).toBe(0);
});
