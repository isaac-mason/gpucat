/**
 * example-compute-particles.ts
 *
 * Demonstrates the explicit compute API: a GPU-side particle simulation where
 * renderer.compute() dispatches the update kernel each frame before the render pass.
 *
 * Architecture:
 *   1. storageArray() allocates a vec4f buffer (xyz position + w=lifetime).
 *   2. compute() defines a kernel that advances each particle per frame.
 *      - globalId.x selects the particle index.
 *      - Particles drift upward and respawn when lifetime expires.
 *   3. renderer.compile(updateParticles) pre-warms the compute pipeline.
 *   4. Each frame: renderer.compute(updateParticles) then renderer.render(outputNode).
 *
 * All per-particle state lives on the GPU after the first upload.
 */

import * as gpu from 'gpucat';

const S = gpu.S;

const N = 8192;
const WG = 64; // workgroup size

// ---------------------------------------------------------------------------
// 1. Storage buffers
// ---------------------------------------------------------------------------

// positions: vec4f per particle — xyz = position, w = lifetime [0..1]
const positionData = new Float32Array(N * 4);
for (let i = 0; i < N; i++) {
    positionData[i * 4 + 0] = (Math.random() - 0.5) * 20;  // x spread
    positionData[i * 4 + 1] = (Math.random() - 0.5) * 10;  // y spread
    positionData[i * 4 + 2] = (Math.random() - 0.5) * 4;   // z depth
    positionData[i * 4 + 3] = Math.random();                // initial lifetime
}
const positions = gpu.storage(positionData, S.array(S.vec4f()), 'read_write');

// velocities: vec4f per particle — xyz = velocity, w = unused
const velocityData = new Float32Array(N * 4);
for (let i = 0; i < N; i++) {
    velocityData[i * 4 + 0] = (Math.random() - 0.5) * 0.02;
    velocityData[i * 4 + 1] = 0.01 + Math.random() * 0.03;
    velocityData[i * 4 + 2] = (Math.random() - 0.5) * 0.01;
    velocityData[i * 4 + 3] = 0;
}
const velocities = gpu.storage(velocityData, S.array(S.vec4f()), 'read');

// ---------------------------------------------------------------------------
// 2. Compute kernel — advance particles each frame
// ---------------------------------------------------------------------------

const updateParticles = gpu.compute({
    workgroupSize: [WG, 1, 1],
    dispatch: [Math.ceil(N / WG)],
    storage: [positions, velocities],

    body({ globalId }) {
        const idx = gpu.toVar(globalId.x, 'idx');

        // Bounds check — last workgroup may have spare threads.
        // Use If guard instead of Return() to stay compatible with void kernels.
        gpu.If(idx.lt(gpu.u32(N)), () => {
            const pos = gpu.toVar(gpu.index(positions, idx), 'pos');
            const vel = gpu.toVar(gpu.index(velocities, idx), 'vel');

            // Advance position by velocity.
            const newX = pos.x.add(vel.x);
            const newY = pos.y.add(vel.y);
            const newZ = pos.z.add(vel.z);

            // Decay lifetime — w counts down from 1 to 0.
            const newW = pos.w.sub(gpu.f32(0.004));

            // Respawn when lifetime expires (w <= 0).
            gpu.If(newW.lte(gpu.f32(0)), () => {
                // Use globalId components as a cheap deterministic hash for spawn position.
                const seedX = gpu.f32(0).add(idx.toF32().mul(gpu.f32(0.0013)).fract().mul(gpu.f32(20)).sub(gpu.f32(10)));
                gpu.index(positions, idx).assign(
                    gpu.vec4(seedX, gpu.f32(-5), gpu.f32(0), gpu.f32(1)),
                );
            }).Else(() => {
                gpu.index(positions, idx).assign(
                    gpu.vec4(newX, newY, newZ, newW),
                );
            });
        });
    },
});

// ---------------------------------------------------------------------------
// 3. Render graph — instanced particles
// ---------------------------------------------------------------------------

const iIdx    = gpu.instanceIndex();
const camNode = gpu.camera();
const timeNode = gpu.time();

// Read this particle's world position directly from the storage buffer.
// renderer.compute() ensures the buffer is updated before the render pass each frame.
const particlePos = gpu.index(positions, iIdx);

// Vertex: offset the geometry vertex by the particle's world position.
const vtxPos = gpu.attribute('vec3f', 'position');
const worldPos = gpu.vec4(
    vtxPos.x.add(particlePos.x),
    vtxPos.y.add(particlePos.y),
    vtxPos.z.add(particlePos.z),
    gpu.f32(1),
);
const viewPos = gpu.mul(camNode.viewMatrix, worldPos);
const clipPos = gpu.mul(camNode.projectionMatrix, viewPos);

// Color: fade by lifetime (w), add a soft blue-white hue.
const lifetime = gpu.varying('f32', 'v_life', particlePos.w);
const r = lifetime.mul(gpu.f32(0.6)).add(gpu.f32(0.4));
const g = lifetime.mul(gpu.f32(0.7)).add(gpu.f32(0.3));
const b = gpu.f32(1.0);
const a = lifetime.clamp(gpu.f32(0), gpu.f32(1));
const particleColor = gpu.vec4(r, g, b, a);

// Subtle time-driven pulse on brightness.
const pulse = timeNode.elapsed.mul(gpu.f32(2)).sin().mul(gpu.f32(0.05)).add(gpu.f32(1));
const finalColor = gpu.vec4(
    particleColor.rgb.mul(pulse),
    particleColor.a,
);

const material = new gpu.Material({
    position: clipPos,
    color: finalColor,
    transparent: true,
    depthWrite: false,
});

// ---------------------------------------------------------------------------
// 4. Main — init renderer and scene
// ---------------------------------------------------------------------------

async function main() {
    const renderer = new gpu.WebGPURenderer({ antialias: true });
    await renderer.init();

    document.body.appendChild(renderer.domElement);
    renderer.setSize(window.innerWidth * devicePixelRatio, window.innerHeight * devicePixelRatio);
    renderer.clearColor = [0.04, 0.04, 0.08, 1];

    const scene = new gpu.Scene();
    const camera = new gpu.PerspectiveCamera(
        Math.PI / 4,
        window.innerWidth / window.innerHeight,
        0.1,
        200,
    );
    camera.position[2] = 25;
    scene.add(camera);

    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth * devicePixelRatio, window.innerHeight * devicePixelRatio);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    });

    // Small quad geometry for each particle — a 0.15-unit square.
    const S2 = 0.075;
    const quadGeom = new gpu.Geometry();
    const verts = new Float32Array([
        -S2, -S2, 0,
         S2, -S2, 0,
         S2,  S2, 0,
        -S2,  S2, 0,
    ]);
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
    quadGeom.attributes.set('position', new gpu.BufferAttribute(verts, 'float32x3'));
    quadGeom.index = new gpu.IndexAttribute(indices);

    const mesh = new gpu.Mesh(quadGeom, material);
    mesh.count = N;
    scene.add(mesh);

    // Pre-warm the compute pipeline before the frame loop.
    await renderer.compile(updateParticles);

    const scenePass = gpu.pass(scene, camera);
    const outputNode = scenePass.getTextureNode();

    // Release CPU-side particle data after the first frame —
    // all further updates happen entirely on the GPU via the compute shader.
    let cpuReleased = false;

    function frame() {
        // Dispatch the compute pass first, then render.
        renderer.compute(updateParticles);
        renderer.render(outputNode);

        if (!cpuReleased) {
            positions.release();
            velocities.release();
            cpuReleased = true;
        }

        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

main();
