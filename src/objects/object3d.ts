import { mat4, mat3, quat, type Quat, type Vec3 } from 'mathcat';

let objectIdCounter = 0;

const _lookAt_tmp = mat4.create();

export class Object3D {
    readonly objectId: number = objectIdCounter++;

    name: string = '';

    position: Vec3 = [0, 0, 0];
    quaternion: Quat = [0, 0, 0, 1];
    scale: Vec3 = [1, 1, 1];

    parent: Object3D | null = null;
    readonly children: Object3D[] = [];

    matrix = mat4.create();
    matrixWorld = mat4.create();
    normalMatrix = mat3.create();

    matrixVersion: number = 0;

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

    lookAt(target: Vec3, up: Vec3 = [0, 1, 0]): void {
        mat4.targetTo(_lookAt_tmp, this.position, target, up);
        quat.fromMat4(this.quaternion, _lookAt_tmp);
    }

    updateWorldMatrix(): void {
        mat4.fromRotationTranslationScale(this.matrix, this.quaternion, this.position, this.scale);

        if (this.parent) {
            mat4.multiply(this.matrixWorld, this.parent.matrixWorld, this.matrix);
        } else {
            mat4.copy(this.matrixWorld, this.matrix);
        }

        mat3.normalFromMat4(this.normalMatrix, this.matrixWorld);

        this.matrixVersion++;

        for (const child of this.children) {
            child.updateWorldMatrix();
        }
    }
}
