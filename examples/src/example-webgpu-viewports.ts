// Multi-view: many independent 3D scenes rendered into sub-rectangles of ONE
// canvas / ONE device, using the renderer's viewport + scissor + autoClear.
//
// This is the primitive behind a grid of 3D "cards" (e.g. avatar previews): each
// cell is its own Scene + Camera, and we composite them all into one canvas with
// setViewport / setScissor, clearing once per frame with autoClear = false.
//
// To make scissor's clipping VISIBLE, each cell's viewport is intentionally
// inflated past its scissor rect, so the cube renders bigger than the cell and
// scissor hard-clips it exactly at the cell edge (no bleed into the gaps). Real
// use would set viewport === scissor === cell for clean framing.

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
    PerspectiveCamera,
    Scene,
    varying,
    vec3,
    vec4,
    WebGPURenderer,
} from 'gpucat';
import { quat } from 'mathcat';

const renderer = new WebGPURenderer();
await renderer.init();
document.body.appendChild(renderer.domElement);
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.clearColor = [0.08, 0.08, 0.1, 1];
// We clear once per frame and composite each view on top (loadOp:'load').
renderer.autoClear = false;
renderer.setScissorTest(true);

const COLS = 4;
const ROWS = 3;
const GAP = 12;
// how far the viewport overspills the scissor cell (fraction of the cell) — purely
// to make scissor's clipping obvious. Set to 0 for tight, real-world framing.
const OVERSCAN = 0.35;

// hue (0..1) → rgb, s=0.6 l=0.55.
function hueColor(h: number): [number, number, number] {
    const s = 0.62;
    const l = 0.55;
    const a = s * Math.min(l, 1 - l);
    const k = (n: number) => (n + h * 12) % 12;
    const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)];
}

type View = { scene: Scene; camera: PerspectiveCamera; mesh: Mesh; spin: number };

function makeView(color: [number, number, number]): View {
    const scene = new Scene();
    const camera = new PerspectiveCamera(Math.PI / 4, 1, 0.1, 100);
    camera.position[2] = 2.2;
    scene.add(camera);

    const geometry = createBoxGeometry(1, 1, 1);

    const position = attribute('position', d.vec3f);
    const normal = attribute('normal', d.vec3f);
    const worldPosition = mul(modelWorldMatrix, vec4(position, f32(1)));
    const clipPosition = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPosition));
    const vNormal = varying(normalize(mul(modelNormalMatrix, normal)), 'vNormal');

    const lightDir = vec3(0.5, 0.85, 0.6).normalize();
    const lighting = f32(0.22).add(vNormal.dot(lightDir).max(f32(0)).mul(f32(0.85)));
    const base = vec3(color[0], color[1], color[2]);
    const material = new Material({ vertex: clipPosition, fragment: vec4(base.mul(lighting), f32(1)) });

    const mesh = new Mesh(geometry, material);
    scene.add(mesh);
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    return { scene, camera, mesh, spin: 0.5 + (Math.floor(color[0] * 7) % 5) * 0.18 };
}

const COUNT = COLS * ROWS;
const views: View[] = [];
for (let i = 0; i < COUNT; i++) views.push(makeView(hueColor(i / COUNT)));

function cellRect(i: number, w: number, h: number): { x: number; y: number; width: number; height: number } {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const cellW = (w - GAP * (COLS + 1)) / COLS;
    const cellH = (h - GAP * (ROWS + 1)) / ROWS;
    const x = GAP + col * (cellW + GAP);
    const y = GAP + row * (cellH + GAP);
    return { x, y, width: cellW, height: cellH };
}

window.addEventListener('resize', () => renderer.setSize(window.innerWidth, window.innerHeight));

function frame(): void {
    const now = performance.now() / 1000;
    const w = window.innerWidth;
    const h = window.innerHeight;

    // one clear for the whole canvas, then composite each view.
    renderer.clear();

    for (let i = 0; i < COUNT; i++) {
        const v = views[i];
        quat.fromEuler(v.mesh.quaternion, [now * v.spin * 0.55, now * v.spin, 0, 'xyz']);
        v.mesh.updateWorldMatrix();

        const cell = cellRect(i, w, h);
        // scissor = the exact cell; viewport = inflated cell (so scissor visibly clips).
        const ox = cell.width * OVERSCAN;
        const oy = cell.height * OVERSCAN;
        const vp = { x: cell.x - ox, y: cell.y - oy, width: cell.width + ox * 2, height: cell.height + oy * 2 };

        v.camera.aspect = vp.width / vp.height;
        v.camera.updateProjectionMatrix();
        v.camera.updateViewMatrix();

        renderer.setScissor(cell.x, cell.y, cell.width, cell.height);
        renderer.setViewport(vp.x, vp.y, vp.width, vp.height);
        renderer.render(v.scene, v.camera);
    }

    requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
