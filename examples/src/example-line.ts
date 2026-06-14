import {
    Line,
    LineGeometry,
    LineSegments,
    LineSegmentsGeometry,
    LineMaterial,
    OrbitControls,
    pass,
    PerspectiveCamera,
    Raycaster,
    RenderPipeline,
    renderOutput,
    Scene,
    vec4f,
    WebGPURenderer,
} from 'gpucat';

const renderer = new WebGPURenderer({ antialias: true });
await renderer.init();

document.body.appendChild(renderer.domElement);
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new Scene();

const camera = new PerspectiveCamera(Math.PI / 4, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position[2] = 8;
scene.add(camera);

const controls = new OrbitControls(camera, renderer.domElement);

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

// ── 1. Line — closed polyline (pentagon), screen-space width ─────────────────
const pentagonPoints: number[] = [];
for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
    pentagonPoints.push(Math.cos(a) * 1.2, Math.sin(a) * 1.2 + 2.5, 0);
}
const pentagonGeom = new LineGeometry(pentagonPoints, true);
const pentagonMat  = new LineMaterial({ color: vec4f(0.2, 0.8, 1.0, 1.0) as any, lineWidth: 4 });
const pentagon     = new Line(pentagonGeom, pentagonMat);
scene.add(pentagon);

// ── 2. Line — animated open polyline (sine wave), screen-space width ─────────
const WAVE_SEGMENTS = 80;
const wavePoints = new Float32Array((WAVE_SEGMENTS + 1) * 3);
const waveGeom = new LineGeometry(wavePoints, false, WAVE_SEGMENTS + 1);
const waveMat  = new LineMaterial({ color: vec4f(1.0, 0.4, 0.1, 1.0) as any, lineWidth: 3 });
const wave     = new Line(waveGeom, waveMat);
wave.position[1] = -0.5;
scene.add(wave);

// ── 3. LineSegments — axis cross ticks, screen-space width ───────────────────
const tickPoints: number[] = [];
for (let i = -3; i <= 3; i++) {
    tickPoints.push(i - 0.1, 0, 0,  i + 0.1, 0, 0);
    tickPoints.push(i, -0.1, 0,  i,  0.1, 0);
}
const tickGeom = new LineSegmentsGeometry(tickPoints);
const tickMat  = new LineMaterial({ color: vec4f(0.9, 0.9, 0.3, 1.0) as any, lineWidth: 2 });
const ticks    = new LineSegments(tickGeom, tickMat);
ticks.position[1] = -2.5;
scene.add(ticks);

// ── 4. Line — world-space width ───────────────────────────────────────────────
const circlePoints: number[] = [];
const CIRCLE_SEGS = 48;
for (let i = 0; i < CIRCLE_SEGS; i++) {
    const a = (i / CIRCLE_SEGS) * Math.PI * 2;
    circlePoints.push(Math.cos(a) * 1.2, Math.sin(a) * 1.2 + 2.5, 0);
}
const circleGeom = new LineGeometry(circlePoints, true);
const circleMat  = new LineMaterial({ color: vec4f(0.5, 1.0, 0.5, 1.0) as any, lineWidth: 0.06, worldUnits: true });
const circle     = new Line(circleGeom, circleMat);
circle.position[0] = 3.5;
scene.add(circle);

// ── Highlight dot — a small sphere-like cross shown at the hit point ──────────
// Built as LineSegments: 3 axis-aligned crosses of length 0.12
const DOT_R = 0.12;
const dotPoints = [
    -DOT_R, 0, 0,  DOT_R, 0, 0,
     0, -DOT_R, 0,  0, DOT_R, 0,
     0, 0, -DOT_R,  0, 0, DOT_R,
];
const dotGeom = new LineSegmentsGeometry(dotPoints);
const dotMat  = new LineMaterial({ color: vec4f(1, 1, 1, 1) as any, lineWidth: 2 });
const dot     = new LineSegments(dotGeom, dotMat);
dot.visible = false;
scene.add(dot);

// ── Label overlay ─────────────────────────────────────────────────────────────
const label = document.createElement('div');
label.style.cssText = [
    'position:fixed', 'top:12px', 'left:12px',
    'color:#fff', 'font:13px/1.5 monospace',
    'background:rgba(0,0,0,.55)', 'padding:6px 10px',
    'border-radius:4px', 'pointer-events:none',
    'white-space:pre',
].join(';');
label.textContent = 'Move mouse over a line';
document.body.appendChild(label);

// ── Raycaster ─────────────────────────────────────────────────────────────────
const raycaster = new Raycaster();
raycaster.camera = camera;   // required for screen-space lines

const pickables = [pentagon, wave, ticks, circle];
const names: Map<object, string> = new Map([
    [pentagon, 'pentagon (screen-space, 4 px)'],
    [wave,     'sine wave (screen-space, 3 px)'],
    [ticks,    'ticks / LineSegments (screen-space, 2 px)'],
    [circle,   'circle (world-space, 0.06 wu)'],
]);

// threshold in pixels for the screen-space lines, world units for the circle
pentagon.threshold = 2;
wave.threshold     = 2;
ticks.threshold    = 2;
circle.threshold   = 0.02;

const mouse: [number, number] = [0, 0];
window.addEventListener('mousemove', (e) => {
    mouse[0] =  (e.clientX / window.innerWidth)  * 2 - 1;
    mouse[1] = -(e.clientY / window.innerHeight) * 2 + 1;
});

// ── Render ────────────────────────────────────────────────────────────────────
scene.updateWorldMatrix();
camera.updateViewMatrix();

const scenePass      = pass(scene, camera);
const outputNode     = renderOutput(scenePass.getTextureNode());
const renderPipeline = new RenderPipeline(renderer, outputNode);

function frame(t: number) {
    const time = t / 1000;

    for (let i = 0; i <= WAVE_SEGMENTS; i++) {
        const x = (i / WAVE_SEGMENTS) * 6 - 3;
        wavePoints[i * 3 + 0] = x;
        wavePoints[i * 3 + 1] = Math.sin(x * 2 + time * 2) * 0.5;
        wavePoints[i * 3 + 2] = 0;
    }
    waveGeom.update(wavePoints);

    // Pick
    scene.updateWorldMatrix();
    camera.updateViewMatrix();
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObjects(pickables, false);

    if (hits.length > 0) {
        const hit = hits[0];
        dot.position[0] = hit.point[0];
        dot.position[1] = hit.point[1];
        dot.position[2] = hit.point[2];
        dot.visible = true;
        label.textContent =
            `hit: ${names.get(hit.object) ?? hit.object.constructor.name}\n` +
            `  segment #${hit.faceIndex}\n` +
            `  dist ${hit.distance.toFixed(3)}`;
    } else {
        dot.visible = false;
        label.textContent = 'Move mouse over a line';
    }

    controls.update();
    renderPipeline.render();
    requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
