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
    u32,
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

// Cascaded shadow maps for a sun: the camera's view out to REACH split into CASCADES slices, near ones short and
// fine, far ones long and coarse, each shadowed by its own orthographic view down the sun. The cascades are the four
// quadrants of one depth target, drawn in one pass, and every lit fragment looks itself up in the cascade its view
// depth falls in.

const CASCADES = 4;
const SHADOW_SIZE = 2048;
const CASCADE_SIZE = SHADOW_SIZE / 2;
/** how far the cascades reach from the camera, in world units */
const REACH = 160;
/** how the splits lean between even (0) and logarithmic (1) */
const SPLIT_LAMBDA = 0.8;
const SPLIT_NEAR = 0.1;
/** how far behind a cascade's slice a caster can stand and still shadow into it */
const PULLBACK = 96;
/** the share of a cascade's range, at its far end, over which it blends into the next */
const CASCADE_BLEND = 0.1;
/** the share of the reach over which the shadows fade out, rather than stop */
const FADE = 0.15;
/** how far along its normal a surface is looked up, in its cascade's texels */
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

// ─── The cascades ───────────────────────────────────────────────────────────

const shadowMap = createRenderTarget(SHADOW_SIZE, SHADOW_SIZE, {
    depthFormat: 'depth24plus',
    count: 0,
    depthSampled: true,
});

/** each cascade's view-projection, the view depth it reaches to, and the world size of its texels */
const CascadeConfig = struct('CascadeConfig', {
    matrices: d.sizedArray(d.mat4x4f, CASCADES),
    splits: d.vec4f,
    texels: d.vec4f,
    debug: d.f32,
});

const config = {
    matrices: Array.from({ length: CASCADES }, () => mat4.create()),
    splits: [0, 0, 0, 0] as [number, number, number, number],
    texels: [1, 1, 1, 1] as [number, number, number, number],
    debug: 0,
};
const configUniform = new Uniform(CascadeConfig, config);
const cfg = uniform(configUniform);

const cascadeCameras = Array.from({ length: CASCADES }, () => new OrthographicCamera(-1, 1, 1, -1, 0, 1));

const sun: Vec3 = [0, 1, 0];
const right: Vec3 = [1, 0, 0];
const up: Vec3 = [0, 1, 0];
const centre: Vec3 = [0, 0, 0];

function fitCascades(): void {
    const tanY = Math.tan(camera.fov / 2);
    const tanX = tanY * camera.aspect;
    const slope = tanX * tanX + tanY * tanY;
    let near = SPLIT_NEAR;
    for (let i = 0; i < CASCADES; i++) {
        // between an even and a logarithmic split
        const t = (i + 1) / CASCADES;
        const far =
            SPLIT_LAMBDA * SPLIT_NEAR * (REACH / SPLIT_NEAR) ** t + (1 - SPLIT_LAMBDA) * (SPLIT_NEAR + (REACH - SPLIT_NEAR) * t);
        fitCascade(i, near, far, slope);
        config.splits[i] = far;
        near = far;
    }
    configUniform.value = config;
}

/**
 * Cascade `index` over the view from `near` to `far`: the sphere bounding that slice of the frustum. It depends on the
 * distances and the field of view alone, so turning the camera never resizes it, and its centre snaps to whole texels
 * across the sun's view, so the texels stay put on the world as the camera moves and shadow edges don't crawl.
 */
function fitCascade(index: number, near: number, far: number, slope: number): void {
    // the point along the view axis nearest every corner of the slice, and its distance to the farthest
    const along = Math.min(far, ((near + far) / 2) * (1 + slope));
    const radius = Math.ceil(
        Math.max(Math.hypot(along - near, near * Math.sqrt(slope)), Math.hypot(far - along, far * Math.sqrt(slope))),
    );
    const m = camera.matrixWorld;
    centre[0] = m[12] - m[8] * along;
    centre[1] = m[13] - m[9] * along;
    centre[2] = m[14] - m[10] * along;
    const texel = (2 * radius) / CASCADE_SIZE;
    config.texels[index] = texel;

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
    const shiftAcross = Math.floor(across / texel) * texel - across;
    const shiftUp = Math.floor(upward / texel) * texel - upward;
    for (let a = 0; a < 3; a++) centre[a] += right[a] * shiftAcross + up[a] * shiftUp;

    const cascade = cascadeCameras[index];
    cascade.coordinateSystem = camera.coordinateSystem;
    cascade.left = -radius;
    cascade.right = radius;
    cascade.top = radius;
    cascade.bottom = -radius;
    cascade.near = 0;
    cascade.far = 2 * radius + PULLBACK;
    cascade.updateProjectionMatrix();
    const back = radius + PULLBACK;
    cascade.position = [centre[0] + sun[0] * back, centre[1] + sun[1] * back, centre[2] + sun[2] * back];
    cascade.lookAt([centre[0], centre[1], centre[2]], up);
    cascade.updateWorldMatrix();
    cascade.updateViewMatrix();
    mat4.multiply(config.matrices[index], cascade.projectionMatrix, cascade.matrixWorldInverse);
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

// ─── Materials ──────────────────────────────────────────────────────────────

const position = attribute('position', d.vec3f);
const normal = attribute('normal', d.vec3f);
const color = attribute('color', d.vec3f);

const worldPos = mul(modelWorldMatrix, vec4(position, f32(1)));
const viewPos = mul(cameraViewMatrix, worldPos);
const clipPos = mul(cameraProjectionMatrix, viewPos);

// drawn into each cascade from the pass's camera, biased so a lit surface doesn't shadow itself
const casterMaterial = createMaterial({ vertex: clipPos, fragment: undefined, depthBias: 2, depthBiasSlopeScale: 2 });

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

const splits = cfg.field('splits');
const texels = cfg.field('texels');

function pick(values: Node<d.vec4f>, index: Node<d.u32>): Node<d.f32> {
    return select(
        select(select(values.w, values.z, index.equal(u32(2))), values.y, index.equal(u32(1))),
        values.x,
        index.equal(u32(0)),
    );
}

/** lit (1) to shadowed (0) by cascade `index`, four filtered compares within its quadrant: a 3 x 3 soft edge */
function cascadeLookup(index: Node<d.u32>, name: string): Node<d.f32> {
    const at = vWorldPos.add(vNormal.mul(pick(texels, index).mul(f32(NORMAL_TEXELS))));
    const clip = mul(cfg.field('matrices').element(index), vec4(at, f32(1))).toVar(`${name}Clip`);
    const uv = vec2(clip.x.mul(f32(0.5)).add(f32(0.5)), f32(0.5).sub(clip.y.mul(f32(0.5)))).toVar(`${name}Uv`);
    const quadrant = vec2(index.mod(u32(2)).toF32(), index.div(u32(2)).toF32())
        .mul(f32(0.5))
        .toVar(`${name}Quadrant`);
    const mapUv = quadrant.add(uv.mul(f32(0.5))).toVar(`${name}MapUv`);
    // the taps stay in the quadrant, never reading a neighbour's
    const low = quadrant.add(f32(HALF_TEXEL * 2));
    const high = quadrant.add(f32(0.5 - HALF_TEXEL * 2));
    const reference = ndcDepthToStorage(clip.z).toVar(`${name}Reference`);
    const tap = (dx: number, dy: number) =>
        textureSampleCompareLevel(
            shadowDepth,
            shadowSampler,
            clamp(mapUv.add(vec2(f32(dx * HALF_TEXEL), f32(dy * HALF_TEXEL))), low, high),
            reference,
        );
    const shadowed = tap(-1, -1).add(tap(1, -1)).add(tap(-1, 1)).add(tap(1, 1)).mul(f32(0.25));
    const inside = uv.x
        .greaterThanEqual(f32(0))
        .and(uv.x.lessThanEqual(f32(1)))
        .and(uv.y.greaterThanEqual(f32(0)))
        .and(uv.y.lessThanEqual(f32(1)));
    return select(f32(1), shadowed, inside);
}

// the cascade the view depth falls in, and the one after it
const cascade = select(
    select(select(u32(3), u32(2), vDepth.lessThan(splits.z)), u32(1), vDepth.lessThan(splits.y)),
    u32(0),
    vDepth.lessThan(splits.x),
).toVar('cascade');
const nextCascade = select(cascade.add(u32(1)), u32(3), cascade.equal(u32(3))).toVar('nextCascade');

// across the last CASCADE_BLEND of a cascade's range, mixed toward the next one's, so the change of texel size has no
// edge; the last cascade fades out toward the reach instead
const far = pick(splits, cascade);
const near = select(pick(splits, cascade.sub(u32(1))), f32(0), cascade.equal(u32(0)));
const band = far.sub(near).mul(f32(CASCADE_BLEND)).toVar('band');
const toNext = select(
    f32(0),
    clamp(vDepth.sub(far.sub(band)).div(band), f32(0), f32(1)),
    cascade.lessThan(u32(CASCADES - 1)),
).toVar('toNext');
const shadowed = mix(cascadeLookup(cascade, 'here'), cascadeLookup(nextCascade, 'next'), toNext);
const fade = smoothstep(f32(REACH * (1 - FADE)), f32(REACH), vDepth);
const lit = select(mix(shadowed, f32(1), fade), f32(1), vDepth.greaterThanEqual(f32(REACH)));

const facing = vNormal.dot(sunDirection).max(f32(0));
const debugTint = select(
    select(
        select(vec3(f32(1), f32(0.4), f32(1)), vec3(f32(0.4), f32(0.6), f32(1)), cascade.equal(u32(2))),
        vec3(f32(0.4), f32(1), f32(0.4)),
        cascade.equal(u32(1)),
    ),
    vec3(f32(1), f32(0.4), f32(0.4)),
    cascade.equal(u32(0)),
);
const base = mix(vColor, vColor.mul(debugTint), cfg.field('debug'));
const sky = vec3(f32(0.32), f32(0.36), f32(0.45));
const sunlight = vec3(f32(1.1), f32(1), f32(0.85));
const shaded = base.mul(sky.add(sunlight.mul(facing.mul(lit))));

const sceneMaterial = createMaterial({ vertex: clipPos, fragment: vec4(shaded, f32(1)) });

// ─── The world: a forest of box trees on a ground ──────────────────────────

const positions: number[] = [];
const normals: number[] = [];
const colors: number[] = [];

const FACES: { n: Vec3; u: Vec3; v: Vec3 }[] = [
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

/** a box centred at (x, y, z), (sx, sy, sz) across, as 12 triangles */
function addBox(
    out: { positions: number[]; normals: number[]; colors: number[] },
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    rgb: Vec3,
): void {
    const half: Vec3 = [sx / 2, sy / 2, sz / 2];
    for (const { n, u, v } of FACES) {
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

function createBoxesGeometry(out: { positions: number[]; normals: number[]; colors: number[] }): Geometry {
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

const world = { positions, normals, colors };
const GROUND = 200;
addBox(world, 0, -0.5, 0, GROUND * 2, 1, GROUND * 2, [0.42, 0.55, 0.3]);
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

const spinnerParts = { positions: [] as number[], normals: [] as number[], colors: [] as number[] };
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

const settings = { sunAngle: 40, sunTurn: 30, spin: true, showCascades: false, showMap: true };
const gui = new GUI();
gui.add(settings, 'sunAngle', 5, 90, 1).name('sun height');
gui.add(settings, 'sunTurn', 0, 360, 1).name('sun turn');
gui.add(settings, 'spin');
gui.add(settings, 'showCascades').name('show cascades');
gui.add(settings, 'showMap').name('show map');

// ─── Loop ───────────────────────────────────────────────────────────────────

const mapRect = { x: 0, y: 0, width: CASCADE_SIZE, height: CASCADE_SIZE };
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
    config.debug = settings.showCascades ? 1 : 0;
    fitCascades();

    const f = frame(renderer);

    const shadowPass = f.pass({ target: shadowMap, clearDepth: 1, label: 'cascades' });
    for (let i = 0; i < CASCADES; i++) {
        mapRect.x = (i % 2) * CASCADE_SIZE;
        mapRect.y = Math.floor(i / 2) * CASCADE_SIZE;
        shadowPass.setCamera(cascadeCameras[i]);
        // triangles clip to the viewport, so each cascade stays in its quadrant
        shadowPass.setViewport(mapRect);
        for (const caster of casters) shadowPass.draw(caster, { material: casterMaterial });
    }
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
