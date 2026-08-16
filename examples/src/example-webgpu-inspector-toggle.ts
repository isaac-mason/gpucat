// Inspector mount/unmount stress test.
//
// Attaching the inspector allocates GPU resources on the renderer's device
// (timestamp query set + on-demand readback buffers, and a probe depth texture if
// a probe is opened); detaching releases them. Those releases must drain in-flight
// GPU work before destroying, or the device can be lost ("A valid external Instance
// reference no longer exists"), which black-screens the whole canvas.
//
// This example toggles the inspector on and off — manually or on an interval — while
// the scene keeps rendering, so teardown regularly races in-flight timestamp
// readbacks. If a toggle loses the device, the banner turns red. Left running in
// auto mode it's a soak test: the banner should stay green indefinitely.

import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createBoxGeometry,
    d,
    type DeviceLostInfo,
    f32,
    Inspector,
    Material,
    Mesh,
    modelNormalMatrix,
    modelWorldMatrix,
    mul,
    normalize,
    OrbitControls,
    pass,
    PerspectiveCamera,
    RenderPipeline,
    renderOutput,
    Scene,
    varying,
    vec3,
    vec4,
    WebGPURenderer,
} from 'gpucat';
import { quat } from 'math';

/* create renderer, scene, camera */

const renderer = new WebGPURenderer({ antialias: true });
await renderer.init();

document.body.appendChild(renderer.domElement);
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new Scene();

const camera = new PerspectiveCamera(Math.PI / 4, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position[2] = 4;
scene.add(camera);

const controls = new OrbitControls(camera, renderer.domElement);

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

/* spinning cube */

const geometry = createBoxGeometry(1, 1, 1);

const position = attribute('position', d.vec3f);
const normal = attribute('normal', d.vec3f);

const worldPosition = mul(modelWorldMatrix, vec4(position, f32(1)));
const clipPosition = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPosition));
const vWorldNormal = varying(normalize(mul(modelNormalMatrix, normal)), 'vNormal');

const vertex = clipPosition;

const lightDirection = vec3(0.6, 1.0, 0.8).normalize();
const ambient = f32(0.15);
const diffuse = vWorldNormal.dot(lightDirection).max(f32(0));
const lighting = ambient.add(diffuse);
const litColor = vec3(0.4, 0.7, 1.0).mul(lighting);
const fragment = vec4(litColor, f32(1));

const material = new Material({ vertex, fragment });
const mesh = new Mesh(geometry, material);
scene.add(mesh);

scene.updateWorldMatrix();
camera.updateViewMatrix();

/* device-loss surfacing: the whole point of the test */

let deviceLost: DeviceLostInfo | null = null;
renderer.onDeviceLost = (info) => {
    deviceLost = info;
    render();
};

/* inspector mount / unmount */

let toggles = 0;

function mountInspector(): void {
    if (renderer.inspector) return;
    // Attaching allocates the inspector's GPU resources on this device. It also
    // self-attaches its panel into the canvas parent (here, the document body).
    renderer.inspector = new Inspector();
    render();
}

function unmountInspector(): void {
    if (!renderer.inspector) return;
    // Detaching runs the drain-then-destroy teardown; this is the path under test.
    renderer.inspector = null;
    render();
}

function toggleInspector(): void {
    if (renderer.inspector) unmountInspector();
    else mountInspector();
    toggles++;
    render();
}

/* auto-toggle (soak) */

let autoTimer: ReturnType<typeof setInterval> | null = null;
let autoIntervalMs = 250;

function setAuto(on: boolean): void {
    if (autoTimer) {
        clearInterval(autoTimer);
        autoTimer = null;
    }
    if (on) autoTimer = setInterval(toggleInspector, autoIntervalMs);
    render();
}

/* controls overlay */

const panel = document.createElement('div');
panel.style.cssText =
    'position:fixed;top:12px;left:12px;z-index:10;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
    'background:rgba(0,0,0,0.72);color:#fff;padding:12px;border-radius:6px;min-width:240px;user-select:none;';
document.body.appendChild(panel);

const status = document.createElement('div');
status.style.cssText = 'padding:6px 8px;border-radius:4px;margin-bottom:10px;font-weight:600;';

const toggleBtn = document.createElement('button');
toggleBtn.textContent = 'toggle inspector';
toggleBtn.style.cssText = 'display:block;width:100%;margin-bottom:8px;padding:8px;cursor:pointer;';
toggleBtn.onclick = toggleInspector;

const autoLabel = document.createElement('label');
autoLabel.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;cursor:pointer;';
const autoBox = document.createElement('input');
autoBox.type = 'checkbox';
autoBox.onchange = () => setAuto(autoBox.checked);
autoLabel.append(autoBox, document.createTextNode('auto-toggle (soak)'));

const rangeLabel = document.createElement('label');
rangeLabel.style.cssText = 'display:block;margin-bottom:8px;';
const range = document.createElement('input');
range.type = 'range';
range.min = '60';
range.max = '1000';
range.step = '10';
range.value = String(autoIntervalMs);
range.style.cssText = 'width:100%;';
range.oninput = () => {
    autoIntervalMs = Number(range.value);
    if (autoTimer) setAuto(true); // re-arm at the new cadence
    render();
};
rangeLabel.append(range);

const counter = document.createElement('div');
counter.style.cssText = 'opacity:0.75;font-size:12px;';

panel.append(status, toggleBtn, autoLabel, rangeLabel, counter);

function render(): void {
    if (deviceLost) {
        status.textContent = `DEVICE LOST (${deviceLost.api}${deviceLost.reason ? `: ${deviceLost.reason}` : ''})`;
        status.style.background = '#a11';
        toggleBtn.disabled = true;
        autoBox.disabled = true;
        if (autoTimer) {
            clearInterval(autoTimer);
            autoTimer = null;
        }
    } else {
        status.textContent = renderer.inspector ? 'device alive — inspector MOUNTED' : 'device alive — inspector unmounted';
        status.style.background = '#161';
    }
    counter.textContent = `toggles: ${toggles} · cadence: ${autoIntervalMs}ms`;
}

render();

/* render loop */

const scenePass = pass(scene, camera);
const outputNode = renderOutput(scenePass.getTextureNode());
const renderPipeline = new RenderPipeline(renderer, outputNode);

let angle = 0;
let prevTime = performance.now() / 1000;

function frame(): void {
    if (deviceLost) return; // stop driving a dead device

    const now = performance.now() / 1000;
    const dt = now - prevTime;
    prevTime = now;

    angle += dt * 0.8;
    quat.fromEuler(mesh.quaternion, [angle * 0.6, angle, 0, 'xyz']);
    mesh.updateWorldMatrix();

    controls.update();
    renderPipeline.render();
    requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
