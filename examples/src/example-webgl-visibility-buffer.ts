import {
    abs,
    BufferLifecycle,
    cameraProjectionMatrix,
    cameraViewMatrix,
    clamp,
    comparisonSampler,
    countTrailingZeros,
    createCanvasTarget,
    createDataTexture,
    createIndexBuffer,
    createMaterial,
    createRenderTarget,
    cross,
    Discard,
    d,
    depthTexture,
    dot,
    dpdx,
    dpdy,
    exp2,
    Fn,
    f32,
    floor,
    fract,
    frame,
    fullscreen,
    Geometry,
    GpuBuffer,
    GpuSampler,
    If,
    type IndexedMeshDraw,
    init,
    instanceIndex,
    invariant,
    Loop,
    length,
    log2,
    type Material,
    Mesh,
    max,
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
    sqrt,
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

// A visibility buffer against forward and deferred, on a stress scene drawn the way bongle's renderer draws it:
//
// - Terrain is bongle's: 64-byte quad records (16-bit positions, an octahedral normal, per-corner uvs, the texture
//   index, per-corner ambient occlusion and a diagonal flip, per-corner baked light: sky and rgb), pulled by the
//   vertex shader from a buffer as quad lists, each draw a section's run from its first quad. Its texture is one
//   atlas with a table of rects and animations, sampled as bongle samples it: two animation frames, a texel-snapped
//   nearest tap up close, four anisotropic taps at an explicit level far off. Cutout reads one texel's alpha.
// - Models are bongle's: 32-byte vertices in a pool, a row a model (its matrix and its look) through a slot map, the
//   voxel light sampled per vertex.
// - Sprites are bongle's: a row each, turned about the vertical to the camera, their light, sun shadow and point
//   lights worked out per vertex, so their fragment is a texture tap.
// - Every surface is lit as bongle lights it: the voxel light under the sun's facing shade, the sun's warped map's
//   four filtered taps, point lights found by screen tile and depth bin with the nearest few shadowed from cube maps
//   in an atlas, kept, a few faces redrawn a frame, then fog.
//
// Three ways to draw it:
// - forward, as bongle orders it: opaque terrain, cutout terrain's depth, models, sprites, then cutout terrain's
//   colour testing equal.
// - deferred: one geometry pass writing 96 bits a pixel (albedo and glow; normal, how outdoors and flags; the voxel
//   light), one fullscreen pass lighting it.
// - visibility: one geometry pass writing 32 bits a pixel, which surface it is (its kind and its quad, triangle or
//   row); a fullscreen pass rebuilds it from the kind's own data (the quad's corners and the pixel's point on it, its
//   barycentric weights, its uv and the uv's screen derivatives), samples its texture there, and lights it.

const WORLD_X = 192;
const WORLD_Y = 48;
const WORLD_Z = 192;
const SECTION = 16;
const SECTIONS_X = WORLD_X / SECTION;
const SECTIONS_Y = WORLD_Y / SECTION;
const SECTIONS_Z = WORLD_Z / SECTION;
const TILE = 32;
const MAX_LIGHTS = 256;
const LIGHT_WORDS = MAX_LIGHTS / 32;
const DEPTH_BINS = 128;
const LIGHT_FAR = 160;
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
/** views a frame draws kinds into: the camera, the sun, SHADOW_REDRAWS light faces */
const MAX_VIEWS = 2 + SHADOW_REDRAWS;

// bongle's quad record, 16 words
const QUAD_U32S = 16;
const POS_ENCODE_SCALE = 2048;
const POS_ENCODE_ORIGIN = 8;
const FLAGS_WORD = 11;
const META_WORD = 12;
const LIGHT_WORD = 13;
const DIAG_FLIP_BIT = 16;
const AO_BRIGHTNESS = [0.5, 0.6, 0.8, 1.0];
/** quads a draw at most: the quad list's indices, 4 vertices a quad */
const QUADS_A_DRAW = 1 << 14;

const AIR = 0;
const GRASS = 1;
const DIRT = 2;
const STONE = 3;
const WOOD = 4;
const LEAVES = 5;
const BRICK = 6;
const LANTERN = 7;

// texture indices: an entry a texture, an animated one's frames following it
const TEX_GRASS_TOP = 0;
const TEX_DIRT = 1;
const TEX_STONE = 2;
const TEX_WOOD = 3;
const TEX_LEAVES = 4;
const TEX_BRICK = 5;
const TEX_BLADES = 6;
const TEX_LANTERN = 7;
const TEX_SKIN = 9;
const TEX_FLOWER = 10;
const TEXTURES = 11;

/** what a visibility pixel holds in its top two bits */
const KIND_TERRAIN = 0;
const KIND_CUTOUT = 1;
const KIND_MODEL = 2;
const KIND_SPRITE = 3;

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

/** deferred's 96 bits: albedo and glow; normal, how outdoors and flags; the voxel light */
const gbuffer = createRenderTarget(1, 1, { colorFormat: 'rgba8unorm', count: 3, depthSampled: true, label: 'gbuffer' });
/** the visibility buffer: which surface, 32 bits, and depth */
const visibility = createRenderTarget(1, 1, { colorFormat: 'rgba8unorm', depthSampled: true, label: 'visibility' });

function resize(): void {
    view.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    gbuffer.setSize(canvas.width, canvas.height);
    visibility.setSize(canvas.width, canvas.height);
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
const opaqueBlock = (block: number) => block !== AIR && block !== LEAVES;

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
    // a lantern inside
    setBlock(x0 + 2, floorY, z0 + 2, LANTERN);
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
                    if (blockAt(x + dx, y0 + trunk + dy, z + dz) === AIR) setBlock(x + dx, y0 + trunk + dy, z + dz, LEAVES);
                }
            }
        }
    }
}
// lanterns about the forest floor, the block light's sources
for (let i = 0; i < 160; i++) {
    const x = 2 + Math.floor(random() * (WORLD_X - 4));
    const z = 2 + Math.floor(random() * (WORLD_Z - 4));
    const y = ground(x, z) + 1;
    if (blockAt(x, y, z) === AIR) setBlock(x, y, z, LANTERN);
}

// ─── Voxel light: sky and block light a cell, 0 to 15 a channel ─────────────

/** a cell's light: sky | r << 4 | g << 8 | b << 12, SOLID_CELL for a solid one */
const SOLID_CELL = 1 << 16;
const cellLight = new Uint32Array(blocks.length);
{
    // sky: open sky 15 down each column to its top, then spreading a level a step, two through leaves
    const sky = new Uint8Array(blocks.length);
    const queue: number[] = [];
    for (let x = 0; x < WORLD_X; x++) {
        for (let z = 0; z < WORLD_Z; z++) {
            for (let y = WORLD_Y - 1; y >= 0; y--) {
                const block = blockAt(x, y, z);
                if (block !== AIR) break;
                sky[blockIndex(x, y, z)] = 15;
                queue.push(blockIndex(x, y, z));
            }
        }
    }
    const spread = (levels: Uint8Array, queue: number[], cost: (block: number) => number) => {
        for (let q = 0; q < queue.length; q++) {
            const i = queue[q];
            const level = levels[i];
            const x = i % WORLD_X;
            const z = Math.floor(i / WORLD_X) % WORLD_Z;
            const y = Math.floor(i / (WORLD_X * WORLD_Z));
            for (const [dx, dy, dz] of [
                [1, 0, 0],
                [-1, 0, 0],
                [0, 1, 0],
                [0, -1, 0],
                [0, 0, 1],
                [0, 0, -1],
            ]) {
                const nx = x + dx;
                const ny = y + dy;
                const nz = z + dz;
                if (!inWorld(nx, ny, nz)) continue;
                const block = blockAt(nx, ny, nz);
                if (opaqueBlock(block) && block !== LANTERN) continue;
                const next = level - cost(block);
                const ni = blockIndex(nx, ny, nz);
                if (next > levels[ni]) {
                    levels[ni] = next;
                    queue.push(ni);
                }
            }
        }
    };
    spread(sky, queue, (block) => (block === LEAVES ? 2 : 1));
    // block light: each lantern 14 in its colour, spreading a level a step
    const channels = [new Uint8Array(blocks.length), new Uint8Array(blocks.length), new Uint8Array(blocks.length)];
    const colors: Vec3[] = [
        [1, 0.75, 0.35],
        [0.5, 0.8, 1],
        [1, 0.45, 0.25],
    ];
    const seeds: number[][] = [[], [], []];
    let lanterns = 0;
    for (let i = 0; i < blocks.length; i++) {
        if (blocks[i] !== LANTERN) continue;
        const color = colors[lanterns++ % colors.length];
        for (let c = 0; c < 3; c++) {
            const level = Math.round(14 * color[c]);
            if (level > channels[c][i]) {
                channels[c][i] = level;
                seeds[c].push(i);
            }
        }
    }
    for (let c = 0; c < 3; c++) spread(channels[c], seeds[c], () => 1);
    for (let i = 0; i < blocks.length; i++) {
        cellLight[i] =
            opaqueBlock(blocks[i]) && blocks[i] !== LANTERN
                ? SOLID_CELL
                : sky[i] | (channels[0][i] << 4) | (channels[1][i] << 8) | (channels[2][i] << 12);
    }
}
const lightOf = (x: number, y: number, z: number, shift: number) => {
    if (!inWorld(x, y, z)) return shift === 0 ? 15 : 0;
    const cell = cellLight[blockIndex(x, y, z)];
    return cell === SOLID_CELL ? -1 : (cell >> shift) & 15;
};

// ─── Terrain: bongle's quad records, a section's run each ───────────────────

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
/** a corner's uv, shrunk a quarter texel as the mesher shrinks it so a nearest tap stays in its tile */
const UV_INSET = 0.25 / 16;
const QUAD_UVS = [
    [UV_INSET, 1 - UV_INSET],
    [1 - UV_INSET, 1 - UV_INSET],
    [1 - UV_INSET, UV_INSET],
    [UV_INSET, UV_INSET],
];

/** a normal's oct16, as the mesher writes it */
function encodeOct16(nx: number, ny: number, nz: number): number {
    const l1 = Math.abs(nx) + Math.abs(ny) + Math.abs(nz) + 1e-30;
    let ox = nx / l1;
    let oy = ny / l1;
    if (nz < 0) {
        const tx = (1 - Math.abs(oy)) * (ox >= 0 ? 1 : -1);
        const ty = (1 - Math.abs(ox)) * (oy >= 0 ? 1 : -1);
        ox = tx;
        oy = ty;
    }
    return Math.round((ox * 0.5 + 0.5) * 255) | (Math.round((oy * 0.5 + 0.5) * 255) << 8);
}

/** a pass's quads, record after record, and the section each belongs to */
type QuadArena = { words: number[]; slots: number[] };
const opaqueArena: QuadArena = { words: [], slots: [] };
const cutoutArena: QuadArena = { words: [], slots: [] };

/** one quad into `arena`: corners in section-local voxels, their uvs, ao levels (0..3) and lights ([sky, r, g, b] 0..60) */
function pushQuad(
    arena: QuadArena,
    section: number,
    corners: Vec3[],
    normal: Vec3,
    blockLocal: Vec3,
    texIndex: number,
    facing: number,
    emissive: boolean,
    unshaded: boolean,
    ao: number[],
    lights: number[][],
): void {
    const words = new Uint32Array(QUAD_U32S);
    const halves: number[] = [];
    for (const c of corners) for (let a = 0; a < 3; a++) halves.push(Math.round((c[a] + POS_ENCODE_ORIGIN) * POS_ENCODE_SCALE));
    for (let w = 0; w < 6; w++) words[w] = halves[w * 2] | (halves[w * 2 + 1] << 16);
    words[6] =
        encodeOct16(normal[0], normal[1], normal[2]) | (blockLocal[0] << 16) | (blockLocal[1] << 20) | (blockLocal[2] << 24);
    for (let c = 0; c < 4; c++) words[7 + c] = Math.round(QUAD_UVS[c][0] * 65535) | (Math.round(QUAD_UVS[c][1] * 65535) << 16);
    words[FLAGS_WORD] = texIndex | (facing << 20) | ((emissive ? 1 : 0) << 23) | ((unshaded ? 1 : 0) << 24);
    const aoBits = ao.map((level) => Math.round((AO_BRIGHTNESS[level] - 0.5) * 30));
    words[META_WORD] =
        aoBits[0] |
        (aoBits[1] << 4) |
        (aoBits[2] << 8) |
        (aoBits[3] << 12) |
        ((aoBits[0] + aoBits[2] < aoBits[1] + aoBits[3] ? 1 : 0) << DIAG_FLIP_BIT);
    // 24 bits a corner from the low bits: sky << 18 | r << 12 | g << 6 | b
    let bits = 0n;
    for (let c = 0; c < 4; c++) {
        const [sky, r, g, b] = lights[c];
        bits |= BigInt((sky << 18) | (r << 12) | (g << 6) | b) << BigInt(24 * c);
    }
    for (let w = 0; w < 3; w++) words[LIGHT_WORD + w] = Number((bits >> BigInt(32 * w)) & 0xffffffffn);
    for (let w = 0; w < QUAD_U32S; w++) arena.words.push(words[w]);
    arena.slots.push(section);
}

/** a section's runs in each pass, and the box it lies in */
type Section = { origin: Vec3; box: Box3; opaqueFirst: number; opaqueCount: number; cutoutFirst: number; cutoutCount: number };
const sections: Section[] = [];
for (let sy = 0; sy < SECTIONS_Y; sy++) {
    for (let sz = 0; sz < SECTIONS_Z; sz++) {
        for (let sx = 0; sx < SECTIONS_X; sx++) {
            const origin: Vec3 = [sx * SECTION, sy * SECTION, sz * SECTION];
            const s = sections.length;
            const section: Section = {
                origin,
                box: [origin[0], origin[1], origin[2], origin[0] + SECTION, origin[1] + SECTION + 2, origin[2] + SECTION],
                opaqueFirst: opaqueArena.slots.length,
                opaqueCount: 0,
                cutoutFirst: cutoutArena.slots.length,
                cutoutCount: 0,
            };
            for (let ly = 0; ly < SECTION; ly++) {
                for (let lz = 0; lz < SECTION; lz++) {
                    for (let lx = 0; lx < SECTION; lx++) {
                        const x = origin[0] + lx;
                        const y = origin[1] + ly;
                        const z = origin[2] + lz;
                        const block = blockAt(x, y, z);
                        if (block === AIR) continue;
                        const arena = block === LEAVES ? cutoutArena : opaqueArena;
                        for (let face = 0; face < 6; face++) {
                            const { n, corners } = FACES[face];
                            // only an opaque block hides a face: one behind leaves shows through their holes, and a
                            // leaf beside a leaf keeps it, as fancy leaves do
                            if (opaqueBlock(blockAt(x + n[0], y + n[1], z + n[2]))) continue;
                            const fx = x + n[0];
                            const fy = y + n[1];
                            const fz = z + n[2];
                            const ao: number[] = [];
                            const lights: number[][] = [];
                            for (const c of corners) {
                                const side: Vec3[] = [];
                                const offset: Vec3 = [0, 0, 0];
                                for (let a = 0; a < 3; a++) {
                                    if (n[a] !== 0) continue;
                                    const v: Vec3 = [0, 0, 0];
                                    v[a] = c[a] === 1 ? 1 : -1;
                                    offset[a] = v[a];
                                    side.push(v);
                                }
                                const cells: Vec3[] = [
                                    [fx, fy, fz],
                                    [fx + side[0][0], fy + side[0][1], fz + side[0][2]],
                                    [fx + side[1][0], fy + side[1][1], fz + side[1][2]],
                                    [fx + offset[0], fy + offset[1], fz + offset[2]],
                                ];
                                const s1 = opaqueBlock(blockAt(...cells[1])) ? 1 : 0;
                                const s2 = opaqueBlock(blockAt(...cells[2])) ? 1 : 0;
                                const corner = opaqueBlock(blockAt(...cells[3])) ? 1 : 0;
                                ao.push(s1 && s2 ? 0 : 3 - s1 - s2 - corner);
                                // the sum of the four cells' levels, a solid one taking the face's own cell's
                                const light = [0, 0, 0, 0];
                                for (let k = 0; k < 4; k++) {
                                    const shift = [0, 4, 8, 12][k];
                                    const own = Math.max(lightOf(fx, fy, fz, shift), 0);
                                    for (const cell of cells) {
                                        const level = lightOf(cell[0], cell[1], cell[2], shift);
                                        light[k] += level < 0 ? own : level;
                                    }
                                }
                                lights.push(light);
                            }
                            const local = corners.map((c) => [lx + c[0], ly + c[1], lz + c[2]] as Vec3);
                            const tex =
                                block === GRASS
                                    ? face === 2
                                        ? TEX_GRASS_TOP
                                        : TEX_DIRT
                                    : block === DIRT
                                      ? TEX_DIRT
                                      : block === STONE
                                        ? TEX_STONE
                                        : block === WOOD
                                          ? TEX_WOOD
                                          : block === LEAVES
                                            ? TEX_LEAVES
                                            : block === BRICK
                                              ? TEX_BRICK
                                              : TEX_LANTERN;
                            pushQuad(arena, s, local, n, [lx, ly, lz], tex, face, block === LANTERN, false, ao, lights);
                        }
                        // grass blades on most open grass: two crossed quads, unshaded, in the cutout pass
                        if (block === GRASS && blockAt(x, y + 1, z) === AIR && random() < 0.6) {
                            const level = [0, 4, 8, 12].map((shift) => lightOf(x, y + 1, z, shift) * 4);
                            for (const [ax, az, bx, bz] of [
                                [0.15, 0.15, 0.85, 0.85],
                                [0.85, 0.15, 0.15, 0.85],
                            ]) {
                                const corners: Vec3[] = [
                                    [lx + ax, ly + 1, lz + az],
                                    [lx + bx, ly + 1, lz + bz],
                                    [lx + bx, ly + 1.8, lz + bz],
                                    [lx + ax, ly + 1.8, lz + az],
                                ];
                                const nx = bz - az;
                                const nz = -(bx - ax);
                                const nl = Math.hypot(nx, nz);
                                pushQuad(
                                    cutoutArena,
                                    s,
                                    corners,
                                    [nx / nl, 0, nz / nl],
                                    [lx, Math.min(ly + 1, 15), lz],
                                    TEX_BLADES,
                                    6,
                                    false,
                                    true,
                                    [3, 3, 3, 3],
                                    [level, level, level, level],
                                );
                            }
                        }
                    }
                }
            }
            section.opaqueCount = opaqueArena.slots.length - section.opaqueFirst;
            section.cutoutCount = cutoutArena.slots.length - section.cutoutFirst;
            sections.push(section);
        }
    }
}

/** both passes' quads in one buffer, opaque then cutout: as words, as the vertex shader reads them, and as vec4s, as the
 *  resolve reads them; and each quad's section. WebGL binds a storage buffer as a texture, at most 16 to a fragment
 *  shader, and the resolve reads every kind's data at once, so what can share a buffer does */
const OPAQUE_QUADS = opaqueArena.slots.length;
const CUTOUT_QUADS = cutoutArena.slots.length;
const quadWords = new Uint32Array((OPAQUE_QUADS + CUTOUT_QUADS) * QUAD_U32S);
quadWords.set(opaqueArena.words);
quadWords.set(cutoutArena.words, OPAQUE_QUADS * QUAD_U32S);
const quadSlots = new Uint32Array(OPAQUE_QUADS + CUTOUT_QUADS);
quadSlots.set(opaqueArena.slots);
quadSlots.set(cutoutArena.slots, OPAQUE_QUADS);
const quadWordBuffer = new GpuBuffer(d.array(d.u32), { label: 'quads', data: quadWords, usage: 'storage' });
const quadVec4Buffer = new GpuBuffer(d.array(d.vec4u), {
    label: 'quads-vec4',
    data: new Uint32Array(quadWords),
    usage: 'storage',
});
const quadSlotBuffer = new GpuBuffer(d.array(d.u32), { label: 'quad-slots', data: quadSlots, usage: 'storage' });
/** each section's origin, as bongle's chunkInfo holds it */
const sectionOrigins = new Float32Array(sections.length * 4);
sections.forEach((s, i) => sectionOrigins.set([s.origin[0], s.origin[1], s.origin[2], 0], i * 4));

/** quad q at vertices 4q to 4q + 3, two triangles over its corners, as bongle's quad list */
const quadIndices = (() => {
    const indices = new Uint32Array(QUADS_A_DRAW * 6);
    for (let q = 0; q < QUADS_A_DRAW; q++) for (let k = 0; k < 6; k++) indices[q * 6 + k] = q * 4 + [0, 1, 2, 0, 2, 3][k];
    return createIndexBuffer(indices, 'quad-indices');
})();

// ─── The atlas: 16-texel tiles in a grid, with a table of rects and animations ───

const ATLAS_TILE = 16;
const ATLAS_COLUMNS = 4;
const ATLAS_SIZE = ATLAS_TILE * ATLAS_COLUMNS;
const atlasData = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4);
const TILE_COLORS: Vec3[] = [
    [0.36, 0.6, 0.24],
    [0.45, 0.32, 0.2],
    [0.48, 0.48, 0.5],
    [0.42, 0.3, 0.18],
    [0.22, 0.45, 0.16],
    [0.6, 0.27, 0.2],
    [0.3, 0.62, 0.2],
    [0.95, 0.75, 0.35],
    [1.0, 0.85, 0.45],
    [0.85, 0.75, 0.6],
    [0.85, 0.35, 0.55],
];
for (let tile = 0; tile < TEXTURES; tile++) {
    const base = TILE_COLORS[tile];
    const ox = (tile % ATLAS_COLUMNS) * ATLAS_TILE;
    const oy = Math.floor(tile / ATLAS_COLUMNS) * ATLAS_TILE;
    for (let v = 0; v < ATLAS_TILE; v++) {
        for (let u = 0; u < ATLAS_TILE; u++) {
            const at = ((oy + v) * ATLAS_SIZE + ox + u) * 4;
            const shade = 0.75 + random() * 0.4;
            let alpha = 255;
            if (tile === TEX_LEAVES && random() < 0.35) alpha = 0;
            if (tile === TEX_BLADES && !((u % 4 === 1 || u % 4 === 2) && random() < 1 - v / 20)) alpha = 0;
            if (tile === TEX_FLOWER && Math.hypot(u - 7.5, v - 5) > 4.5 && !(u >= 7 && u <= 8 && v > 8)) alpha = 0;
            atlasData[at] = Math.min(255, base[0] * shade * 255);
            atlasData[at + 1] = Math.min(255, base[1] * shade * 255);
            atlasData[at + 2] = Math.min(255, base[2] * shade * 255);
            atlasData[at + 3] = alpha;
        }
    }
}
const ATLAS_MIP_LEVELS = 4;
const atlas = createDataTexture(atlasData, ATLAS_SIZE, ATLAS_SIZE, {
    format: 'rgba8unorm',
    magFilter: 'nearest',
    minFilter: 'nearest',
    mipmapFilter: 'linear',
    generateMipmaps: true,
});
const atlasNode = texture(atlas);
const TEXEL = 1 / ATLAS_SIZE;
/** each texture's rect (u, v, w, h) and animation (frames, fps, blend, 0), as bongle's texture entries */
const entryData = new Float32Array(TEXTURES * 8);
for (let tile = 0; tile < TEXTURES; tile++) {
    const ox = (tile % ATLAS_COLUMNS) * ATLAS_TILE;
    const oy = Math.floor(tile / ATLAS_COLUMNS) * ATLAS_TILE;
    entryData.set([ox / ATLAS_SIZE, oy / ATLAS_SIZE, ATLAS_TILE / ATLAS_SIZE, ATLAS_TILE / ATLAS_SIZE, 1, 0, 0, 0], tile * 8);
}
// the lantern flickers between two frames, blended
entryData.set([2, 3, 1, 0], TEX_LANTERN * 8 + 4);

// ─── Models: a pool of 32-byte vertices, a row each ─────────────────────────

/** the model's vertices: (position, u), (normal, v); a body, a head and four legs */
const modelVertices: number[] = [];
for (const [cx, cy, cz, sx, sy, sz] of [
    [0, 0.9, 0, 0.6, 0.6, 1.0],
    [0, 1.4, 0.55, 0.45, 0.45, 0.45],
    [-0.2, 0.3, 0.35, 0.18, 0.6, 0.18],
    [0.2, 0.3, 0.35, 0.18, 0.6, 0.18],
    [-0.2, 0.3, -0.35, 0.18, 0.6, 0.18],
    [0.2, 0.3, -0.35, 0.18, 0.6, 0.18],
]) {
    for (const { n, corners } of FACES) {
        for (const k of [0, 1, 2, 0, 2, 3]) {
            const c = corners[k];
            modelVertices.push(cx + (c[0] - 0.5) * sx, cy + (c[1] - 0.5) * sy, cz + (c[2] - 0.5) * sz, QUAD_UVS[k][0]);
            modelVertices.push(n[0], n[1], n[2], QUAD_UVS[k][1]);
        }
    }
}
const MODEL_VERTICES = modelVertices.length / 8;
const modelPool = new Float32Array(modelVertices);
/** the pool's vertices drawn unshared, so a vertex index says its triangle */
const modelIndices = createIndexBuffer(new Uint32Array(Array.from({ length: MODEL_VERTICES }, (_, i) => i)), 'model-indices');

/** a model row: its matrix's columns, tint, flash, (glow, unlit, litMin, dither), (uv offset, uv scale),
 *  (receives shadows) */
const MODEL_ROW_VEC4S = 9;
const modelRows = new Float32Array(MODELS * MODEL_ROW_VEC4S * 4);
const modelRowPositions: Vec3[] = [];

/** a spot on open ground, for a model or a sprite */
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

const skinRect = entryData.subarray(TEX_SKIN * 8, TEX_SKIN * 8 + 4);
for (let i = 0; i < MODELS; i++) {
    const [x, y, z] = openGround();
    const m = mat4.create();
    mat4.fromYRotation(m, random() * Math.PI * 2);
    m[12] = x;
    m[13] = y;
    m[14] = z;
    const at = i * MODEL_ROW_VEC4S * 4;
    modelRows.set(m, at);
    modelRows.set([0.6 + random() * 0.4, 0.5 + random() * 0.4, 0.4 + random() * 0.4, 0.6], at + 16);
    modelRows.set([0, 0, 0, 0], at + 20);
    modelRows.set([0, 0, 0, 0], at + 24);
    modelRows.set([skinRect[0], skinRect[1], skinRect[2], skinRect[3]], at + 28);
    modelRows.set([1, 0, 0, 0], at + 32);
    modelRowPositions.push([x, y, z]);
}

// ─── Sprites: a row each ────────────────────────────────────────────────────

/** a sprite row: (position, width), (height, 0, 0, 0), uv rect, tint, flash, (glow, unlit, litMin, dither),
 *  (receives shadows) */
const SPRITE_ROW_VEC4S = 7;
const spriteRows = new Float32Array(SPRITES * SPRITE_ROW_VEC4S * 4);
const spriteRowPositions: Vec3[] = [];
const flowerRect = entryData.subarray(TEX_FLOWER * 8, TEX_FLOWER * 8 + 4);
for (let i = 0; i < SPRITES; i++) {
    const [x, y, z] = openGround();
    const size = 0.6 + random() * 0.5;
    const at = i * SPRITE_ROW_VEC4S * 4;
    spriteRows.set([x, y, z, size], at);
    spriteRows.set([size, 0, 0, 0], at + 4);
    spriteRows.set([flowerRect[0], flowerRect[1], flowerRect[2], flowerRect[3]], at + 8);
    spriteRows.set([1, 0.8, 0.9, 0.3], at + 12);
    spriteRows.set([0, 0, 0, 0], at + 16);
    spriteRows.set([0, 0, 0, 0], at + 20);
    spriteRows.set([1, 0, 0, 0], at + 24);
    spriteRowPositions.push([x, y, z]);
}

/** the scene's fixed vec4s in one buffer: the sections' origins, the texture entries, the model pool, the model rows,
 *  the sprite rows, each from its base */
const SCENE_SECTIONS = 0;
const SCENE_ENTRIES = SCENE_SECTIONS + sections.length;
const SCENE_POOL = SCENE_ENTRIES + TEXTURES * 2;
const SCENE_MODEL_ROWS = SCENE_POOL + MODEL_VERTICES * 2;
const SCENE_SPRITE_ROWS = SCENE_MODEL_ROWS + MODELS * MODEL_ROW_VEC4S;
const sceneData = new Float32Array((SCENE_SPRITE_ROWS + SPRITES * SPRITE_ROW_VEC4S) * 4);
sceneData.set(sectionOrigins, SCENE_SECTIONS * 4);
sceneData.set(entryData, SCENE_ENTRIES * 4);
sceneData.set(modelPool, SCENE_POOL * 4);
sceneData.set(modelRows, SCENE_MODEL_ROWS * 4);
sceneData.set(spriteRows, SCENE_SPRITE_ROWS * 4);
const sceneBuffer = new GpuBuffer(d.array(d.vec4f), { label: 'scene', data: sceneData, usage: 'storage' });
const sceneNodes = storage(sceneBuffer, 'read');
const sceneAt = (base: number, index: Node<d.u32>) => sceneNodes.element(index.add(u32(base)));
const spriteQuadIndices = createIndexBuffer(new Uint32Array([0, 1, 2, 0, 2, 3]), 'sprite-indices');

/** rows by the column of sections they stand in, for culling */
const COLUMNS = SECTIONS_X * SECTIONS_Z;
const columnModelRows: number[][] = Array.from({ length: COLUMNS }, () => []);
modelRowPositions.forEach((p, row) =>
    columnModelRows[Math.floor(p[0] / SECTION) + Math.floor(p[2] / SECTION) * SECTIONS_X].push(row),
);
const columnSpriteRows: number[][] = Array.from({ length: COLUMNS }, () => []);
spriteRowPositions.forEach((p, row) =>
    columnSpriteRows[Math.floor(p[0] / SECTION) + Math.floor(p[2] / SECTION) * SECTIONS_X].push(row),
);
const columnBoxes: Box3[] = Array.from({ length: COLUMNS }, (_, c) => {
    const x0 = (c % SECTIONS_X) * SECTION;
    const z0 = Math.floor(c / SECTIONS_X) * SECTION;
    return [x0 - 1, 0, z0 - 1, x0 + SECTION + 1, WORLD_Y + 2, z0 + SECTION + 1];
});

/** the slot maps: each view's visible rows, one run after another, read through `instanceIndex` */
const modelSlotData = new Uint32Array(MODELS * MAX_VIEWS);
const modelSlotBuffer = new GpuBuffer(d.array(d.u32), {
    label: 'model-slots',
    data: modelSlotData,
    usage: 'storage',
    lifecycle: BufferLifecycle.MANUAL,
});
const spriteSlotData = new Uint32Array(SPRITES * MAX_VIEWS);
const spriteSlotBuffer = new GpuBuffer(d.array(d.u32), {
    label: 'sprite-slots',
    data: spriteSlotData,
    usage: 'storage',
    lifecycle: BufferLifecycle.MANUAL,
});

const triangles = (OPAQUE_QUADS + CUTOUT_QUADS) * 2 + (MODEL_VERTICES / 3) * MODELS + 2 * SPRITES;

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
    /** the sky's colour, and the sky light's brightness */
    sky: d.vec4f,
    sunMatrix: d.mat4x4f,
    /** 1 to shadow the point lights; what to show (`SHOW`); the time in seconds; the light faces' shade */
    options: d.vec4f,
    /** the screen's size in pixels */
    size: d.vec4f,
});
const frameConfig = {
    eye: [0, 0, 0, NEAR] as [number, number, number, number],
    right: [0, 0, 0, FAR] as [number, number, number, number],
    up: [0, 0, 0, 1] as [number, number, number, number],
    forward: [0, 0, 0, DEPTH_BINS / LIGHT_FAR] as [number, number, number, number],
    sun: [0, 1, 0, 1] as [number, number, number, number],
    sky: [0, 0, 0, 1] as [number, number, number, number],
    sunMatrix: mat4.create(),
    options: [1, 0, 0, 0.4] as [number, number, number, number],
    size: [1, 1, 0, 0] as [number, number, number, number],
};
const frameUniform = new Uniform(FrameConfig, frameConfig);
const cfg = uniform(frameUniform);
const eye = cfg.field('eye');
const sunDir = cfg.field('sun').xyz;
const sunStrength = cfg.field('sun').w;
const skyColor = cfg.field('sky').xyz;
const skyBrightness = cfg.field('sky').w;
const elapsed = cfg.field('options').z;
const faceShadeAmount = cfg.field('options').w;

/** each shadowed light's cube: per face its view-projection (four vec4s, its columns), then its slot (x, y, size,
 *  drawn) in the atlas, 0 to 1 */
const SHADOW_FACE_VEC4S = 5;
const SHADOW_VEC4S = 6 * SHADOW_FACE_VEC4S;
/** the frame's lights and shadows in one buffer: the lights sorted nearest the camera first, each (position, radius)
 *  then (colour, shadow index + 1); then the shadows' cubes, from SHADOWS_BASE */
const SHADOWS_BASE = MAX_LIGHTS * 2;
const dynamicData = new Float32Array((SHADOWS_BASE + SHADOWED_LIGHTS * SHADOW_VEC4S) * 4);
const lightData = dynamicData.subarray(0, SHADOWS_BASE * 4);
const shadowData = dynamicData.subarray(SHADOWS_BASE * 4);
const dynamicBuffer = new GpuBuffer(d.array(d.vec4f), {
    label: 'lights',
    data: dynamicData,
    usage: 'storage',
    lifecycle: BufferLifecycle.MANUAL,
});
const MAX_TILES = Math.ceil(7680 / TILE) * Math.ceil(4320 / TILE);
/** the light tiles' words, then the depth bins from BINS_BASE */
const BINS_BASE = MAX_TILES * LIGHT_WORDS;
const tileBinData = new Uint32Array(BINS_BASE + DEPTH_BINS);
const tileData = tileBinData.subarray(0, BINS_BASE);
/** each depth bin's lights: the first and last of the sorted lights that reach it, first | last << 16 */
const binData = tileBinData.subarray(BINS_BASE);
const tileBinBuffer = new GpuBuffer(d.array(d.u32), {
    label: 'tiles-bins',
    data: tileBinData,
    usage: 'storage',
    lifecycle: BufferLifecycle.MANUAL,
});
const cellLightBuffer = new GpuBuffer(d.array(d.u32), { label: 'cell-light', data: cellLight, usage: 'storage' });

const lightNodes = storage(dynamicBuffer, 'read');
const shadowAt = (index: Node<d.u32>) => lightNodes.element(index.add(u32(SHADOWS_BASE)));
const tileNodes = storage(tileBinBuffer, 'read');
const cellLightNodes = storage(cellLightBuffer, 'read');

/** the light curve bongle applies to a level, 0 to 1 */
const brightnessCurve = (x: Node<d.f32>) => x.mul(f32(-0.5)).add(f32(1.5)).mul(x).mul(x);

/**
 * The voxel light at `pos` as (sky, r, g, b), as bongle's light tiles give it a model, a sprite or a block mesh: a
 * tetrahedral blend of four of the eight cells around it, a solid cell weighing nothing; open sky outside the world.
 */
const sampleWorldLight = Fn(
    (pos) => {
        const p = pos.sub(vec3(f32(0.5))).toVar('swlP');
        const b = floor(p).toVar('swlB');
        const w = p.sub(b).toVar('swlW');
        const maxX = w.x.greaterThanEqual(w.y).and(w.x.greaterThanEqual(w.z)).toVar('swlMaxX');
        const maxY = maxX.not().and(w.y.greaterThanEqual(w.z)).toVar('swlMaxY');
        const minZ = w.z.lessThanEqual(w.x).and(w.z.lessThanEqual(w.y)).toVar('swlMinZ');
        const minY = minZ.not().and(w.y.lessThanEqual(w.x)).toVar('swlMinY');
        const minX = minZ.not().and(minY.not()).toVar('swlMinX');
        const o1 = vec3(
            select(f32(0), f32(1), maxX),
            select(f32(0), f32(1), maxY),
            f32(1)
                .sub(select(f32(0), f32(1), maxX))
                .sub(select(f32(0), f32(1), maxY)),
        ).toVar('swlO1');
        const o2 = vec3(select(f32(1), f32(0), minX), select(f32(1), f32(0), minY), select(f32(1), f32(0), minZ)).toVar('swlO2');
        const wmax = max(w.x, max(w.y, w.z)).toVar('swlWmax');
        const wmin = min(w.x, min(w.y, w.z)).toVar('swlWmin');
        const wmid = w.x.add(w.y).add(w.z).sub(wmax).sub(wmin).toVar('swlWmid');
        const sum = Var('swlSum', vec4(f32(0)));
        const weight = Var('swlWeight', f32(0));
        const tap = (offset: Node<d.vec3f>, tapWeight: Node<d.f32>, name: string) => {
            const c = b.add(offset).toVar(`${name}C`);
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
            const cell = select(u32(15), cellLightNodes.element(index), inside).toVar(`${name}Cell`);
            If(cell.notEqual(u32(SOLID_CELL)), () => {
                const levels = vec4(
                    cell.bitwiseAnd(u32(15)).toF32(),
                    cell.shiftRight(u32(4)).bitwiseAnd(u32(15)).toF32(),
                    cell.shiftRight(u32(8)).bitwiseAnd(u32(15)).toF32(),
                    cell.shiftRight(u32(12)).bitwiseAnd(u32(15)).toF32(),
                );
                sum.assign(sum.add(levels.mul(tapWeight)));
                weight.assign(weight.add(tapWeight));
            });
        };
        tap(vec3(f32(0)), f32(1).sub(wmax), 'swl0');
        tap(o1, wmax.sub(wmid), 'swl1');
        tap(o2, wmid.sub(wmin), 'swl2');
        tap(vec3(f32(1)), wmin, 'swl3');
        const levels = select(vec4(f32(0)), sum.div(max(weight, f32(1e-4))).div(f32(15)), weight.greaterThan(f32(0)));
        return vec4(brightnessCurve(levels.x), brightnessCurve(levels.y), brightnessCurve(levels.z), brightnessCurve(levels.w));
    },
    { name: 'sampleWorldLight', params: [{ name: 'pos', type: d.vec3f }], return: d.vec4f },
);

// ─── Atlas sampling, as bongle's voxel albedo ───────────────────────────────

const ANISO_TAPS = 4;
const round2 = (x: Node<d.vec2f>) => floor(x.add(vec2(f32(0.5))));

/**
 * The atlas at frame A's `uvA` and frame B's `uvB`, blended by `mixFactor`, the footprint given by `du` and `dv`
 * (frame A's uv a pixel right and down): a texel-snapped nearest tap up close, ANISO_TAPS taps along the footprint's
 * long axis at its short axis's level far off, a blend across the band between.
 */
const sampleAtlasColor = Fn(
    (uvA, uvB, rectA, rectB, mixFactor, du, dv) => {
        const pixelSize = vec2(f32(TEXEL));
        const texelScreen = Var('vmTexelScreen', max(sqrt(du.mul(du).add(dv.mul(dv))), vec2(f32(1e-8))));
        const sampleNearest = (uv: Node<d.vec2f>, name: string): Node<d.vec4f> => {
            const uvTexel = uv.div(pixelSize).toVar(`${name}Texel`);
            const texelCenter = round2(uvTexel)
                .sub(vec2(f32(0.5)))
                .toVar(`${name}Center`);
            const rawOffset = uvTexel.sub(texelCenter);
            const snapped = clamp(
                rawOffset
                    .sub(vec2(f32(0.5)))
                    .mul(pixelSize)
                    .div(texelScreen)
                    .add(vec2(f32(0.5))),
                vec2(f32(0)),
                vec2(f32(1)),
            ).toVar(`${name}Offset`);
            const snappedUv = texelCenter.add(snapped).mul(pixelSize).toVar(`${name}Uv`);
            return atlasNode.sample(snappedUv).grad(du, dv).toVar(`${name}Nearest`);
        };
        const duLen = Var('vmDuLen', max(length(du), f32(1e-8)));
        const dvLen = Var('vmDvLen', max(length(dv), f32(1e-8)));
        const minorLen = Var('vmMinorLen', min(duLen, dvLen));
        const majorLen = Var('vmMajorLen', max(duLen, dvLen));
        const majorAxis = Var('vmMajorAxis', select(dv, du, duLen.greaterThanEqual(dvLen)));
        const lodMinor = log2(minorLen.div(f32(TEXEL)));
        const lodCover = log2(majorLen.div(f32(TEXEL * ANISO_TAPS)));
        const lod = Var('vmLod', clamp(max(lodMinor, lodCover), f32(0), f32(ATLAS_MIP_LEVELS)));
        const texelAtLod = Var('vmTexelAtLod', pixelSize.mul(exp2(lod)));
        const sampleAniso = (uv: Node<d.vec2f>, rect: Node<d.vec4f>, name: string): Node<d.vec4f> => {
            const half = texelAtLod.mul(f32(0.5));
            const centre = rect.xy.add(rect.zw.mul(f32(0.5))).toVar(`${name}Centre`);
            const lo = min(rect.xy.add(half), centre).toVar(`${name}Lo`);
            const hi = max(rect.xy.add(rect.zw).sub(half), centre).toVar(`${name}Hi`);
            let sum: Node<d.vec4f> | null = null;
            for (let i = 0; i < ANISO_TAPS; i++) {
                const offset = (i + 0.5) / ANISO_TAPS - 0.5;
                const tapUv = clamp(uv.add(majorAxis.mul(f32(offset))), lo, hi).toVar(`${name}TapUv${i}`);
                const tap = atlasNode.sample(tapUv).level(lod).toVar(`${name}Tap${i}`);
                sum = sum ? sum.add(tap) : tap;
            }
            return sum!.mul(f32(1 / ANISO_TAPS)).toVar(`${name}Aniso`);
        };
        const maxTexelSize = max(texelScreen.x, texelScreen.y);
        const anisoBlend = Var('vmAnisoBlend', smoothstep(f32(TEXEL), f32(TEXEL * 2), maxTexelSize));
        const sampleAtlas = (uv: Node<d.vec2f>, rect: Node<d.vec4f>, name: string): Node<d.vec4f> => {
            const color = Var(name, vec4(f32(0)));
            If(anisoBlend.lessThan(f32(1)), () => {
                color.assign(sampleNearest(uv, name));
            });
            If(anisoBlend.greaterThan(f32(0)), () => {
                color.assign(mix(color, sampleAniso(uv, rect, name), anisoBlend));
            });
            return color;
        };
        const texColor = Var('texColor', sampleAtlas(uvA, rectA, 'colorA'));
        If(mixFactor.greaterThan(f32(0)), () => {
            texColor.assign(mix(texColor, sampleAtlas(uvB, rectB, 'colorB'), mixFactor));
        });
        return texColor;
    },
    {
        name: 'sampleVoxelAtlas',
        params: [
            { name: 'uvA', type: d.vec2f },
            { name: 'uvB', type: d.vec2f },
            { name: 'rectA', type: d.vec4f },
            { name: 'rectB', type: d.vec4f },
            { name: 'mixFactor', type: d.f32 },
            { name: 'du', type: d.vec2f },
            { name: 'dv', type: d.vec2f },
        ],
        return: d.vec4f,
    },
);

/** texture `texIndex`'s frames now: frame A's rect, frame B's, and the blend between them */
function textureFrames(texIndex: Node<d.u32>, prefix: string) {
    const anim = sceneAt(SCENE_ENTRIES, texIndex.mul(u32(2)).add(u32(1))).toVar(`${prefix}Anim`);
    const t = elapsed.mul(anim.y).toVar(`${prefix}T`);
    const frameA = floor(t).mod(anim.x).toVar(`${prefix}FrameA`);
    const frameB = frameA.add(f32(1)).mod(anim.x);
    const rectA = sceneAt(SCENE_ENTRIES, texIndex.add(frameA.toU32()).mul(u32(2))).toVar(`${prefix}RectA`);
    const rectB = sceneAt(SCENE_ENTRIES, texIndex.add(frameB.toU32()).mul(u32(2))).toVar(`${prefix}RectB`);
    return { rectA, rectB, mixFactor: anim.z.mul(fract(t)) };
}

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
const shadowSampler = comparisonSampler(
    new GpuSampler({ minFilter: 'linear', magFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' }),
    'less',
);
const SUN_HALF_TEXEL = 0.5 / SUN_MAP;

/** the sun's shadow at `pos` facing `normal`, 1 lit: four filtered compares, pushed off along the normal by the warp's
 *  texel there */
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
                shadowSampler,
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

// ─── Point lights: by tile and depth bin, the nearest shadowed by cube maps ─

const shadowAtlas = createRenderTarget(SHADOW_ATLAS, SHADOW_ATLAS, {
    depthFormat: 'depth24plus',
    count: 0,
    depthSampled: true,
    label: 'shadows',
});
const shadowAtlasDepth = depthTexture(shadowAtlas.depthTexture!).bindingNode;
const SHADOW_TEXEL = 1 / SHADOW_ATLAS;

/** shadow `shadow`'s light at `lightPos` on `pos` facing `normal`, 1 lit: the face the surface lies toward from the
 *  light now, with the matrix that face was drawn with, a 3 x 3 filter from four filtered compares */
const cubeShadow = Fn(
    (shadow, lightPos, pos, normal) => {
        const lit = Var('csLit', f32(1));
        const toSurface = pos.sub(lightPos).toVar('csToSurface');
        const a = abs(toSurface).toVar('csAbs');
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
        const slot = shadowAt(base.add(u32(4))).toVar('csSlot');
        If(slot.w.greaterThan(f32(0.5)), () => {
            const texel = length(toSurface).mul(f32(2 / SHADOW_SLOT));
            const at = vec4(pos.add(normal.mul(texel.mul(f32(1.5)))), f32(1));
            const c0 = shadowAt(base).toVar('csC0');
            const c1 = shadowAt(base.add(u32(1))).toVar('csC1');
            const c2 = shadowAt(base.add(u32(2))).toVar('csC2');
            const c3 = shadowAt(base.add(u32(3))).toVar('csC3');
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
                    shadowSampler,
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

/** the point lights at `pos` facing `normal` (both sides, `twoSided`), on pixel (`pixelX`, `pixelY`) at
 *  `viewDepth`: those its tile's bits and its depth bin's range both hold, each shadowed if it casts and the surface
 *  `receives`; in w, how many it walked */
const pointLights = Fn(
    (pos, normal, viewDepth, pixelX, pixelY, receives, twoSided) => {
        const light = Var('plLight', vec3(f32(0)));
        const walked = Var('plWalked', f32(0));
        const bin = min(viewDepth.mul(cfg.field('forward').w), f32(DEPTH_BINS - 1)).toU32();
        const range = tileNodes.element(bin.add(u32(BINS_BASE))).toVar('plRange');
        const first = range.bitwiseAnd(u32(0xffff)).toVar('plFirst');
        const last = range.shiftRight(u32(16)).toVar('plLast');
        If(first.lessThanEqual(last), () => {
            const tileX = clamp(pixelX, f32(0), cfg.field('size').x.sub(f32(1)))
                .toU32()
                .div(u32(TILE));
            const tileY = clamp(pixelY, f32(0), cfg.field('size').y.sub(f32(1)))
                .toU32()
                .div(u32(TILE));
            const tile = tileX.add(tileY.mul(cfg.field('up').w.toU32())).toVar('plTile');
            Loop(
                { start: first.shiftRight(u32(5)), end: last.shiftRight(u32(5)).add(u32(1)), type: d.u32, name: 'word' },
                ({ word }) => {
                    const w = word.toU32();
                    const mask = Var('plMask', tileNodes.element(tile.mul(u32(LIGHT_WORDS)).add(w)));
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
                        const rawFacing = dot(normal, toLight.div(distance));
                        const facing = select(rawFacing, abs(rawFacing), twoSided.greaterThan(f32(0.5))).toVar('plFacing');
                        If(distance.lessThan(positionRadius.w).and(facing.greaterThan(f32(0))), () => {
                            const ratio = distance.div(positionRadius.w);
                            const falloff = f32(1).sub(ratio.mul(ratio));
                            const colorShadow = lightNodes.element(index.mul(u32(2)).add(u32(1))).toVar('plColorShadow');
                            const shadow = Var('plShadow', f32(1));
                            const shadowIndex = colorShadow.w.toU32();
                            If(
                                shadowIndex
                                    .greaterThan(u32(0))
                                    .and(receives.greaterThan(f32(0.5)))
                                    .and(cfg.field('options').x.greaterThan(f32(0.5))),
                                () => {
                                    shadow.assign(cubeShadow(shadowIndex.sub(u32(1)), positionRadius.xyz, pos, normal));
                                },
                            );
                            light.assign(light.add(colorShadow.xyz.mul(falloff.mul(falloff).mul(facing).mul(shadow))));
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
            { name: 'receives', type: d.f32 },
            { name: 'twoSided', type: d.f32 },
        ],
        return: d.vec4f,
    },
);

// ─── Lighting, as bongle's ──────────────────────────────────────────────────

const SUN_LIGHT = vec3(f32(1.0), f32(0.95), f32(0.85));
const AMBIENT_MINIMUM = vec3(f32(0.02));
const OUTDOORS_FROM = 0.4;
const OUTDOORS_TO = 0.8;

/** what to show in place of the lit colour, the surface's inputs as each path rebuilds them */
const SHOW = ['lit', 'albedo', 'normal', 'light', 'depth', 'tile lights'] as const;

/**
 * A surface's colour as bongle lights it: its voxel `light` (sky and block light by occlusion and face shade) under
 * the sun's facing shade, the sun's own light by how outdoors it is (`skyLevel`) and its shadow, the point lights, no
 * less than the ambient minimum; floored by `glow`, bypassed by `unlit`; then fog.
 */
const litSurface = Fn(
    (albedo, normal, pos, light, skyLevel, viewDepth, pixelX, pixelY, receives, glow, unlit) => {
        const facing = max(dot(normal, sunDir), f32(0)).toVar('lsFacing');
        const shaded = light.mul(mix(f32(1).sub(faceShadeAmount), f32(1), facing)).toVar('lsShaded');
        const outdoors = smoothstep(f32(OUTDOORS_FROM), f32(OUTDOORS_TO), clamp(skyLevel, f32(0), f32(1)));
        const sunlight = Var('lsSun', vec3(f32(0)));
        // faces turned from the sun, or indoors, skip the shadow's taps
        If(
            facing
                .greaterThan(f32(0))
                .and(outdoors.greaterThan(f32(0)))
                .and(sunStrength.greaterThan(f32(0))),
            () => {
                const shadow = select(
                    f32(1),
                    sunShadow(pos, normal),
                    viewDepth.lessThan(f32(SUN_REACH)).and(receives.greaterThan(f32(0.5))),
                );
                sunlight.assign(SUN_LIGHT.mul(facing.mul(shadow).mul(outdoors).mul(sunStrength)));
            },
        );
        const points = pointLights(pos, normal, viewDepth, pixelX, pixelY, receives, f32(0)).toVar('lsPoints');
        const world = max(shaded.add(sunlight).add(points.xyz), AMBIENT_MINIMUM);
        const lit = mix(albedo.mul(max(world, vec3(glow))), albedo, unlit);
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
            light,
            vec3(f32(1).sub(min(viewDepth.div(f32(FOG_END)), f32(1)))),
            heat,
        ];
        const show = cfg.field('options').y;
        let out: Node<d.vec3f> = shown[shown.length - 1]!;
        for (let k = shown.length - 2; k >= 0; k--) out = select(out, shown[k]!, show.lessThan(f32(k + 0.5)));
        return out;
    },
    {
        name: 'litSurface',
        params: [
            { name: 'albedo', type: d.vec3f },
            { name: 'normal', type: d.vec3f },
            { name: 'pos', type: d.vec3f },
            { name: 'light', type: d.vec3f },
            { name: 'skyLevel', type: d.f32 },
            { name: 'viewDepth', type: d.f32 },
            { name: 'pixelX', type: d.f32 },
            { name: 'pixelY', type: d.f32 },
            { name: 'receives', type: d.f32 },
            { name: 'glow', type: d.f32 },
            { name: 'unlit', type: d.f32 },
        ],
        return: d.vec3f,
    },
);

/** a voxel light sample's light, bongle's way for a kind: the block light, or the sky's share at its brightness, no
 *  less than `litMin` */
const kindLight = (sample: Node<d.vec4f>, litMin: Node<d.f32>) =>
    max(max(sample.yzw, vec3(sample.x.mul(skyBrightness))), vec3(litMin));

/** an albedo recoloured by `tint` (rgb the target, a how much, its luminance kept) and overlaid by `flash` */
function tintAlbedo(albedo: Node<d.vec3f>, tint: Node<d.vec4f>, flash: Node<d.vec4f>): Node<d.vec3f> {
    const weights = vec3(f32(0.2126), f32(0.7152), f32(0.0722));
    const raw = albedo.mul(tint.xyz);
    const preserved = raw.mul(dot(albedo, weights).div(max(dot(raw, weights), f32(1e-4))));
    return mix(mix(albedo, preserved, tint.w), flash.xyz, flash.w);
}

// ─── Terrain's vertex: a quad corner decoded, as bongle's ───────────────────

const quadNodes = storage(quadWordBuffer, 'read');
const quadVec4Nodes = storage(quadVec4Buffer, 'read');
const slotNodes = storage(quadSlotBuffer, 'read');

/** a normal from its oct16 */
const decodeOct16 = Fn(
    (packed) => {
        const u = packed.bitwiseAnd(u32(0xff)).toF32().div(f32(255)).mul(f32(2)).sub(f32(1)).toVar('octU');
        const v = packed.shiftRight(u32(8)).bitwiseAnd(u32(0xff)).toF32().div(f32(255)).mul(f32(2)).sub(f32(1)).toVar('octV');
        const nx = Var('octNx', u);
        const ny = Var('octNy', v);
        const nz = Var('octNz', f32(1).sub(abs(u)).sub(abs(v)));
        If(nz.lessThan(f32(0)), () => {
            const tx = f32(1)
                .sub(abs(ny))
                .mul(select(f32(-1), f32(1), u.greaterThanEqual(f32(0))))
                .toVar('octTx');
            const ty = f32(1)
                .sub(abs(nx))
                .mul(select(f32(-1), f32(1), v.greaterThanEqual(f32(0))))
                .toVar('octTy');
            nx.assign(tx);
            ny.assign(ty);
        });
        return normalize(vec3(nx, ny, nz));
    },
    { name: 'decodeOct16', params: [{ name: 'packed', type: d.u32 }], return: d.vec3f },
);

/** a face's shade by its normal: sides 0.6 and 0.8, the top 1, the bottom 0.5 */
const faceShadeOf = (n: Node<d.vec3f>) =>
    select(
        select(select(f32(0.8), f32(0.6), abs(n.x).greaterThan(f32(0.5))), f32(1), n.y.greaterThan(f32(0.5))),
        f32(0.5),
        n.y.lessThan(f32(-0.5)),
    );

/** a corner's light from its 24 bits as (sky, r, g, b), each a sum of four cells' levels, 0 to 60, curved */
const cornerChannels = (bits: Node<d.u32>) => {
    const channel = (shift: number) => brightnessCurve(bits.shiftRight(u32(shift)).bitwiseAnd(u32(63)).toF32().div(f32(60)));
    return vec4(channel(18), channel(12), channel(6), channel(0));
};

/** a corner's light as a surface takes it: sky and block light added, then occlusion and face shade */
const cornerLight = (channels: Node<d.vec4f>, ao: Node<d.f32>, shade: Node<d.f32>) =>
    min(channels.yzw.add(vec3(channels.x.mul(skyBrightness))), vec3(f32(1))).mul(ao.mul(shade));

/** one vertex of a pass's quads: the quad its arena position (the draw's first quad plus vertexIndex / 4), the
 *  corner the vertex index's low bits turned by the diagonal flip */
function terrainVertex(passBase: number, prefix: string) {
    const position = u32(passBase)
        .add(instanceIndex)
        .add(vertexIndex.shiftRight(u32(2)))
        .toVar(`${prefix}Position`);
    const base = position.mul(u32(QUAD_U32S)).toVar(`${prefix}Base`);
    const origin = sceneAt(SCENE_SECTIONS, slotNodes.element(position)).xyz.toVar(`${prefix}Origin`);
    const flags = quadNodes.element(base.add(u32(FLAGS_WORD))).toVar(`${prefix}Flags`);
    const meta = quadNodes.element(base.add(u32(META_WORD))).toVar(`${prefix}Meta`);
    const corner = vertexIndex
        .bitwiseAnd(u32(3))
        .add(meta.shiftRight(u32(DIAG_FLIP_BIT)).bitwiseAnd(u32(1)))
        .bitwiseAnd(u32(3))
        .toVar(`${prefix}Corner`);
    // a corner's x, y and z are halves 3c to 3c + 2, in the two words from half 3c's
    const firstHalf = corner.mul(u32(3)).toVar(`${prefix}FirstHalf`);
    const firstWord = base.add(firstHalf.shiftRight(u32(1))).toVar(`${prefix}FirstWord`);
    const low = quadNodes.element(firstWord).toVar(`${prefix}Low`);
    const high = quadNodes.element(firstWord.add(u32(1))).toVar(`${prefix}High`);
    const odd = firstHalf.bitwiseAnd(u32(1)).equal(u32(1));
    const halves = vec3(
        select(low.bitwiseAnd(u32(0xffff)), low.shiftRight(u32(16)), odd).toF32(),
        select(low.shiftRight(u32(16)), high.bitwiseAnd(u32(0xffff)), odd).toF32(),
        select(high.bitwiseAnd(u32(0xffff)), high.shiftRight(u32(16)), odd).toF32(),
    );
    const worldPos = origin
        .add(halves.mul(f32(1 / POS_ENCODE_SCALE)).sub(vec3(f32(POS_ENCODE_ORIGIN))))
        .toVar(`${prefix}WorldPos`);
    const uvPacked = quadNodes.element(base.add(u32(7)).add(corner));
    const uv = vec2(uvPacked.bitwiseAnd(u32(0xffff)).toF32(), uvPacked.shiftRight(u32(16)).toF32())
        .div(f32(65535))
        .toVar(`${prefix}Uv`);
    const normal = decodeOct16(quadNodes.element(base.add(u32(6))).bitwiseAnd(u32(0xffff))).toVar(`${prefix}Normal`);
    const ao = meta
        .shiftRight(corner.mul(u32(4)))
        .bitwiseAnd(u32(15))
        .toF32()
        .div(f32(30))
        .add(f32(0.5))
        .toVar(`${prefix}Ao`);
    const unshaded = flags.shiftRight(u32(24)).bitwiseAnd(u32(1));
    const shade = select(faceShadeOf(normal), f32(1), unshaded.equal(u32(1))).toVar(`${prefix}Shade`);
    // 24 bits a corner from the low bits of the light words, running into the next word unless it starts low
    const bit = corner.mul(u32(24)).toVar(`${prefix}LightBit`);
    const word = bit.shiftRight(u32(5));
    const shift = bit.bitwiseAnd(u32(31)).toVar(`${prefix}LightShift`);
    const lowLight = quadNodes.element(base.add(u32(LIGHT_WORD)).add(word));
    const highLight = quadNodes.element(base.add(u32(LIGHT_WORD)).add(min(word.add(u32(1)), u32(2))));
    const bits = lowLight
        .shiftRight(shift)
        .bitwiseOr(select(u32(0), highLight.shiftLeft(u32(32).sub(shift)), shift.greaterThan(u32(8))))
        .bitwiseAnd(u32(0xffffff));
    const channels = cornerChannels(bits).toVar(`${prefix}Channels`);
    const viewPos = mul(cameraViewMatrix, vec4(worldPos, f32(1)));
    return {
        position,
        clip: mul(cameraProjectionMatrix, viewPos),
        worldPos,
        viewDepth: viewPos.z.negate(),
        uv,
        normal,
        light: cornerLight(channels, ao, shade),
        skyLevel: channels.x,
        texIndex: flags.bitwiseAnd(u32(0xffff)),
        emissive: flags.shiftRight(u32(23)).bitwiseAnd(u32(1)).toF32(),
    };
}

/** a cutout's texel under half covered is a hole */
const ALPHA_CUT = 0.5;

/** the frame's rect a texture's uv lands in, and its alpha there: one texel load, as bongle's cutout */
const cutoutAlpha = (rect: Node<d.vec4f>, uv: Node<d.vec2f>) =>
    atlasNode.load(vec2i(floor(rect.xy.add(uv.mul(rect.zw)).div(f32(TEXEL))).toI32())).w;

/** a fragment that drops `alpha` under the cut and is nothing else: a depth pass's */
function cutFragment(alpha: Node<d.f32>, name: string): Node<d.Void> {
    return Fn(
        (a) => {
            If(a.lessThan(f32(ALPHA_CUT)), () => {
                Discard();
            });
        },
        { name, params: [{ name: 'alpha', type: d.f32 }] },
    )(alpha);
}

/** a visibility pixel's 32 bits as four bytes */
const encodeId = (id: Node<d.u32>) =>
    vec4(
        id.bitwiseAnd(u32(255)).toF32(),
        id.shiftRight(u32(8)).bitwiseAnd(u32(255)).toF32(),
        id.shiftRight(u32(16)).bitwiseAnd(u32(255)).toF32(),
        id.shiftRight(u32(24)).toF32(),
    ).div(f32(255));

/** what each kind is drawn with, by pass */
type Materials = {
    forward: Material;
    /** a cutout's depth before its colour, which then tests equal; none for an opaque kind */
    prepass: Material | null;
    gbuffer: Material;
    visibility: Material;
    sun: Material;
    light: Material;
};

/** deferred's three texels from a surface: albedo and glow (`albedoGlow`, which a cutout's hole discards); normal, how
 *  outdoors and flags; light */
function gbufferOutput(
    albedoGlow: Node<d.vec4f>,
    normal: Node<d.vec3f>,
    skyLevel: Node<d.f32>,
    flags: number | Node<d.f32>,
    light: Node<d.vec3f>,
) {
    const n = normalize(normal);
    const p = n.xy.div(abs(n.x).add(abs(n.y)).add(abs(n.z)));
    const signs = select(vec2(f32(-1)), vec2(f32(1)), p.greaterThanEqual(vec2(f32(0))));
    const oct = select(
        p,
        vec2(f32(1))
            .sub(abs(vec2(p.y, p.x)))
            .mul(signs),
        n.z.lessThan(f32(0)),
    )
        .mul(f32(0.5))
        .add(f32(0.5));
    return mrt({
        output: albedoGlow,
        output1: vec4(oct, skyLevel, (typeof flags === 'number' ? f32(flags) : flags).div(f32(255))),
        output2: vec4(light, f32(1)),
    });
}
const FLAG_UNLIT = 1;
const FLAG_RECEIVES = 2;
const FLAG_PRELIT = 4;

/** an emissive texel's glow by its strongest channel */
const emissiveGlow = (albedo: Node<d.vec3f>, emissive: Node<d.f32>) =>
    smoothstep(f32(0.15), f32(0.45), max(albedo.x, max(albedo.y, albedo.z))).mul(emissive);

function terrainMaterials(passBase: number, cut: boolean, kind: number, name: string): Materials {
    const cullMode: GPUCullMode = cut ? 'none' : 'back';
    const make = (prefix: string) => {
        const v = terrainVertex(passBase, prefix);
        const frames = textureFrames(v.texIndex, `${prefix}Tex`);
        return {
            v,
            vUv: varying(v.uv, `${prefix}VUv`),
            vLight: varying(v.light, `${prefix}VLight`),
            vSky: varying(v.skyLevel, `${prefix}VSky`),
            vPos: varying(v.worldPos, `${prefix}VPos`),
            vDepth: varying(v.viewDepth, `${prefix}VDepth`),
            vNormal: varying(v.normal, `${prefix}VNormal`).setInterpolation('flat'),
            vRectA: varying(frames.rectA, `${prefix}VRectA`).setInterpolation('flat'),
            vRectB: varying(frames.rectB, `${prefix}VRectB`).setInterpolation('flat'),
            vMix: varying(frames.mixFactor, `${prefix}VMix`).setInterpolation('flat'),
            vEmissive: varying(v.emissive, `${prefix}VEmissive`).setInterpolation('flat'),
            vId: varying(u32(kind << 30).bitwiseOr(v.position), `${prefix}VId`).setInterpolation('flat'),
        };
    };
    /** the atlas at the fragment's uv, both frames, its footprint from the uv's derivatives */
    const albedoOf = (s: ReturnType<typeof make>, fnName: string) =>
        Fn(
            (uv, rectA, rectB, mixFactor) => {
                const uvA = rectA.xy.add(uv.mul(rectA.zw)).toVar('taUvA');
                const uvB = rectB.xy.add(uv.mul(rectB.zw)).toVar('taUvB');
                // the derivatives before any branch: they need uniform control flow
                const du = dpdx(uvA).toVar('taDu');
                const dv = dpdy(uvA).toVar('taDv');
                return sampleAtlasColor(uvA, uvB, rectA, rectB, mixFactor, du, dv);
            },
            {
                name: fnName,
                params: [
                    { name: 'uv', type: d.vec2f },
                    { name: 'rectA', type: d.vec4f },
                    { name: 'rectB', type: d.vec4f },
                    { name: 'mixFactor', type: d.f32 },
                ],
                return: d.vec4f,
            },
        )(s.vUv, s.vRectA, s.vRectB, s.vMix);
    const shaded = (s: ReturnType<typeof make>, fnName: string) => {
        const albedo = albedoOf(s, `${fnName}Albedo`).xyz.toVar(`${fnName}AlbedoRgb`);
        return vec4(
            litSurface(
                albedo,
                s.vNormal,
                s.vPos,
                s.vLight,
                s.vSky,
                s.vDepth,
                screenCoordinate.x,
                screenCoordinate.y,
                f32(1),
                emissiveGlow(albedo, s.vEmissive),
                f32(0),
            ),
            f32(1),
        );
    };
    const forward = make(`${name}Fw`);
    const prepass = make(`${name}Pre`);
    const gb = make(`${name}Gb`);
    const vis = make(`${name}Vis`);
    const sun = make(`${name}Sun`);
    const light = make(`${name}Light`);
    const cutOf = (s: ReturnType<typeof make>, fnName: string) =>
        cut ? cutFragment(cutoutAlpha(s.vRectA, s.vUv), fnName) : undefined;
    const discardIfCut = (s: ReturnType<typeof make>, value: Node<d.Any>, fnName: string) =>
        cut
            ? Fn(
                  (alpha, out) => {
                      If(alpha.lessThan(f32(ALPHA_CUT)), () => {
                          Discard();
                      });
                      return out;
                  },
                  {
                      name: fnName,
                      params: [
                          { name: 'alpha', type: d.f32 },
                          { name: 'out', type: d.vec4f },
                      ],
                      return: d.vec4f,
                  },
              )(cutoutAlpha(s.vRectA, s.vUv), value as Node<d.vec4f>)
            : value;
    const gbAlbedo = albedoOf(gb, `${name}GbAlbedo`).xyz.toVar(`${name}GbAlbedoRgb`);
    return {
        // a cutout's colour tests equal to its prepass's depth, its holes already out of it
        forward: createMaterial({
            name: `${name}-forward`,
            vertex: cut ? invariant(forward.v.clip) : forward.v.clip,
            fragment: shaded(forward, `${name}Fw`),
            cullMode,
            ...(cut ? { depthCompare: 'equal' as const, depthWrite: false } : {}),
        }),
        prepass: cut
            ? createMaterial({
                  name: `${name}-prepass`,
                  vertex: invariant(prepass.v.clip),
                  fragment: cutOf(prepass, `${name}PreCut`),
                  colorWrite: false,
                  cullMode,
              })
            : null,
        gbuffer: createMaterial({
            name: `${name}-gbuffer`,
            vertex: gb.v.clip,
            fragment: gbufferOutput(
                discardIfCut(gb, vec4(gbAlbedo, emissiveGlow(gbAlbedo, gb.vEmissive)), `${name}GbCut`) as Node<d.vec4f>,
                gb.vNormal,
                gb.vSky,
                FLAG_RECEIVES,
                gb.vLight,
            ),
            cullMode,
        }),
        visibility: createMaterial({
            name: `${name}-visibility`,
            vertex: vis.v.clip,
            fragment: discardIfCut(vis, encodeId(vis.vId), `${name}VisCut`),
            cullMode,
        }),
        sun: createMaterial({
            name: `${name}-sun`,
            vertex: warpClip(sun.v.clip),
            fragment: cutOf(sun, `${name}SunCut`),
            depthBias: 2,
            depthBiasSlopeScale: 2,
            cullMode: 'none',
        }),
        light: createMaterial({
            name: `${name}-light`,
            vertex: light.v.clip,
            fragment: cutOf(light, `${name}LightCut`),
            depthBias: 2,
            depthBiasSlopeScale: 2,
            cullMode: 'none',
        }),
    };
}

// ─── Models: a vertex from the pool, a row through the slot map ─────────────

const modelSlotNodes = storage(modelSlotBuffer, 'read');

/** a model row's parts, `rowBase` its first vec4 */
function modelRow(rowBase: Node<d.u32>, prefix: string) {
    const at = (k: number) => sceneAt(SCENE_MODEL_ROWS, rowBase.add(u32(k))).toVar(`${prefix}Row${k}`);
    const look = at(6);
    const uvRect = at(7);
    return {
        columns: [at(0), at(1), at(2), at(3)],
        tint: at(4),
        flash: at(5),
        glow: look.x,
        unlit: look.y,
        litMin: look.z,
        uvRect,
        receives: at(8).x,
    };
}

function modelMaterials(name: string): Materials {
    const make = (prefix: string) => {
        const row = modelSlotNodes.element(instanceIndex).toVar(`${prefix}RowIndex`);
        const r = modelRow(row.mul(u32(MODEL_ROW_VEC4S)), prefix);
        const vertex = vertexIndex.toVar(`${prefix}Vertex`);
        const posU = sceneAt(SCENE_POOL, vertex.mul(u32(2))).toVar(`${prefix}PosU`);
        const normalV = sceneAt(SCENE_POOL, vertex.mul(u32(2)).add(u32(1))).toVar(`${prefix}NormalV`);
        const [c0, c1, c2, c3] = r.columns;
        const world = c0.mul(posU.x).add(c1.mul(posU.y)).add(c2.mul(posU.z)).add(c3).xyz.toVar(`${prefix}World`);
        const normal = normalize(c0.xyz.mul(normalV.x).add(c1.xyz.mul(normalV.y)).add(c2.xyz.mul(normalV.z)));
        const viewPos = mul(cameraViewMatrix, vec4(world, f32(1)));
        const sample = sampleWorldLight(world).toVar(`${prefix}Sample`);
        return {
            clip: mul(cameraProjectionMatrix, viewPos),
            vUv: varying(r.uvRect.xy.add(vec2(posU.w, normalV.w).mul(r.uvRect.zw)), `${prefix}VUv`),
            vNormal: varying(normal, `${prefix}VNormal`),
            vPos: varying(world, `${prefix}VPos`),
            vDepth: varying(viewPos.z.negate(), `${prefix}VDepth`),
            // sampled per vertex at its own position, as bongle's models
            vLight: varying(kindLight(sample, r.litMin), `${prefix}VLight`),
            vSky: varying(sample.x, `${prefix}VSky`),
            vTint: varying(r.tint, `${prefix}VTint`).setInterpolation('flat'),
            vFlash: varying(r.flash, `${prefix}VFlash`).setInterpolation('flat'),
            vLook: varying(vec4(r.glow, r.unlit, r.receives, f32(0)), `${prefix}VLook`).setInterpolation('flat'),
            vId: varying(
                u32(KIND_MODEL << 30)
                    .bitwiseOr(row.shiftLeft(u32(8)))
                    .bitwiseOr(vertex.div(u32(3))),
                `${prefix}VId`,
            ).setInterpolation('flat'),
        };
    };
    const fw = make(`${name}Fw`);
    const gb = make(`${name}Gb`);
    const vis = make(`${name}Vis`);
    const sun = make(`${name}Sun`);
    const light = make(`${name}Light`);
    const fwTex = atlasNode.sample(fw.vUv).toVar(`${name}FwTex`);
    const gbTex = atlasNode.sample(gb.vUv).toVar(`${name}GbTex`);
    return {
        forward: createMaterial({
            name: `${name}-forward`,
            vertex: fw.clip,
            fragment: vec4(
                litSurface(
                    tintAlbedo(fwTex.xyz, fw.vTint, fw.vFlash),
                    fw.vNormal,
                    fw.vPos,
                    fw.vLight,
                    fw.vSky,
                    fw.vDepth,
                    screenCoordinate.x,
                    screenCoordinate.y,
                    fw.vLook.z,
                    fw.vLook.x,
                    fw.vLook.y,
                ),
                f32(1),
            ),
        }),
        prepass: null,
        gbuffer: createMaterial({
            name: `${name}-gbuffer`,
            vertex: gb.clip,
            fragment: gbufferOutput(
                vec4(tintAlbedo(gbTex.xyz, gb.vTint, gb.vFlash), gb.vLook.x),
                gb.vNormal,
                gb.vSky,
                gb.vLook.y.mul(f32(FLAG_UNLIT)).add(gb.vLook.z.mul(f32(FLAG_RECEIVES))),
                gb.vLight,
            ),
        }),
        visibility: createMaterial({ name: `${name}-visibility`, vertex: vis.clip, fragment: encodeId(vis.vId) }),
        sun: createMaterial({
            name: `${name}-sun`,
            vertex: warpClip(sun.clip),
            fragment: undefined,
            depthBias: 2,
            depthBiasSlopeScale: 2,
        }),
        light: createMaterial({
            name: `${name}-light`,
            vertex: light.clip,
            fragment: undefined,
            depthBias: 2,
            depthBiasSlopeScale: 2,
        }),
    };
}

// ─── Sprites: a row through the slot map, lit per vertex ────────────────────

const spriteSlotNodes = storage(spriteSlotBuffer, 'read');
/** how much of the sun a sprite with no facing of its own takes, as bongle's omni sun */
const SPRITE_SUN_FACING = 0.75;
/** how far off its plane a sprite's sun shadow is looked up, toward the sun */
const SPRITE_SUN_PUSH = 3;

/** a sprite row's parts, `rowBase` its first vec4 */
function spriteRow(rowBase: Node<d.u32>, prefix: string) {
    const at = (k: number) => sceneAt(SCENE_SPRITE_ROWS, rowBase.add(u32(k))).toVar(`${prefix}Row${k}`);
    const positionWidth = at(0);
    const look = at(5);
    return {
        position: positionWidth.xyz,
        width: positionWidth.w,
        height: at(1).x,
        uvRect: at(2),
        tint: at(3),
        flash: at(4),
        glow: look.x,
        unlit: look.y,
        litMin: look.z,
        receives: at(6).x,
    };
}

/** a sprite's right and up, turned about the vertical to face the camera, and its normal toward it */
function spriteBasis(position: Node<d.vec3f>, prefix: string) {
    const toViewer = vec2(eye.x.sub(position.x), eye.z.sub(position.z));
    const along = toViewer.div(max(length(toViewer), f32(1e-6))).toVar(`${prefix}Along`);
    const normal = vec3(along.x, f32(0), along.y).toVar(`${prefix}Normal`);
    const right = normalize(cross(vec3(f32(0), f32(1), f32(0)), normal)).toVar(`${prefix}Right`);
    return { right, up: vec3(f32(0), f32(1), f32(0)), normal };
}

/**
 * A sprite's light as bongle works it out per vertex: its voxel light, the sun's by how outdoors it is from every
 * side alike and its shadow looked up off its plane toward the sun, the point lights on both its sides, no less than
 * the ambient minimum.
 */
const spriteLight = Fn(
    (position, normal, viewDepth, pixelX, pixelY, litMin, receives) => {
        const sample = sampleWorldLight(position).toVar('slSample');
        const voxel = kindLight(sample, litMin);
        const outdoors = smoothstep(f32(OUTDOORS_FROM), f32(OUTDOORS_TO), clamp(sample.x, f32(0), f32(1)));
        const side = select(f32(-1), f32(1), dot(normal, sunDir).greaterThanEqual(f32(0)));
        const sunlight = Var('slSun', vec3(f32(0)));
        If(outdoors.greaterThan(f32(0)).and(sunStrength.greaterThan(f32(0))), () => {
            const shadow = select(
                f32(1),
                sunShadow(position, normal.mul(side.mul(f32(SPRITE_SUN_PUSH)))),
                viewDepth.lessThan(f32(SUN_REACH)).and(receives.greaterThan(f32(0.5))),
            );
            sunlight.assign(SUN_LIGHT.mul(f32(SPRITE_SUN_FACING).mul(shadow).mul(outdoors).mul(sunStrength)));
        });
        const points = pointLights(position, normal, viewDepth, pixelX, pixelY, receives, f32(1)).xyz;
        return max(voxel.add(sunlight).add(points), AMBIENT_MINIMUM);
    },
    {
        name: 'spriteLight',
        params: [
            { name: 'position', type: d.vec3f },
            { name: 'normal', type: d.vec3f },
            { name: 'viewDepth', type: d.f32 },
            { name: 'pixelX', type: d.f32 },
            { name: 'pixelY', type: d.f32 },
            { name: 'litMin', type: d.f32 },
            { name: 'receives', type: d.f32 },
        ],
        return: d.vec3f,
    },
);

/** where a clip position lands in pixels, top left at 0 */
const clipToPixel = (clip: Node<d.vec4f>) => {
    const ndc = clip.xy.div(clip.w);
    return vec2(
        ndc.x.mul(f32(0.5)).add(f32(0.5)).mul(cfg.field('size').x),
        f32(0.5)
            .sub(ndc.y.mul(f32(0.5)))
            .mul(cfg.field('size').y),
    );
};

function spriteMaterials(name: string): Materials {
    const make = (prefix: string, lit: boolean) => {
        const row = spriteSlotNodes.element(instanceIndex).toVar(`${prefix}RowIndex`);
        const r = spriteRow(row.mul(u32(SPRITE_ROW_VEC4S)), prefix);
        const b = spriteBasis(r.position, prefix);
        const corner = vertexIndex.bitwiseAnd(u32(3));
        // corners 0 to 3: bottom left, bottom right, top right, top left
        const local = vec2(
            select(f32(-0.5), f32(0.5), corner.equal(u32(1)).or(corner.equal(u32(2)))),
            select(f32(0), f32(1), corner.greaterThanEqual(u32(2))),
        );
        const world = r.position
            .add(b.right.mul(local.x.mul(r.width)))
            .add(b.up.mul(local.y.mul(r.height)))
            .toVar(`${prefix}World`);
        const viewPos = mul(cameraViewMatrix, vec4(world, f32(1)));
        const clip = mul(cameraProjectionMatrix, viewPos).toVar(`${prefix}Clip`);
        const pixel = clipToPixel(clip);
        const light = lit
            ? spriteLight(world, b.normal, viewPos.z.negate(), pixel.x, pixel.y, r.litMin, r.receives)
            : vec3(f32(1));
        return {
            clip,
            vUv: varying(r.uvRect.xy.add(vec2(local.x.add(f32(0.5)), f32(1).sub(local.y)).mul(r.uvRect.zw)), `${prefix}VUv`),
            vLight: varying(light, `${prefix}VLight`),
            vDepth: varying(viewPos.z.negate(), `${prefix}VDepth`),
            vTint: varying(r.tint, `${prefix}VTint`).setInterpolation('flat'),
            vFlash: varying(r.flash, `${prefix}VFlash`).setInterpolation('flat'),
            vLook: varying(vec4(r.glow, r.unlit, r.receives, f32(0)), `${prefix}VLook`).setInterpolation('flat'),
            vId: varying(u32(KIND_SPRITE << 30).bitwiseOr(row), `${prefix}VId`).setInterpolation('flat'),
        };
    };
    const fw = make(`${name}Fw`, true);
    const gb = make(`${name}Gb`, true);
    const vis = make(`${name}Vis`, false);
    const sun = make(`${name}Sun`, false);
    const light = make(`${name}Light`, false);
    /** the sprite's colour under its per-vertex light, as bongle's: tinted, floored by glow, bypassed by unlit */
    const prelit = (s: ReturnType<typeof make>, tex: Node<d.vec4f>) => {
        const albedo = tintAlbedo(tex.xyz, s.vTint, s.vFlash);
        return mix(albedo.mul(max(s.vLight, vec3(s.vLook.x))), albedo, s.vLook.y);
    };
    const keep = (alpha: Node<d.f32>, value: Node<d.vec4f>, fnName: string) =>
        Fn(
            (a, out) => {
                If(a.lessThan(f32(ALPHA_CUT)), () => {
                    Discard();
                });
                return out;
            },
            {
                name: fnName,
                params: [
                    { name: 'alpha', type: d.f32 },
                    { name: 'out', type: d.vec4f },
                ],
                return: d.vec4f,
            },
        )(alpha, value);
    const fwTex = atlasNode.sample(fw.vUv).toVar(`${name}FwTex`);
    const gbTex = atlasNode.sample(gb.vUv).toVar(`${name}GbTex`);
    const visAlpha = atlasNode.sample(vis.vUv).w;
    return {
        forward: createMaterial({
            name: `${name}-forward`,
            vertex: fw.clip,
            fragment: keep(
                fwTex.w,
                vec4(mix(prelit(fw, fwTex), skyColor, smoothstep(f32(FOG_START), f32(FOG_END), fw.vDepth)), f32(1)),
                `${name}FwCut`,
            ),
            cullMode: 'none',
        }),
        prepass: null,
        // lit already, so the lighting pass passes it through, fogged
        gbuffer: createMaterial({
            name: `${name}-gbuffer`,
            vertex: gb.clip,
            fragment: gbufferOutput(
                keep(gbTex.w, vec4(prelit(gb, gbTex), f32(0)), `${name}GbCut`),
                vec3(f32(0), f32(1), f32(0)),
                f32(1),
                FLAG_PRELIT,
                vec3(f32(0)),
            ),
            cullMode: 'none',
        }),
        visibility: createMaterial({
            name: `${name}-visibility`,
            vertex: vis.clip,
            fragment: keep(visAlpha, encodeId(vis.vId), `${name}VisCut`),
            cullMode: 'none',
        }),
        sun: createMaterial({
            name: `${name}-sun`,
            vertex: warpClip(sun.clip),
            fragment: cutFragment(atlasNode.sample(sun.vUv).w, `${name}SunCut`),
            depthBias: 2,
            depthBiasSlopeScale: 2,
            cullMode: 'none',
        }),
        light: createMaterial({
            name: `${name}-light`,
            vertex: light.clip,
            fragment: cutFragment(atlasNode.sample(light.vUv).w, `${name}LightCut`),
            depthBias: 2,
            depthBiasSlopeScale: 2,
            cullMode: 'none',
        }),
    };
}

// ─── Fullscreen passes: deferred's lighting, the visibility buffer's resolve ─

/** a unit normal from two values in 0 to 1, octahedrally */
function octDecode(e: Node<d.vec2f>): Node<d.vec3f> {
    const f = e.mul(f32(2)).sub(f32(1));
    const n = vec3(f.x, f.y, f32(1).sub(abs(f.x)).sub(abs(f.y)));
    const t = clamp(n.z.negate(), f32(0), f32(1));
    const signs = select(vec2(f32(1)), vec2(f32(-1)), n.xy.greaterThanEqual(vec2(f32(0))));
    return normalize(vec3(n.xy.add(signs.mul(t)), n.z));
}

/** the camera's ray through pixel (`pixelX`, `pixelY`)'s centre, a unit of view depth along */
const rayAt = (pixelX: Node<d.f32>, pixelY: Node<d.f32>) => {
    const ndcX = pixelX.add(f32(0.5)).div(cfg.field('size').x).mul(f32(2)).sub(f32(1));
    const ndcY = f32(1).sub(pixelY.add(f32(0.5)).div(cfg.field('size').y).mul(f32(2)));
    return cfg.field('forward').xyz.add(cfg.field('right').xyz.mul(ndcX)).add(cfg.field('up').xyz.mul(ndcY));
};

/** view depth from WebGL's stored depth, (ndc z + 1) / 2 */
const viewDepthOf = (depth: Node<d.f32>) => {
    const near = eye.w;
    const far = cfg.field('right').w;
    return f32(2)
        .mul(near)
        .mul(far)
        .div(far.add(near).sub(depth.mul(f32(2)).sub(f32(1)).mul(far.sub(near))));
};

/** how far along `ray` from the eye it meets the plane through `point` facing `normal` */
const meetPlane = (ray: Node<d.vec3f>, point: Node<d.vec3f>, normal: Node<d.vec3f>) =>
    dot(point.sub(eye.xyz), normal).div(dot(ray, normal));

/** `p`'s barycentric weights in the triangle `a`, `b`, `c` */
function barycentric(p: Node<d.vec3f>, a: Node<d.vec3f>, b: Node<d.vec3f>, c: Node<d.vec3f>): Node<d.vec3f> {
    const v0 = b.sub(a);
    const v1 = c.sub(a);
    const v2 = p.sub(a);
    const d00 = dot(v0, v0);
    const d01 = dot(v0, v1);
    const d11 = dot(v1, v1);
    const d20 = dot(v2, v0);
    const d21 = dot(v2, v1);
    const denom = d00.mul(d11).sub(d01.mul(d01));
    const v = d11.mul(d20).sub(d01.mul(d21)).div(denom);
    const w = d00.mul(d21).sub(d01.mul(d20)).div(denom);
    return vec3(f32(1).sub(v).sub(w), v, w);
}

const fog = (rgb: Node<d.vec3f>, viewDepth: Node<d.f32>) =>
    mix(rgb, skyColor, smoothstep(f32(FOG_START), f32(FOG_END), viewDepth));

const gbufferAlbedo = targetColor(gbuffer);
const gbufferNormal = texture(gbuffer.textures[1] as Texture);
const gbufferLight = texture(gbuffer.textures[2] as Texture);
const gbufferDepth = targetDepth(gbuffer);

const lightingFragment = Fn(
    (pixelX, pixelY) => {
        const pixel = vec2i(pixelX.toI32(), pixelY.toI32());
        const depth = gbufferDepth.load(pixel).toVar('lpDepth');
        const color = Var('lpColor', skyColor);
        If(depth.lessThan(f32(1)), () => {
            const albedoGlow = gbufferAlbedo.load(pixel).toVar('lpAlbedoGlow');
            const normalSky = gbufferNormal.load(pixel).toVar('lpNormalSky');
            const light = gbufferLight.load(pixel).xyz.toVar('lpLight');
            const flags = floor(normalSky.w.mul(f32(255)).add(f32(0.5)))
                .toU32()
                .toVar('lpFlags');
            const viewDepth = viewDepthOf(depth).toVar('lpViewDepth');
            If(flags.bitwiseAnd(u32(FLAG_PRELIT)).notEqual(u32(0)), () => {
                color.assign(fog(albedoGlow.xyz, viewDepth));
            }).Else(() => {
                const pos = eye.xyz.add(rayAt(pixelX, pixelY).mul(viewDepth)).toVar('lpPos');
                const receives = select(f32(0), f32(1), flags.bitwiseAnd(u32(FLAG_RECEIVES)).notEqual(u32(0)));
                const unlit = select(f32(0), f32(1), flags.bitwiseAnd(u32(FLAG_UNLIT)).notEqual(u32(0)));
                color.assign(
                    litSurface(
                        albedoGlow.xyz,
                        octDecode(normalSky.xy),
                        pos,
                        light,
                        normalSky.z,
                        viewDepth,
                        pixelX,
                        pixelY,
                        receives,
                        albedoGlow.w,
                        unlit,
                    ),
                );
            });
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

const visibilityId = targetColor(visibility);
const visibilityDepth = targetDepth(visibility);

/** the surface a visibility pixel rebuilds into, each kind's branch filling it */
type Rebuilt = {
    albedo: ReturnType<typeof Var<d.vec3f>>;
    normal: ReturnType<typeof Var<d.vec3f>>;
    pos: ReturnType<typeof Var<d.vec3f>>;
    light: ReturnType<typeof Var<d.vec3f>>;
    sky: ReturnType<typeof Var<d.f32>>;
    viewDepth: ReturnType<typeof Var<d.f32>>;
    receives: ReturnType<typeof Var<d.f32>>;
    glow: ReturnType<typeof Var<d.f32>>;
    unlit: ReturnType<typeof Var<d.f32>>;
    prelit: ReturnType<typeof Var<d.f32>>;
};

/** terrain quad `quad` of `arena` at the pixel whose rays are `ray`, `rayX` and `rayY` (a pixel right, down) */
function rebuildTerrain(
    quad: Node<d.u32>,
    ray: Node<d.vec3f>,
    rayX: Node<d.vec3f>,
    rayY: Node<d.vec3f>,
    out: Rebuilt,
    prefix: string,
): void {
    const q = [0, 1, 2, 3].map((k) => quadVec4Nodes.element(quad.mul(u32(4)).add(u32(k))).toVar(`${prefix}Q${k}`));
    const word = (w: number): Node<d.u32> => [q[w >> 2]!.x, q[w >> 2]!.y, q[w >> 2]!.z, q[w >> 2]!.w][w & 3]!;
    const origin = sceneAt(SCENE_SECTIONS, slotNodes.element(quad)).xyz.toVar(`${prefix}Origin`);
    const half = (h: number) => ((h & 1) === 1 ? word(h >> 1).shiftRight(u32(16)) : word(h >> 1).bitwiseAnd(u32(0xffff))).toF32();
    const meta = word(META_WORD).toVar(`${prefix}Meta`);
    const flags = word(FLAGS_WORD).toVar(`${prefix}Flags`);
    const normal = decodeOct16(word(6).bitwiseAnd(u32(0xffff))).toVar(`${prefix}Normal`);
    const shade = select(faceShadeOf(normal), f32(1), flags.shiftRight(u32(24)).bitwiseAnd(u32(1)).equal(u32(1))).toVar(
        `${prefix}Shade`,
    );
    const corners = [0, 1, 2, 3].map((c) => {
        const position = origin
            .add(
                vec3(half(3 * c), half(3 * c + 1), half(3 * c + 2))
                    .mul(f32(1 / POS_ENCODE_SCALE))
                    .sub(vec3(f32(POS_ENCODE_ORIGIN))),
            )
            .toVar(`${prefix}P${c}`);
        const uvPacked = word(7 + c);
        const uv = vec2(uvPacked.bitwiseAnd(u32(0xffff)).toF32(), uvPacked.shiftRight(u32(16)).toF32()).div(f32(65535));
        const ao = meta
            .shiftRight(u32(4 * c))
            .bitwiseAnd(u32(15))
            .toF32()
            .div(f32(30))
            .add(f32(0.5));
        // corner c's 24 light bits from bit 24c of the light words
        const bit = 24 * c;
        const low = word(LIGHT_WORD + (bit >> 5)).shiftRight(u32(bit & 31));
        const bits = (
            (bit & 31) > 8 ? low.bitwiseOr(word(LIGHT_WORD + Math.min((bit >> 5) + 1, 2)).shiftLeft(u32(32 - (bit & 31)))) : low
        ).bitwiseAnd(u32(0xffffff));
        const channels = cornerChannels(bits).toVar(`${prefix}Channels${c}`);
        return { position, uv, light: cornerLight(channels, ao, shade).toVar(`${prefix}Light${c}`), sky: channels.x };
    });
    // the vertex corners turned by the diagonal flip, then the triangle the pixel lands in: 0, 1, 2 or 0, 2, 3
    const flip = meta.shiftRight(u32(DIAG_FLIP_BIT)).bitwiseAnd(u32(1)).equal(u32(1)).toVar(`${prefix}Flip`);
    const turned = <T extends Node<d.Any>>(pick: (c: (typeof corners)[number]) => T, k: number) =>
        select(pick(corners[k]!), pick(corners[(k + 1) & 3]!), flip) as T;
    const a = turned((c) => c.position, 0).toVar(`${prefix}A`);
    const b1 = turned((c) => c.position, 1).toVar(`${prefix}B1`);
    const c1 = turned((c) => c.position, 2).toVar(`${prefix}C1`);
    const c2 = turned((c) => c.position, 3).toVar(`${prefix}C2`);
    const t = meetPlane(ray, a, normal).toVar(`${prefix}T`);
    const point = eye.xyz.add(ray.mul(t)).toVar(`${prefix}Point`);
    const first = barycentric(point, a, b1, c1).toVar(`${prefix}First`);
    const inFirst = first.y
        .greaterThanEqual(f32(-1e-4))
        .and(first.z.greaterThanEqual(f32(-1e-4)))
        .and(first.x.greaterThanEqual(f32(-1e-4)))
        .toVar(`${prefix}InFirst`);
    const b = select(c1, b1, inFirst).toVar(`${prefix}B`);
    const c = select(c2, c1, inFirst).toVar(`${prefix}C`);
    const weights = (p: Node<d.vec3f>) => barycentric(p, a, b, c);
    const w = weights(point).toVar(`${prefix}W`);
    const pick = <T extends Node<d.Any>>(get: (c: (typeof corners)[number]) => T) => {
        const va = turned(get, 0);
        const vb = select(turned(get, 2), turned(get, 1), inFirst) as T;
        const vc = select(turned(get, 3), turned(get, 2), inFirst) as T;
        return (bw: Node<d.vec3f>) =>
            (va as Node<d.vec3f>)
                .mul(bw.x)
                .add((vb as Node<d.vec3f>).mul(bw.y))
                .add((vc as Node<d.vec3f>).mul(bw.z));
    };
    const uvAt = pick((c) => vec3(c.uv, f32(0)));
    const uv = uvAt(w).xy.toVar(`${prefix}Uv`);
    // the uv a pixel right and down, on the same plane and triangle: its screen derivatives
    const uvX = uvAt(weights(eye.xyz.add(rayX.mul(meetPlane(rayX, a, normal))))).xy;
    const uvY = uvAt(weights(eye.xyz.add(rayY.mul(meetPlane(rayY, a, normal))))).xy;
    const frames = textureFrames(flags.bitwiseAnd(u32(0xffff)), `${prefix}Tex`);
    const uvA = frames.rectA.xy.add(uv.mul(frames.rectA.zw));
    const uvB = frames.rectB.xy.add(uv.mul(frames.rectB.zw));
    const albedo = sampleAtlasColor(
        uvA,
        uvB,
        frames.rectA,
        frames.rectB,
        frames.mixFactor,
        uvX.sub(uv).mul(frames.rectA.zw),
        uvY.sub(uv).mul(frames.rectA.zw),
    ).xyz.toVar(`${prefix}Albedo`);
    out.albedo.assign(albedo);
    out.normal.assign(normal);
    out.pos.assign(point);
    out.light.assign(pick((c) => c.light)(w));
    out.sky.assign(pick((c) => vec3(c.sky, f32(0), f32(0)))(w).x);
    out.viewDepth.assign(t);
    out.receives.assign(f32(1));
    out.glow.assign(emissiveGlow(albedo, flags.shiftRight(u32(23)).bitwiseAnd(u32(1)).toF32()));
    out.unlit.assign(f32(0));
    out.prelit.assign(f32(0));
}

/** model triangle `triangle` of row `row`: its three vertices from the pool, the pixel's weights in it */
function rebuildModel(
    row: Node<d.u32>,
    triangle: Node<d.u32>,
    ray: Node<d.vec3f>,
    rayX: Node<d.vec3f>,
    rayY: Node<d.vec3f>,
    out: Rebuilt,
): void {
    const r = modelRow(row.mul(u32(MODEL_ROW_VEC4S)), 'rm');
    const [m0, m1, m2, m3] = r.columns;
    const vertices = [0, 1, 2].map((k) => {
        const v = triangle.mul(u32(3)).add(u32(k));
        const posU = sceneAt(SCENE_POOL, v.mul(u32(2))).toVar(`rmPosU${k}`);
        const normalV = sceneAt(SCENE_POOL, v.mul(u32(2)).add(u32(1))).toVar(`rmNormalV${k}`);
        return {
            world: m0.mul(posU.x).add(m1.mul(posU.y)).add(m2.mul(posU.z)).add(m3).xyz.toVar(`rmWorld${k}`),
            normal: m0.xyz.mul(normalV.x).add(m1.xyz.mul(normalV.y)).add(m2.xyz.mul(normalV.z)),
            uv: r.uvRect.xy.add(vec2(posU.w, normalV.w).mul(r.uvRect.zw)),
        };
    });
    const [p0, p1, p2] = vertices.map((v) => v.world);
    const plane = normalize(cross(p1!.sub(p0!), p2!.sub(p0!))).toVar('rmPlane');
    const t = meetPlane(ray, p0!, plane).toVar('rmT');
    const point = eye.xyz.add(ray.mul(t)).toVar('rmPoint');
    const interp = <T extends Node<d.vec2f> | Node<d.vec3f>>(get: (v: (typeof vertices)[number]) => T, bw: Node<d.vec3f>) =>
        (get(vertices[0]!) as Node<d.vec3f>)
            .mul(bw.x)
            .add((get(vertices[1]!) as Node<d.vec3f>).mul(bw.y))
            .add((get(vertices[2]!) as Node<d.vec3f>).mul(bw.z)) as unknown as T;
    const w = barycentric(point, p0!, p1!, p2!).toVar('rmW');
    const uv = interp((v) => v.uv, w).toVar('rmUv');
    const uvX = interp((v) => v.uv, barycentric(eye.xyz.add(rayX.mul(meetPlane(rayX, p0!, plane))), p0!, p1!, p2!));
    const uvY = interp((v) => v.uv, barycentric(eye.xyz.add(rayY.mul(meetPlane(rayY, p0!, plane))), p0!, p1!, p2!));
    const tex = atlasNode.sample(uv).grad(uvX.sub(uv), uvY.sub(uv)).toVar('rmTex');
    // bongle samples a model's voxel light at each vertex; here once, at the pixel
    const sample = sampleWorldLight(point).toVar('rmSample');
    out.albedo.assign(tintAlbedo(tex.xyz, r.tint, r.flash));
    out.normal.assign(normalize(interp((v) => v.normal, w)));
    out.pos.assign(point);
    out.light.assign(kindLight(sample, r.litMin));
    out.sky.assign(sample.x);
    out.viewDepth.assign(t);
    out.receives.assign(r.receives);
    out.glow.assign(r.glow);
    out.unlit.assign(r.unlit);
    out.prelit.assign(f32(0));
}

/** sprite row `row`: its billboard's plane, the pixel's point on it, its light worked out as bongle's per vertex */
function rebuildSprite(
    row: Node<d.u32>,
    ray: Node<d.vec3f>,
    rayX: Node<d.vec3f>,
    rayY: Node<d.vec3f>,
    pixelX: Node<d.f32>,
    pixelY: Node<d.f32>,
    out: Rebuilt,
): void {
    const r = spriteRow(row.mul(u32(SPRITE_ROW_VEC4S)), 'rs');
    const b = spriteBasis(r.position, 'rs');
    const uvOn = (rayOf: Node<d.vec3f>) => {
        const local = eye.xyz.add(rayOf.mul(meetPlane(rayOf, r.position, b.normal))).sub(r.position);
        return r.uvRect.xy.add(
            vec2(dot(local, b.right).div(r.width).add(f32(0.5)), f32(1).sub(dot(local, b.up).div(r.height))).mul(r.uvRect.zw),
        );
    };
    const uv = uvOn(ray).toVar('rsUv');
    const tex = atlasNode.sample(uv).grad(uvOn(rayX).sub(uv), uvOn(rayY).sub(uv)).toVar('rsTex');
    const depth = meetPlane(ray, r.position, b.normal).toVar('rsT');
    const light = spriteLight(r.position, b.normal, depth, pixelX, pixelY, r.litMin, r.receives);
    const albedo = tintAlbedo(tex.xyz, r.tint, r.flash);
    out.albedo.assign(mix(albedo.mul(max(light, vec3(r.glow))), albedo, r.unlit));
    out.viewDepth.assign(depth);
    out.prelit.assign(f32(1));
}

const resolveFragment = Fn(
    (pixelX, pixelY) => {
        const pixel = vec2i(pixelX.toI32(), pixelY.toI32());
        const depth = visibilityDepth.load(pixel).toVar('rvDepth');
        const color = Var('rvColor', skyColor);
        If(depth.lessThan(f32(1)), () => {
            const bytes = floor(
                visibilityId
                    .load(pixel)
                    .mul(f32(255))
                    .add(vec4(f32(0.5))),
            ).toVar('rvBytes');
            const id = bytes.x
                .toU32()
                .bitwiseOr(bytes.y.toU32().shiftLeft(u32(8)))
                .bitwiseOr(bytes.z.toU32().shiftLeft(u32(16)))
                .bitwiseOr(bytes.w.toU32().shiftLeft(u32(24)))
                .toVar('rvId');
            const kind = id.shiftRight(u32(30)).toVar('rvKind');
            const payload = id.bitwiseAnd(u32(0x3fffffff)).toVar('rvPayload');
            const ray = rayAt(pixelX, pixelY).toVar('rvRay');
            const rayX = rayAt(pixelX.add(f32(1)), pixelY).toVar('rvRayX');
            const rayY = rayAt(pixelX, pixelY.add(f32(1))).toVar('rvRayY');
            const out: Rebuilt = {
                albedo: Var('rvAlbedo', vec3(f32(0))),
                normal: Var('rvNormal', vec3(f32(0), f32(1), f32(0))),
                pos: Var('rvPos', vec3(f32(0))),
                light: Var('rvLight', vec3(f32(0))),
                sky: Var('rvSky', f32(0)),
                viewDepth: Var('rvViewDepth', f32(0)),
                receives: Var('rvReceives', f32(1)),
                glow: Var('rvGlow', f32(0)),
                unlit: Var('rvUnlit', f32(0)),
                prelit: Var('rvPrelit', f32(0)),
            };
            If(kind.lessThanEqual(u32(KIND_CUTOUT)), () => rebuildTerrain(payload, ray, rayX, rayY, out, 'rt'))
                .ElseIf(kind.equal(u32(KIND_MODEL)), () =>
                    rebuildModel(payload.shiftRight(u32(8)), payload.bitwiseAnd(u32(255)), ray, rayX, rayY, out),
                )
                .Else(() => rebuildSprite(payload, ray, rayX, rayY, pixelX, pixelY, out));
            If(out.prelit.greaterThan(f32(0.5)), () => {
                color.assign(fog(out.albedo, out.viewDepth));
            }).Else(() => {
                color.assign(
                    litSurface(
                        out.albedo,
                        out.normal,
                        out.pos,
                        out.light,
                        out.sky,
                        out.viewDepth,
                        pixelX,
                        pixelY,
                        out.receives,
                        out.glow,
                        out.unlit,
                    ),
                );
            });
        });
        return vec4(color, f32(1));
    },
    {
        name: 'resolveFragment',
        params: [
            { name: 'pixelX', type: d.f32 },
            { name: 'pixelY', type: d.f32 },
        ],
        return: d.vec4f,
    },
);
const resolvePass = fullscreen(resolveFragment(screenCoordinate.x, screenCoordinate.y));

// ─── Meshes, and each view's draws ──────────────────────────────────────────

function indexedMesh(indices: GpuBuffer, material: Material): Mesh {
    const geometry = new Geometry();
    geometry.setIndex(indices);
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.updateWorldMatrix();
    return mesh;
}

const opaqueMaterials = terrainMaterials(0, false, KIND_TERRAIN, 'terrain');
const cutoutMaterials = terrainMaterials(OPAQUE_QUADS, true, KIND_CUTOUT, 'cutout');
const modelKind = modelMaterials('model');
const spriteKind = spriteMaterials('sprite');

const opaqueMesh = indexedMesh(quadIndices, opaqueMaterials.forward);
const cutoutMesh = indexedMesh(quadIndices, cutoutMaterials.forward);
const modelMesh = indexedMesh(modelIndices, modelKind.forward);
const spriteMesh = indexedMesh(spriteQuadIndices, spriteKind.forward);

/** a view's draws of each kind */
type ViewDraws = { opaque: IndexedMeshDraw[]; cutout: IndexedMeshDraw[]; models: IndexedMeshDraw[]; sprites: IndexedMeshDraw[] };

const _frustum = frustum.create();
const _visibleSections: number[] = [];
let modelSlotsUsed = 0;
let spriteSlotsUsed = 0;

/** what `viewCamera` sees: its sections' quads nearest first, a draw a section's run, and its columns' models and
 *  sprites as a run of each slot map */
function cullView(viewCamera: PerspectiveCamera | OrthographicCamera): ViewDraws {
    frustum.setFromViewProjectionMatrixNO(_frustum, viewCamera.projectionMatrix, viewCamera.matrixWorldInverse);
    const p = viewCamera.position;
    _visibleSections.length = 0;
    for (let s = 0; s < sections.length; s++) {
        const section = sections[s];
        if (section.opaqueCount + section.cutoutCount === 0) continue;
        if (frustum.intersectsBox3(_frustum, section.box)) _visibleSections.push(s);
    }
    const distance = (s: number) => {
        const o = sections[s].origin;
        return (o[0] + 8 - p[0]) ** 2 + (o[1] + 8 - p[1]) ** 2 + (o[2] + 8 - p[2]) ** 2;
    };
    _visibleSections.sort((a, b) => distance(a) - distance(b));
    const draws: ViewDraws = { opaque: [], cutout: [], models: [], sprites: [] };
    for (const s of _visibleSections) {
        const section = sections[s];
        if (section.opaqueCount > 0)
            draws.opaque.push({
                indexCount: section.opaqueCount * 6,
                instanceCount: 1,
                firstIndex: 0,
                firstInstance: section.opaqueFirst,
            });
        if (section.cutoutCount > 0)
            draws.cutout.push({
                indexCount: section.cutoutCount * 6,
                instanceCount: 1,
                firstIndex: 0,
                firstInstance: section.cutoutFirst,
            });
    }
    const modelFirst = modelSlotsUsed;
    const spriteFirst = spriteSlotsUsed;
    for (let c = 0; c < COLUMNS; c++) {
        if (!frustum.intersectsBox3(_frustum, columnBoxes[c])) continue;
        for (const row of columnModelRows[c]) modelSlotData[modelSlotsUsed++] = row;
        for (const row of columnSpriteRows[c]) spriteSlotData[spriteSlotsUsed++] = row;
    }
    if (modelSlotsUsed > modelFirst)
        draws.models.push({
            indexCount: MODEL_VERTICES,
            instanceCount: modelSlotsUsed - modelFirst,
            firstIndex: 0,
            firstInstance: modelFirst,
        });
    if (spriteSlotsUsed > spriteFirst)
        draws.sprites.push({
            indexCount: 6,
            instanceCount: spriteSlotsUsed - spriteFirst,
            firstIndex: 0,
            firstInstance: spriteFirst,
        });
    return draws;
}

/** `draws` into `pass`, each kind with the material `pick` chooses: opaque terrain, models, sprites, cutout terrain */
function drawKinds(pass: Pass, draws: ViewDraws, pick: (m: Materials) => Material | null): void {
    const draw = (mesh: Mesh, list: IndexedMeshDraw[], materials: Materials) => {
        const material = pick(materials);
        if (material !== null && list.length > 0) pass.draw(mesh, { material, draws: list });
    };
    draw(opaqueMesh, draws.opaque, opaqueMaterials);
    draw(modelMesh, draws.models, modelKind);
    draw(spriteMesh, draws.sprites, spriteKind);
    draw(cutoutMesh, draws.cutout, cutoutMaterials);
}

// ─── Lights, the sun and the point lights' shadows ──────────────────────────

const settings = {
    path: 'forward',
    view: 'forest floor',
    time: 'day',
    lights: 0,
    shadows: true,
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
/** each redrawn face's camera aimed, its casters culled into the slot maps, its record written: before any pass is
 *  recorded, as every view's data is */
const faceDraws: ViewDraws[] = [];
function prepareShadows(): void {
    faceDraws.length = 0;
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
        faceDraws.push(cullView(faceCamera));
        mat4.multiply(faceMatrix, faceCamera.projectionMatrix, faceCamera.matrixWorldInverse);
        const at = (s * SHADOW_VEC4S + face * SHADOW_FACE_VEC4S) * 4;
        shadowData.set(faceMatrix, at);
        shadowData[at + 16] = ((v % SHADOW_SLOTS_ACROSS) * SHADOW_SLOT) / SHADOW_ATLAS;
        shadowData[at + 17] = (Math.floor(v / SHADOW_SLOTS_ACROSS) * SHADOW_SLOT) / SHADOW_ATLAS;
        shadowData[at + 18] = SHADOW_SLOT / SHADOW_ATLAS;
        viewMapped[v] = 1;
        viewDrawnFrame[v] = shadowFrame;
        viewDrawnFrom[v][0] = p[0];
        viewDrawnFrom[v][1] = p[1];
        viewDrawnFrom[v][2] = p[2];
    }
    // a slot taken by a new light reads as holding no map until its face is drawn
    for (let v = 0; v < VIEWS_MAX; v++) shadowData[(Math.floor(v / 6) * SHADOW_VEC4S + (v % 6) * SHADOW_FACE_VEC4S) * 4 + 19] = viewMapped[v];
    dynamicBuffer.addUpdateRange(SHADOWS_BASE * 4, shadowData.length);
    dynamicBuffer.needsUpdate = true;
}

/** the redrawn faces into the atlas, each its slot cleared then its casters drawn */
function drawShadows(f: ReturnType<typeof frame>): void {
    if (redraws.length === 0) return;
    const pass = f.pass({ target: shadowAtlas, clearDepth: false, label: 'light-shadows' });
    for (let k = 0; k < redraws.length; k++) {
        const v = redraws[k];
        pass.setViewport({ x: (v % SHADOW_SLOTS_ACROSS) * SHADOW_SLOT, y: Math.floor(v / SHADOW_SLOTS_ACROSS) * SHADOW_SLOT, width: SHADOW_SLOT, height: SHADOW_SLOT });
        pass.draw(clearSlot);
        pass.setCamera(faceCameras[k]);
        drawKinds(pass, faceDraws[k], (m) => m.light);
    }
    pass.end();
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
    dynamicBuffer.addUpdateRange(0, Math.max(order.length, 1) * 8);
    dynamicBuffer.needsUpdate = true;
    tileBinBuffer.addUpdateRange(0, tilesX * tilesY * LIGHT_WORDS);
    tileBinBuffer.addUpdateRange(BINS_BASE, DEPTH_BINS);
    tileBinBuffer.needsUpdate = true;
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
    frameConfig.options[2] = time;
    frameConfig.sky[3] = day ? 0.9 : 0.05;
    frameConfig.options[0] = settings.shadows ? 1 : 0;
    if (day) fitSun();
    binLights(time);
    frameUniform.value = frameConfig;
    frameConfig.size[0] = canvas.width;
    frameConfig.size[1] = canvas.height;
    frameUniform.value = frameConfig;
}

// ─── Controls ───────────────────────────────────────────────────────────────

const info = { triangles: Math.round(triangles).toLocaleString(), frame: '' };
const gui = new GUI();
gui.add(settings, 'path', ['forward', 'deferred', 'visibility']);
gui.add(settings, 'view', Object.keys(VIEWS)).onChange((name: string) => setView(name));
gui.add(settings, 'time', ['day', 'night']);
gui.add(settings, 'lights', 0, MAX_LIGHTS, 1);
gui.add(settings, 'shadows').name('light shadows');
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

    // every view culled and every buffer written before any pass is recorded: a draw reads its buffers as they stand
    // when it is drawn
    modelSlotsUsed = 0;
    spriteSlotsUsed = 0;
    shadowFrame++;
    const shadowsOn = settings.shadows && settings.lights > 0;
    if (shadowsOn) {
        chooseRedraws();
        prepareShadows();
    }
    const sunDraws = settings.time === 'day' ? cullView(sunCamera) : null;
    const visible = cullView(camera);
    modelSlotBuffer.addUpdateRange(0, Math.max(modelSlotsUsed, 1));
    modelSlotBuffer.needsUpdate = true;
    spriteSlotBuffer.addUpdateRange(0, Math.max(spriteSlotsUsed, 1));
    spriteSlotBuffer.needsUpdate = true;

    const f = frame(renderer);
    if (shadowsOn) drawShadows(f);
    if (sunDraws !== null) {
        const sunPass = f.pass({ target: sunMap, camera: sunCamera, clearDepth: 1, label: 'sun' });
        drawKinds(sunPass, sunDraws, (m) => m.sun);
        sunPass.end();
    }
    if (settings.path === 'forward') {
        // as bongle orders it: opaque terrain, cutout terrain's depth, models, sprites, then cutout terrain's colour
        const pass = f.pass({ target: view, camera, label: 'forward' });
        if (visible.opaque.length > 0) pass.draw(opaqueMesh, { material: opaqueMaterials.forward, draws: visible.opaque });
        if (visible.cutout.length > 0) pass.draw(cutoutMesh, { material: cutoutMaterials.prepass!, draws: visible.cutout });
        if (visible.models.length > 0) pass.draw(modelMesh, { material: modelKind.forward, draws: visible.models });
        if (visible.sprites.length > 0) pass.draw(spriteMesh, { material: spriteKind.forward, draws: visible.sprites });
        if (visible.cutout.length > 0) pass.draw(cutoutMesh, { material: cutoutMaterials.forward, draws: visible.cutout });
        pass.end();
    } else if (settings.path === 'deferred') {
        const geometryPass = f.pass({ target: gbuffer, camera, clear: [0, 0, 0, 0], label: 'gbuffer' });
        drawKinds(geometryPass, visible, (m) => m.gbuffer);
        geometryPass.end();
        const lighting = f.pass({ target: view, label: 'lighting' });
        lighting.draw(lightingPass);
        lighting.end();
    } else {
        const geometryPass = f.pass({ target: visibility, camera, clear: [0, 0, 0, 0], label: 'visibility' });
        drawKinds(geometryPass, visible, (m) => m.visibility);
        geometryPass.end();
        const resolve = f.pass({ target: view, label: 'resolve' });
        resolve.draw(resolvePass);
        resolve.end();
    }
    f.submit();
    requestAnimationFrame(update);
}

requestAnimationFrame(update);
