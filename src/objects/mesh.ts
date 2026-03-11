import { Object3D } from '../core/object3d';
import type { Geometry } from '../geometry/geometry';
import type { Material } from '../material/material';

export class Mesh extends Object3D {
    geometry: Geometry;
    material: Material;
    count: number = 1;
    frustumCulled: boolean = true;

    constructor(geometry: Geometry, material: Material) {
        super();
        this.geometry = geometry;
        this.material = material;
    }
}
