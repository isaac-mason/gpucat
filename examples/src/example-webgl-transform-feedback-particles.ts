import * as g from 'gpucat';

const d = g.d;

// ---------------------------------------------------------------------------------------------------
// Transform-feedback particles (the honest WebGL2 GPU-sim primitive).
//
// `transformFeedback(kernel, { inputs, outputs })` is the literal WebGL2 transform-feedback primitive:
// per-element attributes in, captured varyings out, own-index (gl_VertexID) only. It is NOT a faked
// storage()/compute() — there is no hidden dual buffer, no auto-swap, no PBO mirror. You hold the
// buffers, you ping-pong them yourself, and you read results back with the native `readBufferAsync`.
//
// The per-element physics lives in a shared `particleStep` Fn (below). The SAME Fn would feed a WebGPU
// `compute()` kernel — `Fn(() => { index(out, i).assign(particleStep(index(pos, i), index(vel, i), dt)); })`
// — so the body is reused verbatim across backends; only the thin I/O wrapper differs (own-index
// attributes/varyings here vs arbitrary-index storage there). That difference is stated, not disguised.
// ---------------------------------------------------------------------------------------------------

const N = 4096;

// The half-extent of the cube the particles loop inside. When a particle drifts past a face it wraps
// to the opposite one, so the field stays alive without any respawn bookkeeping.
const BOUND = 8;

// ---------------------------------------------------------------------------------------------------
// Shared per-element physics. `particleStep(pos, vel, dt)` advances one particle by `vel * dt` and wraps each
// axis back into [-BOUND, BOUND]. It is a plain DSL `Fn` with no I/O model baked in, so it is reusable:
// the transform-feedback kernel calls it here; a WebGPU compute() kernel would call the exact same Fn.
// ---------------------------------------------------------------------------------------------------

const wrap = g.Fn((x: g.Node<typeof d.f32>) => {
    // ((x + BOUND) mod 2*BOUND) - BOUND, using fract to fold the axis back into range.
    const span = g.f32(2 * BOUND);
    const t = x.add(g.f32(BOUND)).div(span);
    return t.sub(t.floor()).mul(span).sub(g.f32(BOUND));
}, {
    name: 'wrap',
    params: [{ name: 'x', type: d.f32 }],
    return: d.f32,
});

const particleStep = g.Fn((pos: g.Node<typeof d.vec4f>, vel: g.Node<typeof d.vec4f>, dt: g.Node<typeof d.f32>) => {
    const next = pos.add(vel.mul(dt));
    // xyz = wrapped position, w = passthrough (carries a per-particle hue seed for the fragment).
    return g.vec4(wrap(next.x), wrap(next.y), wrap(next.z), pos.w);
}, {
    name: 'particleStep',
    params: [
        { name: 'pos', type: d.vec4f },
        { name: 'vel', type: d.vec4f },
        { name: 'dt', type: d.f32 },
    ],
    return: d.vec4f,
});

// ---------------------------------------------------------------------------------------------------
// Buffers. Two position buffers to ping-pong between (bufA/bufB), one velocity buffer, and a separate
// instanced attribute buffer the render pass draws from. Each is one GpuBuffer = one GL buffer.
// ---------------------------------------------------------------------------------------------------

const posData = new Float32Array(N * 4);
const velData = new Float32Array(N * 4);
for (let i = 0; i < N; i++) {
    posData[i * 4 + 0] = (Math.random() - 0.5) * 2 * BOUND;
    posData[i * 4 + 1] = (Math.random() - 0.5) * 2 * BOUND;
    posData[i * 4 + 2] = (Math.random() - 0.5) * 2 * BOUND;
    posData[i * 4 + 3] = i / N; // hue seed in w

    velData[i * 4 + 0] = (Math.random() - 0.5) * 4;
    velData[i * 4 + 1] = (Math.random() - 0.5) * 4;
    velData[i * 4 + 2] = (Math.random() - 0.5) * 4;
    velData[i * 4 + 3] = 0;
}

// Transform-feedback position buffers (ping-ponged). We swap which is input vs output each frame.
let cur = new g.GpuBuffer(d.vec4f, { data: posData });
let next = new g.GpuBuffer(d.vec4f, { data: new Float32Array(N * 4) });
const velBuf = new g.GpuBuffer(d.vec4f, { data: velData });

// The render pass draws from its own instanced attribute buffer. Because transform feedback and the
// render path keep independent GL buffers, we read the simulated positions back with the honest native
// `readBufferAsync` and upload them here — the CPU round-trip is explicit, not hidden.
const renderPos = new g.GpuBuffer(d.vec4f, { count: N, usage: 'vertex' });

// `dt` uniform, driven from the frame loop (the renderer reads no wall clock of its own).
const dt = g.uniform('dt', d.f32);

// The transform-feedback kernel: attribute-in (pos, vel) → captured-varying-out (pos), body = shared Fn.
const kernel = g.transformFeedback(
    (io) => ({ pos: particleStep(io.pos, io.vel, dt) }),
    {
        inputs: { pos: d.vec4f, vel: d.vec4f },
        outputs: { pos: d.vec4f },
        name: 'particles-step',
    },
);

// ---------------------------------------------------------------------------------------------------
// Render material: a tiny instanced quad per particle, offset by its world position (an instanced
// vec4f attribute), tinted by the hue seed carried in w.
// ---------------------------------------------------------------------------------------------------

const instancePos = g.attribute(renderPos, { instanced: true });

const vtx = g.attribute('position', d.vec3f);
const worldPos = g.vec4(
    vtx.x.add(instancePos.x),
    vtx.y.add(instancePos.y),
    vtx.z.add(instancePos.z),
    g.f32(1),
);
const clipPos = g.mul(g.cameraProjectionMatrix, g.mul(g.cameraViewMatrix, worldPos));

// Per-particle hue from w, interpolated into the fragment stage.
const hue = g.varying(instancePos.w, 'v_hue');
const twoPi = g.f32(Math.PI * 2);
const color = g.vec4(
    hue.mul(twoPi).sin().mul(g.f32(0.5)).add(g.f32(0.5)),
    hue.mul(twoPi).add(g.f32(2)).sin().mul(g.f32(0.5)).add(g.f32(0.5)),
    hue.mul(twoPi).add(g.f32(4)).sin().mul(g.f32(0.5)).add(g.f32(0.5)),
    g.f32(1),
);

const material = new g.Material({ vertex: clipPos, fragment: color });

// ---------------------------------------------------------------------------------------------------
// Renderer + scene.
// ---------------------------------------------------------------------------------------------------

async function main() {
    const renderer = new g.WebGLRenderer({ antialias: true });
    await renderer.init();

    document.body.appendChild(renderer.domElement);
    renderer.setPixelRatio(devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.clearColor = [0.04, 0.04, 0.08, 1];

    const scene = new g.Scene();
    const camera = new g.PerspectiveCamera(Math.PI / 4, window.innerWidth / window.innerHeight, 0.1, 200);
    camera.position[2] = 24;
    scene.add(camera);
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth, window.innerHeight);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    });

    // A small quad per particle (a 0.12-unit square).
    const S = 0.06;
    const quad = new g.Geometry();
    quad.setBuffer('position', g.createVertexBuffer(d.vec3f, new Float32Array([
        -S, -S, 0, S, -S, 0, S, S, 0, -S, S, 0,
    ])));
    quad.index = g.createIndexBuffer(new Uint16Array([0, 1, 2, 0, 2, 3]));

    const mesh = new g.Mesh(quad, material);
    mesh.count = N;
    scene.add(mesh);

    const scenePass = g.pass(scene, camera);
    const renderPipeline = new g.RenderPipeline(renderer, g.renderOutput(scenePass.getTextureNode()));

    let last = performance.now();

    async function frame() {
        const now = performance.now();
        dt.value = Math.min((now - last) / 1000, 0.05); // seconds, clamped for tab-switch spikes
        last = now;

        // 1. Advance the sim on the GPU: cur (+ vel) → next, own-index, one draw under RASTERIZER_DISCARD.
        renderer.transformFeedback(kernel, {
            inputs: { pos: cur, vel: velBuf },
            outputs: { pos: next },
            count: N,
        });

        // 2. Explicit ping-pong — no auto-swap. `next` now holds this frame's positions.
        [cur, next] = [next, cur];

        // 3. Honest native readback of the current positions, then upload them as the instanced draw
        //    attribute. (transform feedback and the render path hold separate GL buffers, so the hop
        //    through the CPU is explicit rather than a hidden buffer↔attribute mirror.)
        const positions = await renderer.readBufferAsync(cur);
        renderPos.array!.set(positions as Float32Array);
        renderPos.needsUpdate = true;

        renderPipeline.render();
        requestAnimationFrame(() => void frame());
    }

    requestAnimationFrame(() => void frame());
}

main();
