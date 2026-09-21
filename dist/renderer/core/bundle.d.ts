import type { Mesh } from '../../objects/mesh';
import type { DrawOpts, RenderBundle } from './frame';
/** Records draws for replay. `finish()` hands back the bundle and closes recording. */
export type BundleEncoder = {
    draw(mesh: Mesh, opts?: DrawOpts): void;
    finish(): RenderBundle;
};
/**
 * Opens a bundle for recording. It takes no target: a bundle is replayed into whichever pass executes
 * it, and on WebGPU the attachment shape it must be built against is that pass's, not one named here.
 */
export declare function bundle(label?: string): BundleEncoder;
