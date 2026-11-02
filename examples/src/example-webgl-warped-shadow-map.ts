import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    clamp,
    comparisonSampler,
    createCanvasTarget,
    createMaterial,
    createPlaneGeometry,
    createRenderTarget,
    createVertexBuffer,
    d,
    depthTexture,
    drawScene,
    f32,
    frame,
    Geometry,
    GpuSampler,
    init,
    length,
    Mesh,
    mix,
    modelNormalMatrix,
    modelWorldMatrix,
    mul,
    type Node,
    ndcDepthToStorage,
    normalize,
    OrbitControls,
    OrthographicCamera,
    PerspectiveCamera,
    Scene,
    select,
    smoothstep,
    struct,
    textureSampleCompareLevel,
    Uniform,
    uniform,
    varying,
    vec2,
    vec2i,
    vec3,
    vec4,
    webgl,
} from 'gpucat';
import GUI from 'lil-gui';
import { type Euler, mat4, quat, type Vec3 } from 'math';

// A warped shadow map for a sun, as Minecraft shader packs draw theirs: one orthographic view down the sun over
// everything within REACH of the camera, its clip positions drawn toward the camera by x / (warp |x| + 1 - warp), so
// the texels are finest where the camera stands and widen away from it. The casters warp in their vertex shader and
// every lit fragment warps its lookup the same way. The warp bends straight lines, and a triangle is drawn straight
// between its warped corners, so the world is made of small triangles: here the ground is a grid of cells.

const SHADOW_SIZE = 2048;
/** how far the map reaches from the camera, in world units */
const REACH = 160;
/** blocks the map's centre moves in, across the sun's view, so its texels stay put on the world */
const SNAP = 2;
/** how far behind the reach a caster can stand and still shadow into it */
const PULLBACK = 96;
/** the share of the reach over which the shadows fade out, rather than stop */
const FADE = 0.15;
/** how far along its normal a surface is looked up, in the texels where it stands */
const NORMAL_TEXELS = 3;
const HALF_TEXEL = 0.5 / SHADOW_SIZE;

// ─── Renderer ───────────────────────────────────────────────────────────────

const canvas = document.createElement('canvas');
canvas.style.display = 'block';
document.body.appendChild(canvas);

const view = createCanvasTarget(canvas, { samples: 4, clearColor: [0.55, 0.7, 0.9, 1] });
view.setPixelRatio(devicePixelRatio);
view.setSize(window.innerWidth, window.innerHeight);

const renderer = await init(webgl({ target: view }));

const camera = new PerspectiveCamera(Math.PI / 3.5, window.innerWidth / window.innerHeight, 0.1, 400);
camera.position = [0, 9, 24];
const controls = new OrbitControls(camera, canvas);
controls.target = [0, 2, 0];

window.addEventListener('resize', () => {
    view.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

// ─── The map ────────────────────────────────────────────────────────────────

const shadowMap = createRenderTarget(SHADOW_SIZE, SHADOW_SIZE, {
    depthFormat: 'depth24plus',
    count: 0,
    depthSampled: true,
});

/** the map's view-projection, the world size of an unwarped map's texels, how strongly it warps */
const WarpConfig = struct('WarpConfig', {
    matrix: d.mat4x4f,
    texel: d.f32,
    warp: d.f32,
    debug: d.f32,
});

const config = { matrix: mat4.create(), texel: 1, warp: 0.85, debug: 0 };
const configUniform = new Uniform(WarpConfig, config);
const cfg = uniform(configUniform);
const warp = cfg.field('warp');

const sunCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

const sun: Vec3 = [0, 1, 0];
const right: Vec3 = [1, 0, 0];
const up: Vec3 = [0, 1, 0];
const centre: Vec3 = [0, 0, 0];

/**
 * The map: centred on the camera, the reach across each way, viewed down the sun from far enough back to catch what
 * stands behind it. Its centre snaps to whole SNAP steps across the sun's view: the warp moves with the camera, so the
 * texels can't stay put the way an even map's do, but snapping keeps them still while the camera moves within a step.
 */
function fitMap(): void {
    const m = camera.matrixWorld;
    centre[0] = m[12];
    centre[1] = m[13];
    centre[2] = m[14];
    const radius = Math.ceil(REACH);
    config.texel = (2 * radius) / SHADOW_SIZE;

    // the sun's view across: any two axes square to it
    const vertical = Math.abs(sun[1]) > 0.99;
    up[0] = 0;
    up[1] = vertical ? 0 : 1;
    up[2] = vertical ? 1 : 0;
    cross(right, up, sun);
    normalize3(right);
    cross(up, sun, right);
    const across = dot(centre, right);
    const upward = dot(centre, up);
    const shiftAcross = Math.floor(across / SNAP) * SNAP - across;
    const shiftUp = Math.floor(upward / SNAP) * SNAP - upward;
    for (let a = 0; a < 3; a++) centre[a] += right[a] * shiftAcross + up[a] * shiftUp;

    sunCamera.coordinateSystem = camera.coordinateSystem;
    sunCamera.left = -radius;
    sunCamera.right = radius;
    sunCamera.top = radius;
    sunCamera.bottom = -radius;
    sunCamera.near = 0;
    sunCamera.far = 2 * radius + PULLBACK;
    sunCamera.updateProjectionMatrix();
    const back = radius + PULLBACK;
    sunCamera.position = [centre[0] + sun[0] * back, centre[1] + sun[1] * back, centre[2] + sun[2] * back];
    sunCamera.lookAt([centre[0], centre[1], centre[2]], up);
    sunCamera.updateWorldMatrix();
    sunCamera.updateViewMatrix();
    mat4.multiply(config.matrix, sunCamera.projectionMatrix, sunCamera.matrixWorldInverse);
    configUniform.value = config;
}

function cross(out: Vec3, a: Vec3, b: Vec3): void {
    const x = a[1] * b[2] - a[2] * b[1];
    const y = a[2] * b[0] - a[0] * b[2];
    const z = a[0] * b[1] - a[1] * b[0];
    out[0] = x;
    out[1] = y;
    out[2] = z;
}

function dot(a: Vec3, b: Vec3): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize3(v: Vec3): void {
    const length = Math.hypot(v[0], v[1], v[2]) || 1;
    v[0] /= length;
    v[1] /= length;
    v[2] /= length;
}

/** a clip position drawn toward the map's centre: x / (warp |x| + 1 - warp) across, its depth left alone */
function warpClip(clip: Node<d.vec4f>): Node<d.vec4f> {
    const factor = length(clip.xy).mul(warp).add(f32(1).sub(warp));
    return vec4(clip.xy.div(factor), clip.z, clip.w);
}

// ─── Materials ──────────────────────────────────────────────────────────────

const position = attribute('position', d.vec3f);
const normal = attribute('normal', d.vec3f);
const color = attribute('color', d.vec3f);

const worldPos = mul(modelWorldMatrix, vec4(position, f32(1)));
const viewPos = mul(cameraViewMatrix, worldPos);
const clipPos = mul(cameraProjectionMatrix, viewPos);

// drawn into the map from the sun's camera, warped, biased so a lit surface doesn't shadow itself
const casterMaterial = createMaterial({ vertex: warpClip(clipPos), fragment: undefined, depthBias: 2, depthBiasSlopeScale: 2 });

const vWorldPos = varying(worldPos.xyz, 'v_worldPos');
const vNormal = varying(normalize(mul(modelNormalMatrix, normal)), 'v_normal');
const vColor = varying(color, 'v_color');
const vDepth = varying(viewPos.z.negate(), 'v_depth');

const sunValue = new Float32Array([0, 1, 0]);
const sunUniform = new Uniform(d.vec3f, sunValue);
const sunDirection = uniform(sunUniform);

const shadowDepth = depthTexture(shadowMap.depthTexture!).bindingNode;
const shadowSampler = comparisonSampler(
    new GpuSampler({ minFilter: 'linear', magFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' }),
    'less',
);

// the warp stretches texels by (warp r + 1 - warp)^2 / (1 - warp) at clip radius r: the normal offset widens with them
const matrix = cfg.field('matrix');
const surfaceClip = mul(matrix, vec4(vWorldPos, f32(1))).toVar('surfaceClip');
const spread = length(surfaceClip.xy).mul(warp).add(f32(1).sub(warp)).toVar('spread');
const stretch = spread.mul(spread).div(f32(1).sub(warp)).toVar('stretch');
const at = vWorldPos.add(vNormal.mul(cfg.field('texel').mul(stretch).mul(f32(NORMAL_TEXELS))));
const clip = warpClip(mul(matrix, vec4(at, f32(1)))).toVar('clip');
const uv = vec2(clip.x.mul(f32(0.5)).add(f32(0.5)), f32(0.5).sub(clip.y.mul(f32(0.5)))).toVar('uv');
const reference = ndcDepthToStorage(clip.z).toVar('reference');
// four filtered compares half a texel apart: a 3 x 3 soft edge
const tap = (dx: number, dy: number) =>
    textureSampleCompareLevel(
        shadowDepth,
        shadowSampler,
        clamp(uv.add(vec2(f32(dx * HALF_TEXEL), f32(dy * HALF_TEXEL))), vec2(f32(HALF_TEXEL * 2)), vec2(f32(1 - HALF_TEXEL * 2))),
        reference,
    );
const shadowed = tap(-1, -1).add(tap(1, -1)).add(tap(-1, 1)).add(tap(1, 1)).mul(f32(0.25));
const inside = uv.x
    .greaterThanEqual(f32(0))
    .and(uv.x.lessThanEqual(f32(1)))
    .and(uv.y.greaterThanEqual(f32(0)))
    .and(uv.y.lessThanEqual(f32(1)));
const fade = smoothstep(f32(REACH * (1 - FADE)), f32(REACH), vDepth);
const lit = select(mix(select(f32(1), shadowed, inside), f32(1), fade), f32(1), vDepth.greaterThanEqual(f32(REACH)));

// a checker of the map's texels, eight to a square, to see how finely each part of the world is shadowed
const square = uv.mul(f32(SHADOW_SIZE / 8)).floor();
const checker = square.x.add(square.y).mod(f32(2));
const debugTint = mix(vec3(f32(1), f32(0.55), f32(0.55)), vec3(f32(0.55), f32(0.7), f32(1)), checker);

const facing = vNormal.dot(sunDirection).max(f32(0));
const base = mix(vColor, vColor.mul(debugTint), cfg.field('debug'));
const sky = vec3(f32(0.32), f32(0.36), f32(0.45));
const sunlight = vec3(f32(1.1), f32(1), f32(0.85));
const shaded = base.mul(sky.add(sunlight.mul(facing.mul(lit))));

const sceneMaterial = createMaterial({ vertex: clipPos, fragment: vec4(shaded, f32(1)) });

// ─── The world: a forest of box trees on a ground ──────────────────────────

type Parts = { positions: number[]; normals: number[]; colors: number[] };

const FACES: { n: Vec3; u: Vec3; v: Vec3 }[] = [
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

/** the faces of a box centred at (x, y, z), (sx, sy, sz) across, whose index is in `faces`, two triangles each */
function addBox(
    out: Parts,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    rgb: Vec3,
    faces = [0, 1, 2, 3, 4, 5],
): void {
    const half: Vec3 = [sx / 2, sy / 2, sz / 2];
    for (const face of faces) {
        const { n, u, v } = FACES[face];
        const corner = (a: number, b: number): Vec3 => [
            x + (n[0] + u[0] * a + v[0] * b) * half[0],
            y + (n[1] + u[1] * a + v[1] * b) * half[1],
            z + (n[2] + u[2] * a + v[2] * b) * half[2],
        ];
        const quad = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, -1), corner(1, 1), corner(-1, 1)];
        for (const p of quad) {
            out.positions.push(p[0], p[1], p[2]);
            out.normals.push(n[0], n[1], n[2]);
            out.colors.push(rgb[0], rgb[1], rgb[2]);
        }
    }
}

function createBoxesGeometry(out: Parts): Geometry {
    const geometry = new Geometry();
    geometry.setBuffer('position', createVertexBuffer(d.vec3f, new Float32Array(out.positions)));
    geometry.setBuffer('normal', createVertexBuffer(d.vec3f, new Float32Array(out.normals)));
    geometry.setBuffer('color', createVertexBuffer(d.vec3f, new Float32Array(out.colors)));
    geometry.drawRange.count = out.positions.length / 3;
    return geometry;
}

let seed = 7;
function random(): number {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
}

const world: Parts = { positions: [], normals: [], colors: [] };
const GROUND = 200;
const CELL = 4;
for (let x = -GROUND; x < GROUND; x += CELL) {
    for (let z = -GROUND; z < GROUND; z += CELL) {
        addBox(world, x + CELL / 2, -0.5, z + CELL / 2, CELL, 1, CELL, [0.42, 0.55, 0.3], [2]);
    }
}
for (let gx = -GROUND + 4; gx < GROUND; gx += 7) {
    for (let gz = -GROUND + 4; gz < GROUND; gz += 7) {
        if (random() < 0.35) continue;
        const x = gx + (random() - 0.5) * 4;
        const z = gz + (random() - 0.5) * 4;
        // a clearing around the spinning box
        if (Math.hypot(x, z) < 12) continue;
        const height = 2 + random() * 3;
        const crown = 2 + random() * 1.5;
        addBox(world, x, height / 2, z, 0.5, height, 0.5, [0.45, 0.32, 0.2]);
        addBox(world, x, height + crown / 2 - 0.3, z, crown, crown, crown, [0.25, 0.45 + random() * 0.1, 0.22]);
    }
}

const scene = new Scene();
scene.add(camera);

const forest = new Mesh(createBoxesGeometry(world), sceneMaterial);
forest.frustumCulled = false;
scene.add(forest);

const spinnerParts: Parts = { positions: [], normals: [], colors: [] };
addBox(spinnerParts, 0, 0, 0, 1.5, 1.5, 1.5, [0.85, 0.75, 0.6]);
const spinner = new Mesh(createBoxesGeometry(spinnerParts), sceneMaterial);
spinner.position = [0, 1.8, 0];
scene.add(spinner);

scene.updateWorldMatrix();

const casters = [forest, spinner];

// ─── A view of the map ──────────────────────────────────────────────────────

const INSET = 320;
const insetGeometry = createPlaneGeometry(2, 2);
const insetUv = attribute('uv', d.vec2f);
const vMapTexel = varying(insetUv.mul(f32(SHADOW_SIZE)), 'v_mapTexel');
const insetDepth = depthTexture(shadowMap.depthTexture!).load(vec2i(vMapTexel.x.toI32(), vMapTexel.y.toI32()));
const insetMaterial = createMaterial({
    vertex: vec4(position.x, position.y, f32(0), f32(1)),
    fragment: vec4(vec3(f32(1).sub(insetDepth)), f32(1)),
    depthTest: false,
    depthWrite: false,
});
const inset = new Mesh(insetGeometry, insetMaterial);

// ─── Controls ───────────────────────────────────────────────────────────────

const settings = { sunAngle: 40, sunTurn: 30, warp: config.warp, spin: true, showTexels: false, showMap: true };
const gui = new GUI();
gui.add(settings, 'sunAngle', 5, 90, 1).name('sun height');
gui.add(settings, 'sunTurn', 0, 360, 1).name('sun turn');
gui.add(settings, 'warp', 0, 0.95, 0.01);
gui.add(settings, 'spin');
gui.add(settings, 'showTexels').name('show texels');
gui.add(settings, 'showMap').name('show map');

// ─── Loop ───────────────────────────────────────────────────────────────────

let angle = 0;
let previous = performance.now() / 1000;

function update(): void {
    const now = performance.now() / 1000;
    const dt = now - previous;
    previous = now;

    if (settings.spin) angle += dt * 0.6;
    quat.fromEuler(spinner.quaternion, [angle * 0.7, angle, 0, 'yxz'] as Euler);
    spinner.updateWorldMatrix();

    const height = (settings.sunAngle * Math.PI) / 180;
    const turn = (settings.sunTurn * Math.PI) / 180;
    sun[0] = Math.cos(height) * Math.cos(turn);
    sun[1] = Math.sin(height);
    sun[2] = Math.cos(height) * Math.sin(turn);
    sunValue.set(sun);
    sunUniform.value = sunValue;

    controls.update();
    camera.updateWorldMatrix();
    camera.updateViewMatrix();
    config.warp = settings.warp;
    config.debug = settings.showTexels ? 1 : 0;
    fitMap();

    const f = frame(renderer);

    const shadowPass = f.pass({ target: shadowMap, camera: sunCamera, clearDepth: 1, label: 'warped-map' });
    for (const caster of casters) shadowPass.draw(caster, { material: casterMaterial });
    shadowPass.end();

    const scenePass = f.pass({ target: view, camera, label: 'scene' });
    drawScene(renderer, scenePass, scene, camera);
    if (settings.showMap) {
        scenePass.setViewport({ x: 16, y: window.innerHeight - INSET - 16, width: INSET, height: INSET });
        scenePass.draw(inset);
    }
    scenePass.end();

    f.submit();
    requestAnimationFrame(update);
}

requestAnimationFrame(update);
