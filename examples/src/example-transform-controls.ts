import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createBoxGeometry,
    createSphereGeometry,
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
    RenderPipeline,
    renderOutput,
    Scene,
    TransformControls,
    varying,
    vec3,
    vec4,
    WebGPURenderer,
} from 'gpucat';
import { transform } from 'mathcat/dist/plane3';

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
    100,
);
camera.position[2] = 5;
camera.position[1] = 2;
scene.add(camera);

const orbitControls = new OrbitControls(camera, renderer.domElement);

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

/* shared material: lit diffuse */

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

/* meshes */

const boxGeom = createBoxGeometry(1, 1, 1);
const sphereGeom = createSphereGeometry(0.6, 32, 16);

const box = new Mesh(boxGeom, makeMaterial(0.4, 0.7, 1.0));
box.position[0] = -1.5;
scene.add(box);

const sphere = new Mesh(sphereGeom, makeMaterial(1.0, 0.4, 0.4));
sphere.position[0] = 1.5;
scene.add(sphere);

const floor = new Mesh(createBoxGeometry(6, 0.1, 6), makeMaterial(0.35, 0.35, 0.35));
floor.position[1] = -0.8;
scene.add(floor);

/* transform controls */

const transformControls = new TransformControls(camera, renderer.domElement);
transformControls.attach(box);
scene.add(transformControls.getHelper());

console.log({ transform, box })

// disable orbit controls while dragging
transformControls.onMouseDown.add(() => {
    orbitControls.enabled = false;
});
transformControls.onMouseUp.add(() => {
    orbitControls.enabled = true;
});

/* keyboard shortcuts */

let currentTarget = box;

window.addEventListener('keydown', (e) => {
    switch (e.key.toLowerCase()) {
        case 't':
            transformControls.setMode('translate');
            break;
        case 'r':
            transformControls.setMode('rotate');
            break;
        case 's':
            transformControls.setMode('scale');
            break;
        case 'q':
            transformControls.setSpace(transformControls.space === 'local' ? 'world' : 'local');
            break;
        case 'tab':
            e.preventDefault();
            currentTarget = currentTarget === box ? sphere : box;
            transformControls.attach(currentTarget);
            break;
        case 'escape':
            transformControls.reset();
            break;
    }
});

/* HUD */

const hud = document.createElement('div');
hud.style.cssText = 'position:fixed;bottom:12px;left:12px;color:#fff;font:13px/1.5 monospace;background:rgba(0,0,0,0.6);padding:8px 12px;border-radius:4px;pointer-events:none;';
hud.innerHTML = `
<b>T</b> translate &nbsp; <b>R</b> rotate &nbsp; <b>S</b> scale<br>
<b>Q</b> toggle world/local &nbsp; <b>Tab</b> switch object &nbsp; <b>Esc</b> reset
`.trim();
document.body.appendChild(hud);

/* render loop */

scene.updateWorldMatrix();
camera.updateViewMatrix();

const scenePass = pass(scene, camera);
const outputNode = renderOutput(scenePass.getTextureNode());
const renderPipeline = new RenderPipeline(renderer, outputNode);

function frame() {
    orbitControls.update();
    scene.updateWorldMatrix();

    renderPipeline.render();
    requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
