import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    color,
    createBoxGeometry,
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
    Scene,
    varying,
    vec3,
    vec4,
    WebGPURenderer
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

    const pos = attribute('vec3f', 'position');
    const norm = attribute('vec3f', 'normal');

    const localPos = vec4(pos, f32(1));
    const worldPos = mul(modelWorldMatrix, localPos);
    const viewPos = mul(cameraViewMatrix, worldPos);
    const clipPos = mul(cameraProjectionMatrix, viewPos);

    const worldNorm = mul(modelNormalMatrix, vec3(norm.x, norm.y, norm.z));
    const vNorm = varying('vec3f', 'v_norm', normalize(worldNorm));

    const lightDir = vec3(f32(0.6), f32(1.0), f32(0.8)).normalize();
    const diffuse = vNorm.dot(lightDir).max(f32(0.15));

    const baseColor = color('#f60');
    const litColor = vec3(baseColor.x, baseColor.y, baseColor.z).mul(diffuse);

    const mat = new Material({
        vertex: clipPos,
        fragment: vec4(litColor, f32(1)),
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
