import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createCanvasTarget,
    createMaterial,
    createSphereGeometry,
    d,
    f32,
    frame,
    fullscreen,
    Inspector,
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
    webgl,
} from 'gpucat';
import { quat } from 'math';

/* create the WebGL2 renderer, scene, camera */

const canvas = document.createElement('canvas');
canvas.style.display = 'block';
document.body.appendChild(canvas);

const view = createCanvasTarget(canvas, { samples: 4 });
view.setPixelRatio(devicePixelRatio);
view.setSize(window.innerWidth, window.innerHeight);

const renderer = await init(webgl({ target: view }));

const scene = new Scene();

const camera = new PerspectiveCamera(Math.PI / 4, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position[2] = 4;
scene.add(camera);

const controls = new OrbitControls(camera, canvas);

/* inspector (WebGL: GPU timing via EXT_disjoint_timer_query_webgl2, probe disabled) */
renderer.inspector = new Inspector();

window.addEventListener('resize', () => {
    view.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

/* lit sphere */

const geometry = createSphereGeometry(1, 32, 16);

// vertex
const position = attribute('position', d.vec3f);
const normal = attribute('normal', d.vec3f);

const worldPosition = mul(modelWorldMatrix, vec4(position, f32(1)));
const clipPosition = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPosition));

const vWorldNormal = varying(normalize(mul(modelNormalMatrix, normal)), 'vNormal');

// fragment
const lightDirection = vec3(0.6, 1.0, 0.8).normalize();
const ambient = f32(0.15);
const diffuse = vWorldNormal.dot(lightDirection).max(f32(0));
const lighting = ambient.add(diffuse);

const baseColor = vec3(0.4, 0.7, 1.0);
const litColor = baseColor.mul(lighting);

const material = createMaterial({
    vertex: clipPosition,
    fragment: vec4(litColor, f32(1)),
});

const mesh = new Mesh(geometry, material);
scene.add(mesh);

scene.updateWorldMatrix();
camera.updateViewMatrix();

/* render loop */

const scenePass = renderTexture(scene, camera);
const composite = fullscreen(renderOutput(scenePass.getTextureNode()));

let angle = 0;
let prevTime = performance.now() / 1000;

function update() {
    const now = performance.now() / 1000;
    const dt = now - prevTime;
    prevTime = now;

    angle += dt * 0.6;
    quat.fromEuler(mesh.quaternion, [angle * 0.5, angle, 0, 'xyz']);
    mesh.updateWorldMatrix();

    controls.update();

    const f = frame(renderer);
    const composited = f.pass({ target: view });
    composited.draw(composite);
    composited.end();
    f.submit();

    requestAnimationFrame(update);
}

requestAnimationFrame(update);
