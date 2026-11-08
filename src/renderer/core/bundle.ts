import type { Mesh } from '../../objects/mesh';
import type { DrawOptions, PassEntry, RenderBundle } from './frame';
import type { View } from './view';

/** Records draws for replay. `finish()` hands back the bundle and closes recording. */
export type BundleEncoder = {
    draw(mesh: Mesh, opts?: DrawOptions): void;
    finish(): RenderBundle;
};

export type BundleOptions = {
    /** What its draws are drawn from, whatever camera the pass executing it has. Default none, as a pass without one. */
    camera?: View | null;
    /** Names the bundle in errors and on the device objects recorded from it. Default `'bundle'`. */
    label?: string;
};

/**
 * Opens a bundle for recording. It takes no target: on WebGPU it records at its first `execute`, against that pass's
 * attachment layout, and then executes in any pass of that layout.
 *
 * @example
 * const enc = bundle({ camera: lightCamera, label: 'light-view' });
 * enc.draw(casters);
 * const casterBundle = enc.finish();
 * pass.execute(casterBundle);
 */
export function bundle(opts: BundleOptions = {}): BundleEncoder {
    const records: PassEntry[] = [];
    let finished = false;
    let disposed = false;

    const built: RenderBundle = {
        label: opts.label ?? 'bundle',
        records,
        get count() {
            return records.length;
        },
        camera: opts.camera ?? null,
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
            built._onDispose?.();
            built._onDispose = null;
        },
        _onDispose: null,
    };

    return {
        draw(mesh, opts) {
            if (finished) throw new Error(`[bundle ${built.label}] draw after finish()`);
            const material = opts?.material ?? mesh.material;
            // the stencil reference is pass state: a WebGPU bundle encoder has no setStencilReference
            if (material.stencilTest && material.stencilRef !== 0) {
                throw new Error(
                    `[bundle ${built.label}] material '${material.name}' tests stencil against reference ` +
                        `${material.stencilRef}, which a bundle cannot set: draw it in the pass instead`,
                );
            }
            records.push({
                kind: 'draw',
                mesh,
                material,
                opts: opts ?? null,
                bin: null,
                sortKey: 0,
            });
        },
        finish() {
            finished = true;
            return built;
        },
    };
}
