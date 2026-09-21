/**
 * example-discard-dithering.ts
 *
 * Demonstrates the Discard() control flow node with an ordered dithering effect.
 * A 4x4 Bayer matrix threshold is compared against a time-varying opacity driven
 * by sin(time). Fragments that fall below the threshold are discarded, creating
 * an animated dissolve/dither pattern that fades in and out.
 */

import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createCanvasTarget,
    createMaterial,
    createSphereGeometry,
    Discard,
    d,
    Fn,
    f32,
    fragCoord,
    frame,
    fullscreen,
    If,
    Inspector,
    init,
    Mesh,
    modelNormalMatrix,
    modelWorldMatrix,
    mul,
    type Node,
    normalize,
    OrbitControls,
    PerspectiveCamera,
    renderOutput,
    renderTexture,
    Scene,
    sin,
    uniform,
    varying,
    vec3,
    vec4,
    webgpu,
    wgslFn,
} from 'gpucat';
import { type Euler, quat } from 'math';

// 4x4 Bayer dither threshold — returns a value in [0,1) for the pixel coordinate
const bayerThreshold = wgslFn(
    `
fn bayerThreshold(coord: vec2f) -> f32 {
    let x = u32(coord.x) % 4u;
    let y = u32(coord.y) % 4u;
    let index = x + y * 4u;

    // Bayer 4x4 matrix (values 0..15 mapped to 0..1)
    var m: array<f32, 16> = array<f32, 16>(
         0.0,  8.0,  2.0, 10.0,
        12.0,  4.0, 14.0,  6.0,
         3.0, 11.0,  1.0,  9.0,
        15.0,  7.0, 13.0,  5.0
    );

    return m[index] / 16.0;
}
`,
    { output: d.f32 },
);

// Fragment function that performs dithered discard
const ditherFragment = Fn(
    (color, screenPos, opacity) => {
        const threshold = bayerThreshold(screenPos);

        If(opacity.lessThan(threshold), () => {
            Discard();
        });

        return color;
    },
    {
        name: 'ditherFragment',
        params: [
            { name: 'color', type: d.vec4f },
            { name: 'screenPos', type: d.vec2f },
            { name: 'opacity', type: d.f32 },
        ],
    },
);

async function main() {
    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    document.body.appendChild(canvas);

    const view = createCanvasTarget(canvas);
    view.setPixelRatio(devicePixelRatio);
    view.setSize(window.innerWidth, window.innerHeight);

    const renderer = await init(webgpu());
    renderer.inspector = new Inspector();

    document.body.appendChild((renderer.inspector as Inspector).domElement);

    view.clearColor = [0.08, 0.08, 0.12, 1];

    const scene = new Scene();

    const camera = new PerspectiveCamera(Math.PI / 4, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position[2] = 5;
    scene.add(camera);

    const controls = new OrbitControls(camera, canvas);

    window.addEventListener('resize', () => {
        view.setSize(window.innerWidth, window.innerHeight);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    });

    // Vertex setup
    const position = attribute('position', d.vec3f);
    const normal = attribute('normal', d.vec3f);

    const worldPos = mul(modelWorldMatrix, vec4(position, f32(1)));
    const clipPos = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPos));

    const vNormal = varying(normalize(mul(modelNormalMatrix, normal)), 'vNormal');

    // Fragment: lit color + dithered discard
    const lightDir = vec3(0.6, 1.0, 0.8).normalize();
    const diffuse = vNormal.dot(lightDir).max(f32(0.15));
    const baseColor = vec3(0.9, 0.3, 0.1);
    const litColor = vec4(baseColor.mul(diffuse), f32(1));

    // Opacity oscillates 0..1 via sin(time). `time` is a user-driven uniform (seconds).
    const time = uniform(f32(0), 'time');
    const opacity = sin(time.mul(f32(1.5)))
        .mul(f32(0.5))
        .add(f32(0.5));
    const screenPos = fragCoord.xy as Node<d.vec2f>;

    const fragmentOutput = ditherFragment(litColor, screenPos, opacity) as Node<d.vec4f>;

    const material = createMaterial({
        vertex: clipPos,
        fragment: fragmentOutput,
    });

    const geometry = createSphereGeometry(1, 32, 24);
    const mesh = new Mesh(geometry, material);
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
        time.value = now;

        angle += dt * 0.3;
        quat.fromEuler(mesh.quaternion, [angle * 0.5, angle, 0, 'yxz'] as Euler);
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
