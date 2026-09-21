import { expect, test } from 'vitest';
import { createRenderTarget } from '../src/core/render-target';
import type { Mesh } from '../src/objects/mesh';
import { createCanvasTarget } from '../src/renderer/core/canvas-target';
import {
    type BackendName,
    beginFrame,
    createFrame,
    type DrawRecord,
    type FrameBackend,
    type Pass,
    type PassDesc,
} from '../src/renderer/core/frame';

type Call = { fn: string; label?: string; drawn?: string[] };

function recorder(name: BackendName = 'webgpu'): { backend: FrameBackend; calls: Call[] } {
    const calls: Call[] = [];
    const backend: FrameBackend = {
        name,
        deviceCanvasTarget: null,
        awaitCompletion: () => Promise.resolve(),
        beginFrame: () => void calls.push({ fn: 'beginFrame' }),
        encodePass: (d: PassDesc, records: readonly DrawRecord[], count: number) =>
            void calls.push({ fn: 'encodePass', label: d.label, drawn: records.slice(0, count).map((r) => r.mesh.name) }),
        encodeComputePass: () => void calls.push({ fn: 'encodeComputePass' }),
        encodeTransformFeedbackPass: () => undefined,
        submitFrame: () => void calls.push({ fn: 'submitFrame' }),
        discardFrame: () => void calls.push({ fn: 'discardFrame' }),
    };
    return { backend, calls };
}

const target = createRenderTarget(8, 8);
const mesh = (name: string) => ({ name, material: {} }) as Mesh;
const names = (calls: Call[]) => calls.map((c) => c.fn);

function started() {
    const { backend, calls } = recorder();
    const frame = createFrame(backend);
    beginFrame(frame);
    return { frame, calls };
}

test('nothing reaches the backend until pass.end()', () => {
    const { frame, calls } = started();

    const pass = frame.pass({ target, label: 'scene' });
    pass.draw(mesh('a'));
    pass.draw(mesh('b'));
    expect(names(calls)).toEqual(['beginFrame']);

    pass.end();
    expect(names(calls)).toEqual(['beginFrame', 'encodePass']);
    expect(calls[1].drawn).toEqual(['a', 'b']);
});

test('passes encode in call order, one submit', () => {
    const { frame, calls } = started();

    for (const label of ['world', 'overlay', 'composite']) {
        const pass = frame.pass({ target, label });
        pass.draw(mesh(label));
        pass.end();
    }
    frame.submit();

    expect(calls.filter((c) => c.fn === 'encodePass').map((c) => c.label)).toEqual(['world', 'overlay', 'composite']);
    expect(calls.filter((c) => c.fn === 'submitFrame')).toHaveLength(1);
});

test('a second pass cannot open while one is still open', () => {
    const { frame } = started();
    frame.pass({ target, label: 'scene' });

    expect(() => frame.pass({ target })).toThrow(/"scene" is still open/);
});

test('submit() with an open pass throws and names it', () => {
    const { frame } = started();
    frame.pass({ target, label: 'scene' });

    expect(() => frame.submit()).toThrow(/"scene" is still open/);
});

test('double end() and draw-after-end() throw', () => {
    const { frame } = started();
    const pass = frame.pass({ target });
    pass.end();

    expect(() => pass.end()).toThrow(/end\(\) called twice/);
    expect(() => pass.draw(mesh('a'))).toThrow(/draw after end\(\)/);
});

test('double submit() throws', () => {
    const { frame } = started();
    frame.submit();

    expect(() => frame.submit()).toThrow(/submit\(\) called twice/);
});

test('abandon() drops a recorded pass rather than encoding or submitting it', () => {
    const { frame, calls } = started();
    const pass = frame.pass({ target, label: 'scene' });
    pass.draw(mesh('a'));

    frame.abandon();

    expect(names(calls)).toEqual(['beginFrame', 'discardFrame']);
    expect(frame.open).toBeNull();
    expect(frame.closed).toBe(true);
});

test('abandonFrame after submit is a no-op', () => {
    const { frame, calls } = started();
    frame.submit();
    frame.abandon();

    expect(calls.filter((c) => c.fn === 'discardFrame')).toHaveLength(0);
});

test('a throw inside encode still leaves the frame able to open another pass', () => {
    const { backend } = recorder();
    const frame = createFrame({
        ...backend,
        encodePass: () => {
            throw new Error('validation failed');
        },
    });
    beginFrame(frame);
    const pass = frame.pass({ target, label: 'scene' });

    expect(() => pass.end()).toThrow('validation failed');
    expect(frame.open).toBeNull();
    expect(() => frame.pass({ target, label: 'next' })).not.toThrow();
});

test('beginFrame recovers from a frame a throw escaped from', () => {
    const { frame, calls } = started();
    frame.pass({ target, label: 'scene' });

    beginFrame(frame);

    expect(names(calls)).toEqual(['beginFrame', 'discardFrame', 'beginFrame']);
    expect(frame.open).toBeNull();
    expect(frame.closed).toBe(false);
});

test('pass objects are pooled across frames', () => {
    const { frame } = started();

    const a = frame.pass({ target });
    a.end();
    frame.submit();

    beginFrame(frame);
    const b = frame.pass({ target });

    expect(b).toBe(a);
    expect(b.ended).toBe(false);
});

test('a webgl backend rejects a compute pass at begin, before any dispatch is recorded', () => {
    const { backend, calls } = recorder('webgl');
    const frame = createFrame(backend);
    beginFrame(frame);

    expect(() => frame.compute()).toThrow(/compute passes need the webgpu backend/);
    expect(frame.open).toBeNull();
    expect(frame.computePool).toHaveLength(0);
    expect(names(calls)).not.toContain('encodeComputePass');
});

test('a pass may open while another is mid-encode, and encodes first', () => {
    const calls: Call[] = [];
    const frame = createFrame({
        name: 'webgpu',
        deviceCanvasTarget: null,
        awaitCompletion: () => Promise.resolve(),
        beginFrame: () => void calls.push({ fn: 'beginFrame' }),
        encodePass: (d: PassDesc) => {
            calls.push({ fn: 'encodePass', label: d.label });
            if (d.label !== 'beauty') return;
            const nested = frame.pass({ target, label: 'composite-nested' });
            nested.end();
        },
        encodeComputePass: () => {},
        encodeTransformFeedbackPass: () => undefined,
        submitFrame: () => void calls.push({ fn: 'submitFrame' }),
        discardFrame: () => {},
    });
    beginFrame(frame);

    const pass = frame.pass({ target, label: 'beauty' });
    pass.end();
    frame.submit();

    expect(calls.map((c) => c.label ?? c.fn)).toEqual(['beginFrame', 'beauty', 'composite-nested', 'submitFrame']);
});

test('a nested pass takes its own pool slot, leaving the outer records intact', () => {
    let outer: Pass | null = null;
    let nested: Pass | null = null;
    const frame = createFrame({
        name: 'webgpu',
        deviceCanvasTarget: null,
        awaitCompletion: () => Promise.resolve(),
        beginFrame: () => {},
        encodePass: (d: PassDesc, records: readonly DrawRecord[], count: number) => {
            if (d.label !== 'outer') return;
            nested = frame.pass({ target, label: 'nested' });
            nested.draw(mesh('z'));
            nested.end();
            // still the outer pass's own records, after the nested pass claimed a slot and encoded
            expect(records.slice(0, count).map((r) => r.mesh.name)).toEqual(['a']);
        },
        encodeComputePass: () => {},
        encodeTransformFeedbackPass: () => undefined,
        submitFrame: () => {},
        discardFrame: () => {},
    });
    beginFrame(frame);

    outer = frame.pass({ target, label: 'outer' });
    outer.draw(mesh('a'));
    outer.end();

    expect(nested).not.toBe(outer);
    expect(frame.pool).toHaveLength(2);
});

test('a pass cannot open while another is still recording', () => {
    const { frame } = started();
    frame.pass({ target, label: 'outer' });

    expect(() => frame.pass({ target, label: 'nested' })).toThrow(/"outer" is still open/);
});

test('draw records are reused across frames, so a steady-state frame grows nothing', () => {
    const { frame } = started();
    const meshes = [mesh('a'), mesh('b'), mesh('c')];

    let records: unknown;
    for (let i = 0; i < 4; i++) {
        if (i > 0) beginFrame(frame);
        const pass = frame.pass({ target, label: 'scene' });
        for (const m of meshes) pass.draw(m);
        pass.end();
        frame.submit();

        records ??= pass.records;
        // Same pooled pass, same record array, same record objects inside it.
        expect(pass.records).toBe(records);
        expect(pass.records).toHaveLength(3);
    }

    expect(frame.pool).toHaveLength(1);
});

test('a pass recording fewer draws than last time reads only the new count', () => {
    const { frame, calls } = started();

    const first = frame.pass({ target, label: 'scene' });
    first.draw(mesh('a'));
    first.draw(mesh('b'));
    first.end();
    frame.submit();

    beginFrame(frame);
    const second = frame.pass({ target, label: 'scene' });
    second.draw(mesh('c'));
    second.end();
    frame.submit();

    // The pooled array still holds 'b' in slot 1; count is what bounds the read.
    expect(second.records).toHaveLength(2);
    expect(calls.filter((c) => c.fn === 'encodePass').at(-1)?.drawn).toEqual(['c']);
});

test('a target disposed after its pass recorded is caught at submit, not by the driver', () => {
    const { frame, calls } = started();

    const doomed = createRenderTarget(64, 64);
    frame.pass({ target: doomed }).end();
    doomed.dispose();

    expect(() => frame.submit()).toThrow(/disposed after its pass recorded/);
    // Nothing was handed to the device, so `abandon()` is still the way out.
    expect(names(calls)).not.toContain('submitFrame');
});

test('the next frame starts clean rather than re-reporting a target disposed in the last one', () => {
    const { frame } = started();

    const doomed = createRenderTarget(64, 64);
    frame.pass({ target: doomed }).end();
    doomed.dispose();
    expect(() => frame.submit()).toThrow();

    beginFrame(frame);
    frame.pass({ target: createRenderTarget(64, 64) }).end();
    expect(() => frame.submit()).not.toThrow();
});

test('a webgl frame refuses a canvas its context was not created on, and still takes render targets', () => {
    const canvas = () => ({ width: 8, height: 8 }) as HTMLCanvasElement;
    const deviceCanvasTarget = createCanvasTarget(canvas());
    const foreign = createCanvasTarget(canvas());
    const { backend, calls } = recorder('webgl');
    const frame = createFrame({ ...backend, deviceCanvasTarget });
    beginFrame(frame);

    expect(() => frame.pass({ target: foreign })).toThrow(/cannot present to a second canvas/);

    // The refusal costs the frame nothing: the device canvas and any render target still encode.
    frame.pass({ target: deviceCanvasTarget }).end();
    frame.pass({ target }).end();
    expect(names(calls)).toEqual(['beginFrame', 'encodePass', 'encodePass']);
});

test('done waits once however often it is read, and not at all if it never is', () => {
    let waits = 0;
    const { backend } = recorder();
    const frame = createFrame({ ...backend, awaitCompletion: () => (waits++, Promise.resolve()) });

    beginFrame(frame);
    frame.pass({ target }).end();
    frame.submit();
    expect(waits, 'submit alone must not start a wait').toBe(0);

    const first = frame.done;
    expect(frame.done).toBe(first);
    expect(waits).toBe(1);
});

test('done before submit is an error, not a promise that resolves on nothing', () => {
    const { frame } = started();
    expect(() => frame.done).toThrow(/done read before submit/);
});

test('a reused frame does not hand out the previous frame`s completion', () => {
    const { backend } = recorder();
    const frame = createFrame({ ...backend, awaitCompletion: () => Promise.resolve() });

    beginFrame(frame);
    frame.submit();
    const first = frame.done;

    beginFrame(frame);
    frame.submit();
    expect(frame.done).not.toBe(first);
});

/** What the frame refuses once a pass, or the frame itself, is done. */
const fakeBundle = () => ({
    label: 'props',
    records: [],
    count: 0,
    version: 0,
    disposed: false,
    invalidate() {},
    dispose() {},
});

test('execute-after-end() throws, like draw does', () => {
    const { frame } = started();
    const pass = frame.pass({ target });
    pass.end();

    expect(() => pass.execute(fakeBundle())).toThrow(/execute after end\(\)/);
});

test('a compute pass refuses a dispatch after end()', () => {
    const { frame } = started();
    const pass = frame.compute();
    pass.end();

    expect(() => pass.dispatch({} as never, [1, 1, 1])).toThrow(/dispatch after end\(\)/);
});

test('a transform feedback pass refuses a dispatch after end()', () => {
    const { backend } = recorder('webgl');
    const frame = createFrame(backend);
    beginFrame(frame);
    const pass = frame.transformFeedback();
    pass.end();

    expect(() => pass.dispatch({} as never, {} as never)).toThrow(/dispatch after end\(\)/);
});

test('a closed frame names the verb it is refusing', () => {
    const { frame } = started();
    frame.submit();

    expect(() => frame.pass({ target })).toThrow(/pass\(\) after the frame was closed/);
    expect(() => frame.compute()).toThrow(/compute\(\) after the frame was closed/);
});
