import {
    ArrayTexture,
    arrayTexture,
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    compile,
    createCanvasTarget,
    createMaterial,
    createPlaneGeometry,
    d,
    f32,
    frame,
    fullscreen,
    Inspector,
    i32,
    init,
    Mesh,
    modelWorldMatrix,
    mul,
    PerspectiveCamera,
    renderOutput,
    renderTexture,
    Scene,
    uniform,
    varying,
    vec4,
    webgpu,
} from 'gpucat';

// ─── Renderer ───────────────────────────────────────────────────────────────

const canvas = document.createElement('canvas');
canvas.style.display = 'block';
document.body.appendChild(canvas);

const view = createCanvasTarget(canvas, { samples: 4 });
view.setPixelRatio(devicePixelRatio);
view.setSize(window.innerWidth, window.innerHeight);

const renderer = await init(webgpu());
renderer.inspector = new Inspector();

document.body.appendChild((renderer.inspector as Inspector).domElement);

// ─── Camera ─────────────────────────────────────────────────────────────────

const camera = new PerspectiveCamera(Math.PI / 4, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position = [0, 0, 3];
camera.lookAt([0, 0, 0]);

window.addEventListener('resize', () => {
    view.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

// ─── Procedural flipbook frames ─────────────────────────────────────────────

const FRAME_COUNT = 16;
const TEX_SIZE = 64;
const CHANNELS = 4; // RGBA

const totalPixels = TEX_SIZE * TEX_SIZE * FRAME_COUNT * CHANNELS;
const data = new Uint8Array(totalPixels);

for (let frame = 0; frame < FRAME_COUNT; frame++) {
    const offset = frame * TEX_SIZE * TEX_SIZE * CHANNELS;
    const t = frame / FRAME_COUNT;

    // Each frame: a filled circle that grows from center, with hue shifting
    const radius = (0.15 + t * 0.35) * TEX_SIZE;
    const cx = TEX_SIZE / 2;
    const cy = TEX_SIZE / 2;

    // Hue to RGB (simple HSV with S=1, V=1)
    const hue = t * 360;
    const c = 1.0;
    const x = 1.0 - Math.abs(((hue / 60) % 2) - 1.0);
    let r1 = 0,
        g1 = 0,
        b1 = 0;
    if (hue < 60) {
        r1 = c;
        g1 = x;
    } else if (hue < 120) {
        r1 = x;
        g1 = c;
    } else if (hue < 180) {
        g1 = c;
        b1 = x;
    } else if (hue < 240) {
        g1 = x;
        b1 = c;
    } else if (hue < 300) {
        r1 = x;
        b1 = c;
    } else {
        r1 = c;
        b1 = x;
    }

    for (let y = 0; y < TEX_SIZE; y++) {
        for (let x2 = 0; x2 < TEX_SIZE; x2++) {
            const idx = offset + (y * TEX_SIZE + x2) * CHANNELS;
            const dx = x2 - cx;
            const dy = y - cy;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < radius) {
                data[idx + 0] = (r1 * 255) | 0;
                data[idx + 1] = (g1 * 255) | 0;
                data[idx + 2] = (b1 * 255) | 0;
                data[idx + 3] = 255;
            } else {
                // Dark background
                data[idx + 0] = 30;
                data[idx + 1] = 30;
                data[idx + 2] = 40;
                data[idx + 3] = 255;
            }
        }
    }
}

const flipbookTex = new ArrayTexture(data, TEX_SIZE, TEX_SIZE, FRAME_COUNT);
flipbookTex.magFilter = 'nearest';
flipbookTex.minFilter = 'nearest';
flipbookTex.needsUpdate = true;

// ─── Material ───────────────────────────────────────────────────────────────

const pos = attribute('position', d.vec3f);
const uvAttr = attribute('uv', d.vec2f);

const localPos = vec4(pos, f32(1));
const worldPos = mul(modelWorldMatrix, localPos);
const viewPos = mul(cameraViewMatrix, worldPos);
const clipPos = mul(cameraProjectionMatrix, viewPos);

const vUv = varying(uvAttr, 'v_uv');

// Layer index uniform — updated each frame on the CPU
const layerUniform = uniform(i32(0), 'layerIndex');

const flipbook = arrayTexture(flipbookTex, layerUniform);
const texColor = flipbook.sample(vUv);

const material = createMaterial({
    vertex: clipPos,
    fragment: texColor,
});

// ─── Scene ──────────────────────────────────────────────────────────────────

const scene = new Scene();
scene.add(camera);

const geometry = createPlaneGeometry(2, 2);
const mesh = new Mesh(geometry, material);
// plane already faces +Z (toward camera), no rotation needed
scene.add(mesh);

scene.updateWorldMatrix();
camera.updateViewMatrix();

await compile(renderer, mesh, view, camera);

const scenePass = renderTexture(scene, camera);
const outputNode = renderOutput(scenePass.getTextureNode());
const composite = fullscreen(outputNode);
// ─── Animation loop ─────────────────────────────────────────────────────────

const FPS = 8; // flipbook playback rate

function update() {
    const now = performance.now() / 1000;

    // Cycle through layers
    const frameIndex = Math.floor(now * FPS) % FRAME_COUNT;
    layerUniform.value = frameIndex;

    const f = frame(renderer);

    const compositePass = f.pass({ target: view });

    compositePass.draw(composite);

    compositePass.end();

    f.submit();
    requestAnimationFrame(update);
}

requestAnimationFrame(update);
