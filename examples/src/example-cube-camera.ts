import {
    attribute, cameraProjectionMatrix, cameraViewMatrix, cameraPosition,
    createPlaneGeometry, createBoxGeometry, createSphereGeometry,
    d, f32, dot, mul, normalize, vec3, vec4, varying, modelWorldMatrix, modelNormalMatrix,
    Material, Mesh, Scene, PerspectiveCamera,
    OrbitControls, WebGPURenderer, cubeTexture, CubeRenderTarget, CubeCamera,
    pass, renderOutput, RenderPipeline, readPixels,
} from 'gpucat';
import { quat } from 'mathcat';

/*
 * Cube camera DEBUG scene.
 *
 * The environment is a labeled room: six solid-colour walls, each with a WHITE
 * marker in its top-left corner and a BLACK marker in its top-right (so any
 * flip/rotation is obvious). A mirror sphere sits in the middle. Orbit around
 * and compare the sphere's reflection to the real walls: a correct reflection
 * mirrors the room; any reversed/rotated patch is a cube-camera bug.
 *
 *   +X red    -X green   +Y blue   -Y yellow   +Z magenta   -Z cyan
 */

const renderer = new WebGPURenderer({ antialias: true });
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
legend.innerHTML = 'mirror sphere reflecting a labeled room. each wall: WHITE marker = top-left, BLACK = top-right.<br>' +
    '+X red &nbsp; -X green &nbsp; +Y blue &nbsp; -Y yellow &nbsp; +Z magenta &nbsp; -Z cyan';
document.body.appendChild(legend);

/* ── debug strip: the six live cube faces as canvases along the bottom ────────
 * Reads each layer of the cube color texture back to the CPU and blits it into a
 * small canvas. Faces are layers 0..5 = +X,-X,+Y,-Y,+Z,-Z. */
const FACE_LABELS = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];
const FACE_DISP = 110;

const strip = document.createElement('div');
strip.style.cssText =
    'position:fixed;bottom:8px;left:50%;transform:translateX(-50%);display:flex;gap:6px;' +
    'padding:6px 8px;background:rgba(0,0,0,0.55);border-radius:8px;font:11px monospace;color:#fff';
const faceCanvases = FACE_LABELS.map((label) => {
    const cell = document.createElement('div');
    cell.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:3px';
    const canvas = document.createElement('canvas');
    canvas.width = FACE_DISP;
    canvas.height = FACE_DISP;
    canvas.style.cssText = `width:${FACE_DISP}px;height:${FACE_DISP}px;border:1px solid #333;border-radius:3px`;
    const caption = document.createElement('span');
    caption.textContent = label;
    cell.appendChild(canvas);
    cell.appendChild(caption);
    strip.appendChild(cell);
    return canvas;
});
document.body.appendChild(strip);

// full-resolution scratch canvas: putImageData can't scale, so we draw the face
// at native size then drawImage() it down into the small display canvas.
const faceScratch = document.createElement('canvas');
const faceScratchCtx = faceScratch.getContext('2d')!;

let faceStripBusy = false;
async function updateFaceStrip(): Promise<void> {
    if (faceStripBusy) return; // skip if a previous readback is still in flight
    faceStripBusy = true;
    try {
        const size = cubeRT.size;
        if (faceScratch.width !== size) {
            faceScratch.width = size;
            faceScratch.height = size;
        }
        // Kick off all six copies synchronously (each readPixels submits before it
        // awaits), so every face is sampled from the SAME cube state — otherwise RAF
        // re-captures between faces and the strip tears across frames.
        const faces = await Promise.all(
            [0, 1, 2, 3, 4, 5].map((face) => readPixels(renderer, cubeRT, 0, face)),
        );
        for (let face = 0; face < 6; face++) {
            const img = new ImageData(new Uint8ClampedArray(faces[face]), size, size);
            faceScratchCtx.putImageData(img, 0, 0);
            const ctx = faceCanvases[face].getContext('2d')!;
            ctx.clearRect(0, 0, FACE_DISP, FACE_DISP);
            ctx.drawImage(faceScratch, 0, 0, FACE_DISP, FACE_DISP);
        }
    } finally {
        faceStripBusy = false;
    }
}
setInterval(updateFaceStrip, 150);

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
