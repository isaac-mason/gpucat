import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createPlaneGeometry,
    d,
    f32,
    Inspector,
    Material,
    Mesh,
    modelWorldMatrix,
    mul,
    OrbitControls,
    pass,
    PerspectiveCamera,
    renderOutput,
    RenderPipeline,
    Scene,
    texture,
    Texture,
    varying,
    vec4,
    WebGPURenderer,
    type Node,
} from 'gpucat';


/**
 * Create a high-frequency checkerboard texture.
 * High frequency patterns make mipmap aliasing very visible.
 */
async function createCheckerboardTexture(size = 512, squares = 64): Promise<ImageBitmap> {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d')!;

    const squareSize = size / squares;

    for (let y = 0; y < squares; y++) {
        for (let x = 0; x < squares; x++) {
            const isWhite = (x + y) % 2 === 0;
            ctx.fillStyle = isWhite ? '#ffffff' : '#000000';
            ctx.fillRect(x * squareSize, y * squareSize, squareSize, squareSize);
        }
    }

    return createImageBitmap(canvas);
}

async function main() {
    const renderer = new WebGPURenderer({ antialias: true });
    renderer.inspector = new Inspector();
    await renderer.init();

    document.body.appendChild(renderer.domElement);
    document.body.appendChild((renderer.inspector as Inspector).domElement);
    renderer.setPixelRatio(devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);

    const scene = new Scene();

    // Camera positioned above and looking down at the floor
    const camera = new PerspectiveCamera(
        Math.PI / 3,
        window.innerWidth / window.innerHeight,
        0.1,
        1000,
    );
    camera.position[0] = 0;
    camera.position[1] = 8;
    camera.position[2] = 15;
    camera.lookAt([0, 0, 0]);
    scene.add(camera);
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target = [0, 0, 0];

    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth, window.innerHeight);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    });

    // Create textures
    const checkerImage = await createCheckerboardTexture(512, 64);

    // Texture WITH mipmaps
    const textureMipmapped = new Texture(checkerImage);
    textureMipmapped.wrapS = 'repeat';
    textureMipmapped.wrapT = 'repeat';
    textureMipmapped.generateMipmaps = true;
    textureMipmapped.minFilter = 'linear';
    textureMipmapped.magFilter = 'linear';
    textureMipmapped.mipmapFilter = 'linear';
    textureMipmapped.anisotropy = 16;
    textureMipmapped.needsUpdate = true;

    // Texture WITHOUT mipmaps
    const textureNoMipmaps = new Texture(checkerImage);
    textureNoMipmaps.wrapS = 'repeat';
    textureNoMipmaps.wrapT = 'repeat';
    textureNoMipmaps.generateMipmaps = false;
    textureNoMipmaps.minFilter = 'linear';
    textureNoMipmaps.magFilter = 'linear';
    textureNoMipmaps.needsUpdate = true;

    // Helper to create material for a texture
    function createMaterial(tex: Texture) {
        const position = attribute('position', d.vec3f);
        const uvAttr = attribute('uv', d.vec2f);

        const localPosition = vec4(position, f32(1));
        const worldPosition = mul(modelWorldMatrix, localPosition);
        const viewPosition = mul(cameraViewMatrix, worldPosition);
        const clipPosition = mul(cameraProjectionMatrix, viewPosition);

        // Scale UVs to tile the texture many times - makes aliasing visible
        const uvScale = f32(20);
        const scaledUv = uvAttr.mul(uvScale);
        const vUv = varying(scaledUv, `v_uv_${tex.id}`);

        const texNode = texture(tex);
        const texColor = texNode.sample(vUv as unknown as Node<d.vec2f>);

        return new Material({
            vertex: clipPosition,
            fragment: vec4(texColor.xyz, f32(1)),
        });
    }

    const materialMipmapped = createMaterial(textureMipmapped);
    const materialNoMipmaps = createMaterial(textureNoMipmaps);

    // Create two floor planes side by side
    // Plane is created in XZ plane with +Y normal, so we don't need to rotate it
    const planeGeometry = createPlaneGeometry(20, 40);

    // Left plane: WITH mipmaps
    const meshMipmapped = new Mesh(planeGeometry, materialMipmapped);
    meshMipmapped.position[0] = -11;
    meshMipmapped.position[1] = 0;
    meshMipmapped.position[2] = 0;
    scene.add(meshMipmapped);

    // Right plane: WITHOUT mipmaps  
    const meshNoMipmaps = new Mesh(planeGeometry, materialNoMipmaps);
    meshNoMipmaps.position[0] = 11;
    meshNoMipmaps.position[1] = 0;
    meshNoMipmaps.position[2] = 0;
    scene.add(meshNoMipmaps);

    scene.updateWorldMatrix();

    await renderer.compile(scene, camera);

    const scenePass = pass(scene, camera);
    const outputNode = renderOutput(scenePass.getTextureNode());
    const renderPipeline = new RenderPipeline(renderer, outputNode);

    // Add UI overlay
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
        <div style="margin-bottom: 10px; font-weight: bold;">Mipmap Comparison</div>
        <div style="display: flex; gap: 40px;">
            <div style="text-align: center;">
                <div style="color: #4f4;">LEFT: Mipmaps ON</div>
                <div style="font-size: 12px; color: #aaa;">+ Anisotropic 16x</div>
            </div>
            <div style="text-align: center;">
                <div style="color: #f44;">RIGHT: Mipmaps OFF</div>
                <div style="font-size: 12px; color: #aaa;">Notice the aliasing</div>
            </div>
        </div>
        <div style="margin-top: 15px; font-size: 12px; color: #888;">
            Use mouse to orbit - look at the distance!
        </div>
    `;
    document.body.appendChild(overlay);

    function frame() {
        controls.update();
        camera.updateViewMatrix();

        renderer.beginFrame();
        renderPipeline.render();
        renderer.endFrame();
        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

main().catch(console.error);
