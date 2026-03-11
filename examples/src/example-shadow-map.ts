import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    comparisonSampler,
    createBoxGeometry,
    createPlaneGeometry,
    createSphereGeometry,
    createVertexBuffer,

    d,
    depthTexture,
    f32,
    Geometry,
    Inspector,
    lessThan,
    greaterThan,
    Material,
    Mesh,
    modelNormalMatrix,
    modelWorldMatrix,
    mul,
    normalize,
    or,
    OrbitControls,
    OrthographicCamera,
    PerspectiveCamera,
    RenderTarget,
    Scene,
    select,
    textureSampleCompare,
    Uniform,
    uniform,
    varying,
    vec2,
    vec3,
    vec4,
    WebGPURenderer,
    type Node,
} from 'gpucat';
import { mat4, vec4 as v4, quat, type Euler, type Mat4, type Vec4 } from 'mathcat';

// ─── Renderer ───────────────────────────────────────────────────────────────

const renderer = new WebGPURenderer({ antialias: true });
renderer.inspector = new Inspector();
await renderer.init();

document.body.appendChild(renderer.domElement);
document.body.appendChild((renderer.inspector as Inspector).domElement);
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);

// ─── Cameras ────────────────────────────────────────────────────────────────

const camera = new PerspectiveCamera(
    Math.PI / 4,
    window.innerWidth / window.innerHeight,
    0.1,
    100,
);
camera.position = [3, 4, 6];
camera.lookAt([0, 0, 0]);

const controls = new OrbitControls(camera, renderer.domElement);

// Light camera: orthographic projection for directional light shadow map
const SHADOW_SIZE = 1024;
const lightExtent = 6;
const lightCamera = new OrthographicCamera(
    -lightExtent, lightExtent,
    lightExtent, -lightExtent,
    0.1, 30,
);
lightCamera.position = [5, 8, 6];
lightCamera.lookAt([0, 0, 0]);

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

// ─── Shadow render target (depth-only, count: 0) ───────────────────────────

const shadowRT = new RenderTarget(SHADOW_SIZE, SHADOW_SIZE, {
    depthFormat: 'depth32float',
    count: 0,
});

// ─── Shared vertex transform nodes ─────────────────────────────────────────

const pos = attribute('position', d.vec3f);
const norm = attribute('normal', d.vec3f);

// Standard vertex transform: model → world → view → clip
const localPos = vec4(pos, f32(1));
const worldPos = mul(modelWorldMatrix, localPos);
const viewPos = mul(cameraViewMatrix, worldPos);
const clipPos = mul(cameraProjectionMatrix, viewPos);

// ─── Shadow pass material (depth-only, no fragment) ─────────────────────────

const shadowMaterial = new Material({
    vertex: clipPos,
    fragment: null,
    depthBias: 0,
    depthBiasSlopeScale: 0,
});

// ─── Scene pass material (with shadow sampling) ─────────────────────────────

// Light-space projection matrix: lightProj * lightView (computed on CPU, uploaded as uniform)
const lightVPUniform = new Uniform(d.mat4x4f, new Float32Array(16));
const lightVP = uniform(lightVPUniform);

// Compute world position varying for light-space projection in fragment
const vWorldPos = varying(worldPos.xyz, 'v_worldPos');

// World-space normal for basic lighting
const worldNorm = mul(modelNormalMatrix, vec3(norm.x, norm.y, norm.z));
const vWorldNorm = varying(normalize(worldNorm), 'v_worldNorm');

// Shadow map sampling
const shadowDepthTex = depthTexture(shadowRT.depthTexture!);
const shadowCmpSampler = comparisonSampler(shadowRT.depthTexture!, 'less');

// Light direction uniform: updated each frame from lightCamera.position.
// For a directional light, the direction is normalize(position) since it looks at the origin.
const lightDirUniform = new Uniform(d.vec3f, new Float32Array([5, 8, 6]));
const lightDir = normalize(uniform(lightDirUniform));

// Normal offset bias: nudge the world position along the surface normal before
// projecting into light space. The offset scales with the angle between the
// surface and the light — surfaces at grazing angles get more offset.
const normalBias = f32(0.1);
const cosTheta = vWorldNorm.dot(lightDir).max(f32(0.0));
const biasScale = f32(1.0).sub(cosTheta).mul(normalBias);
const biasedWorldPos = vWorldPos.add(vWorldNorm.mul(biasScale));

// In fragment shader: project biased world position into light clip space
const worldPosH = vec4(biasedWorldPos, f32(1));
const lightClip = mul(lightVP, worldPosH);

// Perspective divide to get light-space NDC
const lightNDC = lightClip.xyz.div(lightClip.w);

// Convert from NDC [-1,1] xy to UV [0,1], flip Y for texture coords
const shadowUV = vec2(
    lightNDC.x.mul(f32(0.5)).add(f32(0.5)),
    lightNDC.y.mul(f32(-0.5)).add(f32(0.5)),
);

// Depth reference (Z is already in [0,1] for WebGPU NDC with ZO projection)
const depthRef = lightNDC.z;

// 3x3 PCF: sample a grid around the shadow UV and average the results
const texelSize = f32(1.0 / SHADOW_SIZE);
const pcfSamples: Node<d.f32>[] = [];
for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
        const offsetUV = vec2(
            shadowUV.x.add(f32(dx).mul(texelSize)),
            shadowUV.y.add(f32(dy).mul(texelSize)),
        );
        pcfSamples.push(textureSampleCompare(
            shadowDepthTex.bindingNode,
            shadowCmpSampler,
            offsetUV as unknown as Node<d.vec2f>,
            depthRef as unknown as Node<d.f32>,
        ));
    }
}

// Average the 9 samples
let pcfResult = pcfSamples[0];
for (let i = 1; i < pcfSamples.length; i++) {
    pcfResult = pcfResult.add(pcfSamples[i]);
}
pcfResult = pcfResult.mul(f32(1.0 / 9.0));

// UV clamping: fragments outside the light frustum should be fully lit.
// Without this, sampling at out-of-range UVs produces garbage shadow values.
const outsideFrustum = or(
    or(lessThan(shadowUV.x, f32(0.0)), greaterThan(shadowUV.x, f32(1.0))),
    or(lessThan(shadowUV.y, f32(0.0)), greaterThan(shadowUV.y, f32(1.0))),
);
const shadowFactor = select(pcfResult, f32(1.0), outsideFrustum);

// Basic directional lighting (reuses lightDir uniform declared above)
const nDotL = vWorldNorm.dot(lightDir).max(f32(0.0));
const ambient = f32(0.15);
const diffuse = nDotL.mul(shadowFactor).add(ambient);

const baseColor = vec3(f32(0.8), f32(0.85), f32(0.9));
const litColor = baseColor.mul(diffuse);

const sceneMaterial = new Material({
    vertex: clipPos,
    fragment: vec4(litColor, f32(1)),
});

// ─── Scene setup ────────────────────────────────────────────────────────────

const scene = new Scene();
scene.add(camera);
scene.add(lightCamera);

// Ground plane (createPlaneGeometry is already XZ with Y-up normals)
const groundGeo = createPlaneGeometry(10, 10);
const groundMesh = new Mesh(groundGeo, sceneMaterial);
groundMesh.position = [0, -0.5, 0];
scene.add(groundMesh);

// Box
const boxGeo = createBoxGeometry(1, 1, 1);
const boxMesh = new Mesh(boxGeo, sceneMaterial);
boxMesh.position = [0, 0.5, 0];
scene.add(boxMesh);

// Sphere
const sphereGeo = createSphereGeometry(0.6, 32, 24);
const sphereMesh = new Mesh(sphereGeo, sceneMaterial);
sphereMesh.position = [-2, 0.6, 1];
scene.add(sphereMesh);

// Second box
const boxMesh2 = new Mesh(boxGeo, sceneMaterial);
boxMesh2.position = [1.5, 0.3, -1];
quat.fromEuler(boxMesh2.quaternion, [0, 0.4, 0.2, 'yxz'] as Euler);
scene.add(boxMesh2);

scene.updateWorldMatrix();
camera.updateViewMatrix();
lightCamera.updateViewMatrix();

// ─── Light camera frustum helper (wireframe via thin quads) ─────────────────

// 8 clip-space corners of an orthographic frustum (WebGPU NDC: Z in [0,1])
const clipCorners: Vec4[] = [
    // near plane (z=0)
    [-1, -1, 0, 1], [-1,  1, 0, 1], [ 1,  1, 0, 1], [ 1, -1, 0, 1],
    // far plane (z=1)
    [-1, -1, 1, 1], [-1,  1, 1, 1], [ 1,  1, 1, 1], [ 1, -1, 1, 1],
];

// 12 edges of a box: [cornerA, cornerB]
const edges: [number, number][] = [
    // near face
    [0, 1], [1, 2], [2, 3], [3, 0],
    // far face
    [4, 5], [5, 6], [6, 7], [7, 4],
    // connecting near to far
    [0, 4], [1, 5], [2, 6], [3, 7],
];

// Each edge becomes a thin quad (2 triangles, 6 vertices). 12 edges × 6 = 72 vertices.
const FRUSTUM_VERTEX_COUNT = edges.length * 6;
const frustumPositions = new Float32Array(FRUSTUM_VERTEX_COUNT * 3);
const frustumNormals = new Float32Array(FRUSTUM_VERTEX_COUNT * 3); // unused but required by vertex shader

const frustumGeo = new Geometry();
const frustumPosBuf = createVertexBuffer(d.vec3f, frustumPositions);
const frustumNormBuf = createVertexBuffer(d.vec3f, frustumNormals);
frustumGeo.setBuffer('position', frustumPosBuf);
frustumGeo.setBuffer('normal', frustumNormBuf);
frustumGeo.drawRange.count = FRUSTUM_VERTEX_COUNT;

const frustumMaterial = new Material({
    vertex: clipPos,
    fragment: vec4(vec3(f32(1.0), f32(0.8), f32(0.2)), f32(1)),
    cullMode: 'none',
});

const frustumMesh = new Mesh(frustumGeo, frustumMaterial);
scene.add(frustumMesh);

const LINE_THICKNESS = 0.03;

// Scratch arrays for unproject computation
const worldCorners: Vec4[] = clipCorners.map(() => [0, 0, 0, 0] as Vec4);
const invVP: Mat4 = mat4.create();

function updateFrustumGeometry(): void {
    // Compute inverse VP for the light camera
    const vp: Mat4 = mat4.create();
    mat4.mul(vp, lightCamera.projectionMatrix, lightCamera.matrixWorldInverse);
    mat4.invert(invVP, vp);

    // Unproject clip corners to world space
    for (let i = 0; i < clipCorners.length; i++) {
        v4.transformMat4(worldCorners[i], clipCorners[i], invVP);
        const w = worldCorners[i][3];
        worldCorners[i][0] /= w;
        worldCorners[i][1] /= w;
        worldCorners[i][2] /= w;
    }

    // Build thin quads for each edge
    let vi = 0;
    for (const [ai, bi] of edges) {
        const ax = worldCorners[ai][0], ay = worldCorners[ai][1], az = worldCorners[ai][2];
        const bx = worldCorners[bi][0], by = worldCorners[bi][1], bz = worldCorners[bi][2];

        // Edge direction
        const dx = bx - ax, dy = by - ay, dz = bz - az;

        // Pick a perpendicular direction for quad width.
        // Cross edge direction with an arbitrary axis (prefer Y-up, fallback to X).
        let px: number, py: number, pz: number;
        if (Math.abs(dy) > 0.99 * Math.sqrt(dx * dx + dy * dy + dz * dz)) {
            // Edge is nearly vertical — cross with X axis
            px = 0; py = -dz; pz = dy;
        } else {
            // Cross with Y axis
            px = dz; py = 0; pz = -dx;
        }
        // Normalize and scale to half-thickness
        const pl = Math.sqrt(px * px + py * py + pz * pz);
        const ht = LINE_THICKNESS / 2;
        px = (px / pl) * ht;
        py = (py / pl) * ht;
        pz = (pz / pl) * ht;

        // Quad corners: A-p, A+p, B+p, B-p
        const a0x = ax - px, a0y = ay - py, a0z = az - pz;
        const a1x = ax + px, a1y = ay + py, a1z = az + pz;
        const b1x = bx + px, b1y = by + py, b1z = bz + pz;
        const b0x = bx - px, b0y = by - py, b0z = bz - pz;

        // Triangle 1: A-p, B-p, B+p
        frustumPositions[vi++] = a0x; frustumPositions[vi++] = a0y; frustumPositions[vi++] = a0z;
        frustumPositions[vi++] = b0x; frustumPositions[vi++] = b0y; frustumPositions[vi++] = b0z;
        frustumPositions[vi++] = b1x; frustumPositions[vi++] = b1y; frustumPositions[vi++] = b1z;
        // Triangle 2: A-p, B+p, A+p
        frustumPositions[vi++] = a0x; frustumPositions[vi++] = a0y; frustumPositions[vi++] = a0z;
        frustumPositions[vi++] = b1x; frustumPositions[vi++] = b1y; frustumPositions[vi++] = b1z;
        frustumPositions[vi++] = a1x; frustumPositions[vi++] = a1y; frustumPositions[vi++] = a1z;
    }

    frustumPosBuf.needsUpdate = true;
}

// ─── Compute light VP matrix ────────────────────────────────────────────────

function updateLightVP(): void {
    const data = lightVPUniform.value as Float32Array;
    mat4.mul(data as unknown as Mat4, lightCamera.projectionMatrix, lightCamera.matrixWorldInverse);
}
updateLightVP();
updateFrustumGeometry();

// ─── Animation loop ─────────────────────────────────────────────────────────

let angle = 0;
let prevTime = performance.now() / 1000;

function frame() {
    const now = performance.now() / 1000;
    const dt = now - prevTime;
    prevTime = now;

    // Animate the main box
    angle += dt * 0.5;
    quat.fromEuler(boxMesh.quaternion, [0, angle, 0, 'yxz'] as Euler);
    boxMesh.updateWorldMatrix();

    // Orbit the light
    const lightAngle = now * 0.3;
    const lightRadius = 8;
    lightCamera.position = [
        Math.cos(lightAngle) * lightRadius,
        8,
        Math.sin(lightAngle) * lightRadius,
    ];
    lightCamera.lookAt([0, 0, 0]);
    lightCamera.updateWorldMatrix();
    lightCamera.updateViewMatrix();
    updateLightVP();
    updateFrustumGeometry();

    // Update light direction uniform (normalize on CPU — the GPU node also normalizes,
    // but we need to write a unit-ish vector so the uniform isn't huge)
    const lp = lightCamera.position;
    const ll = Math.sqrt(lp[0] * lp[0] + lp[1] * lp[1] + lp[2] * lp[2]);
    const ld = lightDirUniform.value as Float32Array;
    ld[0] = lp[0] / ll;
    ld[1] = lp[1] / ll;
    ld[2] = lp[2] / ll;

    controls.update();

    renderer.beginFrame();

    // Pass 1: shadow map (depth-only render into shadowRT)
    // Hide the frustum helper so it doesn't write into the shadow map
    frustumMesh.visible = false;
    renderer.renderTarget = shadowRT;
    renderer.overrideMaterial = shadowMaterial;
    renderer.render(scene, lightCamera, undefined, 'shadow');
    renderer.overrideMaterial = null;
    renderer.renderTarget = null;
    frustumMesh.visible = true;

    // Pass 2: scene with shadow sampling
    renderer.render(scene, camera);

    renderer.endFrame();
    requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
