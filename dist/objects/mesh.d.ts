import { Object3D } from '../core/object3d';
import type { Geometry } from '../geometry/geometry';
import type { Material } from '../material/material';
export declare class Mesh extends Object3D {
    geometry: Geometry;
    material: Material;
    count: number;
    frustumCulled: boolean;
    constructor(geometry: Geometry, material: Material);
}
