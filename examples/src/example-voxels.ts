import {
    attribute,
    bool,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createIndexBuffer,
    createIndirectBuffer,
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
    index,
    instanceIndex,
    Inspector,
    Material,
    Mesh,
    mul,
    OrbitControls,
    packArray,
    pass,
    PerspectiveCamera,
    RenderPipeline,
    renderOutput,
    Return,
    Scene,
    storage,
    struct,
    u32,
    Var,
    varying,
    vec3,
    vec4,
    wgslFn,
    WebGPURenderer,
    type Node,
} from 'gpucat';
import { createSimplex2D } from 'mathcat';
import { createOffsetAllocator, oaAllocate, oaFree, oaStorageReport, type OAHandle } from './offset-allocator';

/*
 * GPU voxels — quad-pull rendering.
 *
 * A 256×64×256 voxel world. Each chunk (16³) is meshed on the CPU into compact
 * *packed quads* — one visible cube face is just two u32s (world position +
 * facing + diagonal-flip; colour + per-corner AO). All quads live in one storage
 * buffer ("the arena"); there are no per-vertex position/normal buffers.
 *
 * The render draws a single unit quad, instanced once per visible face: the
 * vertex stage pulls a packed quad by instanceIndex, rebuilds its four corners
 * from a per-facing basis, and places it in the world. A compute pass frustum-
 * culls each arena page and writes the per-page DrawIndexedIndirect args, so only
 * visible faces are drawn — all on the GPU, no CPU readback.
 *
 * Left-click digs, right-click adds; edited chunks are re-meshed and re-uploaded.
 */

// ─── constants ────────────────────────────────────────────────────────────────

const CHUNK_BITS = 4;
const CHUNK_SIZE = 1 << CHUNK_BITS; // 16

const WORLD_CHUNKS_X = 16;
const WORLD_CHUNKS_Y = 4;
const WORLD_CHUNKS_Z = 16; // 256×64×256 voxels

const TOTAL_CHUNKS = WORLD_CHUNKS_X * WORLD_CHUNKS_Y * WORLD_CHUNKS_Z;

const WORLD_VX = WORLD_CHUNKS_X * CHUNK_SIZE;
const WORLD_VY = WORLD_CHUNKS_Y * CHUNK_SIZE;
const WORLD_VZ = WORLD_CHUNKS_Z * CHUNK_SIZE;

// Arena: a flat pool of packed quads, suballocated per chunk by an exact-fit
// OffsetAllocator (sebbbi's O(1) TLSF). One allocation per loaded chunk.
const ARENA_QUADS = 1 << 20;     // 1,048,576-quad capacity (≈8 MB at 2×u32)
const MAX_ALLOC_NODES = 1 << 14; // allocator node-pool size
const MAX_DRAWS = 1024;          // simultaneously-loaded chunks (draw/cull slots)

const BRUSH_RADIUS = 5;

// ─── voxel types ─────────────────────────────────────────────────────────────

const VOXEL_AIR = 0;
const VOXEL_SOLID = 1;

// ─── structs ─────────────────────────────────────────────────────────────────

const ChunkInfo = struct('ChunkInfo', {
    aabbMin: d.vec3f,
    quadCount: d.u32,
    aabbMax: d.vec3f,
    arenaBase: d.u32, // first quad index in the arena (== firstInstance)
});

const Frustum = struct('Frustum', {
    planes: d.sizedArray(d.vec4f, 6),
});

// ─── chunk / world data ───────────────────────────────────────────────────────

type Chunk = { cx: number; cy: number; cz: number; voxels: Uint8Array };

function chunkVoxelIndex(lx: number, ly: number, lz: number): number {
    return lz * CHUNK_SIZE * CHUNK_SIZE + ly * CHUNK_SIZE + lx;
}

type World = { chunks: (Chunk | null)[] };

function createWorld(): World {
    return { chunks: new Array<Chunk | null>(TOTAL_CHUNKS).fill(null) };
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
    if (cx < 0 || cx >= WORLD_CHUNKS_X || cy < 0 || cy >= WORLD_CHUNKS_Y || cz < 0 || cz >= WORLD_CHUNKS_Z) return VOXEL_AIR;
    const chunk = world.chunks[worldChunkIndex(cx, cy, cz)];
    if (!chunk) return VOXEL_AIR;
    return chunk.voxels[chunkVoxelIndex(wx - cx * CHUNK_SIZE, wy - cy * CHUNK_SIZE, wz - cz * CHUNK_SIZE)];
}

function setVoxel(world: World, wx: number, wy: number, wz: number, type: number): void {
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cy = Math.floor(wy / CHUNK_SIZE);
    const cz = Math.floor(wz / CHUNK_SIZE);
    if (cx < 0 || cx >= WORLD_CHUNKS_X || cy < 0 || cy >= WORLD_CHUNKS_Y || cz < 0 || cz >= WORLD_CHUNKS_Z) return;
    const chunk = getOrCreateChunk(world, cx, cy, cz);
    chunk.voxels[chunkVoxelIndex(wx - cx * CHUNK_SIZE, wy - cy * CHUNK_SIZE, wz - cz * CHUNK_SIZE)] = type;
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
    const scale = 0.012;
    const minH = 4, maxH = WORLD_VY - 8;
    for (let wx = 0; wx < WORLD_VX; wx++) {
        for (let wz = 0; wz < WORLD_VZ; wz++) {
            const n = fbm2D(noise, wx * scale, wz * scale, 5);
            const height = Math.floor(minH + ((n + 1) * 0.5) * (maxH - minH));
            for (let wy = 0; wy < height; wy++) setVoxel(world, wx, wy, wz, VOXEL_SOLID);
        }
    }
}

// ─── colour palette (by height band) ──────────────────────────────────────────
// Indices match the `palette()` table in the vertex shader below.

function colorForHeight(qy: number): number {
    if (qy >= 30) return 4; // snow
    if (qy >= 22) return 3; // light rock
    if (qy >= 14) return 2; // grass
    if (qy >= 8) return 1;  // dirt
    return 0;               // rock
}

// ─── mesher (emits packed quads) ──────────────────────────────────────────────
//
// Per-facing basis, matching the vertex shader's faceU/faceV/faceN tables.
// faceIdx: 0:+X 1:-X 2:+Y 3:-Y 4:+Z 5:-Z

const FACE_NORMALS: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const FACE_BY_AXIS_SIDE = [[0, 1], [2, 3], [4, 5]];
const DIR_VECS: number[][][] = Array.from({ length: 3 }, (_, i) => {
    const a: number[] = [0, 0, 0], b: number[] = [0, 0, 0];
    a[(i + 1) % 3] = 1; b[(i + 2) % 3] = 1;
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
    quads: Uint32Array;   // 2 u32 per quad: [geom, attr]
    quadCount: number;
    aabbMin: [number, number, number];
    aabbMax: [number, number, number];
};

const _aoGrid = new Uint8Array(9);

// pack 0..1 AO into 2 bits (0..3)
const ao2 = (a: number) => Math.min(3, Math.max(0, Math.round(a * 3)));

function meshChunk(world: World, chunk: Chunk): MeshData | null {
    const quads: number[] = [];

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

                    // world-space quad base corner (v0)
                    const qx = chunk.cx * CHUNK_SIZE + nx;
                    const qy = chunk.cy * CHUNK_SIZE + ny;
                    const qz = chunk.cz * CHUNK_SIZE + nz;

                    let gi = 0;
                    for (let q = -1; q < 2; q++)
                        for (let p = -1; p < 2; p++)
                            _aoGrid[gi++] = getVoxelLocal(world, chunk, bx + dx + ux * p + vx * q, by + dy + uy * p + vy * q, bz + dz + uz * p + vz * q) !== VOXEL_AIR ? 1 : 0;

                    const ao00 = vertexAO(_aoGrid[3], _aoGrid[1], _aoGrid[0]); // v0 = base
                    const ao10 = vertexAO(_aoGrid[1], _aoGrid[5], _aoGrid[2]); // v1 = base+U
                    const ao11 = vertexAO(_aoGrid[5], _aoGrid[7], _aoGrid[8]); // v2 = base+U+V
                    const ao01 = vertexAO(_aoGrid[3], _aoGrid[7], _aoGrid[6]); // v3 = base+V
                    const diagFlip = ao00 + ao11 > ao10 + ao01 ? 0 : 1;

                    const color = colorForHeight(qy);

                    const geom = ((qx & 0x1ff) | ((qy & 0x7f) << 9) | ((qz & 0x1ff) << 16) | ((faceIdx & 0x7) << 25) | ((diagFlip & 1) << 28)) >>> 0;
                    const attr = ((color & 0x3f) | (ao2(ao00) << 6) | (ao2(ao10) << 8) | (ao2(ao11) << 10) | (ao2(ao01) << 12)) >>> 0;
                    quads.push(geom, attr);
                }
            }
        }
    }

    if (quads.length === 0) return null;
    const ox = chunk.cx * CHUNK_SIZE, oy = chunk.cy * CHUNK_SIZE, oz = chunk.cz * CHUNK_SIZE;
    return {
        quads: new Uint32Array(quads),
        quadCount: quads.length / 2,
        aabbMin: [ox, oy, oz],
        aabbMax: [ox + CHUNK_SIZE, oy + CHUNK_SIZE, oz + CHUNK_SIZE],
    };
}

// ─── arena + draw-slot allocators ──────────────────────────────────────────────

// The arena's quad ranges are handed out by the exact-fit OffsetAllocator.
const arena = createOffsetAllocator(ARENA_QUADS, MAX_ALLOC_NODES);

// Draw/cull slots — one ChunkInfo + indirect entry per loaded chunk. Plain
// free-stack; independent of the arena offsets.
const freeSlots = new Uint16Array(MAX_DRAWS);
let slotHead = 0;
function initSlots(): void {
    for (let i = 0; i < MAX_DRAWS; i++) freeSlots[i] = MAX_DRAWS - 1 - i;
    slotHead = MAX_DRAWS;
}
function allocSlot(): number {
    return slotHead > 0 ? freeSlots[--slotHead] : -1;
}
function freeDrawSlot(slot: number): void {
    freeSlots[slotHead++] = slot;
}

// ─── GPU buffers ──────────────────────────────────────────────────────────────

// The arena: all packed quads (2 u32 each), one pool suballocated per chunk.
const arenaData = new Uint32Array(ARENA_QUADS * 2);
const arenaBuf = createStorageBuffer(d.array(d.u32), arenaData);

// ChunkInfo storage — one entry per draw slot (AABB + quadCount + arenaBase).
const CI_STRIDE = 8; // vec3f(3) + u32(1) + vec3f(3) + u32(1)
const chunkInfoData = new Float32Array(MAX_DRAWS * CI_STRIDE);
const chunkInfoBuf = createStorageBuffer(d.sizedArray(ChunkInfo, MAX_DRAWS), chunkInfoData);

// Indirect draw buffer — one DrawIndexedIndirect per draw slot (unit quad, instanced).
const indirectData = new Uint32Array(packArray(DrawIndexedIndirect,
    Array.from({ length: MAX_DRAWS }, () => ({
        indexCount: 6, instanceCount: 0, firstIndex: 0, baseVertex: 0, firstInstance: 0,
    })),
));
const indirectBuf = createIndirectBuffer(d.sizedArray(DrawIndexedIndirect, MAX_DRAWS), indirectData);

// Frustum planes, refreshed CPU-side each frame.
const frustumData = new Float32Array(6 * 4);
const frustumBuf = createStorageBuffer(Frustum, frustumData);

const arenaStorageR = storage(arenaBuf, 'read');
const chunkInfoStorage = storage(chunkInfoBuf, 'read');
const indirectStorage = storage(indirectBuf, 'read_write');
const frustumStorage = storage(frustumBuf, 'read');

// ─── cull compute ─────────────────────────────────────────────────────────────

const cullCompute = Fn(() => {
    const id = globalId.x;
    If(id.greaterThanEqual(u32(MAX_DRAWS)), () => { Return(); });

    const ci = chunkInfoStorage.element(id).fields();
    const count = ci.quadCount.toVar('count');
    const aabbMin = ci.aabbMin.toVar('aabbMin');
    const aabbMax = ci.aabbMax.toVar('aabbMax');
    const arenaBase = ci.arenaBase.toVar('arenaBase');

    const visible = Var('visible', count.greaterThan(u32(0)));
    for (let i = 0; i < 6; i++) {
        const plane = frustumStorage.field('planes').element(u32(i)).toVar(`plane${i}`);
        const px = plane.x.greaterThanEqual(f32(0)).select(aabbMax.x, aabbMin.x);
        const py = plane.y.greaterThanEqual(f32(0)).select(aabbMax.y, aabbMin.y);
        const pz = plane.z.greaterThanEqual(f32(0)).select(aabbMax.z, aabbMin.z);
        const dist = plane.x.mul(px).add(plane.y.mul(py)).add(plane.z.mul(pz)).add(plane.w);
        If(dist.lessThan(f32(0)), () => { visible.assign(bool(false)); });
    }

    const draw = indirectStorage.element(id).fields();
    draw.indexCount.assign(u32(6));
    draw.instanceCount.assign(visible.select(count, u32(0)));
    draw.firstIndex.assign(u32(0));
    draw.baseVertex.assign(u32(0));
    draw.firstInstance.assign(arenaBase);
}).compute({ workgroupSize: [64, 1, 1] });

// ─── vertex-shader decode tables (must match the mesher's basis) ───────────────

const faceU = wgslFn(`fn faceU(f:u32)->vec3f { var a=array<vec3f,6>(vec3f(0,1,0),vec3f(0,0,1),vec3f(0,0,1),vec3f(1,0,0),vec3f(1,0,0),vec3f(0,1,0)); return a[f]; }`, { output: d.vec3f });
const faceV = wgslFn(`fn faceV(f:u32)->vec3f { var a=array<vec3f,6>(vec3f(0,0,1),vec3f(0,1,0),vec3f(1,0,0),vec3f(0,0,1),vec3f(0,1,0),vec3f(1,0,0)); return a[f]; }`, { output: d.vec3f });
const faceN = wgslFn(`fn faceN(f:u32)->vec3f { var a=array<vec3f,6>(vec3f(1,0,0),vec3f(-1,0,0),vec3f(0,1,0),vec3f(0,-1,0),vec3f(0,0,1),vec3f(0,0,-1)); return a[f]; }`, { output: d.vec3f });
// corner id (0..3) per (diagFlip, vertexInTri 0..5) — two triangulations
const cornerIdx = wgslFn(`fn cornerIdx(flip:u32, v:u32)->u32 { var a=array<u32,12>(0u,1u,2u,0u,2u,3u,0u,1u,3u,1u,2u,3u); return a[flip*6u+v]; }`, { output: d.u32 });
// corner (0..3) -> unit (u,v): 0:(0,0) 1:(1,0) 2:(1,1) 3:(0,1)
const cornerUV = wgslFn(`fn cornerUV(c:u32)->vec2f { var a=array<vec2f,4>(vec2f(0,0),vec2f(1,0),vec2f(1,1),vec2f(0,1)); return a[c]; }`, { output: d.vec2f });
const palette = wgslFn(`fn palette(c:u32)->vec3f { var a=array<vec3f,6>(vec3f(0.50,0.50,0.52),vec3f(0.42,0.30,0.18),vec3f(0.30,0.55,0.22),vec3f(0.55,0.55,0.50),vec3f(0.92,0.94,0.97),vec3f(0.30,0.45,0.70)); return a[min(c,5u)]; }`, { output: d.vec3f });

// ─── material (quad-pull) ──────────────────────────────────────────────────────

const cornerSlot = attribute('cornerSlot', d.f32); // 0..5 (vertex within the unit quad)
const vtx = (cornerSlot as Node<d.f32>).toU32();

const qi = instanceIndex.mul(u32(2));
const geom = index(arenaStorageR, qi) as Node<d.u32>;
const attr = index(arenaStorageR, qi.add(u32(1))) as Node<d.u32>;

const baseX = geom.bitwiseAnd(u32(0x1ff)).toF32();
const baseY = geom.shiftRight(u32(9)).bitwiseAnd(u32(0x7f)).toF32();
const baseZ = geom.shiftRight(u32(16)).bitwiseAnd(u32(0x1ff)).toF32();
const facing = geom.shiftRight(u32(25)).bitwiseAnd(u32(0x7));
const diagFlip = geom.shiftRight(u32(28)).bitwiseAnd(u32(0x1));

const corner = cornerIdx(diagFlip, vtx) as Node<d.u32>;
const uv = cornerUV(corner) as Node<d.vec2f>;
const U = faceU(facing) as Node<d.vec3f>;
const V = faceV(facing) as Node<d.vec3f>;
const N = faceN(facing) as Node<d.vec3f>;

const worldPos = vec3(baseX, baseY, baseZ).add(U.mul(uv.x)).add(V.mul(uv.y));
const clipPos = mul(cameraProjectionMatrix, mul(cameraViewMatrix, vec4(worldPos, f32(1))));

const aoBits = attr.shiftRight(u32(6).add(corner.mul(u32(2)))).bitwiseAnd(u32(0x3));
const aoVal = aoBits.toF32().div(f32(3));
const colorVal = palette(attr.bitwiseAnd(u32(0x3f))) as Node<d.vec3f>;

const vNormal = varying(N, 'v_normal') as Node<d.vec3f>;
const vAO = varying(aoVal, 'v_ao') as Node<d.f32>;
const vColor = varying(colorVal, 'v_color') as Node<d.vec3f>;

const lightDir = vec3(f32(0.6), f32(1.0), f32(0.4)).normalize();
const diffuse = vNormal.dot(lightDir).max(f32(0.2));
const finalColor = vec4(vColor.mul(diffuse).mul(vAO), f32(1));

const material = new Material({ vertex: clipPos, fragment: finalColor });

// unit quad: 6 vertices (one per triangle corner), trivially indexed 0..5
const cornerBuf = createVertexBuffer(d.f32, new Float32Array([0, 1, 2, 3, 4, 5]));
const idxBuf = createIndexBuffer(new Uint32Array([0, 1, 2, 3, 4, 5]));

const geometry = new Geometry();
geometry.setBuffer('cornerSlot', cornerBuf);
geometry.index = idxBuf;
geometry.indirect = indirectBuf;

// ─── CPU mesh cache + GPU page bookkeeping ─────────────────────────────────────

const meshCache: (MeshData | null)[] = new Array(TOTAL_CHUNKS).fill(null);
const chunkAlloc: (OAHandle | null)[] = new Array(TOTAL_CHUNKS).fill(null); // arena range per chunk
const chunkSlot = new Int32Array(TOTAL_CHUNKS).fill(-1);                    // draw slot per chunk

function meshAndCache(world: World, chunkIdx: number): void {
    const chunk = world.chunks[chunkIdx];
    meshCache[chunkIdx] = chunk ? meshChunk(world, chunk) : null;
}

function writeChunkInfo(slot: number, quadCount: number, aabbMin: [number, number, number], aabbMax: [number, number, number], arenaBase: number): void {
    const base = slot * CI_STRIDE;
    chunkInfoData[base + 0] = aabbMin[0];
    chunkInfoData[base + 1] = aabbMin[1];
    chunkInfoData[base + 2] = aabbMin[2];
    new DataView(chunkInfoData.buffer).setUint32((base + 3) * 4, quadCount, true);
    chunkInfoData[base + 4] = aabbMax[0];
    chunkInfoData[base + 5] = aabbMax[1];
    chunkInfoData[base + 6] = aabbMax[2];
    new DataView(chunkInfoData.buffer).setUint32((base + 7) * 4, arenaBase, true);
}

let gpuDirty = false;

function uploadChunk(chunkIdx: number): void {
    const data = meshCache[chunkIdx];
    if (!data) return;

    // one exact-fit arena allocation + one draw slot for the whole chunk
    const handle = oaAllocate(arena, data.quadCount);
    if (!handle) { console.warn('voxels: arena out of space'); return; }
    const slot = allocSlot();
    if (slot < 0) { oaFree(arena, handle); console.warn('voxels: out of draw slots'); return; }

    chunkAlloc[chunkIdx] = handle;
    chunkSlot[chunkIdx] = slot;

    const dst = handle.offset * 2;
    arenaBuf.array!.set(data.quads, dst);
    arenaBuf.addUpdateRange(dst, data.quadCount * 2);

    writeChunkInfo(slot, data.quadCount, data.aabbMin, data.aabbMax, handle.offset);
    chunkInfoBuf.addUpdateRange(slot * CI_STRIDE, CI_STRIDE);
    gpuDirty = true;
}

function unloadChunk(chunkIdx: number): void {
    const handle = chunkAlloc[chunkIdx];
    const slot = chunkSlot[chunkIdx];
    if (handle) oaFree(arena, handle);
    if (slot >= 0) {
        writeChunkInfo(slot, 0, [0, 0, 0], [0, 0, 0], 0);
        chunkInfoBuf.addUpdateRange(slot * CI_STRIDE, CI_STRIDE);
        freeDrawSlot(slot);
    }
    chunkAlloc[chunkIdx] = null;
    chunkSlot[chunkIdx] = -1;
    gpuDirty = true;
}

function flushGPU(): void {
    if (!gpuDirty) return;
    arenaBuf.needsUpdate = true;
    chunkInfoBuf.needsUpdate = true;
    gpuDirty = false;
}

// ─── editing ──────────────────────────────────────────────────────────────────

function remeshForEdit(world: World, chunkIdx: number): void {
    if (chunkSlot[chunkIdx] >= 0) unloadChunk(chunkIdx);
    meshAndCache(world, chunkIdx);
    uploadChunk(chunkIdx);
    flushGPU();
}

function addChunkIfValid(set: Set<number>, cx: number, cy: number, cz: number): void {
    if (cx >= 0 && cx < WORLD_CHUNKS_X && cy >= 0 && cy < WORLD_CHUNKS_Y && cz >= 0 && cz < WORLD_CHUNKS_Z)
        set.add(worldChunkIndex(cx, cy, cz));
}

function applyBrush(world: World, wx: number, wy: number, wz: number, type: number): void {
    const r = BRUSH_RADIUS, r2 = r * r;
    const affected = new Set<number>();
    for (let dz = -r; dz <= r; dz++) {
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (dx * dx + dy * dy + dz * dz > r2) continue;
                const vx = wx + dx, vy = wy + dy, vz = wz + dz;
                setVoxel(world, vx, vy, vz, type);
                const cx = Math.floor(vx / CHUNK_SIZE), cy = Math.floor(vy / CHUNK_SIZE), cz = Math.floor(vz / CHUNK_SIZE);
                if (cx < 0 || cx >= WORLD_CHUNKS_X || cy < 0 || cy >= WORLD_CHUNKS_Y || cz < 0 || cz >= WORLD_CHUNKS_Z) continue;
                affected.add(worldChunkIndex(cx, cy, cz));
                const lx = vx - cx * CHUNK_SIZE, ly = vy - cy * CHUNK_SIZE, lz = vz - cz * CHUNK_SIZE;
                if (lx === 0) addChunkIfValid(affected, cx - 1, cy, cz);
                if (lx === CHUNK_SIZE - 1) addChunkIfValid(affected, cx + 1, cy, cz);
                if (ly === 0) addChunkIfValid(affected, cx, cy - 1, cz);
                if (ly === CHUNK_SIZE - 1) addChunkIfValid(affected, cx, cy + 1, cz);
                if (lz === 0) addChunkIfValid(affected, cx, cy, cz - 1);
                if (lz === CHUNK_SIZE - 1) addChunkIfValid(affected, cx, cy, cz + 1);
            }
        }
    }
    for (const idx of affected) remeshForEdit(world, idx);
}

// ─── DDA raycast ───────────────────────────────────────────────────────────────

type RaycastHit = { wx: number; wy: number; wz: number; nx: number; ny: number; nz: number } | null;

function raycastVoxels(world: World, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): RaycastHit {
    let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = Math.abs(1 / dx), tDeltaY = Math.abs(1 / dy), tDeltaZ = Math.abs(1 / dz);
    let tMaxX = dx !== 0 ? (dx > 0 ? x + 1 - ox : ox - x) * tDeltaX : Infinity;
    let tMaxY = dy !== 0 ? (dy > 0 ? y + 1 - oy : oy - y) * tDeltaY : Infinity;
    let tMaxZ = dz !== 0 ? (dz > 0 ? z + 1 - oz : oz - z) * tDeltaZ : Infinity;
    let nx = 0, ny = 0, nz = 0, dist = 0;
    while (dist < maxDist) {
        if (getVoxel(world, x, y, z) !== VOXEL_AIR) return { wx: x, wy: y, wz: z, nx, ny, nz };
        if (tMaxX < tMaxY && tMaxX < tMaxZ) { x += stepX; dist = tMaxX; tMaxX += tDeltaX; nx = -stepX; ny = 0; nz = 0; }
        else if (tMaxY < tMaxZ) { y += stepY; dist = tMaxY; tMaxY += tDeltaY; nx = 0; ny = -stepY; nz = 0; }
        else { z += stepZ; dist = tMaxZ; tMaxZ += tDeltaZ; nx = 0; ny = 0; nz = -stepZ; }
    }
    return null;
}

// ─── frustum update ─────────────────────────────────────────────────────────────

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

// ─── main ───────────────────────────────────────────────────────────────────────

async function main() {
    initSlots();

    const renderer = new WebGPURenderer({ antialias: true });
    const inspector = new Inspector();
    renderer.inspector = inspector;
    await renderer.init();

    document.body.appendChild(renderer.domElement);
    document.body.appendChild(inspector.domElement);
    renderer.setPixelRatio(devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.clearColor = [0.53, 0.80, 0.92, 1];

    const statsEl = document.createElement('div');
    statsEl.style.cssText = 'position:fixed;top:8px;left:8px;background:rgba(0,0,0,0.7);color:#fff;padding:8px 12px;font:12px/1.5 monospace;border-radius:4px;pointer-events:none;z-index:100;';
    document.body.appendChild(statsEl);

    const scene = new Scene();
    const camera = new PerspectiveCamera(Math.PI / 4, window.innerWidth / window.innerHeight, 0.1, 2000);
    camera.position[0] = WORLD_VX / 2;
    camera.position[1] = WORLD_VY * 0.9;
    camera.position[2] = WORLD_VZ / 2 + WORLD_VZ * 0.6;
    scene.add(camera);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target[0] = WORLD_VX / 2;
    controls.target[1] = WORLD_VY * 0.25;
    controls.target[2] = WORLD_VZ / 2;
    controls.enableDamping = true;
    controls.update();

    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth, window.innerHeight);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    });

    const world = createWorld();
    inspector.perf.start('terrain-gen');
    generateTerrain(world);
    inspector.perf.end('terrain-gen');

    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    scene.add(mesh);

    await renderer.compileCompute(cullCompute);

    const scenePass = pass(scene, camera);
    const renderPipeline = new RenderPipeline(renderer, renderOutput(scenePass.getTextureNode()));

    inspector.perf.start('initial-meshing');
    for (let i = 0; i < TOTAL_CHUNKS; i++) meshAndCache(world, i);
    inspector.perf.end('initial-meshing');

    inspector.perf.start('initial-upload');
    for (let i = 0; i < TOTAL_CHUNKS; i++) if (meshCache[i]) uploadChunk(i);
    flushGPU();
    inspector.perf.end('initial-upload');

    function getRayFromScreen(clientX: number, clientY: number) {
        const rect = renderer.domElement.getBoundingClientRect();
        const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
        const ndcY = ((clientY - rect.top) / rect.height) * -2 + 1;
        const tanHalfFov = Math.tan(camera.fov / 2);
        const vx = ndcX * tanHalfFov * camera.aspect, vy = ndcY * tanHalfFov, vz = -1;
        const m = camera.matrix;
        const dx = m[0] * vx + m[4] * vy + m[8] * vz;
        const dy = m[1] * vx + m[5] * vy + m[9] * vz;
        const dz = m[2] * vx + m[6] * vy + m[10] * vz;
        const len = Math.hypot(dx, dy, dz);
        return { ox: camera.position[0], oy: camera.position[1], oz: camera.position[2], dx: dx / len, dy: dy / len, dz: dz / len };
    }

    renderer.domElement.addEventListener('mousedown', (e) => {
        if (e.button !== 0 && e.button !== 2) return;
        const ray = getRayFromScreen(e.clientX, e.clientY);
        const hit = raycastVoxels(world, ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz, 1024);
        if (!hit) return;
        if (e.button === 2) applyBrush(world, hit.wx + hit.nx, hit.wy + hit.ny, hit.wz + hit.nz, VOXEL_SOLID);
        else applyBrush(world, hit.wx, hit.wy, hit.wz, VOXEL_AIR);
    });
    renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

    let frameCount = 0;
    function frame() {
        controls.update();
        scene.updateWorldMatrix();
        camera.updateViewMatrix();
        updateFrustum(camera);

        renderer.compute([{ node: cullCompute, dispatch: [Math.ceil(MAX_DRAWS / 64), 1, 1] }]);
        renderPipeline.render();

        if (++frameCount % 30 === 0) {
            let chunksLoaded = 0;
            for (let i = 0; i < TOTAL_CHUNKS; i++) if (chunkSlot[i] >= 0) chunksLoaded++;
            const usedQuads = ARENA_QUADS - oaStorageReport(arena).totalFree;
            statsEl.textContent =
                `arena: ${(usedQuads / 1000).toFixed(0)}k/${(ARENA_QUADS / 1000).toFixed(0)}k quads  ` +
                `chunks: ${chunksLoaded}/${TOTAL_CHUNKS}  slots: ${MAX_DRAWS - slotHead}/${MAX_DRAWS}`;
        }
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
}

main();
