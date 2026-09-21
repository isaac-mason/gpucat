import type { Mesh } from '../../objects/mesh';
import type { DrawOptions, PassEntry, RenderBundle } from './frame';

/** Records draws for replay. `finish()` hands back the bundle and closes recording. */
export type BundleEncoder = {
    draw(mesh: Mesh, opts?: DrawOptions): void;
    finish(): RenderBundle;
};

/**
 * Opens a bundle for recording. It takes no target: a bundle is replayed into whichever pass executes
 * it, and on WebGPU the attachment shape it must be built against is that pass's, not one named here.
 */
export function bundle(label?: string): BundleEncoder {
    const records: PassEntry[] = [];
    let finished = false;
    let disposed = false;

    const built: RenderBundle = {
        label: label ?? 'bundle',
        records,
        get count() {
            return records.length;
        },
        version: 0,
        get disposed() {
            return disposed;
        },
        invalidate() {
            built.version++;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            records.length = 0;
            built.version++;
        },
    };

    return {
        draw(mesh, opts) {
            if (finished) throw new Error(`[bundle ${built.label}] draw after finish()`);
            records.push({ kind: 'draw', mesh, material: opts?.material ?? mesh.material, opts: opts ?? null });
        },
        finish() {
            finished = true;
            return built;
        },
    };
}
