// A WebGPU-only app's imports. The WebGL backend and the GLSL emitter must not reach the bundle.
import {
    attribute,
    createCanvasTarget,
    d,
    f32,
    fullscreen,
    init,
    Material,
    Mesh,
    PerspectiveCamera,
    Scene,
    vec4,
    webgpu,
} from '../../dist/index.js';

const view = createCanvasTarget(document.createElement('canvas'));
const gpu = await init(webgpu());
const scene = new Scene();
scene.add(new Mesh(undefined, new Material({ vertex: vec4(attribute('position', d.vec3f), f32(1)), fragment: vec4(1, 1, 1, 1) })));

const frame = gpu.frame();
const pass = frame.pass({ target: view, camera: new PerspectiveCamera() });
pass.draw(fullscreen(vec4(1, 0, 0, 1)));
pass.end();
frame.submit();
