/**
 * example-mrt.ts — Multiple Render Targets (MRT) demonstration.
 *
 * This example demonstrates MRT support in gpucat by rendering a sphere to
 * multiple render targets simultaneously:
 *   - output: final lit color (tone-mapped for display)
 *   - normal: view-space normals encoded as RGB
 *   - diffuse: base material color (pre-lighting)
 *   - emissive: emissive contribution
 *
 * The final composite shows all four outputs side-by-side using screenUV
 * thresholds, similar to Three.js's webgpu_mrt.html example.
 */

import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    color,
    createSphereGeometry,
    d,
    f32,
    Inspector,
    Material,
    Mesh,
    modelNormalMatrix,
    modelWorldMatrix,
    mrt,
    mul,
    normalize,
    pass,
    PerspectiveCamera,
    Scene,
    varying,
    vec3,
    vec4,
    WebGPURenderer,
    renderOutput,
    RawNode,
    wgslFn,
} from 'gpucat';
import { quat, type Euler } from 'mathcat';

// ---------------------------------------------------------------------------
// Helper: directionToColor using wgslFn
// ---------------------------------------------------------------------------

/**
 * Encodes a normalized direction vector [-1,1] to RGB color [0,1].
 * Demonstrates wgslFn() for raw WGSL function definitions.
 */
const directionToColor = wgslFn<'vec3f'>(/* wgsl */ `
fn directionToColor(dir: vec3f) -> vec3f {
    return dir * vec3f(0.5) + vec3f(0.5);
}
`);

/**
 * Composite shader: selects one of 5 textures based on UV.x position.
 * Shows all MRT outputs side-by-side in vertical strips.
 *
 * Strips from left to right:
 *   [0.0-0.2] beauty   - tonemapped final output
 *   [0.2-0.4] output   - raw linear output
 *   [0.4-0.6] normal   - view-space normals
 *   [0.6-0.8] emissive - emissive contribution
 *   [0.8-1.0] diffuse  - base material color
 */
const selectComposite = wgslFn<'vec4f'>(/* wgsl */ `
fn selectComposite(
    uv_x: f32,
    beauty: vec4f,
    output: vec4f,
    normal: vec4f,
    emissive: vec4f,
    diffuse: vec4f
) -> vec4f {
    if (uv_x >= 0.8) {
        return diffuse;
    } else if (uv_x >= 0.6) {
        return emissive;
    } else if (uv_x >= 0.4) {
        return normal;
    } else if (uv_x >= 0.2) {
        return output;
    }
    return beauty;
}
`);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

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
    camera.position[2] = 4;
    scene.add(camera);
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth * devicePixelRatio, window.innerHeight * devicePixelRatio);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    });

    // -----------------------------------------------------------------------
    // Build node graph for the sphere material
    // -----------------------------------------------------------------------

    const pos = attribute(d.vec3f, 'position');
    const norm = attribute(d.vec3f, 'normal');

    // Vertex shader: transform to clip space
    const localPos = vec4(pos, f32(1));
    const worldPos = mul(modelWorldMatrix, localPos);
    const viewPos = mul(cameraViewMatrix, worldPos);
    const clipPos = mul(cameraProjectionMatrix, viewPos);

    // World-space normal for lighting
    const worldNorm = mul(modelNormalMatrix, vec3(norm.x, norm.y, norm.z));
    const vWorldNorm = varying(d.vec3f, 'v_worldNorm', normalize(worldNorm));

    // View-space normal for MRT output (computed from world normal in fragment)
    // We need view-space normal: viewNorm = (viewMatrix * vec4(worldNorm, 0)).xyz
    const viewNormExpr = new RawNode<'vec3f'>(
        'vec3f',
        'normalize(($0 * vec4($1, 0.0)).xyz)',
        [cameraViewMatrix, vWorldNorm],
    );

    // Simple directional lighting
    const lightDir = vec3(f32(0.6), f32(1.0), f32(0.8)).normalize();
    const nDotL = vWorldNorm.dot(lightDir).max(f32(0.0));
    const ambient = f32(0.15);
    const diffuseFactor = nDotL.add(ambient);

    // Material colors
    const baseColor = color('#4488ff'); // blue diffuse
    const emissiveColor = color('#ff4400'); // orange-red emissive glow

    // Emissive based on view angle (rim effect)
    const viewDir = vec3(f32(0), f32(0), f32(1)); // simplified: assume looking down -Z
    const rimFactor = new RawNode<'f32'>(
        'f32',
        'pow(1.0 - max(dot($0, $1), 0.0), 3.0)',
        [vWorldNorm, viewDir],
    );
    const emissive = vec3(emissiveColor.x, emissiveColor.y, emissiveColor.z).mul(rimFactor);

    // Diffuse color (base color, no lighting)
    const diffuseRGB = vec3(baseColor.x, baseColor.y, baseColor.z);

    // Final lit color (diffuse * lighting + emissive)
    const litColor = diffuseRGB.mul(diffuseFactor).add(emissive);

    // -----------------------------------------------------------------------
    // MRT outputs
    // -----------------------------------------------------------------------

    // output: final lit color
    const outputColor = vec4(litColor, f32(1));

    // normal: view-space normal encoded as color
    const normalColor = vec4(directionToColor(viewNormExpr), f32(1));

    // diffuse: base material color
    const diffuseOutput = vec4(diffuseRGB, f32(1));

    // emissive: emissive contribution
    const emissiveOutput = vec4(emissive, f32(1));

    // Create MRT node
    const mrtOutput = mrt({
        output: outputColor,
        normal: normalColor,
        diffuse: diffuseOutput,
        emissive: emissiveOutput,
    });

    // Material with MRT fragment output
    const mat = new Material({
        vertex: clipPos,
        fragment: mrtOutput,
    });

    // Create sphere geometry
    const geometry = createSphereGeometry(1, 32, 24);

    // Create mesh
    const mesh = new Mesh(geometry, mat);
    scene.add(mesh);

    // -----------------------------------------------------------------------
    // Scene pass with MRT
    // -----------------------------------------------------------------------

    const scenePass = pass(scene, camera);
    scenePass.setMRT(mrtOutput);

    // -----------------------------------------------------------------------
    // Composite shader: show all MRT outputs side-by-side
    // -----------------------------------------------------------------------

    // Get texture nodes for each MRT output
    const outputTex = scenePass.getTextureNode('output');
    const normalTex = scenePass.getTextureNode('normal');
    const diffuseTex = scenePass.getTextureNode('diffuse');
    const emissiveTex = scenePass.getTextureNode('emissive');

    // Apply tone mapping to the output texture
    const tonemappedOutput = renderOutput(outputTex, { toneMapping: 'aces' });

    // Build a composite that shows 5 vertical strips:
    // [0.0-0.2] Tonemapped output (beauty)
    // [0.2-0.4] Raw linear output
    // [0.4-0.6] Normals
    // [0.6-0.8] Emissive
    // [0.8-1.0] Diffuse
    //
    // Use wgslFn selectComposite to pick the right output based on UV.x.
    // The fullscreen pass provides `in.uv` as a varying, so we read it via RawNode.
    const uvX = new RawNode<'f32'>('f32', 'in.uv.x', []);

    // Call the wgslFn composite function
    const compositeOutput = selectComposite(
        uvX,
        tonemappedOutput,
        outputTex,
        normalTex,
        emissiveTex,
        diffuseTex,
    );

    // Final output
    const finalOutput = compositeOutput;

    // -----------------------------------------------------------------------
    // Animation loop
    // -----------------------------------------------------------------------

    let angle = 0;
    let prevTime = performance.now() / 1000;

    function frame() {
        const now = performance.now() / 1000;
        const dt = now - prevTime;
        prevTime = now;

        angle += dt * 0.5;

        quat.fromEuler(mesh.quaternion, [angle * 0.3, angle, 0, 'yxz'] as Euler);
        mesh.updateWorldMatrix();

        renderer.render(finalOutput);
        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

main().catch(console.error);
