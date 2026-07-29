import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createBoxGeometry,
    d,
    f32,
    Material,
    Mesh,
    modelNormalMatrix,
    modelWorldMatrix,
    mul,
    normalize,
    OrbitControls,
    pass,
    PerspectiveCamera,
    Scene,
    texture,
    Texture,
    varying,
    vec3,
    vec4,
    WebGPURenderer,
} from 'gpucat';
import { quat, type Euler } from 'mathcat';

const renderer = new WebGPURenderer({ antialias: true });
await renderer.init();

document.body.appendChild(renderer.domElement);
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);

// ── Shared geometry & vertex transform ───────────────────────────────────

const geometry = createBoxGeometry(1, 1, 1);

const position = attribute('position', d.vec3f);
const normal = attribute('normal', d.vec3f);
const uvAttr = attribute('uv', d.vec2f);

const worldPos = mul(modelWorldMatrix, vec4(position, f32(1)));
const clipPos = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPos));

const worldNormal = varying(normalize(mul(modelNormalMatrix, normal)), 'vNormal');
const vUv = varying(uvAttr, 'vUv');

const lightDir = vec3(0.6, 1.0, 0.8).normalize();

// ── Inner scene (rendered to texture via pass()) ─────────────────────────

const pixels = new Uint8Array([191, 25, 54, 255, 96, 18, 54, 255, 96, 18, 54, 255, 37, 13, 53, 255]);
const imgData = new ImageData(new Uint8ClampedArray(pixels.buffer), 2, 2);
const bitmap = await createImageBitmap(imgData);
const dataTexture = new Texture(bitmap);
dataTexture.magFilter = 'nearest';
dataTexture.minFilter = 'nearest';
dataTexture.needsUpdate = true;

const texNode = texture(dataTexture);
const texColor = texNode.sample(vUv);

const innerDiffuse = worldNormal.dot(lightDir).max(f32(0));
const innerLighting = f32(0.2).add(innerDiffuse);
const innerLitColor = texColor.xyz.mul(innerLighting);

const innerMaterial = new Material({
    vertex: clipPos,
    fragment: vec4(innerLitColor, f32(1)),
});

const innerScene = new Scene();

const innerCamera = new PerspectiveCamera(Math.PI / 4, 1, 0.1, 100);
innerCamera.position[2] = 15;
innerScene.add(innerCamera);

const innerMesh = new Mesh(geometry, innerMaterial);
innerScene.add(innerMesh);

innerScene.updateWorldMatrix();
innerCamera.updateViewMatrix();

// pass() renders the inner scene to an offscreen render target automatically
const innerPass = pass(innerScene, innerCamera, {
    clearColor: [0.15, 0.05, 0.2, 1],
});
const passTextureNode = innerPass.getTextureNode();

// ── Outer scene (samples the pass output) ────────────────────────────────

const sampledRT = passTextureNode.sample(vUv);

const outerDiffuse = worldNormal.dot(lightDir).max(f32(0));
const outerLighting = f32(0.2).mul(outerDiffuse);

// Combine sampled texture with lighting and a subtle UV-based tint (like the OGL example)
const uvTint = vec3(vUv.x.sub(f32(0.5)), vUv.y.sub(f32(0.5)), f32(0)).mul(f32(0.1));
const outerColor = sampledRT.xyz.add(outerLighting).add(uvTint);

const outerMaterial = new Material({
    vertex: clipPos,
    fragment: vec4(outerColor, f32(1)),
});

const outerScene = new Scene();

const outerCamera = new PerspectiveCamera(
    Math.PI / 4,
    window.innerWidth / window.innerHeight,
    0.1,
    100,
);
outerCamera.position[2] = 5;
outerScene.add(outerCamera);

const controls = new OrbitControls(outerCamera, renderer.domElement);

const outerMesh = new Mesh(geometry, outerMaterial);
outerScene.add(outerMesh);

outerScene.updateWorldMatrix();
outerCamera.updateViewMatrix();

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    const aspect = window.innerWidth / window.innerHeight;
    outerCamera.aspect = aspect;
    outerCamera.updateProjectionMatrix();
});

// ── Animation loop ───────────────────────────────────────────────────────

let prevTime = performance.now() / 1000;
let innerAngle = 0;
let outerAngle = 0;

function frame() {
    const now = performance.now() / 1000;
    const dt = now - prevTime;
    prevTime = now;

    // Inner cube: fast spin
    innerAngle += dt * 1.2;
    quat.fromEuler(innerMesh.quaternion, [innerAngle * 0.6, innerAngle, 0, 'xyz'] as Euler);
    innerMesh.updateWorldMatrix();

    // Outer cube: slow tumble
    outerAngle += dt * 0.3;
    quat.fromEuler(outerMesh.quaternion, [outerAngle, outerAngle * 0.5, 0, 'xyz'] as Euler);
    outerMesh.updateWorldMatrix();

    controls.update();


    // Single render call — PassNode.updateBefore() automatically renders
    // the inner scene to its offscreen target before the outer scene draws.
    renderer.clearColor = [1, 1, 1, 1];
    renderer.render(outerScene, outerCamera);


    requestAnimationFrame(frame);
}

requestAnimationFrame(frame);