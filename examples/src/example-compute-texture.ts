import {
    createStorageTexture,
    storageTexture,
    textureStore,
    texture,
    screenUV,
    Fn,
    Var,
    globalId,
    f32,
    vec2u,
    vec4,
    sin,
    uniform,
    renderGroup,
    GpuSampler,
    RenderPipeline,
    WebGPURenderer,
    Inspector,
} from 'gpucat';

/**
 * Compute Texture Example
 *
 * A compute shader writes an animated plasma pattern into a storage texture
 * (`texture_storage_2d<rgba8unorm, write>`) via `textureStore`. A render pass
 * then samples that same texture onto a fullscreen quad.
 *
 * This is the canonical storage-texture round-trip: the texture is created with
 * both STORAGE_BINDING (written in compute) and TEXTURE_BINDING (sampled in
 * render) usage, so one resource flows from the compute pass to the draw.
 */

const W = 256;
const H = 256;
const WG = 8;

// One storage texture, written in compute and sampled in render (dual usage).
const tex = createStorageTexture(W, H, 'rgba8unorm');

// `time` drives the animation. renderGroup (shared) so it binds in the compute pass.
const time = uniform(f32(0), 'time');
time.group = renderGroup;

// Compute: for each texel, write an animated plasma colour.
const writeTex = storageTexture(tex, 'write');
const computePlasma = Fn(() => {
    const px = globalId.x;
    const py = globalId.y;

    const u = Var('u', px.toF32().div(f32(W)));
    const v = Var('v', py.toF32().div(f32(H)));

    const r = sin(u.mul(f32(12)).add(time)).mul(f32(0.5)).add(f32(0.5));
    const g = sin(v.mul(f32(12)).add(time.mul(f32(1.3)))).mul(f32(0.5)).add(f32(0.5));
    const b = sin(u.add(v).mul(f32(8)).add(time.mul(f32(0.7)))).mul(f32(0.5)).add(f32(0.5));

    textureStore(writeTex, vec2u(px, py), vec4(r, g, b, f32(1)));
}).compute({ workgroupSize: [WG, WG, 1] });

/* renderer + display */
const renderer = new WebGPURenderer({ antialias: true });
renderer.inspector = new Inspector();
await renderer.init();

document.body.appendChild(renderer.domElement);
document.body.appendChild((renderer.inspector as Inspector).domElement);
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Sample the storage texture onto a fullscreen quad.
const sampler = new GpuSampler({ minFilter: 'linear', magFilter: 'linear' });
const outputNode = texture(tex, sampler).sample(screenUV);
const renderPipeline = new RenderPipeline(renderer, outputNode);

// Pre-warm the compute pipeline before the loop.
await renderer.compileCompute(computePlasma);

function frame() {
    time.value = performance.now() / 1000;
    // Compute writes the texture, then the render pass samples it.
    renderer.compute([{ node: computePlasma, dispatch: [Math.ceil(W / WG), Math.ceil(H / WG), 1] }]);
    renderPipeline.render();
    requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
