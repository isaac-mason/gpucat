/* SNIPPET_START: spinning-cube */
import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createBoxGeometry,
    createCanvasTarget,
    createMaterial,
    createMesh,
    createScene,
    createStorageBuffer,
    d,
    Fn,
    f32,
    frame,
    fullscreen,
    globalId,
    index,
    init,
    instanceIndex,
    modelNormalMatrix,
    modelWorldMatrix,
    mul,
    normalize,
    PerspectiveCamera,
    renderOutput,
    renderTexture,
    storage,
    varying,
    vec3,
    vec4,
    webgpu,
} from 'gpucat';
import { quat } from 'math';

// renderer: the canvas is yours, and a pass names it as its target
const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const view = createCanvasTarget(canvas, { samples: 4 });
view.setPixelRatio(devicePixelRatio);
view.setSize(window.innerWidth, window.innerHeight);

const renderer = await init(webgpu());

// scene + camera
const scene = createScene();
const camera = new PerspectiveCamera(Math.PI / 4, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position[2] = 4;
scene.add(camera);

// vertex: project the cube into clip space, varying the world-space normal
const position = attribute('position', d.vec3f);
const normal = attribute('normal', d.vec3f);
const worldPosition = mul(modelWorldMatrix, vec4(position, f32(1)));
const clipPosition = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPosition));
const vWorldNormal = varying(normalize(mul(modelNormalMatrix, normal)), 'vNormal');

// fragment: simple Lambert shading
const lightDirection = vec3(0.6, 1.0, 0.8).normalize();
const diffuse = vWorldNormal.dot(lightDirection).max(f32(0));
const lighting = f32(0.15).add(diffuse);
const litColor = vec3(0.4, 0.7, 1.0).mul(lighting);

// mesh
const material = createMaterial({ vertex: clipPosition, fragment: vec4(litColor, f32(1)) });
const mesh = createMesh(createBoxGeometry(1, 1, 1), material);
scene.add(mesh);

// one fullscreen draw of the scene pass's output
const scenePass = renderTexture(scene, camera);
const composite = fullscreen(renderOutput(scenePass.getTextureNode()));

// frame loop
let angle = 0;
let prevTime = performance.now() / 1000;

function update() {
    const now = performance.now() / 1000;
    const dt = now - prevTime;
    prevTime = now;

    angle += dt * 0.8;
    quat.fromEuler(mesh.quaternion, [angle * 0.6, angle, 0, 'xyz']);
    mesh.updateWorldMatrix();
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    const f = frame(renderer);
    const compositePass = f.pass({ target: view });
    compositePass.draw(composite);
    compositePass.end();
    f.submit();

    requestAnimationFrame(update);
}

requestAnimationFrame(update);
/* SNIPPET_END: spinning-cube */

/* SNIPPET_START: gpu-compute */
const PARTICLES = 1024;

const particles = storage(createStorageBuffer(d.array(d.vec4f), new Float32Array(PARTICLES * 4)), 'read_write');

const sim = Fn(() => {
    const p = index(particles, globalId.x);
    index(particles, globalId.x).assign(p.add(vec4(0, 0.01, 0, 0)));
}).compute({ workgroupSize: [64, 1, 1] });

// a material reading the same buffer draws what the kernel just wrote
const particleMaterial = createMaterial({
    vertex: mul(cameraProjectionMatrix, mul(cameraViewMatrix, index(particles, instanceIndex))),
    fragment: vec4(1, 1, 1, 1),
});
const particleMesh = createMesh(createBoxGeometry(0.02, 0.02, 0.02), particleMaterial);

// compute and draw record onto one encoder, so the whole step is a single submission
const computeFrame = frame(renderer);

const simPass = computeFrame.compute();
simPass.dispatch(sim, [Math.ceil(PARTICLES / 64), 1, 1]);
simPass.end();

const particlePass = computeFrame.pass({ target: view, camera });
particlePass.draw(particleMesh, { instances: PARTICLES });
particlePass.end();

computeFrame.submit();
/* SNIPPET_END: gpu-compute */
