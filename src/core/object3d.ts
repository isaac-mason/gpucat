import { mat4, mat3, quat, vec3, type Quat, type Vec3 } from 'mathcat';

let objectIdCounter = 0;

const _lookAt_tmp = mat4.create();

export class Object3D {
    readonly objectId: number = objectIdCounter++;

    name: string = '';

    visible: boolean = true;

    renderOrder: number = 0;

    position: Vec3 = [0, 0, 0];
    quaternion: Quat = [0, 0, 0, 1];
    scale: Vec3 = [1, 1, 1];

    parent: Object3D | null = null;
    children: Object3D[] = [];

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

	removeFromParent() {
		const parent = this.parent;
		if (parent !== null) {
			parent.remove(this);
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

    traverse(callback: (object: Object3D) => void): void {
        callback(this);
        for (const child of this.children) {
            child.traverse(callback);
        }
    }

    getWorldPosition(out: Vec3): Vec3 {
        return mat4.getTranslation(out, this.matrixWorld);
    }

    getWorldQuaternion(out: Quat): Quat {
        return mat4.getRotation(out, this.matrixWorld);
    }

    getWorldDirection(out: Vec3): Vec3 {
        const e = this.matrixWorld;
        out[0] = -e[8];
        out[1] = -e[9];
        out[2] = -e[10];
        vec3.normalize(out, out);
        return out;
    }

    /**
     * Abstract method for raycasting. Override in subclasses (e.g., Mesh) to
     * implement intersection testing. Base implementation does nothing.
     * 
     * @param _raycaster - The Raycaster instance
     * @param _intersects - Array to push intersection results into
     */
    raycast(_raycaster: any, _intersects: any[]): void {
        // Base Object3D does nothing - subclasses override
    }
}
