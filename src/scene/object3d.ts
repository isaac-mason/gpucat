/**
 * object3d.ts — Base 3D scene object with transform and hierarchy.
 *
 * Math delegated to mathcat (mat4, mat3, quat namespaces).
 * Matrices are column-major number[16] tuples (mathcat Mat4 / WebGPU convention).
 */

import { mat4, type Mat4, type Quat, type Vec3 } from 'mathcat';

// ---------------------------------------------------------------------------
// Object3D
// ---------------------------------------------------------------------------

let _objectIdCounter = 0;

export class Object3D {
    readonly objectId: number = _objectIdCounter++;

    name: string = '';

    position: Vec3 = [0, 0, 0];
    quaternion: Quat = [0, 0, 0, 1];
    scale: Vec3 = [1, 1, 1];

    parent: Object3D | null = null;
    readonly children: Object3D[] = [];

    /** Column-major Mat4 in local space (TRS). */
    _localMatrix: Mat4 = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    /** Column-major Mat4 in world space. */
    _worldMatrix: Mat4 = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];

    add(child: Object3D): this {
        if (child.parent) child.parent.remove(child);
        child.parent = this;
        this.children.push(child);
        return this;
    }

    remove(child: Object3D): this {
        const idx = this.children.indexOf(child);
        if (idx !== -1) {
            this.children.splice(idx, 1);
            child.parent = null;
        }
        return this;
    }

    /**
     * Recompute `_localMatrix` from position/quaternion/scale,
     * then `_worldMatrix` = parent._worldMatrix * _localMatrix.
     * Called top-down by Scene.updateWorldMatrices() — do not call directly.
     */
    updateWorldMatrix(): void {
        mat4.fromRotationTranslationScale(this._localMatrix, this.quaternion, this.position, this.scale);

        if (this.parent) {
            mat4.multiply(this._worldMatrix, this.parent._worldMatrix, this._localMatrix);
        } else {
            mat4.copy(this._localMatrix, this._worldMatrix);
        }

        for (const child of this.children) {
            child.updateWorldMatrix();
        }
    }
}
