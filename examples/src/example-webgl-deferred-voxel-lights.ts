import {
    abs,
    attribute,
    BufferLifecycle,
    cameraProjectionMatrix,
    cameraViewMatrix,
    clamp,
    comparisonSampler,
    countTrailingZeros,
    createCanvasTarget,
    createDataTexture,
    createMaterial,
    createRenderTarget,
    createVertexBuffer,
    Discard,
    d,
    depthTexture,
    dot,
    Fn,
    f32,
    floor,
    frame,
    fullscreen,
    Geometry,
    GpuBuffer,
    GpuSampler,
    If,
    init,
    invariant,
    Loop,
    length,
    type Material,
    Mesh,
    mat4 as mat4Node,
    min,
    mix,
    mrt,
    mul,
    type Node,
    ndcDepthToStorage,
    normalize,
    OrbitControls,
    OrthographicCamera,
    type Pass,
    PerspectiveCamera,
    screenCoordinate,
    select,
    smoothstep,
    storage,
    struct,
    type Texture,
    targetColor,
    targetDepth,
    texture,
    textureSampleCompareLevel,
    Uniform,
    u32,
    uniform,
    Var,
    varying,
    vec2,
    vec2i,
    vec3,
    vec4,
    vertexCountGeometry,
    vertexIndex,
    While,
    webgl,
} from 'gpucat';
import GUI from 'lil-gui';
import { mat4, type Vec3 } from 'math';
import { type Box3, frustum } from 'math/shapes';

// A stress scene shaped like a voxel game's frame, to compare ways of lighting it, mirroring bongle's renderer: a forest
// of block terrain meshed a face at a time (no greedy meshing), its leaf canopies keeping the faces between their
// blocks so the eye looks through layer on layer of cutout; cutout grass; 18,850 cutout billboard sprites; 2,000 small
// block models; the world in columns, frustum culled for every view. Every pixel takes a voxel game's shading: a
// pixel-art texture, per-vertex ambient occlusion, the light volume sampled where the surface sits, the sun's warped
// shadow map with four filtered taps, fog, and point lights.
//
// Point lights are found as a clustered forward renderer finds them, so every path reads the same lists with no
// prepass of its own: each 32-pixel tile holds a bit for every light whose sphere's screen box reaches it, and each
// slice of view depth the range of lights, sorted by depth, that reach it. The most important SHADOWED_LIGHTS of them
// cast shadows from cube maps in one atlas, at most SHADOW_REDRAWS of whose faces are drawn again a frame, the others
// keeping the map they last drew; the rest are unshadowed.
//
// The same scene and shading, drawn three ways:
// - forward: each fragment drawn is shaded, those drawn over later too.
// - prepass: depth first (cutout testing its alpha), then colour testing equal to it, so each pixel is shaded once,
//   at the cost of drawing everything twice.
// - deferred, after HypeHype's mobile renderer: one geometry pass writes a 64-bit G-buffer (albedo and occlusion;
//   normal), one fullscreen pass does all the shading from it.

const WORLD_X = 192;
const WORLD_Y = 48;
const WORLD_Z = 192;
const TILE = 32;
const MAX_LIGHTS = 256;
const LIGHT_WORDS = MAX_LIGHTS / 32;
/** view depth slices the lights are binned into, out to LIGHT_FAR */
const DEPTH_BINS = 128;
const LIGHT_FAR = 160;
/** the point lights' shadow atlas, a slot a cube face */
const SHADOW_ATLAS = 2048;
const SHADOW_SLOT = 256;
const SHADOW_SLOTS_ACROSS = SHADOW_ATLAS / SHADOW_SLOT;
/** shadow views a frame at most, as bongle's: SHADOWED_LIGHTS lights of six faces each */
const MAX_SHADOW_VIEWS = 32;
const SHADOWED_LIGHTS = Math.floor(MAX_SHADOW_VIEWS / 6);
/** shadow views drawn again a frame at most, as bongle's standard tier */
const SHADOW_REDRAWS = 8;
const SHADOW_NEAR = 0.05;
const NEAR = 0.1;
const FAR = 400;
const SUN_MAP = 2048;
const SUN_REACH = 128;
const SUN_WARP = 0.85;
const FOG_START = 60;
const FOG_END = 180;
const MODELS = 2000;
const SPRITES = 18850;

const AIR = 0;
const GRASS = 1;
const DIRT = 2;
const STONE = 3;
const WOOD = 4;
const LEAVES = 5;
const BRICK = 6;
/** atlas tiles: one a block, then grass blades and the models' skin */
const TILE_GRASS_BLADES = 7;
const TILE_SKIN = 8;
const TILE_FLOWER = 9;
const ATLAS_TILES = 10;

// ─── Renderer ───────────────────────────────────────────────────────────────

const SKY_DAY: Vec3 = [0.55, 0.7, 0.9];
const SKY_NIGHT: Vec3 = [0.02, 0.03, 0.06];

const canvas = document.createElement('canvas');
canvas.style.display = 'block';
document.body.appendChild(canvas);

const view = createCanvasTarget(canvas, { clearColor: [SKY_DAY[0], SKY_DAY[1], SKY_DAY[2], 1] });
view.setPixelRatio(devicePixelRatio);
view.setSize(window.innerWidth, window.innerHeight);

const renderer = await init(webgl({ target: view }));

const camera = new PerspectiveCamera(Math.PI / 2.6, window.innerWidth / window.innerHeight, NEAR, FAR);
const controls = new OrbitControls(camera, canvas);

/** where the camera looks from, to compare like with like */
const VIEWS: Record<string, { from: Vec3; at: Vec3 }> = {
    'forest floor': { from: [70, 12, 70], at: [110, 11, 100] },
    overhead: { from: [40, 70, 40], at: [100, 10, 100] },
};
function setView(name: string): void {
    camera.position = [...VIEWS[name].from];
    controls.target = [...VIEWS[name].at];
}
setView('forest floor');

/** the G-buffer: albedo and occlusion; normal (octahedral), two channels spare; and depth */
const gbuffer = createRenderTarget(1, 1, { colorFormat: 'rgba8unorm', count: 2, depthSampled: true, label: 'gbuffer' });

function resize(): void {
    view.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    gbuffer.setSize(canvas.width, canvas.height);
}
window.addEventListener('resize', resize);
resize();

// ─── The world ──────────────────────────────────────────────────────────────

const blocks = new Uint8Array(WORLD_X * WORLD_Y * WORLD_Z);
const blockIndex = (x: number, y: number, z: number) => x + z * WORLD_X + y * WORLD_X * WORLD_Z;
const inWorld = (x: number, y: number, z: number) => x >= 0 && y >= 0 && z >= 0 && x < WORLD_X && y < WORLD_Y && z < WORLD_Z;
const blockAt = (x: number, y: number, z: number) => (inWorld(x, y, z) ? blocks[blockIndex(x, y, z)] : AIR);
const setBlock = (x: number, y: number, z: number, block: number) => {
    if (inWorld(x, y, z)) blocks[blockIndex(x, y, z)] = block;
};

let seed = 11;
function random(): number {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
}

const ground = (x: number, z: number) =>
    Math.floor(8 + 3 * Math.sin(x * 0.07) + 2.5 * Math.cos(z * 0.09) + 2 * Math.sin((x + z) * 0.04));

for (let x = 0; x < WORLD_X; x++) {
    for (let z = 0; z < WORLD_Z; z++) {
        const top = ground(x, z);
        for (let y = 0; y <= top; y++) setBlock(x, y, z, y === top ? GRASS : y > top - 3 ? DIRT : STONE);
    }
}
for (let i = 0; i < 14; i++) {
    const x0 = 8 + Math.floor(random() * (WORLD_X - 24));
    const z0 = 8 + Math.floor(random() * (WORLD_Z - 24));
    const w = 6 + Math.floor(random() * 5);
    const l = 6 + Math.floor(random() * 5);
    const floorY = ground(x0, z0) + 1;
    for (let x = x0; x < x0 + w; x++) {
        for (let z = z0; z < z0 + l; z++) {
            for (let y = floorY - 1; y < floorY + 5; y++) {
                const wall = x === x0 || x === x0 + w - 1 || z === z0 || z === z0 + l - 1;
                setBlock(x, y, z, y === floorY - 1 ? STONE : wall ? BRICK : AIR);
            }
            setBlock(x, floorY + 5, z, STONE);
        }
    }
    setBlock(x0 + Math.floor(w / 2), floorY, z0, AIR);
    setBlock(x0 + Math.floor(w / 2), floorY + 1, z0, AIR);
}
// a dense forest: trunks under wide canopies whose leaves keep the faces between them
for (let gx = 2; gx < WORLD_X - 2; gx += 5) {
    for (let gz = 2; gz < WORLD_Z - 2; gz += 5) {
        if (random() < 0.3) continue;
        const x = gx + Math.floor(random() * 3);
        const z = gz + Math.floor(random() * 3);
        const y0 = ground(x, z) + 1;
        if (blockAt(x, y0, z) !== AIR || blockAt(x, y0 - 1, z) !== GRASS) continue;
        const trunk = 4 + Math.floor(random() * 4);
        for (let y = y0; y < y0 + trunk; y++) setBlock(x, y, z, WOOD);
        const radius = 2 + Math.floor(random() * 2);
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dz = -radius; dz <= radius; dz++) {
                for (let dy = -1; dy <= 3; dy++) {
                    if (dx * dx + dz * dz + dy * dy * 1.5 > radius * radius + 1) continue;
                    const at: Vec3 = [x + dx, y0 + trunk + dy, z + dz];
                    if (blockAt(at[0], at[1], at[2]) === AIR) setBlock(at[0], at[1], at[2], LEAVES);
                }
            }
        }
    }
}

/** the column's top solid block, for sky light */
const columnTop = new Int16Array(WORLD_X * WORLD_Z).fill(-1);
for (let x = 0; x < WORLD_X; x++) {
    for (let z = 0; z < WORLD_Z; z++) {
        for (let y = WORLD_Y - 1; y >= 0; y--) {
            if (blockAt(x, y, z) !== AIR) {
                columnTop[x + z * WORLD_X] = y;
                break;
            }
        }
    }
}
/** 1 under open sky, less under leaves and roofs */
const skyAt = (x: number, y: number, z: number) => {
    if (x < 0 || z < 0 || x >= WORLD_X || z >= WORLD_Z) return 1;
    return y > columnTop[x + z * WORLD_X] ? 1 : 0.45;
};

// ─── Meshes: a face a quad, no faces merged ─────────────────────────────────

type Parts = { position: number[]; uvTile: number[]; normal: number[]; shade: number[] };
const newParts = (): Parts => ({ position: [], uvTile: [], normal: [], shade: [] });

const FACES: { n: Vec3; corners: Vec3[] }[] = [
    {
        n: [1, 0, 0],
        corners: [
            [1, 0, 1],
            [1, 0, 0],
            [1, 1, 0],
            [1, 1, 1],
        ],
    },
    {
        n: [-1, 0, 0],
        corners: [
            [0, 0, 0],
            [0, 0, 1],
            [0, 1, 1],
            [0, 1, 0],
        ],
    },
    {
        n: [0, 1, 0],
        corners: [
            [0, 1, 1],
            [1, 1, 1],
            [1, 1, 0],
            [0, 1, 0],
        ],
    },
    {
        n: [0, -1, 0],
        corners: [
            [0, 0, 0],
            [1, 0, 0],
            [1, 0, 1],
            [0, 0, 1],
        ],
    },
    {
        n: [0, 0, 1],
        corners: [
            [0, 0, 1],
            [1, 0, 1],
            [1, 1, 1],
            [0, 1, 1],
        ],
    },
    {
        n: [0, 0, -1],
        corners: [
            [1, 0, 0],
            [0, 0, 0],
            [0, 1, 0],
            [1, 1, 0],
        ],
    },
];
const QUAD_UVS = [
    [0, 1],
    [1, 1],
    [1, 0],
    [0, 0],
];
const opaqueBlock = (block: number) => block !== AIR && block !== LEAVES;

/** the world in columns of COLUMN x COLUMN blocks, each its own meshes, culled by its box */
const COLUMN = 16;
const COLUMNS_X = WORLD_X / COLUMN;
const COLUMNS_Z = WORLD_Z / COLUMN;
const columnOf = (x: number, z: number) => Math.floor(x / COLUMN) + Math.floor(z / COLUMN) * COLUMNS_X;
const opaqueParts = Array.from({ length: COLUMNS_X * COLUMNS_Z }, newParts);
const cutoutParts = Array.from({ length: COLUMNS_X * COLUMNS_Z }, newParts);

for (let y = 0; y < WORLD_Y; y++) {
    for (let z = 0; z < WORLD_Z; z++) {
        for (let x = 0; x < WORLD_X; x++) {
            const block = blockAt(x, y, z);
            if (block === AIR) continue;
            const out = block === LEAVES ? cutoutParts[columnOf(x, z)] : opaqueParts[columnOf(x, z)];
            for (let face = 0; face < 6; face++) {
                const { n, corners } = FACES[face];
                // only an opaque block hides a face: one behind leaves shows through their holes, and a leaf beside a
                // leaf keeps it, as fancy leaves do
                if (opaqueBlock(blockAt(x + n[0], y + n[1], z + n[2]))) continue;
                const ao = corners.map((c) => {
                    const sides: Vec3[] = [];
                    const offset: Vec3 = [0, 0, 0];
                    for (let a = 0; a < 3; a++) {
                        if (n[a] !== 0) continue;
                        const side: Vec3 = [0, 0, 0];
                        side[a] = c[a] === 1 ? 1 : -1;
                        offset[a] = side[a];
                        sides.push(side);
                    }
                    const bx = x + n[0];
                    const by = y + n[1];
                    const bz = z + n[2];
                    const s1 = opaqueBlock(blockAt(bx + sides[0][0], by + sides[0][1], bz + sides[0][2])) ? 1 : 0;
                    const s2 = opaqueBlock(blockAt(bx + sides[1][0], by + sides[1][1], bz + sides[1][2])) ? 1 : 0;
                    const corner = opaqueBlock(blockAt(bx + offset[0], by + offset[1], bz + offset[2])) ? 1 : 0;
                    return s1 && s2 ? 0 : (3 - s1 - s2 - corner) / 3;
                });
                const tile = block === GRASS && face !== 2 ? DIRT : block;
                for (const i of [0, 1, 2, 0, 2, 3]) {
                    const c = corners[i];
                    out.position.push(x + c[0], y + c[1], z + c[2]);
                    out.uvTile.push(QUAD_UVS[i][0], QUAD_UVS[i][1], tile);
                    out.normal.push(n[0], n[1], n[2]);
                    out.shade.push(ao[i], 0);
                }
            }
            // grass blades on most open grass: two crossed quads, in the column's cutout
            if (block === GRASS && blockAt(x, y + 1, z) === AIR && random() < 0.6) {
                const blades = cutoutParts[columnOf(x, z)];
                for (const [ax, az, bx, bz] of [
                    [0.15, 0.15, 0.85, 0.85],
                    [0.85, 0.15, 0.15, 0.85],
                ]) {
                    const quad: Vec3[] = [
                        [x + ax, y + 1, z + az],
                        [x + bx, y + 1, z + bz],
                        [x + bx, y + 1.8, z + bz],
                        [x + ax, y + 1.8, z + az],
                    ];
                    for (const i of [0, 1, 2, 0, 2, 3]) {
                        blades.position.push(quad[i][0], quad[i][1], quad[i][2]);
                        blades.uvTile.push(QUAD_UVS[i][0], QUAD_UVS[i][1], TILE_GRASS_BLADES);
                        blades.normal.push(0, 1, 0);
                        blades.shade.push(i < 2 ? 0.6 : 1, 0);
                    }
                }
            }
        }
    }
}

function geometryOf(parts: Parts): Geometry {
    const geometry = new Geometry();
    geometry.setBuffer('position', createVertexBuffer(d.vec3f, new Float32Array(parts.position)));
    geometry.setBuffer('uvTile', createVertexBuffer(d.vec3f, new Float32Array(parts.uvTile)));
    geometry.setBuffer('normal', createVertexBuffer(d.vec3f, new Float32Array(parts.normal)));
    geometry.setBuffer('shade', createVertexBuffer(d.vec2f, new Float32Array(parts.shade)));
    geometry.drawRange.count = parts.position.length / 3;
    return geometry;
}

// a model: a body, a head and four legs, its faces all skin
const modelParts = newParts();
for (const [cx, cy, cz, sx, sy, sz] of [
    [0, 0.9, 0, 0.6, 0.6, 1.0],
    [0, 1.4, 0.55, 0.45, 0.45, 0.45],
    [-0.2, 0.3, 0.35, 0.18, 0.6, 0.18],
    [0.2, 0.3, 0.35, 0.18, 0.6, 0.18],
    [-0.2, 0.3, -0.35, 0.18, 0.6, 0.18],
    [0.2, 0.3, -0.35, 0.18, 0.6, 0.18],
]) {
    for (const { n, corners } of FACES) {
        for (const i of [0, 1, 2, 0, 2, 3]) {
            const c = corners[i];
            modelParts.position.push(cx + (c[0] - 0.5) * sx, cy + (c[1] - 0.5) * sy, cz + (c[2] - 0.5) * sz);
            modelParts.uvTile.push(QUAD_UVS[i][0], QUAD_UVS[i][1], TILE_SKIN);
            modelParts.normal.push(n[0], n[1], n[2]);
            modelParts.shade.push(1, 0);
        }
    }
}
const modelVertices = {
    position: createVertexBuffer(d.vec3f, new Float32Array(modelParts.position)),
    uvTile: createVertexBuffer(d.vec3f, new Float32Array(modelParts.uvTile)),
    normal: createVertexBuffer(d.vec3f, new Float32Array(modelParts.normal)),
    shade: createVertexBuffer(d.vec2f, new Float32Array(modelParts.shade)),
};

/** a spot on open ground in the world, for a model or a sprite */
function openGround(): Vec3 {
    let x = 0;
    let z = 0;
    let y = 0;
    for (let tries = 0; tries < 20; tries++) {
        x = 2 + random() * (WORLD_X - 4);
        z = 2 + random() * (WORLD_Z - 4);
        y = ground(Math.floor(x), Math.floor(z)) + 1;
        if (blockAt(Math.floor(x), y, Math.floor(z)) === AIR) break;
    }
    return [x, y, z];
}

// the models, grouped by column: each instance its matrix and its tint
const columnModels: { matrices: number[]; tints: number[] }[] = Array.from({ length: COLUMNS_X * COLUMNS_Z }, () => ({
    matrices: [],
    tints: [],
}));
for (let i = 0; i < MODELS; i++) {
    const [x, y, z] = openGround();
    const m = mat4.create();
    mat4.fromYRotation(m, random() * Math.PI * 2);
    m[12] = x;
    m[13] = y;
    m[14] = z;
    const group = columnModels[columnOf(x, z)];
    group.matrices.push(...m);
    group.tints.push(0.6 + random() * 0.4, 0.5 + random() * 0.4, 0.4 + random() * 0.4, 1);
}

// the sprites, grouped by column: each a billboard, its foot's position and size
const columnSprites: number[][] = Array.from({ length: COLUMNS_X * COLUMNS_Z }, () => []);
for (let i = 0; i < SPRITES; i++) {
    const [x, y, z] = openGround();
    columnSprites[columnOf(x, z)].push(x, y, z, 0.6 + random() * 0.5);
}
const spriteQuad = {
    corner: createVertexBuffer(d.vec2f, new Float32Array([-0.5, 0, 0.5, 0, 0.5, 1, -0.5, 0, 0.5, 1, -0.5, 1])),
};

/** a column's meshes, by kind, and the box they lie in */
type Column = { box: Box3; opaque: Mesh | null; cutout: Mesh | null; models: Mesh | null; sprites: Mesh | null; center: Vec3 };
// ─── The texture atlas: pixel art, 16 texels a tile ─────────────────────────

const ATLAS_SIZE = 16;
const atlasData = new Uint8Array(ATLAS_TILES * ATLAS_SIZE * ATLAS_SIZE * 4);
const TILE_COLORS: Record<number, Vec3> = {
    [GRASS]: [0.36, 0.6, 0.24],
    [DIRT]: [0.45, 0.32, 0.2],
    [STONE]: [0.48, 0.48, 0.5],
    [WOOD]: [0.42, 0.3, 0.18],
    [LEAVES]: [0.22, 0.45, 0.16],
    [BRICK]: [0.6, 0.27, 0.2],
    [TILE_GRASS_BLADES]: [0.3, 0.62, 0.2],
    [TILE_SKIN]: [0.85, 0.75, 0.6],
    [TILE_FLOWER]: [0.85, 0.35, 0.55],
};
for (let tile = 1; tile < ATLAS_TILES; tile++) {
    const base = TILE_COLORS[tile];
    for (let v = 0; v < ATLAS_SIZE; v++) {
        for (let u = 0; u < ATLAS_SIZE; u++) {
            const at = (v * ATLAS_SIZE * ATLAS_TILES + tile * ATLAS_SIZE + u) * 4;
            const shade = 0.75 + random() * 0.4;
            let alpha = 255;
            if (tile === LEAVES && random() < 0.35) alpha = 0;
            // blades: tapering stalks
            if (tile === TILE_GRASS_BLADES && !((u % 4 === 1 || u % 4 === 2) && random() < 1 - v / 20)) alpha = 0;
            // a flower: a round head on a stalk
            if (tile === TILE_FLOWER && Math.hypot(u - 7.5, v - 5) > 4.5 && !(u >= 7 && u <= 8 && v > 8)) alpha = 0;
            atlasData[at] = Math.min(255, base[0] * shade * 255);
            atlasData[at + 1] = Math.min(255, base[1] * shade * 255);
            atlasData[at + 2] = Math.min(255, base[2] * shade * 255);
            atlasData[at + 3] = alpha;
        }
    }
}
const atlas = createDataTexture(atlasData, ATLAS_SIZE * ATLAS_TILES, ATLAS_SIZE, {
    format: 'rgba8unorm',
    magFilter: 'nearest',
    minFilter: 'nearest',
    mipmapFilter: 'nearest',
    generateMipmaps: true,
});
const atlasNode = texture(atlas);

// ─── Frame data: the camera, the sun, the lights ────────────────────────────

const FrameConfig = struct('FrameConfig', {
    /** the camera's position, and its near */
    eye: d.vec4f,
    /** its right a unit of view depth along (at the screen's edge), and its far */
    right: d.vec4f,
    /** its up the same, and the tiles across */
    up: d.vec4f,
    /** its forward, and the lights' depth bins a unit of view depth */
    forward: d.vec4f,
    /** toward the sun, and how much it shines */
    sun: d.vec4f,
    /** the sky's colour; w unused */
    sky: d.vec4f,
    sunMatrix: d.mat4x4f,
    /** 1 to shadow the point lights, 0 not; what to show (`SHOW`); 1 to light by the shadowed lights alone */
    options: d.vec4f,
});
const frameConfig = {
    eye: [0, 0, 0, NEAR] as [number, number, number, number],
    right: [0, 0, 0, FAR] as [number, number, number, number],
    up: [0, 0, 0, 1] as [number, number, number, number],
    forward: [0, 0, 0, DEPTH_BINS / LIGHT_FAR] as [number, number, number, number],
    sun: [0, 1, 0, 1] as [number, number, number, number],
    sky: [0, 0, 0, 0] as [number, number, number, number],
    sunMatrix: mat4.create(),
    options: [1, 0, 0, 0] as [number, number, number, number],
};
const frameUniform = new Uniform(FrameConfig, frameConfig);
const cfg = uniform(frameUniform);
const eye = cfg.field('eye');
const sunDir = cfg.field('sun').xyz;
const sunStrength = cfg.field('sun').w;
const skyColor = cfg.field('sky').xyz;

/** the lights sorted nearest the camera first, each (position, radius) then (colour, 0) */
const lightData = new Float32Array(MAX_LIGHTS * 8);
const lightBuffer = new GpuBuffer(d.array(d.vec4f), {
    label: 'lights',
    data: lightData,
    usage: 'storage',
    lifecycle: BufferLifecycle.MANUAL,
});
/** each tile's lights, LIGHT_WORDS words of a bit each */
const MAX_TILES = Math.ceil(7680 / TILE) * Math.ceil(4320 / TILE);
const tileData = new Uint32Array(MAX_TILES * LIGHT_WORDS);
const tileBuffer = new GpuBuffer(d.array(d.u32), {
    label: 'tiles',
    data: tileData,
    usage: 'storage',
    lifecycle: BufferLifecycle.MANUAL,
});
/** each depth bin's lights: the first and last of the sorted lights that reach it, first | last << 16; 0xffff first
 *  for none */
const binData = new Uint32Array(DEPTH_BINS);
const binBuffer = new GpuBuffer(d.array(d.u32), {
    label: 'bins',
    data: binData,
    usage: 'storage',
    lifecycle: BufferLifecycle.MANUAL,
});
/** the light each block's air holds, 0 to 255: open sky, or less under leaves and roofs, and none in a solid block */
const lightVolume = new Uint32Array(WORLD_X * WORLD_Y * WORLD_Z);
for (let y = 0; y < WORLD_Y; y++) {
    for (let z = 0; z < WORLD_Z; z++) {
        for (let x = 0; x < WORLD_X; x++) {
            if (blockAt(x, y, z) !== AIR) continue;
            lightVolume[blockIndex(x, y, z)] = Math.round(skyAt(x, y, z) * 255);
        }
    }
}
const lightVolumeBuffer = new GpuBuffer(d.array(d.u32), { label: 'light-volume', data: lightVolume, usage: 'storage' });

const lightNodes = storage(lightBuffer, 'read');
const tileNodes = storage(tileBuffer, 'read');
const binNodes = storage(binBuffer, 'read');
const lightVolumeNodes = storage(lightVolumeBuffer, 'read');

/** the light volume at `pos`, 0 to 1: its eight nearest blocks' light, blended; open sky outside the world */
const voxelLight = Fn(
    (pos) => {
        const cell = pos.sub(vec3(f32(0.5))).toVar('vlCell');
        const base = floor(cell).toVar('vlBase');
        const t = cell.sub(base).toVar('vlT');
        const at = (dx: number, dy: number, dz: number) => {
            const c = base.add(vec3(f32(dx), f32(dy), f32(dz)));
            const inside = c.x
                .greaterThanEqual(f32(0))
                .and(c.y.greaterThanEqual(f32(0)))
                .and(c.z.greaterThanEqual(f32(0)))
                .and(c.x.lessThan(f32(WORLD_X)))
                .and(c.y.lessThan(f32(WORLD_Y)))
                .and(c.z.lessThan(f32(WORLD_Z)));
            const index = select(
                u32(0),
                c.x
                    .toU32()
                    .add(c.z.toU32().mul(u32(WORLD_X)))
                    .add(c.y.toU32().mul(u32(WORLD_X * WORLD_Z))),
                inside,
            );
            return select(f32(1), lightVolumeNodes.element(index).toF32().div(f32(255)), inside);
        };
        const x0 = mix(mix(at(0, 0, 0), at(1, 0, 0), t.x), mix(at(0, 1, 0), at(1, 1, 0), t.x), t.y);
        const x1 = mix(mix(at(0, 0, 1), at(1, 0, 1), t.x), mix(at(0, 1, 1), at(1, 1, 1), t.x), t.y);
        return mix(x0, x1, t.z);
    },
    { name: 'voxelLight', params: [{ name: 'pos', type: d.vec3f }], return: d.f32 },
);

// ─── The sun's map: one warped orthographic view over the reach ─────────────

const sunMap = createRenderTarget(SUN_MAP, SUN_MAP, { depthFormat: 'depth24plus', count: 0, depthSampled: true, label: 'sun' });
const sunCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
const warpClip = (clip: Node<d.vec4f>) => {
    const factor = length(clip.xy)
        .mul(f32(SUN_WARP))
        .add(f32(1 - SUN_WARP));
    return vec4(clip.xy.div(factor), clip.z, clip.w);
};
const sunDepth = depthTexture(sunMap.depthTexture!).bindingNode;
const sunSampler = comparisonSampler(
    new GpuSampler({ minFilter: 'linear', magFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' }),
    'less',
);
const SUN_HALF_TEXEL = 0.5 / SUN_MAP;

/** the sun's shadow at `pos` facing `normal`: four filtered compares, pushed off along the normal by the warp's texel */
const sunShadow = Fn(
    (pos, normal) => {
        const matrix = cfg.field('sunMatrix');
        const surface = matrix.mul(vec4(pos, f32(1))).toVar('ssSurface');
        const spread = length(surface.xy)
            .mul(f32(SUN_WARP))
            .add(f32(1 - SUN_WARP))
            .toVar('ssSpread');
        const texel = f32((2 * SUN_REACH) / SUN_MAP).mul(spread.mul(spread).div(f32(1 - SUN_WARP)));
        const clip = warpClip(matrix.mul(vec4(pos.add(normal.mul(texel.mul(f32(3)))), f32(1)))).toVar('ssClip');
        const uv = vec2(clip.x.mul(f32(0.5)).add(f32(0.5)), f32(0.5).sub(clip.y.mul(f32(0.5)))).toVar('ssUv');
        const reference = ndcDepthToStorage(clip.z).toVar('ssReference');
        const tap = (dx: number, dy: number) =>
            textureSampleCompareLevel(
                sunDepth,
                sunSampler,
                uv.add(vec2(f32(dx * SUN_HALF_TEXEL), f32(dy * SUN_HALF_TEXEL))),
                reference,
            );
        const inside = uv.x
            .greaterThan(f32(0))
            .and(uv.x.lessThan(f32(1)))
            .and(uv.y.greaterThan(f32(0)))
            .and(uv.y.lessThan(f32(1)));
        return select(f32(1), tap(-1, -1).add(tap(1, -1)).add(tap(-1, 1)).add(tap(1, 1)).mul(f32(0.25)), inside);
    },
    {
        name: 'sunShadow',
        params: [
            { name: 'pos', type: d.vec3f },
            { name: 'normal', type: d.vec3f },
        ],
        return: d.f32,
    },
);

// ─── Point lights: found by tile and depth bin, the nearest shadowed by cube maps ───

/** each shadowed light's cube: per face its view-projection (four vec4s, its columns) then its slot (x, y, size,
 *  drawn) in the atlas, 0 to 1 */
const SHADOW_FACE_VEC4S = 5;
const SHADOW_VEC4S = 6 * SHADOW_FACE_VEC4S;
const shadowData = new Float32Array(SHADOWED_LIGHTS * SHADOW_VEC4S * 4);
const shadowBuffer = new GpuBuffer(d.array(d.vec4f), {
    label: 'shadows',
    data: shadowData,
    usage: 'storage',
    lifecycle: BufferLifecycle.MANUAL,
});
const shadowNodes = storage(shadowBuffer, 'read');
const shadowAtlas = createRenderTarget(SHADOW_ATLAS, SHADOW_ATLAS, {
    depthFormat: 'depth24plus',
    count: 0,
    depthSampled: true,
    label: 'shadows',
});
const shadowAtlasDepth = depthTexture(shadowAtlas.depthTexture!).bindingNode;
const SHADOW_TEXEL = 1 / SHADOW_ATLAS;

/** shadow `shadow`'s light at `lightPos` on `pos` facing `normal`, 1 lit: the cube face the surface lies toward from
 *  the light now, projected with the matrix that face was drawn with, a 3 x 3 filter from four filtered compares */
const cubeShadow = Fn(
    (shadow, lightPos, pos, normal) => {
        const lit = Var('csLit', f32(1));
        const toSurface = pos.sub(lightPos).toVar('csToSurface');
        const a = abs(toSurface).toVar('csAbs');
        // faces +x, -x, +y, -y, +z, -z
        const face = select(
            select(
                select(u32(5), u32(4), toSurface.z.greaterThan(f32(0))),
                select(u32(3), u32(2), toSurface.y.greaterThan(f32(0))),
                a.y.greaterThan(a.z),
            ),
            select(u32(1), u32(0), toSurface.x.greaterThan(f32(0))),
            a.x.greaterThan(a.y).and(a.x.greaterThan(a.z)),
        ).toVar('csFace');
        const base = shadow
            .mul(u32(SHADOW_VEC4S))
            .add(face.mul(u32(SHADOW_FACE_VEC4S)))
            .toVar('csBase');
        const slot = shadowNodes.element(base.add(u32(4))).toVar('csSlot');
        If(slot.w.greaterThan(f32(0.5)), () => {
            // pushed off along the normal by about a texel where the surface is
            const texel = length(toSurface).mul(f32(2 / SHADOW_SLOT));
            const at = vec4(pos.add(normal.mul(texel.mul(f32(1.5)))), f32(1));
            const c0 = shadowNodes.element(base).toVar('csC0');
            const c1 = shadowNodes.element(base.add(u32(1))).toVar('csC1');
            const c2 = shadowNodes.element(base.add(u32(2))).toVar('csC2');
            const c3 = shadowNodes.element(base.add(u32(3))).toVar('csC3');
            const clip = c0.mul(at.x).add(c1.mul(at.y)).add(c2.mul(at.z)).add(c3.mul(at.w)).toVar('csClip');
            const ndc = clip.xyz.div(clip.w).toVar('csNdc');
            const uv = vec2(ndc.x.mul(f32(0.5)).add(f32(0.5)), f32(0.5).sub(ndc.y.mul(f32(0.5))));
            const mapUv = slot.xy.add(uv.mul(slot.z)).toVar('csMapUv');
            const low = slot.xy.add(vec2(f32(SHADOW_TEXEL * 1.5)));
            const high = slot.xy.add(vec2(slot.z)).sub(vec2(f32(SHADOW_TEXEL * 1.5)));
            const reference = ndcDepthToStorage(ndc.z).toVar('csReference');
            const tap = (dx: number, dy: number) =>
                textureSampleCompareLevel(
                    shadowAtlasDepth,
                    sunSampler,
                    clamp(mapUv.add(vec2(f32(dx * SHADOW_TEXEL * 0.5), f32(dy * SHADOW_TEXEL * 0.5))), low, high),
                    reference,
                );
            lit.assign(tap(-1, -1).add(tap(1, -1)).add(tap(-1, 1)).add(tap(1, 1)).mul(f32(0.25)));
        });
        return lit;
    },
    {
        name: 'cubeShadow',
        params: [
            { name: 'shadow', type: d.u32 },
            { name: 'lightPos', type: d.vec3f },
            { name: 'pos', type: d.vec3f },
            { name: 'normal', type: d.vec3f },
        ],
        return: d.f32,
    },
);

/** the point lights at `pos` facing `normal`, on pixel (`pixelX`, `pixelY`) at `viewDepth`: those its tile's bits
 *  and its depth bin's range both hold, each shadowed; and in w, how many it walked */
const pointLights = Fn(
    (pos, normal, viewDepth, pixelX, pixelY) => {
        const light = Var('plLight', vec3(f32(0)));
        const walked = Var('plWalked', f32(0));
        const bin = min(viewDepth.mul(cfg.field('forward').w), f32(DEPTH_BINS - 1)).toU32();
        const range = binNodes.element(bin).toVar('plRange');
        const first = range.bitwiseAnd(u32(0xffff)).toVar('plFirst');
        const last = range.shiftRight(u32(16)).toVar('plLast');
        If(first.lessThanEqual(last), () => {
            const tile = pixelX
                .toU32()
                .div(u32(TILE))
                .add(pixelY.toU32().div(u32(TILE)).mul(cfg.field('up').w.toU32()))
                .toVar('plTile');
            Loop(
                { start: first.shiftRight(u32(5)), end: last.shiftRight(u32(5)).add(u32(1)), type: d.u32, name: 'word' },
                ({ word }) => {
                    const w = word.toU32();
                    const mask = Var('plMask', tileNodes.element(tile.mul(u32(LIGHT_WORDS)).add(w)));
                    // the bits of the bin's range alone
                    If(w.equal(first.shiftRight(u32(5))), () => {
                        mask.assign(mask.bitwiseAnd(u32(0xffffffff).shiftLeft(first.bitwiseAnd(u32(31)))));
                    });
                    If(w.equal(last.shiftRight(u32(5))), () => {
                        mask.assign(mask.bitwiseAnd(u32(0xffffffff).shiftRight(u32(31).sub(last.bitwiseAnd(u32(31))))));
                    });
                    While(mask.notEqual(u32(0)), () => {
                        const index = w.shiftLeft(u32(5)).add(countTrailingZeros(mask)).toVar('plIndex');
                        mask.assign(mask.bitwiseAnd(mask.sub(u32(1))));
                        walked.assign(walked.add(f32(1)));
                        const positionRadius = lightNodes.element(index.mul(u32(2))).toVar('plPositionRadius');
                        const toLight = positionRadius.xyz.sub(pos).toVar('plToLight');
                        const distance = length(toLight).toVar('plDistance');
                        const facing = dot(normal, toLight.div(distance)).toVar('plFacing');
                        // with `options.z`, the shadowed lights alone
                        const shown = lightNodes.element(index.mul(u32(2)).add(u32(1))).w.greaterThan(f32(0)).or(cfg.field('options').z.lessThan(f32(0.5)));
                        If(distance.lessThan(positionRadius.w).and(facing.greaterThan(f32(0))).and(shown), () => {
                            const ratio = distance.div(positionRadius.w);
                            const falloff = f32(1).sub(ratio.mul(ratio));
                            const color = lightNodes.element(index.mul(u32(2)).add(u32(1))).xyz;
                            const shadow = Var('plShadow', f32(1));
                            const shadowIndex = lightNodes.element(index.mul(u32(2)).add(u32(1))).w.toU32();
                            If(shadowIndex.greaterThan(u32(0)).and(cfg.field('options').x.greaterThan(f32(0.5))), () => {
                                shadow.assign(cubeShadow(shadowIndex.sub(u32(1)), positionRadius.xyz, pos, normal));
                            });
                            light.assign(light.add(color.mul(falloff.mul(falloff).mul(facing).mul(shadow))));
                        });
                    });
                },
            );
        });
        return vec4(light, walked);
    },
    {
        name: 'pointLights',
        params: [
            { name: 'pos', type: d.vec3f },
            { name: 'normal', type: d.vec3f },
            { name: 'viewDepth', type: d.f32 },
            { name: 'pixelX', type: d.f32 },
            { name: 'pixelY', type: d.f32 },
        ],
        return: d.vec4f,
    },
);

/** what `options.y` shows in place of the lit colour: the surface's inputs, as the G-buffer holds them */
const SHOW = ['lit', 'albedo', 'normal', 'ao', 'sky light', 'depth', 'tile lights'] as const;

/** a surface's colour, as every path shades it: sky light by occlusion, the sun where it faces it and isn't
 *  shadowed, the point lights, then fog */
const shadeSurface = Fn(
    (albedo, normal, pos, ao, viewDepth, pixelX, pixelY) => {
        // the light the surface sits in, sampled from the light volume as a voxel game does a pixel
        const sky = voxelLight(pos.add(normal.mul(f32(0.5)))).toVar('shSky');
        const ambient = skyColor.mul(sky.mul(f32(0.6)).add(f32(0.1))).mul(f32(0.35).add(ao.mul(f32(0.65))));
        const sunlight = Var('shSun', vec3(f32(0)));
        const facing = dot(normal, sunDir).toVar('shFacing');
        // faces turned from the sun, or indoors, skip the shadow's taps
        If(
            facing
                .greaterThan(f32(0))
                .and(sky.greaterThan(f32(0.5)))
                .and(sunStrength.greaterThan(f32(0))),
            () => {
                const shadow = select(f32(1), sunShadow(pos, normal), viewDepth.lessThan(f32(SUN_REACH)));
                sunlight.assign(vec3(f32(1.0), f32(0.95), f32(0.85)).mul(facing.mul(shadow).mul(sunStrength)));
            },
        );
        const points = pointLights(pos, normal, viewDepth, pixelX, pixelY).toVar('shPoints');
        const lit = albedo.mul(ambient.add(sunlight).add(points.xyz));
        const fogged = mix(lit, skyColor, smoothstep(f32(FOG_START), f32(FOG_END), viewDepth));
        // the lights walked, 0 blue to 16 red
        const heat = mix(
            vec3(f32(0.05), f32(0.1), f32(0.5)),
            vec3(f32(1), f32(0.15), f32(0.05)),
            min(points.w.div(f32(16)), f32(1)),
        );
        const shown = [
            fogged,
            albedo,
            normal.mul(f32(0.5)).add(f32(0.5)),
            vec3(ao),
            vec3(sky),
            vec3(f32(1).sub(min(viewDepth.div(f32(FOG_END)), f32(1)))),
            heat,
        ];
        const show = cfg.field('options').y;
        let out: Node<d.vec3f> = shown[shown.length - 1]!;
        for (let k = shown.length - 2; k >= 0; k--) out = select(out, shown[k]!, show.lessThan(f32(k + 0.5)));
        return out;
    },
    {
        name: 'shadeSurface',
        params: [
            { name: 'albedo', type: d.vec3f },
            { name: 'normal', type: d.vec3f },
            { name: 'pos', type: d.vec3f },
            { name: 'ao', type: d.f32 },
            { name: 'viewDepth', type: d.f32 },
            { name: 'pixelX', type: d.f32 },
            { name: 'pixelY', type: d.f32 },
        ],
        return: d.vec3f,
    },
);

// ─── Surfaces: terrain and models, as each path draws them ──────────────────

/** what a surface hands its fragment: where it is, which way it faces, its texture's sample, its occlusion and sky
 *  light, its view depth */
type Surface = {
    clip: Node<d.vec4f>;
    pos: Node<d.vec3f>;
    normal: Node<d.vec3f>;
    albedo: Node<d.vec4f>;
    ao: Node<d.f32>;
    viewDepth: Node<d.f32>;
};

const atlasUv = (uvTile: Node<d.vec3f>) => vec2(uvTile.z.add(uvTile.x).div(f32(ATLAS_TILES)), uvTile.y);

function terrainSurface(): Surface {
    const position = attribute('position', d.vec3f);
    const viewPos = mul(cameraViewMatrix, vec4(position, f32(1)));
    const shade = attribute('shade', d.vec2f);
    return {
        clip: mul(cameraProjectionMatrix, viewPos),
        pos: varying(position, 'vPos'),
        normal: varying(attribute('normal', d.vec3f), 'vNormal'),
        albedo: atlasNode.sample(atlasUv(varying(attribute('uvTile', d.vec3f), 'vUvTile'))),
        ao: varying(shade.x, 'vAo'),
        viewDepth: varying(viewPos.z.negate(), 'vViewDepth'),
    };
}

function modelSurface(): Surface {
    const column = (k: number) => attribute('instanceMatrix', d.vec4f, { stride: 64, offset: k * 16, instanced: true });
    const model = mat4Node(column(0), column(1), column(2), column(3));
    const tint = attribute('instanceTint', d.vec4f, { instanced: true });
    const world = mul(model, vec4(attribute('position', d.vec3f), f32(1)));
    const viewPos = mul(cameraViewMatrix, world);
    const sample = atlasNode.sample(atlasUv(varying(attribute('uvTile', d.vec3f), 'vUvTile')));
    return {
        clip: mul(cameraProjectionMatrix, viewPos),
        pos: varying(world.xyz, 'vPos'),
        normal: varying(mul(model, vec4(attribute('normal', d.vec3f), f32(0))).xyz, 'vNormal'),
        albedo: vec4(sample.xyz.mul(varying(tint.xyz, 'vTint')), sample.w),
        ao: f32(1),
        viewDepth: varying(viewPos.z.negate(), 'vViewDepth'),
    };
}

/** a sprite: a billboard standing on its foot, turned to the camera about the vertical, a flower its picture */
function spriteSurface(): Surface {
    const sprite = attribute('sprite', d.vec4f, { instanced: true });
    const corner = attribute('corner', d.vec2f);
    const right = normalize(vec3(cfg.field('right').x, f32(0), cfg.field('right').z));
    const world = sprite.xyz.add(right.mul(corner.x.mul(sprite.w))).add(vec3(f32(0), corner.y.mul(sprite.w), f32(0)));
    const viewPos = mul(cameraViewMatrix, vec4(world, f32(1)));
    const uvTile = vec3(corner.x.add(f32(0.5)), f32(1).sub(corner.y), f32(TILE_FLOWER));
    return {
        clip: mul(cameraProjectionMatrix, viewPos),
        pos: varying(world, 'vPos'),
        normal: varying(vec3(f32(0), f32(1), f32(0)), 'vNormal'),
        albedo: atlasNode.sample(atlasUv(varying(uvTile, 'vUvTile'))),
        ao: f32(1),
        viewDepth: varying(viewPos.z.negate(), 'vViewDepth'),
    };
}

/** a cutout's texel under half covered is a hole, dropped by every pass alike */
const ALPHA_CUT = 0.5;

/** the shaded colour, `cut` dropping holes first */
function shadedFragment(s: Surface, cut: boolean, name: string): Node<d.vec4f> {
    return Fn(
        (albedo, normal, pos, ao, viewDepth, pixelX, pixelY) => {
            if (cut) {
                If(albedo.w.lessThan(f32(ALPHA_CUT)), () => {
                    Discard();
                });
            }
            return vec4(shadeSurface(albedo.xyz, normalize(normal), pos, ao, viewDepth, pixelX, pixelY), f32(1));
        },
        {
            name,
            params: [
                { name: 'albedo', type: d.vec4f },
                { name: 'normal', type: d.vec3f },
                { name: 'pos', type: d.vec3f },
                { name: 'ao', type: d.f32 },
                { name: 'viewDepth', type: d.f32 },
                { name: 'pixelX', type: d.f32 },
                { name: 'pixelY', type: d.f32 },
            ],
            return: d.vec4f,
        },
    )(s.albedo, s.normal, s.pos, s.ao, s.viewDepth, screenCoordinate.x, screenCoordinate.y);
}

/** holes dropped and nothing else: a depth-only pass's fragment */
function cutFragment(s: Surface, name: string): Node<d.Void> {
    return Fn(
        (alpha) => {
            If(alpha.lessThan(f32(ALPHA_CUT)), () => {
                Discard();
            });
        },
        { name, params: [{ name: 'alpha', type: d.f32 }] },
    )(s.albedo.w);
}

/** a unit normal as two values in 0 to 1, octahedrally */
function octEncode(n: Node<d.vec3f>): Node<d.vec2f> {
    const p = n.xy.div(abs(n.x).add(abs(n.y)).add(abs(n.z)));
    const signs = select(vec2(f32(-1)), vec2(f32(1)), p.greaterThanEqual(vec2(f32(0))));
    const folded = select(
        p,
        vec2(f32(1))
            .sub(abs(vec2(p.y, p.x)))
            .mul(signs),
        n.z.lessThan(f32(0)),
    );
    return folded.mul(f32(0.5)).add(f32(0.5));
}

function octDecode(e: Node<d.vec2f>): Node<d.vec3f> {
    const f = e.mul(f32(2)).sub(f32(1));
    const n = vec3(f.x, f.y, f32(1).sub(abs(f.x)).sub(abs(f.y)));
    const t = clamp(n.z.negate(), f32(0), f32(1));
    const signs = select(vec2(f32(1)), vec2(f32(-1)), n.xy.greaterThanEqual(vec2(f32(0))));
    return normalize(vec3(n.xy.add(signs.mul(t)), n.z));
}

/** the G-buffer's two texels: albedo and occlusion; normal and two spare */
function gbufferFragment(s: Surface, cut: boolean, name: string): Node<d.Any> {
    const albedoAo = Fn(
        (albedo, ao) => {
            if (cut) {
                If(albedo.w.lessThan(f32(ALPHA_CUT)), () => {
                    Discard();
                });
            }
            return vec4(albedo.xyz, ao);
        },
        {
            name,
            params: [
                { name: 'albedo', type: d.vec4f },
                { name: 'ao', type: d.f32 },
            ],
            return: d.vec4f,
        },
    )(s.albedo, s.ao);
    return mrt({ output: albedoAo, output1: vec4(octEncode(normalize(s.normal)), f32(0), f32(1)) });
}

/** every material a kind of surface is drawn with */
type Materials = {
    forward: Material;
    prepassDepth: Material;
    prepassColor: Material;
    gbuffer: Material;
    sun: Material;
    light: Material;
};

function materialsFor(make: () => Surface, cut: boolean, name: string): Materials {
    const cullMode: GPUCullMode = cut ? 'none' : 'back';
    const forward = make();
    const depthSurface = make();
    const colorSurface = make();
    const gbufferSurface = make();
    const sunSurface = make();
    const lightSurface = make();
    return {
        forward: createMaterial({
            name: `${name}-forward`,
            vertex: forward.clip,
            fragment: shadedFragment(forward, cut, `${name}Forward`),
            cullMode,
        }),
        prepassDepth: createMaterial({
            name: `${name}-prepass-depth`,
            vertex: invariant(depthSurface.clip),
            fragment: cut ? cutFragment(depthSurface, `${name}PrepassCut`) : undefined,
            colorWrite: false,
            cullMode,
        }),
        // the holes are already out of the depth: equal passes only where the prepass kept a fragment
        prepassColor: createMaterial({
            name: `${name}-prepass-color`,
            vertex: invariant(colorSurface.clip),
            fragment: shadedFragment(colorSurface, false, `${name}PrepassColor`),
            depthCompare: 'equal',
            depthWrite: false,
            cullMode,
        }),
        gbuffer: createMaterial({
            name: `${name}-gbuffer`,
            vertex: gbufferSurface.clip,
            fragment: gbufferFragment(gbufferSurface, cut, `${name}Gbuffer`),
            cullMode,
        }),
        sun: createMaterial({
            name: `${name}-sun`,
            vertex: warpClip(sunSurface.clip),
            fragment: cut ? cutFragment(sunSurface, `${name}SunCut`) : undefined,
            depthBias: 2,
            depthBiasSlopeScale: 2,
            cullMode: 'none',
        }),
        // into a point light's cube face: perspective, unwarped
        light: createMaterial({
            name: `${name}-light`,
            vertex: lightSurface.clip,
            fragment: cut ? cutFragment(lightSurface, `${name}LightCut`) : undefined,
            depthBias: 2,
            depthBiasSlopeScale: 2,
            cullMode: 'none',
        }),
    };
}

const opaqueMaterials = materialsFor(terrainSurface, false, 'terrain');
const cutoutMaterials = materialsFor(terrainSurface, true, 'cutout');
const modelMaterials = materialsFor(modelSurface, false, 'model');

const spriteMaterials = materialsFor(spriteSurface, true, 'sprite');

function meshOf(geometry: Geometry, material: Material, count: number): Mesh {
    const mesh = new Mesh(geometry, material);
    mesh.count = count;
    mesh.frustumCulled = false;
    mesh.updateWorldMatrix();
    return mesh;
}

let triangles = 0;
const columns: Column[] = [];
for (let cz = 0; cz < COLUMNS_Z; cz++) {
    for (let cx = 0; cx < COLUMNS_X; cx++) {
        const c = cx + cz * COLUMNS_X;
        const x0 = cx * COLUMN;
        const z0 = cz * COLUMN;
        // the whole height, and the sprites and models standing on the top
        const box: Box3 = [x0, 0, z0, x0 + COLUMN, WORLD_Y + 2, z0 + COLUMN];
        const opaqueTerrain = opaqueParts[c];
        const cutoutTerrain = cutoutParts[c];
        triangles += (opaqueTerrain.position.length + cutoutTerrain.position.length) / 9;
        let models: Mesh | null = null;
        const group = columnModels[c];
        if (group.matrices.length > 0) {
            const geometry = new Geometry();
            geometry.setBuffer('position', modelVertices.position);
            geometry.setBuffer('uvTile', modelVertices.uvTile);
            geometry.setBuffer('normal', modelVertices.normal);
            geometry.setBuffer('shade', modelVertices.shade);
            geometry.setBuffer('instanceMatrix', createVertexBuffer(d.vec4f, new Float32Array(group.matrices)));
            geometry.setBuffer('instanceTint', createVertexBuffer(d.vec4f, new Float32Array(group.tints)));
            geometry.drawRange.count = modelParts.position.length / 3;
            const count = group.matrices.length / 16;
            models = meshOf(geometry, modelMaterials.forward, count);
            triangles += (modelParts.position.length / 9) * count;
        }
        let sprites: Mesh | null = null;
        if (columnSprites[c].length > 0) {
            const geometry = new Geometry();
            geometry.setBuffer('corner', spriteQuad.corner);
            geometry.setBuffer('sprite', createVertexBuffer(d.vec4f, new Float32Array(columnSprites[c])));
            geometry.drawRange.count = 6;
            const count = columnSprites[c].length / 4;
            sprites = meshOf(geometry, spriteMaterials.forward, count);
            triangles += 2 * count;
        }
        columns.push({
            box,
            center: [x0 + COLUMN / 2, 12, z0 + COLUMN / 2],
            opaque: opaqueTerrain.position.length > 0 ? meshOf(geometryOf(opaqueTerrain), opaqueMaterials.forward, 1) : null,
            cutout: cutoutTerrain.position.length > 0 ? meshOf(geometryOf(cutoutTerrain), cutoutMaterials.forward, 1) : null,
            models,
            sprites,
        });
    }
}

const _frustum = frustum.create();
const _visible: Column[] = [];

/** the columns `view` sees, nearest first */
function visibleColumns(view: PerspectiveCamera | OrthographicCamera): Column[] {
    frustum.setFromViewProjectionMatrixNO(_frustum, view.projectionMatrix, view.matrixWorldInverse);
    _visible.length = 0;
    for (const column of columns) if (frustum.intersectsBox3(_frustum, column.box)) _visible.push(column);
    const p = view.position;
    const distance = (c: Column) => (c.center[0] - p[0]) ** 2 + (c.center[2] - p[2]) ** 2;
    _visible.sort((a, b) => distance(a) - distance(b));
    return _visible;
}

/** what a pass draws of each kind, opaque terrain first, cutout last */
const KINDS: { mesh: (c: Column) => Mesh | null; materials: Materials }[] = [
    { mesh: (c) => c.opaque, materials: opaqueMaterials },
    { mesh: (c) => c.models, materials: modelMaterials },
    { mesh: (c) => c.sprites, materials: spriteMaterials },
    { mesh: (c) => c.cutout, materials: cutoutMaterials },
];

/** `visible`'s meshes into `pass`, each with the material `pick` chooses of its kind's */
function drawColumns(pass: Pass, visible: Column[], pick: (m: Materials) => Material): void {
    for (const kind of KINDS) {
        const material = pick(kind.materials);
        for (const column of visible) {
            const mesh = kind.mesh(column);
            if (mesh !== null) pass.draw(mesh, { material });
        }
    }
}

// ─── Deferred lighting: each pixel shaded once from the G-buffer ────────────

/** the canvas's size in pixels */
const sizeValue = new Float32Array([1, 1]);
const sizeUniform = new Uniform(d.vec2f, sizeValue);
const sizeNode = uniform(sizeUniform);

const gbufferAlbedo = targetColor(gbuffer);
const gbufferNormal = texture(gbuffer.textures[1] as Texture);
const gbufferDepth = targetDepth(gbuffer);

const lightingFragment = Fn(
    (pixelX, pixelY) => {
        const pixel = vec2i(pixelX.toI32(), pixelY.toI32());
        const depth = gbufferDepth.load(pixel).toVar('lpDepth');
        const color = Var('lpColor', skyColor);
        If(depth.lessThan(f32(1)), () => {
            const albedoAo = gbufferAlbedo.load(pixel).toVar('lpAlbedoAo');
            const normalTexel = gbufferNormal.load(pixel).toVar('lpNormalTexel');
            // WebGL keeps depth as (ndc z + 1) / 2; view depth from it, then the pixel's ray out to it
            const near = eye.w;
            const far = cfg.field('right').w;
            const ndcZ = depth.mul(f32(2)).sub(f32(1));
            const viewDepth = f32(2)
                .mul(near)
                .mul(far)
                .div(far.add(near).sub(ndcZ.mul(far.sub(near))))
                .toVar('lpViewDepth');
            const ndcX = pixelX.add(f32(0.5)).div(sizeNode.x).mul(f32(2)).sub(f32(1));
            const ndcY = f32(1).sub(pixelY.add(f32(0.5)).div(sizeNode.y).mul(f32(2)));
            const ray = cfg.field('forward').xyz.add(cfg.field('right').xyz.mul(ndcX)).add(cfg.field('up').xyz.mul(ndcY));
            const pos = eye.xyz.add(ray.mul(viewDepth)).toVar('lpPos');
            const normal = octDecode(normalTexel.xy).toVar('lpNormal');
            color.assign(shadeSurface(albedoAo.xyz, normal, pos, albedoAo.w, viewDepth, pixelX, pixelY));
        });
        return vec4(color, f32(1));
    },
    {
        name: 'lightingFragment',
        params: [
            { name: 'pixelX', type: d.f32 },
            { name: 'pixelY', type: d.f32 },
        ],
        return: d.vec4f,
    },
);
const lightingPass = fullscreen(lightingFragment(screenCoordinate.x, screenCoordinate.y));

// ─── Each frame: the sun's view, the lights and their tiles and bins ────────

const settings = {
    path: 'forward',
    view: 'forest floor',
    time: 'day',
    lights: 0,
    shadows: true,
    shadowedOnly: false,
    move: true,
    show: 'lit' as (typeof SHOW)[number],
};

const LIGHTS_FROM = 50;
const LIGHTS_TO = 150;

type Light = { base: Vec3; orbit: number; speed: number; phase: number; radius: number; color: Vec3 };
const lights: Light[] = [];
for (let i = 0; i < MAX_LIGHTS; i++) {
    // over the middle of the world, where the views look
    const x = LIGHTS_FROM + random() * (LIGHTS_TO - LIGHTS_FROM);
    const z = LIGHTS_FROM + random() * (LIGHTS_TO - LIGHTS_FROM);
    const hue = random();
    lights.push({
        // under the canopies, which start four blocks up: a light inside a block is shadowed every way
        base: [x, ground(Math.floor(x), Math.floor(z)) + 1.6 + random() * 1.4, z],
        orbit: 1 + random() * 3,
        speed: 0.3 + random() * 0.8,
        phase: random() * Math.PI * 2,
        radius: 6 + random() * 6,
        color: [1.4 + Math.cos(hue * 6.28) * 0.4, 1.0 + Math.sin(hue * 6.28) * 0.3, 0.5 + hue * 0.6],
    });
}

const SUN: Vec3 = (() => {
    const v: Vec3 = [0.45, 0.75, 0.35];
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
})();
/** blocks the sun's view snaps by, so its texels hold still as the camera moves within a step */
const SUN_SNAP = 2;
const SUN_PULLBACK = 96;

function fitSun(): void {
    const up: Vec3 = [0, 1, 0];
    const right: Vec3 = [up[1] * SUN[2] - up[2] * SUN[1], up[2] * SUN[0] - up[0] * SUN[2], up[0] * SUN[1] - up[1] * SUN[0]];
    const rl = Math.hypot(right[0], right[1], right[2]);
    for (let a = 0; a < 3; a++) right[a] /= rl;
    const across: Vec3 = [
        SUN[1] * right[2] - SUN[2] * right[1],
        SUN[2] * right[0] - SUN[0] * right[2],
        SUN[0] * right[1] - SUN[1] * right[0],
    ];
    const centre: Vec3 = [camera.position[0], camera.position[1], camera.position[2]];
    const r = centre[0] * right[0] + centre[1] * right[1] + centre[2] * right[2];
    const u = centre[0] * across[0] + centre[1] * across[1] + centre[2] * across[2];
    const shiftR = Math.floor(r / SUN_SNAP) * SUN_SNAP - r;
    const shiftU = Math.floor(u / SUN_SNAP) * SUN_SNAP - u;
    for (let a = 0; a < 3; a++) centre[a] += right[a] * shiftR + across[a] * shiftU;
    sunCamera.coordinateSystem = camera.coordinateSystem;
    sunCamera.left = -SUN_REACH;
    sunCamera.right = SUN_REACH;
    sunCamera.top = SUN_REACH;
    sunCamera.bottom = -SUN_REACH;
    sunCamera.near = 0;
    sunCamera.far = 2 * SUN_REACH + SUN_PULLBACK;
    sunCamera.updateProjectionMatrix();
    const back = SUN_REACH + SUN_PULLBACK;
    sunCamera.position = [centre[0] + SUN[0] * back, centre[1] + SUN[1] * back, centre[2] + SUN[2] * back];
    sunCamera.lookAt(centre, across);
    sunCamera.updateWorldMatrix();
    sunCamera.updateViewMatrix();
    mat4.multiply(frameConfig.sunMatrix, sunCamera.projectionMatrix, sunCamera.matrixWorldInverse);
}

const order: number[] = [];
const viewDepths = new Float32Array(MAX_LIGHTS);
const lightPositions: Vec3[] = Array.from({ length: MAX_LIGHTS }, () => [0, 0, 0] as Vec3);

// ─── Point light shadows: kept cube maps, a capped number redrawn a frame ───

/** which shadow each light casts, -1 for none; and which light each shadow is */
const shadowOfLight = new Int32Array(MAX_LIGHTS).fill(-1);
const lightOfShadow = new Int32Array(SHADOWED_LIGHTS).fill(-1);
/** per shadow view (shadow * 6 + face): whether its slot holds a map, the frame it was drawn, where its light was */
const VIEWS_MAX = SHADOWED_LIGHTS * 6;
const viewMapped = new Uint8Array(VIEWS_MAX);
const viewDrawnFrame = new Int32Array(VIEWS_MAX);
const viewDrawnFrom: Vec3[] = Array.from({ length: VIEWS_MAX }, () => [0, 0, 0] as Vec3);
const importance = new Float32Array(MAX_LIGHTS);
const byImportance: number[] = [];
let shadowFrame = 0;

/** the SHADOWED_LIGHTS lights largest by radius over distance from the camera cast shadows, each keeping its shadow
 *  while it stays among them */
function chooseShadowedLights(count: number): void {
    byImportance.length = 0;
    for (let i = 0; i < count; i++) {
        const p = lightPositions[i];
        const r = lights[i].radius;
        const dx = p[0] - camera.position[0];
        const dy = p[1] - camera.position[1];
        const dz = p[2] - camera.position[2];
        importance[i] = (r * r) / Math.max(dx * dx + dy * dy + dz * dz, 1);
        byImportance.push(i);
    }
    byImportance.sort((a, b) => importance[b] - importance[a]);
    const chosen = new Set(byImportance.slice(0, SHADOWED_LIGHTS));
    for (let s = 0; s < SHADOWED_LIGHTS; s++) {
        const light = lightOfShadow[s];
        if (light >= 0 && !chosen.has(light)) {
            shadowOfLight[light] = -1;
            lightOfShadow[s] = -1;
        }
    }
    for (let i = count; i < MAX_LIGHTS; i++) {
        if (shadowOfLight[i] >= 0) {
            lightOfShadow[shadowOfLight[i]] = -1;
            shadowOfLight[i] = -1;
        }
    }
    for (const light of chosen) {
        if (shadowOfLight[light] >= 0) continue;
        const free = lightOfShadow.indexOf(-1);
        lightOfShadow[free] = light;
        shadowOfLight[light] = free;
        for (let f = 0; f < 6; f++) viewMapped[free * 6 + f] = 0;
    }
}

const FACE_DIRECTIONS: Vec3[] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
];
const FACE_UPS: Vec3[] = [
    [0, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [0, 0, 1],
    [0, 1, 0],
    [0, 1, 0],
];
/** a camera a view drawn this frame: the frame records every draw before it runs, so none is reused within one */
const faceCameras = Array.from({ length: SHADOW_REDRAWS }, () => new PerspectiveCamera(Math.PI / 2, 1, SHADOW_NEAR, 1));
const redraws: number[] = [];
const faceMatrix = mat4.create();

/** the views to draw again: those holding no map first, then those whose light has moved, longest since drawn
 *  first, at most SHADOW_REDRAWS */
function chooseRedraws(): void {
    redraws.length = 0;
    const wanting: number[] = [];
    for (let s = 0; s < SHADOWED_LIGHTS; s++) {
        const light = lightOfShadow[s];
        if (light < 0) continue;
        const p = lightPositions[light];
        for (let f = 0; f < 6; f++) {
            const v = s * 6 + f;
            const from = viewDrawnFrom[v];
            const moved = Math.hypot(p[0] - from[0], p[1] - from[1], p[2] - from[2]) > 0.01;
            if (viewMapped[v] === 0 || moved) wanting.push(v);
        }
    }
    wanting.sort((a, b) => viewMapped[a] - viewMapped[b] || viewDrawnFrame[a] - viewDrawnFrame[b]);
    for (let k = 0; k < Math.min(wanting.length, SHADOW_REDRAWS); k++) redraws.push(wanting[k]);
}

/** a triangle over the viewport at the far plane, depth only, whatever is there: clears one slot of the atlas */
const clearSlot = new Mesh(
    vertexCountGeometry(3),
    createMaterial({
        name: 'clear-slot',
        vertex: vec4(
            select(f32(-1), f32(3), vertexIndex.equal(u32(1))),
            select(f32(-1), f32(3), vertexIndex.equal(u32(2))),
            f32(1),
            f32(1),
        ),
        fragment: undefined,
        depthCompare: 'always',
        depthWrite: true,
    }),
);
clearSlot.frustumCulled = false;

/** the chosen views into the atlas, each its slot cleared then its culled casters drawn, its record written */
function drawShadows(f: ReturnType<typeof frame>): void {
    if (redraws.length === 0) return;
    const pass = f.pass({ target: shadowAtlas, clearDepth: false, label: 'light-shadows' });
    for (let k = 0; k < redraws.length; k++) {
        const v = redraws[k];
        const s = Math.floor(v / 6);
        const face = v % 6;
        const light = lightOfShadow[s];
        const p = lightPositions[light];
        const faceCamera = faceCameras[k];
        faceCamera.coordinateSystem = camera.coordinateSystem;
        faceCamera.far = lights[light].radius;
        faceCamera.updateProjectionMatrix();
        faceCamera.position = [p[0], p[1], p[2]];
        const dir = FACE_DIRECTIONS[face];
        faceCamera.lookAt([p[0] + dir[0], p[1] + dir[1], p[2] + dir[2]], FACE_UPS[face]);
        faceCamera.updateWorldMatrix();
        faceCamera.updateViewMatrix();
        const x = (v % SHADOW_SLOTS_ACROSS) * SHADOW_SLOT;
        const y = Math.floor(v / SHADOW_SLOTS_ACROSS) * SHADOW_SLOT;
        pass.setViewport({ x, y, width: SHADOW_SLOT, height: SHADOW_SLOT });
        pass.draw(clearSlot);
        pass.setCamera(faceCamera);
        drawColumns(pass, visibleColumns(faceCamera), (m) => m.light);
        mat4.multiply(faceMatrix, faceCamera.projectionMatrix, faceCamera.matrixWorldInverse);
        const at = (s * SHADOW_VEC4S + face * SHADOW_FACE_VEC4S) * 4;
        shadowData.set(faceMatrix, at);
        shadowData[at + 16] = x / SHADOW_ATLAS;
        shadowData[at + 17] = y / SHADOW_ATLAS;
        shadowData[at + 18] = SHADOW_SLOT / SHADOW_ATLAS;
        shadowData[at + 19] = 1;
        viewMapped[v] = 1;
        viewDrawnFrame[v] = shadowFrame;
        viewDrawnFrom[v][0] = p[0];
        viewDrawnFrom[v][1] = p[1];
        viewDrawnFrom[v][2] = p[2];
    }
    pass.end();
    // a slot taken by a new light reads as holding no map until its face is drawn
    for (let v = 0; v < VIEWS_MAX; v++)
        shadowData[(Math.floor(v / 6) * SHADOW_VEC4S + (v % 6) * SHADOW_FACE_VEC4S) * 4 + 19] = viewMapped[v];
    shadowBuffer.needsUpdate = true;
}
const viewPos: Vec3 = [0, 0, 0];
const lightPos: Vec3 = [0, 0, 0];

/** the lights at `time`, sorted by view depth, each into the tiles its sphere's screen box reaches and the depth
 *  bins its sphere spans */
function binLights(time: number): void {
    const count = settings.lights;
    const viewMatrix = camera.matrixWorldInverse;
    const width = canvas.width;
    const height = canvas.height;
    const focal = height / 2 / Math.tan(camera.fov / 2);
    const tilesX = Math.ceil(width / TILE);
    const tilesY = Math.ceil(height / TILE);
    const binsPerUnit = DEPTH_BINS / LIGHT_FAR;
    order.length = 0;
    for (let i = 0; i < count; i++) {
        const light = lights[i];
        const angle = light.phase + time * light.speed;
        const p = lightPositions[i];
        p[0] = light.base[0] + Math.cos(angle) * light.orbit;
        p[1] = light.base[1] + Math.sin(angle * 1.7) * 0.5;
        p[2] = light.base[2] + Math.sin(angle) * light.orbit;
        viewDepths[i] = -(viewMatrix[2] * p[0] + viewMatrix[6] * p[1] + viewMatrix[10] * p[2] + viewMatrix[14]);
        if (viewDepths[i] + light.radius > NEAR && viewDepths[i] - light.radius < LIGHT_FAR) order.push(i);
    }
    order.sort((a, b) => viewDepths[a] - viewDepths[b]);
    chooseShadowedLights(count);
    tileData.fill(0, 0, tilesX * tilesY * LIGHT_WORDS);
    for (let b = 0; b < DEPTH_BINS; b++) binData[b] = 0xffff;
    for (let s = 0; s < order.length; s++) {
        const i = order[s];
        const p = lightPositions[i];
        const radius = lights[i].radius;
        lightData.set(p, s * 8);
        lightData[s * 8 + 3] = radius;
        lightData.set(lights[i].color, s * 8 + 4);
        lightData[s * 8 + 7] = shadowOfLight[i] + 1;
        for (let a = 0; a < 3; a++) lightPos[a] = p[a];
        for (let a = 0; a < 3; a++)
            viewPos[a] =
                viewMatrix[a] * lightPos[0] +
                viewMatrix[4 + a] * lightPos[1] +
                viewMatrix[8 + a] * lightPos[2] +
                viewMatrix[12 + a];
        const depth = -viewPos[2];
        // the bins its sphere spans
        const b0 = Math.max(0, Math.floor((depth - radius) * binsPerUnit));
        const b1 = Math.min(DEPTH_BINS - 1, Math.floor((depth + radius) * binsPerUnit));
        for (let b = b0; b <= b1; b++) {
            const first = binData[b] & 0xffff;
            const last = binData[b] >>> 16;
            binData[b] = (first === 0xffff ? s : Math.min(first, s)) | (Math.max(first === 0xffff ? 0 : last, s) << 16);
        }
        // the tiles the corners of its view-space box project to; one reaching the near plane, every tile
        let x0 = 0;
        let x1 = tilesX - 1;
        let y0 = 0;
        let y1 = tilesY - 1;
        if (depth - radius > NEAR) {
            let minX = Infinity;
            let maxX = -Infinity;
            let minY = Infinity;
            let maxY = -Infinity;
            for (let corner = 0; corner < 8; corner++) {
                const cx = viewPos[0] + (corner & 1 ? radius : -radius);
                const cy = viewPos[1] + (corner & 2 ? radius : -radius);
                const cd = depth + (corner & 4 ? radius : -radius);
                const sx = width / 2 + (cx / cd) * focal;
                const sy = height / 2 - (cy / cd) * focal;
                minX = Math.min(minX, sx);
                maxX = Math.max(maxX, sx);
                minY = Math.min(minY, sy);
                maxY = Math.max(maxY, sy);
            }
            if (maxX < 0 || maxY < 0 || minX >= width || minY >= height) continue;
            x0 = Math.max(0, Math.floor(minX / TILE));
            x1 = Math.min(tilesX - 1, Math.floor(maxX / TILE));
            y0 = Math.max(0, Math.floor(minY / TILE));
            y1 = Math.min(tilesY - 1, Math.floor(maxY / TILE));
        }
        const word = s >> 5;
        const bit = 1 << (s & 31);
        for (let ty = y0; ty <= y1; ty++) {
            for (let tx = x0; tx <= x1; tx++) {
                const at = (tx + ty * tilesX) * LIGHT_WORDS + word;
                tileData[at] = (tileData[at] | bit) >>> 0;
            }
        }
    }
    lightBuffer.addUpdateRange(0, Math.max(order.length, 1) * 8);
    lightBuffer.needsUpdate = true;
    tileBuffer.addUpdateRange(0, tilesX * tilesY * LIGHT_WORDS);
    tileBuffer.needsUpdate = true;
    binBuffer.needsUpdate = true;
    frameConfig.up[3] = tilesX;
}

function updateFrame(time: number): void {
    const day = settings.time === 'day';
    const sky = day ? SKY_DAY : SKY_NIGHT;
    view.clearColor = [sky[0], sky[1], sky[2], 1];
    const m = camera.matrixWorld;
    const tanY = Math.tan(camera.fov / 2);
    const tanX = tanY * camera.aspect;
    frameConfig.eye[0] = m[12];
    frameConfig.eye[1] = m[13];
    frameConfig.eye[2] = m[14];
    for (let a = 0; a < 3; a++) {
        frameConfig.right[a] = m[a] * tanX;
        frameConfig.up[a] = m[4 + a] * tanY;
        frameConfig.forward[a] = -m[8 + a];
    }
    frameConfig.sun[0] = SUN[0];
    frameConfig.sun[1] = SUN[1];
    frameConfig.sun[2] = SUN[2];
    frameConfig.sun[3] = day ? 1 : 0;
    frameConfig.sky[0] = sky[0];
    frameConfig.sky[1] = sky[1];
    frameConfig.sky[2] = sky[2];
    frameConfig.options[1] = SHOW.indexOf(settings.show);
    frameConfig.options[2] = settings.shadowedOnly ? 1 : 0;
    frameConfig.options[0] = settings.shadows ? 1 : 0;
    if (day) fitSun();
    binLights(time);
    frameUniform.value = frameConfig;
    sizeValue[0] = canvas.width;
    sizeValue[1] = canvas.height;
    sizeUniform.value = sizeValue;
}

// ─── Controls ───────────────────────────────────────────────────────────────

const info = { triangles: Math.round(triangles).toLocaleString(), frame: '' };
const gui = new GUI();
gui.add(settings, 'path', ['forward', 'prepass', 'deferred']);
gui.add(settings, 'view', Object.keys(VIEWS)).onChange((name: string) => setView(name));
gui.add(settings, 'time', ['day', 'night']);
gui.add(settings, 'lights', 0, MAX_LIGHTS, 1);
gui.add(settings, 'shadows').name('light shadows');
gui.add(settings, 'shadowedOnly').name('shadowed lights only');
gui.add(settings, 'move').name('move lights');
gui.add(settings, 'show', [...SHOW]);
gui.add(info, 'triangles').disable();
const frameReadout = gui.add(info, 'frame').name('frame ms').disable();

// ─── Loop ───────────────────────────────────────────────────────────────────

let time = 0;
let previous = performance.now();
let smoothed = 16;

function update(): void {
    const now = performance.now();
    const dt = (now - previous) / 1000;
    previous = now;
    smoothed = smoothed * 0.95 + dt * 1000 * 0.05;
    info.frame = smoothed.toFixed(1);
    frameReadout.updateDisplay();
    if (settings.move) time += dt;

    controls.update();
    camera.updateWorldMatrix();
    camera.updateViewMatrix();
    updateFrame(time);

    const f = frame(renderer);
    shadowFrame++;
    if (settings.shadows && settings.lights > 0) {
        chooseRedraws();
        drawShadows(f);
    }
    if (settings.time === 'day') {
        const sunPass = f.pass({ target: sunMap, camera: sunCamera, clearDepth: 1, label: 'sun' });
        drawColumns(sunPass, visibleColumns(sunCamera), (m) => m.sun);
        sunPass.end();
    }
    if (settings.path === 'deferred') {
        const geometryPass = f.pass({ target: gbuffer, camera, clear: [0, 0, 0, 0], label: 'gbuffer' });
        drawColumns(geometryPass, visibleColumns(camera), (m) => m.gbuffer);
        geometryPass.end();
        const lighting = f.pass({ target: view, label: 'lighting' });
        lighting.draw(lightingPass);
        lighting.end();
    } else {
        const pass = f.pass({ target: view, camera, label: settings.path });
        if (settings.path === 'prepass') {
            const visible = visibleColumns(camera);
            drawColumns(pass, visible, (m) => m.prepassDepth);
            drawColumns(pass, visible, (m) => m.prepassColor);
        } else {
            drawColumns(pass, visibleColumns(camera), (m) => m.forward);
        }
        pass.end();
    }
    f.submit();
    requestAnimationFrame(update);
}

requestAnimationFrame(update);
