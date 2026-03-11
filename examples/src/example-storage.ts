/**
 * example-storage.ts
 *
 * Demonstrates two ways to use storage buffers:
 *
 * 1. Inline form: storage(buffer)
 *    - Pass a GpuBuffer directly to the storage() function
 *    - Good for shared shader graphs where all instances use the same buffer
 *    - Can swap buffers via storageNode.value = otherBuffer
 *
 * 2. Name-based form: storage('name', schema) + geometry.setBuffer()
 *    - Declares a storage buffer slot in the shader, resolved from geometry at render time
 *    - Good for reusable materials where each mesh has different buffer data
 *    - Set buffer via geometry.setBuffer('name', buffer)
 */

import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createBoxGeometry,
    d,
    f32,
    Geometry,
    GpuBuffer,
    index,
    Inspector,
    instanceIndex,
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
    storage,
    varying,
    vec3,
    vec4,
    WebGPURenderer,
    RenderPipeline,
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
    camera.position[2] = 12;
    scene.add(camera);

    const controls = new OrbitControls(camera, renderer.domElement);

    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth, window.innerHeight);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    });

    const lightDir = vec3(0.6, 1.0, 0.8).normalize();

    // -------------------------------------------------------------------------
    // Approach 1: Inline storage - buffer passed directly to storage()
    // -------------------------------------------------------------------------
    // All meshes using this material share the same color buffer.
    // The buffer is "baked into" the shader graph.

    const INSTANCE_COUNT_INLINE = 3;
    const inlineColorData = new Float32Array(INSTANCE_COUNT_INLINE * 4);
    // Orange gradient
    for (let i = 0; i < INSTANCE_COUNT_INLINE; i++) {
        const t = i / (INSTANCE_COUNT_INLINE - 1);
        inlineColorData[i * 4 + 0] = 1.0;
        inlineColorData[i * 4 + 1] = 0.3 + t * 0.4;
        inlineColorData[i * 4 + 2] = 0.1;
        inlineColorData[i * 4 + 3] = 1.0;
    }

    const inlineColorBuffer = new GpuBuffer(d.array(d.vec4f), {
        data: inlineColorData,
        usage: 'storage',
    });

    const inlineColors = storage(inlineColorBuffer);
    const inlineColor = index(inlineColors, instanceIndex);

    const position1 = attribute('position', d.vec3f);
    const normal1 = attribute('normal', d.vec3f);
    const worldPosition1 = mul(modelWorldMatrix, vec4(position1, f32(1)));
    const clipPosition1 = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPosition1));
    const vNormal1 = varying(normalize(mul(modelNormalMatrix, normal1)), 'vNormal');
    const vColor1 = varying(inlineColor, 'vColor');

    const diffuse1 = vNormal1.dot(lightDir).max(f32(0.15));
    const litColor1 = vColor1.rgb.mul(diffuse1);

    const materialInline = new Material({
        vertex: clipPosition1,
        fragment: vec4(litColor1, f32(1)),
    });

    // -------------------------------------------------------------------------
    // Approach 2: Name-based storage - resolved from geometry.buffers
    // -------------------------------------------------------------------------
    // Each mesh can have its own color buffer via geometry.setBuffer().
    // The shader references the buffer by name.

    const namedColors = storage('instanceColors', d.array(d.vec4f));
    const namedColor = index(namedColors, instanceIndex);

    const position2 = attribute('position', d.vec3f);
    const normal2 = attribute('normal', d.vec3f);
    const worldPosition2 = mul(modelWorldMatrix, vec4(position2, f32(1)));
    const clipPosition2 = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPosition2));
    const vNormal2 = varying(normalize(mul(modelNormalMatrix, normal2)), 'vNormal');
    const vColor2 = varying(namedColor, 'vColor');

    const diffuse2 = vNormal2.dot(lightDir).max(f32(0.15));
    const litColor2 = vColor2.rgb.mul(diffuse2);

    const materialNamed = new Material({
        vertex: clipPosition2,
        fragment: vec4(litColor2, f32(1)),
    });

    // -------------------------------------------------------------------------
    // Create meshes
    // -------------------------------------------------------------------------

    const baseGeometry = createBoxGeometry(1, 1, 1);

    // Left side: Single instanced mesh using inline storage (3 instances, orange gradient)
    const inlineMesh = new Mesh(baseGeometry, materialInline);
    inlineMesh.position[0] = -3;
    inlineMesh.count = INSTANCE_COUNT_INLINE;
    scene.add(inlineMesh);

    // Right side: 3 separate meshes, each with its own color buffer via name-based storage
    const INSTANCE_COUNT_NAMED = 3;
    const namedMeshes: Mesh[] = [];

    const colorSets = [
        [0.2, 0.6, 1.0],  // blue
        [0.2, 1.0, 0.4],  // green
        [1.0, 0.2, 0.6],  // pink
    ];

    for (let meshIdx = 0; meshIdx < 3; meshIdx++) {
        // Create color buffer for this mesh's instances
        const colorData = new Float32Array(INSTANCE_COUNT_NAMED * 4);
        const baseColor = colorSets[meshIdx];
        for (let i = 0; i < INSTANCE_COUNT_NAMED; i++) {
            const t = i / (INSTANCE_COUNT_NAMED - 1);
            // Vary brightness per instance
            const brightness = 0.6 + t * 0.4;
            colorData[i * 4 + 0] = baseColor[0] * brightness;
            colorData[i * 4 + 1] = baseColor[1] * brightness;
            colorData[i * 4 + 2] = baseColor[2] * brightness;
            colorData[i * 4 + 3] = 1.0;
        }

        const colorBuffer = new GpuBuffer(d.array(d.vec4f), {
            data: colorData,
            usage: 'storage',
        });

        // Create geometry with the named buffer
        const geometry = new Geometry();
        geometry.setBuffer('position', baseGeometry.getBuffer('position')!);
        geometry.setBuffer('normal', baseGeometry.getBuffer('normal')!);
        geometry.index = baseGeometry.index;
        geometry.setBuffer('instanceColors', colorBuffer);

        const mesh = new Mesh(geometry, materialNamed);
        mesh.position[0] = 3;
        mesh.position[1] = (meshIdx - 1) * 2.5;
        mesh.count = INSTANCE_COUNT_NAMED;
        scene.add(mesh);
        namedMeshes.push(mesh);
    }

    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    // -------------------------------------------------------------------------
    // Buffer swapping demo - cycles colors every 2 seconds
    // -------------------------------------------------------------------------
    
    // --- Inline storage: swap via storageNode.value ---
    const alternateInlineColorData = new Float32Array(INSTANCE_COUNT_INLINE * 4);
    // Cyan gradient (alternate for inline)
    for (let i = 0; i < INSTANCE_COUNT_INLINE; i++) {
        const t = i / (INSTANCE_COUNT_INLINE - 1);
        alternateInlineColorData[i * 4 + 0] = 0.1;
        alternateInlineColorData[i * 4 + 1] = 0.6 + t * 0.3;
        alternateInlineColorData[i * 4 + 2] = 1.0;
        alternateInlineColorData[i * 4 + 3] = 1.0;
    }
    const alternateInlineBuffer = new GpuBuffer(d.array(d.vec4f), {
        data: alternateInlineColorData,
        usage: 'storage',
    });
    const originalInlineBuffer = inlineColorBuffer;

    // --- Name-based storage: swap via geometry.setBuffer() ---
    const alternateColorSets = [
        [1.0, 0.8, 0.2],  // yellow
        [0.8, 0.2, 1.0],  // purple  
        [0.2, 1.0, 1.0],  // cyan
    ];

    const alternateNamedBuffers: GpuBuffer[] = [];
    for (let meshIdx = 0; meshIdx < 3; meshIdx++) {
        const colorData = new Float32Array(INSTANCE_COUNT_NAMED * 4);
        const baseColor = alternateColorSets[meshIdx];
        for (let i = 0; i < INSTANCE_COUNT_NAMED; i++) {
            const t = i / (INSTANCE_COUNT_NAMED - 1);
            const brightness = 0.6 + t * 0.4;
            colorData[i * 4 + 0] = baseColor[0] * brightness;
            colorData[i * 4 + 1] = baseColor[1] * brightness;
            colorData[i * 4 + 2] = baseColor[2] * brightness;
            colorData[i * 4 + 3] = 1.0;
        }
        alternateNamedBuffers.push(new GpuBuffer(d.array(d.vec4f), {
            data: colorData,
            usage: 'storage',
        }));
    }
    const originalNamedBuffers = namedMeshes.map(m => m.geometry.getBuffer('instanceColors')!);

    let useAlternate = false;

    // Swap buffers every 2 seconds
    setInterval(() => {
        useAlternate = !useAlternate;
        
        // Inline: swap via storageNode.value
        inlineColors.value = useAlternate ? alternateInlineBuffer : originalInlineBuffer;
        
        // Name-based: swap via geometry.setBuffer()
        const namedBuffers = useAlternate ? alternateNamedBuffers : originalNamedBuffers;
        for (let i = 0; i < namedMeshes.length; i++) {
            namedMeshes[i].geometry.setBuffer('instanceColors', namedBuffers[i]);
        }
        
        console.log(`Swapped to ${useAlternate ? 'alternate' : 'original'} colors (both inline and name-based)`);
    }, 2000);

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

        // Rotate meshes
        quat.fromEuler(inlineMesh.quaternion, [angle * 0.3, angle, 0, 'xyz']);
        inlineMesh.updateWorldMatrix();

        for (const mesh of namedMeshes) {
            quat.fromEuler(mesh.quaternion, [angle * 0.3, angle, 0, 'xyz']);
            mesh.updateWorldMatrix();
        }

        controls.update();
        renderer.beginFrame();
        renderPipeline.render();
        renderer.endFrame();
        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

main().catch(console.error);
