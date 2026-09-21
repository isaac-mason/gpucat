import { createStorageBuffer, createVertexBuffer, GpuBuffer } from '../../src/core/gpu-buffer';
import {
    ArrayTexture,
    arrayTexture,
    attribute,
    bundle,
    CubeCamera,
    CubeTexture,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createBoxGeometry,
    createCubeRenderTarget,
    cubeTexture,
    DataTexture,
    d,
    depthTexture,
    drawScene,
    Fn,
    f32,
    fields,
    fullscreen,
    Geometry,
    globalId,
    i32,
    index,
    init,
    Material,
    Mesh,
    modelWorldMatrix,
    mrt,
    mul,
    PerspectiveCamera,
    renderTexture,
    type RenderTarget,
    read,
    renderOutput,
    createRenderTarget,
    Scene,
    screenCoordinate,
    screenUV,
    select,
    storage,
    struct,
    type Texture,
    texture,
    textureDimensions,
    Uniform,
    u32,
    uniform,
    varying,
    vec2f,
    vec2i,
    vec3,
    vec4,
    type WebGPUBackend,
    webgpu,
} from '../../src/index';
import { BlendMode } from '../../src/material/blend-mode';
import type { MaterialOptions } from '../../src/material/material';
import type { Renderer } from '../../src/renderer/core/renderer';
import { createStructTexture } from '../../src/texture/data-texture';
import { frame } from '../../src/renderer/core/frame';

export type CaseResult = {
    name: string;
    pixel: [number, number, number, number];
    expected: [number, number, number, number];
    note?: string;
};

const SIZE = 64;
const CENTER = SIZE / 2;

/** A triangle that covers the framebuffer, so the centre pixel is always the fragment under test. */
function fullscreenTriangle(): Geometry {
    const geometry = new Geometry();
    geometry.setBuffer('position', createVertexBuffer(d.vec3f, new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0])));
    return geometry;
}

const u8 = (v: number): number => Math.round(v * 255);

/** The centre texel of a tightly-packed, top-to-bottom RGBA8 readback. */
function centerPixel(pixels: Uint8Array): [number, number, number, number] {
    const i = (CENTER * SIZE + CENTER) * 4;
    return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
}

type Case = (gpu: Renderer<WebGPUBackend>) => Promise<CaseResult>;

/** clear: a pass with no draws leaves the target at its clear colour. */
async function caseClear(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });

    const f = frame(gpu);
    f.pass({ target, clear: [0.2, 0.4, 0.6, 1] }).end();
    f.submit();

    const pixel = centerPixel(await read(gpu, target));
    return { name: 'clear', pixel, expected: [u8(0.2), u8(0.4), u8(0.6), 255] };
}

/** solid: a fullscreen draw writes its fragment colour over the clear. */
async function caseSolid(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });

    const mesh = new Mesh(
        fullscreenTriangle(),
        new Material({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: vec4(1, 0, 0, 1),
            depthTest: false,
        }),
    );
    mesh.updateWorldMatrix();

    const f = frame(gpu);
    const pass = f.pass({ target, clear: [0, 0, 0, 1] });
    pass.draw(mesh);
    pass.end();
    f.submit();

    const pixel = centerPixel(await read(gpu, target));
    return { name: 'solid', pixel, expected: [255, 0, 0, 255] };
}

/** uniform: a uniform reaches the fragment stage through the UBO path. */
async function caseUniform(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });

    const tint = uniform(vec4(0, 1, 0, 1), 'tint');
    const mesh = new Mesh(
        fullscreenTriangle(),
        new Material({ vertex: vec4(attribute('position', d.vec3f), f32(1)), fragment: tint, depthTest: false }),
    );
    mesh.updateWorldMatrix();

    const f = frame(gpu);
    const pass = f.pass({ target, clear: [0, 0, 0, 1] });
    pass.draw(mesh);
    pass.end();
    f.submit();

    const pixel = centerPixel(await read(gpu, target));
    return { name: 'uniform', pixel, expected: [0, 255, 0, 255] };
}

/** scene: a camera-transformed box drawn through the scene walk, not by hand. */
async function caseScene(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });

    const position = attribute('position', d.vec3f);
    const worldPosition = mul(modelWorldMatrix, vec4(position, f32(1)));
    const clipPosition = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPosition));
    const vColor = varying(vec3(0, 0, 1), 'vColor');

    const mesh = new Mesh(createBoxGeometry(1, 1, 1), new Material({ vertex: clipPosition, fragment: vec4(vColor, f32(1)) }));

    const scene = new Scene();
    const camera = new PerspectiveCamera(Math.PI / 4, 1, 0.1, 100);
    camera.position[2] = 3;
    scene.add(camera);
    scene.add(mesh);
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    const f = frame(gpu);
    const pass = f.pass({ target, camera, clear: [0, 0, 0, 1] });
    drawScene(gpu, pass, scene, camera);
    pass.end();
    f.submit();

    const pixel = centerPixel(await read(gpu, target));
    return { name: 'scene', pixel, expected: [0, 0, 255, 255] };
}

/** two-passes: a render target sampled by a later pass in the same frame. */
async function caseTwoPasses(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const offscreen = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const out = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });

    const composite = fullscreen(vec4(1, 1, 0, 1));

    const f = frame(gpu);
    const first = f.pass({ target: offscreen, clear: [1, 0, 1, 1] });
    first.end();
    const second = f.pass({ target: out, clear: [0, 0, 0, 1] });
    second.draw(composite);
    second.end();
    f.submit();

    const pixel = centerPixel(await read(gpu, out));
    return { name: 'two-passes', pixel, expected: [255, 255, 0, 255], note: 'two targets, one frame, one submit' };
}

/** viewport-scissor: a pass rect confines the draw; the centre stays at the clear colour. */
async function caseScissor(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });

    const mesh = new Mesh(
        fullscreenTriangle(),
        new Material({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: vec4(1, 0, 0, 1),
            depthTest: false,
        }),
    );
    mesh.updateWorldMatrix();

    const f = frame(gpu);
    // A corner rect that excludes the centre, so a scissor that does not apply reads red.
    const pass = f.pass({ target, clear: [0, 0, 1, 1], scissor: { x: 0, y: 0, width: 8, height: 8 } });
    pass.draw(mesh);
    pass.end();
    f.submit();

    const pixel = centerPixel(await read(gpu, target));
    return { name: 'viewport-scissor', pixel, expected: [0, 0, 255, 255], note: 'centre is outside the scissor rect' };
}

/** mrt: a named output has to land on its own attachment, read back directly rather than resampled. */
async function caseMrt(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm', count: 2 });
    target.textures[0].name = 'output';
    target.textures[1].name = 'aux';

    const outputs = mrt({ output: vec4(1, 0, 0, 1), aux: vec4(0.2, 0.5, 0.9, 1) });
    const mesh = new Mesh(
        fullscreenTriangle(),
        new Material({ vertex: vec4(attribute('position', d.vec3f), f32(1)), fragment: outputs, depthTest: false }),
    );
    mesh.updateWorldMatrix();

    const f = frame(gpu);
    const pass = f.pass({ target, mrt: outputs, clear: [0, 0, 0, 1] });
    pass.draw(mesh);
    pass.end();
    f.submit();

    const pixel = centerPixel(await read(gpu, target, { attachment: 1 }));
    return { name: 'mrt', pixel, expected: [u8(0.2), u8(0.5), u8(0.9), 255], note: 'attachment 1, not 0' };
}

/** cube-layer: `PassDesc.layer` picks the face, so six passes on one frame fill six different faces. */
async function caseCubeLayer(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const target = createCubeRenderTarget(SIZE, { colorFormat: 'rgba8unorm' });

    const f = frame(gpu);
    // Face n clears to n/8 in red, so reading the wrong face reads the wrong red.
    for (let face = 0; face < 6; face++) f.pass({ target, layer: face, clear: [face / 8, 0, 0, 1] }).end();
    f.submit();

    const pixel = centerPixel(await read(gpu, target, { layer: 3 }));
    return { name: 'cube-layer', pixel, expected: [u8(3 / 8), 0, 0, 255], note: 'face 3 of 6, one frame' };
}

/** msaa: a multisampled target resolves into its single-sampled texture at pass end. */
async function caseMsaa(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm', samples: 4 });

    // A geometry EDGE through the read pixel. MSAA antialiases coverage, not shading, so a fullscreen
    // draw resolves to its own flat colour and cannot tell a resolve from no resolve at all.
    const halfCover = new Geometry();
    halfCover.setBuffer('position', createVertexBuffer(d.vec3f, new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0])));
    const mesh = new Mesh(
        halfCover,
        new Material({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: vec4(0, 1, 1, 1),
            depthTest: false,
        }),
    );
    mesh.updateWorldMatrix();

    const f = frame(gpu);
    const pass = f.pass({ target, clear: [0, 0, 0, 1] });
    pass.draw(mesh);
    pass.end();
    f.submit();

    const pixel = centerPixel(await read(gpu, target));
    const partial = pixel[1] > 40 && pixel[1] < 215;
    return {
        name: 'msaa',
        pixel: partial ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `edge pixel green=${pixel[1]}; a single-sampled target resolves to 0 or 255 there`,
    };
}

/**
 * bundle-replay: the same draws through `pass.execute(bundle)` must reach the device as they do
 * directly. This is the net for `PLAN-render-bundles.md` step 3, where WebGPU stops replaying the
 * records and records a real `GPURenderBundle` — the pixels are the only thing that proves the two
 * agree, so it is written before the change it guards.
 */
async function caseBundleReplay(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const vertex = vec4(attribute('position', d.vec3f), f32(1));
    const makeMesh = (rgb: [number, number, number]) => {
        const m = new Mesh(
            fullscreenTriangle(),
            new Material({ vertex, fragment: vec4(rgb[0], rgb[1], rgb[2], 1), depthTest: false }),
        );
        m.updateWorldMatrix();
        return m;
    };
    // Two overlapping fullscreen draws, so the visible pixel is the second one and order is observable.
    const first = makeMesh([1, 0, 0]);
    const second = makeMesh([0, 1, 0]);

    const directTarget = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const df = frame(gpu);
    const dpass = df.pass({ target: directTarget, clear: [0, 0, 1, 1] });
    dpass.draw(first);
    dpass.draw(second);
    dpass.end();
    df.submit();
    const direct = centerPixel(await read(gpu, directTarget));

    const encoder = bundle('replay');
    encoder.draw(first);
    encoder.draw(second);
    const pair = encoder.finish();

    const bundledTarget = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const bf = frame(gpu);
    const bpass = bf.pass({ target: bundledTarget, clear: [0, 0, 1, 1] });
    bpass.execute(pair);
    bpass.end();
    bf.submit();
    const bundled = centerPixel(await read(gpu, bundledTarget));

    const same = direct.every((v, i) => Math.abs(v - bundled[i]!) <= 3);
    return {
        name: 'bundle-replay',
        pixel: same ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `direct=${direct.join(',')} bundled=${bundled.join(',')}`,
    };
}

/** draw-material: `DrawOpts.material` replaces the mesh's own material for this one submission. */
async function caseDrawMaterial(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });

    const vertex = vec4(attribute('position', d.vec3f), f32(1));
    const mesh = new Mesh(fullscreenTriangle(), new Material({ vertex, fragment: vec4(1, 0, 0, 1), depthTest: false }));
    mesh.updateWorldMatrix();
    const override = new Material({ vertex, fragment: vec4(0, 1, 0, 1), depthTest: false });

    const f = frame(gpu);
    const pass = f.pass({ target, clear: [0, 0, 0, 1] });
    pass.draw(mesh, { material: override });
    pass.end();
    f.submit();

    const pixel = centerPixel(await read(gpu, target));
    return { name: 'draw-material', pixel, expected: [0, 255, 0, 255], note: "the mesh's own material is red" };
}

/** compute: a compute pass and a render pass on one frame, with the render reading what compute wrote. */
async function caseCompute(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });

    const values = createStorageBuffer(d.array(d.u32), new Uint32Array(4));
    const fill = Fn(() => {
        const out = storage('values', d.array(d.u32), 'read_write');
        index(out, globalId.x).assign(u32(255));
    }).compute({ workgroupSize: [4, 1, 1] });

    // Named in compute so `buffers` rebinds it; buffer-valued here, since a draw has no rebind hook.
    const read0 = index(storage(values, 'read'), u32(0)).toF32().div(f32(255));
    const mesh = new Mesh(
        fullscreenTriangle(),
        new Material({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: vec4(f32(0), read0, f32(0), f32(1)),
            depthTest: false,
        }),
    );
    mesh.updateWorldMatrix();

    const f = frame(gpu);
    const compute = f.compute({ label: 'fill' });
    compute.dispatch(fill, [1, 1, 1], { buffers: { values } });
    compute.end();
    const pass = f.pass({ target, clear: [0, 0, 0, 1] });
    pass.draw(mesh);
    pass.end();
    f.submit();

    const pixel = centerPixel(await read(gpu, target));
    return { name: 'compute', pixel, expected: [0, 255, 0, 255], note: 'compute then draw, one frame' };
}

/**
 * dispose-releases: the symmetry plan's parity job, on the backend that had no harness to run it.
 * Grow the resident counts with throwaway targets and geometries, drop them, and require `info.memory`
 * back at its baseline. Each target gets its own geometry: two sharing a GpuBuffer share one device
 * buffer, so reuse would leave the buffer count flat and prove nothing.
 */
async function caseDisposeReleases(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const vertex = vec4(attribute('position', d.vec3f), f32(1));
    const draw = (target: RenderTarget, geometry: Geometry) => {
        const mesh = new Mesh(geometry, new Material({ vertex, fragment: vec4(0, 1, 0, 1), depthTest: false }));
        mesh.updateWorldMatrix();
        const f = frame(gpu);
        const pass = f.pass({ target, clear: [0, 0, 0, 1] });
        pass.draw(mesh);
        pass.end();
        f.submit();
    };

    // One warm geometry, reused: a fresh one in the closing draw would allocate a buffer of its own
    // and the baseline could never be reached again.
    const warmTarget = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const warmGeometry = fullscreenTriangle();
    draw(warmTarget, warmGeometry);
    draw(warmTarget, warmGeometry);
    const base = { ...gpu.info.memory };

    const targets: RenderTarget[] = [];
    const geometries: Geometry[] = [];
    for (let i = 0; i < 3; i++) {
        const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
        const geometry = fullscreenTriangle();
        draw(target, geometry);
        targets.push(target);
        geometries.push(geometry);
    }
    const peak = { ...gpu.info.memory };

    for (const t of targets) t.dispose();
    for (const g of geometries) g.dispose();
    draw(warmTarget, warmGeometry);
    const after = { ...gpu.info.memory };

    const grew = peak.textures > base.textures && peak.buffers > base.buffers;
    const released = after.textures === base.textures && after.buffers === base.buffers;
    return {
        name: 'dispose-releases',
        pixel: grew && released ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `textures ${base.textures}->${peak.textures}->${after.textures}, buffers ${base.buffers}->${peak.buffers}->${after.buffers}`,
    };
}

/**
 * readback-orientation: `read()` promises rows top-to-bottom whichever backend produced them, and the
 * two native conventions disagree, so the neutral contract only holds if both are checked. Red above
 * clip-space y=0, green below; row 3 must be red and row SIZE-4 green.
 */
async function caseReadbackOrientation(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });

    const position = attribute('position', d.vec3f);
    const vy = varying(position.y, 'vy');
    const mesh = new Mesh(
        fullscreenTriangle(),
        new Material({
            vertex: vec4(position, f32(1)),
            fragment: select(vec4(0, 1, 0, 1), vec4(1, 0, 0, 1), vy.greaterThan(f32(0))),
            depthTest: false,
        }),
    );
    mesh.updateWorldMatrix();

    const f = frame(gpu);
    const pass = f.pass({ target, clear: [0, 0, 0, 1] });
    pass.draw(mesh);
    pass.end();
    f.submit();

    const px = await read(gpu, target);
    const at = (x: number, y: number): number[] => {
        const i = (y * SIZE + x) * 4;
        return [px[i], px[i + 1], px[i + 2], px[i + 3]];
    };
    const top = at(CENTER, 3);
    const bottom = at(CENTER, SIZE - 4);

    const isRed = (c: number[]) => c[0] > 200 && c[1] < 60;
    const isGreen = (c: number[]) => c[1] > 200 && c[0] < 60;
    return {
        name: 'readback-orientation',
        pixel: isRed(top) && isGreen(bottom) ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `row 3 = ${top.slice(0, 3)}, row ${SIZE - 4} = ${bottom.slice(0, 3)}`,
    };
}

/**
 * clear-depth: reversed-Z. The pass clears depth to 0 and the material tests 'greater', so a fragment
 * at 0.5 passes only because `PassDesc.clearDepth` reached the attachment. A hardcoded clear of 1.0
 * fails the test everywhere and the red clear colour shows through instead.
 */
async function caseClearDepth(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });

    const mesh = new Mesh(
        fullscreenTriangle(),
        new Material({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: vec4(0, 1, 0, 1),
            depth: f32(0.5),
            depthTest: true,
            depthCompare: 'greater',
        }),
    );
    mesh.updateWorldMatrix();

    const f = frame(gpu);
    const pass = f.pass({ target, camera: new PerspectiveCamera(), clear: [1, 0, 0, 1], clearDepth: 0 });
    pass.draw(mesh);
    pass.end();
    f.submit();

    const pixel = centerPixel(await read(gpu, target));
    return { name: 'clear-depth', pixel, expected: [0, 255, 0, 255], note: 'red means the depth clear did not land' };
}

/**
 * clear-depth-only: two passes to one target. The first writes GREEN at depth 0.5; the second keeps
 * the colour (`clear: false`) but clears depth to 0 and draws BLUE at 0.5 with a 'greater' compare.
 * Blue wins only if depth cleared while colour loaded. Depth borrowing colour's load op reads green.
 */
async function caseClearDepthOnly(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const vertex = vec4(attribute('position', d.vec3f), f32(1));
    const at = (r: number, g: number, b: number) => {
        const mesh = new Mesh(
            fullscreenTriangle(),
            new Material({ vertex, fragment: vec4(r, g, b, 1), depth: f32(0.5), depthTest: true, depthCompare: 'greater' }),
        );
        mesh.updateWorldMatrix();
        return mesh;
    };

    const camera = new PerspectiveCamera();
    const f = frame(gpu);

    const first = f.pass({ target, camera, clear: [0, 0, 0, 1], clearDepth: 0, label: 'write-depth' });
    first.draw(at(0, 1, 0));
    first.end();

    const second = f.pass({ target, camera, clear: false, clearDepth: 0, label: 'clear-depth-only' });
    second.draw(at(0, 0, 1));
    second.end();

    f.submit();

    const pixel = centerPixel(await read(gpu, target));
    return { name: 'clear-depth-only', pixel, expected: [0, 0, 255, 255], note: 'green means depth followed colour' };
}

/**
 * rtt: one frame writes a colour into a target, a later pass in that same frame samples it. Proves the
 * binding sees the texture the earlier pass wrote rather than a stale or unallocated view.
 */
async function caseRtt(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const offscreen = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const out = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const rtColor: [number, number, number, number] = [0.3, 0.8, 0.5, 1];

    const sampler = new Mesh(
        fullscreenTriangle(),
        new Material({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: texture(offscreen.texture as Texture).sample(screenUV),
            depthTest: false,
        }),
    );
    sampler.updateWorldMatrix();

    const f = frame(gpu);
    f.pass({ target: offscreen, clear: rtColor }).end();
    const composite = f.pass({ target: out, clear: [0, 0, 0, 1] });
    composite.draw(sampler);
    composite.end();
    f.submit();

    const pixel = centerPixel(await read(gpu, out));
    return {
        name: 'rtt',
        pixel,
        expected: [u8(rtColor[0]), u8(rtColor[1]), u8(rtColor[2]), 255],
        note: 'written and sampled in one frame',
    };
}

/**
 * pass-node: a `RenderTextureNode` in the graph opens its own pass from inside the outer pass's prepare, which
 * is the one ordering this whole design turns on. The composite samples what the nested pass drew, so
 * a nested pass that ran late, ran twice or never ran reads the outer clear instead.
 */
async function casePassNode(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });

    const scene = new Scene();
    const camera = new PerspectiveCamera(Math.PI / 4, 1, 0.1, 100);
    camera.position[2] = 3;
    scene.add(camera);
    const inner = new Mesh(
        fullscreenTriangle(),
        new Material({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: vec4(1, 0, 1, 1),
            depthTest: false,
        }),
    );
    inner.updateWorldMatrix();
    scene.add(inner);
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    const scenePass = renderTexture(scene, camera, { clearColor: [0, 0, 0, 1] });
    const composite = fullscreen(renderOutput(scenePass.getTextureNode()));

    const f = frame(gpu);
    const outer = f.pass({ target, clear: [0, 1, 0, 1] });
    outer.draw(composite);
    outer.end();
    f.submit();

    const px = centerPixel(await read(gpu, target));
    // renderOutput tone-maps and encodes, so compare the hue rather than an exact magenta.
    const magenta = px[0] > 200 && px[1] < 60 && px[2] > 200;
    return {
        name: 'pass-node',
        pixel: magenta ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `nested pass drew ${px.slice(0, 3)}; the outer clear is green`,
    };
}

/** Read one texel of a tightly-packed, top-to-bottom RGBA8 readback. */
function pixelAt(pixels: Uint8Array, x: number, y: number): [number, number, number, number] {
    const i = (y * SIZE + x) * 4;
    return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
}

/**
 * buffer-swap: replacing a geometry's named buffer has to reach whatever the backend baked the old one
 * into. Draw a triangle covering the LEFT half, swap `position` for one covering the RIGHT, draw
 * again; the right half is green only if the swap was followed.
 */
async function caseBufferSwap(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });

    const left = new Float32Array([-1, -1, 0, 0, -1, 0, -1, 1, 0]);
    const right = new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0]);

    const geometry = new Geometry();
    geometry.setBuffer('position', createVertexBuffer(d.vec3f, left));
    const mesh = new Mesh(
        geometry,
        new Material({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: vec4(0, 1, 0, 1),
            depthTest: false,
        }),
    );
    mesh.updateWorldMatrix();

    const camera = new PerspectiveCamera();
    const draw = () => {
        const f = frame(gpu);
        const pass = f.pass({ target, camera, clear: [0, 0, 0, 1] });
        pass.draw(mesh);
        pass.end();
        f.submit();
    };

    draw();
    geometry.setBuffer('position', createVertexBuffer(d.vec3f, right));
    draw();

    const pixel = pixelAt(await read(gpu, target), SIZE - 4, CENTER);
    return { name: 'buffer-swap', pixel, expected: [0, 255, 0, 255], note: 'right half after the swap' };
}

/**
 * mrt-blend: per-attachment blend, which the WebGL2 backend rejects outright and WebGPU has never had
 * pixel coverage for. Both attachments clear to 0.25 red and receive 0.25 red; `colA` replaces and
 * stays 0.25, `colB` is additive and reaches 0.5. One blend mode leaking across both reads them equal.
 */
async function caseMrtBlend(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm', count: 2 });
    target.textures[0].name = 'colA';
    target.textures[1].name = 'colB';

    const outputs = mrt({ colA: vec4(0.25, 0, 0, 1), colB: vec4(0.25, 0, 0, 1) });
    outputs.setBlendMode('colB', new BlendMode('additive'));

    const mesh = new Mesh(
        fullscreenTriangle(),
        new Material({ vertex: vec4(attribute('position', d.vec3f), f32(1)), fragment: outputs, depthTest: false }),
    );
    mesh.updateWorldMatrix();

    const f = frame(gpu);
    const pass = f.pass({ target, mrt: outputs, clear: [0.25, 0, 0, 1] });
    pass.draw(mesh);
    pass.end();
    f.submit();

    const replaced = centerPixel(await read(gpu, target, { attachment: 0 }))[0];
    const added = centerPixel(await read(gpu, target, { attachment: 1 }))[0];

    const ok = Math.abs(replaced - u8(0.25)) <= 3 && Math.abs(added - u8(0.5)) <= 3;
    return {
        name: 'mrt-blend',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `colA ${replaced} (want ${u8(0.25)}), colB ${added} (want ${u8(0.5)})`,
    };
}

/**
 * pass-depth-sample: a pass's depth attachment sampled by a later pass through
 * `getDepthTextureNode().load()`, which is how overlay occlusion reads it. The scene writes 0.2 up top
 * and 0.8 below, so the composite must read the top darker than the bottom, and neither may be zero.
 * The composite also references the pass colour times zero: a pass only renders when its output is
 * referenced, so sampling depth alone would leave the target at its 1x1 init size.
 */
async function casePassDepthSample(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });

    const scene = new Scene();
    const camera = new PerspectiveCamera();
    scene.add(camera);
    const position = attribute('position', d.vec3f);
    const vy = varying(position.y, 'vyPassDepth');
    scene.add(
        new Mesh(
            fullscreenTriangle(),
            new Material({
                vertex: vec4(position, f32(1)),
                fragment: vec4(f32(0), f32(0), f32(0), f32(1)),
                depth: select(f32(0.8), f32(0.2), vy.greaterThan(f32(0))),
            }),
        ),
    );
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    const scenePass = renderTexture(scene, camera);
    const sceneDepth = scenePass.getDepthTextureNode();
    const texel = vec2i(mul(screenUV, vec2f(textureDimensions(sceneDepth.bindingNode))));
    const z = sceneDepth.load(texel);
    const composite = fullscreen(renderOutput(vec4(z, z, z, f32(1)).add(scenePass.getTextureNode().mul(f32(0)))));

    const f = frame(gpu);
    const compositePass = f.pass({ target, clear: [1, 0, 1, 1] });
    compositePass.draw(composite);
    compositePass.end();
    f.submit();

    const px = await read(gpu, target);
    // Row 3 is the image top, which the scene wrote at depth 0.2, so it reads DARKER than the bottom.
    const nearRow = pixelAt(px, CENTER, 3)[0];
    const farRow = pixelAt(px, CENTER, SIZE - 4)[0];

    const ok = farRow > nearRow && farRow > 150 && nearRow > 30 && nearRow < 200;
    return {
        name: 'pass-depth-sample',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `depth 0.2 row ${nearRow}, depth 0.8 row ${farRow}; a zero is the occlusion-mask bug`,
    };
}

/**
 * draw-opts: `DrawOpts.range` per submission, which is what lets one geometry serve two draws. Six
 * vertices cover the left half and six the right; green takes the first range, red the second, so the
 * left reads green only if each draw honoured its own range rather than drawing the whole buffer.
 */
async function caseDrawOpts(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });

    const geometry = new Geometry();
    geometry.setBuffer(
        'position',
        createVertexBuffer(
            d.vec3f,
            new Float32Array([
                -1, -1, 0, 0, -1, 0, -1, 1, 0, 0, -1, 0, 0, 1, 0, -1, 1, 0, 0, -1, 0, 1, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0, 0, 1,
                0,
            ]),
        ),
    );

    const vertex = vec4(attribute('position', d.vec3f), f32(1));
    const at = (r: number, g: number, b: number) => {
        const mesh = new Mesh(geometry, new Material({ vertex, fragment: vec4(r, g, b, 1), depthTest: false }));
        mesh.updateWorldMatrix();
        return mesh;
    };

    const f = frame(gpu);
    const pass = f.pass({ target, camera: new PerspectiveCamera(), clear: [0, 0, 0, 1] });
    pass.draw(at(0, 1, 0), { range: { start: 0, count: 6 } });
    pass.draw(at(1, 0, 0), { range: { start: 6, count: 6 } });
    pass.end();
    f.submit();

    const pixel = pixelAt(await read(gpu, target), 4, CENTER);
    return { name: 'draw-opts', pixel, expected: [0, 255, 0, 255], note: 'left half, drawn from range 0..6' };
}

/**
 * dispose-in-flight: a room swap disposes a target while a frame that recorded a pass into it has not
 * submitted. The plan calls this a live hazard; this asks the device. A destroyed texture reaching a
 * submit is a validation error, so the frame either has to survive it or say so, not corrupt silently.
 */
async function caseDisposeInFlight(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const doomed = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const survivor = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });

    const f = frame(gpu);
    f.pass({ target: doomed, clear: [1, 0, 0, 1] }).end();

    let threw = '';
    try {
        doomed.dispose();
        f.pass({ target: survivor, clear: [0, 1, 0, 1] }).end();
        f.submit();
    } catch (e) {
        threw = String(e);
    }

    // Whatever happened to the doomed target, the next frame has to still work.
    const after = frame(gpu);
    after.pass({ target: survivor, clear: [0, 0, 1, 1] }).end();
    after.submit();
    const pixel = centerPixel(await read(gpu, survivor));

    const recovered = pixel[2] > 200 && pixel[0] < 60;
    return {
        name: 'dispose-in-flight',
        pixel: recovered ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: threw ? `submit threw: ${threw.slice(0, 60)}` : `survivor reads ${pixel.slice(0, 3)} after the swap`,
    };
}

/** Draw one fragment node fullscreen and report what the shader saw. */
async function readsBack(
    gpu: Renderer<WebGPUBackend>,
    fragment: MaterialOptions['fragment'],
    name: string,
    expected: [number, number, number, number],
    note: string,
): Promise<CaseResult> {
    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const mesh = new Mesh(
        fullscreenTriangle(),
        new Material({ vertex: vec4(attribute('position', d.vec3f), f32(1)), fragment, depthTest: false }),
    );
    mesh.updateWorldMatrix();

    const f = frame(gpu);
    const pass = f.pass({ target, camera: new PerspectiveCamera(), clear: [0, 0, 0, 1] });
    pass.draw(mesh);
    pass.end();
    f.submit();

    return { name, pixel: centerPixel(await read(gpu, target)), expected, note };
}

/**
 * storage-mat4: `array<mat4x4f>` has a 64-byte stride and each column is 16, so reading element 1's
 * column 3 lands at float 28. A stride the emitter and the packer disagree on reads a neighbour.
 */
async function caseStorageMat4(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const N = 2;
    const data = new Float32Array(N * 16);
    const [R, G, B] = [0.3, 0.7, 0.5];
    data.set([R, G, B, 1], 1 * 16 + 12);

    const buffer = createStorageBuffer(d.array(d.mat4x4f), data);
    return readsBack(
        gpu,
        storage(buffer).element(u32(1)).element(u32(3)),
        'storage-mat4',
        [u8(R), u8(G), u8(B), 255],
        'element 1, column 3, at a 64-byte stride',
    );
}

/**
 * storage-mixed-align: `{ scale: f32, tint: vec3f }` is the layout that bites, because WGSL aligns
 * `vec3f` to 16 and pads `scale` out to it. A packer writing them back to back puts `tint` where the
 * shader expects padding, and the read comes back as whatever followed.
 */
async function caseStorageMixedAlign(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const Mixed = struct('Mixed', { scale: d.f32, tint: d.vec3f });
    const buffer = createStorageBuffer(d.array(Mixed), new Float32Array(8));
    buffer.packAtIndex(Mixed, 0, { scale: 1, tint: [0.25, 0.5, 0.75] });

    const fields = storage(buffer).element(u32(0)).fields();
    return readsBack(
        gpu,
        vec4(fields.tint.mul(fields.scale), f32(1)),
        'storage-mixed-align',
        [u8(0.25), u8(0.5), u8(0.75), 255],
        'f32 then vec3f, which WGSL pads to 16',
    );
}

/**
 * uniform-struct-align: the layout that produced a black sky once. `{ enabled: u32, tint: vec3f }` is
 * lib's `EnvConfig` shape, and WGSL aligns `vec3f` to 16, so `enabled` is padded out to it. A UBO
 * packer writing the two back to back puts `tint` where the shader expects padding. Its offsets are
 * checked by compiling WGSL elsewhere; this checks the bytes actually arrive there.
 */
async function caseUniformStructAlign(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const EnvConfig = struct('EnvConfig', { enabled: d.u32, tint: d.vec3f });
    const config = uniform(new Uniform(EnvConfig, { enabled: 1, tint: [0.25, 0.5, 0.75] }));
    const env = fields(config);

    return readsBack(
        gpu,
        vec4(env.tint.mul(env.enabled.toF32()), f32(1)),
        'uniform-struct-align',
        [u8(0.25), u8(0.5), u8(0.75), 255],
        'u32 then vec3f; a black read is the padding bug',
    );
}

/**
 * struct-texture-unorm8x4: a packed field is four bytes in one u32, and component 0 is the low bits.
 * The WebGL emitter emulates `unpack4x8unorm` with shift and mask, so its case proves the emulation;
 * this proves the CPU packer agrees with WGSL's builtin, where the order being backwards would swap
 * red and alpha and nothing would complain.
 */
async function caseStructTexturePackedUnorm(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const Rec = struct('STPackU8', { col: d.unorm8x4 });
    const tex = createStructTexture(Rec, 1);
    tex.packAtIndex(Rec, 0, { col: [64 / 255, 128 / 255, 192 / 255, 1] });

    const rec = texture(tex).load(Rec, u32(0));
    return readsBack(
        gpu,
        vec4(rec.col.x, rec.col.y, rec.col.z, rec.col.w),
        'struct-texture-unorm8x4',
        [64, 128, 192, 255],
        'component 0 is the low bits',
    );
}

async function caseStructTexturePackedSnorm(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const Rec = struct('STPackS8', { s: d.snorm8x4 });
    const tex = createStructTexture(Rec, 1);
    tex.packAtIndex(Rec, 0, { s: [1, 0, -1, 0.5] });

    const rec = texture(tex).load(Rec, u32(0));
    return readsBack(
        gpu,
        vec4(
            rec.s.x.mul(f32(0.5)).add(f32(0.5)),
            rec.s.y.mul(f32(0.5)).add(f32(0.5)),
            rec.s.z.mul(f32(0.5)).add(f32(0.5)),
            f32(1),
        ),
        'struct-texture-snorm8x4',
        [255, u8(0.5), 0, 255],
        'sign-extend, not mask: an unsigned read of -1 gives +1 and a plausible colour',
    );
}

async function caseStructTexturePackedHalf(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const Rec = struct('STPackH', { hv: d.half2x16, uv: d.unorm2x16 });
    const tex = createStructTexture(Rec, 1);
    tex.packAtIndex(Rec, 0, { hv: [0.5, 0.25], uv: [0.5, 0.75] });

    const rec = texture(tex).load(Rec, u32(0));
    return readsBack(
        gpu,
        vec4(rec.hv.x, rec.hv.y, rec.uv.x, f32(1)),
        'struct-texture-half2x16',
        [u8(0.5), u8(0.25), u8(0.5), 255],
        'two pairs in one texel; swapping the halves is silent, and fp16-exact values rule out rounding',
    );
}

async function caseStructTextureMat4(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const M = struct('STMat', { m: d.mat4x4f });
    const tex = createStructTexture(M, 1);
    tex.packAtIndex(M, 0, { m: [0.25, 0.5, 0.75, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });

    const col0 = mul(texture(tex).load(M, u32(0)).m, vec4(f32(1), f32(0), f32(0), f32(0)));
    return readsBack(
        gpu,
        vec4(col0.x, col0.y, col0.z, f32(1)),
        'struct-texture-mat4',
        [u8(0.25), u8(0.5), u8(0.75), 255],
        'column-major across four texels; reading them as rows stays in range',
    );
}

async function caseStructTextureBits(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const Rec = struct('STBits', { bf: d.bits({ a: 8, b: 8, c: 8 }) });
    const tex = createStructTexture(Rec, 1);
    tex.packAtIndex(Rec, 0, { bf: { a: 64, b: 128, c: 192 } } as never);

    const bf = texture(tex).load(Rec, u32(0)).bf;
    return readsBack(
        gpu,
        vec4(f32(bf.a).div(f32(255)), f32(bf.b).div(f32(255)), f32(bf.c).div(f32(255)), f32(1)),
        'struct-texture-bits',
        [64, 128, 192, 255],
        'shift and mask on both backends, so the one decode here with no builtin to agree on',
    );
}

async function caseClearSelective(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm', depthBuffer: true });
    const camera = new PerspectiveCamera();
    const red = new Mesh(
        fullscreenTriangle(),
        new Material({ vertex: vec4(attribute('position', d.vec3f), f32(1)), fragment: vec4(1, 0, 0, 1), depthTest: false }),
    );
    red.updateWorldMatrix();

    const drawn = frame(gpu);
    const draw = drawn.pass({ target, camera, clear: [0, 0, 1, 1] });
    draw.draw(red);
    draw.end();
    drawn.submit();

    const depthOnly = frame(gpu);
    depthOnly.pass({ target, clear: false, clearDepth: 1, label: 'clear-depth-only' }).end();
    depthOnly.submit();
    const preserved = centerPixel(await read(gpu, target));

    const colourToo = frame(gpu);
    colourToo.pass({ target, clear: [0, 0, 1, 1], clearDepth: 1, label: 'clear-colour' }).end();
    colourToo.submit();
    const cleared = centerPixel(await read(gpu, target));

    const ok = preserved[0] > 200 && preserved[2] < 60 && cleared[2] > 200 && cleared[0] < 60;
    return {
        name: 'clear-selective',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `depth-only clear left ${preserved.slice(0, 3)}, colour clear left ${cleared.slice(0, 3)}; skipping both looks identical without the second`,
    };
}

async function caseDepthLoadRead(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const depthOnly = createRenderTarget(SIZE, SIZE, { count: 0, depthFormat: 'depth32float', depthSampled: true });
    const position = attribute('position', d.vec3f);
    const clipY = varying(position.y, 'vyDepthRead');
    const writeDepth = new Mesh(
        fullscreenTriangle(),
        new Material({
            vertex: vec4(position, f32(1)),
            fragment: undefined,
            depth: select(f32(0.8), f32(0.2), clipY.greaterThan(f32(0))),
        }),
    );
    writeDepth.updateWorldMatrix();

    const camera = new PerspectiveCamera();
    const written = frame(gpu);
    const writePass = written.pass({ target: depthOnly, camera, clearDepth: 1 });
    writePass.draw(writeDepth);
    writePass.end();
    written.submit();

    const shown = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const depthNode = depthTexture(depthOnly.depthTexture!);
    const sceneZ = depthNode.load(vec2i(mul(screenUV, vec2f(textureDimensions(depthNode.bindingNode)))));
    const showDepth = new Mesh(
        fullscreenTriangle(),
        new Material({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: vec4(sceneZ, sceneZ, sceneZ, f32(1)),
            depthTest: false,
        }),
    );
    showDepth.updateWorldMatrix();

    const display = frame(gpu);
    const showPass = display.pass({ target: shown, camera, clear: [0, 0, 0, 1] });
    showPass.draw(showDepth);
    showPass.end();
    display.submit();

    const pixels = await read(gpu, shown);
    const top = pixelAt(pixels, CENTER, 3);
    const bottom = pixelAt(pixels, CENTER, SIZE - 4);
    const ok = bottom[0] > top[0] && bottom[0] > 100 && top[0] < 128;
    return {
        name: 'depth-load-read',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `top=${top[0]} bottom=${bottom[0]}; want top near (~51) and bottom far (~204), both 0 means the depth read returned nothing`,
    };
}

async function caseDepthBias(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm', depthBuffer: true });
    const position = attribute('position', d.vec3f);
    const coplanar = (fragment: ReturnType<typeof vec4>, depthBias: number) => {
        const mesh = new Mesh(
            fullscreenTriangle(),
            // 'less', not 'less-equal': coplanar green must be MOVED to win, so an ignored bias reads red.
            // Interpolated z, never a `depth:` override: a shader-written frag_depth replaces the
            // biased value outright, so the bias would be untestable.
            new Material({
                vertex: vec4(position.x, position.y, f32(0.5), f32(1)),
                fragment,
                depthWrite: true,
                depthCompare: 'less',
                depthBias,
                depthBiasSlopeScale: 0,
            }),
        );
        mesh.updateWorldMatrix();
        return mesh;
    };

    const f = frame(gpu);
    const pass = f.pass({ target, camera: new PerspectiveCamera(), clear: [0, 0, 0, 1], clearDepth: 1 });
    pass.draw(coplanar(vec4(1, 0, 0, 1), 0));
    pass.draw(coplanar(vec4(0, 1, 0, 1), -2));
    pass.end();
    f.submit();

    const pixel = centerPixel(await read(gpu, target));
    return { name: 'depth-bias', pixel, expected: [0, 255, 0, 255], note: 'red means the bias never moved the coplanar quad' };
}

async function casePassOcclude(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const scene = new Scene();
    const sceneCamera = new PerspectiveCamera();
    scene.add(sceneCamera);
    const scenePosition = attribute('position', d.vec3f);
    const sceneClipY = varying(scenePosition.y, 'occSvy');
    scene.add(
        new Mesh(
            fullscreenTriangle(),
            new Material({
                vertex: vec4(scenePosition, f32(1)),
                fragment: vec4(f32(1), f32(0), f32(0), f32(1)),
                depth: select(f32(1.0), f32(0.3), sceneClipY.greaterThan(f32(0))),
                depthTest: false,
            }),
        ),
    );
    scene.updateWorldMatrix();
    sceneCamera.updateViewMatrix();

    const scenePass = renderTexture(scene, sceneCamera);
    const sceneColor = scenePass.getTextureNode();
    const sceneDepth = scenePass.getDepthTextureNode();

    const overlay = new Scene();
    const overlayCamera = new PerspectiveCamera();
    overlay.add(overlayCamera);
    const sceneZ = sceneDepth.load(vec2i(mul(screenUV, vec2f(textureDimensions(sceneDepth.bindingNode)))));
    const visible = select(f32(1), f32(0), f32(0.5).greaterThan(sceneZ));
    overlay.add(
        new Mesh(
            fullscreenTriangle(),
            new Material({
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment: vec4(f32(0), visible, f32(0), visible),
                depthTest: false,
            }),
        ),
    );
    overlay.updateWorldMatrix();
    overlayCamera.updateViewMatrix();

    const overlayColor = renderTexture(overlay, overlayCamera).getTextureNode();
    const composited = sceneColor.rgb.mul(f32(1).sub(overlayColor.a)).add(overlayColor.rgb);

    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const f = frame(gpu);
    const compositePass = f.pass({ target, clear: [1, 0, 1, 1] });
    compositePass.draw(fullscreen(renderOutput(vec4(composited, f32(1)))));
    compositePass.end();
    f.submit();

    const pixels = await read(gpu, target);
    const top = pixelAt(pixels, CENTER, 3);
    const bottom = pixelAt(pixels, CENTER, SIZE - 4);
    const ok = top[0] > 128 && top[1] < 128 && bottom[1] > 128 && bottom[0] < 128;
    return {
        name: 'pass-occlude',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `top(r,g)=[${top[0]},${top[1]}] bottom(r,g)=[${bottom[0]},${bottom[1]}]; want top red (the scene at 0.3 occludes) and bottom green`,
    };
}

async function caseTwoPassNodes(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const solidPass = (r: number, g: number, b: number) => {
        const scene = new Scene();
        const camera = new PerspectiveCamera();
        scene.add(camera);
        scene.add(
            new Mesh(
                fullscreenTriangle(),
                new Material({
                    vertex: vec4(attribute('position', d.vec3f), f32(1)),
                    fragment: vec4(r, g, b, 1),
                    depthTest: false,
                }),
            ),
        );
        scene.updateWorldMatrix();
        camera.updateViewMatrix();
        return renderTexture(scene, camera).getTextureNode();
    };

    const red = solidPass(1, 0, 0);
    const blue = solidPass(0, 0, 1);

    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const f = frame(gpu);
    const compositePass = f.pass({ target, clear: [0, 1, 0, 1] });
    compositePass.draw(fullscreen(renderOutput(vec4(red.r, f32(0), blue.b, f32(1)))));
    compositePass.end();
    f.submit();

    const pixel = centerPixel(await read(gpu, target));
    const ok = pixel[0] > 200 && pixel[2] > 200;
    return {
        name: 'two-pass-nodes',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `composite read r=${pixel[0]} from the first pass and b=${pixel[2]} from the second; a zero is that pass unread`,
    };
}

async function casePassColourAndDepth(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    scene.add(camera);
    scene.add(
        new Mesh(
            fullscreenTriangle(),
            new Material({
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment: vec4(f32(1), f32(0), f32(0), f32(1)),
                depth: f32(0.4),
            }),
        ),
    );
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    const scenePass = renderTexture(scene, camera);
    const sceneColor = scenePass.getTextureNode();
    const sceneDepth = scenePass.getDepthTextureNode();
    const z = sceneDepth.load(vec2i(mul(screenUV, vec2f(textureDimensions(sceneDepth.bindingNode)))));

    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const f = frame(gpu);
    const compositePass = f.pass({ target, clear: [0, 1, 0, 1] });
    compositePass.draw(fullscreen(renderOutput(vec4(sceneColor.r, f32(0), z, f32(1)))));
    compositePass.end();
    f.submit();

    const pixel = centerPixel(await read(gpu, target));
    const ok = pixel[0] > 200 && pixel[2] > 30;
    return {
        name: 'pass-colour-and-depth',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `colour r=${pixel[0]} depth b=${pixel[2]}; sampling the depth must not cost the colour`,
    };
}

async function caseChainedPassNodes(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const first = new Scene();
    const firstCamera = new PerspectiveCamera();
    first.add(firstCamera);
    first.add(
        new Mesh(
            fullscreenTriangle(),
            new Material({
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment: vec4(f32(1), f32(0), f32(0), f32(1)),
                depthTest: false,
            }),
        ),
    );
    first.updateWorldMatrix();
    firstCamera.updateViewMatrix();
    const firstColor = renderTexture(first, firstCamera).getTextureNode();

    const second = new Scene();
    const secondCamera = new PerspectiveCamera();
    second.add(secondCamera);
    second.add(
        new Mesh(
            fullscreenTriangle(),
            new Material({
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment: vec4(
                    f32(0),
                    firstColor.load(vec2i(mul(screenUV, vec2f(textureDimensions(firstColor.bindingNode))))).r,
                    f32(0),
                    f32(1),
                ),
                depthTest: false,
            }),
        ),
    );
    second.updateWorldMatrix();
    secondCamera.updateViewMatrix();
    const secondColor = renderTexture(second, secondCamera).getTextureNode();

    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const f = frame(gpu);
    const compositePass = f.pass({ target, clear: [0, 0, 1, 1] });
    compositePass.draw(fullscreen(renderOutput(vec4(firstColor.r, secondColor.g, f32(0), f32(1)))));
    compositePass.end();
    f.submit();

    const pixel = centerPixel(await read(gpu, target));
    const ok = pixel[0] > 200 && pixel[1] > 200;
    return {
        name: 'chained-pass-nodes',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `first r=${pixel[0]}, second g=${pixel[1]}; the second pass samples the first, on a scene geometry that declares no uv`,
    };
}

async function casePassAsValue(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    scene.add(camera);
    scene.add(
        new Mesh(
            fullscreenTriangle(),
            new Material({
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment: vec4(f32(0), f32(1), f32(0), f32(1)),
                depthTest: false,
            }),
        ),
    );
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const f = frame(gpu);
    const compositePass = f.pass({ target, clear: [1, 0, 0, 1] });
    // The RenderTextureNode itself as the value, not `.getTextureNode()`: two examples composite this way.
    compositePass.draw(fullscreen(renderOutput(renderTexture(scene, camera))));
    compositePass.end();
    f.submit();

    const pixel = centerPixel(await read(gpu, target));
    const ok = pixel[1] > 200 && pixel[0] < 60;
    return {
        name: 'pass-as-value',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `composite read [${pixel.slice(0, 3)}]; red is the clear, so the pass never reached the output`,
    };
}

async function caseCubeMips(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const cube = createCubeRenderTarget(SIZE, { colorFormat: 'rgba8unorm', depthBuffer: true, generateMipmaps: true });

    // Each face is half red, half black. One flat colour per face cannot test mips at all: every level
    // is then identical, so the case passes with the chain ungenerated.
    const position = attribute('position', d.vec3f);
    const clipY = varying(position.y, 'vyCubeMips');
    const twoTone = new Mesh(
        fullscreenTriangle(),
        new Material({
            vertex: vec4(position, f32(1)),
            fragment: select(vec4(0, 0, 0, 1), vec4(1, 0, 0, 1), clipY.greaterThan(f32(0))),
            depthTest: false,
        }),
    );
    twoTone.updateWorldMatrix();

    // One frame for all six faces: mips are flushed once at submit, so WebGL's per-face flag dance
    // has no counterpart here.
    const faces = frame(gpu);
    for (let face = 0; face < 6; face++) {
        const facePass = faces.pass({ target: cube, layer: face, camera: new PerspectiveCamera(), clear: [0, 0, 0, 1] });
        facePass.draw(twoTone);
        facePass.end();
    }
    faces.submit();

    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const sampled = new Mesh(
        fullscreenTriangle(),
        new Material({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            // A direction into the face's RED half, at the 1x1 level where the whole face has averaged to
            // half red. Aimed at the centre it would read the two-tone boundary and be 128 either way.
            fragment: cubeTexture(cube.texture).level(f32(6)).sample(vec3(0, 0.6, 1)),
            depthTest: false,
        }),
    );
    sampled.updateWorldMatrix();

    const f = frame(gpu);
    const pass = f.pass({ target, camera: new PerspectiveCamera(), clear: [0, 0, 0, 1] });
    pass.draw(sampled);
    pass.end();
    f.submit();

    const pixel = centerPixel(await read(gpu, target));
    const ok = pixel[0] > 90 && pixel[0] < 165;
    return {
        name: 'cube-mips',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `level 6 red=${pixel[0]}, wants a mid blend; an ungenerated chain clamps to level 0 and reads 0 or 255`,
    };
}

async function caseInterleavedAttrs(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const Vtx = struct('InterleavedVtx', { a: d.vec4f, b: d.vec4f });
    const [U, V] = [0.6, 0.8];
    // biome-ignore format: vertex rows
    const data = new Float32Array([
        -1, -1, 0, U,   0, 0, 0, V,
         3, -1, 0, U,   0, 0, 0, V,
        -1,  3, 0, U,   0, 0, 0, V,
    ]);
    const geometry = new Geometry();
    geometry.setBuffer('vertex', new GpuBuffer(Vtx, { data, usage: 'vertex' }));

    const first = attribute('vertex', d.vec4f, { stride: 32, offset: 0 });
    const second = attribute('vertex', d.vec4f, { stride: 32, offset: 16 });
    const mesh = new Mesh(
        geometry,
        new Material({
            vertex: vec4(first.xyz, f32(1)),
            fragment: varying(vec4(first.w, second.w, f32(0), f32(1)), 'vColor'),
            depthTest: false,
        }),
    );
    mesh.updateWorldMatrix();

    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const f = frame(gpu);
    const pass = f.pass({ target, camera: new PerspectiveCamera(), clear: [0, 0, 0, 1] });
    pass.draw(mesh);
    pass.end();
    f.submit();

    return {
        name: 'interleaved-attrs',
        pixel: centerPixel(await read(gpu, target)),
        expected: [u8(U), u8(V), 0, 255],
        note: 'two attributes, one buffer, offsets 0 and 16; green collapsing to red is the second read at the first offset',
    };
}

async function caseInstanced(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const second: [number, number, number] = [0.2, 0.8, 0.4];
    const instanceColors = new Float32Array([0.9, 0.1, 0.1, ...second]);
    const instanceColor = attribute(instanceColors, d.vec3f, { stride: 12, offset: 0, instanced: true });

    const mesh = new Mesh(
        fullscreenTriangle(),
        new Material({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: vec4(varying(instanceColor, 'v_instColor'), f32(1)),
            depthTest: false, // so the last instance wins at every pixel
        }),
    );
    mesh.count = 2;
    mesh.updateWorldMatrix();

    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const f = frame(gpu);
    const pass = f.pass({ target, camera: new PerspectiveCamera(), clear: [0, 0, 0, 1] });
    pass.draw(mesh);
    pass.end();
    f.submit();

    return {
        name: 'instanced',
        pixel: centerPixel(await read(gpu, target)),
        expected: [u8(second[0]), u8(second[1]), u8(second[2]), 255],
        note: 'instance 1 over instance 0; red means the step mode advanced per vertex instead',
    };
}

async function caseCubemap(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const faces = [
        new Uint8Array([230, 26, 26, 255]),
        new Uint8Array([26, 153, 153, 255]),
        new Uint8Array([26, 204, 51, 255]),
        new Uint8Array([153, 51, 179, 255]),
        new Uint8Array([51, 128, 230, 255]), // +Z, the direction sampled
        new Uint8Array([230, 204, 26, 255]),
    ];
    const cubeTex = new CubeTexture(
        faces.map((data) => ({ data, width: 1, height: 1 })),
        { format: 'rgba8unorm', magFilter: 'nearest', minFilter: 'nearest', generateMipmaps: false },
    );
    cubeTex.needsUpdate = true;

    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const mesh = new Mesh(
        fullscreenTriangle(),
        new Material({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: cubeTexture(cubeTex).sample(vec3(0, 0, 1)),
            depthTest: false,
        }),
    );
    mesh.updateWorldMatrix();

    const f = frame(gpu);
    const pass = f.pass({ target, camera: new PerspectiveCamera(), clear: [0, 0, 0, 1] });
    pass.draw(mesh);
    pass.end();
    f.submit();

    const pixel = centerPixel(await read(gpu, target));
    return {
        name: 'cubemap',
        pixel,
        expected: [51, 128, 230, 255],
        note: 'six faces from typed arrays, which the cube upload path had no branch for',
    };
}

async function caseCubeFacePartial(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const faceData = [
        new Uint8Array([230, 26, 26, 255]),
        new Uint8Array([26, 153, 153, 255]),
        new Uint8Array([26, 204, 51, 255]),
        new Uint8Array([153, 51, 179, 255]),
        new Uint8Array([51, 128, 230, 255]), // +Z, the face rewritten below
        new Uint8Array([230, 204, 26, 255]),
    ];
    const cubeTex = new CubeTexture(
        faceData.map((data) => ({ data, width: 1, height: 1 })),
        { format: 'rgba8unorm', magFilter: 'nearest', minFilter: 'nearest', generateMipmaps: false },
    );
    cubeTex.needsUpdate = true;

    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const mesh = new Mesh(
        fullscreenTriangle(),
        new Material({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: cubeTexture(cubeTex).sample(vec3(0, 0, 1)),
            depthTest: false,
        }),
    );
    mesh.updateWorldMatrix();

    const sampleOnce = (): void => {
        const f = frame(gpu);
        const pass = f.pass({ target, camera: new PerspectiveCamera(), clear: [0, 0, 0, 1] });
        pass.draw(mesh);
        pass.end();
        f.submit();
    };

    sampleOnce(); // full upload
    faceData[4].set([255, 0, 255]);
    cubeTex._gpuTexture.addUpdateRegion({ z: 4, depth: 1 });
    sampleOnce();

    return {
        name: 'cube-face-partial',
        pixel: centerPixel(await read(gpu, target)),
        expected: [255, 0, 255, 255],
        note: 'region z is the face index; the old blue means it wrote some other face or none',
    };
}

/** Both halves of the partial-layer contract in one case: the queued layer changes, its neighbour does not. */
async function caseArrayLayerPartial(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const packed = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]); // layer 0 red, layer 1 green
    const arrayTex = new ArrayTexture(packed, 1, 1, 2, {
        format: 'rgba8unorm',
        magFilter: 'nearest',
        minFilter: 'nearest',
        generateMipmaps: false,
    });
    arrayTex.needsUpdate = true;

    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const sampleLayer = (layer: number): Mesh => {
        const mesh = new Mesh(
            fullscreenTriangle(),
            new Material({
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment: arrayTexture(arrayTex, i32(layer)).sample(screenUV),
                depthTest: false,
            }),
        );
        mesh.updateWorldMatrix();
        return mesh;
    };
    const readLayer = async (layer: number): Promise<[number, number, number, number]> => {
        const f = frame(gpu);
        const pass = f.pass({ target, camera: new PerspectiveCamera(), clear: [0, 0, 0, 1] });
        pass.draw(sampleLayer(layer));
        pass.end();
        f.submit();
        return centerPixel(await read(gpu, target));
    };

    await readLayer(1); // full upload
    packed.set([0, 0, 255], 4);
    arrayTex._gpuTexture.addUpdateRegion({ z: 1, depth: 1 });

    const updated = await readLayer(1);
    const neighbour = await readLayer(0);

    const ok = updated[2] > 200 && updated[0] < 60 && neighbour[0] > 200 && neighbour[2] < 60;
    return {
        name: 'array-layer-partial',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `layer 1 ${updated.slice(0, 3)} wants blue, layer 0 ${neighbour.slice(0, 3)} wants red and untouched`,
    };
}

/** Both halves again: the queued texel changes and its row-neighbour does not, so a widened write fails. */
async function caseSubrectPartial(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    // 2x2 rgba8: (0,0) red, (1,0) green, (0,1) blue, (1,1) yellow.
    const texels = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]);
    const tex = new DataTexture(texels, 2, 2, {
        format: 'rgba8unorm',
        magFilter: 'nearest',
        minFilter: 'nearest',
        generateMipmaps: false,
    });
    tex.needsUpdate = true;

    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const sampleTexel = (u: number, v: number): Mesh => {
        const mesh = new Mesh(
            fullscreenTriangle(),
            new Material({
                vertex: vec4(attribute('position', d.vec3f), f32(1)),
                fragment: texture(tex).sample(vec2f(u, v)),
                depthTest: false,
            }),
        );
        mesh.updateWorldMatrix();
        return mesh;
    };
    const readTexel = async (u: number, v: number): Promise<[number, number, number, number]> => {
        const f = frame(gpu);
        const pass = f.pass({ target, camera: new PerspectiveCamera(), clear: [0, 0, 0, 1] });
        pass.draw(sampleTexel(u, v));
        pass.end();
        f.submit();
        return centerPixel(await read(gpu, target));
    };

    await readTexel(0.75, 0.25); // full upload
    texels.set([255, 0, 255], 4);
    tex._gpuTexture.addUpdateRegion({ x: 1, y: 0, width: 1, height: 1 });

    const updated = await readTexel(0.75, 0.25); // texel (1,0)
    const neighbour = await readTexel(0.25, 0.25); // texel (0,0), untouched

    const ok = updated[0] > 200 && updated[2] > 200 && neighbour[0] > 200 && neighbour[2] < 60;
    return {
        name: 'subrect-partial',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `(1,0) ${updated.slice(0, 3)} wants magenta, (0,0) ${neighbour.slice(0, 3)} wants red and untouched`,
    };
}

async function caseRttFlip(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const offscreen = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm', depthBuffer: true });
    const position = attribute('position', d.vec3f);
    const clipY = varying(position.y, 'vyRttFlip');
    const twoTone = new Mesh(
        fullscreenTriangle(),
        new Material({
            vertex: vec4(position, f32(1)),
            fragment: select(vec4(0, 1, 0, 1), vec4(1, 0, 0, 1), clipY.greaterThan(f32(0))),
            depthTest: false,
        }),
    );
    twoTone.updateWorldMatrix();

    const drawn = frame(gpu);
    const drawPass = drawn.pass({ target: offscreen, camera: new PerspectiveCamera(), clear: [0, 0, 0, 1] });
    drawPass.draw(twoTone);
    drawPass.end();
    drawn.submit();

    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const sampled = new Mesh(
        fullscreenTriangle(),
        new Material({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: texture(offscreen.texture as Texture).sample(vec2f(0.5, 0.25)),
            depthTest: false,
        }),
    );
    sampled.updateWorldMatrix();

    const f = frame(gpu);
    const pass = f.pass({ target, camera: new PerspectiveCamera(), clear: [0, 0, 0, 1] });
    pass.draw(sampled);
    pass.end();
    f.submit();

    return {
        name: 'rtt-flip',
        pixel: centerPixel(await read(gpu, target)),
        expected: [255, 0, 0, 255],
        note: "the other half of the WebGL harness's V-flip claim: v=0.25 is the clip-space top here too, so red; green means V runs the other way",
    };
}

async function caseRtLoadOrient(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const offscreen = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm', depthBuffer: true });
    const position = attribute('position', d.vec3f);
    const clipY = varying(position.y, 'vyLoadOrient');
    const twoTone = new Mesh(
        fullscreenTriangle(),
        new Material({
            vertex: vec4(position, f32(1)),
            fragment: select(vec4(0, 1, 0, 1), vec4(1, 0, 0, 1), clipY.greaterThan(f32(0))),
            depthTest: false,
        }),
    );
    twoTone.updateWorldMatrix();

    const drawn = frame(gpu);
    const drawPass = drawn.pass({ target: offscreen, camera: new PerspectiveCamera(), clear: [0, 0, 0, 1] });
    drawPass.draw(twoTone);
    drawPass.end();
    drawn.submit();

    const texNode = texture(offscreen.texture as Texture);
    const shown = new Mesh(
        fullscreenTriangle(),
        new Material({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: texNode.load(vec2i(mul(screenUV, vec2f(textureDimensions(texNode.bindingNode))))),
            depthTest: false,
        }),
    );
    shown.updateWorldMatrix();

    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const f = frame(gpu);
    const pass = f.pass({ target, camera: new PerspectiveCamera(), clear: [0, 0, 0, 1] });
    pass.draw(shown);
    pass.end();
    f.submit();

    const pixels = await read(gpu, target);
    const top = pixelAt(pixels, CENTER, 3);
    const bottom = pixelAt(pixels, CENTER, SIZE - 4);
    const ok = top[0] > 128 && top[1] < 128 && bottom[1] > 128 && bottom[0] < 128;
    return {
        name: 'rt-load-orient',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `top=[${top[0]},${top[1]}] wants red, bottom=[${bottom[0]},${bottom[1]}] wants green; swapped means the texel index is mirrored`,
    };
}

async function caseFragCoordDirect(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const mesh = new Mesh(
        fullscreenTriangle(),
        new Material({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: select(vec4(0, 1, 0, 1), vec4(1, 0, 0, 1), screenCoordinate.y.lessThan(f32(SIZE / 2))),
            depthTest: false,
        }),
    );
    mesh.updateWorldMatrix();

    const f = frame(gpu);
    const pass = f.pass({ target, camera: new PerspectiveCamera(), clear: [0, 0, 0, 1] });
    pass.draw(mesh);
    pass.end();
    f.submit();

    const pixels = await read(gpu, target);
    const top = pixelAt(pixels, CENTER, 3);
    const bottom = pixelAt(pixels, CENTER, SIZE - 4);
    const ok = top[0] > 128 && top[1] < 128 && bottom[1] > 128 && bottom[0] < 128;
    return {
        name: 'fragcoord-direct',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `raw fragCoord, not screenUV: top=[${top[0]},${top[1]}] wants red, bottom=[${bottom[0]},${bottom[1]}] wants green`,
    };
}

async function caseCubeCamera(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const cube = createCubeRenderTarget(SIZE, { colorFormat: 'rgba8unorm', depthBuffer: true });
    const faceColor: [number, number, number, number] = [0.2, 0.8, 0.4, 1];
    cube.clearColor = faceColor;

    const cubeCamera = new CubeCamera(0.1, 100, cube);
    cubeCamera.updateWorldMatrix();
    const empty = new Scene();
    empty.updateWorldMatrix();
    cubeCamera.update(gpu, empty);

    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const sampled = new Mesh(
        fullscreenTriangle(),
        new Material({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: cubeTexture(cube.texture).sample(vec3(-1, 0, 0)), // the -X face
            depthTest: false,
        }),
    );
    sampled.updateWorldMatrix();

    const f = frame(gpu);
    const pass = f.pass({ target, camera: new PerspectiveCamera(), clear: [0, 0, 0, 1] });
    pass.draw(sampled);
    pass.end();
    f.submit();

    return {
        name: 'cube-camera',
        pixel: centerPixel(await read(gpu, target)),
        expected: [u8(faceColor[0]), u8(faceColor[1]), u8(faceColor[2]), 255],
        note: 'only written if PassDesc.layer reaches activeFace; dead layer wiring leaves -X untouched',
    };
}

async function caseCubeCameraMips(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const cube = createCubeRenderTarget(SIZE, { colorFormat: 'rgba8unorm', depthBuffer: true, generateMipmaps: true });
    cube.clearColor = [0, 0, 0, 1];

    // Raw clip-space positions, so every one of CubeCamera's six views draws the same two-tone face.
    const scene = new Scene();
    const position = attribute('position', d.vec3f);
    const clipY = varying(position.y, 'vyCubeCameraMips');
    scene.add(
        new Mesh(
            fullscreenTriangle(),
            new Material({
                vertex: vec4(position, f32(1)),
                fragment: select(vec4(0, 0, 0, 1), vec4(1, 0, 0, 1), clipY.greaterThan(f32(0))),
                depthTest: false,
            }),
        ),
    );
    scene.updateWorldMatrix();

    const cubeCamera = new CubeCamera(0.1, 100, cube);
    cubeCamera.updateWorldMatrix();
    cubeCamera.update(gpu, scene);

    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const sampled = new Mesh(
        fullscreenTriangle(),
        new Material({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: cubeTexture(cube.texture).level(f32(6)).sample(vec3(0, 0.6, 1)),
            depthTest: false,
        }),
    );
    sampled.updateWorldMatrix();

    const f = frame(gpu);
    const pass = f.pass({ target, camera: new PerspectiveCamera(), clear: [0, 0, 0, 1] });
    pass.draw(sampled);
    pass.end();
    f.submit();

    const pixel = centerPixel(await read(gpu, target));
    const blended = pixel[0] > 90 && pixel[0] < 165;
    return {
        name: 'cube-camera-mips',
        pixel: blended ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `level 6 red=${pixel[0]}; CubeCamera flips generateMipmaps off, which used to suppress the allocation`,
    };
}

async function caseIntegerTexture(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    // rgba32uint binds with sampleType 'uint' and no sampler, a layout shape no float texture exercises.
    const tex = new DataTexture(new Uint32Array([64, 128, 192, 255]), 1, 1, {
        format: 'rgba32uint',
        magFilter: 'nearest',
        minFilter: 'nearest',
    });

    const texel = texture(tex).load(vec2i(i32(0), i32(0)), i32(0));
    const mesh = new Mesh(
        fullscreenTriangle(),
        new Material({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: vec4(f32(texel.x).div(f32(255)), f32(texel.y).div(f32(255)), f32(texel.z).div(f32(255)), f32(1)),
            depthTest: false,
        }),
    );
    mesh.updateWorldMatrix();

    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const f = frame(gpu);
    const pass = f.pass({ target, camera: new PerspectiveCamera(), clear: [0, 0, 0, 1] });
    pass.draw(mesh);
    pass.end();
    f.submit();

    return {
        name: 'integer-texture',
        pixel: centerPixel(await read(gpu, target)),
        expected: [64, 128, 192, 255],
        note: 'raw u32 channels through textureLoad; a float sampleType would fail the layout, not the pixel',
    };
}

async function caseCompilePrewarm(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm', depthBuffer: true });
    const mesh = new Mesh(
        fullscreenTriangle(),
        new Material({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: vec4(0, 1, 0, 1),
            depthTest: false,
        }),
    );
    mesh.updateWorldMatrix();

    const pipelines = () => gpu.backend.pipelines.renderPipelines.size;
    const before = pipelines();
    await gpu.compile([mesh], target, new PerspectiveCamera());
    const warmed = pipelines();

    const f = frame(gpu);
    const pass = f.pass({ target, camera: new PerspectiveCamera(), clear: [0, 0, 0, 1] });
    pass.draw(mesh);
    pass.end();
    f.submit();
    const afterDraw = pipelines();

    const drewGreen = centerPixel(await read(gpu, target))[1] > 200;
    // `afterDraw === warmed` is the assertion that matters: a pre-warm resolved against anything but
    // the pass's own context builds a second pipeline the pass never looks up.
    const ok = warmed > before && afterDraw === warmed && drewGreen;
    return {
        name: 'compile-prewarm',
        pixel: ok ? [0, 255, 0, 255] : [255, 0, 0, 255],
        expected: [0, 255, 0, 255],
        note: `pipelines ${before} -> ${warmed} on compile -> ${afterDraw} after the draw`,
    };
}

async function caseTransparentDefaultBlend(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const position = attribute('position', d.vec3f);
    const layer = (fragment: ReturnType<typeof vec4>, transparent: boolean): Mesh => {
        const mesh = new Mesh(
            fullscreenTriangle(),
            new Material({ vertex: vec4(position, f32(1)), fragment, depthTest: false, transparent }),
        );
        mesh.updateWorldMatrix();
        return mesh;
    };

    const f = frame(gpu);
    const pass = f.pass({ target, camera: new PerspectiveCamera(), clear: [0, 0, 0, 1] });
    pass.draw(layer(vec4(1, 0, 0, 1), false));
    pass.draw(layer(vec4(0, 1, 0, 0.5), true)); // no explicit `blend`, so the default must apply
    pass.end();
    f.submit();

    return {
        name: 'transparent-default-blend',
        pixel: centerPixel(await read(gpu, target)),
        expected: [u8(0.5), u8(0.5), 0, 255],
        note: 'half-alpha green over opaque red; a material with no blend state reading as opaque gives pure green',
    };
}

async function caseFrameDone(gpu: Renderer<WebGPUBackend>): Promise<CaseResult> {
    const target = createRenderTarget(SIZE, SIZE, { colorFormat: 'rgba8unorm' });
    const mesh = new Mesh(
        fullscreenTriangle(),
        new Material({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: vec4(0, 1, 0, 1),
            depthTest: false,
        }),
    );
    mesh.updateWorldMatrix();

    const f = frame(gpu);
    const pass = f.pass({ target, camera: new PerspectiveCamera(), clear: [1, 0, 0, 1] });
    pass.draw(mesh);
    pass.end();
    f.submit();

    // Awaiting `done` is the whole point: the readback must not be what makes the work land.
    await f.done;

    return {
        name: 'frame-done',
        pixel: centerPixel(await read(gpu, target)),
        expected: [0, 255, 0, 255],
        note: 'green after awaiting done; the clear is red, so a wait that resolves early reads red',
    };
}

const CASES: Record<string, Case> = {
    clear: caseClear,
    solid: caseSolid,
    uniform: caseUniform,
    scene: caseScene,
    'two-passes': caseTwoPasses,
    'viewport-scissor': caseScissor,
    mrt: caseMrt,
    'cube-layer': caseCubeLayer,
    'cube-mips': caseCubeMips,
    'cube-face-partial': caseCubeFacePartial,
    'array-layer-partial': caseArrayLayerPartial,
    'subrect-partial': caseSubrectPartial,
    'rtt-flip': caseRttFlip,
    'rt-load-orient': caseRtLoadOrient,
    'fragcoord-direct': caseFragCoordDirect,
    'cube-camera': caseCubeCamera,
    'cube-camera-mips': caseCubeCameraMips,
    'integer-texture': caseIntegerTexture,
    'compile-prewarm': caseCompilePrewarm,
    'frame-done': caseFrameDone,
    'transparent-default-blend': caseTransparentDefaultBlend,
    cubemap: caseCubemap,
    msaa: caseMsaa,
    'bundle-replay': caseBundleReplay,
    'draw-material': caseDrawMaterial,
    compute: caseCompute,
    'dispose-releases': caseDisposeReleases,
    'readback-orientation': caseReadbackOrientation,
    'clear-depth': caseClearDepth,
    'clear-depth-only': caseClearDepthOnly,
    'clear-selective': caseClearSelective,
    'depth-load-read': caseDepthLoadRead,
    'depth-bias': caseDepthBias,
    'pass-occlude': casePassOcclude,
    'two-pass-nodes': caseTwoPassNodes,
    'pass-colour-and-depth': casePassColourAndDepth,
    'chained-pass-nodes': caseChainedPassNodes,
    'pass-as-value': casePassAsValue,
    rtt: caseRtt,
    'pass-node': casePassNode,
    'buffer-swap': caseBufferSwap,
    'mrt-blend': caseMrtBlend,
    'pass-depth-sample': casePassDepthSample,
    'draw-opts': caseDrawOpts,
    'interleaved-attrs': caseInterleavedAttrs,
    instanced: caseInstanced,
    'dispose-in-flight': caseDisposeInFlight,
    'storage-mat4': caseStorageMat4,
    'storage-mixed-align': caseStorageMixedAlign,
    'uniform-struct-align': caseUniformStructAlign,
    'struct-texture-unorm8x4': caseStructTexturePackedUnorm,
    'struct-texture-snorm8x4': caseStructTexturePackedSnorm,
    'struct-texture-half2x16': caseStructTexturePackedHalf,
    'struct-texture-mat4': caseStructTextureMat4,
    'struct-texture-bits': caseStructTextureBits,
};

/** One case on its own renderer. The runner gives each its own process; see child.mjs for why. */
export async function runCase(device: GPUDevice, adapter: GPUAdapter, name: string): Promise<CaseResult> {
    const c = CASES[name];
    if (!c) throw new Error(`[webgpu-render] no case named '${name}'`);
    const gpu = await init(webgpu({ device, adapter, format: 'rgba8unorm' }));
    const result = await c(gpu);

    // Error scopes resolve after the pass that opened them, so without this a case can finish and the
    // process exit before Dawn reports why its pixels were wrong.
    const errors = await gpu.backend.takeValidationErrors();
    if (errors.length > 0) {
        return { ...result, pixel: [255, 0, 0, 255], note: `${errors.length} validation error(s): ${errors[0]}` };
    }
    return result;
}

/** The parent reads `case-names.mjs` without bundling this file, so the two must agree. */
export function assertCaseNames(names: readonly string[]): void {
    const mine = Object.keys(CASES);
    const missing = mine.filter((n) => !names.includes(n));
    const extra = names.filter((n) => !mine.includes(n));
    if (missing.length || extra.length) {
        throw new Error(`[webgpu-render] case-names.mjs is stale: missing [${missing}], unknown [${extra}]`);
    }
}
