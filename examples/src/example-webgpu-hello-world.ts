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
    init,
    Mesh,
    modelNormalMatrix,
    modelWorldMatrix,
    mul,
    normalize,
    OrbitControls,
    PerspectiveCamera,
    renderOutput,
    renderTexture,
    Scene,
    varying,
    vec3,
    vec4,
    webgpu,
} from 'gpucat';
import { quat } from 'math';

/* create renderer, scene, camera */

const canvas = document.createElement('canvas');
canvas.style.display = 'block';
document.body.appendChild(canvas);

const view = createCanvasTarget(canvas, { samples: 4 });
view.setPixelRatio(devicePixelRatio);
view.setSize(window.innerWidth, window.innerHeight);

const renderer = await init(webgpu());

const scene = new Scene();

const camera = new PerspectiveCamera(Math.PI / 4, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position[2] = 4;
scene.add(camera);

const controls = new OrbitControls(camera, canvas);

window.addEventListener('resize', () => {
    view.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

/* spinning cube */

// geometry
const geometry = createBoxGeometry(1, 1, 1);

// material nodes

// vertex
const position = attribute('position', d.vec3f);
const normal = attribute('normal', d.vec3f);

const worldPosition = mul(modelWorldMatrix, vec4(position, f32(1)));
const clipPosition = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPosition));

const vWorldNormal = varying(normalize(mul(modelNormalMatrix, normal)), 'vNormal');

const vertex = clipPosition;

// fragment

const lightDirection = vec3(0.6, 1.0, 0.8).normalize();
const ambient = f32(0.15);
const diffuse = vWorldNormal.dot(lightDirection).max(f32(0));
const lighting = ambient.add(diffuse);

const baseColor = vec3(0.4, 0.7, 1.0);
const litColor = baseColor.mul(lighting);

const fragment = vec4(litColor, f32(1));

// assemble material

const material = createMaterial({
    vertex,
    fragment,
});

// create mesh and add to scene

const mesh = new Mesh(geometry, material);
scene.add(mesh);

scene.updateWorldMatrix();
camera.updateViewMatrix();

/* render loop */

// render pipeline setup: create a pass for the scene and camera, then render to screen
const scenePass = renderTexture(scene, camera);
const outputNode = renderOutput(scenePass.getTextureNode());
const composite = fullscreen(outputNode);
// requestAnimationFrame loop
let angle = 0;
let prevTime = performance.now() / 1000;

function update() {
    const now = performance.now() / 1000;
    const dt = now - prevTime;
    prevTime = now;

    angle += dt * 0.8;
    quat.fromEuler(mesh.quaternion, [angle * 0.6, angle, 0, 'xyz']);
    mesh.updateWorldMatrix();

    controls.update();
    const f = frame(renderer);
    const compositePass = f.pass({ target: view });
    compositePass.draw(composite);
    compositePass.end();
    f.submit();
    requestAnimationFrame(update);
}

requestAnimationFrame(update);
