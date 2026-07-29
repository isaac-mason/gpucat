import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createBoxGeometry,
    d,
    f32,
    Inspector,
    Material,
    Mesh,
    modelNormalMatrix,
    modelWorldMatrix,
    mul,
    normalize,
    pass,
    PerspectiveCamera,
    renderOutput,
    RenderPipeline,
    Scene,
    texture,
    Texture,
    varying,
    vec3,
    vec4,
    WebGPURenderer,
    type Node,
} from 'gpucat';
import { quat, type Euler } from 'mathcat';

/**
 * Video Texture Example
 *
 * An `HTMLVideoElement` used directly as a texture, mapped onto a spinning cube.
 * Each frame the texture is marked `needsUpdate`, and the renderer copies the
 * current video frame into the GPU texture (via `copyExternalImageToTexture`) —
 * no new texture type needed, a video is just a `Texture` whose contents change
 * every frame, then sampled like any other.
 *
 * Test clip: Big Buck Bunny — © 2008 Blender Foundation / bigbuckbunny.org,
 * licensed CC-BY 3.0. Bundled (same-origin) so the WebGPU frame copy isn't blocked
 * by CORS; a cross-origin video would need `video.crossOrigin = 'anonymous'` plus
 * CORS headers from the host.
 */

// A muted, looping, inline video autoplays without a user gesture.
const video = document.createElement('video');
video.src = `${import.meta.env.BASE_URL}videos/big-buck-bunny.mp4`;
video.loop = true;
video.muted = true;
video.playsInline = true;
video.crossOrigin = 'anonymous';

const renderer = new WebGPURenderer({ antialias: true });
renderer.inspector = new Inspector();
await renderer.init();

document.body.appendChild(renderer.domElement);
document.body.appendChild((renderer.inspector as Inspector).domElement);
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new Scene();
const camera = new PerspectiveCamera(Math.PI / 4, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position[2] = 3;
scene.add(camera);
scene.updateWorldMatrix();
camera.updateViewMatrix();

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

// Start playback and wait until the video has a decodable frame (and real
// dimensions) before sampling it — otherwise videoWidth/Height are 0.
await video.play().catch(() => {
    // Autoplay can be blocked; muted inline playback is allowed in all major browsers.
});
if (video.readyState < 2) {
    await new Promise<void>((resolve) => video.addEventListener('loadeddata', () => resolve(), { once: true }));
}

// The video element is the texture's source — re-copied each frame in the loop.
// `rgba8unorm-srgb` so sampling decodes the video's sRGB bytes to linear (correct for
// lighting + the sRGB output encode below). No mipmaps: the cube fills the view (no
// minification) and regenerating mips every frame would be wasteful.
const videoTexture = new Texture(video, { format: 'rgba8unorm-srgb', generateMipmaps: false });

// vertex: standard model-view-projection, pass uv + world normal to the fragment.
const position = attribute('position', d.vec3f).toVar('position');
const normal = attribute('normal', d.vec3f).toVar('normal');
const uvAttr = attribute('uv', d.vec2f).toVar('uv');

const worldPosition = mul(modelWorldMatrix, vec4(position, f32(1))).toVar('worldPos');
const clipPosition = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPosition)).toVar('clipPos');

const vNormal = varying(normalize(mul(modelNormalMatrix, normal)), 'v_norm');
const vUv = varying(uvAttr, 'v_uv');

// fragment: sample the video texture, with gentle directional lighting so the
// cube's faces read as 3D.
const texColor = texture(videoTexture).sample(vUv as unknown as Node<d.vec2f>);
const lightDir = vec3(f32(0.5), f32(0.8), f32(1.0)).normalize();
const diffuse = vNormal.dot(lightDir).max(f32(0.35));
const litColor = texColor.xyz.mul(diffuse);

const material = new Material({
    vertex: clipPosition,
    fragment: vec4(litColor, f32(1)),
});

const mesh = new Mesh(createBoxGeometry(1.4, 1.4, 1.4), material);
scene.add(mesh);

const scenePass = pass(scene, camera);
// Skip tone mapping — that's for HDR scene colour; a video is already display-graded,
// so we want it shown faithfully (the sRGB output encode still runs for the swapchain).
const outputNode = renderOutput(scenePass.getTextureNode(), { toneMapping: 'none' });
const renderPipeline = new RenderPipeline(renderer, outputNode);

let angle = 0;
let prevTime = performance.now() / 1000;

function frame() {
    const now = performance.now() / 1000;
    const dt = now - prevTime;
    prevTime = now;

    angle += dt * 0.6;
    quat.fromEuler(mesh.quaternion, [angle * 0.35, angle, 0, 'yxz'] as Euler);
    mesh.updateWorldMatrix();

    // Re-copy the current video frame into the GPU texture this frame.
    videoTexture.needsUpdate = true;
    renderPipeline.render();
    requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
