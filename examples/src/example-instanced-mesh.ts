import * as g from 'gpucat';
import { mat4, quat, vec3 } from 'mathcat';

const S = g.S;

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
    instanceColors[i * 3 + 0] = Math.abs(Math.sin(h * Math.PI * 2 + 0));
    instanceColors[i * 3 + 1] = Math.abs(Math.sin(h * Math.PI * 2 + (2 * Math.PI) / 3));
    instanceColors[i * 3 + 2] = Math.abs(Math.sin(h * Math.PI * 2 + (4 * Math.PI) / 3));
}

const instanceTransformStride = 16 * 4;
const col0 = g.instancedBufferAttribute(instanceMatrices, S.vec4f(), instanceTransformStride, 0);
const col1 = g.instancedBufferAttribute(instanceMatrices, S.vec4f(), instanceTransformStride, 16);
const col2 = g.instancedBufferAttribute(instanceMatrices, S.vec4f(), instanceTransformStride, 32);
const col3 = g.instancedBufferAttribute(instanceMatrices, S.vec4f(), instanceTransformStride, 48);
const instanceTransform = g.mat4(col0, col1, col2, col3);

const instanceColor = g.instancedBufferAttribute(instanceColors, S.vec3f(), 12, 0);

const vColor = g.varying('vec3f', 'v_color', instanceColor);

const pos = g.attribute('vec3f', 'position');
const localPos = g.vec4(pos, g.f32(1.0));
const worldPos = g.mul(instanceTransform, localPos);
const viewPos  = g.mul(g.cameraViewMatrix, worldPos);
const clipPos  = g.mul(g.cameraProjectionMatrix, viewPos);

// pulse: gentle brightness oscillation each second
const tScaled = g.timeElapsed.mul(g.f32(2.0));
const pulse = g.f32(0.12).mul(
    g.f32(1.0).add(tScaled.sin()),
);
const finalColor = g.vec4(
    vColor.add(g.vec3f(1, 1, 1).mul(pulse)),
    g.f32(1.0),
);

const material = new g.Material({ position: clipPos, color: finalColor });

async function main() {
    const renderer = new g.WebGPURenderer({ antialias: true });
    const inspector = new g.Inspector();
    renderer.inspector = inspector;
    await renderer.init();

    document.body.appendChild(renderer.domElement);
    document.body.appendChild(inspector.domElement);
    renderer.setSize(window.innerWidth * devicePixelRatio, window.innerHeight * devicePixelRatio);

    const scene = new g.Scene();

    const perspCamera = new g.PerspectiveCamera(
        Math.PI / 4,
        window.innerWidth / window.innerHeight,
        0.1,
        200,
    );
    perspCamera.position[2] = 18;
    scene.add(perspCamera);
    // Static scene — set matrices once after setup.
    scene.updateWorldMatrix();
    perspCamera.updateViewMatrix();

    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth * devicePixelRatio, window.innerHeight * devicePixelRatio);
        perspCamera.aspect = window.innerWidth / window.innerHeight;
        perspCamera.updateProjectionMatrix();
    });

    const mesh = new g.Mesh(g.createBoxGeometry(1, 1, 1), material);
    mesh.count = N;
    scene.add(mesh);

    const scenePass = g.pass(scene, perspCamera);
    const outputNode = scenePass.getTextureNode();

    function frame() {
        renderer.render(outputNode);
        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

main();
