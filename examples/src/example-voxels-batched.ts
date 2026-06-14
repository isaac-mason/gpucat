import {
    attribute,
    bool,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createIndexBuffer,
    createStorageBuffer,
    createVertexBuffer,
    d,
    DrawIndexedIndirect,
    f32,
    Fn,
    frustum,
    Geometry,
    globalId,
    If,
    Inspector,
    Material,
    Mesh,
    OrbitControls,
    pass,
    PerspectiveCamera,
    Return,
    Scene,
    storage,
    struct,
    u32,
    Var,
    varying,
    vec3,
    vec4,
    WebGPURenderer,
    type Node,
    mul,
    createIndirectBuffer,
    packArray,
    RenderPipeline,
    renderOutput,
} from 'gpucat';
import { createSimplex2D } from 'mathcat';

// ─── constants ────────────────────────────────────────────────────────────────

const CHUNK_BITS  = 4;
const CHUNK_SIZE  = 1 << CHUNK_BITS; // 16

const WORLD_CHUNKS_X = 8;
const WORLD_CHUNKS_Y = 4;
const WORLD_CHUNKS_Z = 8;

const TOTAL_CHUNKS = WORLD_CHUNKS_X * WORLD_CHUNKS_Y * WORLD_CHUNKS_Z;

// Page pool — start with estimated size, grows if needed
const PAGE_QUADS       = 512;
const PAGE_VERTS       = PAGE_QUADS * 4;   // 2048
const PAGE_INDICES     = PAGE_QUADS * 6;   // 3072
let POOL_PAGES         = 256; // Initial estimate, can grow

const BRUSH_RADIUS = 5;

// ─── voxel types ─────────────────────────────────────────────────────────────

const VOXEL_AIR   = 0;
const VOXEL_SOLID = 1;

// ─── structs ─────────────────────────────────────────────────────────────────

const PageInfo = struct('PageInfo', {
    aabbMin:    d.vec3f,
    indexCount: d.u32,
    aabbMax:    d.vec3f,
    _pad:       d.u32,
});

const Frustum = struct('Frustum', {
    planes: d.sizedArray(d.vec4f, 6),
});

// ─── chunk / world data ───────────────────────────────────────────────────────

type Chunk = {
    cx: number; cy: number; cz: number;
    voxels: Uint8Array;
};

function chunkVoxelIndex(lx: number, ly: number, lz: number): number {
    return lz * CHUNK_SIZE * CHUNK_SIZE + ly * CHUNK_SIZE + lx;
}

type World = {
    chunks: (Chunk | null)[];
    chunksX: number; chunksY: number; chunksZ: number;
};

function createWorld(): World {
    return {
        chunks: new Array<Chunk | null>(WORLD_CHUNKS_X * WORLD_CHUNKS_Y * WORLD_CHUNKS_Z).fill(null),
        chunksX: WORLD_CHUNKS_X,
        chunksY: WORLD_CHUNKS_Y,
        chunksZ: WORLD_CHUNKS_Z,
    };
}

function worldChunkIndex(cx: number, cy: number, cz: number): number {
    return cz * WORLD_CHUNKS_Y * WORLD_CHUNKS_X + cy * WORLD_CHUNKS_X + cx;
}

function getOrCreateChunk(world: World, cx: number, cy: number, cz: number): Chunk {
    const idx = worldChunkIndex(cx, cy, cz);
    let chunk = world.chunks[idx];
    if (!chunk) {
        chunk = { cx, cy, cz, voxels: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE) };
        world.chunks[idx] = chunk;
    }
    return chunk;
}

function getVoxel(world: World, wx: number, wy: number, wz: number): number {
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cy = Math.floor(wy / CHUNK_SIZE);
    const cz = Math.floor(wz / CHUNK_SIZE);
    if (cx < 0 || cx >= world.chunksX || cy < 0 || cy >= world.chunksY || cz < 0 || cz >= world.chunksZ) return VOXEL_AIR;
    const chunk = world.chunks[worldChunkIndex(cx, cy, cz)];
    if (!chunk) return VOXEL_AIR;
    const lx = wx - cx * CHUNK_SIZE;
    const ly = wy - cy * CHUNK_SIZE;
    const lz = wz - cz * CHUNK_SIZE;
    return chunk.voxels[chunkVoxelIndex(lx, ly, lz)];
}

function setVoxel(world: World, wx: number, wy: number, wz: number, type: number): void {
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cy = Math.floor(wy / CHUNK_SIZE);
    const cz = Math.floor(wz / CHUNK_SIZE);
    if (cx < 0 || cx >= world.chunksX || cy < 0 || cy >= world.chunksY || cz < 0 || cz >= world.chunksZ) return;
    const chunk = getOrCreateChunk(world, cx, cy, cz);
    const lx = wx - cx * CHUNK_SIZE;
    const ly = wy - cy * CHUNK_SIZE;
    const lz = wz - cz * CHUNK_SIZE;
    chunk.voxels[chunkVoxelIndex(lx, ly, lz)] = type;
}

// ─── procgen ─────────────────────────────────────────────────────────────────

function fbm2D(noise: (x: number, y: number) => number, x: number, y: number, octaves: number): number {
    let value = 0, amp = 1, freq = 1, norm = 0;
    for (let i = 0; i < octaves; i++) {
        value += noise(x * freq, y * freq) * amp;
        norm += amp; amp *= 0.5; freq *= 2;
    }
    return value / norm;
}

function generateTerrain(world: World): void {
    const noise = createSimplex2D(42);
    const wvx = world.chunksX * CHUNK_SIZE;
    const wvz = world.chunksZ * CHUNK_SIZE;
    const wvy = world.chunksY * CHUNK_SIZE;
    const scale = 0.012;
    const minH = 4, maxH = wvy - 8;

    for (let wx = 0; wx < wvx; wx++) {
        for (let wz = 0; wz < wvz; wz++) {
            const n = fbm2D(noise, wx * scale, wz * scale, 5);
            const height = Math.floor(minH + ((n + 1) * 0.5) * (maxH - minH));
            for (let wy = 0; wy < height; wy++) {
                setVoxel(world, wx, wy, wz, VOXEL_SOLID);
            }
        }
    }
}

// ─── mesher ───────────────────────────────────────────────────────────────────

const FACE_NORMALS: [number, number, number][] = [
    [1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1],
];
const FACE_BY_AXIS_SIDE = [[0,1],[2,3],[4,5]];

const DIR_VECS: number[][][] = Array.from({ length: 3 }, (_, i) => {
    const a: number[] = [0,0,0], b: number[] = [0,0,0];
    a[(i+1)%3] = 1; b[(i+2)%3] = 1;
    return [a, b];
});

function vertexAO(s1: number, s2: number, c: number): number {
    if (s1 !== 0 && s2 !== 0) return 0;
    return (3 - (s1 + s2 + c)) / 3;
}

function getVoxelLocal(world: World, chunk: Chunk, lx: number, ly: number, lz: number): number {
    if (lx >= 0 && lx < CHUNK_SIZE && ly >= 0 && ly < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE)
        return chunk.voxels[chunkVoxelIndex(lx, ly, lz)];
    return getVoxel(world, chunk.cx * CHUNK_SIZE + lx, chunk.cy * CHUNK_SIZE + ly, chunk.cz * CHUNK_SIZE + lz);
}

type MeshData = {
    positions: Float32Array;
    normals:   Float32Array;
    ao:        Float32Array;
    indices:   Uint32Array;
    quadCount: number;
    // world-space AABB
    aabbMin: [number, number, number];
    aabbMax: [number, number, number];
};

const _aoGrid = new Uint8Array(9);

function meshChunk(world: World, chunk: Chunk): MeshData | null {
    const positions: number[] = [];
    const normals:   number[] = [];
    const ao:        number[] = [];
    const indices:   number[] = [];

    for (let x = -1; x < CHUNK_SIZE; x++) {
        for (let z = -1; z < CHUNK_SIZE; z++) {
            for (let y = -1; y < CHUNK_SIZE; y++) {
                const curSolid = getVoxelLocal(world, chunk, x, y, z) !== VOXEL_AIR;
                for (let dir = 0; dir < 3; dir++) {
                    const nx = x + (dir === 0 ? 1 : 0);
                    const ny = y + (dir === 1 ? 1 : 0);
                    const nz = z + (dir === 2 ? 1 : 0);
                    const nbrSolid = getVoxelLocal(world, chunk, nx, ny, nz) !== VOXEL_AIR;
                    if (curSolid === nbrSolid) continue;

                    const side = curSolid ? 0 : 1;
                    const bx = x + (dir === 0 ? side : 0);
                    const by = y + (dir === 1 ? side : 0);
                    const bz = z + (dir === 2 ? side : 0);
                    if (bx < 0 || bx >= CHUNK_SIZE || by < 0 || by >= CHUNK_SIZE || bz < 0 || bz >= CHUNK_SIZE) continue;

                    const faceIdx = FACE_BY_AXIS_SIDE[dir][side];
                    const [dx, dy, dz] = FACE_NORMALS[faceIdx];
                    const [ux, uy, uz] = DIR_VECS[dir][side];
                    const [vx, vy, vz] = DIR_VECS[dir][side ^ 1];

                    // world-space quad origin
                    const qx = chunk.cx * CHUNK_SIZE + nx;
                    const qy = chunk.cy * CHUNK_SIZE + ny;
                    const qz = chunk.cz * CHUNK_SIZE + nz;

                    const v0x = qx,        v0y = qy,        v0z = qz;
                    const v1x = qx+ux,     v1y = qy+uy,     v1z = qz+uz;
                    const v2x = qx+ux+vx,  v2y = qy+uy+vy,  v2z = qz+uz+vz;
                    const v3x = qx+vx,     v3y = qy+vy,     v3z = qz+vz;

                    let gi = 0;
                    for (let q = -1; q < 2; q++) {
                        for (let p = -1; p < 2; p++) {
                            _aoGrid[gi++] = getVoxelLocal(world, chunk, bx+dx+ux*p+vx*q, by+dy+uy*p+vy*q, bz+dz+uz*p+vz*q) !== VOXEL_AIR ? 1 : 0;
                        }
                    }

                    const ao00 = vertexAO(_aoGrid[3], _aoGrid[1], _aoGrid[0]);
                    const ao10 = vertexAO(_aoGrid[1], _aoGrid[5], _aoGrid[2]);
                    const ao11 = vertexAO(_aoGrid[5], _aoGrid[7], _aoGrid[8]);
                    const ao01 = vertexAO(_aoGrid[3], _aoGrid[7], _aoGrid[6]);

                    const base = positions.length / 3;
                    positions.push(v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z, v3x, v3y, v3z);
                    normals.push(dx, dy, dz, dx, dy, dz, dx, dy, dz, dx, dy, dz);
                    ao.push(ao00, ao10, ao11, ao01);

                    if (ao00 + ao11 > ao10 + ao01) {
                        indices.push(base, base+1, base+2, base, base+2, base+3);
                    } else {
                        indices.push(base, base+1, base+3, base+1, base+2, base+3);
                    }
                }
            }
        }
    }

    if (indices.length === 0) return null;

    // world-space AABB
    const ox = chunk.cx * CHUNK_SIZE;
    const oy = chunk.cy * CHUNK_SIZE;
    const oz = chunk.cz * CHUNK_SIZE;

    return {
        positions: new Float32Array(positions),
        normals:   new Float32Array(normals),
        ao:        new Float32Array(ao),
        indices:   new Uint32Array(indices),
        quadCount: indices.length / 6,
        aabbMin:   [ox, oy, oz],
        aabbMax:   [ox + CHUNK_SIZE, oy + CHUNK_SIZE, oz + CHUNK_SIZE],
    };
}

// ─── slab allocator with dynamic growth ───────────────────────────────────────

let freePageStack = new Uint16Array(POOL_PAGES);
let freeHead = 0;

function initFreeList(): void {
    for (let i = 0; i < POOL_PAGES; i++) freePageStack[i] = POOL_PAGES - 1 - i;
    freeHead = POOL_PAGES;
}

function allocPage(): number {
    if (freeHead > 0) {
        return freePageStack[--freeHead];
    }
    // Pool exhausted, need to grow
    growBufferPool();
    return freePageStack[--freeHead];
}

function freePage(page: number): void {
    freePageStack[freeHead++] = page;
}

function growBufferPool(): void {
    const oldPoolPages = POOL_PAGES;
    POOL_PAGES = Math.ceil(POOL_PAGES * 1.5);
    
    // Grow all GPU buffers
    const newPositionData = new Float32Array(POOL_PAGES * PAGE_VERTS * 3);
    newPositionData.set(positionData.subarray(0, oldPoolPages * PAGE_VERTS * 3));
    positionData.set(newPositionData);
    positionBuf.array = newPositionData;
    
    const newNormalData = new Float32Array(POOL_PAGES * PAGE_VERTS * 3);
    newNormalData.set(normalData.subarray(0, oldPoolPages * PAGE_VERTS * 3));
    normalData.set(newNormalData);
    normalBuf.array = newNormalData;
    
    const newAOData = new Float32Array(POOL_PAGES * PAGE_VERTS);
    newAOData.set(aoData.subarray(0, oldPoolPages * PAGE_VERTS));
    aoData.set(newAOData);
    aoBuf.array = newAOData;
    
    const newIndexData = new Uint32Array(POOL_PAGES * PAGE_INDICES);
    newIndexData.set(indexData.subarray(0, oldPoolPages * PAGE_INDICES));
    indexData.set(newIndexData);
    indexBuf.array = newIndexData;
    
    // Grow PageInfo storage
    const PAGE_INFO_STRIDE = 8;
    const newPageInfoData = new Float32Array(POOL_PAGES * PAGE_INFO_STRIDE);
    newPageInfoData.set(pageInfoData.subarray(0, oldPoolPages * PAGE_INFO_STRIDE));
    pageInfoData.set(newPageInfoData);
    pageInfoBuf.array = newPageInfoData;
    
    // Grow indirect buffer
    const newIndirectData = new Uint32Array(POOL_PAGES * 5); // DrawIndexedIndirect is 5 u32s
    newIndirectData.set(indirectData.subarray(0, oldPoolPages * 5));
    for (let i = oldPoolPages; i < POOL_PAGES; i++) {
        newIndirectData[i * 5 + 0] = 0;      // indexCount
        newIndirectData[i * 5 + 1] = 1;      // instanceCount
        newIndirectData[i * 5 + 2] = i * PAGE_INDICES;      // firstIndex
        newIndirectData[i * 5 + 3] = i * PAGE_VERTS;        // baseVertex
        newIndirectData[i * 5 + 4] = 0;      // firstInstance
    }
    indirectData.set(newIndirectData);
    indirectBuf.array = newIndirectData;
    
    // Grow free page stack
    const newFreePageStack = new Uint16Array(POOL_PAGES);
    newFreePageStack.set(freePageStack);
    for (let i = oldPoolPages; i < POOL_PAGES; i++) {
        newFreePageStack[freeHead++] = POOL_PAGES - 1 - i;
    }
    freePageStack = newFreePageStack;
}

// ─── GPU buffers ──────────────────────────────────────────────────────────────

// Pre-allocated merged vertex/index buffers
const positionData = new Float32Array(POOL_PAGES * PAGE_VERTS * 3);
const positionBuf = createVertexBuffer(d.vec3f, positionData);

const normalData = new Float32Array(POOL_PAGES * PAGE_VERTS * 3);
const normalBuf = createVertexBuffer(d.vec3f, normalData);

const aoData = new Float32Array(POOL_PAGES * PAGE_VERTS);
const aoBuf = createVertexBuffer(d.f32, aoData);

const indexData = new Uint32Array(POOL_PAGES * PAGE_INDICES);
const indexBuf = createIndexBuffer(indexData);

// PageInfo storage — one entry per pool page
const PAGE_INFO_STRIDE = 8; // floats: vec3f(3) + u32(1) + vec3f(3) + u32(1)
const pageInfoData = new Float32Array(POOL_PAGES * PAGE_INFO_STRIDE);
const pageInfoBuf = createStorageBuffer(d.sizedArray(PageInfo, POOL_PAGES), pageInfoData);

// Indirect draw buffer — one DrawIndexedIndirect per pool page
const indirectData = new Uint32Array(packArray(DrawIndexedIndirect,
    Array.from({ length: POOL_PAGES }, (_, i) => ({
        indexCount: 0, instanceCount: 1,
        firstIndex: i * PAGE_INDICES, baseVertex: i * PAGE_VERTS, firstInstance: 0,
    }))
));
const indirectBuf = createIndirectBuffer(d.sizedArray(DrawIndexedIndirect, POOL_PAGES), indirectData);

// Frustum uniform — 6 planes as vec4f (xyz=normal, w=d), updated CPU-side each frame
const frustumData = new Float32Array(6 * 4);
const frustumBuf = createStorageBuffer(Frustum, frustumData);

// ─── storage nodes for compute ────────────────────────────────────────────────

const pageInfoStorage = storage(pageInfoBuf, 'read');
const indirectStorage = storage(indirectBuf, 'read_write');
const frustumStorage  = storage(frustumBuf, 'read');

// ─── cull compute ─────────────────────────────────────────────────────────────

const cullCompute = Fn(() => {
    const id = globalId.x;
    If(id.greaterThanEqual(u32(POOL_PAGES)), () => { Return(); });

    const page = pageInfoStorage.element(id).fields();
    const count = page.indexCount.toVar('count');

    // AABB frustum test — p-vertex method
    const aabbMin = page.aabbMin.toVar('aabbMin');
    const aabbMax = page.aabbMax.toVar('aabbMax');

    const visible = Var('visible', count.greaterThan(u32(0)));

    for (let i = 0; i < 6; i++) {
        const plane = frustumStorage.field("planes").element(u32(i)).toVar(`plane${i}`);
        const planeX = plane.x.toVar(`p${i}x`);
        const planeY = plane.y.toVar(`p${i}y`);
        const planeZ = plane.z.toVar(`p${i}z`);
        const px = planeX.greaterThanEqual(f32(0)).select(aabbMax.x, aabbMin.x);
        const py = planeY.greaterThanEqual(f32(0)).select(aabbMax.y, aabbMin.y);
        const pz = planeZ.greaterThanEqual(f32(0)).select(aabbMax.z, aabbMin.z);
        const dist = planeX.mul(px).add(planeY.mul(py)).add(planeZ.mul(pz)).add(plane.w);
        If(dist.lessThan(f32(0)), () => { visible.assign(bool(false)); });
    }

    const draw = indirectStorage.element(id).fields();
    draw.indexCount.assign(visible.select(count, u32(0)));
    draw.instanceCount.assign(u32(1));
    draw.firstIndex.assign(id.mul(u32(PAGE_INDICES)));
    draw.baseVertex.assign(id.mul(u32(PAGE_VERTS)));
    draw.firstInstance.assign(u32(0));
}).compute({ workgroupSize: [64, 1, 1] });

// ─── chunk state & mesh cache ─────────────────────────────────────────────────

// CPU-side mesh cache — populated at startup, updated on edit
const meshCache: (MeshData | null)[] = new Array(TOTAL_CHUNKS).fill(null);

// Pages needed per chunk (0 for empty chunks) — derived from meshCache
const chunkPageCount = new Uint8Array(TOTAL_CHUNKS);

// GPU page allocations per chunk (empty array = not on GPU)
const gpuPages: number[][] = Array.from({ length: TOTAL_CHUNKS }, () => []);

function meshAndCache(world: World, chunkIdx: number): void {
    const chunk = world.chunks[chunkIdx];
    if (!chunk) {
        meshCache[chunkIdx] = null;
        chunkPageCount[chunkIdx] = 0;
        return;
    }
    const data = meshChunk(world, chunk);
    meshCache[chunkIdx] = data;
    chunkPageCount[chunkIdx] = data ? Math.ceil(data.quadCount / PAGE_QUADS) : 0;
}

// ─── write page info into pageInfoData ───────────────────────────────────────

function writePageInfo(page: number, indexCount: number, aabbMin: [number,number,number], aabbMax: [number,number,number]): void {
    const base = page * PAGE_INFO_STRIDE;
    pageInfoData[base + 0] = aabbMin[0];
    pageInfoData[base + 1] = aabbMin[1];
    pageInfoData[base + 2] = aabbMin[2];
    new DataView(pageInfoData.buffer).setUint32((base + 3) * 4, indexCount, true);
    pageInfoData[base + 4] = aabbMax[0];
    pageInfoData[base + 5] = aabbMax[1];
    pageInfoData[base + 6] = aabbMax[2];
    new DataView(pageInfoData.buffer).setUint32((base + 7) * 4, 0, true); // _pad
}

// ─── GPU upload / unload ─────────────────────────────────────────────────────

let gpuDirty = false;

function uploadChunk(chunkIdx: number): void {
    const data = meshCache[chunkIdx];
    if (!data) return; // empty chunk, nothing to upload

    const pages = gpuPages[chunkIdx];

    let quadOffset = 0;
    while (quadOffset < data.quadCount) {
        const pageQuads = Math.min(PAGE_QUADS, data.quadCount - quadOffset);
        const pageVerts = pageQuads * 4;
        const pageIdxs  = pageQuads * 6;
        const vOff      = quadOffset * 4;
        const iOff      = quadOffset * 6;

        const page = allocPage();
        pages.push(page);

        const pvBase = page * PAGE_VERTS;
        const piBase = page * PAGE_INDICES;

        positionBuf.array!.set(data.positions.subarray(vOff * 3, (vOff + pageVerts) * 3), pvBase * 3);
        positionBuf.addUpdateRange(pvBase * 3, pageVerts * 3);

        normalBuf.array!.set(data.normals.subarray(vOff * 3, (vOff + pageVerts) * 3), pvBase * 3);
        normalBuf.addUpdateRange(pvBase * 3, pageVerts * 3);

        aoBuf.array!.set(data.ao.subarray(vOff, vOff + pageVerts), pvBase);
        aoBuf.addUpdateRange(pvBase, pageVerts);

        const iSrc = data.indices.subarray(iOff, iOff + pageIdxs);
        const idxDst = indexBuf.array!;
        for (let j = 0; j < pageIdxs; j++) {
            idxDst[piBase + j] = iSrc[j] - vOff;
        }
        indexBuf.addUpdateRange(piBase, pageIdxs);

        writePageInfo(page, pageIdxs, data.aabbMin, data.aabbMax);
        pageInfoBuf.addUpdateRange(page * PAGE_INFO_STRIDE, PAGE_INFO_STRIDE);

        quadOffset += pageQuads;
    }

    gpuDirty = true;
}

function unloadChunk(chunkIdx: number): void {
    const pages = gpuPages[chunkIdx];
    for (const p of pages) {
        writePageInfo(p, 0, [0,0,0], [0,0,0]);
        pageInfoBuf.addUpdateRange(p * PAGE_INFO_STRIDE, PAGE_INFO_STRIDE);
        freePage(p);
    }
    pages.length = 0;
    gpuDirty = true;
}

function flushGPU(): void {
    if (!gpuDirty) return;
    positionBuf.needsUpdate = true;
    normalBuf.needsUpdate   = true;
    aoBuf.needsUpdate       = true;
    indexBuf.needsUpdate    = true;
    pageInfoBuf.needsUpdate = true;
    gpuDirty = false;
}

// ─── sort-based chunk streaming ──────────────────────────────────────────────
// REMOVED — all chunks fit in memory, no streaming needed

// ─── editing ─────────────────────────────────────────────────────────────────

function remeshForEdit(world: World, chunkIdx: number): void {
    // Unload from GPU if present
    if (gpuPages[chunkIdx].length > 0) unloadChunk(chunkIdx);
    // Re-mesh to cache
    meshAndCache(world, chunkIdx);

    const needed = chunkPageCount[chunkIdx];
    if (needed === 0) return;

    // Ensure pool has room, growing if necessary
    let retries = 0;
    while (freeHead < needed && retries < 5) {
        growBufferPool();
        retries++;
    }

    if (freeHead >= needed) uploadChunk(chunkIdx);
    flushGPU();
}

// ─── frustum update ───────────────────────────────────────────────────────────

const _cpuFrustum = frustum.create();

function updateFrustum(camera: PerspectiveCamera): void {
    frustum.setFromViewProjectionMatrix(_cpuFrustum, camera.projectionMatrix, camera.matrixWorldInverse);
    for (let i = 0; i < 6; i++) {
        const p = _cpuFrustum[i];
        frustumData[i * 4 + 0] = p.normal[0];
        frustumData[i * 4 + 1] = p.normal[1];
        frustumData[i * 4 + 2] = p.normal[2];
        frustumData[i * 4 + 3] = p.constant;
    }
    frustumBuf.needsUpdate = true;
}

// ─── DDA raycast ─────────────────────────────────────────────────────────────

type RaycastHit = { wx: number; wy: number; wz: number; nx: number; ny: number; nz: number } | null;

function raycastVoxels(world: World, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): RaycastHit {
    let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = Math.abs(1 / dx), tDeltaY = Math.abs(1 / dy), tDeltaZ = Math.abs(1 / dz);
    let tMaxX = dx !== 0 ? (dx > 0 ? (x+1-ox) : (ox-x)) * tDeltaX : Infinity;
    let tMaxY = dy !== 0 ? (dy > 0 ? (y+1-oy) : (oy-y)) * tDeltaY : Infinity;
    let tMaxZ = dz !== 0 ? (dz > 0 ? (z+1-oz) : (oz-z)) * tDeltaZ : Infinity;
    let nx = 0, ny = 0, nz = 0;
    let dist = 0;

    while (dist < maxDist) {
        if (getVoxel(world, x, y, z) !== VOXEL_AIR) return { wx: x, wy: y, wz: z, nx, ny, nz };
        if (tMaxX < tMaxY && tMaxX < tMaxZ) {
            x += stepX; dist = tMaxX; tMaxX += tDeltaX; nx = -stepX; ny = 0; nz = 0;
        } else if (tMaxY < tMaxZ) {
            y += stepY; dist = tMaxY; tMaxY += tDeltaY; nx = 0; ny = -stepY; nz = 0;
        } else {
            z += stepZ; dist = tMaxZ; tMaxZ += tDeltaZ; nx = 0; ny = 0; nz = -stepZ;
        }
    }
    return null;
}

function addChunkIfValid(set: Set<number>, cx: number, cy: number, cz: number): void {
    if (cx >= 0 && cx < WORLD_CHUNKS_X && cy >= 0 && cy < WORLD_CHUNKS_Y && cz >= 0 && cz < WORLD_CHUNKS_Z) {
        set.add(worldChunkIndex(cx, cy, cz));
    }
}

function applyBrush(world: World, wx: number, wy: number, wz: number, type: number): void {
    const r = BRUSH_RADIUS;
    const r2 = r * r;
    const affected = new Set<number>();

    for (let dz = -r; dz <= r; dz++) {
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (dx*dx + dy*dy + dz*dz > r2) continue;
                const vx = wx + dx, vy = wy + dy, vz = wz + dz;
                setVoxel(world, vx, vy, vz, type);
                const cx = Math.floor(vx / CHUNK_SIZE);
                const cy = Math.floor(vy / CHUNK_SIZE);
                const cz = Math.floor(vz / CHUNK_SIZE);
                if (cx >= 0 && cx < WORLD_CHUNKS_X && cy >= 0 && cy < WORLD_CHUNKS_Y && cz >= 0 && cz < WORLD_CHUNKS_Z) {
                    affected.add(worldChunkIndex(cx, cy, cz));
                    const lx = vx - cx * CHUNK_SIZE;
                    const ly = vy - cy * CHUNK_SIZE;
                    const lz = vz - cz * CHUNK_SIZE;
                    if (lx === 0)              addChunkIfValid(affected, cx-1, cy, cz);
                    if (lx === CHUNK_SIZE - 1) addChunkIfValid(affected, cx+1, cy, cz);
                    if (ly === 0)              addChunkIfValid(affected, cx, cy-1, cz);
                    if (ly === CHUNK_SIZE - 1) addChunkIfValid(affected, cx, cy+1, cz);
                    if (lz === 0)              addChunkIfValid(affected, cx, cy, cz-1);
                    if (lz === CHUNK_SIZE - 1) addChunkIfValid(affected, cx, cy, cz+1);
                }
            }
        }
    }

    for (const idx of affected) remeshForEdit(world, idx);
}

// ─── material ─────────────────────────────────────────────────────────────────

const posAttr    = attribute('position', d.vec3f);
const normalAttr = attribute('normal',   d.vec3f) as Node<d.vec3f>;
const aoAttr     = attribute('ao',       d.f32)   as Node<d.f32>;

const vNormal = varying(normalAttr, 'v_normal') as Node<d.vec3f>;
const vAO     = varying(aoAttr,     'v_ao')     as Node<d.f32>;

const clipPos = mul(cameraProjectionMatrix, mul(cameraViewMatrix, vec4(posAttr, f32(1))));

const lightDir  = vec3(f32(0.6), f32(1.0), f32(0.4)).normalize();
const diffuse   = vNormal.dot(lightDir).max(f32(0.15));
const baseColor = vec3(f32(0.55), f32(0.52), f32(0.50));
const shadedColor = baseColor.mul(diffuse).mul(vAO);
const finalColor  = vec4(shadedColor, f32(1));

const material = new Material({ vertex: clipPos, fragment: finalColor });

// ─── geometry (one merged mesh) ───────────────────────────────────────────────

const mergedGeometry = new Geometry();
mergedGeometry.setBuffer('position', positionBuf);
mergedGeometry.setBuffer('normal',   normalBuf);
mergedGeometry.setBuffer('ao',       aoBuf);
mergedGeometry.index    = indexBuf;
mergedGeometry.indirect = indirectBuf;

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
    initFreeList();

    const renderer = new WebGPURenderer({ antialias: true });
    const inspector = new Inspector();
    renderer.inspector = inspector;
    await renderer.init();

    document.body.appendChild(renderer.domElement);
    document.body.appendChild(inspector.domElement);
    renderer.setPixelRatio(devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.clearColor = [0.53, 0.80, 0.92, 1];

    // Stats overlay
    const statsEl = document.createElement('div');
    statsEl.style.cssText = 'position:fixed;top:8px;left:8px;background:rgba(0,0,0,0.7);color:#fff;padding:8px 12px;font:12px/1.5 monospace;border-radius:4px;pointer-events:none;z-index:100;';
    document.body.appendChild(statsEl);

    const scene = new Scene();
    const camera = new PerspectiveCamera(Math.PI / 4, window.innerWidth / window.innerHeight, 0.1, 2000);
    camera.position[0] = (WORLD_CHUNKS_X * CHUNK_SIZE) / 2;
    camera.position[1] = WORLD_CHUNKS_Y * CHUNK_SIZE * 0.6;
    camera.position[2] = (WORLD_CHUNKS_Z * CHUNK_SIZE) / 2 + CHUNK_SIZE * 10;
    scene.add(camera);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target[0] = (WORLD_CHUNKS_X * CHUNK_SIZE) / 2;
    controls.target[1] = WORLD_CHUNKS_Y * CHUNK_SIZE * 0.25;
    controls.target[2] = (WORLD_CHUNKS_Z * CHUNK_SIZE) / 2;
    controls.enableDamping = true;
    controls.update();

    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth, window.innerHeight);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    });

    // Generate terrain
    const world = createWorld();
    
    inspector.perf.start('terrain-gen');
    generateTerrain(world);
    inspector.perf.end('terrain-gen');

    // One mesh for the whole world
    const mesh = new Mesh(mergedGeometry, material);
    scene.add(mesh);

    await renderer.compileCompute(cullCompute);

    const scenePass = pass(scene, camera);
    const outputNode = renderOutput(scenePass.getTextureNode());
    const renderPipeline = new RenderPipeline(renderer, outputNode);

    // Mesh all chunks into CPU cache at startup
    inspector.perf.start('initial-meshing');
    for (let i = 0; i < TOTAL_CHUNKS; i++) meshAndCache(world, i);
    inspector.perf.end('initial-meshing');

    // Load all chunks into GPU buffers at startup
    inspector.perf.start('initial-upload');
    for (let i = 0; i < TOTAL_CHUNKS; i++) {
        if (meshCache[i]) uploadChunk(i);
    }
    flushGPU();
    inspector.perf.end('initial-upload');

    // Ray from screen position
    function getRayFromScreen(clientX: number, clientY: number): { ox: number; oy: number; oz: number; dx: number; dy: number; dz: number } {
        const rect = renderer.domElement.getBoundingClientRect();
        const ndcX = ((clientX - rect.left) / rect.width)  *  2 - 1;
        const ndcY = ((clientY - rect.top)  / rect.height) * -2 + 1;

        // Simple approach: use the camera's own position and compute a view-space ray
        const tanHalfFov = Math.tan(camera.fov / 2);
        const aspect = camera.aspect;
        const vx = ndcX * tanHalfFov * aspect;
        const vy = ndcY * tanHalfFov;

        // View-space ray direction (camera looks -Z)
        const vRayX = vx, vRayY = vy, vRayZ = -1;

        // Transform to world space using camera's world matrix (column-major)
        const m = camera.matrix;
        const dx = m[0]*vRayX + m[4]*vRayY + m[8]*vRayZ;
        const dy = m[1]*vRayX + m[5]*vRayY + m[9]*vRayZ;
        const dz = m[2]*vRayX + m[6]*vRayY + m[10]*vRayZ;
        const len = Math.sqrt(dx*dx + dy*dy + dz*dz);

        return {
            ox: camera.position[0], oy: camera.position[1], oz: camera.position[2],
            dx: dx/len, dy: dy/len, dz: dz/len,
        };
    }

    renderer.domElement.addEventListener('mousedown', (e) => {
        if (e.button !== 0 && e.button !== 2) return;
        const ray = getRayFromScreen(e.clientX, e.clientY);
        const hit = raycastVoxels(world, ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz, 1024);
        if (!hit) return;

        if (e.button === 2) {
            applyBrush(world, hit.wx + hit.nx, hit.wy + hit.ny, hit.wz + hit.nz, VOXEL_SOLID);
        } else {
            applyBrush(world, hit.wx, hit.wy, hit.wz, VOXEL_AIR);
        }
    });

    renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

    let frameCount = 0;

    function frame() {
        inspector.perf.start('update');
        controls.update();
        scene.updateWorldMatrix();
        camera.updateViewMatrix();
        inspector.perf.end('update');

        // Update frustum for GPU cull
        inspector.perf.start('frustum-update');
        updateFrustum(camera);
        inspector.perf.end('frustum-update');

        // GPU cull pass — writes indirectBuf slots
        renderer.compute([{ node: cullCompute, dispatch: [Math.ceil(POOL_PAGES / 64), 1, 1] }]);

        renderPipeline.render();

        if (++frameCount % 30 === 0) {
            const pagesUsed = POOL_PAGES - freeHead;
            let chunksLoaded = 0;
            for (let i = 0; i < TOTAL_CHUNKS; i++) {
                if (gpuPages[i].length > 0) chunksLoaded++;
            }
            statsEl.textContent =
                `pages: ${pagesUsed}/${POOL_PAGES}  ` +
                `chunks: ${chunksLoaded}/${TOTAL_CHUNKS}`;
        }

        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

main();
