import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    rgb,
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
    OrbitControls,
    pass,
    PerspectiveCamera,
    Scene,
    varying,
    vec3,
    vec4,
    WebGPURenderer,
    RenderPipeline,
    renderOutput,
} from 'gpucat';

async function main() {
    const renderer = new WebGPURenderer({ antialias: true });
    renderer.inspector = new Inspector();
    await renderer.init();

    document.body.appendChild(renderer.domElement);
    document.body.appendChild((renderer.inspector as Inspector).domElement);
    renderer.setPixelRatio(devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);

    const scene = new Scene();

    const camera = new PerspectiveCamera(
        Math.PI / 4,
        window.innerWidth / window.innerHeight,
        0.1,
        100,
    );
    camera.position[2] = 50;
    scene.add(camera);
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    const controls = new OrbitControls(camera, renderer.domElement);

    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth, window.innerHeight);
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

    const material = new Material({
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

    const scenePass = pass(scene, camera);
    const outputNode = renderOutput(scenePass.getTextureNode());
    const renderPipeline = new RenderPipeline(renderer, outputNode);

    function frame() {
        renderPipeline.render();
        controls.update();
        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

main().catch(console.error);
