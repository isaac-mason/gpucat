import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createBoxGeometry,
    createCanvasTarget,
    createMaterial,
    d,
    drawScene,
    f32,
    frame,
    init,
    Mesh,
    modelNormalMatrix,
    modelWorldMatrix,
    mul,
    normalize,
    OrbitControls,
    PerspectiveCamera,
    renderTexture,
    Scene,
    Texture,
    texture,
    varying,
    vec3,
    vec4,
    webgpu,
} from 'gpucat';
import { type Euler, quat } from 'math';

const canvas = document.createElement('canvas');
canvas.style.display = 'block';
document.body.appendChild(canvas);

const view = createCanvasTarget(canvas, { samples: 4 });
view.setPixelRatio(devicePixelRatio);
view.setSize(window.innerWidth, window.innerHeight);

const renderer = await init(webgpu());

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

// ── Inner scene (rendered to texture via renderTexture()) ─────────────────────────

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

const innerMaterial = createMaterial({
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

// renderTexture() renders the inner scene to an offscreen render target automatically
const innerPass = renderTexture(innerScene, innerCamera, {
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

const outerMaterial = createMaterial({
    vertex: clipPos,
    fragment: vec4(outerColor, f32(1)),
});

const outerScene = new Scene();

const outerCamera = new PerspectiveCamera(Math.PI / 4, window.innerWidth / window.innerHeight, 0.1, 100);
outerCamera.position[2] = 5;
outerScene.add(outerCamera);

const controls = new OrbitControls(outerCamera, canvas);

const outerMesh = new Mesh(geometry, outerMaterial);
outerScene.add(outerMesh);

outerScene.updateWorldMatrix();
outerCamera.updateViewMatrix();

window.addEventListener('resize', () => {
    view.setSize(window.innerWidth, window.innerHeight);
    const aspect = window.innerWidth / window.innerHeight;
    outerCamera.aspect = aspect;
    outerCamera.updateProjectionMatrix();
});

// ── Animation loop ───────────────────────────────────────────────────────

let prevTime = performance.now() / 1000;
let innerAngle = 0;
let outerAngle = 0;

function update() {
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

    // One pass — the inner scene's RenderTextureNode records its own pass on this frame, before this one
    // encodes, because preparing a draw evaluates the graph it depends on.
    const f = frame(renderer);
    const outerPass = f.pass({ target: view, camera: outerCamera, clear: [1, 1, 1, 1] });
    drawScene(renderer, outerPass, outerScene, outerCamera);
    outerPass.end();
    f.submit();

    requestAnimationFrame(update);
}

requestAnimationFrame(update);
