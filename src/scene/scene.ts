/**
 * scene.ts — Root of the 3D scene graph.
 */

import { Object3D } from './object3d.js';

export class Scene extends Object3D {
    /** Optional background clear color [r, g, b, a]. */
    background?: [number, number, number, number];

    constructor() {
        super();
        this.name = 'Scene';
    }

    /**
     * Recursively recompute world matrices for all objects in the scene.
     * Call once per frame before rendering.
     */
    updateWorldMatrices(): void {
        this._worldMatrix[0]  = 1; this._worldMatrix[1]  = 0; this._worldMatrix[2]  = 0; this._worldMatrix[3]  = 0;
        this._worldMatrix[4]  = 0; this._worldMatrix[5]  = 1; this._worldMatrix[6]  = 0; this._worldMatrix[7]  = 0;
        this._worldMatrix[8]  = 0; this._worldMatrix[9]  = 0; this._worldMatrix[10] = 1; this._worldMatrix[11] = 0;
        this._worldMatrix[12] = 0; this._worldMatrix[13] = 0; this._worldMatrix[14] = 0; this._worldMatrix[15] = 1;

        for (const child of this.children) {
            child.updateWorldMatrix();
        }
    }
}
