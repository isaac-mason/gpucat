import type { Mat4 } from 'math';
import type { CoordinateSystem } from '../../core/coordinate-system';

/**
 * What core needs from a camera: matrices, depth range, and the clip-space convention its projection
 * was built for. `Camera` and its subclasses satisfy this structurally.
 *
 * Core takes a `View` rather than a `Camera` so the render path does not reach into `Object3D`, which
 * `Camera` extends. The scene tree stays a layer above; anything that can produce these six values can
 * drive a pass.
 */
export type View = {
    projectionMatrix: Mat4;
    /** World-to-camera. */
    matrixWorldInverse: Mat4;
    /** Camera-to-world. Read for world position rather than a `position` property, which is parent-relative. */
    matrixWorld: Mat4;
    near: number;
    far: number;
    coordinateSystem: CoordinateSystem;
    /**
     * Rebuilds `projectionMatrix` for the current `coordinateSystem`. A pass calls it when its backend's
     * clip convention differs, so one camera can drive both. A view without it is the caller's to keep
     * consistent.
     */
    updateProjectionMatrix?(): void;
};
