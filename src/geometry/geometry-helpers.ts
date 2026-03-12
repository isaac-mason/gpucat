import { createIndexBuffer, createVertexBuffer } from '../core/buffer';
import * as d from '../nodes/schema';
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
    geom.index = createIndexBuffer(indices);
    geom.boundingBox = [-hw, -hh, -hd, hw, hh, hd];
    geom.boundingSphere = { center: [0, 0, 0], radius: Math.sqrt(hw * hw + hh * hh + hd * hd) };
    return geom;
}

export function createSphereGeometry(radius = 0.5, widthSegments = 16, heightSegments = 8): Geometry {
    const cols = widthSegments + 1;
    const rows = heightSegments + 1;
    const vertexCount = cols * rows;
    const indexCount = widthSegments * heightSegments * 6;

    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const indices = new Uint16Array(indexCount);

    let vi = 0;
    for (let iy = 0; iy < rows; iy++) {
        const v = iy / heightSegments;
        const phi = v * Math.PI;
        const sinPhi = Math.sin(phi);
        const cosPhi = Math.cos(phi);
        for (let ix = 0; ix < cols; ix++) {
            const u = ix / widthSegments;
            const theta = u * Math.PI * 2;
            const nx = Math.cos(theta) * sinPhi;
            const ny = cosPhi;
            const nz = Math.sin(theta) * sinPhi;

            const pi = vi * 3;
            const ui = vi * 2;
            positions[pi] = nx * radius;
            positions[pi + 1] = ny * radius;
            positions[pi + 2] = nz * radius;
            normals[pi] = nx;
            normals[pi + 1] = ny;
            normals[pi + 2] = nz;
            uvs[ui] = u;
            uvs[ui + 1] = v;
            vi++;
        }
    }

    let ii = 0;
    for (let iy = 0; iy < heightSegments; iy++) {
        for (let ix = 0; ix < widthSegments; ix++) {
            const a = iy * cols + ix;
            const b = a + cols;
            // CCW winding when viewed from outside the sphere
            indices[ii] = a;
            indices[ii + 1] = a + 1;
            indices[ii + 2] = b;
            indices[ii + 3] = b;
            indices[ii + 4] = a + 1;
            indices[ii + 5] = b + 1;
            ii += 6;
        }
    }

    const geom = new Geometry();
    geom.setBuffer('position', createVertexBuffer(d.vec3f, positions));
    geom.setBuffer('normal', createVertexBuffer(d.vec3f, normals));
    geom.setBuffer('uv', createVertexBuffer(d.vec2f, uvs));
    geom.index = createIndexBuffer(indices);
    geom.boundingBox = [-radius, -radius, -radius, radius, radius, radius];
    geom.boundingSphere = { center: [0, 0, 0], radius };
    return geom;
}

/**
 * Creates a plane geometry in the XY plane (facing +Z).
 *
 * Vertices span [-width/2, width/2] in X and [-height/2, height/2] in Y, at z=0.
 * Normals point +Z. Triangles wound CCW when viewed from +Z.
 * Matches three.js PlaneGeometry orientation.
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
    geom.index = createIndexBuffer(indices as Uint16Array);
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
