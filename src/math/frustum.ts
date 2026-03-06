import { mat4, plane3, type Mat4, type Box3, type Sphere, type Plane3 } from 'mathcat';

export type Frustum = [Plane3, Plane3, Plane3, Plane3, Plane3, Plane3];

export function create(): Frustum {
    return [
        plane3.create(),
        plane3.create(),
        plane3.create(),
        plane3.create(),
        plane3.create(),
        plane3.create(),
    ];
}

export function clone(f: Frustum): Frustum {
    return [
        plane3.clone(f[0]),
        plane3.clone(f[1]),
        plane3.clone(f[2]),
        plane3.clone(f[3]),
        plane3.clone(f[4]),
        plane3.clone(f[5]),
    ];
}

export function copy(out: Frustum, f: Frustum): Frustum {
    plane3.copy(out[0], f[0]);
    plane3.copy(out[1], f[1]);
    plane3.copy(out[2], f[2]);
    plane3.copy(out[3], f[3]);
    plane3.copy(out[4], f[4]);
    plane3.copy(out[5], f[5]);
    return out;
}

export function setFromViewProjectionMatrix(out: Frustum, proj: Mat4, view: Mat4): Frustum {
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const m = vp;

    setPlane(out[0], m[0] + m[3], m[4] + m[7], m[8] + m[11], m[12] + m[15]);
    setPlane(out[1], -m[0] + m[3], -m[4] + m[7], -m[8] + m[11], -m[12] + m[15]);
    setPlane(out[2], m[1] + m[3], m[5] + m[7], m[9] + m[11], m[13] + m[15]);
    setPlane(out[3], -m[1] + m[3], -m[5] + m[7], -m[9] + m[11], -m[13] + m[15]);
    setPlane(out[4], m[2], m[6], m[10], m[14]);
    setPlane(out[5], -m[2] + m[3], -m[6] + m[7], -m[10] + m[11], -m[14] + m[15]);

    for (let i = 0; i < 6; i++) {
        plane3.normalize(out[i], out[i]);
    }

    return out;
}

export function intersectsSphere(f: Frustum, s: Sphere): boolean {
    const { center, radius } = s;
    for (let i = 0; i < 6; i++) {
        if (plane3.distanceToPoint(f[i], center) < -radius) {
            return false;
        }
    }
    return true;
}

export function intersectsBox3(f: Frustum, box: Box3): boolean {
    const [minX, minY, minZ, maxX, maxY, maxZ] = box;
    for (let i = 0; i < 6; i++) {
        const p = f[i];
        const nx = p.normal[0];
        const ny = p.normal[1];
        const nz = p.normal[2];

        const px = nx >= 0 ? maxX : minX;
        const py = ny >= 0 ? maxY : minY;
        const pz = nz >= 0 ? maxZ : minZ;

        if (nx * px + ny * py + nz * pz + p.constant < 0) {
            return false;
        }
    }
    return true;
}

function setPlane(out: Plane3, nx: number, ny: number, nz: number, d: number): void {
    out.normal[0] = nx;
    out.normal[1] = ny;
    out.normal[2] = nz;
    out.constant = d;
}
