import type { Object3D } from '../core/object3d';
import type { Pass } from '../renderer/core/frame';
import type { Renderer } from '../renderer/core/renderer';
import type { View } from '../renderer/core/view';
/** Frustum culled, opaque before transparent, each in its own bin, drawn through the public `pass.bin`. */
export declare function drawScene(renderer: Renderer, pass: Pass, scene: Object3D, camera: View): void;
