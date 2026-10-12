import * as g from 'gpucat';
import { d, GpuBuffer } from 'gpucat';

/*
 * Boxes appear along a spiral, each one appended to a `cpu: false` storage buffer with writeBuffer.
 * When the buffer is full, a buffer twice the size takes its place: copyBuffer moves what is there on
 * the GPU, and the geometry's named buffer swaps to the new one.
 */

const MAX_INSTANCES = 4096;
const SPAWN_PER_SECOND = 120;

/* xyz position, w a colour phase */
const instances = g.storage('instances', d.array(d.vec4f));
const instance = g.index(instances, g.instanceIndex);

const position = g.attribute('position', d.vec3f);
const normal = g.attribute('normal', d.vec3f);
const world = g.vec4(position.mul(g.f32(0.35)).add(instance.xyz), g.f32(1));
const clip = g.mul(g.cameraProjectionMatrix, g.mul(g.cameraViewMatrix, world));

const phase = g.varying(instance.w, 'vPhase');
const light = g.varying(normal.dot(g.vec3f(0.4, 0.8, 0.45).normalize()).max(g.f32(0.2)), 'vLight');
const palette = g
    .vec3f(0, 0.33, 0.67)
    .add(phase)
    .mul(g.f32(Math.PI * 2))
    .cos()
    .mul(g.f32(0.5))
    .add(g.f32(0.5));
const material = new g.Material({ vertex: clip, fragment: g.vec4(palette.mul(light), g.f32(1)) });

const geometry = g.createBoxGeometry(1, 1, 1);
let capacity = 16;
let buffer = new GpuBuffer(d.array(d.vec4f), { count: capacity, usage: 'storage', cpu: false, label: 'instances' });
geometry.setBuffer('instances', buffer);

const mesh = new g.Mesh(geometry, material);
mesh.count = 0;

/* setup renderer and scene */

const canvas = document.createElement('canvas');
canvas.style.display = 'block';
document.body.appendChild(canvas);

const label = document.createElement('div');
label.style.cssText = 'position:fixed;left:12px;bottom:12px;color:#fff;font:13px ui-monospace,monospace;';
document.body.appendChild(label);

const view = g.createCanvasTarget(canvas, { samples: 4 });
view.setPixelRatio(devicePixelRatio);
view.setSize(window.innerWidth, window.innerHeight);

const renderer = await g.init(g.webgpu());

const scene = new g.Scene();
const camera = new g.PerspectiveCamera(Math.PI / 4, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position[1] = 24;
camera.position[2] = 34;
camera.lookAt([0, 0, 0]);
scene.add(camera);
scene.add(mesh);
scene.updateWorldMatrix();
camera.updateViewMatrix();

window.addEventListener('resize', () => {
    view.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

/** doubles the buffer: the new one is filled from the old on the GPU, then takes its name on the geometry. */
function grow(): void {
    const grown = new GpuBuffer(d.array(d.vec4f), { count: capacity * 2, usage: 'storage', cpu: false, label: 'instances' });
    g.copyBuffer(renderer, buffer, grown);
    geometry.setBuffer('instances', grown);
    buffer.dispose();
    buffer = grown;
    capacity *= 2;
}

const slot = new Float32Array(4);

function spawn(i: number): void {
    if (i === capacity) grow();
    const angle = i * 0.137;
    const radius = Math.sqrt(i) * 0.4;
    slot[0] = Math.cos(angle) * radius;
    slot[1] = Math.sin(i * 0.05) * 0.6;
    slot[2] = Math.sin(angle) * radius;
    slot[3] = i / 600;
    g.writeBuffer(renderer, buffer, i * 16, slot);
}

let start = performance.now();
function update() {
    const due = Math.min(MAX_INSTANCES, Math.floor(((performance.now() - start) / 1000) * SPAWN_PER_SECOND));
    while (mesh.count < due) spawn(mesh.count++);
    if (mesh.count === MAX_INSTANCES) {
        start = performance.now();
        mesh.count = 0;
    }
    label.textContent = `${mesh.count} instances in a buffer of ${capacity}`;

    const f = g.frame(renderer);
    const pass = f.pass({ target: view, camera, clear: [0.06, 0.06, 0.08, 1] });
    g.drawScene(renderer, pass, scene, camera);
    pass.end();
    f.submit();
    requestAnimationFrame(update);
}

requestAnimationFrame(update);
