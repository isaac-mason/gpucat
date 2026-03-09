import {
    d, struct, instancedArray, instanceIndex, uniform, index,
    f32, i32, u32, vec3f, vec3i, vec4,
    array, mat3,
    clamp, max, pow, step,
    atomicAdd, atomicStore, atomicLoad,
    Loop, If, Return, Fn,
    attribute, varying,
    cameraViewMatrix, cameraProjectionMatrix, mul,
    Material, WebGPURenderer, Inspector, Scene, PerspectiveCamera,
    Geometry, BufferAttribute, IndexAttribute, Mesh, pass,
    OrbitControls,
    type Node,
} from 'gpucat';

// ── Simulation constants ──────────────────────────────────────────────────────

const maxParticles    = 8192 * 4;
const gridSize1d      = 64;
const workgroupSize   = 64;
const cellCount       = gridSize1d * gridSize1d * gridSize1d;
const FIXED           = 1e7;

// ── Structs ───────────────────────────────────────────────────────────────────

// Each particle: position (vec3, 4-float aligned), velocity (vec3, 4-float
// aligned), affine velocity field C (mat3x3, 3×4 floats) → 20 f32 slots total.
const ParticleStruct = struct('Particle', {
    position: d.vec3f,
    velocity: d.vec3f,
    C:        d.mat3x3f,
});

// Grid cell with four atomic i32 fields (fixed-point encoded).
const CellStruct = struct('Cell', {
    x:    d.atomic(d.i32),
    y:    d.atomic(d.i32),
    z:    d.atomic(d.i32),
    mass: d.atomic(d.i32),
});

// ── Buffers ───────────────────────────────────────────────────────────────────

const particleData = new Float32Array(maxParticles * 20);
for (let i = 0; i < maxParticles; i++) {
    particleData[i * 20 + 0] = Math.random() * 0.8 + 0.1;
    particleData[i * 20 + 1] = Math.random() * 0.8 + 0.1;
    particleData[i * 20 + 2] = Math.random() * 0.8 + 0.1;
}

const particleBuffer   = instancedArray(particleData,  d.array(ParticleStruct), 'read_write');
const cellBuffer       = instancedArray(cellCount,     d.array(CellStruct),     'read_write');
const cellBufferFloat  = instancedArray(cellCount,     d.array(d.vec4f),        'read_write');

// ── Uniforms ──────────────────────────────────────────────────────────────────

const particleCountUniform    = uniform(u32(maxParticles));
const gridSizeUniform         = uniform(vec3f(gridSize1d, gridSize1d, gridSize1d));
const stiffnessUniform        = uniform(f32(50.0));
const restDensityUniform      = uniform(f32(1.5));
const dynamicViscosityUniform = uniform(f32(0.1));
const dtUniform               = uniform(f32(1 / 60));
const gravityUniform          = uniform(vec3f(0, -(9.81 * 9.81), 0));

// ── Fixed-point helpers ───────────────────────────────────────────────────────
// WebGPU only supports integer atomics, so we encode floats as scaled i32.

const encodeFixedPoint = (v: Node<d.f32>): Node<d.i32> => i32(v.mul(f32(FIXED)));
const decodeFixedPoint = (v: Node<d.i32 | d.u32>): Node<d.f32> => f32(v).div(f32(FIXED));

// ── Compute kernels ───────────────────────────────────────────────────────────

// 1. Clear all grid cells before each p2g pass.
const clearGridKernel = Fn(() => {
    If(instanceIndex.greaterThanEqual(u32(cellCount)), () => { Return(); });

    const c = CellStruct.instantiate(index(cellBuffer, instanceIndex));
    atomicStore(c.x,    i32(0));
    atomicStore(c.y,    i32(0));
    atomicStore(c.z,    i32(0));
    atomicStore(c.mass, i32(0));
}).compute({ workgroupSize: [workgroupSize, 1, 1], dispatch: [Math.ceil(cellCount / workgroupSize)] });

// 2. Particle-to-grid pass 1: scatter velocity×mass and mass to grid.
const p2g1Kernel = Fn(() => {
    If(instanceIndex.greaterThanEqual(particleCountUniform), () => { Return(); });

    const p          = ParticleStruct.instantiate(index(particleBuffer, instanceIndex));
    const pos        = p.position.toConst('pos');
    const vel        = p.velocity.toConst('vel');
    const C          = p.C.toConst('C');

    const gridPos    = pos.mul(gridSizeUniform).toVar('gridPos');
    const cellIdx    = vec3i(gridPos).sub(vec3i(i32(1), i32(1), i32(1))).toConst('cellIdx');
    const cellDiff   = gridPos.fract().sub(f32(0.5)).toConst('cellDiff');

    const w0 = f32(0.5).mul(f32(0.5).sub(cellDiff)).mul(f32(0.5).sub(cellDiff)).toConst('w0');
    const w1 = f32(0.75).sub(cellDiff.mul(cellDiff)).toConst('w1');
    const w2 = f32(0.5).mul(f32(0.5).add(cellDiff)).mul(f32(0.5).add(cellDiff)).toConst('w2');
    const weights = array([w0, w1, w2]).toConst('weights');

    Loop({ start: 0, end: 3, type: 'i32', name: 'gx', condition: '<' }, ({ gx }) => {
        Loop({ start: 0, end: 3, type: 'i32', name: 'gy', condition: '<' }, ({ gy }) => {
            Loop({ start: 0, end: 3, type: 'i32', name: 'gz', condition: '<' }, ({ gz }) => {
                const weight    = weights.element(gx).x.mul(weights.element(gy).y).mul(weights.element(gz).z);
                const cellX     = cellIdx.add(vec3i(gx, gy, gz)).toConst('cellX');
                const cellDist  = vec3f(cellX).add(f32(0.5)).sub(gridPos).toConst('cellDist');
                const Q         = C.mul(cellDist);
                const mass      = weight; // particle mass = 1
                const velContrib = mass.mul(vel.add(Q)).toConst('velContrib');
                const ptr       = cellX.x.mul(i32(gridSize1d * gridSize1d)).add(cellX.y.mul(i32(gridSize1d))).add(cellX.z).toConst('ptr');
                const cell      = CellStruct.instantiate(index(cellBuffer, ptr));
                atomicAdd(cell.x,    encodeFixedPoint(velContrib.x));
                atomicAdd(cell.y,    encodeFixedPoint(velContrib.y));
                atomicAdd(cell.z,    encodeFixedPoint(velContrib.z));
                atomicAdd(cell.mass, encodeFixedPoint(mass));
            });
        });
    });
}).compute({ workgroupSize: [workgroupSize, 1, 1], dispatch: [Math.ceil(maxParticles / workgroupSize)] });

// 3. Particle-to-grid pass 2: scatter pressure + viscosity forces.
const p2g2Kernel = Fn(() => {
    If(instanceIndex.greaterThanEqual(particleCountUniform), () => { Return(); });

    const p        = ParticleStruct.instantiate(index(particleBuffer, instanceIndex));
    const pos      = p.position.toConst('pos');
    const gridPos  = pos.mul(gridSizeUniform).toVar('gridPos');
    const cellIdx  = vec3i(gridPos).sub(vec3i(i32(1), i32(1), i32(1))).toConst('cellIdx');
    const cellDiff = gridPos.fract().sub(f32(0.5)).toConst('cellDiff');

    const w0 = f32(0.5).mul(f32(0.5).sub(cellDiff)).mul(f32(0.5).sub(cellDiff)).toConst('w0');
    const w1 = f32(0.75).sub(cellDiff.mul(cellDiff)).toConst('w1');
    const w2 = f32(0.5).mul(f32(0.5).add(cellDiff)).mul(f32(0.5).add(cellDiff)).toConst('w2');
    const weights = array([w0, w1, w2]).toConst('weights');

    const density = f32(0).toVar('density');
    Loop({ start: 0, end: 3, type: 'i32', name: 'gx', condition: '<' }, ({ gx }) => {
        Loop({ start: 0, end: 3, type: 'i32', name: 'gy', condition: '<' }, ({ gy }) => {
            Loop({ start: 0, end: 3, type: 'i32', name: 'gz', condition: '<' }, ({ gz }) => {
                const weight = weights.element(gx).x.mul(weights.element(gy).y).mul(weights.element(gz).z);
                const cellX  = cellIdx.add(vec3i(gx, gy, gz)).toConst('cellX');
                const ptr    = cellX.x.mul(i32(gridSize1d * gridSize1d)).add(cellX.y.mul(i32(gridSize1d))).add(cellX.z).toConst('ptr');
                const cell   = CellStruct.instantiate(index(cellBuffer, ptr));
                const mass   = decodeFixedPoint(atomicLoad(cell.mass));
                density.addAssign(mass.mul(weight));
            });
        });
    });

    const volume   = f32(1).div(density);
    const pressure = max(f32(0), pow(density.div(restDensityUniform), f32(5)).sub(f32(1)).mul(stiffnessUniform)).toConst('pressure');
    const stress   = mat3(pressure.negate(), f32(0), f32(0), f32(0), pressure.negate(), f32(0), f32(0), f32(0), pressure.negate()).toVar('stress');
    // dudv is actually the particle's C matrix (affine velocity gradient)
    const dudv     = p.C.toConst('dudv');
    const strain   = dudv.add(dudv.transpose());
    stress.addAssign(strain.mul(dynamicViscosityUniform));
    const eq16     = volume.mul(f32(-4)).mul(stress).mul(dtUniform);

    Loop({ start: 0, end: 3, type: 'i32', name: 'gx', condition: '<' }, ({ gx }) => {
        Loop({ start: 0, end: 3, type: 'i32', name: 'gy', condition: '<' }, ({ gy }) => {
            Loop({ start: 0, end: 3, type: 'i32', name: 'gz', condition: '<' }, ({ gz }) => {
                const weight   = weights.element(gx).x.mul(weights.element(gy).y).mul(weights.element(gz).z);
                const cellX    = cellIdx.add(vec3i(gx, gy, gz)).toConst('cellX');
                const cellDist = vec3f(cellX).add(f32(0.5)).sub(gridPos).toConst('cellDist');
                const momentum = eq16.mul(weight).mul(cellDist).toConst('momentum');
                const ptr      = cellX.x.mul(i32(gridSize1d * gridSize1d)).add(cellX.y.mul(i32(gridSize1d))).add(cellX.z).toConst('ptr');
                const cell     = CellStruct.instantiate(index(cellBuffer, ptr));
                atomicAdd(cell.x, encodeFixedPoint(momentum.x));
                atomicAdd(cell.y, encodeFixedPoint(momentum.y));
                atomicAdd(cell.z, encodeFixedPoint(momentum.z));
            });
        });
    });
}).compute({ workgroupSize: [workgroupSize, 1, 1], dispatch: [Math.ceil(maxParticles / workgroupSize)] });

// 4. Update grid: normalise by mass, apply boundary conditions, write to float buffer.
const updateGridKernel = Fn(() => {
    If(instanceIndex.greaterThanEqual(u32(cellCount)), () => { Return(); });

    const cell = CellStruct.instantiate(index(cellBuffer, instanceIndex));
    const mass = decodeFixedPoint(atomicLoad(cell.mass)).toConst('mass');
    If(mass.lessThanEqual(f32(0)), () => { Return(); });

    const vx = decodeFixedPoint(atomicLoad(cell.x)).div(mass).toVar('vx');
    const vy = decodeFixedPoint(atomicLoad(cell.y)).div(mass).toVar('vy');
    const vz = decodeFixedPoint(atomicLoad(cell.z)).div(mass).toVar('vz');

    // Boundary: zero velocity on grid faces.
    const gx = i32(instanceIndex).div(i32(gridSize1d * gridSize1d));
    const gy = i32(instanceIndex).div(i32(gridSize1d)).mod(i32(gridSize1d));
    const gz = i32(instanceIndex).mod(i32(gridSize1d));
    If(gx.lessThan(i32(1)).or(gx.greaterThan(i32(gridSize1d - 2))), () => { vx.assign(f32(0)); });
    If(gy.lessThan(i32(1)).or(gy.greaterThan(i32(gridSize1d - 2))), () => { vy.assign(f32(0)); });
    If(gz.lessThan(i32(1)).or(gz.greaterThan(i32(gridSize1d - 2))), () => { vz.assign(f32(0)); });

    index(cellBufferFloat, instanceIndex).assign(vec4(vx, vy, vz, mass));
}).compute({ workgroupSize: [workgroupSize, 1, 1], dispatch: [Math.ceil(cellCount / workgroupSize)] });

// 5. Grid-to-particle: gather velocity, update C, integrate position.
const g2pKernel = Fn(() => {
    If(instanceIndex.greaterThanEqual(particleCountUniform), () => { Return(); });

    const p        = ParticleStruct.instantiate(index(particleBuffer, instanceIndex));
    const pos      = p.position.toVar('pos');
    const gridPos  = pos.mul(gridSizeUniform).toVar('gridPos');
    const pVel     = vec3f(f32(0), f32(0), f32(0)).toVar('pVel');

    const cellIdx  = vec3i(gridPos).sub(vec3i(i32(1), i32(1), i32(1))).toConst('cellIdx');
    const cellDiff = gridPos.fract().sub(f32(0.5)).toConst('cellDiff');

    const w0 = f32(0.5).mul(f32(0.5).sub(cellDiff)).mul(f32(0.5).sub(cellDiff)).toConst('w0');
    const w1 = f32(0.75).sub(cellDiff.mul(cellDiff)).toConst('w1');
    const w2 = f32(0.5).mul(f32(0.5).add(cellDiff)).mul(f32(0.5).add(cellDiff)).toConst('w2');
    const weights = array([w0, w1, w2]).toConst('weights');

    const B = mat3(f32(0)).toVar('B');
    Loop({ start: 0, end: 3, type: 'i32', name: 'gx', condition: '<' }, ({ gx }) => {
        Loop({ start: 0, end: 3, type: 'i32', name: 'gy', condition: '<' }, ({ gy }) => {
            Loop({ start: 0, end: 3, type: 'i32', name: 'gz', condition: '<' }, ({ gz }) => {
                const weight   = weights.element(gx).x.mul(weights.element(gy).y).mul(weights.element(gz).z);
                const cellX    = cellIdx.add(vec3i(gx, gy, gz)).toConst('cellX');
                const cellDist = vec3f(cellX).add(f32(0.5)).sub(gridPos).toConst('cellDist');
                const ptr      = cellX.x.mul(i32(gridSize1d * gridSize1d)).add(cellX.y.mul(i32(gridSize1d))).add(cellX.z).toConst('ptr');
                const wVel     = index(cellBufferFloat, ptr).xyz.mul(weight).toConst('wVel');
                const term     = mat3(wVel.mul(cellDist.x), wVel.mul(cellDist.y), wVel.mul(cellDist.z));
                B.addAssign(term);
                pVel.addAssign(wVel);
            });
        });
    });

    p.C.assign(B.mul(f32(4)));

    // Gravity + dt integration.
    pVel.addAssign(gravityUniform.mul(dtUniform));
    pVel.divAssign(gridSizeUniform);
    pos.addAssign(pVel.mul(dtUniform));

    // Keep particles inside the grid boundary.
    const lo = vec3f(f32(1)).div(gridSizeUniform);
    const hi = vec3f(f32(gridSize1d - 1)).div(gridSizeUniform);
    pos.assign(clamp(pos, lo, hi));

    // Rounded-box containment: push particles back from the interior walls.
    const innerBox    = gridSizeUniform.mul(f32(0.5)).sub(f32(9.0)).div(gridSizeUniform).toVar('innerBox');
    const innerRadius = f32(6.0).div(gridSizeUniform.x);
    const posNext     = pos.add(pVel.mul(dtUniform).mul(f32(2))).toConst('posNext');
    const r           = posNext.sub(f32(0.5)).toVar('r');
    const pp          = step(innerBox, r.abs()).mul(r.add(innerBox.negate().mul(r.sign())));
    const ppLen       = pp.length().toVar('ppLen');
    const dist        = ppLen.sub(innerRadius);
    If(dist.greaterThan(f32(0)), () => {
        r.subAssign(pp.normalize().mul(dist).mul(f32(1.3)));
    });
    r.addAssign(f32(0.5));
    pVel.addAssign(r.sub(posNext));

    pVel.mulAssign(gridSizeUniform);
    p.position.assign(pos);
    p.velocity.assign(pVel);
}).compute({ workgroupSize: [workgroupSize, 1, 1], dispatch: [Math.ceil(maxParticles / workgroupSize)] });

// ── Render material ───────────────────────────────────────────────────────────

// Read particle position for this instance and offset the mesh vertex.
const particlePos = ParticleStruct.instantiate(index(particleBuffer, instanceIndex)).position;
const vtxPos      = attribute(d.vec3f, 'position');
// Particles live in [0,1]^3; shift to [-0.5, 0.5]^3 for the camera.
const worldPos    = vec4(
    vtxPos.x.add(particlePos.x).sub(f32(0.5)),
    vtxPos.y.add(particlePos.y).sub(f32(0.5)),
    vtxPos.z.add(particlePos.z).sub(f32(0.5)),
    f32(1),
);
const clipPos   = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPos));
const fragColor = varying(vec4(f32(0.1), f32(0.4), f32(1.0), f32(1.0)), 'v_col');

const material = new Material({ vertex: clipPos, fragment: fragColor });

// ── Scene setup ───────────────────────────────────────────────────────────────

const renderer = new WebGPURenderer({ antialias: true });
renderer.inspector = new Inspector();
await renderer.init();
document.body.appendChild(renderer.domElement);
document.body.appendChild((renderer.inspector as Inspector).domElement);
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.clearColor = [0.05, 0.05, 0.1, 1];

const scene  = new Scene();
const camera = new PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.01, 10);
camera.position[0] = -1.3;
camera.position[1] =  1.3;
camera.position[2] = -1.3;
scene.add(camera);

const controls = new OrbitControls(camera, renderer.domElement);
controls.minDistance = 1;
controls.maxDistance = 3;

// Small tetrahedron geometry per particle (~sphere stand-in, 4 verts).
const r = 0.008;
const tetraVerts = new Float32Array([
     0,  r,  0,
    -r, -r,  r,
     r, -r,  r,
     0, -r, -r,
]);
const tetraIdx = new Uint16Array([0,1,2, 0,2,3, 0,3,1, 1,3,2]);
const geom = new Geometry();
geom.attributes.set('position', new BufferAttribute(tetraVerts, 3));
geom.index = new IndexAttribute(tetraIdx);

const mesh  = new Mesh(geom, material);
mesh.count  = maxParticles;
scene.add(mesh);

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

// Pre-compile all five kernels.
await Promise.all([
    renderer.compileCompute(clearGridKernel),
    renderer.compileCompute(p2g1Kernel),
    renderer.compileCompute(p2g2Kernel),
    renderer.compileCompute(updateGridKernel),
    renderer.compileCompute(g2pKernel),
]);

const scenePass  = pass(scene, camera);
const outputNode = scenePass.getTextureNode();

function frame() {
    dtUniform.value = 1 / 60;

    renderer.compute(clearGridKernel);
    renderer.compute(p2g1Kernel);
    renderer.compute(p2g2Kernel);
    renderer.compute(updateGridKernel);
    renderer.compute(g2pKernel);
    renderer.render(outputNode);
    requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
