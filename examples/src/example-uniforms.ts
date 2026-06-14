/**
 * example-uniforms.ts
 * 
 * Demonstrates two ways to use uniforms:
 * 
 * 1. Inline form: uniform(f32(value), 'name')
 *    - Creates a Uniform internally with an initial value
 *    - Good for shared shader graphs where all instances use the same value
 *    - Update via uniformNode.value = newValue
 * 
 * 2. Name-based form: uniform('name', schema) + material.uniforms
 *    - Declares a uniform slot in the shader, resolved from material at render time
 *    - Good for reusable materials where each instance has different values
 *    - Update via material.uniforms.set('name', new Uniform(schema, value))
 */

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
    OrbitControls,
    pass,
    PerspectiveCamera,
    RenderPipeline,
    Scene,
    Uniform,
    uniform,
    varying,
    vec3,
    vec4,
    WebGPURenderer,
    renderOutput,
} from 'gpucat';
import { quat } from 'mathcat';

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
    camera.position[2] = 8;
    scene.add(camera);

    const controls = new OrbitControls(camera, renderer.domElement);

    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth, window.innerHeight);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    });

    const geometry = createBoxGeometry(1, 1, 1);
    
    const lightDir = vec3(0.6, 1.0, 0.8).normalize();

    // -------------------------------------------------------------------------
    // Approach 1: Inline uniform - value baked into the shader graph
    // -------------------------------------------------------------------------
    // All meshes using this material share the same color uniform.
    // Updating uColorInline.value affects ALL meshes.
    
    const uColorInline = uniform(vec3(1.0, 0.4, 0.1), 'inlineColor');
    
    const position1 = attribute('position', d.vec3f);
    const normal1 = attribute('normal', d.vec3f);
    const worldPosition1 = mul(modelWorldMatrix, vec4(position1, f32(1)));
    const clipPosition1 = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPosition1));
    const vNormal1 = varying(normalize(mul(modelNormalMatrix, normal1)), 'vNormal');
    
    const diffuse1 = vNormal1.dot(lightDir).max(f32(0.15));
    const litColor1 = uColorInline.mul(diffuse1);
    
    const materialInline = new Material({
        vertex: clipPosition1,
        fragment: vec4(litColor1, f32(1)),
    });

    // -------------------------------------------------------------------------
    // Approach 2: Name-based uniform - resolved from material.uniforms
    // -------------------------------------------------------------------------
    // Each material instance can have its own color value.
    // The shader declares a slot, material.uniforms provides the value.
    
    const uColorNamed = uniform('namedColor', d.vec3f);
    
    const position2 = attribute('position', d.vec3f);
    const normal2 = attribute('normal', d.vec3f);
    const worldPosition2 = mul(modelWorldMatrix, vec4(position2, f32(1)));
    const clipPosition2 = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPosition2));
    const vNormal2 = varying(normalize(mul(modelNormalMatrix, normal2)), 'vNormal');
    
    const diffuse2 = vNormal2.dot(lightDir).max(f32(0.15));
    const litColor2 = uColorNamed.mul(diffuse2);


    // -------------------------------------------------------------------------
    // Create meshes
    // -------------------------------------------------------------------------
    
    // Left side: 3 boxes using inline uniform (all same color)
    const inlineMeshes: Mesh[] = [];
    for (let i = 0; i < 3; i++) {
        const mesh = new Mesh(geometry, materialInline);
        mesh.position[0] = -2.5;
        mesh.position[1] = (i - 1) * 1.5;
        scene.add(mesh);
        inlineMeshes.push(mesh);
    }

    // Right side: 3 boxes using name-based uniforms (each different color)
    const namedMeshes: Mesh[] = [];
    const colors = [
        [0.2, 0.6, 1.0],  // blue
        [0.2, 1.0, 0.4],  // green
        [1.0, 0.2, 0.6],  // pink
    ];
    
    for (let i = 0; i < 3; i++) {
        // Each mesh gets its own Material instance with its own uniforms map
        const material = new Material({
            vertex: clipPosition2,
            fragment: vec4(litColor2, f32(1)),
        });
        // Set the color for this specific material instance
        material.uniforms.set('namedColor', new Uniform(d.vec3f, colors[i]));
        
        const mesh = new Mesh(geometry, material);
        mesh.position[0] = 2.5;
        mesh.position[1] = (i - 1) * 1.5;
        scene.add(mesh);
        namedMeshes.push(mesh);
    }

    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    // -------------------------------------------------------------------------
    // Inspector controls
    // -------------------------------------------------------------------------
    const inspector = renderer.inspector as Inspector;
    
    const inlineParams = inspector.createParameters('Inline Uniform (left)');
    inlineParams.add(uColorInline, 'value', { label: 'Color (affects all 3)' });
    
    const namedParams = inspector.createParameters('Named Uniforms (right)');
    // For name-based, we need to access the Uniform from each material
    for (let i = 0; i < namedMeshes.length; i++) {
        const mesh = namedMeshes[i];
        const colorUniform = mesh.material.uniforms.get('namedColor')!;
        namedParams.add(colorUniform, 'value', { label: `Box ${i + 1} Color` });
    }

    // -------------------------------------------------------------------------
    // Render loop
    // -------------------------------------------------------------------------
    const scenePass = pass(scene, camera);
    const outputNode = renderOutput(scenePass.getTextureNode());
    const renderPipeline = new RenderPipeline(renderer, outputNode);

    let angle = 0;
    let prevTime = performance.now() / 1000;

    function frame() {
        const now = performance.now() / 1000;
        const dt = now - prevTime;
        prevTime = now;

        angle += dt * 0.5;

        // Rotate all meshes
        for (const mesh of [...inlineMeshes, ...namedMeshes]) {
            quat.fromEuler(mesh.quaternion, [angle * 0.3, angle, 0, 'xyz']);
            mesh.updateWorldMatrix();
        }

        controls.update();
        renderPipeline.render();
        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

main().catch(console.error);
