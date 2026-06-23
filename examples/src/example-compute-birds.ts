import {
    d, createStorageBuffer, storage, Fn, Var, If, Loop, index, globalId, instanceIndex,
    f32, u32, vec3, vec4, mul, floor, clamp, min, max, dot, cross, mix, sin, cos, atan2, pow, length, normalize,
    atomicStore, atomicAdd, atomicLoad, attribute, varying, uniform, Uniform,
    cameraViewMatrix, cameraProjectionMatrix, cameraPosition, Material, Mesh, Scene, PerspectiveCamera,
    WebGPURenderer, OrbitControls, Geometry, createVertexBuffer, createIndexBuffer,
    pass, renderOutput, fxaa, RenderPipeline, unproject, Inspector, type Node,
} from 'gpucat';
import { vec3 as v3 } from 'mathcat';

/*
 * GPU compute bird flocking (boids).
 *
 * A few thousand birds flock with the three classic Reynolds rules — separation
 * (don't crowd neighbours), alignment (match their heading), cohesion (steer
 * toward their centre) — plus a soft spherical boundary that turns them back and
 * a cursor "predator" they swerve away from. The whole flock runs on the GPU in
 * three compute passes per frame, using a uniform spatial-hash grid so each bird
 * only inspects its 27 neighbouring cells instead of every other bird.
 *
 * Each bird is a little winged mesh instanced N times; the vertex stage builds an
 * orientation basis from the bird's velocity (so every bird points where it flies
 * and banks as the flock turns) and flaps the wings about the body axis with a
 * per-bird phase — all on the GPU, no CPU skinning. Faster birds glow warm.
 */

const N = 4096;
const WG = 64;
const R = 3.0;                    // perception radius == spatial-hash cell size
const GRID_MIN = -16;            // world-space corner of the grid
const CELL = R;
const GRID_DIM = Math.ceil((-2 * GRID_MIN) / CELL);
const NUM_CELLS = GRID_DIM * GRID_DIM * GRID_DIM;
const MAX_PER_CELL = 96;          // fixed per-cell capacity (flocks clump, so keep it generous)

// flocking weights — these shape direction; the speed clamp shapes magnitude.
// Strong alignment is what makes the flock stream into murmuration-like lanes.
const SEP_W = 0.5;                // separation: push apart, stronger when closer
const ALI_W = 0.2;                // alignment: match neighbours' heading
const COH_W = 0.025;              // cohesion: drift toward neighbours' centre
const BOUND = 13;                 // soft sphere radius; beyond it, turn back
const BOUND_W = 0.6;
const MIN_SPEED = 3.0;            // birds never stall...
const MAX_SPEED = 6.5;            // ...and never outrun the sim
const DT = 1 / 60;
const SCALE = 0.4;                // bird size
const FLAP_AMP = 0.95;            // wing-beat amplitude (radians, ~54°)
const FLAP_BASE = 13;             // base beat rate
const FLAP_VAR = 9;               // per-bird rate spread, so they don't beat in unison
const FOG_NEAR = 30;              // distance fog: front of the flock stays vivid...
const FOG_FAR = 62;              // ...the back fades into the background, reading as depth
const MOUSE_RADIUS = 8.0;         // cursor predator sphere
const MOUSE_STRENGTH = 5.0;       // how hard birds swerve away

/* storage buffers */

// positions: the canonical buffer. The render reads it, the sim writes it.
const positionData = new Float32Array(N * 4);
const velocityData = new Float32Array(N * 4);
for (let i = 0; i < N; i++) {
    // start as a loose cloud in a sphere, heading in random directions
    const r = Math.random() * 8;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positionData[i * 4 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positionData[i * 4 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positionData[i * 4 + 2] = r * Math.cos(phi);

    const vt = Math.random() * Math.PI * 2;
    const vp = Math.acos(2 * Math.random() - 1);
    const s = 4.5;
    velocityData[i * 4 + 0] = s * Math.sin(vp) * Math.cos(vt);
    velocityData[i * 4 + 1] = s * Math.sin(vp) * Math.sin(vt);
    velocityData[i * 4 + 2] = s * Math.cos(vp);
}
const positions = storage(createStorageBuffer(d.array(d.vec4f), positionData), 'read_write');
const velocities = storage(createStorageBuffer(d.array(d.vec4f), velocityData), 'read_write');

// posPrev / velPrev: per-frame snapshots (written by the bin pass), so the sim
// reads a stable set of neighbour positions and velocities.
const posPrev = storage(createStorageBuffer(d.array(d.vec4f), new Float32Array(N * 4)), 'read_write');
const velPrev = storage(createStorageBuffer(d.array(d.vec4f), new Float32Array(N * 4)), 'read_write');

// grid: per-cell atomic count, and a flat list of bird indices per cell.
const gridCount = storage(createStorageBuffer(d.array(d.atomic(d.u32)), new Uint32Array(NUM_CELLS)), 'read_write');
const gridItems = storage(createStorageBuffer(d.array(d.u32), new Uint32Array(NUM_CELLS * MAX_PER_CELL)), 'read_write');

/* uniforms: the cursor predator sphere, driven by the pointer */

const uMouse = new Uniform(d.vec3f, [0, 0, 0]);
const uMouseActive = new Uniform(d.f32, 0); // 0 or 1
const mouse = uniform(uMouse);
const mouseActive = uniform(uMouseActive);

/* hash a world position to a grid cell index */

const clampCoord = (v: Node<d.f32>) => clamp(floor(v), f32(0), f32(GRID_DIM - 1)).toU32();
const cellOf = (p: Node<d.vec3f>): Node<d.u32> => {
    const l = p.sub(vec3(GRID_MIN, GRID_MIN, GRID_MIN)).mul(f32(1 / CELL));
    return clampCoord(l.z).mul(u32(GRID_DIM * GRID_DIM)).add(clampCoord(l.y).mul(u32(GRID_DIM))).add(clampCoord(l.x));
};

/* pass 1: clear the grid counts */
const clearGrid = Fn(() => {
    const c = globalId.x;
    If(c.lessThan(u32(NUM_CELLS)), () => {
        atomicStore(index(gridCount, c), u32(0));
    });
}).compute({ workgroupSize: [WG, 1, 1] });

/* pass 2: snapshot each bird's pos/vel into the prev buffers, then bin it.
 * This pass already visits every bird, so it stashes the snapshot for free
 * instead of paying for a separate copy dispatch. */
const bin = Fn(() => {
    const i = globalId.x;
    If(i.lessThan(u32(N)), () => {
        const p = Var('p', index(positions, i));
        index(posPrev, i).assign(p);
        index(velPrev, i).assign(index(velocities, i));
        const cell = cellOf(p.xyz);
        const slot = Var('slot', atomicAdd(index(gridCount, cell), u32(1)));
        If(slot.lessThan(u32(MAX_PER_CELL)), () => {
            index(gridItems, cell.mul(u32(MAX_PER_CELL)).add(slot)).assign(i);
        });
    });
}).compute({ workgroupSize: [WG, 1, 1] });

/* pass 3: apply the flocking rules over neighbours, then integrate */
const simulate = Fn(() => {
    const i = globalId.x;
    If(i.lessThan(u32(N)), () => {
        const selfP = Var('selfP', index(posPrev, i).xyz);
        const selfV = Var('selfV', index(velPrev, i).xyz);

        const sep = Var('sep', vec3(0, 0, 0));      // push away from close neighbours
        const aliSum = Var('aliSum', vec3(0, 0, 0)); // sum of neighbour velocities
        const cohSum = Var('cohSum', vec3(0, 0, 0)); // sum of neighbour positions
        const count = Var('count', f32(0));

        // gather neighbours from the 27 surrounding cells
        Loop(3, ({ i: a }) => {
            Loop(3, ({ i: b }) => {
                Loop(3, ({ i: c }) => {
                    const offset = vec3(a.toF32().sub(f32(1)), b.toF32().sub(f32(1)), c.toF32().sub(f32(1))).mul(f32(CELL));
                    const ncell = cellOf(selfP.add(offset));
                    const cnt = Var('cnt', min(atomicLoad(index(gridCount, ncell)), u32(MAX_PER_CELL)).toU32());
                    Loop(MAX_PER_CELL, ({ i: s }) => {
                        const su = s.toU32();
                        If(su.lessThan(cnt), () => {
                            const j = Var('j', index(gridItems, ncell.mul(u32(MAX_PER_CELL)).add(su)));
                            If(j.notEqual(i), () => {
                                const jp = Var('jp', index(posPrev, j).xyz);
                                const delta = selfP.sub(jp);
                                const dist = Var('dist', length(delta));
                                If(dist.greaterThan(f32(1e-4)), () => {
                                    If(dist.lessThan(f32(R)), () => {
                                        // separation: away from the neighbour, stronger when closer
                                        sep.addAssign(normalize(delta).mul(f32(R).sub(dist).div(f32(R))));
                                        aliSum.addAssign(index(velPrev, j).xyz);
                                        cohSum.addAssign(jp);
                                        count.addAssign(f32(1));
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });

        // start from current velocity, then blend in the steering rules
        const vel = Var('vel', selfV.add(sep.mul(f32(SEP_W))));
        If(count.greaterThan(f32(0)), () => {
            const aliAvg = aliSum.div(count);
            vel.addAssign(aliAvg.sub(selfV).mul(f32(ALI_W)));      // alignment
            const cohAvg = cohSum.div(count);
            vel.addAssign(cohAvg.sub(selfP).mul(f32(COH_W)));      // cohesion
        });

        // soft spherical boundary: turn back when straying past the radius
        const distC = Var('distC', length(selfP));
        If(distC.greaterThan(f32(BOUND)), () => {
            vel.subAssign(normalize(selfP).mul(distC.sub(f32(BOUND)).mul(f32(BOUND_W))));
        });

        // cursor predator: swerve away from the sphere on the cursor ray
        const md = Var('md', selfP.sub(mouse));
        const mdist = Var('mdist', length(md));
        If(mdist.greaterThan(f32(1e-4)), () => {
            If(mdist.lessThan(f32(MOUSE_RADIUS)), () => {
                vel.addAssign(normalize(md).mul(f32(MOUSE_RADIUS).sub(mdist).mul(f32(MOUSE_STRENGTH)).mul(mouseActive)));
            });
        });

        // clamp the speed so birds never stall or outrun the sim, then integrate
        const speed = Var('speed', length(vel));
        If(speed.greaterThan(f32(1e-4)), () => {
            vel.assign(normalize(vel).mul(clamp(speed, f32(MIN_SPEED), f32(MAX_SPEED))));
        });
        index(velocities, i).assign(vec4(vel, f32(0)));
        index(positions, i).assign(vec4(selfP.add(vel.mul(f32(DT))), f32(0)));
    });
}).compute({ workgroupSize: [WG, 1, 1] });

/* material: instanced birds, wings flapping, each oriented along its velocity */

const localPos = attribute('position', d.vec3f);
const normal = attribute('normal', d.vec3f);
const wing = attribute('wing', d.f32); // +1 left wing, -1 right wing, 0 body
const time = uniform(f32(0), 'time'); // seconds, wired from the frame loop
const birdPos = index(positions, instanceIndex).xyz;
const birdVel = index(velocities, instanceIndex).xyz;

// wing-beat: each bird gets its own constant rate + phase from its index, so the
// flock shimmers instead of beating in lockstep. The flap rotates the wing about
// the body's forward (z) axis; the shoulder sits at x=0, so it acts as the hinge.
const seed = instanceIndex.toF32();
const phase = seed.mul(f32(0.61803)).fract().mul(f32(6.2831853));
const rate = f32(FLAP_BASE).add(seed.mul(f32(0.327)).fract().mul(f32(FLAP_VAR)));
const beat = sin(time.mul(rate).add(phase)).mul(f32(FLAP_AMP)).mul(wing);
const cb = cos(beat);
const sb = sin(beat);
const flapPos = vec3(localPos.x.mul(cb).sub(localPos.y.mul(sb)), localPos.x.mul(sb).add(localPos.y.mul(cb)), localPos.z);
const flapNormal = vec3(normal.x.mul(cb).sub(normal.y.mul(sb)), normal.x.mul(sb).add(normal.y.mul(cb)), normal.z);

// build an orientation basis from the velocity: the bird's +Z is "forward"
const fwd = normalize(birdVel);
const right = normalize(cross(vec3(0, 1, 0), fwd));
const up = cross(fwd, right);

const sp = flapPos.mul(f32(SCALE));
const rotated = right.mul(sp.x).add(up.mul(sp.y)).add(fwd.mul(sp.z));
const worldPosV = rotated.add(birdPos);
const worldPos = vec4(worldPosV, f32(1));
const clipPos = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPos));

// rotate the (already-flapped) normal by the same basis so lighting follows the bird
const rotNormal = right.mul(flapNormal.x).add(up.mul(flapNormal.y)).add(fwd.mul(flapNormal.z));
const vNormal = varying(rotNormal, 'vNormal');
const vWorldPos = varying(worldPosV, 'vWorldPos');
const vHeading = varying(fwd, 'vHeading');                 // travel direction, drives the hue
const vSpeed = varying(length(birdVel), 'vSpeed');

// hue from heading: birds flowing the same way share a colour, so the flocking
// lanes read as flowing bands. A cosine palette keeps the ramp smooth and rich.
const hue = atan2(vHeading.z, vHeading.x).mul(f32(0.1591549)).add(f32(0.5)); // 0..1 around the azimuth
const speedT = clamp(vSpeed.sub(f32(MIN_SPEED)).div(f32(MAX_SPEED - MIN_SPEED)), f32(0), f32(1));
const palT = hue.add(speedT.mul(f32(0.08)));
const palB = vec3(0.5, 0.42, 0.4);
const palD = vec3(0.5, 0.78, 0.92);
const baseColor = vec3(0.55, 0.5, 0.55).add(palB.mul(cos(vec3(1, 1, 1).mul(palT).add(palD).mul(f32(6.2831853)))));

// lighting: a coloured hemisphere (cool sky above, warm ground below) plus one
// soft directional key, and a fresnel rim so each bird carries a faint halo.
const nrm = normalize(vNormal);
const lightDir = normalize(vec3(0.35, 0.85, 0.4));
const diff = max(dot(nrm, lightDir), f32(0));
const hemi = mix(vec3(0.22, 0.2, 0.28), vec3(0.7, 0.82, 1.0), nrm.y.mul(f32(0.5)).add(f32(0.5)));
const direct = vec3(1.0, 0.96, 0.88).mul(diff.mul(f32(0.85)));
const shaded = baseColor.mul(hemi.add(direct));
const toCam = cameraPosition.sub(vWorldPos);
const dist = length(toCam);
const viewDir = normalize(toCam);
const rim = pow(f32(1).sub(max(dot(nrm, viewDir), f32(0))), f32(2.5));
const rimColor = vec3(0.45, 0.65, 1.0).mul(rim.mul(f32(0.55)));
const lit = shaded.add(rimColor);
// distance fog gives atmospheric perspective: far birds recede into the backdrop
const fog = clamp(dist.sub(f32(FOG_NEAR)).div(f32(FOG_FAR - FOG_NEAR)), f32(0), f32(1));
const fragColor = vec4(mix(lit, vec3(0.03, 0.04, 0.08), fog), f32(1));

const material = new Material({ vertex: clipPos, fragment: fragColor, cullMode: 'none' });

/* a little low-poly bird: a slim body in the vertical plane plus two horizontal
 * wings, nose pointing +Z. Each vertex carries a `wing` sign (+1 left, -1 right,
 * 0 body); the vertex stage hinges the wings about the body axis to flap them. */

function createBirdGeometry() {
    const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const crossV = (a: number[], b: number[]) => [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
    const norm = (a: number[]) => {
        const l = Math.hypot(a[0], a[1], a[2]) || 1;
        return [a[0] / l, a[1] / l, a[2] / l];
    };

    // body verts (vertical plane, x=0)
    const N = [0, 0, 0.95];   // nose
    const T = [0, 0, -0.75];  // tail
    const Tp = [0, 0.14, -0.25]; // back ridge
    const Bt = [0, -0.06, -0.2]; // belly
    // wing verts: shoulders sit on the body axis (x=0) so they act as the hinge
    const Sf = [0, 0, 0.25];   // shoulder, front
    const Sb = [0, 0, -0.45];  // shoulder, back
    const L = [-1.15, 0, -0.55]; // left wing tip (swept back)
    const Rt = [1.15, 0, -0.55]; // right wing tip

    const pos: number[] = [];
    const nrm: number[] = [];
    const wng: number[] = [];
    const tri = (a: number[], b: number[], c: number[], wingSign: number, forceN?: number[]) => {
        const n = forceN ?? norm(crossV(sub(b, a), sub(c, a)));
        for (const v of [a, b, c]) {
            pos.push(v[0], v[1], v[2]);
            nrm.push(n[0], n[1], n[2]);
            wng.push(wingSign);
        }
    };

    // body: two triangles forming a thin vertical fuselage (flat normals)
    tri(N, Tp, T, 0);
    tri(N, T, Bt, 0);
    // wings: lie flat (normal up so the top catches light); the flap rotates them
    tri(Sf, Sb, L, 1, [0, 1, 0]);  // left wing
    tri(Sf, Sb, Rt, -1, [0, 1, 0]); // right wing

    const geom = new Geometry();
    geom.setBuffer('position', createVertexBuffer(d.vec3f, new Float32Array(pos)));
    geom.setBuffer('normal', createVertexBuffer(d.vec3f, new Float32Array(nrm)));
    geom.setBuffer('wing', createVertexBuffer(d.f32, new Float32Array(wng)));
    const idx = new Uint16Array(pos.length / 3);
    for (let i = 0; i < idx.length; i++) idx[i] = i;
    geom.index = createIndexBuffer(idx);
    return geom;
}

/* renderer + scene */

const renderer = new WebGPURenderer({ antialias: true });
const inspector = new Inspector();
renderer.inspector = inspector;
await renderer.init();
document.body.appendChild(renderer.domElement);
document.body.appendChild(inspector.domElement);
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.clearColor = [0.03, 0.04, 0.08, 1];

const scene = new Scene();
const camera = new PerspectiveCamera(Math.PI / 4, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position[2] = 42;
scene.add(camera);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const mesh = new Mesh(createBirdGeometry(), material);
mesh.count = N;
mesh.frustumCulled = false;
scene.add(mesh);

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

/* pointer: a predator sphere placed on the cursor ray, at the flock's depth */

let mouseOver = false;
const ndcX = { v: 0 };
const ndcY = { v: 0 };
const near: [number, number, number] = [0, 0, 0];
const far: [number, number, number] = [0, 0, 0];
const dir: [number, number, number] = [0, 0, 0];
const mouseWorld: [number, number, number] = [0, 0, 0];

renderer.domElement.addEventListener('pointermove', (e) => {
    const rect = renderer.domElement.getBoundingClientRect();
    ndcX.v = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndcY.v = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    mouseOver = true;
});
renderer.domElement.addEventListener('pointerleave', () => { mouseOver = false; });

function updateMouse() {
    if (!mouseOver) {
        uMouseActive.value = 0;
        return;
    }
    // build the cursor ray and take the point on it closest to the origin,
    // so the predator sphere sits at the flock's depth
    unproject(near, [ndcX.v, ndcY.v, 0], camera);
    unproject(far, [ndcX.v, ndcY.v, 1], camera);
    v3.subtract(dir, far, near);
    v3.normalize(dir, dir);
    const tt = -v3.dot(near, dir);
    v3.scaleAndAdd(mouseWorld, near, dir, tt);
    uMouse.value = mouseWorld;
    uMouseActive.value = 1;
}

/* pre-warm pipelines, then run */

await renderer.compileCompute(clearGrid);
await renderer.compileCompute(bin);
await renderer.compileCompute(simulate);

const scenePass = pass(scene, camera);
// anti-alias the rendered scene (FXAA needs the texture), then tone-map + sRGB
const renderPipeline = new RenderPipeline(renderer, renderOutput(fxaa(scenePass.getTextureNode())));

const dispatchN = Math.ceil(N / WG);
const dispatchCells = Math.ceil(NUM_CELLS / WG);

function frame() {
    controls.update();
    scene.updateWorldMatrix();
    camera.updateViewMatrix();
    updateMouse();
    time.value = performance.now() / 1000;

    renderer.compute([
        { node: clearGrid, dispatch: [dispatchCells, 1, 1] },
        { node: bin, dispatch: [dispatchN, 1, 1] },
        { node: simulate, dispatch: [dispatchN, 1, 1] },
    ]);
    renderPipeline.render();

    requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
