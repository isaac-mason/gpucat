# Plan: Raycasting for Object3D / Mesh

## Overview

Add raycasting support for editor interaction (picking, selection, hover detection). Direct inspiration from three.js's approach, adapted to gpucat's architecture and mathcat primitives.

## Design

### Core Components

#### 1. `Raycaster` class (`src/math/raycaster.ts`)

Following three.js closely:

```ts
import { raycast3, type Raycast3, type Vec3 } from 'mathcat';
import type { Object3D } from '../core/object3d';
import type { Camera } from '../camera/camera';

export type Intersection = {
    distance: number;
    point: Vec3;
    object: Object3D;
    faceIndex?: number;
    face?: { a: number; b: number; c: number; normal: Vec3 };
    uv?: [number, number];
    normal?: Vec3;
};

export class Raycaster {
    ray: Raycast3;
    near: number = 0;
    far: number = Infinity;
    camera: Camera | null = null;

    constructor(origin?: Vec3, direction?: Vec3, near?: number, far?: number);
    
    set(origin: Vec3, direction: Vec3): void;
    setFromCamera(coords: [number, number], camera: Camera): void;
    
    intersectObject(object: Object3D, recursive?: boolean, intersects?: Intersection[]): Intersection[];
    intersectObjects(objects: Object3D[], recursive?: boolean, intersects?: Intersection[]): Intersection[];
}
```

**Key methods:**

- `set(origin, direction)` - Set ray directly
- `setFromCamera(coords, camera)` - Create ray from NDC coords + camera (perspective/ortho)
- `intersectObject(object, recursive, intersects)` - Test single object (+ children if recursive)
- `intersectObjects(objects, recursive, intersects)` - Test multiple objects

#### 2. `Object3D.raycast()` method (`src/core/object3d.ts`)

Base implementation is a no-op (matching three.js):

```ts
raycast(raycaster: Raycaster, intersects: Intersection[]): void {
    // Base Object3D does nothing - subclasses override
}
```

#### 3. `Mesh.raycast()` override (`src/objects/mesh.ts`)

Full triangle intersection following three.js:

```ts
raycast(raycaster: Raycaster, intersects: Intersection[]): void {
    const geometry = this.geometry;
    const matrixWorld = this.matrixWorld;

    // 1. Early-out: bounding sphere test (if available)
    if (geometry.boundingSphere) {
        // Transform sphere to world space, test against ray
        // Early return if no intersection
    }

    // 2. Transform ray to local space
    const inverseMatrix = mat4.invert(mat4.create(), matrixWorld);
    const localRay = raycast3.create();
    // Transform ray origin and direction by inverse matrix

    // 3. Early-out: bounding box test (if available)
    if (geometry.boundingBox) {
        if (!raycast3.intersectsBox3(localRay, geometry.boundingBox)) return;
    }

    // 4. Triangle intersection tests (double-sided by default)
    this._computeIntersections(raycaster, intersects, localRay);
}
```

**Triangle intersection logic:**

- Get position buffer from `geometry.buffers.get('position')`
- Get optional index buffer from `geometry.index`
- Iterate triangles using `raycast3.intersectsTriangle()` with `backfaceCulling: false` (double-sided)
- For hits: compute world-space point, check near/far, build Intersection object
- Optionally compute UV coords via barycentric interpolation (if uv buffer exists)

### Data Flow

```
User Event (mouse)
    ↓
NDC coords [-1, 1]
    ↓
raycaster.setFromCamera(coords, camera)
    ↓
raycaster.intersectObjects(scene.children, true)
    ↓
For each object:
    - Call object.raycast(raycaster, intersects)
    ↓
Sort intersects by distance
    ↓
Return Intersection[]
```

### Implementation Details

#### Accessing Geometry Data for CPU-side Raycasting

**Problem:** `GpuBuffer` data may only exist on GPU. Need CPU-side vertex data.

**Solution:** `GpuBuffer` already stores the source data. Check implementation:
- If `GpuBuffer` has `data` property accessible, read from it
- This is for editor use - acceptable to require CPU-side data for raycasting

```ts
// In Mesh.raycast, accessing position data:
const positionBuffer = geometry.getBuffer('position');
if (!positionBuffer?.data) return; // Can't raycast without CPU data

const positions = positionBuffer.data as Float32Array;
```

#### Ray Transformation to Local Space

Using mathcat's mat4 utilities:

```ts
// Transform ray to object's local space
const invMatrix = mat4.create();
mat4.invert(invMatrix, this.matrixWorld);

// Transform origin
const localOrigin: Vec3 = [0, 0, 0];
vec3.transformMat4(localOrigin, raycaster.ray.origin, invMatrix);

// Transform direction (as vector, not point)
const localDir: Vec3 = [0, 0, 0];
vec3.transformMat4Direction(localDir, raycaster.ray.direction, invMatrix);
vec3.normalize(localDir, localDir);

// Create local ray
const localRay = raycast3.fromValues(localOrigin, localDir, raycaster.ray.length);
```

#### setFromCamera Implementation

**Perspective camera:**
```ts
// Origin at camera position
vec3.copy(this.ray.origin, camera.position);
// Direction: unproject NDC point and normalize
const target = camera.unproject([coords[0], coords[1], 0.5]);
vec3.sub(this.ray.direction, target, this.ray.origin);
vec3.normalize(this.ray.direction, this.ray.direction);
```

**Orthographic camera:**
```ts
// Origin: unproject NDC point onto near plane
this.ray.origin = camera.unproject([coords[0], coords[1], -1]);
// Direction: camera's forward direction
vec3.set(this.ray.direction, 0, 0, -1);
vec3.transformMat4Direction(this.ray.direction, this.ray.direction, camera.matrixWorld);
```

#### Camera.unproject() method

Add to Camera class:

```ts
unproject(out: Vec3, ndc: Vec3): Vec3 {
    const invViewProj = mat4.create();
    mat4.multiply(invViewProj, this.projectionMatrix, this.matrixWorldInverse);
    mat4.invert(invViewProj, invViewProj);
    
    vec3.transformMat4(out, ndc, invViewProj);
    return out;
}
```

### File Structure

```
src/
├── math/
│   └── raycaster.ts          # New: Raycaster class
├── core/
│   └── object3d.ts           # Add: raycast() stub method
├── objects/
│   └── mesh.ts               # Add: raycast() implementation
├── camera/
│   └── camera.ts             # Add: unproject() method
└── index.ts                  # Export Raycaster, Intersection
```

### API Usage Example

```ts
import { Raycaster, type Intersection } from 'gpucat';

const raycaster = new Raycaster();

canvas.addEventListener('click', (event) => {
    // Convert mouse to NDC
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera([x, y], camera);
    
    const intersects = raycaster.intersectObjects(scene.children, true);
    
    if (intersects.length > 0) {
        const hit = intersects[0];
        console.log('Hit:', hit.object.name, 'at distance:', hit.distance);
    }
});
```

## Tasks

1. **Add `unproject()` method to Camera** - Unproject NDC to world space
2. **Create `src/math/raycaster.ts`** - Raycaster class with full API
3. **Add `raycast()` to Object3D** - Empty base implementation  
4. **Add `raycast()` to Mesh** - Full triangle intersection (double-sided default)
5. **Export from index.ts** - Raycaster and Intersection type

## Decisions

1. **Backface culling** - Default to double-sided (no backface culling). Not adding to Material.

2. **Instancing (mesh.count > 1)** - Not supported in base implementation. Users can patch or extend Mesh with custom raycast() for advanced cases.

3. **unproject location** - On Camera class as `camera.unproject(out, ndc)`

4. **Layers** - Not adding. Skip for now, add later if needed.

## Non-Goals

- BVH acceleration (use crashcat for physics)
- GPU-based raycasting
- Octree/spatial structures
- Instanced mesh raycasting
- Morph target support
- Lines/Points/Sprites (Mesh only for now)

## Dependencies

- `mathcat`: `raycast3`, `mat4`, `vec3` modules (all available)
- No new dependencies needed
