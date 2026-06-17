import { Object3D } from '../core/object3d';
import type { Geometry } from '../geometry/geometry';
import type { Material } from '../material/material';
import { type Raycaster, type Intersection } from '../math/raycaster';
export declare class Mesh extends Object3D {
    readonly isMesh = true;
    geometry: Geometry;
    material: Material;
    count: number;
    frustumCulled: boolean;
    constructor(geometry: Geometry, material: Material);
    raycast(raycaster: Raycaster, intersects: Intersection[]): void;
}
