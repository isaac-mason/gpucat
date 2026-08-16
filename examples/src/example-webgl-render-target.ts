import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createBoxGeometry,
    d,
    f32,
    Material,
    Mesh,
    modelNormalMatrix,
    modelWorldMatrix,
    mul,
    normalize,
    pass,
    PerspectiveCamera,
    renderOutput,
    RenderPipeline,
    Scene,
    screenUV,
    varying,
    vec3,
    vec4,
    WebGLRenderer,
} from 'gpucat';
import { quat, type Euler } from 'math';

/* create the WebGL2 renderer */

const renderer = new WebGLRenderer({ antialias: true });
await renderer.init();

document.body.appendChild(renderer.domElement);
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);

/* scene: a lit, spinning cube */

const scene = new Scene();

const camera = new PerspectiveCamera(
    Math.PI / 4,
    window.innerWidth / window.innerHeight,
    0.1,
    100,
);
camera.position[2] = 4;
scene.add(camera);

const position = attribute('position', d.vec3f);
const normal = attribute('normal', d.vec3f);

const worldPosition = mul(modelWorldMatrix, vec4(position, f32(1)));
const clipPosition = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPosition));

const vNormal = varying(normalize(mul(modelNormalMatrix, normal)), 'vNormal');

const lightDirection = vec3(0.6, 1.0, 0.8).normalize();
const diffuse = vNormal.dot(lightDirection).max(f32(0));
const lighting = f32(0.15).add(diffuse);
const litColor = vec3(1.0, 0.55, 0.2).mul(lighting);

const material = new Material({
    vertex: clipPosition,
    fragment: vec4(litColor, f32(1)),
});

const geometry = createBoxGeometry(1, 1, 1);
const mesh = new Mesh(geometry, material);
scene.add(mesh);

scene.updateWorldMatrix();
camera.updateViewMatrix();

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

/* post: render the scene into an offscreen render target, then sample it
   fullscreen and tweak the color (proves the WebGL2 FBO + sampler path) */

// pass() renders the scene (with its own depth attachment) into an offscreen framebuffer
const scenePass = pass(scene, camera, { colorFormat: 'rgba8unorm' });
const sceneTexture = scenePass.getTextureNode();

// sample the render target fullscreen
const uv = screenUV;
const sampled = sceneTexture.sample(uv);

// color tweak: sepia-ish tint + a soft radial vignette
const tint = vec3(
    sampled.x.mul(f32(1.15)).add(sampled.y.mul(f32(0.1))),
    sampled.y.mul(f32(0.95)),
    sampled.z.mul(f32(0.8)),
);

const centered = vec3(uv.x.sub(f32(0.5)), uv.y.sub(f32(0.5)), f32(0));
const dist = centered.dot(centered);
const vignette = f32(1).sub(dist.mul(f32(1.1))).max(f32(0));

const graded = tint.mul(vignette);

const outputNode = renderOutput(vec4(graded, f32(1)));

const renderPipeline = new RenderPipeline(renderer, outputNode);

/* render loop */

let angle = 0;
let prevTime = performance.now() / 1000;

function frame() {
    const now = performance.now() / 1000;
    const dt = now - prevTime;
    prevTime = now;

    angle += dt * 0.6;
    quat.fromEuler(mesh.quaternion, [angle * 0.4, angle, 0, 'yxz'] as Euler);
    mesh.updateWorldMatrix();

    renderPipeline.render();
    requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
