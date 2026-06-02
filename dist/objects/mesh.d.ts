import { Object3D } from 'gpucat/dist/core/object3d';
import type { Geometry } from 'gpucat/dist/geometry/geometry';
import type { Material } from 'gpucat/dist/material/material';
import { type Raycaster, type Intersection } from 'gpucat/dist/math/raycaster';
export declare class Mesh extends Object3D {
    geometry: Geometry;
    material: Material;
    count: number;
    frustumCulled: boolean;
    constructor(geometry: Geometry, material: Material);
    raycast(raycaster: Raycaster, intersects: Intersection[]): void;
}
