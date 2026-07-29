import {
    attribute, cameraProjectionMatrix, cameraViewMatrix, createPlaneGeometry, createSphereGeometry,
    d, f32, dot, length, max, mul, normalize, struct, storage, createStorageBuffer, packArray,
    Fn, Var, Loop, varying, vec3, vec4, Material, Mesh, modelNormalMatrix, modelWorldMatrix,
    Scene, PerspectiveCamera, OrbitControls, pass, renderOutput, RenderPipeline, WebGPURenderer,
} from 'gpucat';
import { quat } from 'mathcat';

/*
 * Lights are not a built-in. gpucat ships no Light object and no shading model;
 * lighting is math you write in the fragment graph. Here a handful of coloured
 * point lights live in a storage buffer, the fragment loops over them and sums a
 * simple diffuse + distance falloff, and the CPU re-packs the buffer each frame to
 * orbit them. Swap in your own model (specular, point vs spot, etc.) freely.
 */

const LIGHT_COUNT = 3;
const LIGHT_RADIUS = 10;   // distance at which a light fades to zero
const ORBIT = 5;           // how far the lights orbit from the centre
const HEIGHT = 3;          // how high they float

/* the light buffer: an array of { position, colour } structs */

const Light = struct('Light', { position: d.vec3f, color: d.vec3f });

const lightData: { position: [number, number, number]; color: [number, number, number] }[] = [
    { position: [0, HEIGHT, 0], color: [4.0, 0.5, 0.5] },   // warm
    { position: [0, HEIGHT, 0], color: [0.5, 4.0, 0.6] },   // green
    { position: [0, HEIGHT, 0], color: [0.5, 0.6, 4.0] },   // blue
];

const lightBuffer = createStorageBuffer(d.array(Light), new Float32Array(packArray(Light, lightData)));
const lights = storage(lightBuffer, 'read');

/* material: one lit material, shared by the floor and the spheres */

const position = attribute('position', d.vec3f);
const normal = attribute('normal', d.vec3f);

const worldPosition = mul(modelWorldMatrix, vec4(position, f32(1)));
const clipPosition = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPosition));

const vWorldPos = varying(worldPosition.xyz, 'vWorldPos');
const vWorldNormal = varying(normalize(mul(modelNormalMatrix, normal)), 'vWorldNormal');

const baseColor = vec3(0.8, 0.8, 0.82);

// the loop over lights needs control flow, so it lives in an Fn (also keeps it
// reusable). sum each light's contribution: colour * N.L * distance falloff.
const computeLighting = Fn((worldPos, n) => {
    const lighting = Var('lighting', vec3(0.04, 0.04, 0.06));   // ambient
    Loop(LIGHT_COUNT, ({ i }) => {
        const l = lights.element(i).fields();
        const toLight = l.position.sub(worldPos);
        const dist = Var('dist', length(toLight));
        const dir = normalize(toLight);
        const ndotl = max(dot(n, dir), f32(0));
        const falloff = max(f32(1).sub(dist.mul(f32(1 / LIGHT_RADIUS))), f32(0));
        lighting.addAssign(l.color.mul(ndotl).mul(falloff.mul(falloff)));
    });
    return lighting;
}, {
    name: 'computeLighting',
    params: [{ name: 'worldPos', type: d.vec3f }, { name: 'n', type: d.vec3f }],
    return: d.vec3f,
});

const fragment = vec4(baseColor.mul(computeLighting(vWorldPos, normalize(vWorldNormal))), f32(1));
const material = new Material({ vertex: clipPosition, fragment });

/* renderer + scene */

const renderer = new WebGPURenderer({ antialias: true });
await renderer.init();
document.body.appendChild(renderer.domElement);
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new Scene();
const camera = new PerspectiveCamera(Math.PI / 4, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position[0] = 0;
camera.position[1] = 8;
camera.position[2] = 14;
scene.add(camera);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// ground plane, laid flat
const floor = new Mesh(createPlaneGeometry(40, 40), material);
quat.fromEuler(floor.quaternion, [-Math.PI / 2, 0, 0, 'xyz']);
floor.updateWorldMatrix();
scene.add(floor);

// a grid of spheres for the lights to travel across
const sphereGeom = createSphereGeometry(0.7, 24, 16);
const GRID = 5;
const SPACING = 2.6;
for (let x = 0; x < GRID; x++) {
    for (let z = 0; z < GRID; z++) {
        const sphere = new Mesh(sphereGeom, material);
        sphere.position[0] = (x - (GRID - 1) / 2) * SPACING;
        sphere.position[1] = 0.7;
        sphere.position[2] = (z - (GRID - 1) / 2) * SPACING;
        sphere.updateWorldMatrix();
        scene.add(sphere);
    }
}

camera.updateViewMatrix();

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

/* render loop: orbit the lights by re-packing the buffer each frame */

const scenePass = pass(scene, camera);
const renderPipeline = new RenderPipeline(renderer, renderOutput(scenePass.getTextureNode()));

function frame() {
    const t = performance.now() / 1000;
    for (let i = 0; i < LIGHT_COUNT; i++) {
        const a = t * 0.6 + (i * Math.PI * 2) / LIGHT_COUNT;
        lightData[i].position[0] = Math.cos(a) * ORBIT;
        lightData[i].position[1] = HEIGHT;
        lightData[i].position[2] = Math.sin(a) * ORBIT;
    }
    lightBuffer.array!.set(new Float32Array(packArray(Light, lightData)));
    lightBuffer.needsUpdate = true;

    controls.update();
    renderPipeline.render();
    requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
