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

async function createCheckerboardTexture(size = 256, squares = 8): Promise<ImageBitmap> {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d')!;
    
    const squareSize = size / squares;
    
    for (let y = 0; y < squares; y++) {
        for (let x = 0; x < squares; x++) {
            const isWhite = (x + y) % 2 === 0;
            ctx.fillStyle = isWhite ? '#ffffff' : '#444444';
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

    const camera = new PerspectiveCamera(
        Math.PI / 4,
        window.innerWidth / window.innerHeight,
        0.1,
        100,
    );
    camera.position[2] = 5;
    scene.add(camera);
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth, window.innerHeight);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    });

    // create checkerboard texture
    const checkerImage = await createCheckerboardTexture(256, 8);
    const checkerTexture = new Texture(checkerImage);
    checkerTexture.wrapS = 'repeat';
    checkerTexture.wrapT = 'repeat';
    checkerTexture.needsUpdate = true;

    // geometry attributes
    const position = attribute('position', d.vec3f).toVar('position');
    const normal = attribute('normal', d.vec3f).toVar('normal');
    const uvAttr = attribute('uv', d.vec2f).toVar('uv');

    // vertex shader: transform position to clip space
    const localPosition = vec4(position, f32(1)).toVar('localPos');
    const worldPosition = mul(modelWorldMatrix, localPosition).toVar('worldPos');
    const viewPosition = mul(cameraViewMatrix, worldPosition).toVar('viewPos');
    const clipPosition = mul(cameraProjectionMatrix, viewPosition).toVar('clipPos');

    // pass normal and UV to fragment shader via varyings
    const worldNormal = mul(modelNormalMatrix, vec3(normal.x, normal.y, normal.z)).toVar('worldNormal');

    const vNormal = varying(normalize(worldNormal), 'v_norm');
    const vUv = varying(uvAttr, 'v_uv');

    // fragment: sample texture and apply simple lighting
    const texNode = texture(checkerTexture);
    const texColor = texNode.sample(vUv as unknown as Node<d.vec2f>);
    const lightDirection = vec3(f32(0.6), f32(1.0), f32(0.8)).normalize();
    const diffuse = vNormal.dot(lightDirection).max(f32(0.2));
    const litColor = texColor.xyz.mul(diffuse);

    const material = new Material({
        vertex: clipPosition,
        fragment: vec4(litColor, f32(1)),
    });

    const geometry = createBoxGeometry(1, 1, 1);
    const mesh = new Mesh(geometry, material);
    scene.add(mesh);

    await renderer.compile(scene, camera);

    const scenePass = pass(scene, camera);
    const outputNode = scenePass.getTextureNode();

    let angle = 0;
    let prevTime = performance.now() / 1000;

    function frame() {
        const now = performance.now() / 1000;
        const dt = now - prevTime;
        prevTime = now;

        angle += dt * 0.5;

        quat.fromEuler(mesh.quaternion, [angle * 0.3, angle, 0, 'yxz'] as Euler);
        mesh.updateWorldMatrix();

        renderer.render(outputNode);
        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

main().catch(console.error);
