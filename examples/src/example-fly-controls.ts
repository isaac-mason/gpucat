import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createBoxGeometry,
    createSphereGeometry,
    createCylinderGeometry,
    createPlaneGeometry,
    d,
    f32,
    FlyControls,
    Material,
    Mesh,
    modelNormalMatrix,
    modelWorldMatrix,
    mul,
    normalize,
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

/* renderer, scene, camera */

const renderer = new WebGPURenderer({ antialias: true });
await renderer.init();

document.body.appendChild(renderer.domElement);
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new Scene();

const camera = new PerspectiveCamera(
    Math.PI / 4,
    window.innerWidth / window.innerHeight,
    0.1,
    500,
);
camera.position[1] = 2;
camera.position[2] = 8;
scene.add(camera);

const flyControls = new FlyControls(camera, renderer.domElement);

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

/* shared vertex setup */

const position = attribute('position', d.vec3f);
const normal = attribute('normal', d.vec3f);

const worldPosition = mul(modelWorldMatrix, vec4(position, f32(1)));
const clipPosition = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPosition));

const vWorldNormal = varying(normalize(mul(modelNormalMatrix, normal)), 'vNormal');
const vertex = clipPosition;

const lightDirection = vec3(0.6, 1.0, 0.8).normalize();
const ambient = f32(0.2);
const diffuse = vWorldNormal.dot(lightDirection).max(f32(0));
const lighting = ambient.add(diffuse);

function makeMaterial(r: number, g: number, b: number): Material {
    const baseColor = vec3(r, g, b);
    const litColor = baseColor.mul(lighting);
    const fragment = vec4(litColor, f32(1));
    return new Material({ vertex, fragment });
}

/* ground plane */

const ground = new Mesh(createPlaneGeometry(100, 100), makeMaterial(0.25, 0.28, 0.25));
ground.quaternion[0] = -Math.SQRT1_2; // rotate -90 degrees around X to lay flat
ground.quaternion[3] = Math.SQRT1_2;
scene.add(ground);

/* scatter objects to fly around */

const boxGeom = createBoxGeometry(1, 1, 1);
const sphereGeom = createSphereGeometry(0.6, 24, 12);
const cylinderGeom = createCylinderGeometry(0.4, 0.4, 2, 16);

const colors: [number, number, number][] = [
    [0.4, 0.7, 1.0],
    [1.0, 0.4, 0.4],
    [0.4, 1.0, 0.5],
    [1.0, 0.85, 0.3],
    [0.7, 0.4, 1.0],
    [1.0, 0.6, 0.2],
];

const geometries = [boxGeom, sphereGeom, cylinderGeom];

// pseudo-random seeded generator for deterministic layout
let seed = 42;
function rand(): number {
    seed = (seed * 16807 + 0) % 2147483647;
    return (seed - 1) / 2147483646;
}

for (let i = 0; i < 60; i++) {
    const geom = geometries[Math.floor(rand() * geometries.length)];
    const color = colors[Math.floor(rand() * colors.length)];
    const mesh = new Mesh(geom, makeMaterial(...color));

    const radius = 5 + rand() * 40;
    const angle = rand() * Math.PI * 2;
    mesh.position[0] = Math.cos(angle) * radius;
    mesh.position[1] = 0.5 + rand() * 3;
    mesh.position[2] = Math.sin(angle) * radius;

    const s = 0.5 + rand() * 2;
    mesh.scale[0] = s;
    mesh.scale[1] = s;
    mesh.scale[2] = s;

    scene.add(mesh);
}

/* HUD */

const hud = document.createElement('div');
hud.style.cssText = 'position:fixed;bottom:12px;left:12px;color:#fff;font:13px/1.5 monospace;background:rgba(0,0,0,0.6);padding:8px 12px;border-radius:4px;pointer-events:none;';
hud.innerHTML = `
<b>WASD</b> move &nbsp; <b>Space</b> up &nbsp; <b>Shift</b> down<br>
<b>Right-click + drag</b> look &nbsp; <b>Scroll</b> adjust speed
`.trim();
document.body.appendChild(hud);

/* render loop */

scene.updateWorldMatrix();
camera.updateViewMatrix();

const scenePass = pass(scene, camera);
const outputNode = renderOutput(scenePass.getTextureNode());
const renderPipeline = new RenderPipeline(renderer, outputNode);

let prevTime = performance.now() / 1000;

function frame() {
    const now = performance.now() / 1000;
    const delta = now - prevTime;
    prevTime = now;

    flyControls.update(delta);
    scene.updateWorldMatrix();

    renderer.beginFrame();
    renderPipeline.render();
    renderer.endFrame();
    requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
