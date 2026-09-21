import { expect, test } from 'vitest';
import { createCanvasTarget } from '../src/renderer/core/canvas-target';

function canvas(width = 100, height = 50): HTMLCanvasElement {
    return { width, height } as HTMLCanvasElement;
}

test('bundle config defaults and overrides', () => {
    const def = createCanvasTarget(canvas());
    expect(def.depthFormat).toBe('depth24plus');
    expect(def.samples).toBe(1);
    expect(def.alphaMode).toBe('opaque');

    const custom = createCanvasTarget(canvas(), { depthFormat: 'depth24plus-stencil8', samples: 4, alphaMode: 'premultiplied' });
    expect(custom.depthFormat).toBe('depth24plus-stencil8');
    expect(custom.samples).toBe(4);
    expect(custom.alphaMode).toBe('premultiplied');
});

test('dpr clamps a forwarded ratio, and a number pins it', () => {
    const clamped = createCanvasTarget(canvas(), { dpr: [1, 2] });
    clamped.setPixelRatio(3);
    expect(clamped.getPixelRatio()).toBe(2);
    clamped.setPixelRatio(0.5);
    expect(clamped.getPixelRatio()).toBe(1);
    clamped.setPixelRatio(1.5);
    expect(clamped.getPixelRatio()).toBe(1.5);

    const pinned = createCanvasTarget(canvas(), { dpr: 2 });
    expect(pinned.getPixelRatio()).toBe(2);
    pinned.setPixelRatio(3);
    expect(pinned.getPixelRatio()).toBe(2);

    const unclamped = createCanvasTarget(canvas());
    unclamped.setPixelRatio(3);
    expect(unclamped.getPixelRatio()).toBe(3);
});

test('onResize fires on subscribe, on change, and stops after unsubscribe', () => {
    const target = createCanvasTarget(canvas(100, 50));
    const seen: [number, number, number][] = [];

    const off = target.onResize((e) => seen.push([e.width, e.height, e.pixelRatio]));
    expect(seen).toEqual([[100, 50, 1]]);

    target.setSize(200, 100, false);
    expect(seen[1]).toEqual([200, 100, 1]);

    target.setPixelRatio(2);
    expect(seen[2]).toEqual([400, 200, 2]);

    // A ratio that does not change the value must not fire.
    target.setPixelRatio(2);
    expect(seen).toHaveLength(3);

    off();
    target.setSize(10, 10, false);
    expect(seen).toHaveLength(3);
});

test('a derived target can follow the canvas through onResize', () => {
    const target = createCanvasTarget(canvas(100, 50), { dpr: [1, 2] });
    const derived = { width: 0, height: 0 };

    target.onResize((e) => {
        derived.width = Math.floor(e.width * 0.5);
        derived.height = Math.floor(e.height * 0.5);
    });
    expect(derived).toEqual({ width: 50, height: 25 });

    target.setPixelRatio(2);
    expect(derived).toEqual({ width: 100, height: 50 });
});

test('autoResize defaults on for a DOM canvas and off for an OffscreenCanvas', () => {
    const dom = createCanvasTarget({ width: 8, height: 8, clientWidth: 8, clientHeight: 8 } as HTMLCanvasElement);
    expect(dom.autoResize).toBe(true);

    const offscreen = createCanvasTarget({ width: 8, height: 8 } as unknown as OffscreenCanvas);
    expect(offscreen.autoResize).toBe(false);
});

test('syncToClientSize follows the layout without writing CSS back', () => {
    const canvas = { width: 8, height: 8, clientWidth: 8, clientHeight: 8, style: {} } as unknown as HTMLCanvasElement;
    const target = createCanvasTarget(canvas);
    target.setPixelRatio(2);

    const styleBefore = canvas.style.width;
    (canvas as unknown as { clientWidth: number }).clientWidth = 400;
    (canvas as unknown as { clientHeight: number }).clientHeight = 300;
    target.syncToClientSize();

    expect(target.getDrawingBufferSize()).toEqual({ width: 800, height: 600 });
    // CSS is what it read; writing it back would fight the layout that produced it.
    expect(canvas.style.width).toBe(styleBefore);
});

test('syncToClientSize is a no-op when the layout has not changed', () => {
    const canvas = { width: 8, height: 8, clientWidth: 8, clientHeight: 8, style: {} } as unknown as HTMLCanvasElement;
    const target = createCanvasTarget(canvas);
    let resizes = 0;
    target.onResize(() => {
        resizes++;
    });

    target.syncToClientSize();
    target.syncToClientSize();

    expect(resizes).toBe(1); // the immediate fire on subscribe, and nothing after
});
