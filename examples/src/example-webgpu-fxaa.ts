import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createBoxGeometry,
    createCanvasTarget,
    createMaterial,
    d,
    f32,
    frame,
    fullscreen,
    fxaa,
    Inspector,
    init,
    Mesh,
    modelWorldMatrix,
    mul,
    PerspectiveCamera,
    renderTexture,
    Scene,
    varying,
    vec3,
    vec4,
    webgpu,
} from 'gpucat';
import { type Euler, quat } from 'math';

/**
 * FXAA Example
 *
 * Demonstrates the FXAA (Fast Approximate Anti-Aliasing) post-processing effect.
 * The scene renders a rotating cube with high-contrast edges to showcase
 * the anti-aliasing effect.
 *
 * Compare the aliased edges (jaggies) on the cube with FXAA disabled vs
 * the smoothed edges with FXAA enabled.
 */

const canvas = document.createElement('canvas');
canvas.style.display = 'block';
document.body.appendChild(canvas);

const view = createCanvasTarget(canvas);
view.setPixelRatio(devicePixelRatio);
view.setSize(window.innerWidth, window.innerHeight);

const renderer = await init(webgpu());
renderer.inspector = new Inspector();

document.body.appendChild((renderer.inspector as Inspector).domElement);

const scene = new Scene();

const camera = new PerspectiveCamera(Math.PI / 4, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position[2] = 4;
scene.add(camera);
scene.updateWorldMatrix();
camera.updateViewMatrix();

window.addEventListener('resize', () => {
    view.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

/* material - simple colored cube with high contrast */

const pos = attribute('position', d.vec3f);

// vertex shader: transform to clip space
const localPos = vec4(pos, f32(1));
const worldPos = mul(modelWorldMatrix, localPos);
const viewPos = mul(cameraViewMatrix, worldPos);
const clipPos = mul(cameraProjectionMatrix, viewPos);

const vWorldPos = varying(worldPos);

// fragment: use world position as color for high contrast edges
const outputColor = vec4(
    vec3(vWorldPos.x.add(f32(1)).mul(f32(0.5)), vWorldPos.y.add(f32(1)).mul(f32(0.5)), vWorldPos.z.add(f32(1)).mul(f32(0.5))),
    f32(1),
);

const mat = createMaterial({
    vertex: clipPos,
    fragment: outputColor,
    cullMode: 'back',
});

// create cube geometry
const geometry = createBoxGeometry(1, 1, 1);

// create mesh
const mesh = new Mesh(geometry, mat);
scene.add(mesh);

/* post-processing with FXAA */

// scene pass renders to texture
const scenePass = renderTexture(scene, camera);
const sceneTexture = scenePass.getTextureNode();

// apply FXAA to the scene texture
const fxaaOutput = fxaa(sceneTexture).inspect('FXAA Output');

// create render pipeline
const composite = fullscreen(fxaaOutput);
/* inspector: FXAA toggle */

const inspector = renderer.inspector as Inspector;
const params = inspector.createParameters('FXAA');
const state = { enabled: true };
params
    .add(state, 'enabled')
    .name('Enabled')
    .onChange(() => {
        composite.material.fragment = state.enabled ? fxaaOutput : scenePass;
        composite.material.needsUpdate = true;
    });

/* animation loop */

let angle = 0;
let prevTime = performance.now() / 1000;

function update() {
    const now = performance.now() / 1000;
    const dt = now - prevTime;
    prevTime = now;

    angle += dt * 0.5;

    quat.fromEuler(mesh.quaternion, [angle * 0.3, angle, 0, 'yxz'] as Euler);
    mesh.updateWorldMatrix();

    const f = frame(renderer);

    const compositePass = f.pass({ target: view });

    compositePass.draw(composite);

    compositePass.end();

    f.submit();
    requestAnimationFrame(update);
}

requestAnimationFrame(update);
