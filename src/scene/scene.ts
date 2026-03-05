/**
 * scene.ts — Root of the 3D scene graph.
 */

import { Object3D } from './object3d';

export class Scene extends Object3D {
    background?: [number, number, number, number];

    constructor() {
        super();
        this.name = 'Scene';
    }
}
