import {
    attribute, cameraProjectionMatrix, cameraViewMatrix, cameraPosition,
    createPlaneGeometry, createBoxGeometry, createSphereGeometry,
    d, f32, dot, mul, normalize, vec3, vec4, varying, modelWorldMatrix, modelNormalMatrix,
    Material, Mesh, Scene, PerspectiveCamera,
    OrbitControls, WebGLRenderer, cubeTexture, CubeRenderTarget, CubeCamera,
    pass, renderOutput, RenderPipeline,
} from 'gpucat';
import { quat } from 'mathcat';

/*
 * Cube camera DEBUG scene (WebGL).
 *
 * The environment is a labeled room: six solid-colour walls, each with a WHITE
 * marker in its top-left corner and a BLACK marker in its top-right (so any
 * flip/rotation is obvious). A mirror sphere sits in the middle. Orbit around
 * and compare the sphere's reflection to the real walls: a correct reflection
 * mirrors the room; any reversed/rotated patch is a cube-camera bug.
 *
 *   +X red    -X green   +Y blue   -Y yellow   +Z magenta   -Z cyan
 *
 * NOTE: unlike the WebGPU example this port drops the readPixels() debug face
 * strip — CPU readback of a render target is WebGPU-only in gpucat right now.
 */

const renderer = new WebGLRenderer({ antialias: true });
await renderer.init();
document.body.appendChild(renderer.domElement);
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.clearColor = [0.05, 0.05, 0.06, 1];

const scene = new Scene();
const camera = new PerspectiveCamera(Math.PI / 3, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position[2] = 9;
scene.add(camera);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

/* a flat (unlit) colour material */
function flat(color: [number, number, number], cull: GPUCullMode = 'back'): Material {
    const position = attribute('position', d.vec3f);
    const clip = mul(cameraProjectionMatrix, mul(cameraViewMatrix, mul(modelWorldMatrix, vec4(position, f32(1)))));
    return new Material({ vertex: clip, fragment: vec4(vec3(...color), f32(1)), cullMode: cull });
}

/* labeled room: 6 inward-facing colored walls, each with TL (white) + TR (black) markers */
const D = 16;
const WALLS: { color: [number, number, number]; euler: [number, number, number]; pos: [number, number, number] }[] = [
    { color: [1, 0.25, 0.25], euler: [0, -Math.PI / 2, 0], pos: [D, 0, 0] },  // +X red
    { color: [0.3, 1, 0.4], euler: [0, Math.PI / 2, 0], pos: [-D, 0, 0] },    // -X green
    { color: [0.35, 0.55, 1], euler: [Math.PI / 2, 0, 0], pos: [0, D, 0] },   // +Y blue
    { color: [1, 0.85, 0.3], euler: [-Math.PI / 2, 0, 0], pos: [0, -D, 0] },  // -Y yellow
    { color: [1, 0.4, 1], euler: [0, Math.PI, 0], pos: [0, 0, D] },           // +Z magenta
    { color: [0.3, 1, 1], euler: [0, 0, 0], pos: [0, 0, -D] },                // -Z cyan
];

function buildRoom(): Mesh[] {
    const meshes: Mesh[] = [];
    const planeGeom = createPlaneGeometry(2 * D, 2 * D);
    const markGeom = createBoxGeometry(3.5, 3.5, 0.4);
    for (const w of WALLS) {
        const wall = new Mesh(planeGeom, flat(w.color));
        quat.fromEuler(wall.quaternion, [...w.euler, 'xyz']);
        wall.position[0] = w.pos[0]; wall.position[1] = w.pos[1]; wall.position[2] = w.pos[2];
        const white = new Mesh(markGeom, flat([1, 1, 1]));   // local top-left
        white.position[0] = -6; white.position[1] = 6; white.position[2] = 0.4;
        const black = new Mesh(markGeom, flat([0, 0, 0]));   // local top-right
        black.position[0] = 6; black.position[1] = 6; black.position[2] = 0.4;
        wall.add(white); wall.add(black);
        wall.updateWorldMatrix();
        meshes.push(wall);
    }
    return meshes;
}

for (const m of buildRoom()) scene.add(m);

/* cube camera + render target at the room center */
const cubeRT = new CubeRenderTarget(512, { colorFormat: 'rgba8unorm' });
const cubeCamera = new CubeCamera(0.1, 100, cubeRT);
cubeCamera.updateWorldMatrix();

/* mirror sphere in the middle */
const spherePos = attribute('position', d.vec3f);
const sphereNormal = attribute('normal', d.vec3f);
const sphereWorld = mul(modelWorldMatrix, vec4(spherePos, f32(1)));
const sphereClip = mul(cameraProjectionMatrix, mul(cameraViewMatrix, sphereWorld));

const vWorldPos = varying(sphereWorld.xyz, 'vWorldPos');
const vWorldNormal = varying(normalize(mul(modelNormalMatrix, sphereNormal)), 'vWorldNormal');

const N = normalize(vWorldNormal);
const I = normalize(vWorldPos.sub(cameraPosition));               // camera -> surface
const R = I.sub(N.mul(dot(N, I).mul(f32(2))));     // reflect(I, N)
const env = cubeTexture(cubeRT.texture).sample(R);

const sphereMaterial = new Material({ vertex: sphereClip, fragment: vec4(env.xyz, f32(1)) });
const sphere = new Mesh(createSphereGeometry(4, 48, 32), sphereMaterial);
scene.add(sphere);

/* small legend overlay */
const legend = document.createElement('div');
legend.style.cssText = 'position:fixed;top:10px;left:10px;font:12px monospace;color:#fff;background:rgba(0,0,0,0.6);padding:8px 10px;border-radius:6px;line-height:1.5';
legend.innerHTML = 'mirror sphere reflecting a labeled room (WebGL). each wall: WHITE marker = top-left, BLACK = top-right.<br>' +
    '+X red &nbsp; -X green &nbsp; +Y blue &nbsp; -Y yellow &nbsp; +Z magenta &nbsp; -Z cyan';
document.body.appendChild(legend);

/* main-view pipeline. toneMapping 'none' so the flat debug colours render true. */
const scenePass = pass(scene, camera);
const outputNode = renderOutput(scenePass.getTextureNode(), { toneMapping: 'none' });
const renderPipeline = new RenderPipeline(renderer, outputNode);

/* render loop */
function frame() {
    controls.update();
    camera.updateViewMatrix();

    // capture the room into the cube (sphere hidden so it does not reflect itself)
    sphere.visible = false;
    cubeCamera.update(renderer, scene);
    sphere.visible = true;

    renderPipeline.render();
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
