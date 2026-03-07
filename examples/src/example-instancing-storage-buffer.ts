import * as g from 'gpucat';
import { d } from 'gpucat'; 
import { mat4, quat, vec3 } from 'mathcat';

const COLS = 7;
const ROWS = 5;
const N = COLS * ROWS;
const SPACING = 2.4;

/* per instance cpu data */

const matrixData  = new Float32Array(N * 16);  // mat4x4f per instance (column-major)
const colorData   = new Float32Array(N * 4);   // vec4f per instance (rgba)

const _mat4 = mat4.create();
const _translation = vec3.create();
const _scale = vec3.fromValues(1, 1, 1);
const _quat = quat.create();

for (let i = 0; i < N; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);

    _translation[0] = (col - (COLS - 1) * 0.5) * SPACING;
    _translation[1] = (row - (ROWS - 1) * 0.5) * SPACING;
    _translation[2] = 0;
    mat4.fromRotationTranslationScale(_mat4, _quat, _translation, _scale);
    matrixData.set(_mat4, i * 16);

    // HSV → RGB: each instance gets a distinct hue
    const h = (i / N) * 360;
    const [r, g, b] = hsvToRgb(h, 0.75, 0.95);
    colorData[i * 4 + 0] = r;
    colorData[i * 4 + 1] = g;
    colorData[i * 4 + 2] = b;
    colorData[i * 4 + 3] = 1;
}

/* node graph - storage buffer instancing */

// storage buffer nodes: wrap data in StorageBufferAttribute, renderer auto-uploads.
// no manual device.createBuffer / device.queue.writeBuffer / material.uniforms.set needed.
const matrixAttr = new g.StorageBufferAttribute(matrixData, 16); // 16 floats per mat4x4f
const colorAttr  = new g.StorageBufferAttribute(colorData, 4);   // 4 floats per vec4f
const instanceMatrices = g.storage(matrixAttr, d.array(d.mat4x4f));
const instanceColors   = g.storage(colorAttr,  d.array(d.vec4f));

// index into the storage arrays.
const modelMat   = g.index(instanceMatrices, g.instanceIndex);
const rawColor   = g.index(instanceColors,   g.instanceIndex);

// also demo instancedBufferAttribute for the spin offset — shows both APIs together.
// each instance gets a unique starting angle (in radians) baked into a vertex buffer.
const spinOffsets = new Float32Array(N);
for (let i = 0; i < N; i++) spinOffsets[i] = (i / N) * Math.PI * 2;
const spinOffset = g.instancedBufferAttribute(spinOffsets, d.f32, 4, 0);

// animate rotation: time.elapsed drives a per-instance spin via the storage matrix +
// a small additional rotation sourced from the instancedBufferAttribute offset.

// derive a per-instance Y-axis rotation node from the spin offset attribute.
// we fold it into the final clip position rather than modifying the storage matrix.
// rotation angle = elapsed * speed + spinOffset
const speed   = g.f32(0.8);
const angle   = g.timeElapsed.mul(speed).add(spinOffset);
const cosA    = angle.cos();
const sinA    = angle.sin();

// build a Y-axis rotation matrix from scalar nodes.
// mat4x4f column-major: col0..col3
const zero  = g.f32(0);
const one   = g.f32(1);
const rotY  = g.mat4(
    g.vec4(cosA,  zero, sinA.negate(), zero),
    g.vec4(zero,  one,  zero,          zero),
    g.vec4(sinA,  zero, cosA,          zero),
    g.vec4(zero,  zero, zero,          one),
);

const pos       = g.attribute(d.vec3f, 'position');
const localPos  = g.vec4(pos, g.f32(1));

// final transform: camera * storageMatrix * rotY * localPos
const worldPos  = g.mul(modelMat, g.mul(rotY, localPos));
const viewPos   = g.mul(g.cameraViewMatrix, worldPos);
const clipPos   = g.mul(g.cameraProjectionMatrix, viewPos);

// pass color to fragment via varying.
const vColor    = g.varying(rawColor, 'v_color');

// pulse brightness with time
const pulse     = g.f32(0.08).mul(g.f32(1).add(g.timeElapsed.mul(g.f32(3)).sin()));
const finalColor = g.vec4(
    vColor.rgb.add(g.vec3f(1, 1, 1).mul(pulse)),
    g.f32(1),
);

const material = new g.Material({ vertex: clipPos, fragment: finalColor });

/* setup renderer and scene */

const renderer = new g.WebGPURenderer({ antialias: true });
renderer.inspector = new g.Inspector();
await renderer.init();

document.body.appendChild(renderer.domElement);
document.body.appendChild((renderer.inspector as g.Inspector).domElement);
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);

const scene   = new g.Scene();
const camera  = new g.PerspectiveCamera(
    Math.PI / 4,
    window.innerWidth / window.innerHeight,
    0.1,
    200,
);
camera.position[2] = 20;
scene.add(camera);
scene.updateWorldMatrix();
camera.updateViewMatrix();

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

const mesh  = new g.Mesh(g.createBoxGeometry(1, 1, 1), material);
mesh.count  = N;
scene.add(mesh);

const scenePass = g.pass(scene, camera);
const outputNode = scenePass.getTextureNode();

function frame() {
    renderer.render(outputNode);
    requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// ---------------------------------------------------------------------------
// HSV → RGB helper
// ---------------------------------------------------------------------------

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
    const c  = v * s;
    const x  = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m  = v - c;
    let r = 0, g = 0, b = 0;
    if      (h < 60)  { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else              { r = c; g = 0; b = x; }
    return [r + m, g + m, b + m];
}
