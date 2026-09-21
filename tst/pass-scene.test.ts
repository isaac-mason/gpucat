import { expect, test } from 'vitest';
import { createRenderTarget } from '../src/core/render-target';
import {
    type BackendName,
    beginFrame,
    createFrame,
    type DrawRecord,
    type FrameBackend,
    type PassDesc,
} from '../src/renderer/core/frame';

function recorder(name: BackendName = 'webgpu'): FrameBackend {
    return {
        name,
        deviceCanvasTarget: null,
        awaitCompletion: () => Promise.resolve(),
        beginFrame: () => {},
        encodePass: (_d: PassDesc, _r: readonly DrawRecord[], _c: number) => {},
        encodeComputePass: () => {},
        encodeTransformFeedbackPass: () => undefined,
        submitFrame: () => {},
        discardFrame: () => {},
    };
}

const target = createRenderTarget(8, 8);

/** `pass.scene()` is the tree walk as a verb on the pass, beside `draw` and `execute`. */
test('a frame opened without a renderer refuses scene(), naming what it needs', () => {
    const frame = createFrame(recorder());
    beginFrame(frame);
    const pass = frame.pass({ target });

    expect(() => pass.scene({} as never)).toThrow(/frame\(renderer\)/);
});

/** The camera comes from the pass unless one is handed in, so the common call takes a tree alone. */
test('scene() refuses a pass with no camera and no camera argument', () => {
    const frame = createFrame(recorder());
    beginFrame(frame);
    frame.renderer = {} as never;
    const pass = frame.pass({ target });

    expect(() => pass.scene({} as never)).toThrow(/needs a camera/);
});

test('draw, execute and scene are all verbs on the pass', () => {
    const frame = createFrame(recorder());
    beginFrame(frame);
    const pass = frame.pass({ target });

    expect(typeof pass.draw).toBe('function');
    expect(typeof pass.execute).toBe('function');
    expect(typeof pass.scene).toBe('function');
});
