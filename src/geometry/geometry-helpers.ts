import { createIndexBuffer, createVertexBuffer } from '../core/gpu-buffer';
import * as d from '../schema/schema';
import { Geometry } from './geometry';

const BOX_VERTEX_COUNT = 24; // 6 faces * 4 vertices
const BOX_INDEX_COUNT = 36; // 6 faces * 6 indices

function writeFace(
    positions: Float32Array,
    normals: Float32Array,
    uvs: Float32Array,
    indices: Uint16Array,
    faceIndex: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    dx: number,
    dy: number,
    dz: number,
    nx: number,
    ny: number,
    nz: number,
): void {
    const base = faceIndex * 4;
    const pi = base * 3;
    const ui = base * 2;
    const ii = faceIndex * 6;

    positions[pi] = ax;
    positions[pi + 1] = ay;
    positions[pi + 2] = az;
    positions[pi + 3] = bx;
    positions[pi + 4] = by;
    positions[pi + 5] = bz;
    positions[pi + 6] = cx;
    positions[pi + 7] = cy;
    positions[pi + 8] = cz;
    positions[pi + 9] = dx;
    positions[pi + 10] = dy;
    positions[pi + 11] = dz;

    normals[pi] = nx;
    normals[pi + 1] = ny;
    normals[pi + 2] = nz;
    normals[pi + 3] = nx;
    normals[pi + 4] = ny;
    normals[pi + 5] = nz;
    normals[pi + 6] = nx;
    normals[pi + 7] = ny;
    normals[pi + 8] = nz;
    normals[pi + 9] = nx;
    normals[pi + 10] = ny;
    normals[pi + 11] = nz;

    uvs[ui] = 0;
    uvs[ui + 1] = 0;
    uvs[ui + 2] = 1;
    uvs[ui + 3] = 0;
    uvs[ui + 4] = 1;
    uvs[ui + 5] = 1;
    uvs[ui + 6] = 0;
    uvs[ui + 7] = 1;

    indices[ii] = base;
    indices[ii + 1] = base + 1;
    indices[ii + 2] = base + 2;
    indices[ii + 3] = base;
    indices[ii + 4] = base + 2;
    indices[ii + 5] = base + 3;
}

export function createBoxGeometry(width = 1, height = 1, depth = 1): Geometry {
    const hw = width / 2;
    const hh = height / 2;
    const hd = depth / 2;

    const positions = new Float32Array(BOX_VERTEX_COUNT * 3);
    const normals = new Float32Array(BOX_VERTEX_COUNT * 3);
    const uvs = new Float32Array(BOX_VERTEX_COUNT * 2);
    const indices = new Uint16Array(BOX_INDEX_COUNT);

    // +X
    writeFace(positions, normals, uvs, indices, 0, hw, -hh, -hd, hw, hh, -hd, hw, hh, hd, hw, -hh, hd, 1, 0, 0);
    // -X
    writeFace(positions, normals, uvs, indices, 1, -hw, -hh, hd, -hw, hh, hd, -hw, hh, -hd, -hw, -hh, -hd, -1, 0, 0);
    // +Y
    writeFace(positions, normals, uvs, indices, 2, -hw, hh, -hd, -hw, hh, hd, hw, hh, hd, hw, hh, -hd, 0, 1, 0);
    // -Y
    writeFace(positions, normals, uvs, indices, 3, -hw, -hh, hd, -hw, -hh, -hd, hw, -hh, -hd, hw, -hh, hd, 0, -1, 0);
    // +Z
    writeFace(positions, normals, uvs, indices, 4, -hw, -hh, hd, hw, -hh, hd, hw, hh, hd, -hw, hh, hd, 0, 0, 1);
    // -Z
    writeFace(positions, normals, uvs, indices, 5, hw, -hh, -hd, -hw, -hh, -hd, -hw, hh, -hd, hw, hh, -hd, 0, 0, -1);

    const geom = new Geometry();
    geom.setBuffer('position', createVertexBuffer(d.vec3f, positions));
    geom.setBuffer('normal', createVertexBuffer(d.vec3f, normals));
    geom.setBuffer('uv', createVertexBuffer(d.vec2f, uvs));
    geom.setIndex(createIndexBuffer(indices));
    geom.boundingBox = [-hw, -hh, -hd, hw, hh, hd];
    geom.boundingSphere = { center: [0, 0, 0], radius: Math.sqrt(hw * hw + hh * hh + hd * hd) };
    return geom;
}

export function createSphereGeometry(radius = 0.5, widthSegments = 16, heightSegments = 8): Geometry {
    // Faithful port of three.js SphereGeometry (full sphere). Note the negated
    // X and `1 - v` UV, which match three exactly, and the pole-triangle skipping.
    widthSegments = Math.max(3, Math.floor(widthSegments));
    heightSegments = Math.max(2, Math.floor(heightSegments));

    const thetaEnd = Math.PI;

    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    const grid: number[][] = [];
    let index = 0;

    for (let iy = 0; iy <= heightSegments; iy++) {
        const verticesRow: number[] = [];
        const v = iy / heightSegments;

        // special-case the poles for a slightly better UV at the seam
        let uOffset = 0;
        if (iy === 0) uOffset = 0.5 / widthSegments;
        else if (iy === heightSegments) uOffset = -0.5 / widthSegments;

        for (let ix = 0; ix <= widthSegments; ix++) {
            const u = ix / widthSegments;

            const x = -radius * Math.cos(u * Math.PI * 2) * Math.sin(v * Math.PI);
            const y = radius * Math.cos(v * Math.PI);
            const z = radius * Math.sin(u * Math.PI * 2) * Math.sin(v * Math.PI);

            positions.push(x, y, z);

            const len = Math.hypot(x, y, z) || 1;
            normals.push(x / len, y / len, z / len);

            uvs.push(u + uOffset, 1 - v);

            verticesRow.push(index++);
        }
        grid.push(verticesRow);
    }

    for (let iy = 0; iy < heightSegments; iy++) {
        for (let ix = 0; ix < widthSegments; ix++) {
            const a = grid[iy][ix + 1];
            const b = grid[iy][ix];
            const c = grid[iy + 1][ix];
            const dd = grid[iy + 1][ix + 1];

            if (iy !== 0) indices.push(a, b, dd);
            if (iy !== heightSegments - 1 || thetaEnd < Math.PI) indices.push(b, c, dd);
        }
    }

    const geom = new Geometry();
    geom.setBuffer('position', createVertexBuffer(d.vec3f, new Float32Array(positions)));
    geom.setBuffer('normal', createVertexBuffer(d.vec3f, new Float32Array(normals)));
    geom.setBuffer('uv', createVertexBuffer(d.vec2f, new Float32Array(uvs)));
    geom.setIndex(createIndexBuffer(new Uint16Array(indices)));
    geom.boundingBox = [-radius, -radius, -radius, radius, radius, radius];
    geom.boundingSphere = { center: [0, 0, 0], radius };
    return geom;
}

/**
 * Creates a plane geometry in the XY plane (facing +Z).
 *
 * Vertices span [-width/2, width/2] in X and [-height/2, height/2] in Y, at z=0.
 * Normals point +Z. Triangles wound CCW when viewed from +Z.
 *
 * @param width - Total width along X. Defaults to 1.
 * @param height - Total height along Y. Defaults to 1.
 * @param widthSegments - Subdivisions along X. Defaults to 1.
 * @param heightSegments - Subdivisions along Y. Defaults to 1.
 */
export function createPlaneGeometry(width = 1, height = 1, widthSegments = 1, heightSegments = 1): Geometry {
    const hw = width / 2;
    const hh = height / 2;

    const cols = widthSegments + 1;
    const rows = heightSegments + 1;
    const vertexCount = cols * rows;

    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);

    // generate vertices top-to-bottom (iy=0 is top), left-to-right
    // y is negated so iy=0 → +hh (top), iy=max → -hh (bottom)
    for (let iy = 0; iy < rows; iy++) {
        const v = iy / heightSegments;
        const y = hh - v * height; // top to bottom
        for (let ix = 0; ix < cols; ix++) {
            const u = ix / widthSegments;
            const x = -hw + u * width;
            const idx = iy * cols + ix;
            positions[idx * 3 + 0] = x;
            positions[idx * 3 + 1] = y;
            positions[idx * 3 + 2] = 0;
            normals[idx * 3 + 0] = 0;
            normals[idx * 3 + 1] = 0;
            normals[idx * 3 + 2] = 1;
            uvs[idx * 2 + 0] = u;
            uvs[idx * 2 + 1] = v;
        }
    }

    // two triangles per quad, wound CCW when viewed from +Z
    const indexCount = widthSegments * heightSegments * 6;
    const indices = vertexCount <= 65536 ? new Uint16Array(indexCount) : new Uint32Array(indexCount);
    let i = 0;
    for (let iy = 0; iy < heightSegments; iy++) {
        for (let ix = 0; ix < widthSegments; ix++) {
            const a = iy * cols + ix; // top-left
            const b = a + cols; // bottom-left
            const c = b + 1; // bottom-right
            const d = a + 1; // top-right
            // CCW from +Z: a → b → d, then b → c → d
            indices[i++] = a;
            indices[i++] = b;
            indices[i++] = d;
            indices[i++] = b;
            indices[i++] = c;
            indices[i++] = d;
        }
    }

    const geom = new Geometry();
    geom.setBuffer('position', createVertexBuffer(d.vec3f, positions));
    geom.setBuffer('normal', createVertexBuffer(d.vec3f, normals));
    geom.setBuffer('uv', createVertexBuffer(d.vec2f, uvs));
    geom.setIndex(createIndexBuffer(indices as Uint16Array));
    geom.boundingBox = [-hw, -hh, 0, hw, hh, 0];
    geom.boundingSphere = {
        center: [0, 0, 0],
        radius: Math.sqrt(hw * hw + hh * hh),
    };
    return geom;
}

/**
 * Creates a fullscreen triangle geometry for post-processing passes.
 *
 * Uses an oversized triangle technique for efficiency (3 vertices instead of 6).
 * The triangle covers clip space from (-1,-1) to (3,-1) to (-1,3), ensuring
 * full viewport coverage after clipping.
 *
 * UV coordinates follow WebGPU conventions:
 *   - (0, 0) at top-left of texture
 *   - (1, 1) at bottom-right of texture
 *
 * Since clip space Y=-1 is bottom and Y=+1 is top, but texture V=0 is top and V=1 is bottom,
 * we map: bottom-left clip (-1,-1) → UV (0,1), top-left clip (-1,3) → UV (0,-1).
 *
 * @param flipY - Whether to flip UV coordinates along the vertical axis. Defaults to false.
 */
export function createFullscreenTriangleGeometry(flipY = false): Geometry {
    // Oversized triangle positions in clip space
    // vi=0 → (-1, -1)   vi=1 → (3, -1)   vi=2 → (-1, 3)
    const positions = new Float32Array([
        -1,
        -1,
        0, // bottom-left clip
        3,
        -1,
        0, // bottom-right clip (oversized)
        -1,
        3,
        0, // top-left clip (oversized)
    ]);

    // UV coordinates: map clip space to texture space
    // Clip Y=-1 (bottom) → texture V=1 (bottom)
    // Clip Y=+1 (top)    → texture V=0 (top)
    // Using oversized triangle, V goes from 1 to -1 (will be clipped to 0-1)
    const uvsData = flipY
        ? new Float32Array([0, -1, 2, -1, 0, 1]) // flipped
        : new Float32Array([0, 1, 2, 1, 0, -1]); // standard: bottom-left→(0,1), bottom-right→(2,1), top-left→(0,-1)

    const geom = new Geometry();
    geom.setBuffer('position', createVertexBuffer(d.vec3f, positions));
    geom.setBuffer('uv', createVertexBuffer(d.vec2f, uvsData));
    geom.drawRange.count = 3;
    return geom;
}

/**
 * Creates a cylinder geometry along the Y axis, centered at the origin.
 * When radiusTop is 0, produces a cone. Includes top and bottom caps.
 *
 * @param radiusTop - Radius at y = +height/2. 0 for a cone.
 * @param radiusBottom - Radius at y = -height/2.
 * @param height - Total height along Y.
 * @param radialSegments - Number of segments around the circumference.
 */
export function createCylinderGeometry(
    radiusTop = 1,
    radiusBottom = 1,
    height = 1,
    radialSegments = 8,
): Geometry {
    const halfHeight = height / 2;
    const hasTop = radiusTop > 0;
    const hasBottom = radiusBottom > 0;

    // body vertices: 2 rings of (radialSegments + 1) vertices (seam duplicated for UVs)
    const bodyCols = radialSegments + 1;
    const bodyVertexCount = bodyCols * 2;
    const bodyIndexCount = radialSegments * 6;

    // cap vertices: each cap has 1 center + (radialSegments + 1) ring vertices
    const capVerticesPerCap = 1 + bodyCols;
    const capIndicesPerCap = radialSegments * 3;
    const topCapVertexCount = hasTop ? capVerticesPerCap : 0;
    const bottomCapVertexCount = hasBottom ? capVerticesPerCap : 0;
    const topCapIndexCount = hasTop ? capIndicesPerCap : 0;
    const bottomCapIndexCount = hasBottom ? capIndicesPerCap : 0;

    const totalVertexCount = bodyVertexCount + topCapVertexCount + bottomCapVertexCount;
    const totalIndexCount = bodyIndexCount + topCapIndexCount + bottomCapIndexCount;

    const positions = new Float32Array(totalVertexCount * 3);
    const normals = new Float32Array(totalVertexCount * 3);
    const uvs = new Float32Array(totalVertexCount * 2);
    const indices = new Uint16Array(totalIndexCount);

    // slope for normals: the cylinder side normal has a Y component when radii differ
    const slope = (radiusBottom - radiusTop) / height;
    const normalScale = 1 / Math.sqrt(1 + slope * slope);

    let vi = 0;

    // --- body ---
    for (let ring = 0; ring < 2; ring++) {
        const y = ring === 0 ? halfHeight : -halfHeight;
        const r = ring === 0 ? radiusTop : radiusBottom;
        for (let seg = 0; seg <= radialSegments; seg++) {
            const u = seg / radialSegments;
            const theta = u * Math.PI * 2;
            const cosT = Math.cos(theta);
            const sinT = Math.sin(theta);

            const px = r * sinT;
            const pz = r * cosT;

            const pi = vi * 3;
            const ui = vi * 2;
            positions[pi] = px;
            positions[pi + 1] = y;
            positions[pi + 2] = pz;

            // normal points outward; adjust Y for cone slope
            normals[pi] = sinT * normalScale;
            normals[pi + 1] = slope * normalScale;
            normals[pi + 2] = cosT * normalScale;

            uvs[ui] = u;
            uvs[ui + 1] = ring === 0 ? 0 : 1;
            vi++;
        }
    }

    // body indices
    let ii = 0;
    for (let seg = 0; seg < radialSegments; seg++) {
        const a = seg;
        const b = seg + 1;
        const c = bodyCols + seg;
        const dd = bodyCols + seg + 1;
        indices[ii++] = a;
        indices[ii++] = c;
        indices[ii++] = b;
        indices[ii++] = b;
        indices[ii++] = c;
        indices[ii++] = dd;
    }

    // --- top cap ---
    if (hasTop) {
        const centerIndex = vi;
        const pi0 = vi * 3;
        const ui0 = vi * 2;
        positions[pi0] = 0;
        positions[pi0 + 1] = halfHeight;
        positions[pi0 + 2] = 0;
        normals[pi0] = 0;
        normals[pi0 + 1] = 1;
        normals[pi0 + 2] = 0;
        uvs[ui0] = 0.5;
        uvs[ui0 + 1] = 0.5;
        vi++;

        for (let seg = 0; seg <= radialSegments; seg++) {
            const u = seg / radialSegments;
            const theta = u * Math.PI * 2;
            const cosT = Math.cos(theta);
            const sinT = Math.sin(theta);

            const pi = vi * 3;
            const uii = vi * 2;
            positions[pi] = radiusTop * sinT;
            positions[pi + 1] = halfHeight;
            positions[pi + 2] = radiusTop * cosT;
            normals[pi] = 0;
            normals[pi + 1] = 1;
            normals[pi + 2] = 0;
            uvs[uii] = sinT * 0.5 + 0.5;
            uvs[uii + 1] = cosT * 0.5 + 0.5;
            vi++;
        }

        for (let seg = 0; seg < radialSegments; seg++) {
            indices[ii++] = centerIndex;
            indices[ii++] = centerIndex + 1 + seg;
            indices[ii++] = centerIndex + 1 + seg + 1;
        }
    }

    // --- bottom cap ---
    if (hasBottom) {
        const centerIndex = vi;
        const pi0 = vi * 3;
        const ui0 = vi * 2;
        positions[pi0] = 0;
        positions[pi0 + 1] = -halfHeight;
        positions[pi0 + 2] = 0;
        normals[pi0] = 0;
        normals[pi0 + 1] = -1;
        normals[pi0 + 2] = 0;
        uvs[ui0] = 0.5;
        uvs[ui0 + 1] = 0.5;
        vi++;

        for (let seg = 0; seg <= radialSegments; seg++) {
            const u = seg / radialSegments;
            const theta = u * Math.PI * 2;
            const cosT = Math.cos(theta);
            const sinT = Math.sin(theta);

            const pi = vi * 3;
            const uii = vi * 2;
            positions[pi] = radiusBottom * sinT;
            positions[pi + 1] = -halfHeight;
            positions[pi + 2] = radiusBottom * cosT;
            normals[pi] = 0;
            normals[pi + 1] = -1;
            normals[pi + 2] = 0;
            uvs[uii] = sinT * 0.5 + 0.5;
            uvs[uii + 1] = cosT * 0.5 + 0.5;
            vi++;
        }

        for (let seg = 0; seg < radialSegments; seg++) {
            indices[ii++] = centerIndex;
            indices[ii++] = centerIndex + 1 + seg + 1;
            indices[ii++] = centerIndex + 1 + seg;
        }
    }

    const maxR = Math.max(radiusTop, radiusBottom);
    const geom = new Geometry();
    geom.setBuffer('position', createVertexBuffer(d.vec3f, positions));
    geom.setBuffer('normal', createVertexBuffer(d.vec3f, normals));
    geom.setBuffer('uv', createVertexBuffer(d.vec2f, uvs));
    geom.setIndex(createIndexBuffer(indices));
    geom.boundingBox = [-maxR, -halfHeight, -maxR, maxR, halfHeight, maxR];
    geom.boundingSphere = { center: [0, 0, 0], radius: Math.sqrt(maxR * maxR + halfHeight * halfHeight) };
    return geom;
}

/**
 * Creates a torus geometry in the XZ plane.
 *
 * @param radius - Distance from center of torus to center of tube.
 * @param tube - Radius of the tube.
 * @param radialSegments - Segments around the tube cross-section.
 * @param tubularSegments - Segments around the torus ring.
 * @param arc - Central angle of the torus in radians. Defaults to full circle.
 */
export function createTorusGeometry(
    radius = 1,
    tube = 0.4,
    radialSegments = 12,
    tubularSegments = 48,
    arc = Math.PI * 2,
): Geometry {
    const radCols = radialSegments + 1;
    const tubCols = tubularSegments + 1;
    const vertexCount = radCols * tubCols;
    const indexCount = radialSegments * tubularSegments * 6;

    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvArr = new Float32Array(vertexCount * 2);
    const indices = new Uint16Array(indexCount);

    // Ring lies in XY plane, tube cross-section sweeps around Z.
    let vi = 0;
    for (let j = 0; j <= radialSegments; j++) {
        const v = (j / radialSegments) * Math.PI * 2;
        const cosV = Math.cos(v);
        const sinV = Math.sin(v);

        for (let i = 0; i <= tubularSegments; i++) {
            const u = (i / tubularSegments) * arc;
            const cosU = Math.cos(u);
            const sinU = Math.sin(u);

            const px = (radius + tube * cosV) * cosU;
            const py = (radius + tube * cosV) * sinU;
            const pz = tube * sinV;

            const cx = radius * cosU;
            const cy = radius * sinU;
            let nx = px - cx;
            let ny = py - cy;
            let nz = pz;
            const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
            nx /= nl;
            ny /= nl;
            nz /= nl;

            const pi = vi * 3;
            const ui = vi * 2;
            positions[pi] = px;
            positions[pi + 1] = py;
            positions[pi + 2] = pz;
            normals[pi] = nx;
            normals[pi + 1] = ny;
            normals[pi + 2] = nz;
            uvArr[ui] = i / tubularSegments;
            uvArr[ui + 1] = j / radialSegments;
            vi++;
        }
    }

    let ii = 0;
    for (let j = 1; j <= radialSegments; j++) {
        for (let i = 1; i <= tubularSegments; i++) {
            const a = tubCols * j + i - 1;
            const b = tubCols * (j - 1) + i - 1;
            const c = tubCols * (j - 1) + i;
            const dd = tubCols * j + i;
            indices[ii++] = a;
            indices[ii++] = b;
            indices[ii++] = dd;
            indices[ii++] = b;
            indices[ii++] = c;
            indices[ii++] = dd;
        }
    }

    const outerR = radius + tube;
    const geom = new Geometry();
    geom.setBuffer('position', createVertexBuffer(d.vec3f, positions));
    geom.setBuffer('normal', createVertexBuffer(d.vec3f, normals));
    geom.setBuffer('uv', createVertexBuffer(d.vec2f, uvArr));
    geom.setIndex(createIndexBuffer(indices));
    geom.boundingBox = [-outerR, -outerR, -tube, outerR, outerR, tube];
    geom.boundingSphere = { center: [0, 0, 0], radius: outerR };
    return geom;
}

/**
 * Creates an octahedron geometry (dual of cube).
 * At detail=0: 6 vertices, 8 triangular faces.
 * Higher detail subdivides each face recursively.
 *
 * @param radius - Circumscribed sphere radius.
 * @param detail - Subdivision level. 0 = base octahedron.
 */
export function createOctahedronGeometry(radius = 1, detail = 0): Geometry {
    // base octahedron vertices
    const baseVertices = [
         1,  0,  0,  -1,  0,  0,
         0,  1,  0,   0, -1,  0,
         0,  0,  1,   0,  0, -1,
    ];

    // base octahedron faces (indices into baseVertices, CCW from outside)
    const baseFaces = [
        0, 2, 4,  0, 4, 3,  0, 3, 5,  0, 5, 2,
        1, 4, 2,  1, 3, 4,  1, 5, 3,  1, 2, 5,
    ];

    // subdivide
    let verts = baseVertices.slice();
    let faces = baseFaces.slice();

    const midpointCache: Map<string, number> = new Map();

    function getMidpoint(a: number, b: number): number {
        const key = Math.min(a, b) + '_' + Math.max(a, b);
        const cached = midpointCache.get(key);
        if (cached !== undefined) return cached;

        const ax = verts[a * 3], ay = verts[a * 3 + 1], az = verts[a * 3 + 2];
        const bx = verts[b * 3], by = verts[b * 3 + 1], bz = verts[b * 3 + 2];
        let mx = (ax + bx) / 2;
        let my = (ay + by) / 2;
        let mz = (az + bz) / 2;

        // project onto unit sphere
        const len = Math.sqrt(mx * mx + my * my + mz * mz) || 1;
        mx /= len;
        my /= len;
        mz /= len;

        const idx = verts.length / 3;
        verts.push(mx, my, mz);
        midpointCache.set(key, idx);
        return idx;
    }

    for (let d = 0; d < detail; d++) {
        const newFaces: number[] = [];
        midpointCache.clear();
        for (let i = 0; i < faces.length; i += 3) {
            const a = faces[i], b = faces[i + 1], c = faces[i + 2];
            const ab = getMidpoint(a, b);
            const bc = getMidpoint(b, c);
            const ca = getMidpoint(c, a);
            newFaces.push(a, ab, ca);
            newFaces.push(b, bc, ab);
            newFaces.push(c, ca, bc);
            newFaces.push(ab, bc, ca);
        }
        faces = newFaces;
    }

    // build arrays, each face gets its own 3 vertices (flat shading normals)
    const faceCount = faces.length / 3;
    const vertexCount = faceCount * 3;
    const positions = new Float32Array(vertexCount * 3);
    const normalsArr = new Float32Array(vertexCount * 3);
    const uvsArr = new Float32Array(vertexCount * 2);
    const indexData = vertexCount <= 65536 ? new Uint16Array(vertexCount) : new Uint32Array(vertexCount);

    for (let f = 0; f < faceCount; f++) {
        const ia = faces[f * 3], ib = faces[f * 3 + 1], ic = faces[f * 3 + 2];

        const ax = verts[ia * 3] * radius, ay = verts[ia * 3 + 1] * radius, az = verts[ia * 3 + 2] * radius;
        const bx = verts[ib * 3] * radius, by = verts[ib * 3 + 1] * radius, bz = verts[ib * 3 + 2] * radius;
        const cx = verts[ic * 3] * radius, cy = verts[ic * 3 + 1] * radius, cz = verts[ic * 3 + 2] * radius;

        // face normal
        const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
        const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
        let nx = e1y * e2z - e1z * e2y;
        let ny = e1z * e2x - e1x * e2z;
        let nz = e1x * e2y - e1y * e2x;
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;

        const base = f * 3;
        for (let v = 0; v < 3; v++) {
            const idx = base + v;
            const vx = v === 0 ? ax : v === 1 ? bx : cx;
            const vy = v === 0 ? ay : v === 1 ? by : cy;
            const vz = v === 0 ? az : v === 1 ? bz : cz;

            positions[idx * 3] = vx;
            positions[idx * 3 + 1] = vy;
            positions[idx * 3 + 2] = vz;
            normalsArr[idx * 3] = nx;
            normalsArr[idx * 3 + 1] = ny;
            normalsArr[idx * 3 + 2] = nz;
            uvsArr[idx * 2] = v === 1 ? 1 : 0;
            uvsArr[idx * 2 + 1] = v === 2 ? 1 : 0;
            indexData[idx] = idx;
        }
    }

    const geom = new Geometry();
    geom.setBuffer('position', createVertexBuffer(d.vec3f, positions));
    geom.setBuffer('normal', createVertexBuffer(d.vec3f, normalsArr));
    geom.setBuffer('uv', createVertexBuffer(d.vec2f, uvsArr));
    geom.setIndex(createIndexBuffer(indexData as Uint16Array));
    geom.boundingBox = [-radius, -radius, -radius, radius, radius, radius];
    geom.boundingSphere = { center: [0, 0, 0], radius };
    return geom;
}
