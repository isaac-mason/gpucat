import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createIndexBuffer,
    createVertexBuffer,
    d,
    Geometry,
    Inspector,
    Material,
    Mesh,
    mul,
    OrbitControls,
    pass,
    PerspectiveCamera,
    Scene,
    vec4,
    WebGPURenderer,
    f32,
    vec3,
    varying,
    type Node,
    RenderPipeline,
    renderOutput,
} from 'gpucat';
import { createSimplex2D } from 'mathcat';

// ─── world constants ──────────────────────────────────────────────────────────

const CHUNK_BITS = 4;
const CHUNK_SIZE = 1 << CHUNK_BITS; // 16
const CHUNK_VOXELS = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE;

const WORLD_CHUNKS_X = 12;
const WORLD_CHUNKS_Z = 12;
const WORLD_CHUNKS_Y = 4;

// ─── voxel types ─────────────────────────────────────────────────────────────

const VOXEL_AIR = 0;
const VOXEL_SOLID = 1;

// ─── chunk data ───────────────────────────────────────────────────────────────

type Chunk = {
    cx: number;
    cy: number;
    cz: number;
    voxels: Uint8Array;
};

function createChunk(cx: number, cy: number, cz: number): Chunk {
    return { cx, cy, cz, voxels: new Uint8Array(CHUNK_VOXELS) };
}

function chunkVoxelIndex(lx: number, ly: number, lz: number): number {
    return lz * CHUNK_SIZE * CHUNK_SIZE + ly * CHUNK_SIZE + lx;
}

// ─── world ────────────────────────────────────────────────────────────────────

type World = {
    chunks: (Chunk | null)[];
    chunksX: number;
    chunksY: number;
    chunksZ: number;
};

function createWorld(chunksX: number, chunksY: number, chunksZ: number): World {
    return {
        chunks: new Array<Chunk | null>(chunksX * chunksY * chunksZ).fill(null),
        chunksX,
        chunksY,
        chunksZ,
    };
}

function worldChunkIndex(world: World, cx: number, cy: number, cz: number): number {
    return cz * world.chunksY * world.chunksX + cy * world.chunksX + cx;
}

function getVoxel(world: World, wx: number, wy: number, wz: number): number {
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cy = Math.floor(wy / CHUNK_SIZE);
    const cz = Math.floor(wz / CHUNK_SIZE);

    if (cx < 0 || cx >= world.chunksX) return VOXEL_AIR;
    if (cy < 0 || cy >= world.chunksY) return VOXEL_AIR;
    if (cz < 0 || cz >= world.chunksZ) return VOXEL_AIR;

    const chunk = world.chunks[worldChunkIndex(world, cx, cy, cz)];
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

    if (cx < 0 || cx >= world.chunksX) return;
    if (cy < 0 || cy >= world.chunksY) return;
    if (cz < 0 || cz >= world.chunksZ) return;

    const idx = worldChunkIndex(world, cx, cy, cz);
    let chunk = world.chunks[idx];
    if (!chunk) {
        chunk = createChunk(cx, cy, cz);
        world.chunks[idx] = chunk;
    }

    const lx = wx - cx * CHUNK_SIZE;
    const ly = wy - cy * CHUNK_SIZE;
    const lz = wz - cz * CHUNK_SIZE;

    chunk.voxels[chunkVoxelIndex(lx, ly, lz)] = type;
}

// ─── procgen ─────────────────────────────────────────────────────────────────

function fbm2D(
    noise: (x: number, y: number) => number,
    x: number,
    y: number,
    octaves: number,
    lacunarity = 2.0,
    gain = 0.5,
): number {
    let value = 0;
    let amplitude = 1.0;
    let frequency = 1.0;
    let normalization = 0;

    for (let i = 0; i < octaves; i++) {
        value += noise(x * frequency, y * frequency) * amplitude;
        normalization += amplitude;
        amplitude *= gain;
        frequency *= lacunarity;
    }

    return value / normalization;
}

function generateTerrain(world: World): void {
    const noise = createSimplex2D(42);

    const worldVoxelsX = world.chunksX * CHUNK_SIZE;
    const worldVoxelsZ = world.chunksZ * CHUNK_SIZE;
    const worldVoxelsY = world.chunksY * CHUNK_SIZE;

    const terrainScale = 0.025;
    const terrainHeightMin = 4;
    const terrainHeightMax = worldVoxelsY - 4;

    for (let wx = 0; wx < worldVoxelsX; wx++) {
        for (let wz = 0; wz < worldVoxelsZ; wz++) {
            const n = fbm2D(noise, wx * terrainScale, wz * terrainScale, 5);
            // n is [-1, 1], remap to [terrainHeightMin, terrainHeightMax]
            const height = Math.floor(
                terrainHeightMin + ((n + 1) * 0.5) * (terrainHeightMax - terrainHeightMin),
            );

            for (let wy = 0; wy < height; wy++) {
                setVoxel(world, wx, wy, wz, VOXEL_SOLID);
            }
        }
    }
}

// ─── mesher ───────────────────────────────────────────────────────────────────

// direction vectors for the two tangent axes of each face
const DIRECTION_VECTORS: number[][][] = new Array(3);
for (let i = 0; i < 3; ++i) {
    DIRECTION_VECTORS[i] = [[0, 0, 0], [0, 0, 0]];
    DIRECTION_VECTORS[i][0][(i + 1) % 3] = 1;
    DIRECTION_VECTORS[i][1][(i + 2) % 3] = 1;
}

const FACE_NORMALS: [number, number, number][] = [
    [1, 0, 0],   // EAST  (axis=X, side=CURRENT)
    [-1, 0, 0],  // WEST  (axis=X, side=NEXT)
    [0, 1, 0],   // UP    (axis=Y, side=CURRENT)
    [0, -1, 0],  // DOWN  (axis=Y, side=NEXT)
    [0, 0, 1],   // SOUTH (axis=Z, side=CURRENT)
    [0, 0, -1],  // NORTH (axis=Z, side=NEXT)
];

// axis→[side_current_face_idx, side_next_face_idx]
const FACE_BY_AXIS_SIDE = [[0, 1], [2, 3], [4, 5]];

// AO: given two edge-adjacent voxels and a corner, compute vertex darkness [0..1]
function vertexAO(side1: number, side2: number, corner: number): number {
    if (side1 !== 0 && side2 !== 0) return 0;
    return (3 - (side1 + side2 + corner)) / 3;
}

// sample a voxel relative to the chunk, falling back to the world for neighbours
function getVoxelRelativeToChunk(
    world: World,
    chunk: Chunk,
    lx: number,
    ly: number,
    lz: number,
): number {
    if (lx >= 0 && lx < CHUNK_SIZE && ly >= 0 && ly < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE) {
        return chunk.voxels[chunkVoxelIndex(lx, ly, lz)];
    }
    const wx = chunk.cx * CHUNK_SIZE + lx;
    const wy = chunk.cy * CHUNK_SIZE + ly;
    const wz = chunk.cz * CHUNK_SIZE + lz;
    return getVoxel(world, wx, wy, wz);
}

type MeshData = {
    positions: Float32Array;
    normals: Float32Array;
    ao: Float32Array;
    indices: Uint32Array;
};

const _aoGrid = new Uint8Array(9);

function meshChunk(world: World, chunk: Chunk): MeshData | null {
    const positions: number[] = [];
    const normals: number[] = [];
    const ao: number[] = [];
    const indices: number[] = [];

    for (let x = -1; x < CHUNK_SIZE; x++) {
        for (let z = -1; z < CHUNK_SIZE; z++) {
            for (let y = -1; y < CHUNK_SIZE; y++) {
                const currentSolid = getVoxelRelativeToChunk(world, chunk, x, y, z) !== VOXEL_AIR;

                for (let dir = 0; dir < 3; dir++) {
                    const nx = x + (dir === 0 ? 1 : 0);
                    const ny = y + (dir === 1 ? 1 : 0);
                    const nz = z + (dir === 2 ? 1 : 0);

                    const neighbourSolid = getVoxelRelativeToChunk(world, chunk, nx, ny, nz) !== VOXEL_AIR;

                    if (currentSolid === neighbourSolid) continue;

                    // side=0: face belongs to current block (solid→air), side=1: belongs to neighbour (air→solid)
                    const side = currentSolid ? 0 : 1;

                    const bx = x + (dir === 0 ? side : 0);
                    const by = y + (dir === 1 ? side : 0);
                    const bz = z + (dir === 2 ? side : 0);

                    // only emit faces for voxels inside this chunk
                    if (bx < 0 || bx >= CHUNK_SIZE) continue;
                    if (by < 0 || by >= CHUNK_SIZE) continue;
                    if (bz < 0 || bz >= CHUNK_SIZE) continue;

                    const faceIdx = FACE_BY_AXIS_SIDE[dir][side];
                    const [dx, dy, dz] = FACE_NORMALS[faceIdx];
                    const [ux, uy, uz] = DIRECTION_VECTORS[dir][side];
                    const [vx, vy, vz] = DIRECTION_VECTORS[dir][side ^ 1];

                    // world-space origin of the face quad (the neighbour corner touching this face)
                    const qx = chunk.cx * CHUNK_SIZE + nx;
                    const qy = chunk.cy * CHUNK_SIZE + ny;
                    const qz = chunk.cz * CHUNK_SIZE + nz;

                    // four vertices of the quad
                    const v0x = qx,        v0y = qy,        v0z = qz;
                    const v1x = qx + ux,   v1y = qy + uy,   v1z = qz + uz;
                    const v2x = qx + ux + vx, v2y = qy + uy + vy, v2z = qz + uz + vz;
                    const v3x = qx + vx,   v3y = qy + vy,   v3z = qz + vz;

                    // ── AO grid: 3×3 kernel one step out along the face normal ──
                    // p is the face-block position in local chunk coords
                    // We sample the 3×3 ring of neighbours displaced by (dx,dy,dz)
                    let aoGridIdx = 0;
                    for (let q = -1; q < 2; q++) {
                        for (let p = -1; p < 2; p++) {
                            const sax = bx + dx + ux * p + vx * q;
                            const say = by + dy + uy * p + vy * q;
                            const saz = bz + dz + uz * p + vz * q;
                            _aoGrid[aoGridIdx++] = getVoxelRelativeToChunk(world, chunk, sax, say, saz) !== VOXEL_AIR ? 1 : 0;
                        }
                    }

                    // grid layout (p=col, q=row):
                    //  0 1 2
                    //  3 4 5
                    //  6 7 8
                    // vertex order matches: v0=corner(-1,-1), v1=corner(+1,-1), v2=corner(+1,+1), v3=corner(-1,+1)
                    const ao00 = vertexAO(_aoGrid[3], _aoGrid[1], _aoGrid[0]);
                    const ao10 = vertexAO(_aoGrid[1], _aoGrid[5], _aoGrid[2]);
                    const ao11 = vertexAO(_aoGrid[5], _aoGrid[7], _aoGrid[8]);
                    const ao01 = vertexAO(_aoGrid[3], _aoGrid[7], _aoGrid[6]);

                    const base = positions.length / 3;

                    positions.push(v0x, v0y, v0z);
                    positions.push(v1x, v1y, v1z);
                    positions.push(v2x, v2y, v2z);
                    positions.push(v3x, v3y, v3z);

                    normals.push(dx, dy, dz, dx, dy, dz, dx, dy, dz, dx, dy, dz);

                    ao.push(ao00, ao10, ao11, ao01);

                    // flip diagonal based on AO to avoid interpolation artifacts
                    // (https://0fps.net/2013/07/03/ambient-occlusion-for-minecraft-like-worlds/)
                    if (ao00 + ao11 > ao10 + ao01) {
                        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
                    } else {
                        indices.push(base, base + 1, base + 3, base + 1, base + 2, base + 3);
                    }
                }
            }
        }
    }

    if (indices.length === 0) return null;

    return {
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        ao: new Float32Array(ao),
        indices: new Uint32Array(indices),
    };
}

// ─── build gpucat Geometry from mesh data ─────────────────────────────────────

function buildGeometry(meshData: MeshData): Geometry {
    const geom = new Geometry();
    geom.setBuffer('position', createVertexBuffer(d.vec3f, meshData.positions));
    geom.setBuffer('normal', createVertexBuffer(d.vec3f, meshData.normals));
    geom.setBuffer('ao', createVertexBuffer(d.f32, meshData.ao));
    geom.index = createIndexBuffer(meshData.indices);
    geom.vertexCount = meshData.positions.length / 3;
    return geom;
}

// ─── material ─────────────────────────────────────────────────────────────────

const posAttr = attribute('position', d.vec3f);
const normalAttr = attribute('normal', d.vec3f);
const aoAttr = attribute('ao', d.f32);

const vNormal = varying(normalAttr, 'v_normal');
const vAO = varying(aoAttr, 'v_ao');

const clipPos = mul(
    cameraProjectionMatrix,
    mul(cameraViewMatrix, vec4(posAttr, f32(1))),
);

// simple diffuse + AO
const lightDir = vec3(f32(0.6), f32(1.0), f32(0.4)).normalize().toVar('lightDir');
const diffuse = vNormal.dot(lightDir).max(f32(0.15)).toVar('diffuse');

// stone-ish grey, modulated by diffuse and AO
const baseColor = vec3(f32(0.55), f32(0.52), f32(0.50));
const shadedColor = baseColor.mul(diffuse).mul(vAO);
const finalColor = vec4(shadedColor, f32(1));

const material = new Material({ vertex: clipPos, fragment: finalColor });

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
    const renderer = new WebGPURenderer({ antialias: true });
    const inspector = new Inspector();
    renderer.inspector = inspector;
    await renderer.init();

    document.body.appendChild(renderer.domElement);
    document.body.appendChild(inspector.domElement);
    renderer.setPixelRatio(devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);

    renderer.clearColor = [0.53, 0.80, 0.92, 1];

    const scene = new Scene();

    const camera = new PerspectiveCamera(
        Math.PI / 4,
        window.innerWidth / window.innerHeight,
        0.1,
        1000,
    );
    camera.position[0] = (WORLD_CHUNKS_X * CHUNK_SIZE) / 2;
    camera.position[1] = WORLD_CHUNKS_Y * CHUNK_SIZE * 0.75;
    camera.position[2] = WORLD_CHUNKS_Z * CHUNK_SIZE * 1.2;
    scene.add(camera);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target[0] = (WORLD_CHUNKS_X * CHUNK_SIZE) / 2;
    controls.target[1] = (WORLD_CHUNKS_Y * CHUNK_SIZE) / 4;
    controls.target[2] = (WORLD_CHUNKS_Z * CHUNK_SIZE) / 2;
    controls.enableDamping = true;
    controls.update();

    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth, window.innerHeight);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    });

    // generate terrain
    const world = createWorld(WORLD_CHUNKS_X, WORLD_CHUNKS_Y, WORLD_CHUNKS_Z);
    generateTerrain(world);

    // mesh each chunk and add to scene
    for (let cz = 0; cz < world.chunksZ; cz++) {
        for (let cy = 0; cy < world.chunksY; cy++) {
            for (let cx = 0; cx < world.chunksX; cx++) {
                const chunk = world.chunks[worldChunkIndex(world, cx, cy, cz)];
                if (!chunk) continue;

                const meshData = meshChunk(world, chunk);
                if (!meshData) continue;

                const geom = buildGeometry(meshData);
                const mesh = new Mesh(geom, material);
                scene.add(mesh);
            }
        }
    }

    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    const scenePass = pass(scene, camera);
    const outputNode = renderOutput(scenePass.getTextureNode());
    const renderPipeline = new RenderPipeline(renderer, outputNode);

    function frame() {
        controls.update();
        camera.updateViewMatrix();
        renderer.beginFrame();
        renderPipeline.render();
        renderer.endFrame();
        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

main();
