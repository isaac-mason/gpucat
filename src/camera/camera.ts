import { mat4 } from 'mathcat';
import { Object3D } from '../core/object3d';

export class Camera extends Object3D {
    near = 0.1;
    far = 100;
    
    projectionMatrix = mat4.create();
    matrixWorldInverse = mat4.create();

    constructor() {
        super();
        this.name = 'Camera';
    }

    /** recompute the matrixWorldInverse from the current matrixWorld. */
    updateViewMatrix(): void {
        if (mat4.invert(this.matrixWorldInverse, this.matrixWorld) === null) {
            mat4.identity(this.matrixWorldInverse);
        }
    }
}


