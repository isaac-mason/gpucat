import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createPlaneGeometry,
    d,
    Fn,
    f32,
    Inspector,
    Material,
    Mesh,
    modelWorldMatrix,
    mul,
    type Node,
    OrbitControls,
    PerspectiveCamera,
    pass,
    RenderPipeline,
    renderOutput,
    Scene,
    timeElapsed,
    uniform,
    varying,
    vec2,
    vec3,
    vec4,
    WebGPURenderer,
    wgslFn,
} from 'gpucat';
import { quat } from 'mathcat';

// gradient (Perlin-style) noise — C1 continuous, no sharp zero-crossings

const noiseHash = wgslFn(
    `
fn noiseHash(n: i32) -> u32 {
    var v = u32(n);
    v = (v << 13u) ^ v;
    return v * (v * v * 15731u + 789221u) + 1376312589u;
}
`,
    { output: d.u32 },
);

const noiseGrad = wgslFn(
    `
fn noiseGrad(h: u32, x: f32, y: f32, z: f32) -> f32 {
    let hh = h & 15u;
    let u2 = select(y, x, hh < 8u);
    let v2 = select(select(x, y, hh == 12u || hh == 14u), z, hh < 4u);
    return select(-u2, u2, (hh & 1u) == 0u) + select(-v2, v2, (hh & 2u) == 0u);
}
`,
    { output: d.f32 },
);

const gradNoise3D = wgslFn(
    `
fn gradNoise3D(p: vec3f) -> f32 {
    let iv = vec3i(floor(p));
    let f  = fract(p);
    let u  = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

    let h000 = noiseHash(iv.x +     i32(noiseHash(iv.y     + i32(noiseHash(iv.z    )))));
    let h100 = noiseHash(iv.x + 1 + i32(noiseHash(iv.y     + i32(noiseHash(iv.z    )))));
    let h010 = noiseHash(iv.x +     i32(noiseHash(iv.y + 1 + i32(noiseHash(iv.z    )))));
    let h110 = noiseHash(iv.x + 1 + i32(noiseHash(iv.y + 1 + i32(noiseHash(iv.z    )))));
    let h001 = noiseHash(iv.x +     i32(noiseHash(iv.y     + i32(noiseHash(iv.z + 1)))));
    let h101 = noiseHash(iv.x + 1 + i32(noiseHash(iv.y     + i32(noiseHash(iv.z + 1)))));
    let h011 = noiseHash(iv.x +     i32(noiseHash(iv.y + 1 + i32(noiseHash(iv.z + 1)))));
    let h111 = noiseHash(iv.x + 1 + i32(noiseHash(iv.y + 1 + i32(noiseHash(iv.z + 1)))));

    let n000 = noiseGrad(h000, f.x,       f.y,       f.z      );
    let n100 = noiseGrad(h100, f.x - 1.0, f.y,       f.z      );
    let n010 = noiseGrad(h010, f.x,       f.y - 1.0, f.z      );
    let n110 = noiseGrad(h110, f.x - 1.0, f.y - 1.0, f.z      );
    let n001 = noiseGrad(h001, f.x,       f.y,       f.z - 1.0);
    let n101 = noiseGrad(h101, f.x - 1.0, f.y,       f.z - 1.0);
    let n011 = noiseGrad(h011, f.x,       f.y - 1.0, f.z - 1.0);
    let n111 = noiseGrad(h111, f.x - 1.0, f.y - 1.0, f.z - 1.0);

    return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
               mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
`,
    { output: d.f32 },
    [noiseHash, noiseGrad],
);

// uniforms

const uFreqX = uniform(f32(3.0), 'freqX');
const uFreqZ = uniform(f32(1.5), 'freqZ');
const uSpeed = uniform(f32(1.0), 'speed');
const uAmp = uniform(f32(0.15), 'amplitude');

const uSmallFreq = uniform(f32(2.0), 'smallFreq');
const uSmallSpeed = uniform(f32(0.3), 'smallSpeed');
const uSmallAmp = uniform(f32(0.18), 'smallAmp');

// wavesElevation: large sine + small noise octaves (via Fn)
// note: uses x,y as horizontal coords (plane is XY, rotated to XZ in world space)
const wavesElevation = Fn(
    (pos, t, freqX, freqZ, speed, amp, sFreq, sSpeed, sAmp) => {
        const elev = pos.x
            .mul(freqX)
            .add(t.mul(speed))
            .sin()
            .mul(pos.y.mul(freqZ).add(t.mul(speed)).sin())
            .mul(amp)
            .toVar('elev');

        // 3 octaves of value noise for small waves
        for (let oct = 1; oct <= 3; oct++) {
            const scale = f32(oct);
            const noiseInput = vec3(
                pos.xy
                    .add(vec2(f32(2), f32(2)))
                    .mul(sFreq)
                    .mul(scale),
                t.mul(sSpeed),
            );
            const wave = gradNoise3D(noiseInput).mul(sAmp).div(scale);
            elev.assign(elev.sub(wave));
        }

        return elev;
    },
    {
        name: 'wavesElevation',
        params: [
            { name: 'pos', type: d.vec3f },
            { name: 't', type: d.f32 },
            { name: 'freqX', type: d.f32 },
            { name: 'freqZ', type: d.f32 },
            { name: 'speed', type: d.f32 },
            { name: 'amp', type: d.f32 },
            { name: 'sFreq', type: d.f32 },
            { name: 'sSpeed', type: d.f32 },
            { name: 'sAmp', type: d.f32 },
        ],
    },
);

function elev(pos: Node<d.vec3f>): Node<d.f32> {
    return wavesElevation(pos, timeElapsed, uFreqX, uFreqZ, uSpeed, uAmp, uSmallFreq, uSmallSpeed, uSmallAmp) as Node<d.f32>;
}

/* vertex */
// plane is XY with z=0, rotated -90° around X to become XZ ground plane
// elevation goes into local z, which becomes world y after rotation

const positionAttr = attribute('position', d.vec3f);
const px = positionAttr.x as Node<d.f32>;
const py = positionAttr.y as Node<d.f32>;
const shift = f32(0.01);

const displacedPos = vec3(px, py, elev(positionAttr as Node<d.vec3f>));
const posA = vec3(px.add(shift), py, elev(vec3(px.add(shift), py, f32(0)) as Node<d.vec3f>));
const posB = vec3(px, py.sub(shift), elev(vec3(px, py.sub(shift), f32(0)) as Node<d.vec3f>));

// tangent vectors → cross product → normal
const toA = posA.sub(displacedPos).normalize();
const toB = posB.sub(displacedPos).normalize();
const normal = toB.cross(toA).normalize();

const vNormal = varying(normal, 'v_normal');
const vElevation = varying(displacedPos.z, 'v_elevation');

const clipPos = mul(cameraProjectionMatrix, mul(cameraViewMatrix, mul(modelWorldMatrix, vec4(displacedPos, f32(1)))));

/* fragment */

// diffuse
const lightDir = vec3(f32(-0.6), f32(1.0), f32(0.8)).normalize().toVar('lightDir');
const diffuse = vNormal.dot(lightDir).max(f32(0.05)).toVar('diffuse');

// specular
const viewDir = vec3(f32(0), f32(1), f32(0)).toVar('viewDir');
const halfVec = lightDir.add(viewDir).normalize().toVar('halfVec');
const specular = vNormal.dot(halfVec).max(f32(0)).pow(f32(64)).mul(f32(0.4)).toVar('specular');

// flat dark purple base colour (matches Three.js #271442)
const baseColor = vec3(f32(0.153), f32(0.078), f32(0.259)).toVar('baseColor');
const litColor = baseColor
    .mul(diffuse)
    .add(vec3(f32(1), f32(1), f32(1)).mul(specular))
    .toVar('litColor');

// emissive foam: glows at TROUGHS (low elevation) — matches Three.js remap(high, low)
// elevation.remap(emissiveHigh, emissiveLow) = (elev - high) / (low - high), clamped 0..1
const emissiveColor = vec3(f32(1.0), f32(0.039), f32(0.506)).toVar('emissiveColor'); // #ff0a81
const emissiveLow = f32(-0.25);
const emissiveHigh = f32(0.2);
const emissivePower = f32(7.0);
const emissiveT = vElevation.sub(emissiveHigh).div(emissiveLow.sub(emissiveHigh)).clamp(f32(0), f32(1)).toVar('emissiveT');
const emissive = emissiveColor.mul(emissiveT.pow(emissivePower)).toVar('emissive');

const finalColor = vec4(litColor.add(emissive), f32(1)).toVar('finalColor');

const material = new Material({ vertex: clipPos, fragment: finalColor });

/* renderer and scene */

const renderer = new WebGPURenderer({ antialias: true });
renderer.inspector = new Inspector();
await renderer.init();

document.body.appendChild(renderer.domElement);
document.body.appendChild((renderer.inspector as Inspector).domElement);
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);

renderer.clearColor = [0.05, 0.04, 0.1, 1];

const scene = new Scene();

const camera = new PerspectiveCamera(Math.PI / 4, window.innerWidth / window.innerHeight, 0.1, 50);
camera.position[0] = 1.4;
camera.position[1] = 1.2;
camera.position[2] = 1.4;
scene.add(camera);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target[1] = 0;
controls.enableDamping = true;
controls.update();

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

const geometry = createPlaneGeometry(4, 4, 256, 256);
const mesh = new Mesh(geometry, material);
// rotate XY plane to XZ orientation for water surface
quat.rotateX(mesh.quaternion, mesh.quaternion, -Math.PI / 2);
scene.add(mesh);

scene.updateWorldMatrix();
camera.updateViewMatrix();

const inspector = renderer.inspector as Inspector;

const waveParams = inspector.createParameters('Waves');
waveParams.add(uFreqX, 'value', 0.1, 10, 0.1).name('Frequency X');
waveParams.add(uFreqZ, 'value', 0.1, 10, 0.1).name('Frequency Y');
waveParams.add(uSpeed, 'value', 0.0, 5.0, 0.05).name('Speed');
waveParams.add(uAmp, 'value', 0.0, 1.0, 0.01).name('Amplitude');
const smallParams = inspector.createParameters('Small Waves');
smallParams.add(uSmallFreq, 'value', 0.1, 10, 0.1).name('Frequency');
smallParams.add(uSmallSpeed, 'value', 0.0, 5.0, 0.05).name('Speed');
smallParams.add(uSmallAmp, 'value', 0.0, 1.0, 0.01).name('Amplitude');

const scenePass = pass(scene, camera);
const outputNode = renderOutput(scenePass.getTextureNode());
const renderPipeline = new RenderPipeline(renderer, outputNode);

function frame() {
    renderer.beginFrame();
    controls.update();
    scene.updateWorldMatrix();
    camera.updateViewMatrix();
    renderPipeline.render();
    renderer.endFrame();
    requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
