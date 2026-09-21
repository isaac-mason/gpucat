/**
 * example-interleaved.ts
 *
 * Demonstrates interleaved vertex attributes: position (vec3f), normal (vec3f),
 * and color (vec3f) are packed into a single GpuBuffer with stride=36 bytes.
 *
 * Layout per vertex:
 *   [pos.x, pos.y, pos.z, norm.x, norm.y, norm.z, col.r, col.g, col.b]
 *   offset 0               offset 12               offset 24
 *   stride = 36 bytes
 *
 * The buffer is set on geometry.buffers under the name 'interleaved', and three
 * attribute() calls reference it by name with different offsets.
 * groupAttributesByBuffer groups them into one VertexBufferGroup — one
 * GPUVertexBufferLayout with three attributes, one setVertexBuffer() call.
 */

import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createCanvasTarget,
    createIndexBuffer,
    createMaterial,
    d,
    f32,
    frame,
    fullscreen,
    Geometry,
    GpuBuffer,
    Inspector,
    init,
    Mesh,
    modelNormalMatrix,
    modelWorldMatrix,
    mul,
    normalize,
    OrbitControls,
    PerspectiveCamera,
    renderOutput,
    renderTexture,
    Scene,
    varying,
    vec3,
    vec4,
    webgpu,
} from 'gpucat';
import { quat } from 'math';

// ---------------------------------------------------------------------------
// Build box geometry with fully interleaved position+normal+color buffer
// ---------------------------------------------------------------------------

const VERTEX_COUNT = 24; // 6 faces * 4 vertices
const INDEX_COUNT = 36;

// Face colours — one distinct colour per face
const FACE_COLORS: [number, number, number][] = [
    [1.0, 0.3, 0.3], // +X red
    [0.3, 1.0, 0.3], // -X green
    [0.3, 0.3, 1.0], // +Y blue
    [1.0, 1.0, 0.3], // -Y yellow
    [1.0, 0.3, 1.0], // +Z magenta
    [0.3, 1.0, 1.0], // -Z cyan
];

const FLOATS_PER_VERTEX = 9; // pos(3) + normal(3) + color(3)
const STRIDE = FLOATS_PER_VERTEX * 4; // 36 bytes

function buildBoxGeometry() {
    const hw = 0.5,
        hh = 0.5,
        hd = 0.5;

    const interleaved = new Float32Array(VERTEX_COUNT * FLOATS_PER_VERTEX);
    const indices = new Uint16Array(INDEX_COUNT);

    function writeFace(
        faceIndex: number,
        ax: number,
        ay: number,
        az: number,
        bx: number,
        by: number,
        bz: number,
        cx: number,
        cy: number,
        cz: number,
        dx: number,
        dy: number,
        dz: number,
        nx: number,
        ny: number,
        nz: number,
    ) {
        const base = faceIndex * 4;
        const il = base * FLOATS_PER_VERTEX;
        const ii = faceIndex * 6;
        const [cr, cg, cb] = FACE_COLORS[faceIndex];

        const positions = [ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz];
        for (let v = 0; v < 4; v++) {
            const off = il + v * FLOATS_PER_VERTEX;
            // position
            interleaved[off] = positions[v * 3];
            interleaved[off + 1] = positions[v * 3 + 1];
            interleaved[off + 2] = positions[v * 3 + 2];
            // normal
            interleaved[off + 3] = nx;
            interleaved[off + 4] = ny;
            interleaved[off + 5] = nz;
            // color
            interleaved[off + 6] = cr;
            interleaved[off + 7] = cg;
            interleaved[off + 8] = cb;
        }

        // Indices
        indices[ii] = base;
        indices[ii + 1] = base + 1;
        indices[ii + 2] = base + 2;
        indices[ii + 3] = base;
        indices[ii + 4] = base + 2;
        indices[ii + 5] = base + 3;
    }

    writeFace(0, hw, -hh, -hd, hw, hh, -hd, hw, hh, hd, hw, -hh, hd, 1, 0, 0); // +X
    writeFace(1, -hw, -hh, hd, -hw, hh, hd, -hw, hh, -hd, -hw, -hh, -hd, -1, 0, 0); // -X
    writeFace(2, -hw, hh, -hd, -hw, hh, hd, hw, hh, hd, hw, hh, -hd, 0, 1, 0); // +Y
    writeFace(3, -hw, -hh, hd, -hw, -hh, -hd, hw, -hh, -hd, hw, -hh, hd, 0, -1, 0); // -Y
    writeFace(4, -hw, -hh, hd, hw, -hh, hd, hw, hh, hd, -hw, hh, hd, 0, 0, 1); // +Z
    writeFace(5, hw, -hh, -hd, -hw, -hh, -hd, -hw, hh, -hd, hw, hh, -hd, 0, 0, -1); // -Z

    // Build geometry — single interleaved buffer set by name
    const geom = new Geometry();
    geom.setBuffer(
        'interleaved',
        new GpuBuffer(d.vec3f, {
            data: interleaved,
            usage: 'vertex',
        }),
    );
    geom.setIndex(createIndexBuffer(indices));

    return geom;
}

const geom = buildBoxGeometry();

// ---------------------------------------------------------------------------
// Shader graph — all three attributes reference 'interleaved' by name
// ---------------------------------------------------------------------------

const position = attribute('interleaved', d.vec3f, { stride: STRIDE, offset: 0 });
const normal = attribute('interleaved', d.vec3f, { stride: STRIDE, offset: 12 });
const color = attribute('interleaved', d.vec3f, { stride: STRIDE, offset: 24 });

const worldPos = mul(modelWorldMatrix, vec4(position, f32(1)));
const clipPos = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPos));

const vNormal = varying(normalize(mul(modelNormalMatrix, normal)), 'vNormal');
const vColor = varying(color, 'vColor');

const lightDir = vec3(0.6, 1.0, 0.8).normalize();
const diffuse = vNormal.dot(lightDir).max(f32(0.15));
const litColor = vColor.mul(diffuse);

const material = createMaterial({
    vertex: clipPos,
    fragment: vec4(litColor, f32(1)),
});

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function main() {
    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    document.body.appendChild(canvas);

    const view = createCanvasTarget(canvas, { samples: 4 });
    view.setPixelRatio(devicePixelRatio);
    view.setSize(window.innerWidth, window.innerHeight);

    const renderer = await init(webgpu());
    const inspector = new Inspector();
    renderer.inspector = inspector;

    document.body.appendChild(inspector.domElement);

    const scene = new Scene();

    const camera = new PerspectiveCamera(Math.PI / 4, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position[2] = 4;
    scene.add(camera);

    const controls = new OrbitControls(camera, canvas);

    window.addEventListener('resize', () => {
        view.setSize(window.innerWidth, window.innerHeight);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    });

    const mesh = new Mesh(geom, material);
    scene.add(mesh);

    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    const scenePass = renderTexture(scene, camera);
    const outputNode = renderOutput(scenePass.getTextureNode());
    const composite = fullscreen(outputNode);
    let angle = 0;
    let prevTime = performance.now() / 1000;

    function update() {
        const now = performance.now() / 1000;
        const dt = now - prevTime;
        prevTime = now;

        angle += dt * 0.5;
        quat.fromEuler(mesh.quaternion, [angle * 0.7, angle, 0, 'xyz']);
        mesh.updateWorldMatrix();

        controls.update();
        const f = frame(renderer);
        const compositePass = f.pass({ target: view });
        compositePass.draw(composite);
        compositePass.end();
        f.submit();
        requestAnimationFrame(update);
    }

    requestAnimationFrame(update);
}

main().catch(console.error);
