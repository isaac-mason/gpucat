import { Object3D } from './object3d';
import type { Geometry } from './geometry';
import type { Material } from './material';

export class Mesh extends Object3D {
    geometry: Geometry;
    material: Material;
    count: number = 1;

    constructor(geometry: Geometry, material: Material) {
        super();
        this.geometry = geometry;
        this.material = material;
    }
}
