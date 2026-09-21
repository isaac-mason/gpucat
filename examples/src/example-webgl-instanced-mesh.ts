import * as g from 'gpucat';
import { mat4, quat, vec3 } from 'math';

const d = g.d;

const COLS = 6;
const ROWS = 5;
const N = COLS * ROWS;
const SPACING = 2.2;

const instanceMatrices = new Float32Array(N * 16);
const instanceColors = new Float32Array(N * 3);

const _translation = vec3.create();
const _scale = vec3.fromValues(1, 1, 1);
const _quat = quat.create();
const _mat4 = mat4.create();
const _color = g.color.create();

for (let i = 0; i < N; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    _translation[0] = (col - (COLS - 1) * 0.5) * SPACING;
    _translation[1] = (row - (ROWS - 1) * 0.5) * SPACING;
    _translation[2] = 0;
    mat4.fromRotationTranslationScale(_mat4, _quat, _translation, _scale);
    instanceMatrices.set(_mat4, i * 16);

    // rainbow hue per instance
    const h = i / N;
    g.color.set(
        _color,
        Math.abs(Math.sin(h * Math.PI * 2 + 0)),
        Math.abs(Math.sin(h * Math.PI * 2 + (2 * Math.PI) / 3)),
        Math.abs(Math.sin(h * Math.PI * 2 + (4 * Math.PI) / 3)),
    );
    instanceColors[i * 3 + 0] = _color[0];
    instanceColors[i * 3 + 1] = _color[1];
    instanceColors[i * 3 + 2] = _color[2];
}

const instanceTransformStride = 16 * 4;
const col0 = g.attribute(instanceMatrices, d.vec4f, { stride: instanceTransformStride, offset: 0, instanced: true });
const col1 = g.attribute(instanceMatrices, d.vec4f, { stride: instanceTransformStride, offset: 16, instanced: true });
const col2 = g.attribute(instanceMatrices, d.vec4f, { stride: instanceTransformStride, offset: 32, instanced: true });
const col3 = g.attribute(instanceMatrices, d.vec4f, { stride: instanceTransformStride, offset: 48, instanced: true });
const instanceTransform = g.mat4(col0, col1, col2, col3);

const instanceColor = g.attribute(instanceColors, d.vec3f, { stride: 12, offset: 0, instanced: true });

const vColor = g.varying(instanceColor, 'v_color');

const pos = g.attribute('position', d.vec3f);
const localPos = g.vec4(pos, g.f32(1.0));
const worldPos = g.mul(instanceTransform, localPos);
const viewPos = g.mul(g.cameraViewMatrix, worldPos);
const clipPos = g.mul(g.cameraProjectionMatrix, viewPos);

// `time` is a user-driven uniform (seconds), updated each frame in the loop.
const time = g.uniform(g.f32(0), 'time');
// pulse: gentle brightness oscillation each second
const tScaled = time.mul(g.f32(2.0));
const pulse = g.f32(0.12).mul(g.f32(1.0).add(tScaled.sin()));
const finalColor = g.vec4(vColor.add(g.vec3f(1, 1, 1).mul(pulse)), g.f32(1.0));

const material = new g.Material({ vertex: clipPos, fragment: finalColor });

async function main() {
    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    document.body.appendChild(canvas);

    const view = g.createCanvasTarget(canvas, { samples: 4 });
    view.setPixelRatio(devicePixelRatio);
    view.setSize(window.innerWidth, window.innerHeight);

    const renderer = await g.init(g.webgl({ target: view }));

    const scene = new g.Scene();

    const perspCamera = new g.PerspectiveCamera(Math.PI / 4, window.innerWidth / window.innerHeight, 0.1, 200);
    perspCamera.position[2] = 18;
    scene.add(perspCamera);
    scene.updateWorldMatrix();
    perspCamera.updateViewMatrix();

    window.addEventListener('resize', () => {
        view.setSize(window.innerWidth, window.innerHeight);
        perspCamera.aspect = window.innerWidth / window.innerHeight;
        perspCamera.updateProjectionMatrix();
    });

    const mesh = new g.Mesh(g.createBoxGeometry(1, 1, 1), material);
    mesh.count = N;
    scene.add(mesh);

    const scenePass = g.renderTexture(scene, perspCamera);
    const outputNode = g.renderOutput(scenePass);
    const composite = g.fullscreen(outputNode);
    function update() {
        time.value = performance.now() / 1000;
        const f = g.frame(renderer);
        const compositePass = f.pass({ target: view });
        compositePass.draw(composite);
        compositePass.end();
        f.submit();
        requestAnimationFrame(update);
    }

    requestAnimationFrame(update);
}

main();
