import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createBoxGeometry,
    createFullscreenTriangleGeometry,
    createIndirectBuffer,
    CubeRenderTarget,
    CubeTexture,
    cubeTexture,
    d,
    DataTexture,
    DrawIndirect,
    f32,
    Geometry,
    GpuBuffer,
    i32,
    Material,
    Mesh,
    modelNormalMatrix,
    modelWorldMatrix,
    mrt,
    mul,
    normalize,
    packArray,
    PerspectiveCamera,
    RenderTarget,
    Scene,
    screenUV,
    Texture,
    texture,
    transformFeedback,
    Uniform,
    uniform,
    varying,
    vec2i,
    vec3,
    vec4,
    vertexIndex,
    WebGLRenderer,
} from '../../src/index';
import { BlendMode } from '../../src/material/blend-mode';

/**
 * Browser-side harness for the WebGL2 draw path. Bundled to a single IIFE by esbuild and injected
 * into a real headless Chromium page (see run.mjs). It runs several render cases against a real
 * WebGL2 context (SwiftShader) and reads back a known pixel for each:
 *
 *  - clear        : empty scene → clearColor (the original clear-only proof, kept).
 *  - solid        : a fullscreen triangle with a constant fragment color.
 *  - uniform      : a fullscreen triangle whose fragment reads a vec4 uniform (tests the std140 UBO).
 *  - lit          : a camera-transformed box with a lambert term (tests mat4/mat3 std140 + attributes
 *                   + depth).
 *
 * Exposed as `window.__webglRender.run` so the Playwright runner can call each case via
 * page.evaluate — no HTTP server, no file:// ESM.
 */

export interface CaseResult {
    name: string;
    pixel: [number, number, number, number];
    expected: [number, number, number, number];
    error?: string;
    /** Free-form note a case may attach (e.g. the observed error message for a throw-assertion case). */
    note?: string;
}

export interface RunResult {
    contextError?: string;
    cases?: CaseResult[];
}

const SIZE = 64;
const CENTER = SIZE / 2;

/** Read the center pixel of the default framebuffer (readPixels origin is bottom-left). */
function readCenter(gl: WebGL2RenderingContext): [number, number, number, number] {
    const buf = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(CENTER, CENTER, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return [buf[0], buf[1], buf[2], buf[3]];
}

const u8 = (v: number): number => Math.round(v * 255);

async function newRenderer(): Promise<WebGLRenderer> {
    const canvas = document.createElement('canvas');
    const renderer = new WebGLRenderer({ canvas });
    await renderer.init();
    renderer.setSize(SIZE, SIZE);
    return renderer;
}

/** clear: empty scene renders to clearColor. */
async function caseClear(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0.2, 0.4, 0.6, 1];
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    renderer.render(scene, camera);
    const pixel = readCenter(renderer.gl!);
    renderer.dispose();
    return { name: 'clear', pixel, expected: [u8(0.2), u8(0.4), u8(0.6), 255] };
}

/** solid: fullscreen triangle with a constant fragment color. */
async function caseSolid(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];

    const geometry = createFullscreenTriangleGeometry();
    const position = attribute('position', d.vec3f);
    const material = new Material({
        vertex: vec4(position, f32(1)),
        fragment: vec4(0.9, 0.3, 0.6, 1),
        depthTest: false,
    });
    const mesh = new Mesh(geometry, material);

    const scene = new Scene();
    scene.add(mesh);
    const camera = new PerspectiveCamera();
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    renderer.render(scene, camera);
    const pixel = readCenter(renderer.gl!);
    renderer.dispose();
    return { name: 'solid', pixel, expected: [u8(0.9), u8(0.3), u8(0.6), 255] };
}

/** uniform: fullscreen triangle whose fragment reads a vec4 uniform → tests std140 UBO. */
async function caseUniform(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];

    const geometry = createFullscreenTriangleGeometry();
    const position = attribute('position', d.vec3f);
    const uColor = uniform('color', d.vec4f);
    const material = new Material({
        vertex: vec4(position, f32(1)),
        fragment: uColor,
        depthTest: false,
    });
    material.uniforms.set('color', new Uniform(d.vec4f, [0.1, 0.7, 0.5, 1]));

    const mesh = new Mesh(geometry, material);
    const scene = new Scene();
    scene.add(mesh);
    const camera = new PerspectiveCamera();
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    renderer.render(scene, camera);
    const pixel = readCenter(renderer.gl!);
    renderer.dispose();
    return { name: 'uniform', pixel, expected: [u8(0.1), u8(0.7), u8(0.5), 255] };
}

/**
 * lit: a camera-transformed box with a lambert term → tests mat4/mat3 in std140 + attributes + depth.
 *
 * The box faces the camera along -Z; its front face normal is (0,0,1). The light direction is
 * normalize(0,0,1), so the front face is fully lit: lighting = ambient + max(dot(n, l), 0) = 0.15 + 1.
 * With baseColor (0.4, 0.4, 0.4) the lit color clamps to ~ (0.4*1.15) per channel ≈ 0.46 → 117.
 */
async function caseLit(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];

    const geometry = createBoxGeometry(1, 1, 1);

    const position = attribute('position', d.vec3f);
    const normal = attribute('normal', d.vec3f);
    const worldPosition = mul(modelWorldMatrix, vec4(position, f32(1)));
    const clipPosition = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPosition));
    const vNormal = varying(normalize(mul(modelNormalMatrix, normal)), 'vNormal');

    const lightDir = vec3(0, 0, 1).normalize();
    const ambient = f32(0.15);
    const diffuse = vNormal.dot(lightDir).max(f32(0));
    const lighting = ambient.add(diffuse);
    const baseColor = vec3(0.4, 0.4, 0.4);
    const litColor = baseColor.mul(lighting);

    const material = new Material({
        vertex: clipPosition,
        fragment: vec4(litColor, f32(1)),
    });
    const mesh = new Mesh(geometry, material);

    const scene = new Scene();
    scene.add(mesh);

    const camera = new PerspectiveCamera(Math.PI / 4, 1, 0.1, 100);
    camera.position[2] = 3;
    scene.add(camera);

    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    renderer.render(scene, camera);
    const pixel = readCenter(renderer.gl!);
    renderer.dispose();

    // Front face fully lit: 0.4 * (0.15 + 1.0) = 0.46 → 117 per channel.
    const shaded = u8(0.4 * 1.15);
    return { name: 'lit', pixel, expected: [shaded, shaded, shaded, 255] };
}

/**
 * textured: sample a known-color DataTexture on a fullscreen quad → tests texture upload + the
 * combined-sampler unit binding. The texture is a solid magenta (2×2) so any texel we hit is the
 * same known value; the center pixel must match the texel.
 */
async function caseTextured(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];

    // A 2×2 solid magenta texture (0.6, 0.2, 0.8, 1) in rgba8unorm.
    const R = u8(0.6);
    const G = u8(0.2);
    const B = u8(0.8);
    const data = new Uint8Array(2 * 2 * 4);
    for (let i = 0; i < 4; i++) {
        data[i * 4 + 0] = R;
        data[i * 4 + 1] = G;
        data[i * 4 + 2] = B;
        data[i * 4 + 3] = 255;
    }
    const tex = new DataTexture(data, 2, 2, { format: 'rgba8unorm', magFilter: 'nearest', minFilter: 'nearest' });

    const geometry = createFullscreenTriangleGeometry();
    const position = attribute('position', d.vec3f);
    const material = new Material({
        vertex: vec4(position, f32(1)),
        fragment: texture(tex).sample(screenUV),
        depthTest: false,
    });
    const mesh = new Mesh(geometry, material);

    const scene = new Scene();
    scene.add(mesh);
    const camera = new PerspectiveCamera();
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    renderer.render(scene, camera);
    const pixel = readCenter(renderer.gl!);
    renderer.dispose();
    return { name: 'textured', pixel, expected: [R, G, B, 255] };
}

/**
 * render-to-texture: render a solid known color INTO a RenderTarget (the render-to-texture flow —
 * `renderer.renderTarget = rt; render(); restore`), then sample that target's color texture
 * fullscreen to the canvas and read back. Proves the FBO path + texture-as-input round-trip.
 */
async function caseRenderToTexture(): Promise<CaseResult> {
    const renderer = await newRenderer();

    // rgba8unorm target so the round-tripped color reads back exactly (no float precision loss).
    // depthBuffer:true exercises the FBO depth attachment + DepthTexture construction under WebGL2
    // (DepthTexture now uses spec-fixed numeric usage flags, not the WebGPU-only `GPUTextureUsage`).
    const rt = new RenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm', depthBuffer: true });

    // Pass 1: clear the target to a known color (an empty scene → the target's clearColor).
    const rtColor: [number, number, number, number] = [0.3, 0.8, 0.5, 1];
    const scene1 = new Scene();
    const camera1 = new PerspectiveCamera();
    scene1.updateWorldMatrix();
    camera1.updateViewMatrix();

    const savedTarget = renderer.renderTarget;
    const savedClear = renderer.clearColor;
    renderer.renderTarget = rt;
    renderer.clearColor = rtColor;
    renderer.render(scene1, camera1);
    renderer.renderTarget = savedTarget;
    renderer.clearColor = savedClear;

    // Pass 2: sample the target's color texture fullscreen onto the default framebuffer.
    renderer.clearColor = [0, 0, 0, 1];
    const geometry = createFullscreenTriangleGeometry();
    const position = attribute('position', d.vec3f);
    const material = new Material({
        vertex: vec4(position, f32(1)),
        fragment: texture(rt.texture! as Texture).sample(screenUV),
        depthTest: false,
    });
    const mesh = new Mesh(geometry, material);
    const scene2 = new Scene();
    scene2.add(mesh);
    const camera2 = new PerspectiveCamera();
    scene2.updateWorldMatrix();
    camera2.updateViewMatrix();

    renderer.render(scene2, camera2);
    const pixel = readCenter(renderer.gl!);
    renderer.dispose();
    return { name: 'rtt', pixel, expected: [u8(rtColor[0]), u8(rtColor[1]), u8(rtColor[2]), 255] };
}

/**
 * msaa: render a solid known color into a samples>1 RenderTarget (the multisample render FBO), which
 * is resolved (blitFramebuffer) into the target's sampleable texture on pass end; then sample that
 * texture fullscreen to the canvas and read back. Proves the MSAA render → resolve → sample path.
 *
 * The whole target is a single flat color, so antialiasing changes nothing at the center — the read
 * value equals the drawn color, which is what confirms the resolve landed the pixels in the texture.
 */
async function caseMsaa(): Promise<CaseResult> {
    const renderer = await newRenderer();

    // rgba8unorm + samples:4 so the resolved color reads back exactly. SwiftShader supports 4x MSAA
    // renderbuffers; if a sample count degrades, the fallback still produces the same flat color.
    const rt = new RenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm', depthBuffer: true, samples: 4 });

    // Pass 1: draw a solid fullscreen color into the MSAA target.
    const drawn: [number, number, number, number] = [0.2, 0.6, 0.9, 1];
    const geometry1 = createFullscreenTriangleGeometry();
    const material1 = new Material({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: vec4(drawn[0], drawn[1], drawn[2], 1),
        depthTest: false,
    });
    const scene1 = new Scene();
    scene1.add(new Mesh(geometry1, material1));
    const camera1 = new PerspectiveCamera();
    scene1.updateWorldMatrix();
    camera1.updateViewMatrix();

    const savedTarget = renderer.renderTarget;
    const savedClear = renderer.clearColor;
    renderer.renderTarget = rt;
    renderer.clearColor = [0, 0, 0, 1];
    renderer.render(scene1, camera1);
    renderer.renderTarget = savedTarget;
    renderer.clearColor = savedClear;

    // Pass 2: sample the resolved texture fullscreen onto the default framebuffer.
    renderer.clearColor = [0, 0, 0, 1];
    const material2 = new Material({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: texture(rt.texture! as Texture).sample(screenUV),
        depthTest: false,
    });
    const scene2 = new Scene();
    scene2.add(new Mesh(createFullscreenTriangleGeometry(), material2));
    const camera2 = new PerspectiveCamera();
    scene2.updateWorldMatrix();
    camera2.updateViewMatrix();

    renderer.render(scene2, camera2);
    const pixel = readCenter(renderer.gl!);
    renderer.dispose();
    return { name: 'msaa', pixel, expected: [u8(drawn[0]), u8(drawn[1]), u8(drawn[2]), 255] };
}

/**
 * cube-rtt: render a solid known color into every face of a CubeRenderTarget (set activeFace 0..5 and
 * render each), then sample the cube fullscreen and read back. Proves the cube-face FBO attachment
 * path (framebufferTexture2D(TEXTURE_CUBE_MAP_POSITIVE_X + activeFace)) + cube sampling round-trip.
 *
 * All six faces get the same color, so the sample direction is immaterial — the read value equals the
 * drawn color, confirming a face render actually wrote into the cube texture.
 */
async function caseCubeRtt(): Promise<CaseResult> {
    const renderer = await newRenderer();

    const rt = new CubeRenderTarget(SIZE, { colorFormat: 'rgba8unorm', depthBuffer: true });

    const drawn: [number, number, number, number] = [0.7, 0.3, 0.5, 1];
    const savedTarget = renderer.renderTarget;
    const savedClear = renderer.clearColor;
    renderer.renderTarget = rt;
    renderer.clearColor = [drawn[0], drawn[1], drawn[2], 1];

    // Render each of the six faces (an empty scene → the face clears to the target's clearColor).
    for (let face = 0; face < 6; face++) {
        rt.activeFace = face;
        const scene = new Scene();
        const camera = new PerspectiveCamera();
        scene.updateWorldMatrix();
        camera.updateViewMatrix();
        renderer.render(scene, camera);
    }
    renderer.renderTarget = savedTarget;
    renderer.clearColor = savedClear;

    // Sample the cube fullscreen onto the default framebuffer. Direction is a constant per-fragment
    // vector; since every face carries the same color, any direction reads the drawn color.
    renderer.clearColor = [0, 0, 0, 1];
    const material = new Material({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: cubeTexture(rt.texture).sample(vec3(0, 0, 1)),
        depthTest: false,
    });
    const scene2 = new Scene();
    scene2.add(new Mesh(createFullscreenTriangleGeometry(), material));
    const camera2 = new PerspectiveCamera();
    scene2.updateWorldMatrix();
    camera2.updateViewMatrix();

    renderer.render(scene2, camera2);
    const pixel = readCenter(renderer.gl!);
    renderer.dispose();
    return { name: 'cube-rtt', pixel, expected: [u8(drawn[0]), u8(drawn[1]), u8(drawn[2]), 255] };
}

/**
 * indirect-unsupported: indirect draw (`geometry.indirect`) is a WebGPU-only feature; on the WebGL2
 * backend even a plain CPU-authored indirect command must be rejected with a clear error. We set a
 * normal DrawIndirect command on the geometry and assert `renderer.render(...)` throws with a message
 * naming the WebGL2 limitation (pixel/expected are unused for pass/fail; the runner surfaces the note).
 */
async function caseIndirectUnsupported(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];

    const geometry = createFullscreenTriangleGeometry();
    const material = new Material({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: vec4(1, 1, 1, 1),
        depthTest: false,
    });
    // A normal CPU-authored indirect command (array kept): draw all 3 vertices, 1 instance, no base.
    const data = new Uint32Array(
        packArray(DrawIndirect, [{ vertexCount: 3, instanceCount: 1, firstVertex: 0, firstInstance: 0 }]),
    );
    geometry.indirect = createIndirectBuffer(DrawIndirect, data);

    const mesh = new Mesh(geometry, material);
    const scene = new Scene();
    scene.add(mesh);
    const camera = new PerspectiveCamera();
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    let threw = false;
    let msg = '';
    try {
        renderer.render(scene, camera);
    } catch (err) {
        threw = true;
        msg = err instanceof Error ? err.message : String(err);
    }
    renderer.dispose();
    // Encode pass/fail as a pixel: green when it threw the expected error, red otherwise.
    const ok = threw && msg.includes('not supported on the WebGL2 backend');
    return {
        name: 'ind-unsupported',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: threw ? msg.slice(0, 60) : 'did not throw',
    };
}

/**
 * depth-bias: two coplanar fullscreen quads at the same clip-space Z. The first (red) is drawn
 * normally; the second (green) has a positive polygon offset (depthBias) pushing it *toward* the
 * camera so it wins the depth test (depthCompare 'less-equal') and the center pixel reads green.
 *
 * Without polygon offset the two quads Z-fight and the second would NOT reliably beat the first with a
 * strict 'less' compare; the bias is what makes green consistently win. This asserts gl.polygonOffset
 * is actually applied on the WebGL path (C1).
 */
async function caseDepthBias(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];

    const position = attribute('position', d.vec3f);

    // First quad: red, plain depth write, no bias. Occupies z = 0.
    const redMat = new Material({
        vertex: vec4(position, f32(1)),
        fragment: vec4(1, 0, 0, 1),
        depthWrite: true,
        depthCompare: 'less-equal',
    });
    // Second quad: green, coplanar (same z), negative depthBias pulls it toward the camera so it passes
    // the 'less-equal' test against the red quad's stored depth and overwrites it.
    const greenMat = new Material({
        vertex: vec4(position, f32(1)),
        fragment: vec4(0, 1, 0, 1),
        depthWrite: true,
        depthCompare: 'less-equal',
        depthBias: -2,
        depthBiasSlopeScale: 0,
    });

    const scene = new Scene();
    scene.add(new Mesh(createFullscreenTriangleGeometry(), redMat));
    scene.add(new Mesh(createFullscreenTriangleGeometry(), greenMat));
    const camera = new PerspectiveCamera();
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    renderer.render(scene, camera);
    const pixel = readCenter(renderer.gl!);
    renderer.dispose();
    // Green wins because its polygon offset pulled it in front of the coplanar red quad.
    return { name: 'depth-bias', pixel, expected: [0, 255, 0, 255] };
}

/**
 * alpha-to-coverage: draw a fullscreen triangle with alpha = 0.5 into a 4x MSAA target, with
 * alphaToCoverage enabled and blending OFF. A2C converts fragment alpha into a coverage mask, so ~half
 * the samples of each pixel are written with the (opaque) color and half keep the clear color; the
 * MSAA resolve averages them, yielding roughly the halfway color. We assert the resolved center pixel
 * is a blend of clear (black) and the drawn color — i.e. A2C actually took effect (C2).
 *
 * Read against clear black [0,0,0]; with color (1,1,1) at alpha 0.5, the resolve lands near 128 per
 * channel. We assert it's meaningfully between black and white (a wide band; SwiftShader's sample
 * pattern isn't exactly 50%), which is only possible if A2C is enabled — with A2C off and blending off
 * the pixel would be fully white (255).
 */
async function caseAlphaToCoverage(): Promise<CaseResult> {
    const renderer = await newRenderer();

    const rt = new RenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm', depthBuffer: true, samples: 4 });

    const material1 = new Material({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: vec4(1, 1, 1, 0.5),
        depthTest: false,
        alphaToCoverage: true,
    });
    const scene1 = new Scene();
    scene1.add(new Mesh(createFullscreenTriangleGeometry(), material1));
    const camera1 = new PerspectiveCamera();
    scene1.updateWorldMatrix();
    camera1.updateViewMatrix();

    const savedTarget = renderer.renderTarget;
    const savedClear = renderer.clearColor;
    renderer.renderTarget = rt;
    renderer.clearColor = [0, 0, 0, 1];
    renderer.render(scene1, camera1);
    renderer.renderTarget = savedTarget;
    renderer.clearColor = savedClear;

    // Sample the resolved texture fullscreen to the default framebuffer.
    renderer.clearColor = [0, 0, 0, 1];
    const material2 = new Material({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: texture(rt.texture! as Texture).sample(screenUV),
        depthTest: false,
    });
    const scene2 = new Scene();
    scene2.add(new Mesh(createFullscreenTriangleGeometry(), material2));
    const camera2 = new PerspectiveCamera();
    scene2.updateWorldMatrix();
    camera2.updateViewMatrix();

    renderer.render(scene2, camera2);
    const pixel = readCenter(renderer.gl!);
    renderer.dispose();

    // With A2C on, the resolved value is a partial-coverage blend (roughly half). Encode pass/fail as a
    // green/red pixel: pass iff the red channel is meaningfully below fully-opaque white (i.e. coverage
    // actually dropped some samples). A generous band tolerates SwiftShader's sample geometry.
    const ok = pixel[0] > 20 && pixel[0] < 235;
    return {
        name: 'a2c',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `resolved center = [${pixel.join(', ')}]`,
    };
}

/**
 * mrt: render a fullscreen triangle into a 2-attachment RenderTarget via drawBuffers, writing a
 * distinct constant color to each attachment (attachment 0 = red-ish, attachment 1 = a known blue),
 * then sample attachment 1's texture fullscreen and read back. Proves the WebGL2 MRT path routes the
 * mrt() named output to the correct COLOR_ATTACHMENT (if drawBuffers were wrong, attachment 1 would
 * carry attachment 0's color or the clear color).
 */
async function caseMrt(): Promise<CaseResult> {
    const renderer = await newRenderer();

    // 2-attachment target; rename attachments to the mrt() keys. Attachment 0 is named `output` so
    // this also covers (a) the default MRT blend split (output→'material', aux→'no') NOT tripping the
    // per-attachment-blend guard, and (b) `output` being a GLSL reserved word (mangled to out_output).
    const rt = new RenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm', depthBuffer: true, count: 2 });
    rt.textures[0].name = 'output';
    rt.textures[1].name = 'colB';

    const colB: [number, number, number, number] = [0.2, 0.5, 0.9, 1];
    const mrtNode = mrt({
        output: vec4(0.9, 0.1, 0.1, 1),
        colB: vec4(colB[0], colB[1], colB[2], 1),
    });

    const material1 = new Material({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: mrtNode,
        depthTest: false,
    });
    const scene1 = new Scene();
    scene1.add(new Mesh(createFullscreenTriangleGeometry(), material1));
    const camera1 = new PerspectiveCamera();
    scene1.updateWorldMatrix();
    camera1.updateViewMatrix();

    const savedTarget = renderer.renderTarget;
    const savedClear = renderer.clearColor;
    renderer.renderTarget = rt;
    renderer.mrt = mrtNode;
    renderer.clearColor = [0, 0, 0, 1];
    renderer.render(scene1, camera1);
    renderer.mrt = null;
    renderer.renderTarget = savedTarget;
    renderer.clearColor = savedClear;

    // Sample attachment 1 (colB) fullscreen to the default framebuffer.
    renderer.clearColor = [0, 0, 0, 1];
    const material2 = new Material({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: texture(rt.textures[1] as Texture).sample(screenUV),
        depthTest: false,
    });
    const scene2 = new Scene();
    scene2.add(new Mesh(createFullscreenTriangleGeometry(), material2));
    const camera2 = new PerspectiveCamera();
    scene2.updateWorldMatrix();
    camera2.updateViewMatrix();

    renderer.render(scene2, camera2);
    const pixel = readCenter(renderer.gl!);
    renderer.dispose();
    return { name: 'mrt', pixel, expected: [u8(colB[0]), u8(colB[1]), u8(colB[2]), 255] };
}

/**
 * Shared MRT probe: render a fullscreen triangle into an N-attachment RenderTarget writing a distinct
 * constant color per attachment, then sample the LAST attachment's texture fullscreen and read back.
 *
 * `lazy` mirrors the PassNode flow that breaks the example: create the target with a single color
 * attachment (`count: 1`) at a small size, then lazily `push` the extra attachments (as the pass's
 * `getTexture()` does), then `setSize()` to the render size AFTER the extras are attached. This is the
 * exact ordering the pass produces: extra attachments minted at the initial size, then everyone
 * resized. `lazy:false` creates all N up front at the render size (the working `caseMrt` shape).
 */
async function mrtProbe(
    name: string,
    format: GPUTextureFormat,
    count: number,
    lazy: boolean,
    /**
     * When true, render once at 1x1 (allocating GL storage), THEN setSize to SIZE and render again —
     * the exact resize sequence the pass produces over frames. This exercises the re-allocation path
     * (a size change on an already-allocated render-target texture), which is where the example breaks.
     */
    resize = false,
): Promise<CaseResult> {
    const renderer = await newRenderer();

    // Distinct constant color per attachment; the last one is what we read back.
    const colors: Array<[number, number, number, number]> = [];
    for (let i = 0; i < count; i++) {
        colors.push([0.1 + i * 0.05, 0.3 + i * 0.1, 0.9 - i * 0.07, 1]);
    }
    const last = colors[count - 1];
    const names = Array.from({ length: count }, (_, i) => (i === 0 ? 'output' : `out${i}`));

    let rt: RenderTarget;
    // Initial size: `resize` starts at 1x1 (like the pass, whose _width/_height default to 1) so the
    // later setSize(SIZE) is a genuine re-allocation of already-allocated GL storage.
    const initial = resize ? 1 : SIZE;
    if (lazy) {
        // Mirror PassNode: single attachment created small, extras pushed, then resized.
        rt = new RenderTarget(initial, initial, { colorFormat: format, depthBuffer: true, count: 1 });
        rt.textures[0].name = names[0];
        for (let i = 1; i < count; i++) {
            const tex = new Texture({ width: rt.width, height: rt.height });
            tex.format = format;
            tex.isRenderTargetTexture = true;
            tex.generateMipmaps = false;
            tex.flipY = false;
            tex.name = names[i];
            tex._gpuTexture.isRenderTargetTexture = true;
            rt.textures.push(tex);
        }
        if (!resize) rt.setSize(SIZE, SIZE);
    } else {
        rt = new RenderTarget(initial, initial, { colorFormat: format, depthBuffer: true, count });
        rt.textures.forEach((t, i) => (t.name = names[i]));
    }

    const mrtFields: Record<string, ReturnType<typeof vec4>> = {};
    names.forEach((n, i) => {
        mrtFields[n] = vec4(colors[i][0], colors[i][1], colors[i][2], 1);
    });
    const mrtNode = mrt(mrtFields);

    const material1 = new Material({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: mrtNode,
        depthTest: false,
    });
    const scene1 = new Scene();
    scene1.add(new Mesh(createFullscreenTriangleGeometry(), material1));
    const camera1 = new PerspectiveCamera();
    scene1.updateWorldMatrix();
    camera1.updateViewMatrix();

    const savedTarget = renderer.renderTarget;
    renderer.renderTarget = rt;
    renderer.mrt = mrtNode;
    renderer.clearColor = [0, 0, 0, 1];
    if (resize) {
        // Render once at the initial 1x1 size (allocates GL storage for every attachment), then resize
        // to SIZE and render again — the exact frame-over-frame sequence PassNode.updateBefore produces.
        renderer.render(scene1, camera1);
        rt.setSize(SIZE, SIZE);
    }
    renderer.render(scene1, camera1);
    renderer.mrt = null;
    renderer.renderTarget = savedTarget;

    // Sample the last attachment's texture fullscreen to the default (rgba8) framebuffer.
    renderer.clearColor = [0, 0, 0, 1];
    const material2 = new Material({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: texture(rt.textures[count - 1] as Texture).sample(screenUV),
        depthTest: false,
    });
    const scene2 = new Scene();
    scene2.add(new Mesh(createFullscreenTriangleGeometry(), material2));
    const camera2 = new PerspectiveCamera();
    scene2.updateWorldMatrix();
    camera2.updateViewMatrix();

    renderer.render(scene2, camera2);
    const pixel = readCenter(renderer.gl!);
    renderer.dispose();
    return { name, pixel, expected: [u8(last[0]), u8(last[1]), u8(last[2]), 255] };
}

/** Probe (a): 4 rgba8unorm MRT attachments created up front — isolates attachment count from format/lazy. */
async function caseMrt4Rgba8(): Promise<CaseResult> {
    return mrtProbe('mrt4rgba8', 'rgba8unorm', 4, false);
}

/** Probe (b): 2 rgba16float MRT attachments created up front — isolates format from lazy-push. */
async function caseMrt2Rgba16f(): Promise<CaseResult> {
    return mrtProbe('mrt2rgba16f', 'rgba16float', 2, false);
}

/** Probe (c): 4 rgba16float MRT attachments created up front — format + count, no lazy push. */
async function caseMrt4Rgba16fUpfront(): Promise<CaseResult> {
    return mrtProbe('mrt4rgba16fupfront', 'rgba16float', 4, false);
}

/**
 * Regression: 4 rgba16float MRT attachments created LAZILY (push after construction), rendered once at
 * 1x1, then resized to SIZE and rendered again — the exact PassNode.setMRT + updateBefore(setSize) flow
 * the example uses. Fails before the fix (incomplete framebuffer / size mismatch from a re-allocation
 * that texStorage2D refuses on immutable storage), reads back the correct sampled pixel after.
 */
async function caseMrt4Rgba16fLazy(): Promise<CaseResult> {
    return mrtProbe('mrt4rgba16flazy', 'rgba16float', 4, true, true);
}

/**
 * Probe: a single-attachment rgba16float target, rendered once then resized and re-rendered. Isolates
 * "re-allocate on resize" from MRT/lazy — if THIS also fails, the bug is the immutable-storage resize
 * path, not anything MRT-specific.
 */
async function caseRtResizeRealloc(): Promise<CaseResult> {
    return mrtProbe('rt-resize-realloc', 'rgba16float', 1, false, true);
}

/**
 * cubemap: build a CubeTexture with a distinct constant color per face, then sample a fixed direction
 * (+Z → face index 4) on a fullscreen triangle and read back. Proves cube sampling picks the right
 * face on WebGL2. Face order: +X,-X,+Y,-Y,+Z,-Z.
 */
async function caseCubemap(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];

    // Six 1x1 solid-color faces. +Z (index 4) is the one we sample toward.
    const faceColors: [number, number, number][] = [
        [0.9, 0.1, 0.1], // +X red
        [0.1, 0.6, 0.6], // -X teal
        [0.1, 0.8, 0.2], // +Y green
        [0.6, 0.2, 0.7], // -Y purple
        [0.2, 0.5, 0.9], // +Z blue  ← sampled
        [0.9, 0.8, 0.1], // -Z yellow
    ];
    const faces = faceColors.map(([r, g, b]) => ({
        data: new Uint8Array([u8(r), u8(g), u8(b), 255]),
        width: 1,
        height: 1,
    }));
    const cubeTex = new CubeTexture(faces, {
        format: 'rgba8unorm',
        magFilter: 'nearest',
        minFilter: 'nearest',
        generateMipmaps: false,
    });
    cubeTex.needsUpdate = true;

    const material = new Material({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        // Sample toward +Z: picks the +Z face (index 4) = blue.
        fragment: cubeTexture(cubeTex).sample(vec3(0, 0, 1)),
        depthTest: false,
    });
    const scene = new Scene();
    scene.add(new Mesh(createFullscreenTriangleGeometry(), material));
    const camera = new PerspectiveCamera();
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    renderer.render(scene, camera);
    const pixel = readCenter(renderer.gl!);
    renderer.dispose();
    const [r, g, b] = faceColors[4];
    return { name: 'cubemap', pixel, expected: [u8(r), u8(g), u8(b), 255] };
}

/**
 * instanced: draw 2 instances of a fullscreen triangle where each instance's color comes from an
 * instanced vertex attribute; the second instance (drawn last, depth off) overwrites the first, so the
 * center pixel reads instance 1's color. Proves per-instance vertex attributes + instanced draw on
 * WebGL2 (instance divisor).
 */
async function caseInstanced(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];

    // Per-instance colors: instance 0 red, instance 1 the known green we assert.
    const inst1: [number, number, number] = [0.2, 0.8, 0.4];
    const instanceColors = new Float32Array([0.9, 0.1, 0.1, inst1[0], inst1[1], inst1[2]]);
    const instColor = attribute(instanceColors, d.vec3f, { stride: 12, offset: 0, instanced: true });
    const vColor = varying(instColor, 'v_instColor');

    const material = new Material({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: vec4(vColor, f32(1)),
        depthTest: false, // last instance wins at every pixel
    });
    const mesh = new Mesh(createFullscreenTriangleGeometry(), material);
    mesh.count = 2;

    const scene = new Scene();
    scene.add(mesh);
    const camera = new PerspectiveCamera();
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    renderer.render(scene, camera);
    const pixel = readCenter(renderer.gl!);
    renderer.dispose();
    return { name: 'instanced', pixel, expected: [u8(inst1[0]), u8(inst1[1]), u8(inst1[2]), 255] };
}

/**
 * unknown-format-unsupported: a DataTexture whose format the WebGL2 backend can't map must be
 * rejected with a clear error (not silently coerced to rgba8). Sample it and assert render() throws
 * naming the unsupported format. Green pixel iff it threw the expected message.
 */
async function caseUnknownFormatUnsupported(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];

    const data = new Uint8Array(2 * 2 * 4);
    // A real GPUTextureFormat WebGL2 has no mapping for (compressed BC format).
    const tex = new DataTexture(data, 2, 2, { format: 'bc7-rgba-unorm' as never, magFilter: 'nearest', minFilter: 'nearest' });

    const geometry = createFullscreenTriangleGeometry();
    const material = new Material({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: texture(tex).sample(screenUV),
        depthTest: false,
    });
    const scene = new Scene();
    scene.add(new Mesh(geometry, material));
    const camera = new PerspectiveCamera();
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    let threw = false;
    let msg = '';
    try {
        renderer.render(scene, camera);
    } catch (err) {
        threw = true;
        msg = err instanceof Error ? err.message : String(err);
    }
    renderer.dispose();
    const ok = threw && msg.includes('not supported on the WebGL2 backend') && msg.includes('bc7-rgba-unorm');
    return {
        name: 'fmt-unsupported',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: threw ? msg.slice(0, 60) : 'did not throw',
    };
}

/**
 * mrt-blend-unsupported: an MRT that asks for *differing* per-attachment blend modes can't be honored
 * on WebGL2 (one global blend state). Assert render() throws the per-attachment-blend error. Green
 * pixel iff it threw the expected message. (A uniform blend across targets is exercised by caseMrt.)
 */
async function caseMrtBlendUnsupported(): Promise<CaseResult> {
    const renderer = await newRenderer();

    const rt = new RenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm', depthBuffer: true, count: 2 });
    rt.textures[0].name = 'colA';
    rt.textures[1].name = 'colB';

    const mrtNode = mrt({
        colA: vec4(0.9, 0.1, 0.1, 1),
        colB: vec4(0.2, 0.5, 0.9, 1),
    });
    // Distinct per-target blends: colA additive, colB left at default (no blend) → differing.
    mrtNode.setBlendMode('colA', new BlendMode('additive'));

    const material = new Material({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: mrtNode,
        depthTest: false,
    });
    const scene = new Scene();
    scene.add(new Mesh(createFullscreenTriangleGeometry(), material));
    const camera = new PerspectiveCamera();
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    const savedTarget = renderer.renderTarget;
    renderer.renderTarget = rt;
    renderer.mrt = mrtNode;
    renderer.clearColor = [0, 0, 0, 1];

    let threw = false;
    let msg = '';
    try {
        renderer.render(scene, camera);
    } catch (err) {
        threw = true;
        msg = err instanceof Error ? err.message : String(err);
    }
    renderer.mrt = null;
    renderer.renderTarget = savedTarget;
    renderer.dispose();
    const ok = threw && msg.includes('per-attachment blend modes are not supported on the WebGL2 backend');
    return {
        name: 'mrt-blend',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: threw ? msg.slice(0, 60) : 'did not throw',
    };
}

/**
 * cube-mips: render into every face of a CubeRenderTarget with generateMipmaps, then finalize the
 * capture (generates cube mipmaps) and sample the cube. All faces share one color, so the sampled
 * value equals the drawn color; this exercises the finalizeCubeCapture → generateMipmap(CUBE) path
 * (it must not throw and must leave a sampleable, correctly-colored cube).
 */
async function caseCubeMips(): Promise<CaseResult> {
    const renderer = await newRenderer();

    const rt = new CubeRenderTarget(SIZE, { colorFormat: 'rgba8unorm', depthBuffer: true, generateMipmaps: true });

    const drawn: [number, number, number, number] = [0.4, 0.7, 0.6, 1];
    const savedTarget = renderer.renderTarget;
    const savedClear = renderer.clearColor;
    renderer.renderTarget = rt;
    renderer.clearColor = [drawn[0], drawn[1], drawn[2], 1];
    for (let face = 0; face < 6; face++) {
        rt.activeFace = face;
        const scene = new Scene();
        const camera = new PerspectiveCamera();
        scene.updateWorldMatrix();
        camera.updateViewMatrix();
        renderer.render(scene, camera);
    }
    // Generate the cube mipmaps from the captured faces (the fix under test).
    renderer.finalizeCubeCapture?.(rt, 0);
    renderer.renderTarget = savedTarget;
    renderer.clearColor = savedClear;

    renderer.clearColor = [0, 0, 0, 1];
    const material = new Material({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: cubeTexture(rt.texture).sample(vec3(0, 0, 1)),
        depthTest: false,
    });
    const scene2 = new Scene();
    scene2.add(new Mesh(createFullscreenTriangleGeometry(), material));
    const camera2 = new PerspectiveCamera();
    scene2.updateWorldMatrix();
    camera2.updateViewMatrix();

    renderer.render(scene2, camera2);
    const pixel = readCenter(renderer.gl!);
    renderer.dispose();
    return { name: 'cube-mips', pixel, expected: [u8(drawn[0]), u8(drawn[1]), u8(drawn[2]), 255] };
}

// NOTE: a uint8 index-buffer render case is intentionally omitted. The WebGL backend now maps
// Uint8Array indices to UNSIGNED_BYTE correctly (geometries.ts glIndexType), but that path is not
// reachable through the public API: core `GpuBuffer` rejects any index buffer whose array isn't a
// Uint16Array/Uint32Array (gpu-buffer.ts validation). So a uint8 index buffer can't be constructed to
// drive this case end-to-end; the fix is covered defensively + by tsc/build.

/**
 * bgra8unorm-unsupported: bgra8unorm has no WebGL2 core internal format; uploading as RGBA8 would
 * silently swap the B/R channels (wrong colors). Assert the backend throws rather than corrupting the
 * result. Green pixel iff it threw the expected message.
 */
async function caseBgra8Unsupported(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];

    const data = new Uint8Array(2 * 2 * 4);
    const tex = new DataTexture(data, 2, 2, { format: 'bgra8unorm', magFilter: 'nearest', minFilter: 'nearest' });

    const geometry = createFullscreenTriangleGeometry();
    const material = new Material({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: texture(tex).sample(screenUV),
        depthTest: false,
    });
    const scene = new Scene();
    scene.add(new Mesh(geometry, material));
    const camera = new PerspectiveCamera();
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    let threw = false;
    let msg = '';
    try {
        renderer.render(scene, camera);
    } catch (err) {
        threw = true;
        msg = err instanceof Error ? err.message : String(err);
    }
    renderer.dispose();
    const ok = threw && msg.includes('bgra8unorm is not supported on the WebGL2 backend');
    return {
        name: 'bgra8-unsupported',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: threw ? msg.slice(0, 60) : 'did not throw',
    };
}

// -------------------------------------------------------------------------------------------------
// Transform feedback (Phase 2). These read the TF OUTPUT buffer back directly via raw
// gl.getBufferSubData (test-side; readBufferAsync is Phase 3) and assert exact values — the strongest
// proof the kernel actually ran. Pass/fail is encoded as a green/red pixel like the other cases.
// -------------------------------------------------------------------------------------------------

/** Read a GpuBuffer's TF output GL buffer back into a Float32Array (raw, test-side). */
function readTfFloat32(renderer: WebGLRenderer, buffer: GpuBuffer, length: number): Float32Array {
    const gl = renderer.gl!;
    const glBuf = renderer.getTransformFeedbackGlBuffer(buffer);
    if (!glBuf) throw new Error('no GL buffer for TF output (was transformFeedback() run?)');
    const out = new Float32Array(length);
    gl.bindBuffer(gl.ARRAY_BUFFER, glBuf);
    gl.getBufferSubData(gl.ARRAY_BUFFER, 0, out);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return out;
}

/** tf-add: pos' = pos + vel over N vec4 elements; read output back and assert exact per-component. */
async function caseTransformFeedback(): Promise<CaseResult> {
    const renderer = await newRenderer();
    const N = 4;

    // N vec4s: pos = (i, i+0.5, i+1, i+1.5); vel = (1, 2, 3, 4).
    const posData = new Float32Array(N * 4);
    const velData = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
        posData[i * 4 + 0] = i;
        posData[i * 4 + 1] = i + 0.5;
        posData[i * 4 + 2] = i + 1;
        posData[i * 4 + 3] = i + 1.5;
        velData[i * 4 + 0] = 1;
        velData[i * 4 + 1] = 2;
        velData[i * 4 + 2] = 3;
        velData[i * 4 + 3] = 4;
    }
    const bufA = new GpuBuffer(d.vec4f, { data: posData });
    const velBuf = new GpuBuffer(d.vec4f, { data: velData });
    const bufB = new GpuBuffer(d.vec4f, { count: N });

    const kernel = transformFeedback((io) => ({ pos: io.pos.add(io.vel) }), {
        inputs: { pos: d.vec4f, vel: d.vec4f },
        outputs: { pos: d.vec4f },
    });

    renderer.transformFeedback(kernel, { inputs: { pos: bufA, vel: velBuf }, outputs: { pos: bufB }, count: N });

    const got = readTfFloat32(renderer, bufB, N * 4);
    let ok = true;
    let note = '';
    for (let i = 0; i < N * 4; i++) {
        const expected = posData[i] + velData[i];
        if (Math.abs(got[i] - expected) > 1e-4) {
            ok = false;
            note = `idx ${i}: got ${got[i]}, want ${expected}`;
            break;
        }
    }
    if (ok) note = `[${Array.from(got.slice(0, 4)).join(', ')}] …`;
    renderer.dispose();
    return {
        name: 'tf-add',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note,
    };
}

/** tf-pingpong: run twice swapping in/out; assert value advanced by 2*vel. */
async function caseTransformFeedbackPingPong(): Promise<CaseResult> {
    const renderer = await newRenderer();
    const N = 4;
    const posData = new Float32Array(N * 4);
    const velData = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
        for (let c = 0; c < 4; c++) {
            posData[i * 4 + c] = i * 4 + c;
            velData[i * 4 + c] = c + 1; // (1,2,3,4)
        }
    }
    let front = new GpuBuffer(d.vec4f, { data: posData });
    let back = new GpuBuffer(d.vec4f, { count: N });
    const velBuf = new GpuBuffer(d.vec4f, { data: velData });

    const kernel = transformFeedback((io) => ({ pos: io.pos.add(io.vel) }), {
        inputs: { pos: d.vec4f, vel: d.vec4f },
        outputs: { pos: d.vec4f },
    });

    // Step 1: front → back.
    renderer.transformFeedback(kernel, { inputs: { pos: front, vel: velBuf }, outputs: { pos: back }, count: N });
    [front, back] = [back, front];
    // Step 2: front(=old back) → back(=old front). back must hold pos + 2*vel.
    renderer.transformFeedback(kernel, { inputs: { pos: front, vel: velBuf }, outputs: { pos: back }, count: N });

    // `back` now (after the second swap target) holds the twice-advanced values.
    const got = readTfFloat32(renderer, back, N * 4);
    let ok = true;
    let note = '';
    for (let i = 0; i < N * 4; i++) {
        const expected = posData[i] + 2 * velData[i];
        if (Math.abs(got[i] - expected) > 1e-4) {
            ok = false;
            note = `idx ${i}: got ${got[i]}, want ${expected}`;
            break;
        }
    }
    if (ok) note = `advanced by 2*vel: [${Array.from(got.slice(0, 4)).join(', ')}] …`;
    renderer.dispose();
    return {
        name: 'tf-pingpong',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note,
    };
}

/**
 * tf-readback: run a particles-style kernel (pos' = pos + vel), then read the output buffer back via
 * the PUBLIC async API `renderer.readBufferAsync(outBuf)` (the real Phase-3 copyBufferSubData + fence
 * path — NOT raw getBufferSubData). Asserts exact per-component values. Because the fence is polled
 * across event-loop ticks, this also regression-guards the yield: a synchronous busy-loop would time
 * out on SwiftShader and this case would throw/fail rather than pass.
 */
async function caseTransformFeedbackReadbackAsync(): Promise<CaseResult> {
    const renderer = await newRenderer();
    const N = 4;

    // N vec4s: pos = (i, i+0.5, i+1, i+1.5); vel = (1, 2, 3, 4).
    const posData = new Float32Array(N * 4);
    const velData = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
        posData[i * 4 + 0] = i;
        posData[i * 4 + 1] = i + 0.5;
        posData[i * 4 + 2] = i + 1;
        posData[i * 4 + 3] = i + 1.5;
        velData[i * 4 + 0] = 1;
        velData[i * 4 + 1] = 2;
        velData[i * 4 + 2] = 3;
        velData[i * 4 + 3] = 4;
    }
    const bufA = new GpuBuffer(d.vec4f, { data: posData });
    const velBuf = new GpuBuffer(d.vec4f, { data: velData });
    const bufB = new GpuBuffer(d.vec4f, { count: N });

    const kernel = transformFeedback((io) => ({ pos: io.pos.add(io.vel) }), {
        inputs: { pos: d.vec4f, vel: d.vec4f },
        outputs: { pos: d.vec4f },
    });

    renderer.transformFeedback(kernel, { inputs: { pos: bufA, vel: velBuf }, outputs: { pos: bufB }, count: N });

    // The real async fence path — this is what Phase 3 delivers.
    const got = await renderer.readBufferAsync(bufB);
    let ok = got instanceof Float32Array && got.length === N * 4;
    let note = '';
    if (!ok) {
        note = `bad result: len ${got.length}, ctor ${got.constructor.name}`;
    } else {
        for (let i = 0; i < N * 4; i++) {
            const expected = posData[i] + velData[i];
            if (Math.abs(got[i] - expected) > 1e-4) {
                ok = false;
                note = `idx ${i}: got ${got[i]}, want ${expected}`;
                break;
            }
        }
    }
    if (ok) note = `readBufferAsync → [${Array.from(got.slice(0, 4)).join(', ')}] …`;
    renderer.dispose();
    return {
        name: 'tf-readback',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note,
    };
}

/**
 * tf-uniform (Phase 4): a kernel `pos' = pos + vel * dt` where `dt = uniform('dt', d.f32)`. Sets
 * dt=0.5, runs, asserts pos' == pos + 0.5*vel exactly; then sets dt=2.0, runs again, and asserts
 * pos' == pos + 2.0*vel — proving the UBO is RE-PACKED per dispatch (a changed uniform takes effect).
 * This exercises the standalone std140 UBO path (updateAndBindStandaloneUniformGroup).
 */
async function caseTransformFeedbackUniform(): Promise<CaseResult> {
    const renderer = await newRenderer();
    const N = 4;

    const posData = new Float32Array(N * 4);
    const velData = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
        for (let c = 0; c < 4; c++) {
            posData[i * 4 + c] = i * 4 + c;
            velData[i * 4 + c] = c + 1; // (1,2,3,4)
        }
    }
    const posBuf = new GpuBuffer(d.vec4f, { data: posData });
    const velBuf = new GpuBuffer(d.vec4f, { data: velData });
    const outBuf = new GpuBuffer(d.vec4f, { count: N });

    const dt = uniform('dt', d.f32);
    const kernel = transformFeedback((io) => ({ pos: io.pos.add(io.vel.mul(dt)) }), {
        inputs: { pos: d.vec4f, vel: d.vec4f },
        outputs: { pos: d.vec4f },
    });

    // First dispatch with dt = 0.5.
    dt.value = 0.5;
    renderer.transformFeedback(kernel, { inputs: { pos: posBuf, vel: velBuf }, outputs: { pos: outBuf }, count: N });
    const got1 = readTfFloat32(renderer, outBuf, N * 4);

    let ok = true;
    let note = '';
    for (let i = 0; i < N * 4 && ok; i++) {
        const expected = posData[i] + 0.5 * velData[i];
        if (Math.abs(got1[i] - expected) > 1e-4) {
            ok = false;
            note = `dt=0.5 idx ${i}: got ${got1[i]}, want ${expected}`;
        }
    }

    // Second dispatch with dt = 2.0 — must take effect (per-dispatch re-pack).
    if (ok) {
        dt.value = 2.0;
        renderer.transformFeedback(kernel, {
            inputs: { pos: posBuf, vel: velBuf },
            outputs: { pos: outBuf },
            count: N,
        });
        const got2 = readTfFloat32(renderer, outBuf, N * 4);
        for (let i = 0; i < N * 4 && ok; i++) {
            const expected = posData[i] + 2.0 * velData[i];
            if (Math.abs(got2[i] - expected) > 1e-4) {
                ok = false;
                note = `dt=2.0 idx ${i}: got ${got2[i]}, want ${expected}`;
            }
        }
        if (ok) note = `dt 0.5→2.0 re-packed: [${Array.from(got2.slice(0, 4)).join(', ')}] …`;
    }

    renderer.dispose();
    return {
        name: 'tf-uniform',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note,
    };
}

/**
 * tf-neighbour (Phase 4, boids-lite): each element reads texel (i+1) from an explicit rgba32float
 * DataTexture via textureLoad (`texture(dataTex).load(vec2i(i+1, 0), 0)`) and returns
 * `pos + neighbour`. Proves explicit random reads work with no hidden mirror — the standalone
 * texture-binding path (bindStandaloneTextures). Asserts exact per-component values against the
 * texels the test uploaded.
 */
async function caseTransformFeedbackNeighbour(): Promise<CaseResult> {
    const renderer = await newRenderer();
    const N = 4;

    // pos = (i, i, i, i). A data texture of width N+1 whose texel j = (j*10, j*10+1, j*10+2, j*10+3).
    const posData = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
        for (let c = 0; c < 4; c++) posData[i * 4 + c] = i;
    }
    const posBuf = new GpuBuffer(d.vec4f, { data: posData });
    const outBuf = new GpuBuffer(d.vec4f, { count: N });

    const TW = N + 1;
    const texData = new Float32Array(TW * 4);
    for (let j = 0; j < TW; j++) {
        texData[j * 4 + 0] = j * 10;
        texData[j * 4 + 1] = j * 10 + 1;
        texData[j * 4 + 2] = j * 10 + 2;
        texData[j * 4 + 3] = j * 10 + 3;
    }
    // rgba32float + nearest so `.load` (texelFetch, no filtering) reads the exact bytes back.
    const dataTex = new DataTexture(texData, TW, 1, {
        format: 'rgba32float',
        magFilter: 'nearest',
        minFilter: 'nearest',
    });

    const kernel = transformFeedback(
        (io) => {
            const i = vertexIndex.toI32();
            const neighbour = texture(dataTex).load(vec2i(i.add(i32(1)), i32(0)), i32(0));
            return { pos: io.pos.add(neighbour) };
        },
        {
            inputs: { pos: d.vec4f },
            outputs: { pos: d.vec4f },
        },
    );

    renderer.transformFeedback(kernel, { inputs: { pos: posBuf }, outputs: { pos: outBuf }, count: N });
    const got = readTfFloat32(renderer, outBuf, N * 4);

    let ok = true;
    let note = '';
    for (let i = 0; i < N && ok; i++) {
        const j = i + 1; // element i reads texel i+1
        for (let c = 0; c < 4; c++) {
            const expected = posData[i * 4 + c] + (j * 10 + c);
            if (Math.abs(got[i * 4 + c] - expected) > 1e-4) {
                ok = false;
                note = `elem ${i} c${c}: got ${got[i * 4 + c]}, want ${expected}`;
                break;
            }
        }
    }
    if (ok) note = `neighbour gather: [${Array.from(got.slice(0, 4)).join(', ')}] …`;

    renderer.dispose();
    return {
        name: 'tf-neighbour',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note,
    };
}

/** tf-alias-guard: same buffer as input and output must throw. */
async function caseTransformFeedbackAliasGuard(): Promise<CaseResult> {
    const renderer = await newRenderer();
    const N = 4;
    const shared = new GpuBuffer(d.vec4f, { data: new Float32Array(N * 4) });
    const velBuf = new GpuBuffer(d.vec4f, { data: new Float32Array(N * 4) });

    const kernel = transformFeedback((io) => ({ pos: io.pos.add(io.vel) }), {
        inputs: { pos: d.vec4f, vel: d.vec4f },
        outputs: { pos: d.vec4f },
    });

    let threw = false;
    let msg = '';
    try {
        renderer.transformFeedback(kernel, {
            inputs: { pos: shared, vel: velBuf },
            outputs: { pos: shared },
            count: N,
        });
    } catch (err) {
        threw = true;
        msg = err instanceof Error ? err.message : String(err);
    }
    renderer.dispose();
    const ok = threw && msg.includes("output buffer can't also be an input");
    return {
        name: 'tf-alias',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: threw ? msg.slice(0, 60) : 'did not throw',
    };
}

export async function run(): Promise<RunResult> {
    try {
        const cases: CaseResult[] = [];
        const runners: Array<() => Promise<CaseResult>> = [
            caseClear,
            caseSolid,
            caseUniform,
            caseLit,
            caseTextured,
            caseRenderToTexture,
            caseMsaa,
            caseCubeRtt,
            caseIndirectUnsupported,
            caseDepthBias,
            caseAlphaToCoverage,
            caseMrt,
            caseMrt4Rgba8,
            caseMrt2Rgba16f,
            caseMrt4Rgba16fUpfront,
            caseMrt4Rgba16fLazy,
            caseRtResizeRealloc,
            caseCubemap,
            caseInstanced,
            caseUnknownFormatUnsupported,
            caseMrtBlendUnsupported,
            caseCubeMips,
            caseBgra8Unsupported,
            caseTransformFeedback,
            caseTransformFeedbackPingPong,
            caseTransformFeedbackReadbackAsync,
            caseTransformFeedbackUniform,
            caseTransformFeedbackNeighbour,
            caseTransformFeedbackAliasGuard,
            // NOTE: shadow-map (comparison sampler) is NOT asserted here — SwiftShader (the headless
            // WebGL2 backend this harness runs on) does not honor sampler2DShadow depth comparison
            // (a hand-rolled pure-GL shadow program returns "lit" for every ref against a
            // gpucat-rendered depth-texture target). See the WebGL shadow-map example; it exercises
            // the depth render-target + comparison-sampler path for real hardware.
        ];
        for (const runner of runners) {
            try {
                cases.push(await runner());
            } catch (err) {
                cases.push({
                    name: runner.name.replace(/^case/, '').toLowerCase(),
                    pixel: [0, 0, 0, 0],
                    expected: [0, 0, 0, 0],
                    error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err),
                });
            }
        }
        return { cases };
    } catch (err) {
        return { contextError: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) };
    }
}

(globalThis as unknown as { __webglRender: { run: typeof run } }).__webglRender = { run };
