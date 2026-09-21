import type { Object3D } from '../core/object3d';
import type { Pass } from '../renderer/core/frame';
import type { Renderer } from '../renderer/core/renderer';
import type { View } from '../renderer/core/view';
/** Frustum culled, in render order, opaque before transparent, drawn through the public `pass.draw`. */
export declare function drawScene(renderer: Renderer, pass: Pass, scene: Object3D, camera: View): void;
