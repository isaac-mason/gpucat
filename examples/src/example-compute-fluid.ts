import {
    d, struct, instancedArray, storage, instanceIndex, computeIndex, uniform, index,
    f32, i32, u32, vec3, vec3f, vec3i, vec4,
    array, mat3, cross,
    clamp, max, pow, step,
    atomicAdd, atomicStore, atomicLoad,
    Loop, If, Return, Fn,
    attribute, varying,
    cameraViewMatrix, cameraProjectionMatrix, mul,
    Material, WebGPURenderer, Inspector, Scene, PerspectiveCamera,
    Geometry, BufferAttribute, IndexAttribute, IndirectStorageBufferAttribute, Mesh, pass,
    OrbitControls,
    type Node,
} from 'gpucat';
import { mat4, vec4 as mcVec4 } from 'mathcat';

// ── Simulation constants ──────────────────────────────────────────────────────

const maxParticles    = 8192 * 16;
const gridSize1d      = 64;
const workgroupSize   = 64;
const cellCount       = gridSize1d * gridSize1d * gridSize1d;
const FIXED           = 1e7;

const params = {
    particleCount: 8192 * 4,
};

// ── Structs ───────────────────────────────────────────────────────────────────

const ParticleStruct = struct('Particle', {
    position: d.vec3f,
    velocity: d.vec3f,
    C:        d.mat3x3f,
});

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

// ── Indirect dispatch buffers ─────────────────────────────────────────────────

const numWorkgroups = Math.ceil(params.particleCount / workgroupSize);

const p2g1IndirectAttr = new IndirectStorageBufferAttribute(new Uint32Array([numWorkgroups, 1, 1]), 1);
const p2g2IndirectAttr = new IndirectStorageBufferAttribute(new Uint32Array([numWorkgroups, 1, 1]), 1);
const g2pIndirectAttr  = new IndirectStorageBufferAttribute(new Uint32Array([numWorkgroups, 1, 1]), 1);

const p2g1WorkgroupStorage = storage(p2g1IndirectAttr, d.array(d.u32), 'read_write');
const p2g2WorkgroupStorage = storage(p2g2IndirectAttr, d.array(d.u32), 'read_write');
const g2pWorkgroupStorage  = storage(g2pIndirectAttr,  d.array(d.u32), 'read_write');

// ── Uniforms ──────────────────────────────────────────────────────────────────

const particleCountUniform     = uniform(u32(params.particleCount));
const gridSizeUniform          = uniform(vec3f(gridSize1d, gridSize1d, gridSize1d));
const stiffnessUniform         = uniform(f32(50.0));
const restDensityUniform       = uniform(f32(1.5));
const dynamicViscosityUniform  = uniform(f32(0.1));
const dtUniform                = uniform(f32(1 / 60));
const gravityUniform           = uniform(vec3f(0, -(9.81 * 9.81), 0));
const mouseRayOriginUniform    = uniform(vec3f(0, 0, 0));
const mouseRayDirectionUniform = uniform(vec3f(0, 0, 0));
const mouseForceUniform        = uniform(vec3f(0, 0, 0));

// ── Fixed-point helpers ───────────────────────────────────────────────────────

const encodeFixedPoint = <D extends d.f32>(v: Node<D>) => i32(v.mul(f32(FIXED)));
const decodeFixedPoint = <D extends d.i32 | d.u32>(v: Node<D>) => f32(v).div(f32(FIXED));

// ── Workgroup kernel ──────────────────────────────────────────────────────────

// Runs a single invocation to compute the indirect dispatch counts from the
// dynamic particleCount uniform. This avoids CPU readback.
const workgroupKernel = Fn(() => {
    const count = particleCountUniform.sub(u32(1)).div(u32(workgroupSize)).add(u32(1));
    index(p2g1WorkgroupStorage, u32(0)).assign(count);
    index(p2g2WorkgroupStorage, u32(0)).assign(count);
    index(g2pWorkgroupStorage,  u32(0)).assign(count);
}).compute({ workgroupSize: [1, 1, 1] });

// ── Compute kernels ───────────────────────────────────────────────────────────

// 1. Clear all grid cells before each p2g pass.
const clearGridKernel = Fn(() => {
    If(computeIndex.greaterThanEqual(u32(cellCount)), () => { Return(); });

    const c = CellStruct.instantiate(index(cellBuffer, computeIndex));
    atomicStore(c.x,    i32(0));
    atomicStore(c.y,    i32(0));
    atomicStore(c.z,    i32(0));
    atomicStore(c.mass, i32(0));
}).compute({ workgroupSize: [workgroupSize, 1, 1] });
const clearGridDispatch: [number, number, number] = [Math.ceil(cellCount / workgroupSize), 1, 1];

// 2. Particle-to-grid pass 1: scatter velocity*mass and mass to grid.
const p2g1Kernel = Fn(() => {
    If(computeIndex.greaterThanEqual(particleCountUniform), () => { Return(); });

    const p          = ParticleStruct.instantiate(index(particleBuffer, computeIndex));
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
                const mass      = weight;
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
}).compute({ workgroupSize: [workgroupSize, 1, 1] });

// 3. Particle-to-grid pass 2: scatter pressure + viscosity forces.
const p2g2Kernel = Fn(() => {
    If(computeIndex.greaterThanEqual(particleCountUniform), () => { Return(); });

    const p        = ParticleStruct.instantiate(index(particleBuffer, computeIndex));
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
}).compute({ workgroupSize: [workgroupSize, 1, 1] });

// 4. Update grid: normalise by mass, apply boundary conditions, write to float buffer.
const updateGridKernel = Fn(() => {
    If(computeIndex.greaterThanEqual(u32(cellCount)), () => { Return(); });

    const cell = CellStruct.instantiate(index(cellBuffer, computeIndex));
    const mass = decodeFixedPoint(atomicLoad(cell.mass)).toConst('mass');
    If(mass.lessThanEqual(f32(0)), () => { Return(); });

    const vx = decodeFixedPoint(atomicLoad(cell.x)).div(mass).toVar('vx');
    const vy = decodeFixedPoint(atomicLoad(cell.y)).div(mass).toVar('vy');
    const vz = decodeFixedPoint(atomicLoad(cell.z)).div(mass).toVar('vz');

    const gx = i32(computeIndex).div(i32(gridSize1d * gridSize1d));
    const gy = i32(computeIndex).div(i32(gridSize1d)).mod(i32(gridSize1d));
    const gz = i32(computeIndex).mod(i32(gridSize1d));
    If(gx.lessThan(i32(1)).or(gx.greaterThan(i32(gridSize1d - 2))), () => { vx.assign(f32(0)); });
    If(gy.lessThan(i32(1)).or(gy.greaterThan(i32(gridSize1d - 2))), () => { vy.assign(f32(0)); });
    If(gz.lessThan(i32(1)).or(gz.greaterThan(i32(gridSize1d - 2))), () => { vz.assign(f32(0)); });

    index(cellBufferFloat, computeIndex).assign(vec4(vx, vy, vz, mass));
}).compute({ workgroupSize: [workgroupSize, 1, 1] });
const updateGridDispatch: [number, number, number] = [Math.ceil(cellCount / workgroupSize), 1, 1];

// 5. Grid-to-particle: gather velocity, update C, integrate position.
const g2pKernel = Fn(() => {
    If(computeIndex.greaterThanEqual(particleCountUniform), () => { Return(); });

    const p        = ParticleStruct.instantiate(index(particleBuffer, computeIndex));
    const pos      = p.position.toVar('pos');
    const gridPos  = pos.mul(gridSizeUniform).toVar('gridPos');
    const pVel     = vec3(0).toVar('pVel');

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

    // Gravity
    pVel.addAssign(gravityUniform.mul(dtUniform));

    // Scale from grid space to [0,1] space
    pVel.divAssign(gridSizeUniform);

    // Mouse interaction
    const dist = cross(mouseRayDirectionUniform, pos.sub(mouseRayOriginUniform)).length();
    const force = dist.mul(f32(3)).oneMinus().max(f32(0)).pow(f32(2));
    pVel.addAssign(mouseForceUniform.mul(force));

    // Integrate position
    pos.addAssign(pVel.mul(dtUniform));

    // Clamp to grid boundary
    const lo = vec3(f32(1)).div(gridSizeUniform);
    const hi = vec3f(f32(gridSize1d - 1)).div(gridSizeUniform);
    pos.assign(clamp(pos, lo, hi));

    // Rounded-box containment
    const innerBox    = gridSizeUniform.mul(f32(0.5)).sub(f32(9.0)).div(gridSizeUniform).toVar('innerBox');
    const innerRadius = f32(6.0).div(gridSizeUniform.x);
    const posNext     = pos.add(pVel.mul(dtUniform).mul(f32(2))).toConst('posNext');
    const r           = posNext.sub(f32(0.5)).toVar('r');
    const pp          = step(innerBox, r.abs()).mul(r.add(innerBox.negate().mul(r.sign())));
    const ppLen       = pp.length().toVar('ppLen');
    const clampDist   = ppLen.sub(innerRadius);
    If(clampDist.greaterThan(f32(0)), () => {
        r.subAssign(pp.normalize().mul(clampDist).mul(f32(1.3)));
    });
    r.addAssign(f32(0.5));
    pVel.addAssign(r.sub(posNext));

    // Scale back to grid space
    pVel.mulAssign(gridSizeUniform);
    p.position.assign(pos);
    p.velocity.assign(pVel);
}).compute({ workgroupSize: [workgroupSize, 1, 1] });

// ── Render material ───────────────────────────────────────────────────────────

const particlePos = ParticleStruct.instantiate(index(particleBuffer, instanceIndex)).position;
const vtxPos      = attribute(d.vec3f, 'position');
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

// Small tetrahedron geometry per particle
const tetraR = 0.008;
const tetraVerts = new Float32Array([
     0,  tetraR,  0,
    -tetraR, -tetraR,  tetraR,
     tetraR, -tetraR,  tetraR,
     0, -tetraR, -tetraR,
]);
const tetraIdx = new Uint16Array([0,1,2, 0,2,3, 0,3,1, 1,3,2]);
const geom = new Geometry();
geom.attributes.set('position', new BufferAttribute(tetraVerts, 3));
geom.index = new IndexAttribute(tetraIdx);

const mesh  = new Mesh(geom, material);
mesh.count  = params.particleCount;
scene.add(mesh);

// ── GUI ───────────────────────────────────────────────────────────────────────

const gui = (renderer.inspector as Inspector).createParameters('Settings');
gui.add(params, 'particleCount', 4096, maxParticles, 4096).onChange((value: number) => {
    mesh.count = value;
    particleCountUniform.value = value;
});

// ── Mouse interaction ─────────────────────────────────────────────────────────

const mouseCoord    = [0, 0, 0];
const prevMouseCoord = [0, 0, 0];

function setupMouse() {
    const planeNormal = [0, 1, 0]; // y-up plane at y=0

    renderer.domElement.addEventListener('pointermove', (event: PointerEvent) => {
        // NDC coordinates
        const ndcX = (event.clientX / window.innerWidth) * 2 - 1;
        const ndcY = -(event.clientY / window.innerHeight) * 2 + 1;

        // Unproject ray from camera
        const invProj = mat4.create();
        mat4.invert(invProj, camera.projectionMatrix);
        // camera.matrixWorldInverse is the view matrix, so matrixWorld is its inverse
        const invView = camera.matrixWorld;

        // Ray in clip space → view space → world space
        const nearClip = mcVec4.fromValues(ndcX, ndcY, -1, 1);
        const farClip  = mcVec4.fromValues(ndcX, ndcY,  1, 1);
        const nearView = mcVec4.create();
        const farView  = mcVec4.create();
        mcVec4.transformMat4(nearView, nearClip, invProj);
        mcVec4.transformMat4(farView, farClip, invProj);
        perspDiv(nearView);
        perspDiv(farView);
        const nearWorld = mcVec4.create();
        const farWorld  = mcVec4.create();
        mcVec4.transformMat4(nearWorld, nearView, invView);
        mcVec4.transformMat4(farWorld, farView, invView);
        perspDiv(nearWorld);
        perspDiv(farWorld);

        const origin = [nearWorld[0], nearWorld[1], nearWorld[2]];
        const dir = [
            farWorld[0] - nearWorld[0],
            farWorld[1] - nearWorld[1],
            farWorld[2] - nearWorld[2],
        ];
        const len = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
        dir[0] /= len; dir[1] /= len; dir[2] /= len;

        // Shift origin by +0.5 on x,z to match particle [0,1]^3 space
        origin[0] += 0.5;
        origin[2] += 0.5;

        mouseRayOriginUniform.value    = [origin[0], origin[1], origin[2]];
        mouseRayDirectionUniform.value = [dir[0], dir[1], dir[2]];

        // Intersect y=0 plane
        const denom = planeNormal[0] * dir[0] + planeNormal[1] * dir[1] + planeNormal[2] * dir[2];
        if (Math.abs(denom) > 1e-6) {
            const t = -(planeNormal[0] * origin[0] + planeNormal[1] * origin[1] + planeNormal[2] * origin[2]) / denom;
            mouseCoord[0] = origin[0] + dir[0] * t;
            mouseCoord[1] = origin[1] + dir[1] * t;
            mouseCoord[2] = origin[2] + dir[2] * t;
        }
    });
}

function perspDiv(v: mcVec4.Vec4): void {
    const w = v[3];
    v[0] /= w; v[1] /= w; v[2] /= w; v[3] = 1;
}

setupMouse();

// ── Resize ────────────────────────────────────────────────────────────────────

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

// ── Compile ───────────────────────────────────────────────────────────────────

await Promise.all([
    renderer.compileCompute(workgroupKernel),
    renderer.compileCompute(clearGridKernel),
    renderer.compileCompute(p2g1Kernel),
    renderer.compileCompute(p2g2Kernel),
    renderer.compileCompute(updateGridKernel),
    renderer.compileCompute(g2pKernel),
]);

const scenePass  = pass(scene, camera);
const outputNode = scenePass.getTextureNode();

// ── Frame loop ────────────────────────────────────────────────────────────────

let lastTime = 0;

function frame() {
    const now = performance.now() / 1000;
    const delta = lastTime === 0 ? 0 : now - lastTime;
    lastTime = now;

    dtUniform.value = Math.min(Math.max(delta, 0.00001), 1 / 60);

    // Compute mouse force from position delta
    const fx = (mouseCoord[0] - prevMouseCoord[0]) * 2;
    const fy = (mouseCoord[1] - prevMouseCoord[1]) * 2;
    const fz = (mouseCoord[2] - prevMouseCoord[2]) * 2;
    const fLen = Math.sqrt(fx * fx + fy * fy + fz * fz);
    if (fLen > 0.3) {
        const scale = 0.3 / fLen;
        mouseForceUniform.value = [fx * scale, fy * scale, fz * scale];
    } else {
        mouseForceUniform.value = [fx, fy, fz];
    }
    prevMouseCoord[0] = mouseCoord[0];
    prevMouseCoord[1] = mouseCoord[1];
    prevMouseCoord[2] = mouseCoord[2];

    renderer.compute(workgroupKernel, [1, 1, 1]);
    renderer.compute(clearGridKernel, clearGridDispatch);
    renderer.compute(p2g1Kernel, p2g1IndirectAttr);
    renderer.compute(p2g2Kernel, p2g2IndirectAttr);
    renderer.compute(updateGridKernel, updateGridDispatch);
    renderer.compute(g2pKernel, g2pIndirectAttr);
    renderer.render(outputNode);
    requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
