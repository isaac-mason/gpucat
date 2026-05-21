import { d, createStorageBuffer, storage, Fn, Var, globalId, If, index, f32, vec4, instanceIndex, attribute, mul, cameraViewMatrix, cameraProjectionMatrix, varying, timeElapsed, Material, WebGPURenderer, Inspector, Scene, PerspectiveCamera, Geometry, Mesh, pass, createIndexBuffer, createVertexBuffer, RenderPipeline, renderOutput } from 'gpucat';

const N = 8192;
const WG_SIZE = 64;

/* storage buffers */

// positions: vec4f per particle — xyz = position, w = lifetime [0..1]
const positionData = new Float32Array(N * 4);
for (let i = 0; i < N; i++) {
    positionData[i * 4 + 0] = (Math.random() - 0.5) * 20;  // x spread
    positionData[i * 4 + 1] = (Math.random() - 0.5) * 10;  // y spread
    positionData[i * 4 + 2] = (Math.random() - 0.5) * 4;   // z depth
    positionData[i * 4 + 3] = Math.random();               // initial lifetime
}
const positionBuffer = createStorageBuffer(d.array(d.vec4f), positionData);
const positions = storage(positionBuffer, 'read_write');

// velocities: vec4f per particle — xyz = velocity, w = unused
const velocityData = new Float32Array(N * 4);
for (let i = 0; i < N; i++) {
    velocityData[i * 4 + 0] = (Math.random() - 0.5) * 0.02;
    velocityData[i * 4 + 1] = 0.01 + Math.random() * 0.03;
    velocityData[i * 4 + 2] = (Math.random() - 0.5) * 0.01;
    velocityData[i * 4 + 3] = 0;
}
const velocityBuffer = createStorageBuffer(d.array(d.vec4f), velocityData);
const velocities = storage(velocityBuffer);

/* compute function */

const updateParticles = Fn(() => {
    const idx = Var(globalId.x, 'idx');
    const pos = Var(index(positions, idx), 'pos');
    const vel = Var(index(velocities, idx), 'vel');

    // advance
    const newX = pos.x.add(vel.x);
    const newY = pos.y.add(vel.y);
    const newZ = pos.z.add(vel.z);

    // decay lifetime — w counts down from 1 to 0.
    const newW = pos.w.sub(f32(0.004));

    // respawn when lifetime expires (w <= 0).
    If(newW.lessThanEqual(f32(0)), () => {
        // use globalId components as a cheap deterministic hash for spawn position.
        const seedX = f32(0).add(idx.toF32().mul(f32(0.0013)).fract().mul(f32(20)).sub(f32(10)));
        index(positions, idx).assign(
            vec4(seedX, f32(-5), f32(0), f32(1)),
        );
    }).Else(() => {
        index(positions, idx).assign(
            vec4(newX, newY, newZ, newW),
        );
    });
}).compute({ workgroupSize: [WG_SIZE, 1, 1] });

const iIdx = instanceIndex;

const particlePos = index(positions, iIdx);

// vertex: offset the geometry vertex by the particle's world position.
const vtxPos = attribute('position', d.vec3f);
const worldPos = vec4(
    vtxPos.x.add(particlePos.x),
    vtxPos.y.add(particlePos.y),
    vtxPos.z.add(particlePos.z),
    f32(1),
);
const viewPos = mul(cameraViewMatrix, worldPos);
const clipPos = mul(cameraProjectionMatrix, viewPos);

// fragment: fade by lifetime (w), add a soft blue-white hue.
const lifetime = varying(particlePos.w, 'v_life');
const colR = lifetime.mul(f32(0.6)).add(f32(0.4));
const colG = lifetime.mul(f32(0.7)).add(f32(0.3));
const colB = f32(1.0);
const colA = lifetime.clamp(f32(0), f32(1));
const particleColor = vec4(colR, colG, colB, colA);

// Subtle time-driven pulse on brightness.
const pulse = timeElapsed.mul(f32(2)).sin().mul(f32(0.05)).add(f32(1));
const finalColor = vec4(
    particleColor.rgb.mul(pulse),
    particleColor.a,
);

const material = new Material({
    vertex: clipPos,
    fragment: finalColor,
    transparent: true,
    depthWrite: false,
});

/* setup renderer and scene */
const renderer = new WebGPURenderer({ antialias: true });
renderer.inspector = new Inspector();
await renderer.init();

document.body.appendChild(renderer.domElement);
document.body.appendChild((renderer.inspector as Inspector).domElement);
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.clearColor = [0.04, 0.04, 0.08, 1];

const scene = new Scene();
const camera = new PerspectiveCamera(
    Math.PI / 4,
    window.innerWidth / window.innerHeight,
    0.1,
    200,
);
camera.position[2] = 25;
scene.add(camera);
// Static scene — set matrices once after setup.
scene.updateWorldMatrix();
camera.updateViewMatrix();

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

// Small quad geometry for each particle — a 0.15-unit square.
const S2 = 0.075;
const quadGeom = new Geometry();
const verts = new Float32Array([
    -S2, -S2, 0,
    S2, -S2, 0,
    S2,  S2, 0,
    -S2,  S2, 0,
]);
const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
quadGeom.setBuffer('position', createVertexBuffer(d.vec3f, verts));
quadGeom.index = createIndexBuffer(indices);

const mesh = new Mesh(quadGeom, material);
mesh.count = N;
scene.add(mesh);

// Pre-warm the compute pipeline before the frame loop.
await renderer.compileCompute(updateParticles);

const scenePass = pass(scene, camera);
const outputNode = renderOutput(scenePass.getTextureNode());
const renderPipeline = new RenderPipeline(renderer, outputNode);

function frame() {
    renderer.beginFrame();
    // Dispatch the compute pass first, then render.
    renderer.compute([{ node: updateParticles, dispatch: [Math.ceil(N / WG_SIZE), 1, 1] }]);
    renderPipeline.render();
    renderer.endFrame();
    requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
