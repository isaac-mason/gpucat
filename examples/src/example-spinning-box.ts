import {
    createBoxGeometry,
    color,
    f32,
    Inspector,
    Material,
    Mesh,
    pass,
    PerspectiveCamera,
    Scene,
    vec4,
    WebGPURenderer,
} from 'gpucat';
import { quat, type Euler } from 'mathcat';

async function main() {
    const renderer = new WebGPURenderer({ antialias: true });
    renderer.inspector = new Inspector();
    await renderer.init();

    document.body.appendChild(renderer.domElement);
    document.body.appendChild((renderer.inspector as Inspector).domElement);
    renderer.setSize(window.innerWidth * devicePixelRatio, window.innerHeight * devicePixelRatio);

    const scene = new Scene();

    const camera = new PerspectiveCamera(
        Math.PI / 4,
        window.innerWidth / window.innerHeight,
        0.1,
        100,
    );
    camera.position[2] = 5;
    scene.add(camera);
    // Initial matrix setup — camera doesn't move after this so only needed once.
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth * devicePixelRatio, window.innerHeight * devicePixelRatio);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    });

    const mat = new Material({
        color: vec4(color('#f60'), f32(1)),
    });

    const mesh = new Mesh(createBoxGeometry(1, 1, 1), mat);
    scene.add(mesh);

    const scenePass = pass(scene, camera);
    const outputNode = scenePass.getTextureNode();

    let angle = 0;

    let prevTime = performance.now() / 1000;

    function frame() {
        const now = performance.now() / 1000;
        const dt = now - prevTime;
        prevTime = now;

        angle += dt * 0.8;

        quat.fromEuler(mesh.quaternion, [0, angle, 0.2 * Math.sin(angle * 0.5), 'yxz'] as Euler);
        mesh.updateWorldMatrix();

        renderer.render(outputNode);
        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

main().catch(console.error);
