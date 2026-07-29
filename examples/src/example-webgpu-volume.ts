import {
    createStorageTexture3d,
    storageTexture,
    textureStore,
    texture,
    attribute,
    modelWorldMatrix,
    cameraViewMatrix,
    cameraProjectionMatrix,
    cameraPosition,
    varying,
    Fn,
    Var,
    Loop,
    If,
    globalId,
    f32,
    vec3,
    vec3u,
    vec4,
    sin,
    exp,
    min,
    max,
    clamp,
    mix,
    floor,
    fract,
    dot,
    length,
    normalize,
    mul,
    smoothstep,
    uniform,
    renderGroup,
    renderOutput,
    pass,
    createBoxGeometry,
    Mesh,
    Material,
    Scene,
    PerspectiveCamera,
    OrbitControls,
    GpuSampler,
    RenderPipeline,
    WebGPURenderer,
    Inspector,
    type Node,
    d,
} from 'gpucat';

/**
 * Volume Example
 *
 * A compute shader writes an animated density field into a 3D storage texture
 * (`texture_storage_3d` + `textureStore`), and a render pass raymarches it,
 * sampling the same texture as a `texture_3d`. The canonical 3D-texture use.
 *
 * The volume is drawn by raymarching its bounding box: a unit cube is rendered,
 * and each fragment casts a ray from the camera through its world position into
 * the volume. So `OrbitControls` just moves the camera — no special handling.
 * Depth/form comes from self-shadowing (a short shadow march per step + Beer's law).
 */

const N = 128;          // volume is N^3 voxels
const WG = 4;           // compute workgroup size
const STEPS = 96;       // view raymarch steps
const LIGHT_STEPS = 6;  // shadow raymarch steps toward the light
const BG = [0.04, 0.05, 0.09] as const; // background / clear colour (linear)

// One 3D texture: written in compute, sampled in render. rgba8unorm is filterable,
// so the raymarch gets smooth trilinear interpolation between voxels.
const volume = createStorageTexture3d(N, N, N, 'rgba8unorm');

// Animation clock — shared (renderGroup) so it binds in the compute pass too.
const time = uniform(f32(0), 'time');
time.group = renderGroup;

/* compute: write an animated, eroded value-noise FBM density per voxel.
 * Hash-based value noise (not sine layers) gives genuinely turbulent, wispy detail. */
const hash = Fn((p: Node<d.vec3f>) => {
    return fract(sin(dot(p, vec3(f32(127.1), f32(311.7), f32(74.7)))).mul(f32(43758.5453)));
}, { name: 'hash3', params: [{ name: 'p', type: d.vec3f }], return: d.f32 });

// Trilinearly-interpolated value noise: hash the 8 lattice corners, smooth-blend.
const valueNoise = Fn((p: Node<d.vec3f>) => {
    const i = floor(p).toVar('i');
    const f = fract(p).toVar('f');
    const u = f.mul(f).mul(vec3(f32(3), f32(3), f32(3)).sub(f.mul(f32(2)))).toVar('u'); // smoothstep weights
    const x00 = mix(hash(i), hash(i.add(vec3(f32(1), f32(0), f32(0)))), u.x);
    const x10 = mix(hash(i.add(vec3(f32(0), f32(1), f32(0)))), hash(i.add(vec3(f32(1), f32(1), f32(0)))), u.x);
    const x01 = mix(hash(i.add(vec3(f32(0), f32(0), f32(1)))), hash(i.add(vec3(f32(1), f32(0), f32(1)))), u.x);
    const x11 = mix(hash(i.add(vec3(f32(0), f32(1), f32(1)))), hash(i.add(vec3(f32(1), f32(1), f32(1)))), u.x);
    return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}, { name: 'valueNoise', params: [{ name: 'p', type: d.vec3f }], return: d.f32 });

// 4-octave FBM in ~[0, 0.94].
const fbm = Fn((p: Node<d.vec3f>) => {
    return valueNoise(p).mul(f32(0.5))
        .add(valueNoise(p.mul(f32(2.02))).mul(f32(0.25)))
        .add(valueNoise(p.mul(f32(4.03))).mul(f32(0.125)))
        .add(valueNoise(p.mul(f32(8.01))).mul(f32(0.0625)));
}, { name: 'fbm', params: [{ name: 'p', type: d.vec3f }], return: d.f32 });

const writeVol = storageTexture(volume, 'write');
const fillVolume = Fn(() => {
    const gid = globalId;
    const p = vec3(gid.x.toF32(), gid.y.toF32(), gid.z.toF32()).add(f32(0.5)).div(f32(N)).toVar('p');

    // spherical falloff — dense at the centre, fading to empty at the edges
    const shape = smoothstep(f32(0.5), f32(0.05), length(p.sub(f32(0.5)))).toVar('shape');

    // sample the noise in a drifting, scaled space so the cloud churns over time
    const sp = p.mul(f32(4.5)).add(vec3(time.mul(f32(0.25)), f32(0), time.mul(f32(0.12)))).toVar('sp');
    const n = fbm(sp).toVar('n');

    // erode by a threshold + boost contrast → wispy tendrils and holes
    const density = clamp(shape.mul(n).sub(f32(0.22)).mul(f32(3.5)), f32(0), f32(1)).toVar('density');
    textureStore(writeVol, vec3u(gid.x, gid.y, gid.z), vec4(density, density, density, f32(1)));
}).compute({ workgroupSize: [WG, WG, WG] });

/* render: raymarch the bounding box with self-shadowing */
const sampler = new GpuSampler({ minFilter: 'linear', magFilter: 'linear' });
const vol = texture(volume, sampler);
// textureSampleLevel (explicit LOD) — valid inside loops / non-uniform branches.
const densityAt = (tc: Node<d.vec3f>) => vol.sample(tc).level(f32(0)).x;

// vertex: standard MVP for a unit cube at the origin (spans [-0.5, 0.5]).
const localPos = attribute('position', d.vec3f);
const worldPos4 = mul(modelWorldMatrix, vec4(localPos, f32(1)));
const clipPos = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPos4));
const vWorld = varying(worldPos4.xyz as Node<d.vec3f>, 'v_world');

// fragment: ray from the camera through this surface point, marched through the box.
// `entry` (the interpolated world position) is a varying → must be a parameter.
const raymarch = Fn((entry: Node<d.vec3f>) => {
    const ro = cameraPosition;                              // world camera position (uniform)
    const rd = normalize(entry.sub(ro)).toVar('rd');

    // ray vs the box [-0.5, 0.5]^3 (robust slab method)
    const invD = vec3(f32(1), f32(1), f32(1)).div(rd).toVar('invD');
    const t0 = vec3(f32(-0.5), f32(-0.5), f32(-0.5)).sub(ro).mul(invD).toVar('t0');
    const t1 = vec3(f32(0.5), f32(0.5), f32(0.5)).sub(ro).mul(invD).toVar('t1');
    const tmin = min(t0, t1).toVar('tmin');
    const tmax = max(t0, t1).toVar('tmax');
    const tNear = max(max(tmin.x, tmin.y), tmin.z).max(f32(0)).toVar('tNear');
    const tFar = min(min(tmax.x, tmax.y), tmax.z).toVar('tFar');
    const dt = max(tFar.sub(tNear), f32(0)).div(f32(STEPS)).toVar('dt');

    const lightDir = normalize(vec3(f32(0.6), f32(0.7), f32(-0.4)));
    const lightStep = f32(1.0 / 24);

    const col = Var('col', vec3(f32(0), f32(0), f32(0)));
    const trans = Var('trans', f32(1)); // remaining view transmittance

    Loop(STEPS, ({ i }) => {
        const t = tNear.add(dt.mul(i.toF32())).toVar('t');
        const tc = ro.add(rd.mul(t)).add(f32(0.5)).toVar('tc'); // world [-0.5,0.5] → texcoord [0,1]
        const dens = densityAt(tc).toVar('dens');

        If(dens.greaterThan(f32(0.01)), () => {
            // shadow march: accumulate density toward the light, attenuate (Beer's law)
            const ldens = Var('ldens', f32(0));
            Loop(LIGHT_STEPS, ({ i: j }) => {
                ldens.addAssign(densityAt(tc.add(lightDir.mul(lightStep.mul(j.toF32().add(f32(1)))))));
            });
            const lightT = exp(ldens.mul(f32(-1.1))).toVar('lightT');
            const sun = vec3(f32(1.0), f32(0.85), f32(0.55)).mul(lightT);
            const ambient = vec3(f32(0.25), f32(0.35), f32(0.55)).mul(f32(0.45));
            const shade = sun.add(ambient);

            const aStep = clamp(dens.mul(f32(24)).mul(dt), f32(0), f32(1)).toVar('aStep');
            col.addAssign(shade.mul(aStep).mul(trans));
            trans.assign(trans.mul(f32(1).sub(aStep)));
        });
    });

    // composite over the (matching) background colour so the cube silhouette is seamless
    const bg = vec3(f32(BG[0]), f32(BG[1]), f32(BG[2]));
    return vec4(col.add(bg.mul(trans)), f32(1));
}, { name: 'raymarch', params: [{ name: 'entry', type: d.vec3f }], return: d.vec4f });

const material = new Material({ vertex: clipPos, fragment: raymarch(vWorld) });

/* renderer + scene */
const renderer = new WebGPURenderer({ antialias: true });
renderer.inspector = new Inspector();
await renderer.init();

document.body.appendChild(renderer.domElement);
document.body.appendChild((renderer.inspector as Inspector).domElement);
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.clearColor = [BG[0], BG[1], BG[2], 1];

const scene = new Scene();
const camera = new PerspectiveCamera(Math.PI / 4, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position[2] = 2.2;
scene.add(camera);
scene.add(new Mesh(createBoxGeometry(1, 1, 1), material));
scene.updateWorldMatrix();

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.update();

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

await renderer.compileCompute(fillVolume);

const scenePass = pass(scene, camera, { clearColor: [BG[0], BG[1], BG[2], 1] });
const outputNode = renderOutput(scenePass.getTextureNode(), { toneMapping: 'none' });
const renderPipeline = new RenderPipeline(renderer, outputNode);

function frame() {
    time.value = performance.now() / 1000;
    controls.update();          // orbit / damping
    camera.updateViewMatrix();  // camera moved → refresh its view matrix

    // compute rewrites the volume, then the render pass raymarches it
    renderer.compute([{ node: fillVolume, dispatch: [N / WG, N / WG, N / WG] }]);
    renderPipeline.render();
    requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
