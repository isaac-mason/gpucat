import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createBoxGeometry,
    createCanvasTarget,
    createMaterial,
    d,
    f32,
    frame,
    fullscreen,
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
    rgb,
    Scene,
    varying,
    vec3,
    vec4,
    webgpu,
} from 'gpucat';

async function main() {
    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    document.body.appendChild(canvas);

    const view = createCanvasTarget(canvas, { samples: 4 });
    view.setPixelRatio(devicePixelRatio);
    view.setSize(window.innerWidth, window.innerHeight);

    const renderer = await init(webgpu());
    renderer.inspector = new Inspector();

    document.body.appendChild((renderer.inspector as Inspector).domElement);

    const scene = new Scene();

    const camera = new PerspectiveCamera(Math.PI / 4, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position[2] = 50;
    scene.add(camera);
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    const controls = new OrbitControls(camera, canvas);

    window.addEventListener('resize', () => {
        view.setSize(window.innerWidth, window.innerHeight);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    });

    const position = attribute('position', d.vec3f);
    const normal = attribute('normal', d.vec3f);

    const localPosition = vec4(position, f32(1)).toVar('localPos');
    const worldPosition = mul(modelWorldMatrix, localPosition).toVar('worldPos');
    const viewPosition = mul(cameraViewMatrix, worldPosition).toVar('viewPos');
    const clipPosition = mul(cameraProjectionMatrix, viewPosition).toVar('clipPos');

    const worldNormal = mul(modelNormalMatrix, vec3(normal.x, normal.y, normal.z)).toVar('worldNormal');

    const vNormal = varying(normalize(worldNormal), 'v_norm');

    const lightDirection = vec3(f32(0.6), f32(1.0), f32(0.8)).normalize().toVar('lightDir').inspect('light direction');
    const diffuse = vNormal.dot(lightDirection).max(f32(0.15)).toVar('diffuse').inspect('diffuse lighting');

    const baseColor = rgb('#f60').toVar('baseColor');
    const litColor = vec3(baseColor.x, baseColor.y, baseColor.z).mul(diffuse).toVar('litColor');

    const material = createMaterial({
        vertex: clipPosition,
        fragment: vec4(litColor, f32(1)),
    });

    const geometry = createBoxGeometry(1, 1, 1);

    const rows = 30;
    const cols = 30;
    for (let x = 0; x < cols; x++) {
        for (let y = 0; y < rows; y++) {
            const mesh = new Mesh(geometry, material);
            mesh.position[0] = (x - cols / 2) * 1.5;
            mesh.position[1] = (y - rows / 2) * 1.5;
            scene.add(mesh);
        }
    }

    // Update world matrices once - meshes are static
    scene.updateWorldMatrix();

    const scenePass = renderTexture(scene, camera);
    const outputNode = renderOutput(scenePass.getTextureNode());
    const composite = fullscreen(outputNode);
    function update() {
        const f = frame(renderer);
        const compositePass = f.pass({ target: view });
        compositePass.draw(composite);
        compositePass.end();
        f.submit();
        controls.update();
        requestAnimationFrame(update);
    }

    requestAnimationFrame(update);
}

main().catch(console.error);
