import {
    attribute,
    CubeTexture,
    cameraProjectionMatrix,
    cameraViewMatrix,
    compile,
    createBoxGeometry,
    createCanvasTarget,
    createMaterial,
    cubeTexture,
    d,
    f32,
    frame,
    fullscreen,
    Inspector,
    init,
    Mesh,
    modelWorldMatrix,
    mul,
    OrbitControls,
    PerspectiveCamera,
    renderOutput,
    renderTexture,
    Scene,
    varying,
    vec4,
    webgpu,
} from 'gpucat';

/**
 * Create a labeled face image for one side of a cube texture.
 * Each face gets a distinct color and a text label so it's immediately
 * obvious whether the faces are mapped correctly.
 */
function createFaceImage(label: string, color: string, size = 512): OffscreenCanvas {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d')!;

    // Fill background
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, size, size);

    // Draw border
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = size * 0.02;
    ctx.strokeRect(0, 0, size, size);

    // Draw label
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.font = `bold ${size * 0.15}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, size / 2, size / 2);

    return canvas;
}

/**
 * Create 6 face ImageBitmaps for a cube texture.
 * Order: +X, -X, +Y, -Y, +Z, -Z
 */
async function createCubeFaces(size = 512): Promise<ImageBitmap[]> {
    const faces: [string, string][] = [
        ['+X', '#e74c3c'], // red
        ['-X', '#1abc9c'], // teal
        ['+Y', '#2ecc71'], // green
        ['-Y', '#9b59b6'], // purple
        ['+Z', '#3498db'], // blue
        ['-Z', '#f1c40f'], // yellow
    ];

    return Promise.all(faces.map(([label, color]) => createImageBitmap(createFaceImage(label, color, size))));
}

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

    const camera = new PerspectiveCamera(Math.PI / 3, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position[2] = 0.01; // Inside the box, slightly off-center so orbit works
    scene.add(camera);
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    const controls = new OrbitControls(camera, canvas);
    controls.target = [0, 0, 0];

    window.addEventListener('resize', () => {
        view.setSize(window.innerWidth, window.innerHeight);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    });

    // Create cube texture with labeled faces
    const faceImages = await createCubeFaces(512);
    const cubeTex = new CubeTexture(faceImages);
    cubeTex.generateMipmaps = false;
    cubeTex.needsUpdate = true;

    // Skybox material: sample the cube texture using the vertex position as direction.
    // We render the inside of a box (cullMode: 'front') centered at the origin.
    const position = attribute('position', d.vec3f);

    // Transform to clip space
    const localPos = vec4(position, f32(1));
    const worldPos = mul(modelWorldMatrix, localPos);
    const viewPos = mul(cameraViewMatrix, worldPos);
    const clipPos = mul(cameraProjectionMatrix, viewPos);

    // Pass the local position to the fragment shader as the cube sample direction
    const vDirection = varying(position, 'v_direction');

    // Sample the cube texture with the interpolated direction
    const envNode = cubeTexture(cubeTex);
    const envColor = envNode.sample(vDirection);

    const material = createMaterial({
        vertex: clipPos,
        fragment: vec4(envColor.xyz, f32(1)),
        cullMode: 'front', // Render back faces (we're inside the box)
        depthWrite: false,
    });

    const geometry = createBoxGeometry(10, 10, 10);
    const mesh = new Mesh(geometry, material);
    scene.add(mesh);

    scene.updateWorldMatrix();

    await compile(renderer, [mesh], view, camera);

    const scenePass = renderTexture(scene, camera);
    const outputNode = renderOutput(scenePass.getTextureNode());
    const composite = fullscreen(outputNode);
    // UI overlay
    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position: fixed;
        top: 10px;
        left: 10px;
        background: rgba(0,0,0,0.7);
        color: white;
        padding: 15px;
        font-family: monospace;
        font-size: 14px;
        border-radius: 5px;
        z-index: 1000;
    `;
    overlay.innerHTML = `
        <div style="margin-bottom: 10px; font-weight: bold;">Cube Texture Skybox</div>
        <div style="font-size: 12px; color: #aaa;">
            Each face has a distinct color and label.<br>
            Drag to look around.
        </div>
    `;
    document.body.appendChild(overlay);

    function update() {
        controls.update();
        camera.updateViewMatrix();

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
