import {
    d, createStorageBuffer, storage, Fn, Var, If, Loop, index, globalId, instanceIndex,
    f32, u32, vec3, vec4, mul, floor, clamp, min, max, dot, length, normalize, select,
    atomicStore, atomicAdd, atomicLoad, attribute, varying, uniform, Uniform,
    cameraViewMatrix, cameraProjectionMatrix, Material, Mesh, Scene, PerspectiveCamera,
    WebGPURenderer, OrbitControls, createSphereGeometry, pass, renderOutput, RenderPipeline,
    unproject, Inspector, type Node,
} from 'gpucat';
import { vec3 as v3 } from 'mathcat';

/*
 * GPU compute ball cluster.
 *
 * A few thousand balls hold together as a cluster (a gentle pull toward the
 * origin) and collide with each other so they never interpenetrate. The mouse
 * is a repulsion sphere that shoves balls out of the way. The whole thing runs
 * on the GPU in four compute passes per frame, using a uniform spatial-hash grid
 * so each ball only checks its 27 neighbouring cells, not every other ball.
 *
 * Contacts use a DEM (spring-dashpot) model: a normal spring pushes overlapping
 * balls apart, a normal dashpot gives restitution (bounce), and a tangential
 * dashpot gives friction. This needs neighbour velocities, so velocities are
 * snapshotted alongside positions each frame.
 */

const N = 500;
const WG = 64;
const BALL_RADIUS = 0.5;
const CELL = 2 * BALL_RADIUS;     // a ball only touches balls in adjacent cells
const GRID_MIN = -16;             // world-space corner of the grid
const GRID_DIM = Math.ceil((-2 * GRID_MIN) / CELL); // cells per axis
const NUM_CELLS = GRID_DIM * GRID_DIM * GRID_DIM;
const MAX_PER_CELL = 24;          // fixed per-cell capacity (overflow is dropped)
// DEM (spring-dashpot) contact coefficients. Tune these for feel.
const KN = 120;                   // normal stiffness: push out of overlaps
const GN = 8;                     // normal damping: lower = bouncier (restitution)
const GT = 3;                     // tangential damping: higher = more friction / grip
const COHESION = 1.2;             // gentle pull toward the origin, holds the cluster
const GLOBAL_DAMP = 0.99;         // light air drag
const MOUSE_RADIUS = 3.5;         // cursor repulsion sphere
const MOUSE_STRENGTH = 25;        // how hard the cursor shoves balls
const DT = 1 / 60;

/* storage buffers */

// positions: the canonical buffer. The render reads it, the sim writes it.
const positionData = new Float32Array(N * 4);
for (let i = 0; i < N; i++) {
    // start as a loose cloud in a sphere shell; w holds the radius
    const r = 6 + Math.random() * 5;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positionData[i * 4 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positionData[i * 4 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positionData[i * 4 + 2] = r * Math.cos(phi);
    positionData[i * 4 + 3] = BALL_RADIUS;
}
const positions = storage(createStorageBuffer(d.array(d.vec4f), positionData), 'read_write');

// posPrev / velPrev: per-frame snapshots, so a contact reads a stable set of
// neighbour positions and velocities.
const posPrev = storage(createStorageBuffer(d.array(d.vec4f), new Float32Array(N * 4)), 'read_write');
const velPrev = storage(createStorageBuffer(d.array(d.vec4f), new Float32Array(N * 4)), 'read_write');
const velocities = storage(createStorageBuffer(d.array(d.vec4f), new Float32Array(N * 4)), 'read_write');

// grid: per-cell atomic count, and a flat list of particle indices per cell.
const gridCount = storage(createStorageBuffer(d.array(d.atomic(d.u32)), new Uint32Array(NUM_CELLS)), 'read_write');
const gridItems = storage(createStorageBuffer(d.array(d.u32), new Uint32Array(NUM_CELLS * MAX_PER_CELL)), 'read_write');

/* uniforms: the cursor repulsion sphere, driven by the pointer */

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

/* pass 1: snapshot positions and velocities */
const snapshot = Fn(() => {
    const i = globalId.x;
    If(i.lessThan(u32(N)), () => {
        index(posPrev, i).assign(index(positions, i));
        index(velPrev, i).assign(index(velocities, i));
    });
}).compute({ workgroupSize: [WG, 1, 1] });

/* pass 2: clear the grid counts */
const clearGrid = Fn(() => {
    const c = globalId.x;
    If(c.lessThan(u32(NUM_CELLS)), () => {
        atomicStore(index(gridCount, c), u32(0));
    });
}).compute({ workgroupSize: [WG, 1, 1] });

/* pass 3: bin each ball into its cell */
const bin = Fn(() => {
    const i = globalId.x;
    If(i.lessThan(u32(N)), () => {
        const cell = cellOf(index(posPrev, i).xyz);
        const slot = Var('slot', atomicAdd(index(gridCount, cell), u32(1)));
        If(slot.lessThan(u32(MAX_PER_CELL)), () => {
            index(gridItems, cell.mul(u32(MAX_PER_CELL)).add(slot)).assign(i);
        });
    });
}).compute({ workgroupSize: [WG, 1, 1] });

/* pass 4: sum forces (cohesion + DEM contacts + cursor), then integrate */
const simulate = Fn(() => {
    const i = globalId.x;
    If(i.lessThan(u32(N)), () => {
        const selfP = Var('selfP', index(posPrev, i).xyz);
        const selfV = Var('selfV', index(velPrev, i).xyz);

        // cohesion: a gentle pull toward the origin holds the cluster
        const force = Var('force', selfP.mul(f32(-COHESION)));

        // DEM contacts against neighbours in the 27 surrounding cells
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
                                const delta = selfP.sub(index(posPrev, j).xyz);
                                const dist = Var('dist', length(delta));
                                If(dist.greaterThan(f32(1e-4)), () => {
                                    If(dist.lessThan(f32(2 * BALL_RADIUS)), () => {
                                        const n = Var('n', normalize(delta));            // contact normal
                                        const overlap = f32(2 * BALL_RADIUS).sub(dist);
                                        const vRel = Var('vRel', selfV.sub(index(velPrev, j).xyz));
                                        const vn = Var('vn', dot(vRel, n));               // normal relative speed
                                        // normal spring + dashpot (restitution)
                                        force.addAssign(n.mul(f32(KN).mul(overlap).sub(f32(GN).mul(vn))));
                                        // tangential dashpot (friction)
                                        force.subAssign(vRel.sub(n.mul(vn)).mul(f32(GT)));
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });

        // cursor: a repulsion force that shoves balls out of the sphere
        const md = Var('md', selfP.sub(mouse));
        const mdist = Var('mdist', length(md));
        If(mdist.greaterThan(f32(1e-4)), () => {
            If(mdist.lessThan(f32(MOUSE_RADIUS)), () => {
                force.addAssign(normalize(md).mul(f32(MOUSE_RADIUS).sub(mdist).mul(f32(MOUSE_STRENGTH)).mul(mouseActive)));
            });
        });

        // integrate (mass = 1), with a little global drag
        const vel = Var('vel', selfV.add(force.mul(f32(DT))).mul(f32(GLOBAL_DAMP)));
        const pos = Var('pos', selfP.add(vel.mul(f32(DT))));
        index(velocities, i).assign(vec4(vel, f32(0)));
        index(positions, i).assign(vec4(pos, f32(BALL_RADIUS)));
    });
}).compute({ workgroupSize: [WG, 1, 1] });

/* material: instanced spheres offset by their particle position */

const localPos = attribute('position', d.vec3f);
const normal = attribute('normal', d.vec3f);
const ballCenter = index(positions, instanceIndex).xyz;
const worldPos = vec4(localPos.add(ballCenter), f32(1));
const clipPos = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPos));

const idx3 = instanceIndex.mod(u32(3));
const baseColor = select(
    select(vec3(1.0, 0.55, 0.15), vec3(1.0, 0.25, 0.6), idx3.equal(u32(1))),
    vec3(0.9, 0.92, 1.0),
    idx3.equal(u32(2)),
);
const vColor = varying(baseColor, 'vColor');
const vNormal = varying(normal, 'vNormal');

const lightDir = normalize(vec3(0.4, 0.8, 0.45));
const diff = max(dot(normalize(vNormal), lightDir), f32(0));
const fragColor = vec4(vColor.mul(diff.mul(f32(0.75)).add(f32(0.25))), f32(1));

const material = new Material({ vertex: clipPos, fragment: fragColor });

/* renderer + scene */

const renderer = new WebGPURenderer({ antialias: true });
const inspector = new Inspector();
renderer.inspector = inspector;
await renderer.init();
document.body.appendChild(renderer.domElement);
document.body.appendChild(inspector.domElement);
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.clearColor = [0.04, 0.04, 0.06, 1];

const scene = new Scene();
const camera = new PerspectiveCamera(Math.PI / 4, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position[2] = 22;
scene.add(camera);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const mesh = new Mesh(createSphereGeometry(BALL_RADIUS, 12, 8), material);
mesh.count = N;
mesh.frustumCulled = false;
scene.add(mesh);

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

/* pointer: a repulsion sphere placed on the cursor ray, at the cluster's depth */

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
    // so the repulsion sphere sits at the cluster's depth
    unproject(near, [ndcX.v, ndcY.v, 0], camera);
    unproject(far, [ndcX.v, ndcY.v, 1], camera);
    v3.subtract(dir, far, near);
    v3.normalize(dir, dir);
    const t = -v3.dot(near, dir);
    v3.scaleAndAdd(mouseWorld, near, dir, t);
    uMouse.value = mouseWorld;
    uMouseActive.value = 1;
}

/* pre-warm pipelines, then run */

await renderer.compileCompute(snapshot);
await renderer.compileCompute(clearGrid);
await renderer.compileCompute(bin);
await renderer.compileCompute(simulate);

const scenePass = pass(scene, camera);
const renderPipeline = new RenderPipeline(renderer, renderOutput(scenePass.getTextureNode()));

const dispatchN = Math.ceil(N / WG);
const dispatchCells = Math.ceil(NUM_CELLS / WG);

function frame() {
    controls.update();
    scene.updateWorldMatrix();
    camera.updateViewMatrix();
    updateMouse();

    renderer.compute([
        { node: snapshot, dispatch: [dispatchN, 1, 1] },
        { node: clearGrid, dispatch: [dispatchCells, 1, 1] },
        { node: bin, dispatch: [dispatchN, 1, 1] },
        { node: simulate, dispatch: [dispatchN, 1, 1] },
    ]);
    renderPipeline.render();

    requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
