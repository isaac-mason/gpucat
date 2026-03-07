import {
    abs,
    attribute,
    BufferAttribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    cross,
    d,
    DrawIndirect,
    f32,
    Fn,
    Geometry,
    globalId,
    If,
    IndirectStorageBufferAttribute,
    Inspector,
    instancedBufferAttribute,
    Material,
    Mesh,
    mix,
    mul,
    pass,
    PerspectiveCamera,
    pow,
    Scene,
    storage,
    timeElapsed,
    u32,
    varying,
    vec4,
    WebGPURenderer,
} from "gpucat";

// positions: three verts of a flat equilateral triangle in XY plane
const positions = new Float32Array([
    0.025, -0.025, 0, -0.025, 0.025, 0, 0, 0, 0.025,
]);

/* per instance attributes */
const INSTANCES = 100_000;

const offsetData = new Float32Array(INSTANCES * 3);
const colorData = new Float32Array(INSTANCES * 4);
const orientationStartData = new Float32Array(INSTANCES * 4);
const orientationEndData = new Float32Array(INSTANCES * 4);

for (let i = 0; i < INSTANCES; i++) {
    // random offset in unit cube
    offsetData[i * 3 + 0] = Math.random() - 0.5;
    offsetData[i * 3 + 1] = Math.random() - 0.5;
    offsetData[i * 3 + 2] = Math.random() - 0.5;

    // random color (rgba)
    colorData[i * 4 + 0] = Math.random();
    colorData[i * 4 + 1] = Math.random();
    colorData[i * 4 + 2] = Math.random();
    colorData[i * 4 + 3] = Math.random();

    // random unit quaternion — orientationStart
    let [x, y, z, w] = [
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
    ];
    let len = Math.sqrt(x * x + y * y + z * z + w * w);
    orientationStartData[i * 4 + 0] = x / len;
    orientationStartData[i * 4 + 1] = y / len;
    orientationStartData[i * 4 + 2] = z / len;
    orientationStartData[i * 4 + 3] = w / len;

    // random unit quaternion — orientationEnd
    [x, y, z, w] = [
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
    ];
    len = Math.sqrt(x * x + y * y + z * z + w * w);
    orientationEndData[i * 4 + 0] = x / len;
    orientationEndData[i * 4 + 1] = y / len;
    orientationEndData[i * 4 + 2] = z / len;
    orientationEndData[i * 4 + 3] = w / len;
}

const attrOffset = instancedBufferAttribute(offsetData, d.vec3f, 12, 0);
const attrColor = instancedBufferAttribute(colorData, d.vec4f, 16, 0);
const attrOrientationStart = instancedBufferAttribute(
    orientationStartData,
    d.vec4f,
    16,
    0,
);
const attrOrientationEnd = instancedBufferAttribute(
    orientationEndData,
    d.vec4f,
    16,
    0,
);

/* indirect draw buffer */
// non-indexed DrawIndirect, struct-typed
//    layout (u32 slots):
//      [0] vertexCount    — 3
//      [1] instanceCount  — written by GPU compute each frame
//      [2] firstVertex    — 0
//      [3] firstInstance  — 0

// non-indexed, 1 draw.
const drawBuffer = new IndirectStorageBufferAttribute(false, 1);

// struct-typed storage node — mirrors: storage(drawBuffer, DrawIndirect, drawBuffer.count)
const drawStorage = storage(drawBuffer, DrawIndirect, "read_write");

/* compute shaders */
//
//    computeInit  (1 thread)  — seeds the draw arguments once per frame before
//                               computeUpdate runs. Resets instanceCount to 0
//                               so the update can accumulate cleanly (here it
//                               just overwrites, but the pattern is correct).
//
//    computeUpdate (N threads) — each frame, thread 0 calculates the desired
//                               instanceCount from sin(time) and writes it.
//                               (No atomics needed — single writer, single slot.)

const computeInit = Fn(() => {
    drawStorage.vertexCount.assign(u32(3));
    drawStorage.instanceCount.assign(u32(0));
    drawStorage.firstVertex.assign(u32(0));
    drawStorage.firstInstance.assign(u32(0));
}).compute({ workgroupSize: [1, 1, 1], dispatch: [1] });

const computeUpdate = Fn(() => {
    // only thread 0 writes — avoids needing atomics.
    If(globalId.x.eq(u32(0)), () => {
        const halfTime = timeElapsed.mul(f32(0.5)).sin();
        // map sin ∈ [-1,1] → range 1→0→1 → then pow4 → count
        const sinPlus1 = halfTime.add(f32(1)); // [0,2]
        const raised = pow(sinPlus1, f32(4)); // [0,16]
        const countF = raised.mul(f32(INSTANCES / 16)); // [0, N]
        const instanceCount = countF.max(f32(100)); // min 100
        drawStorage.instanceCount.assign(instanceCount.toU32());
    });
}).compute({
    workgroupSize: [64, 1, 1],
    dispatch: [Math.ceil(INSTANCES / 64)],
});

/* render node graph */

// built-in per-vertex position.
const vtxPos = attribute(d.vec3f, "position");

// per-instance attributes.
const offset = attrOffset;
const color = attrColor;
const orientationStart = attrOrientationStart;
const orientationEnd = attrOrientationEnd;

// animate: halfTime ∈ [-1, 1]
const halfTime = timeElapsed.mul(f32(0.5)).sin();

// oscillate vertex position with offset
const oscRange = abs(halfTime.mul(f32(2.0)).add(f32(1.0))).max(f32(0.5));
const sphereOsc = offset.mul(oscRange).add(vtxPos);

// quaternion rotation: v' = v + 2w(q×v) + 2(q×(q×v))
//   orientation = normalize(mix(orientationStart, orientationEnd, halfTime))
const orientation = mix(
    orientationStart,
    orientationEnd,
    halfTime.add(f32(1)).mul(f32(0.5)),
).normalize();
const vcV = cross(orientation.xyz, sphereOsc);
const crossvcV = cross(orientation.xyz, vcV);
const rotated = vcV
    .mul(orientation.w.mul(f32(2)))
    .add(crossvcV.mul(f32(2)).add(sphereOsc));

// varyings
const vPosition = varying(rotated, "vPosition");
const vColor = varying(color, "vColor");

// project to clip space (no model matrix — instances live in camera space units)
const worldPos4 = vec4(rotated, f32(1));
const viewPos = mul(cameraViewMatrix, worldPos4);
const clipPos = mul(cameraProjectionMatrix, viewPos);

// fragment: base color + sin ripple on x and time
const fragColor = vec4(
    vColor.x.add(vPosition.x.mul(f32(10)).add(timeElapsed).sin().mul(f32(0.5))),
    vColor.y,
    vColor.z,
    vColor.w,
);

const material = new Material({
    vertex: clipPos,
    fragment: fragColor,
    transparent: true,
    cullMode: "none",
});

const renderer = new WebGPURenderer({ antialias: true });
renderer.inspector = new Inspector();
await renderer.init();

document.body.appendChild(renderer.domElement);
document.body.appendChild((renderer.inspector as Inspector).domElement);
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.clearColor = [0, 0, 0.12, 1];

const scene = new Scene();
const camera = new PerspectiveCamera(
    50 * (Math.PI / 180),
    window.innerWidth / window.innerHeight,
    0.1,
    10_000,
);
camera.position[0] = 1;
camera.position[1] = 1;
camera.position[2] = 1;
camera.lookAt([0, 0, 0]);
scene.add(camera);

window.addEventListener("resize", () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

// geometry — non-indexed triangle, per-instance vertex buffers
const geo = new Geometry();
geo.setAttribute("position", new BufferAttribute(positions, 3));
geo.indirect = drawBuffer; // use drawIndirect

const mesh = new Mesh(geo, material);
scene.add(mesh);

scene.updateWorldMatrix();
camera.updateViewMatrix();

const scenePass = pass(scene, camera);
const outputNode = scenePass.getTextureNode();

await renderer.compileCompute(computeInit);
await renderer.compileCompute(computeUpdate);

function frame() {
    // seed draw args
    renderer.compute(computeInit);
    // GPU writes instanceCount
    renderer.compute(computeUpdate);
    // render — drawIndirect reads GPU-written instanceCount
    renderer.render(outputNode);

    requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
