import { createVertexBuffer } from '../core/buffer';
import * as d from '../nodes/schema';
import { createIndexBuffer, Geometry } from './geometry';

export function createBoxGeometry(width = 1, height = 1, depth = 1): Geometry {
    const hw = width / 2;
    const hh = height / 2;
    const hd = depth / 2;

    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    function face(
        ax: number, ay: number, az: number,
        bx: number, by: number, bz: number,
        cx: number, cy: number, cz: number,
        dx: number, dy: number, dz: number,
        nx: number, ny: number, nz: number
    ): void {
        const base = positions.length / 3;
        positions.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
        normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
        uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }

    // +X
    face(hw, -hh, -hd, hw, hh, -hd, hw, hh, hd, hw, -hh, hd, 1, 0, 0);
    // -X
    face(-hw, -hh, hd, -hw, hh, hd, -hw, hh, -hd, -hw, -hh, -hd, -1, 0, 0);
    // +Y
    face(-hw, hh, -hd, -hw, hh, hd, hw, hh, hd, hw, hh, -hd, 0, 1, 0);
    // -Y
    face(-hw, -hh, hd, -hw, -hh, -hd, hw, -hh, -hd, hw, -hh, hd, 0, -1, 0);
    // +Z
    face(-hw, -hh, hd, hw, -hh, hd, hw, hh, hd, -hw, hh, hd, 0, 0, 1);
    // -Z
    face(hw, -hh, -hd, -hw, -hh, -hd, -hw, hh, -hd, hw, hh, -hd, 0, 0, -1);

    const geom = new Geometry();
    geom.setBuffer('position', createVertexBuffer(d.vec3f, new Float32Array(positions)));
    geom.setBuffer('normal', createVertexBuffer(d.vec3f, new Float32Array(normals)));
    geom.setBuffer('uv', createVertexBuffer(d.vec2f, new Float32Array(uvs)));
    geom.index = createIndexBuffer(new Uint16Array(indices));
    geom.vertexCount = positions.length / 3;
    geom.boundingBox = [-hw, -hh, -hd, hw, hh, hd];
    geom.boundingSphere = { center: [0, 0, 0], radius: Math.sqrt(hw * hw + hh * hh + hd * hd) };
    return geom;
}

export function createSphereGeometry(radius = 0.5, widthSegments = 16, heightSegments = 8): Geometry {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    for (let iy = 0; iy <= heightSegments; iy++) {
        const v = iy / heightSegments;
        const phi = v * Math.PI;
        for (let ix = 0; ix <= widthSegments; ix++) {
            const u = ix / widthSegments;
            const theta = u * Math.PI * 2;
            const sinPhi = Math.sin(phi);
            const nx = Math.cos(theta) * sinPhi;
            const ny = Math.cos(phi);
            const nz = Math.sin(theta) * sinPhi;
            positions.push(nx * radius, ny * radius, nz * radius);
            normals.push(nx, ny, nz);
            uvs.push(u, v);
        }
    }

    for (let iy = 0; iy < heightSegments; iy++) {
        for (let ix = 0; ix < widthSegments; ix++) {
            const a = iy * (widthSegments + 1) + ix;
            const b = a + widthSegments + 1;
            indices.push(a, b, a + 1, b, b + 1, a + 1);
        }
    }

    const geom = new Geometry();
    geom.setBuffer('position', createVertexBuffer(d.vec3f, new Float32Array(positions)));
    geom.setBuffer('normal', createVertexBuffer(d.vec3f, new Float32Array(normals)));
    geom.setBuffer('uv', createVertexBuffer(d.vec2f, new Float32Array(uvs)));
    geom.index = createIndexBuffer(new Uint16Array(indices));
    geom.vertexCount = positions.length / 3;
    geom.boundingBox = [-radius, -radius, -radius, radius, radius, radius];
    geom.boundingSphere = { center: [0, 0, 0], radius };
    return geom;
}

/**
 * Creates a plane geometry in the XZ plane (Y-up).
 *
 * Vertices span [-width/2, width/2] × [-height/2, height/2] in XZ, at y=0.
 * Normals point +Y. Triangles wound CCW from above (+Y) so they are front-facing
 * when viewed from above with the default cullMode:'back' / frontFace:'ccw' pipeline.
 *
 * @param width - Total width along X. Defaults to 1.
 * @param height - Total depth along Z. Defaults to 1.
 * @param widthSegments - Subdivisions along X. Defaults to 1.
 * @param heightSegments - Subdivisions along Z. Defaults to 1.
 */
export function createPlaneGeometry(
    width = 1,
    height = 1,
    widthSegments = 1,
    heightSegments = 1,
): Geometry {
    const hw = width / 2;
    const hh = height / 2;

    const cols = widthSegments + 1;
    const rows = heightSegments + 1;
    const vertexCount = cols * rows;

    const positions = new Float32Array(vertexCount * 3);
    const normals   = new Float32Array(vertexCount * 3);
    const uvs       = new Float32Array(vertexCount * 2);

    for (let iy = 0; iy < rows; iy++) {
        const v = iy / heightSegments;
        const z = -hh + v * height;
        for (let ix = 0; ix < cols; ix++) {
            const u = ix / widthSegments;
            const x = -hw + u * width;
            const idx = iy * cols + ix;
            positions[idx * 3 + 0] = x;
            positions[idx * 3 + 1] = 0;
            positions[idx * 3 + 2] = z;
            normals[idx * 3 + 0] = 0;
            normals[idx * 3 + 1] = 1;
            normals[idx * 3 + 2] = 0;
            uvs[idx * 2 + 0] = u;
            uvs[idx * 2 + 1] = v;
        }
    }

     // Two triangles per quad, wound CCW when viewed from +Y (normal points +Y).
    // Triangle 1: a → b+1 → a+1   (CCW from above)
    // Triangle 2: a → b   → b+1   (CCW from above)
    const indexCount = widthSegments * heightSegments * 6;
    const indices = vertexCount <= 65536
        ? new Uint16Array(indexCount)
        : new Uint32Array(indexCount);
    let i = 0;
    for (let iy = 0; iy < heightSegments; iy++) {
        for (let ix = 0; ix < widthSegments; ix++) {
            const a = iy * cols + ix;
            const b = a + cols;
            indices[i++] = a;
            indices[i++] = b + 1;
            indices[i++] = a + 1;
            indices[i++] = a;
            indices[i++] = b;
            indices[i++] = b + 1;
        }
    }

    const geom = new Geometry();
    geom.setBuffer('position', createVertexBuffer(d.vec3f, positions));
    geom.setBuffer('normal', createVertexBuffer(d.vec3f, normals));
    geom.setBuffer('uv', createVertexBuffer(d.vec2f, uvs));
    geom.index = createIndexBuffer(indices as Uint16Array);
    geom.vertexCount = vertexCount;
    geom.boundingBox  = [-hw, 0, -hh, hw, 0, hh];
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
 *   - (0, 0) at top-left
 *   - (1, 1) at bottom-right
 * 
 * This mirrors Three.js QuadGeometry from QuadMesh.js.
 * 
 * @param flipY - Whether to flip UV coordinates along the vertical axis. Defaults to false.
 */
export function createFullscreenTriangleGeometry(flipY = false): Geometry {
    // Oversized triangle positions in clip space
    // vi=0 → (-1, -1)   vi=1 → (3, -1)   vi=2 → (-1, 3)
    const positions = new Float32Array([
        -1, -1, 0,  // bottom-left
         3, -1, 0,  // bottom-right (oversized)
        -1,  3, 0,  // top-left (oversized)
    ]);

    // UV coordinates matching Three.js QuadGeometry
    // Default: (0,0) at top-left, (1,1) at bottom-right (WebGPU convention)
    const uvsData = flipY
        ? new Float32Array([0, 2, 0, 0, 2, 0])  // flipped
        : new Float32Array([0, 0, 2, 0, 0, 2]); // standard

    const geom = new Geometry();
    geom.setBuffer('position', createVertexBuffer(d.vec3f, positions));
    geom.setBuffer('uv', createVertexBuffer(d.vec2f, uvsData));
    geom.vertexCount = 3;
    return geom;
}
