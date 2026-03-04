/**
 * frustum.ts — CPU-side frustum built from a combined view-projection matrix.
 *
 * Usage:
 *   const frustum = new Frustum();
 *   frustum.setFromViewProjectionMatrix(camera.projectionMatrix, camera._viewMatrix);
 *
 *   if (frustum.intersectsSphere(worldSphere)) { ... }
 *   if (frustum.intersectsBox3(worldBox))      { ... }
 *
 * The six frustum planes are extracted using the standard Gribb/Hartmann method.
 * Because mathcat uses WebGPU-style clip space (Z in [0, 1]), the near plane row
 * is taken from row 3 directly (not row3 + row3_z as in the OpenGL [-1,1] variant).
 *
 * All bounding-volume tests are done in **world space**, so callers must transform
 * local-space volumes by the mesh world matrix before testing.
 */

import { mat4, plane3, type Mat4, type Box3, type Sphere, type Plane3 } from 'mathcat';

// ---------------------------------------------------------------------------
// Frustum
// ---------------------------------------------------------------------------

export class Frustum {
    /**
     * The six clip planes in world space.
     * Order: left, right, bottom, top, near, far.
     * After setFromViewProjectionMatrix() each plane is normalised so that
     * distanceToPoint() returns a true metric distance.
     */
    readonly planes: [Plane3, Plane3, Plane3, Plane3, Plane3, Plane3] = [
        plane3.create(),
        plane3.create(),
        plane3.create(),
        plane3.create(),
        plane3.create(),
        plane3.create(),
    ];

    /** Scratch VP matrix — reused every call to avoid allocation. */
    private readonly _vp: Mat4 = mat4.create();

    // -----------------------------------------------------------------------
    // setFromViewProjectionMatrix
    // -----------------------------------------------------------------------

    /**
     * Extract the six frustum planes from the combined view-projection matrix.
     *
     * The caller passes `projectionMatrix` and `viewMatrix` separately; this
     * method multiplies them internally so neither source matrix is mutated.
     *
     * The extraction follows Gribb & Hartmann (2001) adapted for column-major
     * storage and WebGPU clip-Z in [0, 1]:
     *
     *   left   = col3 + col0
     *   right  = col3 - col0
     *   bottom = col3 + col1
     *   top    = col3 - col1
     *   near   = col2              (WebGPU: near z-clip is 0, not -1)
     *   far    = col3 - col2
     *
     * Each plane is normalised so distances are in world units.
     *
     * @param proj  Camera projection matrix (column-major Mat4)
     * @param view  Camera view matrix (column-major Mat4)
     */
    setFromViewProjectionMatrix(proj: Mat4, view: Mat4): void {
        // VP = proj * view  (mathcat mat4 is column-major; multiply(out, a, b) = a*b)
        mat4.multiply(this._vp, proj, view);
        const m = this._vp;

        // Column-major indexing:
        //   col 0: m[0], m[1], m[2],  m[3]
        //   col 1: m[4], m[5], m[6],  m[7]
        //   col 2: m[8], m[9], m[10], m[11]
        //   col 3: m[12],m[13],m[14], m[15]
        //
        // A clip-space point p is inside the frustum when:
        //   -w <= x <= w  →  (col3 + col0) · p >= 0  and  (col3 - col0) · p >= 0
        //   -w <= y <= w  →  (col3 + col1) · p >= 0  and  (col3 - col1) · p >= 0
        //    0 <= z <= w  →  (col2)        · p >= 0  and  (col3 - col2) · p >= 0

        setPlane(this.planes[0], m[0]+m[3],  m[4]+m[7],  m[8]+m[11],  m[12]+m[15]);  // left
        setPlane(this.planes[1], -m[0]+m[3], -m[4]+m[7], -m[8]+m[11], -m[12]+m[15]); // right
        setPlane(this.planes[2], m[1]+m[3],  m[5]+m[7],  m[9]+m[11],  m[13]+m[15]);  // bottom
        setPlane(this.planes[3], -m[1]+m[3], -m[5]+m[7], -m[9]+m[11], -m[13]+m[15]); // top
        setPlane(this.planes[4], m[2],        m[6],        m[10],        m[14]);        // near (Z≥0)
        setPlane(this.planes[5], -m[2]+m[3], -m[6]+m[7], -m[10]+m[11], -m[14]+m[15]); // far

        for (const p of this.planes) {
            plane3.normalize(p, p);
        }
    }

    // -----------------------------------------------------------------------
    // intersectsSphere — world-space sphere vs frustum
    // -----------------------------------------------------------------------

    /**
     * Returns true if the world-space sphere is at least partially inside
     * (or intersecting) the frustum.
     *
     * A sphere is fully outside if its centre is more than `radius` units
     * behind any single frustum plane.
     */
    intersectsSphere(s: Sphere): boolean {
        const { center, radius } = s;
        for (const p of this.planes) {
            // distanceToPoint = dot(normal, center) + constant
            // Positive = in front of plane, negative = behind
            if (plane3.distanceToPoint(p, center) < -radius) {
                return false; // entirely outside this plane
            }
        }
        return true;
    }

    // -----------------------------------------------------------------------
    // intersectsBox3 — world-space AABB vs frustum
    // -----------------------------------------------------------------------

    /**
     * Returns true if the world-space axis-aligned bounding box is at least
     * partially inside (or intersecting) the frustum.
     *
     * Uses the p-vertex test: for each plane we pick the corner of the box
     * that is most in the direction of the plane normal. If even that corner
     * is behind the plane, the whole box is outside.
     */
    intersectsBox3(box: Box3): boolean {
        const [minX, minY, minZ, maxX, maxY, maxZ] = box;
        for (const p of this.planes) {
            const nx = p.normal[0];
            const ny = p.normal[1];
            const nz = p.normal[2];

            // p-vertex: the corner most in the direction of the plane normal
            const px = nx >= 0 ? maxX : minX;
            const py = ny >= 0 ? maxY : minY;
            const pz = nz >= 0 ? maxZ : minZ;

            if (nx * px + ny * py + nz * pz + p.constant < 0) {
                return false; // p-vertex is behind this plane → box is fully outside
            }
        }
        return true;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Set a Plane3 from the four raw coefficients (nx, ny, nz, d) where the
 * plane equation is:  nx·x + ny·y + nz·z + d >= 0  for points on the
 * positive side.
 *
 * We store this as  normal = (nx, ny, nz)  and  constant = d,
 * matching mathcat's Plane3 convention where
 *   distanceToPoint(p, pt) = dot(p.normal, pt) + p.constant
 */
function setPlane(out: Plane3, nx: number, ny: number, nz: number, d: number): void {
    out.normal[0] = nx;
    out.normal[1] = ny;
    out.normal[2] = nz;
    out.constant  = d;
}

