import { Object3D } from '../core/object3d';
export declare class Scene extends Object3D {
    constructor();
}
/** The factory form; a `Scene` is the root `Object3D` a walk starts from. */
export declare function createScene(): Scene;
