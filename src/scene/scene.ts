import { Object3D } from '../core/object3d';

export class Scene extends Object3D {
    constructor() {
        super();
        this.name = 'Scene';
    }
}

/** The factory form; a `Scene` is the root `Object3D` a walk starts from. */
export function createScene(): Scene {
    return new Scene();
}
