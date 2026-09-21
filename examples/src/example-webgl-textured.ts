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
    Texture,
    texture,
    varying,
    vec3,
    vec4,
    webgl,
} from 'gpucat';
import { type Euler, quat } from 'math';

/* build a checkerboard image on a 2D canvas */

function createCheckerboard(size = 256, squares = 8): Promise<ImageBitmap> {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d')!;
    const squareSize = size / squares;

    for (let y = 0; y < squares; y++) {
        for (let x = 0; x < squares; x++) {
            const isLight = (x + y) % 2 === 0;
            ctx.fillStyle = isLight ? '#f0f0f0' : '#3a5a8a';
            ctx.fillRect(x * squareSize, y * squareSize, squareSize, squareSize);
        }
    }

    return createImageBitmap(canvas);
}

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

window.addEventListener('resize', () => {
    view.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

/* checkerboard texture bound to a sampler in the material */

const checkerImage = await createCheckerboard(256, 8);
const checkerTexture = new Texture(checkerImage);
checkerTexture.wrapS = 'repeat';
checkerTexture.wrapT = 'repeat';
checkerTexture.needsUpdate = true;

/* geometry attributes */

const position = attribute('position', d.vec3f);
const normal = attribute('normal', d.vec3f);
const uvAttr = attribute('uv', d.vec2f);

/* vertex: transform position to clip space */

const worldPosition = mul(modelWorldMatrix, vec4(position, f32(1)));
const clipPosition = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPosition));

const vNormal = varying(normalize(mul(modelNormalMatrix, normal)), 'vNormal');
const vUv = varying(uvAttr, 'vUv');

/* fragment: sample the texture and apply simple lighting */

const texNode = texture(checkerTexture);
const texColor = texNode.sample(vUv);

const lightDirection = vec3(0.6, 1.0, 0.8).normalize();
const diffuse = vNormal.dot(lightDirection).max(f32(0.25));
const litColor = texColor.xyz.mul(diffuse);

const material = createMaterial({
    vertex: clipPosition,
    fragment: vec4(litColor, f32(1)),
});

const geometry = createBoxGeometry(1, 1, 1);
const mesh = new Mesh(geometry, material);
scene.add(mesh);

scene.updateWorldMatrix();
camera.updateViewMatrix();

/* render loop */

const scenePass = renderTexture(scene, camera);
const outputNode = renderOutput(scenePass.getTextureNode());
const composite = fullscreen(outputNode);
let angle = 0;
let prevTime = performance.now() / 1000;

function update() {
    const now = performance.now() / 1000;
    const dt = now - prevTime;
    prevTime = now;

    angle += dt * 0.5;
    quat.fromEuler(mesh.quaternion, [angle * 0.3, angle, 0, 'yxz'] as Euler);
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
