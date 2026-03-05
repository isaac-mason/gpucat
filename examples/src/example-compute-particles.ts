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

import * as g from 'gpucat';

const S = g.S;

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
const positionAttr = new g.StorageBufferAttribute(positionData, 4); // 4 floats per vec4f
const positions = g.storage(positionAttr, S.array(S.vec4f()), 'read_write');

// velocities: vec4f per particle — xyz = velocity, w = unused
const velocityData = new Float32Array(N * 4);
for (let i = 0; i < N; i++) {
    velocityData[i * 4 + 0] = (Math.random() - 0.5) * 0.02;
    velocityData[i * 4 + 1] = 0.01 + Math.random() * 0.03;
    velocityData[i * 4 + 2] = (Math.random() - 0.5) * 0.01;
    velocityData[i * 4 + 3] = 0;
}
const velocityAttr = new g.StorageBufferAttribute(velocityData, 4); // 4 floats per vec4f
const velocities = g.storage(velocityAttr, S.array(S.vec4f()), 'read');

// ---------------------------------------------------------------------------
// 2. Compute kernel — advance particles each frame
// ---------------------------------------------------------------------------

const updateParticles = g.Fn(() => {
    const idx = g.Var(g.globalId().x, 'idx');

    // Bounds check — last workgroup may have spare threads.
    // Use If guard instead of Return() to stay compatible with void kernels.
    g.If(idx.lt(g.u32(N)), () => {
        const pos = g.Var(g.index(positions, idx), 'pos');
        const vel = g.Var(g.index(velocities, idx), 'vel');

        // Advance position by velocity.
        const newX = pos.x.add(vel.x);
        const newY = pos.y.add(vel.y);
        const newZ = pos.z.add(vel.z);

        // Decay lifetime — w counts down from 1 to 0.
        const newW = pos.w.sub(g.f32(0.004));

        // Respawn when lifetime expires (w <= 0).
        g.If(newW.lte(g.f32(0)), () => {
            // Use globalId components as a cheap deterministic hash for spawn position.
            const seedX = g.f32(0).add(idx.toF32().mul(g.f32(0.0013)).fract().mul(g.f32(20)).sub(g.f32(10)));
            g.index(positions, idx).assign(
                g.vec4(seedX, g.f32(-5), g.f32(0), g.f32(1)),
            );
        }).Else(() => {
            g.index(positions, idx).assign(
                g.vec4(newX, newY, newZ, newW),
            );
        });
    });
}).compute({ workgroupSize: [WG, 1, 1], dispatch: [Math.ceil(N / WG)] });

// ---------------------------------------------------------------------------
// 3. Render graph — instanced particles
// ---------------------------------------------------------------------------

const iIdx    = g.instanceIndex();

// Read this particle's world position directly from the storage buffer.
// renderer.compute() ensures the buffer is updated before the render pass each frame.
const particlePos = g.index(positions, iIdx);

// Vertex: offset the geometry vertex by the particle's world position.
const vtxPos = g.attribute('vec3f', 'position');
const worldPos = g.vec4(
    vtxPos.x.add(particlePos.x),
    vtxPos.y.add(particlePos.y),
    vtxPos.z.add(particlePos.z),
    g.f32(1),
);
const viewPos = g.mul(g.cameraViewMatrix, worldPos);
const clipPos = g.mul(g.cameraProjectionMatrix, viewPos);

// Color: fade by lifetime (w), add a soft blue-white hue.
const lifetime = g.varying('f32', 'v_life', particlePos.w);
const colR = lifetime.mul(g.f32(0.6)).add(g.f32(0.4));
const colG = lifetime.mul(g.f32(0.7)).add(g.f32(0.3));
const colB = g.f32(1.0);
const colA = lifetime.clamp(g.f32(0), g.f32(1));
const particleColor = g.vec4(colR, colG, colB, colA);

// Subtle time-driven pulse on brightness.
const pulse = g.timeElapsed.mul(g.f32(2)).sin().mul(g.f32(0.05)).add(g.f32(1));
const finalColor = g.vec4(
    particleColor.rgb.mul(pulse),
    particleColor.a,
);

const material = new g.Material({
    vertex: clipPos,
    fragment: finalColor,
    transparent: true,
    depthWrite: false,
});

// ---------------------------------------------------------------------------
// 4. Main — init renderer and scene
// ---------------------------------------------------------------------------

async function main() {
    const renderer = new g.WebGPURenderer({ antialias: true });
    renderer.inspector = new g.Inspector();
    await renderer.init();

    document.body.appendChild(renderer.domElement);
    document.body.appendChild((renderer.inspector as g.Inspector).domElement);
    renderer.setSize(window.innerWidth * devicePixelRatio, window.innerHeight * devicePixelRatio);
    renderer.clearColor = [0.04, 0.04, 0.08, 1];

    const scene = new g.Scene();
    const camera = new g.PerspectiveCamera(
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
        renderer.setSize(window.innerWidth * devicePixelRatio, window.innerHeight * devicePixelRatio);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    });

    // Small quad geometry for each particle — a 0.15-unit square.
    const S2 = 0.075;
    const quadGeom = new g.Geometry();
    const verts = new Float32Array([
        -S2, -S2, 0,
         S2, -S2, 0,
         S2,  S2, 0,
        -S2,  S2, 0,
    ]);
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
    quadGeom.attributes.set('position', new g.BufferAttribute(verts, 3));
    quadGeom.index = new g.IndexAttribute(indices);

    const mesh = new g.Mesh(quadGeom, material);
    mesh.count = N;
    scene.add(mesh);

    // Pre-warm the compute pipeline before the frame loop.
    await renderer.compileCompute(updateParticles);

    const scenePass = g.pass(scene, camera);
    const outputNode = scenePass.getTextureNode();

    function frame() {
        // Dispatch the compute pass first, then render.
        renderer.compute(updateParticles);
        renderer.render(outputNode);
        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

main();
