import * as g from 'gpucat';
import { d, packStructArray, writeStructArray, createVertexBuffer, createIndexBuffer, createIndirectBuffer } from 'gpucat';
import { mat4, quat, vec3 } from 'mathcat';

const TOTAL = 120; // total instances
const COLS  = 12;
const ROWS  = TOTAL / COLS;
const SPACING = 2.0;

const boxSource    = g.createBoxGeometry(0.8, 0.8, 0.8);
const sphereSource = g.createSphereGeometry(0.5, 16, 8);

const boxPos    = boxSource.buffers.get('position')!.array    as Float32Array;
const boxNorm   = boxSource.buffers.get('normal')!.array      as Float32Array;
const boxIdx    = boxSource.index!.array as Uint16Array;

const sphPos    = sphereSource.buffers.get('position')!.array as Float32Array;
const sphNorm   = sphereSource.buffers.get('normal')!.array   as Float32Array;
const sphIdx    = sphereSource.index!.array as Uint16Array;

const mergedPos  = new Float32Array(boxPos.length  + sphPos.length);
const mergedNorm = new Float32Array(boxNorm.length + sphNorm.length);
mergedPos.set(boxPos);   mergedPos.set(sphPos,  boxPos.length);
mergedNorm.set(boxNorm); mergedNorm.set(sphNorm, boxNorm.length);

const mergedIdx = new Uint16Array(boxIdx.length + sphIdx.length);
mergedIdx.set(boxIdx);
mergedIdx.set(sphIdx, boxIdx.length);

const boxVertCount = boxPos.length / 3;
const boxIdxCount  = boxIdx.length;
const sphIdxCount  = sphIdx.length;

const mergedGeometry = new g.Geometry();
mergedGeometry.setBuffer('position', createVertexBuffer(d.vec3f, mergedPos));
mergedGeometry.setBuffer('normal', createVertexBuffer(d.vec3f, mergedNorm));
mergedGeometry.index = createIndexBuffer(mergedIdx);

const instanceMatrices = new Float32Array(TOTAL * 16);
const instanceHues     = new Float32Array(TOTAL);      // [0..1] for color

const _translation = vec3.create();
const _scale = vec3.fromValues(1, 1, 1);
const _quat = quat.create();
const _matrix = mat4.create();

for (let i = 0; i < TOTAL; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    _translation[0] = (col - (COLS - 1) * 0.5) * SPACING;
    _translation[1] = (row - (ROWS - 1) * 0.5) * SPACING;
    _translation[2] = 0;
    mat4.fromRotationTranslationScale(_matrix, _quat, _translation, _scale);
    instanceMatrices.set(_matrix, i * 16);
    instanceHues[i] = i / TOTAL;
}

const stride = 16 * 4;
const col0 = g.instancedBufferAttribute(instanceMatrices, d.vec4f, stride, 0);
const col1 = g.instancedBufferAttribute(instanceMatrices, d.vec4f, stride, 16);
const col2 = g.instancedBufferAttribute(instanceMatrices, d.vec4f, stride, 32);
const col3 = g.instancedBufferAttribute(instanceMatrices, d.vec4f, stride, 48);
const instanceTransform = g.mat4(col0, col1, col2, col3);

const instanceHue = g.instancedBufferAttribute(instanceHues, d.f32, 4, 0);

const pos = g.attribute('position', d.vec3f);
const norm = g.attribute('normal', d.vec3f);

const localPos = g.vec4(pos, g.f32(1.0));
const worldPos = g.mul(instanceTransform, localPos);
const viewPos  = g.mul(g.cameraViewMatrix, worldPos);
const clipPos  = g.mul(g.cameraProjectionMatrix, viewPos);

// world-space normal (no non-uniform scale so instanceTransform is fine)
const worldNorm = g.vec4(norm, g.f32(0.0));
const tformedNorm = g.mul(instanceTransform, worldNorm);

// simple diffuse lighting from a fixed light direction
const lightDir  = g.vec3f(0.6, 1.0, 0.8).normalize();
const vNorm = g.varying(tformedNorm.xyz, 'v_norm');
const vHue = g.varying(instanceHue, 'v_hue');

const diffuse = vNorm.normalize().dot(lightDir).max(g.f32(0.15));

// HSV-like color from hue: oscillate through red→yellow→green→cyan→blue→magenta
const pulse = g.timeElapsed.mul(g.f32(0.4)).sin().mul(g.f32(0.05)).add(g.f32(1.0));
const colR = vHue.mul(g.f32(Math.PI * 2)).sin().mul(g.f32(0.5)).add(g.f32(0.5));
const colG = vHue.mul(g.f32(Math.PI * 2)).add(g.f32(Math.PI * 2 / 3)).sin().mul(g.f32(0.5)).add(g.f32(0.5));
const colB = vHue.mul(g.f32(Math.PI * 2)).add(g.f32(Math.PI * 4 / 3)).sin().mul(g.f32(0.5)).add(g.f32(0.5));
const baseColor = g.vec3(colR, colG, colB);
const litColor  = baseColor.mul(diffuse).mul(pulse);
const finalColor = g.vec4(litColor, g.f32(1.0));

const material = new g.Material({ vertex: clipPos, fragment: finalColor });

// ---------------------------------------------------------------------------
// 4. One GpuBuffer with drawCount=2 for indirect indexed draws
//    draw 0 → box sub-range    (firstIndex=0,          baseVertex=0,         firstInstance=0)
//    draw 1 → sphere sub-range (firstIndex=boxIdxCount, baseVertex=boxVerts, firstInstance=TOTAL/2)
//
//    Indexed stride = 5 u32s per draw:
//      [draw*5+0] indexCount
//      [draw*5+1] instanceCount
//      [draw*5+2] firstIndex
//      [draw*5+3] baseVertex
//      [draw*5+4] firstInstance
// ---------------------------------------------------------------------------

const indirectData = new Uint32Array(packStructArray(g.DrawIndexedIndirect, [
    { indexCount: boxIdxCount, instanceCount: TOTAL / 2, firstIndex: 0,           baseVertex: 0,           firstInstance: 0        },
    { indexCount: sphIdxCount, instanceCount: TOTAL / 2, firstIndex: boxIdxCount, baseVertex: boxVertCount, firstInstance: TOTAL / 2 },
]));

const indirectBuffer = createIndirectBuffer(g.DrawIndexedIndirect, indirectData);
mergedGeometry.indirect = indirectBuffer;

// ---------------------------------------------------------------------------
// 5. Main
// ---------------------------------------------------------------------------

async function main() {
    const renderer = new g.WebGPURenderer({ antialias: true });
    renderer.inspector = new g.Inspector();
    await renderer.init();

    document.body.appendChild(renderer.domElement);
    document.body.appendChild((renderer.inspector as g.Inspector).domElement);
    renderer.setPixelRatio(devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.clearColor = [0.07, 0.07, 0.1, 1];

    const scene = new g.Scene();
    const camera = new g.PerspectiveCamera(
        Math.PI / 4,
        window.innerWidth / window.innerHeight,
        0.1,
        200,
    );
    camera.position[2] = 28;
    scene.add(camera);
    // Static scene — set matrices once after setup.
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth, window.innerHeight);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    });

    // One mesh, one merged geometry, one IndirectBuffer (drawCount=2).
    const mesh = new g.Mesh(mergedGeometry, material);
    scene.add(mesh);

    const scenePass = g.pass(scene, camera);
    const outputNode = scenePass.getTextureNode();

    // -----------------------------------------------------------------------
    // UI — slider to split instances between boxes and spheres at runtime
    // -----------------------------------------------------------------------

    const ui = document.createElement('div');
    ui.style.cssText = `
        position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
        background: rgba(0,0,0,0.6); color: #fff; padding: 12px 20px;
        border-radius: 8px; font-family: monospace; font-size: 13px;
        display: flex; flex-direction: column; align-items: center; gap: 8px;
        pointer-events: all; user-select: none;
    `;

    const label = document.createElement('span');
    label.textContent = `boxes: ${TOTAL / 2}   spheres: ${TOTAL / 2}`;

    const slider = document.createElement('input');
    slider.type  = 'range';
    slider.min   = '0';
    slider.max   = String(TOTAL);
    slider.value = String(TOTAL / 2);
    slider.style.width = '240px';

    slider.addEventListener('input', () => {
        const boxCount = Number(slider.value);
        const sphCount = TOTAL - boxCount;

        writeStructArray(g.DrawIndexedIndirect, [
            { indexCount: boxIdxCount, instanceCount: boxCount, firstIndex: 0,           baseVertex: 0,           firstInstance: 0        },
            { indexCount: sphIdxCount, instanceCount: sphCount, firstIndex: boxIdxCount, baseVertex: boxVertCount, firstInstance: boxCount },
        ], indirectBuffer.array!.buffer as ArrayBuffer, 0);
        indirectBuffer.needsUpdate = true;

        label.textContent = `boxes: ${boxCount}   spheres: ${sphCount}`;
    });

    ui.appendChild(label);
    ui.appendChild(slider);
    document.body.appendChild(ui);

    function frame() {
        renderer.render(outputNode);
        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

main();
