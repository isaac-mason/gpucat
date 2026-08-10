import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createBoxGeometry,
    createFullscreenTriangleGeometry,
    createIndirectBuffer,
    createStructTexture,
    CubeRenderTarget,
    CubeTexture,
    cubeTexture,
    d,
    DataTexture,
    depthTexture,
    DrawIndirect,
    f32,
    Geometry,
    GpuBuffer,
    i32,
    instanceIndex,
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
    screenCoordinate,
    screenUV,
    select,
    storage,
    struct,
    Texture,
    texture,
    textureDimensions,
    transformFeedback,
    u32,
    Uniform,
    uniform,
    varying,
    vec2f,
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
 * cube-mips: render into every face of a CubeRenderTarget with generateMipmaps, then sample the cube.
 * All faces share one color, so the sampled value equals the drawn color; this exercises the
 * render-finish → generateMipmap(CUBE) path (it must not throw and must leave a sampleable, correctly-
 * colored cube). Mirrors CubeCamera's flag-flip: generateMipmaps is kept off until the final face so
 * the mip chain is filled exactly once, on the render that completes all six faces.
 */
async function caseCubeMips(): Promise<CaseResult> {
    const renderer = await newRenderer();

    const rt = new CubeRenderTarget(SIZE, { colorFormat: 'rgba8unorm', depthBuffer: true, generateMipmaps: true });

    const drawn: [number, number, number, number] = [0.4, 0.7, 0.6, 1];
    const savedTarget = renderer.renderTarget;
    const savedClear = renderer.clearColor;
    renderer.renderTarget = rt;
    renderer.clearColor = [drawn[0], drawn[1], drawn[2], 1];
    const wantMips = rt.texture.generateMipmaps;
    rt.texture.generateMipmaps = false;
    for (let face = 0; face < 6; face++) {
        if (face === 5) rt.texture.generateMipmaps = wantMips; // restore before the last face
        rt.activeFace = face;
        const scene = new Scene();
        const camera = new PerspectiveCamera();
        scene.updateWorldMatrix();
        camera.updateViewMatrix();
        renderer.render(scene, camera);
    }
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

/**
 * batched-draws: `mesh.draws` issues two instanced sub-draws over one indexed box, each with its own
 * `firstInstance`. A 2×1 data texture holds instance 0 = red, instance 1 = green; the color is read in
 * the VERTEX stage (gl_InstanceID is vertex-only in GLSL) by `instanceIndex` — base-inclusive
 * (`u_drawBase + gl_InstanceID`) — and passed to the fragment via a varying. Both sub-draws fill the
 * view with depthTest off, so the CENTER pixel is the LAST sub-draw's color. `order` picks which
 * firstInstance is drawn last: [0,1] ⇒ last is instance 1 ⇒ green; [1,0] ⇒ last is instance 0 ⇒ red.
 * A broken firstInstance (u_drawBase not applied) makes every sub-draw read instance 0 ⇒ always red,
 * so the [0,1]⇒green case is the one that fails if the base isn't wired.
 */
async function batchedDrawsCase(name: string, order: [number, number], expected: [number, number, number, number]): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];

    // 2×1 rgba8unorm: instance 0 = red, instance 1 = green.
    const data = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
    const tex = new DataTexture(data, 2, 1, { format: 'rgba8unorm', magFilter: 'nearest', minFilter: 'nearest' });

    const geometry = createBoxGeometry(1, 1, 1);
    const position = attribute('position', d.vec3f);
    const clip = mul(cameraProjectionMatrix, mul(cameraViewMatrix, mul(modelWorldMatrix, vec4(position, f32(1)))));
    // Load per-instance color in the vertex stage (instanceIndex → gl_InstanceID is vertex-only),
    // carry it to the fragment as a (constant-per-primitive) varying.
    const instColor = texture(tex).load(vec2i(instanceIndex.toI32(), i32(0)), i32(0));
    const vColor = varying(instColor, 'vColor');
    const material = new Material({ vertex: clip, fragment: vColor, depthTest: false });

    const mesh = new Mesh(geometry, material);
    const indexCount = geometry.index!.array!.length;
    mesh.draws = order.map((firstInstance) => ({ indexCount, instanceCount: 1, firstIndex: 0, firstInstance }));

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
    return { name, pixel, expected };
}

/** batched-draws order [0,1] ⇒ last sub-draw is instance 1 ⇒ green. Fails if firstInstance is ignored. */
async function caseBatchedDrawsGreen(): Promise<CaseResult> {
    return batchedDrawsCase('batched-draws-g', [0, 1], [0, 255, 0, 255]);
}

/** batched-draws order [1,0] ⇒ last sub-draw is instance 0 ⇒ red (proves the other base too). */
async function caseBatchedDrawsRed(): Promise<CaseResult> {
    return batchedDrawsCase('batched-draws-r', [1, 0], [255, 0, 0, 255]);
}

/**
 * batched-draws-nonindexed: the same proof for the NON-indexed path. The fullscreen triangle has no
 * index buffer, so `mesh.draws` uses the `{ vertexCount, firstVertex, ... }` variant → the
 * drawArraysInstanced / draw path. Two sub-draws (firstInstance 0 then 1), center = last = instance 1
 * = green; a broken firstInstance would read instance 0 for both ⇒ red.
 */
async function caseBatchedDrawsNonIndexed(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];

    const data = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]); // instance 0 = red, instance 1 = green
    const tex = new DataTexture(data, 2, 1, { format: 'rgba8unorm', magFilter: 'nearest', minFilter: 'nearest' });

    const geometry = createFullscreenTriangleGeometry(); // non-indexed (3 vertices)
    const position = attribute('position', d.vec3f);
    const instColor = texture(tex).load(vec2i(instanceIndex.toI32(), i32(0)), i32(0));
    const vColor = varying(instColor, 'vColor');
    const material = new Material({ vertex: vec4(position, f32(1)), fragment: vColor, depthTest: false });

    const mesh = new Mesh(geometry, material);
    const vertexCount = geometry.buffers.get('position')!.count;
    mesh.draws = [
        { vertexCount, instanceCount: 1, firstVertex: 0, firstInstance: 0 },
        { vertexCount, instanceCount: 1, firstVertex: 0, firstInstance: 1 },
    ];

    const scene = new Scene();
    scene.add(mesh);
    const camera = new PerspectiveCamera();
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    renderer.render(scene, camera);
    const pixel = readCenter(renderer.gl!);
    renderer.dispose();
    return { name: 'batched-draws-nonindexed', pixel, expected: [0, 255, 0, 255] };
}

/**
 * integer-texture (rgba32uint): a 1×1 RGBA32UI DataTexture with known raw-`u32` channels, read via
 * `texture(tex).load(...)` → `uvec4` (usampler2D + integer texelFetch) and converted to a color.
 * Proves WebGL2 integer-texture support end-to-end: the RGBA32UI format upload, the `usampler2D`
 * declaration, and integer `texelFetch`. A regression (sampler2D / float path) would misread it.
 */
async function caseIntegerTexture(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];

    // 1×1 rgba32uint: one texel = (64, 128, 192, 255) as raw u32 channels.
    const tex = new DataTexture(new Uint32Array([64, 128, 192, 255]), 1, 1, {
        format: 'rgba32uint',
        magFilter: 'nearest',
        minFilter: 'nearest',
    });

    const texel = texture(tex).load(vec2i(i32(0), i32(0)), i32(0)); // Node<vec4u>
    const material = new Material({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: vec4(f32(texel.x).div(f32(255)), f32(texel.y).div(f32(255)), f32(texel.z).div(f32(255)), f32(1)),
        depthTest: false,
    });

    const mesh = new Mesh(createFullscreenTriangleGeometry(), material);
    const scene = new Scene();
    scene.add(mesh);
    const camera = new PerspectiveCamera();
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    renderer.render(scene, camera);
    const pixel = readCenter(renderer.gl!);
    renderer.dispose();
    return { name: 'integer-texture', pixel, expected: [64, 128, 192, 255] };
}

/**
 * struct-texture: schema-typed store→load round-trip. A `createStructTexture` for `{ color: vec4f,
 * id: u32 }` is written with `store(Rec, 0, …)` (CPU std430 pack into rgba32uint), then the fragment
 * reads it back with `texture(tex).load(Rec, 0)` — `.color` (a multi-lane f32 field via bitcast) into
 * rgb and `.id` (a u32 field at the next texel) into alpha. Proves store/load AGREE on the texel
 * layout across both field kinds + a multi-texel record.
 */
async function caseStructTexture(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];

    const Rec = struct('STRec', { color: d.vec4f, id: d.u32 });
    const tex = createStructTexture(Rec, 1);
    tex.packAtIndex(Rec, 0, { color: [0.25, 0.5, 0.75, 0.1], id: 255 });

    const rec = texture(tex).load(Rec, u32(0));
    const material = new Material({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: vec4(rec.color.x, rec.color.y, rec.color.z, f32(rec.id).div(f32(255))),
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
    // color rgb = (0.25,0.5,0.75); alpha = id/255 = 1.
    return { name: 'struct-texture', pixel, expected: [u8(0.25), u8(0.5), u8(0.75), 255] };
}

/**
 * struct-texture-mat4: a `{ m: mat4x4f }` record (4 texels, one per column). Stored with column 0 =
 * (0.25, 0.5, 0.75, 1); the fragment loads `.m` and computes `m · (1,0,0,0)` = column 0 → color.
 * Proves the mat4 decode (4 texel reads, per-lane bitcast, `mat4(...)` reassembly) round-trips.
 */
async function caseStructTextureMat4(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];

    const M = struct('STMat', { m: d.mat4x4f });
    const tex = createStructTexture(M, 1);
    // column-major: column 0 = (0.25, 0.5, 0.75, 1), rest 0.
    tex.packAtIndex(M, 0, { m: [0.25, 0.5, 0.75, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });

    const rec = texture(tex).load(M, u32(0));
    const col0 = mul(rec.m, vec4(f32(1), f32(0), f32(0), f32(0)));
    const material = new Material({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: vec4(col0.x, col0.y, col0.z, f32(1)),
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
    return { name: 'struct-texture-mat4', pixel, expected: [u8(0.25), u8(0.5), u8(0.75), 255] };
}

/**
 * struct-texture-unorm8x4: a packed `unorm8x4` field (4 B → one u32). Stored [64,128,192,255]/255,
 * loaded via `unpack4x8unorm` — which the GLSL emitter EMULATES (shift/mask + /255, not an ES-3.00
 * builtin). Proves CPU encode ↔ shader decode agree on byte order (component 0 = low bits).
 */
async function caseStructTexturePackedUnorm(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];
    const Rec = struct('STPackU8', { col: d.unorm8x4 });
    const tex = createStructTexture(Rec, 1);
    tex.packAtIndex(Rec, 0, { col: [64 / 255, 128 / 255, 192 / 255, 1] });
    const rec = texture(tex).load(Rec, u32(0));
    const material = new Material({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: vec4(rec.col.x, rec.col.y, rec.col.z, rec.col.w),
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
    return { name: 'struct-texture-unorm8x4', pixel, expected: [64, 128, 192, 255] };
}

/**
 * struct-texture-half2x16: packed `half2x16` (rg) + `unorm2x16` (ba) in one texel — the 2×16 family,
 * which lowers to native GLSL ES 3.00 builtins (unpackHalf2x16 / unpackUnorm2x16). half values are
 * fp16-exact (0.5, 0.25); unorm values 0.5/0.75.
 */
async function caseStructTexturePackedHalf(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];
    const Rec = struct('STPackH', { hv: d.half2x16, uv: d.unorm2x16 });
    const tex = createStructTexture(Rec, 1);
    tex.packAtIndex(Rec, 0, { hv: [0.5, 0.25], uv: [0.5, 0.75] });
    const rec = texture(tex).load(Rec, u32(0));
    // rgb only — the default framebuffer is opaque, so a fractional alpha reads back as 255.
    // hv.x→r, hv.y→g (half2x16), uv.x→b (unorm2x16); alpha fixed at 1.
    const material = new Material({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: vec4(rec.hv.x, rec.hv.y, rec.uv.x, f32(1)),
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
    return { name: 'struct-texture-half2x16', pixel, expected: [u8(0.5), u8(0.25), u8(0.5), 255] };
}

/**
 * struct-texture-snorm8x4: signed packed `snorm8x4`, values [1, 0, -1, 0.5], decoded via
 * `unpack4x8snorm` (GLSL-emulated with sign-extend + /127 + max(-1)). Read back remapped x*0.5+0.5:
 * 1→1(255), 0→0.5(128), -1→0(0), 0.5→~0.75(192).
 */
async function caseStructTexturePackedSnorm(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];
    const Rec = struct('STPackS8', { s: d.snorm8x4 });
    const tex = createStructTexture(Rec, 1);
    tex.packAtIndex(Rec, 0, { s: [1, 0, -1, 0.5] });
    const rec = texture(tex).load(Rec, u32(0));
    const material = new Material({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        // rgb = remap(s.xyz) into [0,1]; alpha fixed at 1 (opaque framebuffer). s.x=1→1, s.y=0→0.5,
        // s.z=-1→0 exercises the signed sign-extend path.
        fragment: vec4(
            rec.s.x.mul(f32(0.5)).add(f32(0.5)),
            rec.s.y.mul(f32(0.5)).add(f32(0.5)),
            rec.s.z.mul(f32(0.5)).add(f32(0.5)),
            f32(1),
        ),
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
    return { name: 'struct-texture-snorm8x4', pixel, expected: [255, u8(0.5), 0, 255] };
}

/**
 * struct-texture-bits: a `d.bits({ a: 8, b: 8, c: 8 })` field (one u32, fields low→high). Stored
 * {a:64,b:128,c:192}; each field is decoded via shift/mask (no builtins — works on both backends).
 * Proves the bitfield CPU encode ↔ shader shift/mask decode agree.
 */
async function caseStructTextureBits(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];
    const Rec = struct('STBits', { bf: d.bits({ a: 8, b: 8, c: 8 }) });
    const tex = createStructTexture(Rec, 1);
    tex.packAtIndex(Rec, 0, { bf: { a: 64, b: 128, c: 192 } } as never);
    const rec = texture(tex).load(Rec, u32(0));
    // bits sub-accessor: `.a`/`.b`/`.c` → `Node<u32>` (statically typed — no cast needed).
    const bf = rec.bf;
    const material = new Material({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: vec4(f32(bf.a).div(f32(255)), f32(bf.b).div(f32(255)), f32(bf.c).div(f32(255)), f32(1)),
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
    return { name: 'struct-texture-bits', pixel, expected: [64, 128, 192, 255] };
}

/**
 * struct-texture-grow: a `createStructTexture` allocated at capacity 1, then written at record 5 —
 * which forces an auto-grow (height only, width fixed). Loading record 5 (past the original
 * allocation) must return its stored value, proving the texture grew, copied, and still addresses
 * correctly under the compiled shader's fixed width. Without the grow, texel 10 is out of bounds and
 * `texelFetch` would read 0.
 */
async function caseStructTextureGrow(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];

    const Rec = struct('GrowRec', { color: d.vec4f, id: d.u32 });
    const tex = createStructTexture(Rec, 1); // capacity 1 → storing record 5 forces a height grow
    tex.packAtIndex(Rec, 0, { color: [0.9, 0.1, 0.2, 1], id: 1 });
    tex.packAtIndex(Rec, 5, { color: [0.25, 0.5, 0.75, 0.1], id: 255 });

    const rec = texture(tex).load(Rec, u32(5));
    const material = new Material({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: vec4(rec.color.x, rec.color.y, rec.color.z, f32(rec.id).div(f32(255))),
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
    return { name: 'struct-texture-grow', pixel, expected: [u8(0.25), u8(0.5), u8(0.75), 255] };
}

/**
 * struct-texture-partial: exercises the PARTIAL upload path. Render once (full upload of a grown,
 * multi-row texture), then change record 5 and render again — the second `store` routes through
 * `addUpdateRange` → the renderer re-uploads only row 5 via `texSubImage2D` (not the whole texture).
 * The final pixel must reflect the NEW value; a broken partial upload would show the stale first value.
 */
async function caseStructTexturePartial(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];

    const Rec = struct('PartRec', { color: d.vec4f, id: d.u32 });
    const tex = createStructTexture(Rec, 1); // grows to a multi-row texture when record 5 is written
    tex.packAtIndex(Rec, 5, { color: [0.9, 0.1, 0.2, 1], id: 1 });

    const rec = texture(tex).load(Rec, u32(5));
    const material = new Material({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: vec4(rec.color.x, rec.color.y, rec.color.z, f32(rec.id).div(f32(255))),
        depthTest: false,
    });
    const scene = new Scene();
    scene.add(new Mesh(createFullscreenTriangleGeometry(), material));
    const camera = new PerspectiveCamera();
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    renderer.render(scene, camera); // render 1: full upload (allocates the grown texture)
    // Change record 5 → partial path (already allocated, no full flag): only row 5 is re-uploaded.
    tex.packAtIndex(Rec, 5, { color: [0.25, 0.5, 0.75, 0.1], id: 255 });
    renderer.render(scene, camera); // render 2: partial texSubImage2D of row 5

    const pixel = readCenter(renderer.gl!);
    renderer.dispose();
    return { name: 'struct-texture-partial', pixel, expected: [u8(0.25), u8(0.5), u8(0.75), 255] };
}

/**
 * storage-struct: read one record of a read-only `storage()` buffer whose element is a struct, on WebGL.
 * WebGL2 has no SSBO, so the backend reinterprets the buffer AS an rgba32uint mirror texture (a zero-copy
 * view over the buffer's bytes) and lowers `buf.element(2).fields().color` to a texelFetch + bitcast —
 * the SAME `decodeField` path as `texture(t).load(schema, i)`. The center pixel must equal element 2's
 * color, proving the reinterpretation + index math + field decode round-trip end to end.
 */
async function caseStorageStruct(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];

    const Instance = struct('Instance', { color: d.vec4f });
    const R = 0.6;
    const G = 0.2;
    const B = 0.8;
    const N = 4;
    const data = new Float32Array(N * 4); // one vec4f per element; std430 stride = 16 bytes = 1 texel
    data[2 * 4 + 0] = R;
    data[2 * 4 + 1] = G;
    data[2 * 4 + 2] = B;
    data[2 * 4 + 3] = 1;
    const buf = new GpuBuffer(d.array(Instance), { data, usage: 'storage' });
    const store = storage(buf); // read-only, value-based → lowered to a mirror texture

    const geometry = createFullscreenTriangleGeometry();
    const position = attribute('position', d.vec3f);
    const material = new Material({
        vertex: vec4(position, f32(1)),
        fragment: store.element(u32(2)).fields().color,
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
    return { name: 'storage-struct', pixel, expected: [u8(R), u8(G), u8(B), 255] };
}

/**
 * storage-mat4: read a whole NON-struct element (a `mat4x4f`) from a read-only `storage()` buffer — the
 * makecat per-instance-transform shape (`array<mat4x4f>` gathered by index). This exercises the bare
 * `storage[i]` (Index-over-storage) lowering rather than a struct field: `store.element(1)` decodes the
 * mat4 from 4 mirror texels, then `.element(3)` selects its 4th column as the fragment color. We put the
 * probe color in element 1's column 3, so the center pixel must match it.
 */
async function caseStorageMat4(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];

    const R = 0.3;
    const G = 0.7;
    const B = 0.5;
    const N = 2;
    const data = new Float32Array(N * 16); // mat4x4f stride = 64 bytes = 4 texels
    // element 1, column 3 (bytes 48..63 within the element = floats 12..15) = (R, G, B, 1).
    data[1 * 16 + 12] = R;
    data[1 * 16 + 13] = G;
    data[1 * 16 + 14] = B;
    data[1 * 16 + 15] = 1;
    const buf = new GpuBuffer(d.array(d.mat4x4f), { data, usage: 'storage' });
    const store = storage(buf);

    const geometry = createFullscreenTriangleGeometry();
    const position = attribute('position', d.vec3f);
    const material = new Material({
        vertex: vec4(position, f32(1)),
        fragment: store.element(u32(1)).element(u32(3)),
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
    return { name: 'storage-mat4', pixel, expected: [u8(R), u8(G), u8(B), 255] };
}

/**
 * storage-dynamic: mutate a read-only storage() buffer BETWEEN frames and confirm the WebGL read picks up
 * the new bytes. The buffer is bound AS a per-GpuBuffer GL texture (no DataTexture); bumping `buffer.version`
 * (via `needsUpdate`) must re-upload the texture on the next render. We render element 0's color, rewrite it
 * in place, flag the buffer dirty, render again, and assert the SECOND frame's pixel is the updated color —
 * proving version-sync (the follow-up the buffer-backed rework unlocks; a static mirror would show stale data).
 */
async function caseStorageDynamic(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];

    const Instance = struct('Instance', { color: d.vec4f });
    const N = 4;
    const data = new Float32Array(N * 4); // one vec4f per element; std430 stride = 16 bytes = 1 texel
    // Frame 1 color at element 0.
    data[0] = 0.2;
    data[1] = 0.4;
    data[2] = 0.6;
    data[3] = 1;
    const buf = new GpuBuffer(d.array(Instance), { data, usage: 'storage' });
    const store = storage(buf);

    const geometry = createFullscreenTriangleGeometry();
    const position = attribute('position', d.vec3f);
    const material = new Material({
        vertex: vec4(position, f32(1)),
        fragment: store.element(u32(0)).fields().color,
        depthTest: false,
    });
    const mesh = new Mesh(geometry, material);
    const scene = new Scene();
    scene.add(mesh);
    const camera = new PerspectiveCamera();
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    // Frame 1 (allocates + uploads the buffer texture).
    renderer.render(scene, camera);

    // Mutate the buffer's bytes in place and flag it dirty — the next render must re-upload.
    const R = 0.9;
    const G = 0.1;
    const B = 0.5;
    data[0] = R;
    data[1] = G;
    data[2] = B;
    buf.needsUpdate = true;

    // Frame 2 must reflect the new bytes (version-synced re-upload of the same-size texture).
    renderer.render(scene, camera);
    const pixel = readCenter(renderer.gl!);
    renderer.dispose();
    return { name: 'storage-dynamic', pixel, expected: [u8(R), u8(G), u8(B), 255] };
}

/**
 * storage-store: exercise the COMPOSED write path — `GpuBuffer.packAtIndex(schema, i, value)` (CPU-side struct
 * pack) feeding the buffer-as-texture PARTIAL upload (`texSubImage2D` of just the covering rows). The
 * buffer is `array<Instance>` (8192 elements → a `min(8192, MAX_TEXTURE_SIZE)`-wide grid); we `store` a
 * NEW color into a MIDDLE element (not element 0) between frames, then read a pixel that combines the
 * stored element and an untouched element (`vec4(elemA.x, elem0.y, elemA.z, 1)`). Frame 2 must show the
 * new value on elemA's channels AND the original value on elem0's channel — proving `store` packs the
 * right bytes, the partial upload targets the right region, and untouched elements are not clobbered.
 */
async function caseStorageStore(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];

    const Instance = struct('Instance', { color: d.vec4f });
    const N = 8192; // 1 texel/element → 8192 texels → a 2048×4 grid (height 4, so partial rows < full).
    const A_IDX = 5000; // texel 5000 → row 2; element 0 → row 0 (a different, untouched row).
    const data = new Float32Array(N * 4);
    // Element 0 (untouched): only its .y (G) is asserted.
    const G = 0.4;
    data[0] = 0.1;
    data[1] = G;
    data[2] = 0.1;
    data[3] = 1;
    // Element A_IDX frame-1 value (overwritten by store before frame 2; not asserted).
    data[A_IDX * 4 + 0] = 0.05;
    data[A_IDX * 4 + 1] = 0.05;
    data[A_IDX * 4 + 2] = 0.05;
    data[A_IDX * 4 + 3] = 1;

    const buf = new GpuBuffer(d.array(Instance), { data, usage: 'storage' });
    const store = storage(buf);

    const elemA = store.element(u32(A_IDX)).fields().color;
    const elem0 = store.element(u32(0)).fields().color;

    const geometry = createFullscreenTriangleGeometry();
    const position = attribute('position', d.vec3f);
    const material = new Material({
        vertex: vec4(position, f32(1)),
        // Combine the stored element (x, z) with the untouched element (y) so one pixel proves both.
        fragment: vec4(elemA.x, elem0.y, elemA.z, f32(1)),
        depthTest: false,
    });
    const mesh = new Mesh(geometry, material);
    const scene = new Scene();
    scene.add(mesh);
    const camera = new PerspectiveCamera();
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    // Frame 1: allocates + fully uploads the buffer texture.
    renderer.render(scene, camera);

    // Schema-typed write of a NEW color into the middle element → queues a partial (row-2) upload.
    const R = 0.8;
    const B = 0.6;
    buf.packAtIndex(Instance, A_IDX, { color: [R, 0.3, B, 1] });

    // Frame 2: partial `texSubImage2D` of row 2 only; elem0's row 0 stays as originally uploaded.
    renderer.render(scene, camera);
    const pixel = readCenter(renderer.gl!);
    renderer.dispose();
    return { name: 'storage-store', pixel, expected: [u8(R), u8(G), u8(B), 255] };
}

/**
 * storage-pad: a read-only storage() buffer whose texel count is NOT a multiple of the grid width, so the
 * lowering pads the short LAST row. We size the buffer to `MAX_TEXTURE_SIZE + 3` texels → width = MAX,
 * height = 2, with a 3-texel padded last row; the probe element is the very last one (in that padded row).
 * The center pixel must equal its color — proving the padded upload (full rows + a narrower last-row
 * `texSubImage2D`), the 2D wrap addressing (`% width`, `/ width`), and that no read runs past the buffer.
 */
/**
 * storage-u32: read a scalar element from a read-only `storage(d.array(d.u32))` buffer. A u32 is 4 bytes
 * (four per rgba32uint mirror texel), so element `i` lives at texel `i/4`, lane `i%4` — NOT texel `i`. This
 * probes whether the sub-16-byte-element addressing is correct. Element 5 holds 128; the center pixel's red
 * channel must read back 128. (makecat's voxel `quads`/`quadSlot` are `array<u32>`.)
 */
async function caseStorageU32(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];

    const N = 64; // 256 bytes = multiple of 16, so this isolates ADDRESSING from the byte-length guard.
    const data = new Uint32Array(N);
    for (let i = 0; i < N; i++) data[i] = i; // distinct per element
    data[5] = 128;
    const buf = new GpuBuffer(d.array(d.u32), { data, usage: 'storage' });
    const store = storage(buf);

    const geometry = createFullscreenTriangleGeometry();
    const position = attribute('position', d.vec3f);
    const material = new Material({
        vertex: vec4(position, f32(1)),
        fragment: vec4(store.element(u32(5)).toF32().div(f32(255)), f32(0), f32(0), f32(1)),
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
    return { name: 'storage-u32', pixel, expected: [128, 0, 0, 255] };
}

/**
 * storage-u32-odd: a `storage(d.array(d.u32))` whose byte length is NOT a multiple of 16 (7 u32 = 28
 * bytes) — the exact shape that made makecat's `quadSlot` throw the old "multiple of 16" guard. With an
 * `r32uint` mirror (4-byte texels) it binds and reads correctly. Reads the last element.
 */
async function caseStorageU32Odd(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];

    const N = 7; // 28 bytes — %16 != 0 (old guard rejected), %4 == 0 (r32uint is fine).
    const data = new Uint32Array(N);
    for (let i = 0; i < N; i++) data[i] = i * 10;
    data[6] = 210;
    const buf = new GpuBuffer(d.array(d.u32), { data, usage: 'storage' });
    const store = storage(buf);

    const geometry = createFullscreenTriangleGeometry();
    const position = attribute('position', d.vec3f);
    const material = new Material({
        vertex: vec4(position, f32(1)),
        fragment: vec4(store.element(u32(6)).toF32().div(f32(255)), f32(0), f32(0), f32(1)),
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
    return { name: 'storage-u32-odd', pixel, expected: [210, 0, 0, 255] };
}

/**
 * storage-vec2: a `storage(d.array(d.vec2f))` — 8-byte stride → `rg32uint` mirror (2 u32 lanes/texel).
 * Element 3's (x, y) drive red/green, proving the rg32uint format + vec2 lane decode.
 */
async function caseStorageVec2(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];

    const N = 8;
    const data = new Float32Array(N * 2);
    data[3 * 2 + 0] = 0.5;
    data[3 * 2 + 1] = 0.25;
    const buf = new GpuBuffer(d.array(d.vec2f), { data, usage: 'storage' });
    const store = storage(buf);

    const geometry = createFullscreenTriangleGeometry();
    const position = attribute('position', d.vec3f);
    const v = store.element(u32(3));
    const material = new Material({
        vertex: vec4(position, f32(1)),
        fragment: vec4(v.x, v.y, f32(0), f32(1)),
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
    return { name: 'storage-vec2', pixel, expected: [128, 64, 0, 255] };
}

/**
 * storage-u32-struct: a `storage(d.array(struct{a:u32,b:u32}))` — an 8-byte all-scalar struct →
 * `rg32uint` mirror (makecat's `VisibleQuad` shape). Field `a` decodes from lane .x (byteOffset 0), field
 * `b` from lane .y (byteOffset 4), proving struct-field decode within an rg32uint texel.
 */
async function caseStorageU32Struct(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];

    const Rec = struct('U32Pair', { a: d.u32, b: d.u32 });
    const N = 8;
    const data = new Uint32Array(N * 2);
    data[3 * 2 + 0] = 100;
    data[3 * 2 + 1] = 200;
    const buf = new GpuBuffer(d.array(Rec), { data, usage: 'storage' });
    const store = storage(buf);

    const geometry = createFullscreenTriangleGeometry();
    const position = attribute('position', d.vec3f);
    const rec = store.element(u32(3));
    const material = new Material({
        vertex: vec4(position, f32(1)),
        fragment: vec4(rec.field('a').toF32().div(f32(255)), rec.field('b').toF32().div(f32(255)), f32(0), f32(1)),
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
    return { name: 'storage-u32-struct', pixel, expected: [100, 200, 0, 255] };
}

async function caseStoragePad(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];
    const MAX = renderer.gl!.getParameter(renderer.gl!.MAX_TEXTURE_SIZE) as number;

    const Instance = struct('Instance', { color: d.vec4f });
    const N = MAX + 3; // width = min(N, MAX) = MAX → fullRows 1, remainder 3, height 2.
    const LAST = N - 1; // last element sits in the padded last row.
    const R = 0.6;
    const G = 0.2;
    const B = 0.8;
    const data = new Float32Array(N * 4);
    data[LAST * 4 + 0] = R;
    data[LAST * 4 + 1] = G;
    data[LAST * 4 + 2] = B;
    data[LAST * 4 + 3] = 1;
    const buf = new GpuBuffer(d.array(Instance), { data, usage: 'storage' });
    const store = storage(buf);

    const geometry = createFullscreenTriangleGeometry();
    const position = attribute('position', d.vec3f);
    const material = new Material({
        vertex: vec4(position, f32(1)),
        fragment: store.element(u32(LAST)).fields().color,
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
    return { name: 'storage-pad', pixel, expected: [u8(R), u8(G), u8(B), 255] };
}

/**
 * storage-pad-dynamic: mutate the element in the PADDED last row between frames and confirm the partial
 * upload targets that (narrower) last row. `packAtIndex` on the last element queues a dirty range whose
 * covering row is the padded row; the partial `texSubImage2D` must upload only its `remainder` texels.
 * Frame 2 must show the new color.
 */
async function caseStoragePadDynamic(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];
    const MAX = renderer.gl!.getParameter(renderer.gl!.MAX_TEXTURE_SIZE) as number;

    const Instance = struct('Instance', { color: d.vec4f });
    const N = MAX + 3;
    const LAST = N - 1;
    const data = new Float32Array(N * 4);
    // Frame-1 value at the last element (overwritten before frame 2; not asserted).
    data[LAST * 4 + 0] = 0.05;
    data[LAST * 4 + 1] = 0.05;
    data[LAST * 4 + 2] = 0.05;
    data[LAST * 4 + 3] = 1;
    const buf = new GpuBuffer(d.array(Instance), { data, usage: 'storage' });
    const store = storage(buf);

    const geometry = createFullscreenTriangleGeometry();
    const position = attribute('position', d.vec3f);
    const material = new Material({
        vertex: vec4(position, f32(1)),
        fragment: store.element(u32(LAST)).fields().color,
        depthTest: false,
    });
    const mesh = new Mesh(geometry, material);
    const scene = new Scene();
    scene.add(mesh);
    const camera = new PerspectiveCamera();
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    renderer.render(scene, camera); // frame 1: full upload (allocates the padded grid).

    const R = 0.9;
    const G = 0.1;
    const B = 0.5;
    buf.packAtIndex(Instance, LAST, { color: [R, G, B, 1] }); // dirty range → padded last row.

    renderer.render(scene, camera); // frame 2: partial upload of just the last (narrower) row.
    const pixel = readCenter(renderer.gl!);
    renderer.dispose();
    return { name: 'storage-pad-dynamic', pixel, expected: [u8(R), u8(G), u8(B), 255] };
}

/**
 * readback-orientation: render a two-tone image (red where clip-space y > 0, green below) into an
 * rgba8unorm RenderTarget, then assert `readRenderTargetPixels` returns red in the TOP rows and green
 * in the BOTTOM rows. This proves the row-flip: GL reads bottom-to-top, and the readback must return
 * top-to-bottom to match the WebGPU `readPixels` contract (output row 0 = clip +Y = top of image).
 */
async function caseReadbackOrientation(): Promise<CaseResult> {
    const renderer = await newRenderer();
    const rt = new RenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm', depthBuffer: true });

    const geometry = createFullscreenTriangleGeometry();
    const position = attribute('position', d.vec3f);
    const vy = varying(position.y, 'vy'); // clip-space y interpolated to each fragment
    const material = new Material({
        vertex: vec4(position, f32(1)),
        fragment: select(vec4(0, 1, 0, 1), vec4(1, 0, 0, 1), vy.greaterThan(f32(0))),
        depthTest: false,
    });
    const scene = new Scene();
    scene.add(new Mesh(geometry, material));
    const camera = new PerspectiveCamera();
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    const saved = renderer.renderTarget;
    renderer.renderTarget = rt;
    renderer.render(scene, camera);
    renderer.renderTarget = saved;

    const px = await renderer.readRenderTargetPixels(rt);
    const at = (x: number, y: number): [number, number, number, number] => {
        const i = (y * SIZE + x) * 4;
        return [px[i], px[i + 1], px[i + 2], px[i + 3]];
    };
    const top = at(CENTER, 3);
    const bottom = at(CENTER, SIZE - 4);
    renderer.dispose();

    const isRed = (c: number[]): boolean => c[0] > 200 && c[1] < 60 && c[2] < 60;
    const isGreen = (c: number[]): boolean => c[1] > 200 && c[0] < 60 && c[2] < 60;
    const pass = isRed(top) && isGreen(bottom);
    return {
        name: 'readback-orientation',
        pixel: pass ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `top=${top.join(',')} bottom=${bottom.join(',')}`,
    };
}

/**
 * headless-offscreen: construct a WebGLRenderer over a 1x1 OffscreenCanvas (no DOM canvas, no setSize),
 * render a solid color into a RenderTarget, and read it back — proving OffscreenCanvas acceptance
 * end-to-end (the headless icon-bake path).
 */
async function caseHeadlessOffscreen(): Promise<CaseResult> {
    const renderer = new WebGLRenderer({ canvas: new OffscreenCanvas(1, 1) });
    await renderer.init();
    const rt = new RenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm', depthBuffer: true });

    const geometry = createFullscreenTriangleGeometry();
    const position = attribute('position', d.vec3f);
    const material = new Material({
        vertex: vec4(position, f32(1)),
        fragment: vec4(0.2, 0.8, 0.4, 1),
        depthTest: false,
    });
    const scene = new Scene();
    scene.add(new Mesh(geometry, material));
    const camera = new PerspectiveCamera();
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    const saved = renderer.renderTarget;
    renderer.renderTarget = rt;
    renderer.render(scene, camera);
    renderer.renderTarget = saved;

    const px = await renderer.readRenderTargetPixels(rt);
    const i = (CENTER * SIZE + CENTER) * 4;
    const pixel: [number, number, number, number] = [px[i], px[i + 1], px[i + 2], px[i + 3]];
    renderer.dispose();
    return { name: 'headless-offscreen', pixel, expected: [u8(0.2), u8(0.8), u8(0.4), 255] };
}

/**
 * storage+texture: the avatar-material shape that nothing else covers. A read-only storage() buffer
 * (lowered to a usampler2D integer texture) read in the VERTEX stage AND a regular sampler2D texture
 * sampled in the FRAGMENT stage, in ONE material. Both samplers are declared in both GLSL stages
 * (combined-sampler model); the draw must give each a DISTINCT texture unit or GL raises 1282
 * "mismatch between texture format and sampler type". Reads back the sampled texel (magenta); a wrong
 * unit assignment makes the fragment read the integer storage texture instead.
 */
async function caseStorageAndTexture(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];

    // storage: one vec4 we read in the VERTEX and hand to the fragment as a varying (like the avatar's uv).
    const buf = new GpuBuffer(d.array(d.vec4f), { data: new Float32Array([0.5, 0.5, 0, 0]), usage: 'storage' });
    const store = storage(buf);

    // texture: solid magenta 2x2 (the expected sample).
    const R = u8(0.6);
    const G = u8(0.2);
    const B = u8(0.8);
    const tdata = new Uint8Array(2 * 2 * 4);
    for (let i = 0; i < 4; i++) {
        tdata[i * 4 + 0] = R;
        tdata[i * 4 + 1] = G;
        tdata[i * 4 + 2] = B;
        tdata[i * 4 + 3] = 255;
    }
    const tex = new DataTexture(tdata, 2, 2, { format: 'rgba8unorm', magFilter: 'nearest', minFilter: 'nearest' });

    const geometry = createFullscreenTriangleGeometry();
    const position = attribute('position', d.vec3f);
    const uvFromStorage = varying(store.element(u32(0)).xy, 'vUv'); // storage read in the vertex stage
    const material = new Material({
        vertex: vec4(position, f32(1)),
        fragment: texture(tex).sample(uvFromStorage), // sampler2D in the fragment stage
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
    return { name: 'storage+texture', pixel, expected: [R, G, B, 255] };
}

/**
 * interleaved-attrs: two attributes sharing ONE buffer name ('vertex') but at DIFFERENT byte offsets,
 * the avatar's `posU`@0 / `normalV`@16 interleave. The GLSL emitter used to dedup named attributes by NAME
 * alone, collapsing both to offset 0, so the SECOND attribute's data was silently dropped (its .w read the
 * first's .w). We put a distinct probe in each attribute's .w (0.6 in the first, 0.8 in the second) and
 * output vec4(first.w, second.w, 0, 1): the green channel proves the second attribute is fetched from its
 * own offset/location. Buggy output would be [153,153,0,255] (green collapses to red); correct is
 * [153,204,0,255]. This is the WebGL2 analogue of the WGSL path, which always kept them distinct.
 */
async function caseInterleavedAttrs(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];

    const Vtx = struct('InterleavedVtx', { a: d.vec4f, b: d.vec4f }); // 32-byte stride, b at offset 16
    const U = 0.6;
    const V = 0.8;
    // fullscreen triangle in a.xyz; a.w = U probe, b.w = V probe (same on all 3 verts for constant interp).
    // biome-ignore format: vertex rows
    const data = new Float32Array([
        -1, -1, 0, U,   0, 0, 0, V,
         3, -1, 0, U,   0, 0, 0, V,
        -1,  3, 0, U,   0, 0, 0, V,
    ]);
    const vbuf = new GpuBuffer(Vtx, { data, usage: 'vertex' });
    const geometry = new Geometry();
    geometry.setBuffer('vertex', vbuf);

    const aFirst = attribute('vertex', d.vec4f, { stride: 32, offset: 0 });
    const aSecond = attribute('vertex', d.vec4f, { stride: 32, offset: 16 });
    const vColor = varying(vec4(aFirst.w, aSecond.w, f32(0), f32(1)), 'vColor');
    const material = new Material({
        vertex: vec4(aFirst.xyz, f32(1)),
        fragment: vColor,
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
    return { name: 'interleaved-attrs', pixel, expected: [u8(U), u8(V), 0, 255] };
}

/**
 * rtt-flip: prove the render-target V-flip. WebGL's framebuffer origin is bottom-left vs WebGPU's
 * top-left, so a texture RENDERED INTO is stored with its rows in the opposite V order; sampling it must
 * flip V to match WebGPU. Pass 1 renders a two-tone into the RT (clip-space top = RED, bottom = GREEN).
 * Pass 2 samples the RT at a FIXED uv in the top region (v=0.25) fullscreen and reads it back. WebGPU
 * would return the top color (RED) there; the flip makes WebGL agree. Without the flip WebGL samples the
 * bottom-up storage and returns GREEN, so this fails if the render-target flip regresses.
 */
async function caseRenderTargetFlip(): Promise<CaseResult> {
    const renderer = await newRenderer();
    const rt = new RenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm', depthBuffer: true });

    // Pass 1: two-tone into the RT. clip y > 0 (top) = RED, below = GREEN.
    const geometry1 = createFullscreenTriangleGeometry();
    const position1 = attribute('position', d.vec3f);
    const vy = varying(position1.y, 'vy');
    const twoTone = new Material({
        vertex: vec4(position1, f32(1)),
        fragment: select(vec4(0, 1, 0, 1), vec4(1, 0, 0, 1), vy.greaterThan(f32(0))),
        depthTest: false,
    });
    const scene1 = new Scene();
    scene1.add(new Mesh(geometry1, twoTone));
    const camera1 = new PerspectiveCamera();
    scene1.updateWorldMatrix();
    camera1.updateViewMatrix();

    const saved = renderer.renderTarget;
    renderer.renderTarget = rt;
    renderer.render(scene1, camera1);
    renderer.renderTarget = saved;

    // Pass 2: sample the RT at a constant top-region uv (v = 0.25) onto the default framebuffer.
    renderer.clearColor = [0, 0, 0, 1];
    const geometry2 = createFullscreenTriangleGeometry();
    const position2 = attribute('position', d.vec3f);
    const sampleMat = new Material({
        vertex: vec4(position2, f32(1)),
        fragment: texture(rt.texture! as Texture).sample(vec2f(0.5, 0.25)),
        depthTest: false,
    });
    const scene2 = new Scene();
    scene2.add(new Mesh(geometry2, sampleMat));
    const camera2 = new PerspectiveCamera();
    scene2.updateWorldMatrix();
    camera2.updateViewMatrix();

    renderer.render(scene2, camera2);
    const pixel = readCenter(renderer.gl!);
    renderer.dispose();
    // v=0.25 is the top region, so RED (matching WebGPU's top-left sampling origin).
    return { name: 'rtt-flip', pixel, expected: [255, 0, 0, 255] };
}

/**
 * rt-load-orient: verifies the `.load()` (texelFetch) path applies the render-target V-flip at runtime,
 * indexed the way makecat's CanvasTrait occlusion does — `texture(rt).load(vec2i(screenUV * dims))`.
 * (makecat samples the DEPTH RT this way; SwiftShader can't sample depth textures, so this exercises the
 * identical shared flip helper on a COLOR RT — the depth path routes through the same `textureFlip`.)
 * Pass 1 writes two-tone into the RT (displayed TOP = RED, BOTTOM = GREEN). Pass 2 loads it by top-left
 * screenUV; the displayed top must read RED — without the flip, the texelFetch reads the mirrored row (GREEN).
 */
async function caseRtLoadOrient(): Promise<CaseResult> {
    const renderer = await newRenderer();
    const rt = new RenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm', depthBuffer: true });

    // Pass 1: two-tone into the RT — clip y > 0 (top) = RED, below = GREEN.
    const g1 = createFullscreenTriangleGeometry();
    const p1 = attribute('position', d.vec3f);
    const vy = varying(p1.y, 'vyLoadOrient');
    const twoTone = new Material({
        vertex: vec4(p1, f32(1)),
        fragment: select(vec4(0, 1, 0, 1), vec4(1, 0, 0, 1), vy.greaterThan(f32(0))),
        depthTest: false,
    });
    const s1 = new Scene();
    s1.add(new Mesh(g1, twoTone));
    const cam1 = new PerspectiveCamera();
    s1.updateWorldMatrix();
    cam1.updateViewMatrix();
    renderer.renderTarget = rt;
    renderer.render(s1, cam1);
    renderer.renderTarget = null;

    // Pass 2: texelFetch the RT by top-left screenUV * dims (makecat's occlusion index) → output it.
    renderer.clearColor = [0, 0, 0, 1];
    const texNode = texture(rt.texture! as Texture);
    const texel = vec2i(mul(screenUV, vec2f(textureDimensions(texNode.bindingNode))));
    const g2 = createFullscreenTriangleGeometry();
    const p2 = attribute('position', d.vec3f);
    const showMat = new Material({
        vertex: vec4(p2, f32(1)),
        fragment: texNode.load(texel),
        depthTest: false,
    });
    const s2 = new Scene();
    s2.add(new Mesh(g2, showMat));
    const cam2 = new PerspectiveCamera();
    s2.updateWorldMatrix();
    cam2.updateViewMatrix();
    renderer.render(s2, cam2);

    const gl = renderer.gl!;
    const top = readAt(gl, CENTER, SIZE - 4); // displayed top → RED
    const bottom = readAt(gl, CENTER, 3); //     displayed bottom → GREEN
    renderer.dispose();
    // Correct (un-mirrored): displayed top loads RED, bottom loads GREEN.
    const ok = top[0] > 128 && top[1] < 128 && bottom[1] > 128 && bottom[0] < 128;
    return {
        name: 'rt-load-orient',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `top=[${top[0]},${top[1]}] bottom=[${bottom[0]},${bottom[1]}] (top must be RED; mirrored would swap)`,
    };
}

/**
 * depth-load-read: a DEPTH render target sampled via `depthTexture(rt).load(...)` must return real depth,
 * not 0 — and be correctly oriented. This is makecat's CanvasTrait occlusion read. A depth texture with a
 * LINEAR default filter is texture-INCOMPLETE in WebGL2 (depth is not filterable), so the read comes back
 * 0 → the occlusion discards everything → a screen-space mask; the NEAREST default fixes it. Pass 1 writes
 * depth 0.2 to the top (clip y>0) and 0.8 to the bottom via a frag-depth override; pass 2 reads it by
 * top-left screenUV. Displayed top must be the NEAR (dark ~0.2) depth — nonzero AND not mirrored.
 */
async function caseDepthLoadRead(): Promise<CaseResult> {
    const renderer = await newRenderer();
    const rt = new RenderTarget(SIZE, SIZE, { count: 0, depthFormat: 'depth32float', depthSampled: true });

    const g1 = createFullscreenTriangleGeometry();
    const p1 = attribute('position', d.vec3f);
    const vy = varying(p1.y, 'vyDepthRead');
    const depthMat = new Material({
        vertex: vec4(p1, f32(1)),
        fragment: undefined,
        depth: select(f32(0.8), f32(0.2), vy.greaterThan(f32(0))),
    });
    const s1 = new Scene();
    s1.add(new Mesh(g1, depthMat));
    const cam1 = new PerspectiveCamera();
    s1.updateWorldMatrix();
    cam1.updateViewMatrix();
    renderer.renderTarget = rt;
    renderer.render(s1, cam1);
    renderer.renderTarget = null;

    renderer.clearColor = [0, 0, 0, 1];
    const depthNode = depthTexture(rt.depthTexture!);
    const texel = vec2i(mul(screenUV, vec2f(textureDimensions(depthNode.bindingNode))));
    const sceneZ = depthNode.load(texel);
    const g2 = createFullscreenTriangleGeometry();
    const p2 = attribute('position', d.vec3f);
    const showMat = new Material({
        vertex: vec4(p2, f32(1)),
        fragment: vec4(sceneZ, sceneZ, sceneZ, f32(1)),
        depthTest: false,
    });
    const s2 = new Scene();
    s2.add(new Mesh(g2, showMat));
    const cam2 = new PerspectiveCamera();
    s2.updateWorldMatrix();
    cam2.updateViewMatrix();
    renderer.render(s2, cam2);

    const gl = renderer.gl!;
    const top = readAt(gl, CENTER, SIZE - 4); // displayed top → near depth 0.2 → dark (~51), NONZERO
    const bottom = readAt(gl, CENTER, 3); //     displayed bottom → far depth 0.8 → light (~204)
    renderer.dispose();
    // Nonzero (read works) AND oriented (top is the near/dark depth, not the mirrored far/light one).
    const ok = bottom[0] > top[0] && bottom[0] > 100 && top[0] < 128;
    return {
        name: 'depth-load-read',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `top=${top[0]} bottom=${bottom[0]} (top≈51 near, bottom≈204 far; both 0 = depth read broken)`,
    };
}

/** Read the default framebuffer at (x,y). readPixels origin is bottom-left, so y=SIZE-4 is the
 *  DISPLAYED TOP and y=3 is the DISPLAYED BOTTOM. */
function readAt(gl: WebGL2RenderingContext, x: number, y: number): [number, number, number, number] {
    const buf = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return [buf[0], buf[1], buf[2], buf[3]];
}

const isRed = (c: number[]): boolean => c[0] > 200 && c[1] < 60 && c[2] < 60;

/**
 * screen-orient-direct: two-tone (clip top RED, bottom GREEN) rendered DIRECTLY to the default
 * framebuffer. The browser presents the default fb right-side-up, so displayed-top MUST be RED. The
 * baseline for `screen-orient-present` below — proves the direct path is upright before comparing.
 */
async function caseScreenOrientDirect(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];
    const g = createFullscreenTriangleGeometry();
    const p = attribute('position', d.vec3f);
    const vy = varying(p.y, 'vy');
    const mat = new Material({
        vertex: vec4(p, f32(1)),
        fragment: select(vec4(0, 1, 0, 1), vec4(1, 0, 0, 1), vy.greaterThan(f32(0))),
        depthTest: false,
    });
    const s = new Scene();
    s.add(new Mesh(g, mat));
    const c = new PerspectiveCamera();
    s.updateWorldMatrix();
    c.updateViewMatrix();
    renderer.render(s, c);
    const gl = renderer.gl!;
    const dispTop = readAt(gl, CENTER, SIZE - 4);
    const dispBottom = readAt(gl, CENTER, 3);
    renderer.dispose();
    return {
        name: 'screen-orient-direct',
        pixel: isRed(dispTop) ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `dispTop=${dispTop.join(',')} dispBottom=${dispBottom.join(',')} (top should be RED)`,
    };
}

/**
 * screen-orient-present: the app present path — two-tone into an RT, then a fullscreen pass sampling
 * it via `screenUV` to the default framebuffer (the studio/avatar `renderOutput(fxaa(texture(rt)))`
 * shape, minus the pure color math, which doesn't affect orientation). Displayed-top MUST be RED to
 * match the direct baseline / WebGPU. GREEN means the on-screen present is vertically mirrored, which
 * happens when gl_FragCoord.y (bottom-up) isn't flipped to top-left: screenUV then double-inverts
 * against the render-target sample flip. The constant-uv `rtt-flip` case can't catch this — it needs
 * a screenUV-varying sample across the whole image.
 */
async function caseScreenOrientPresent(): Promise<CaseResult> {
    const renderer = await newRenderer();
    const rt = new RenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm', depthBuffer: true });
    // pass 1: two-tone into the RT.
    const g1 = createFullscreenTriangleGeometry();
    const p1 = attribute('position', d.vec3f);
    const vy = varying(p1.y, 'vy');
    const twoTone = new Material({
        vertex: vec4(p1, f32(1)),
        fragment: select(vec4(0, 1, 0, 1), vec4(1, 0, 0, 1), vy.greaterThan(f32(0))),
        depthTest: false,
    });
    const s1 = new Scene();
    s1.add(new Mesh(g1, twoTone));
    const c1 = new PerspectiveCamera();
    s1.updateWorldMatrix();
    c1.updateViewMatrix();
    const saved = renderer.renderTarget;
    renderer.renderTarget = rt;
    renderer.render(s1, c1);
    renderer.renderTarget = saved;
    // pass 2: present via screenUV to the default framebuffer.
    renderer.clearColor = [0, 0, 0, 1];
    const g2 = createFullscreenTriangleGeometry();
    const p2 = attribute('position', d.vec3f);
    const present = new Material({
        vertex: vec4(p2, f32(1)),
        fragment: texture(rt.texture! as Texture).sample(screenUV),
        depthTest: false,
    });
    const s2 = new Scene();
    s2.add(new Mesh(g2, present));
    const c2 = new PerspectiveCamera();
    s2.updateWorldMatrix();
    c2.updateViewMatrix();
    renderer.render(s2, c2);
    const gl = renderer.gl!;
    const dispTop = readAt(gl, CENTER, SIZE - 4);
    const dispBottom = readAt(gl, CENTER, 3);
    renderer.dispose();
    return {
        name: 'screen-orient-present',
        pixel: isRed(dispTop) ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `dispTop=${dispTop.join(',')} dispBottom=${dispBottom.join(',')} (top should be RED; GREEN = mirrored)`,
    };
}

/**
 * fragcoord-direct: a shader that reads RAW gl_FragCoord (screenCoordinate), NOT screenUV, and splits
 * the image by pixel row straight to the default framebuffer. With fragCoord flipped to WebGPU's
 * top-left origin, `fragCoord.y < height/2` is the DISPLAYED TOP, so displayed-top MUST be RED. Guards
 * the global fragCoord flip for direct (non-screenUV) position reads.
 */
async function caseFragCoordDirect(): Promise<CaseResult> {
    const renderer = await newRenderer();
    renderer.clearColor = [0, 0, 0, 1];
    const g = createFullscreenTriangleGeometry();
    const p = attribute('position', d.vec3f);
    const mat = new Material({
        vertex: vec4(p, f32(1)),
        // top-left fragCoord: y < half → top → RED, else GREEN.
        fragment: select(vec4(0, 1, 0, 1), vec4(1, 0, 0, 1), screenCoordinate.y.lessThan(f32(SIZE / 2))),
        depthTest: false,
    });
    const s = new Scene();
    s.add(new Mesh(g, mat));
    const c = new PerspectiveCamera();
    s.updateWorldMatrix();
    c.updateViewMatrix();
    renderer.render(s, c);
    const gl = renderer.gl!;
    const dispTop = readAt(gl, CENTER, SIZE - 4);
    const dispBottom = readAt(gl, CENTER, 3);
    renderer.dispose();
    return {
        name: 'fragcoord-direct',
        pixel: isRed(dispTop) ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `dispTop=${dispTop.join(',')} dispBottom=${dispBottom.join(',')} (top should be RED)`,
    };
}

/**
 * geomuv-present: two-tone into an RT, then present sampling by the fullscreen triangle's GEOMETRY uv
 * attribute (top-left convention), NOT screenUV, to the default framebuffer. Isolates the render-target
 * V-flip for geometry-uv sampling (no fragCoord in the uv). Displayed-top MUST be RED.
 */
async function caseGeomUvPresent(): Promise<CaseResult> {
    const renderer = await newRenderer();
    const rt = new RenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm', depthBuffer: true });
    // pass 1: two-tone into the RT (clip top RED, bottom GREEN).
    const g1 = createFullscreenTriangleGeometry();
    const p1 = attribute('position', d.vec3f);
    const vy = varying(p1.y, 'vy');
    const twoTone = new Material({
        vertex: vec4(p1, f32(1)),
        fragment: select(vec4(0, 1, 0, 1), vec4(1, 0, 0, 1), vy.greaterThan(f32(0))),
        depthTest: false,
    });
    const s1 = new Scene();
    s1.add(new Mesh(g1, twoTone));
    const c1 = new PerspectiveCamera();
    s1.updateWorldMatrix();
    c1.updateViewMatrix();
    const saved = renderer.renderTarget;
    renderer.renderTarget = rt;
    renderer.render(s1, c1);
    renderer.renderTarget = saved;
    // pass 2: present sampling by the geometry uv (top-left), not screenUV.
    renderer.clearColor = [0, 0, 0, 1];
    const g2 = createFullscreenTriangleGeometry();
    const p2 = attribute('position', d.vec3f);
    const vUv = varying(attribute('uv', d.vec2f), 'vUv');
    const present = new Material({
        vertex: vec4(p2, f32(1)),
        fragment: texture(rt.texture! as Texture).sample(vUv),
        depthTest: false,
    });
    const s2 = new Scene();
    s2.add(new Mesh(g2, present));
    const c2 = new PerspectiveCamera();
    s2.updateWorldMatrix();
    c2.updateViewMatrix();
    renderer.render(s2, c2);
    const gl = renderer.gl!;
    const dispTop = readAt(gl, CENTER, SIZE - 4);
    const dispBottom = readAt(gl, CENTER, 3);
    renderer.dispose();
    return {
        name: 'geomuv-present',
        pixel: isRed(dispTop) ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `dispTop=${dispTop.join(',')} dispBottom=${dispBottom.join(',')} (top should be RED)`,
    };
}

/**
 * viewport-cell-present: the studio-grid shape. Render solid RED into the TOP-HALF cell of a shared RT
 * via viewport+scissor (a top-left rect) over a BLUE-cleared RT, then present the whole RT via screenUV.
 * The RED cell MUST land in the DISPLAYED TOP (viewport Y flipped to GL's bottom-left) with BLUE below.
 * If the viewport Y-flip regresses, RED lands at the bottom.
 */
async function caseViewportCellPresent(): Promise<CaseResult> {
    const renderer = await newRenderer();
    const rt = new RenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm', depthBuffer: true });
    // clear the whole RT to BLUE.
    renderer.clearColor = [0, 0, 1, 1];
    const saved = renderer.renderTarget;
    renderer.renderTarget = rt;
    renderer.render(new Scene(), new PerspectiveCamera());
    // draw solid RED into the top-half cell (top-left rect), without re-clearing the blue.
    rt.viewport = [0, 0, SIZE, SIZE / 2];
    rt.scissor = [0, 0, SIZE, SIZE / 2];
    rt.scissorTest = true;
    renderer.autoClear = false;
    const g = createFullscreenTriangleGeometry();
    const p = attribute('position', d.vec3f);
    const red = new Material({ vertex: vec4(p, f32(1)), fragment: vec4(1, 0, 0, 1), depthTest: false });
    const s = new Scene();
    s.add(new Mesh(g, red));
    const c = new PerspectiveCamera();
    s.updateWorldMatrix();
    c.updateViewMatrix();
    renderer.render(s, c);
    // restore full-target state + present via screenUV.
    rt.scissorTest = false;
    rt.viewport = null;
    rt.scissor = null;
    renderer.autoClear = true;
    renderer.renderTarget = saved;
    renderer.clearColor = [0, 0, 0, 1];
    const g2 = createFullscreenTriangleGeometry();
    const p2 = attribute('position', d.vec3f);
    const present = new Material({
        vertex: vec4(p2, f32(1)),
        fragment: texture(rt.texture! as Texture).sample(screenUV),
        depthTest: false,
    });
    const s2 = new Scene();
    s2.add(new Mesh(g2, present));
    const c2 = new PerspectiveCamera();
    s2.updateWorldMatrix();
    c2.updateViewMatrix();
    renderer.render(s2, c2);
    const gl = renderer.gl!;
    const dispTop = readAt(gl, CENTER, SIZE - 4);
    const dispBottom = readAt(gl, CENTER, 3);
    renderer.dispose();
    const isBlue = (col: number[]): boolean => col[2] > 200 && col[0] < 60 && col[1] < 60;
    const pass = isRed(dispTop) && isBlue(dispBottom);
    return {
        name: 'viewport-cell-present',
        pixel: pass ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `dispTop=${dispTop.join(',')} dispBottom=${dispBottom.join(',')} (top RED, bottom BLUE)`,
    };
}

export async function run(): Promise<RunResult> {
    try {
        const cases: CaseResult[] = [];
        const runners: Array<() => Promise<CaseResult>> = [
            caseScreenOrientDirect,
            caseScreenOrientPresent,
            caseFragCoordDirect,
            caseGeomUvPresent,
            caseViewportCellPresent,
            caseClear,
            caseSolid,
            caseUniform,
            caseLit,
            caseTextured,
            caseStorageAndTexture,
            caseInterleavedAttrs,
            caseRenderTargetFlip,
            caseRtLoadOrient,
            caseDepthLoadRead,
            caseIntegerTexture,
            caseStructTexture,
            caseStructTextureMat4,
            caseStructTexturePackedUnorm,
            caseStructTexturePackedHalf,
            caseStructTexturePackedSnorm,
            caseStructTextureBits,
            caseStructTextureGrow,
            caseStructTexturePartial,
            caseStorageStruct,
            caseStorageU32,
            caseStorageU32Odd,
            caseStorageVec2,
            caseStorageU32Struct,
            caseStorageMat4,
            caseStorageDynamic,
            caseStorageStore,
            caseStoragePad,
            caseStoragePadDynamic,
            caseRenderToTexture,
            caseReadbackOrientation,
            caseHeadlessOffscreen,
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
            caseBatchedDrawsGreen,
            caseBatchedDrawsRed,
            caseBatchedDrawsNonIndexed,
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
