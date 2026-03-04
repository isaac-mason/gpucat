import { Object3D } from './object3d.js';
import type { Geometry } from './geometry.js';
import type { Material } from './material.js';

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
