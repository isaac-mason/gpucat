import type { Mesh } from '../../objects/mesh';
import type { DrawOptions, RenderBundle } from './frame';
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
export declare function bundle(opts?: BundleOptions): BundleEncoder;
