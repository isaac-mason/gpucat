import * as gpu from 'gpucat';
import { mat4, type Mat4, type Vec3, type Quat } from 'mathcat';

const S = gpu.S;

const COLS = 6;
const ROWS = 5;
const N = COLS * ROWS;
const SPACING = 2.2;

const instanceMatrices = new Float32Array(N * 16);
const instanceColors = new Float32Array(N * 3);

const tmpTranslation: Vec3 = [0, 0, 0];
const tmpScale: Vec3 = [1, 1, 1];
const tmpQuat: Quat = [0, 0, 0, 1];
const tmpMat: Mat4 = [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0];

for (let i = 0; i < N; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    tmpTranslation[0] = (col - (COLS - 1) * 0.5) * SPACING;
    tmpTranslation[1] = (row - (ROWS - 1) * 0.5) * SPACING;
    tmpTranslation[2] = 0;
    mat4.fromRotationTranslationScale(tmpMat, tmpQuat, tmpTranslation, tmpScale);
    instanceMatrices.set(tmpMat, i * 16);

    // rainbow hue per instance
    const h = i / N;
    instanceColors[i * 3 + 0] = Math.abs(Math.sin(h * Math.PI * 2 + 0));
    instanceColors[i * 3 + 1] = Math.abs(Math.sin(h * Math.PI * 2 + (2 * Math.PI) / 3));
    instanceColors[i * 3 + 2] = Math.abs(Math.sin(h * Math.PI * 2 + (4 * Math.PI) / 3));
}

const instanceTransformStride = 16 * 4;
const col0 = gpu.instancedBufferAttribute(instanceMatrices, S.vec4f(), instanceTransformStride, 0);
const col1 = gpu.instancedBufferAttribute(instanceMatrices, S.vec4f(), instanceTransformStride, 16);
const col2 = gpu.instancedBufferAttribute(instanceMatrices, S.vec4f(), instanceTransformStride, 32);
const col3 = gpu.instancedBufferAttribute(instanceMatrices, S.vec4f(), instanceTransformStride, 48);
const instanceTransform = gpu.mat4(col0, col1, col2, col3);

const instanceColor = gpu.instancedBufferAttribute(instanceColors, S.vec3f(), 12, 0);

const vColor = gpu.varying('vec3f', 'v_color', instanceColor);

const cam = gpu.camera();
const pos = gpu.attribute('vec3f', 'position');
const localPos = gpu.vec4(pos, gpu.f32(1.0));
const worldPos = gpu.mul(instanceTransform, localPos);
const viewPos  = gpu.mul(cam.viewMatrix, worldPos);
const clipPos  = gpu.mul(cam.projectionMatrix, viewPos);

const time = gpu.time();

// pulse: gentle brightness oscillation each second
const tScaled = time.elapsed.mul(gpu.f32(2.0));
const pulse = gpu.f32(0.12).mul(
    gpu.f32(1.0).add(tScaled.sin()),
);
const finalColor = gpu.vec4(
    vColor.add(gpu.vec3f(1, 1, 1).mul(pulse)),
    gpu.f32(1.0),
);

const material = new gpu.Material({ position: clipPos, color: finalColor });

async function main() {
    const renderer = new gpu.WebGPURenderer({ antialias: true });
    await renderer.init();

    document.body.appendChild(renderer.domElement);
    renderer.setSize(window.innerWidth * devicePixelRatio, window.innerHeight * devicePixelRatio);

    const scene = new gpu.Scene();

    const perspCamera = new gpu.PerspectiveCamera(
        Math.PI / 4,
        window.innerWidth / window.innerHeight,
        0.1,
        200,
    );
    perspCamera.position[2] = 18;
    scene.add(perspCamera);

    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth * devicePixelRatio, window.innerHeight * devicePixelRatio);
        perspCamera.aspect = window.innerWidth / window.innerHeight;
        perspCamera.updateProjectionMatrix();
    });

    const mesh = new gpu.Mesh(gpu.createBoxGeometry(1, 1, 1), material);
    mesh.count = N;
    scene.add(mesh);

    const scenePass = gpu.pass(scene, perspCamera);
    const outputNode = scenePass.getTextureNode();

    function frame() {
        renderer.render(outputNode);
        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

main();
