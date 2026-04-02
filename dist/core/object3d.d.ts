import { type Quat, type Vec3 } from 'mathcat';
export declare class Object3D {
    readonly objectId: number;
    name: string;
    visible: boolean;
    renderOrder: number;
    position: Vec3;
    quaternion: Quat;
    scale: Vec3;
    parent: Object3D | null;
    children: Object3D[];
    matrix: import("mathcat").Mat4;
    matrixWorld: import("mathcat").Mat4;
    normalMatrix: import("mathcat").Mat3;
    matrixVersion: number;
    add(child: Object3D): this;
    remove(child: Object3D): this;
    removeFromParent(): this;
    lookAt(target: Vec3, up?: Vec3): void;
    updateWorldMatrix(): void;
    traverse(callback: (object: Object3D) => void): void;
    getWorldPosition(out: Vec3): Vec3;
    getWorldQuaternion(out: Quat): Quat;
    getWorldDirection(out: Vec3): Vec3;
    /**
     * Abstract method for raycasting. Override in subclasses (e.g., Mesh) to
     * implement intersection testing. Base implementation does nothing.
     *
     * @param _raycaster - The Raycaster instance
     * @param _intersects - Array to push intersection results into
     */
    raycast(_raycaster: any, _intersects: any[]): void;
}
