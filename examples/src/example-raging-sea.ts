import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createPlaneGeometry,
    d,
    f32,
    Fn,
    Inspector,
    Material,
    Mesh,
    modelWorldMatrix,
    mul,
    OrbitControls,
    pass,
    PerspectiveCamera,
    Scene,
    uniform,
    vec2,
    vec3,
    timeElapsed,
    varying,
    vec4,
    WebGPURenderer,
    wgslFn,
    type Node,
    type WgslType,
} from 'gpucat';

// ─────────────────────────────────────────────────────────────────────────────
// Value noise (raw WGSL)
// ─────────────────────────────────────────────────────────────────────────────

const hash3 = wgslFn<'f32'>(`
fn hash3(p: vec3f) -> f32 {
    var q: vec3f = fract(p * vec3f(127.1, 311.7, 74.7));
    q = q + dot(q, q + 19.19);
    return fract(q.x * q.y * q.z);
}
`);

const valueNoise3D = wgslFn<'f32'>(`
fn valueNoise3D(p: vec3f) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);

    let n000 = hash3(i + vec3f(0.0, 0.0, 0.0));
    let n100 = hash3(i + vec3f(1.0, 0.0, 0.0));
    let n010 = hash3(i + vec3f(0.0, 1.0, 0.0));
    let n110 = hash3(i + vec3f(1.0, 1.0, 0.0));
    let n001 = hash3(i + vec3f(0.0, 0.0, 1.0));
    let n101 = hash3(i + vec3f(1.0, 0.0, 1.0));
    let n011 = hash3(i + vec3f(0.0, 1.0, 1.0));
    let n111 = hash3(i + vec3f(1.0, 1.0, 1.0));

    let k0  = mix(n000, n100, u.x);
    let k1  = mix(n010, n110, u.x);
    let k2  = mix(n001, n101, u.x);
    let k3  = mix(n011, n111, u.x);
    let k01 = mix(k0, k1, u.y);
    let k23 = mix(k2, k3, u.y);
    let v   = mix(k01, k23, u.z);

    return v * 2.0 - 1.0;
}
`, [hash3]);

// ─────────────────────────────────────────────────────────────────────────────
// Uniforms
// ─────────────────────────────────────────────────────────────────────────────

const uFreqX       = uniform(f32(3.0),  'freqX');
const uFreqZ       = uniform(f32(1.5),  'freqZ');
const uSpeed       = uniform(f32(1.0),  'speed');
const uAmp         = uniform(f32(0.15), 'amplitude');

const uSmallFreq   = uniform(f32(2.0),  'smallFreq');
const uSmallSpeed  = uniform(f32(0.3),  'smallSpeed');
const uSmallAmp    = uniform(f32(0.18), 'smallAmp');

// ─────────────────────────────────────────────────────────────────────────────
// wavesElevation: large sine + small noise octaves (via Fn)
// ─────────────────────────────────────────────────────────────────────────────

const wavesElevation = Fn(
    (
        pos:    Node<WgslType>,
        t:      Node<WgslType>,
        freqX:  Node<WgslType>,
        freqZ:  Node<WgslType>,
        speed:  Node<WgslType>,
        amp:    Node<WgslType>,
        sFreq:  Node<WgslType>,
        sSpeed: Node<WgslType>,
        sAmp:   Node<WgslType>,
    ) => {
        const p  = pos   as Node<'vec3f'>;
        const tm = t     as Node<'f32'>;
        const fx = freqX as Node<'f32'>;
        const fz = freqZ as Node<'f32'>;
        const sp = speed as Node<'f32'>;
        const am = amp   as Node<'f32'>;
        const sf = sFreq  as Node<'f32'>;
        const ss = sSpeed as Node<'f32'>;
        const sa = sAmp   as Node<'f32'>;

        const elev = p.x.mul(fx).add(tm.mul(sp)).sin()
            .mul(p.z.mul(fz).add(tm.mul(sp)).sin())
            .mul(am)
            .toVar('elev');

        // 3 octaves of value noise for small waves
        for (let oct = 1; oct <= 3; oct++) {
            const scale = f32(oct);
            const noiseInput = vec3(
                p.xz.add(vec2(f32(2), f32(2))).mul(sf).mul(scale),
                tm.mul(ss),
            );
            const wave = valueNoise3D(noiseInput).mul(sa).div(scale).abs();
            elev.assign(elev.sub(wave));
        }

        return elev;
    },
    {
        name: 'wavesElevation',
        params: [
            { name: 'pos',    type: d.vec3f },
            { name: 't',      type: d.f32 },
            { name: 'freqX',  type: d.f32 },
            { name: 'freqZ',  type: d.f32 },
            { name: 'speed',  type: d.f32 },
            { name: 'amp',    type: d.f32 },
            { name: 'sFreq',  type: d.f32 },
            { name: 'sSpeed', type: d.f32 },
            { name: 'sAmp',   type: d.f32 },
        ],
    },
);

function elev(pos: Node<'vec3f'>): Node<'f32'> {
    return wavesElevation(
        pos, timeElapsed,
        uFreqX, uFreqZ, uSpeed, uAmp,
        uSmallFreq, uSmallSpeed, uSmallAmp,
    ) as Node<'f32'>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vertex graph
// ─────────────────────────────────────────────────────────────────────────────

const positionAttr = attribute(d.vec3f, 'position');
const px    = positionAttr.x as Node<'f32'>;
const pz    = positionAttr.z as Node<'f32'>;
const shift = f32(0.01);

const displacedPos = vec3(px,            elev(positionAttr as Node<'vec3f'>),                                                   pz);
const posA         = vec3(px.add(shift), elev(vec3(px.add(shift), f32(0), pz)             as Node<'vec3f'>),  pz);
const posB         = vec3(px,            elev(vec3(px,             f32(0), pz.sub(shift))  as Node<'vec3f'>),  pz.sub(shift));

// Tangent vectors → cross product → normal (matches Three.js toA.cross(toB))
const toA    = posA.sub(displacedPos).normalize();
const toB    = posB.sub(displacedPos).normalize();
const normal = toA.cross(toB).normalize();

const vNormal    = varying(d.vec3f, 'v_normal',    normal);
const vElevation = varying(d.f32,   'v_elevation', displacedPos.y as Node<'f32'>);

const clipPos = mul(cameraProjectionMatrix, mul(cameraViewMatrix, mul(modelWorldMatrix, vec4(displacedPos, f32(1)))));

// ─────────────────────────────────────────────────────────────────────────────
// Fragment graph
// ─────────────────────────────────────────────────────────────────────────────

// Diffuse
const lightDir = vec3(f32(-0.6), f32(1.0), f32(0.8)).normalize();
const diffuse  = vNormal.dot(lightDir).max(f32(0.05));

// Specular
const viewDir  = vec3(f32(0), f32(1), f32(0));
const halfVec  = lightDir.add(viewDir).normalize();
const specular = vNormal.dot(halfVec).max(f32(0)).pow(f32(64)).mul(f32(0.4));

// Flat dark purple base colour (matches Three.js #271442)
const baseColor = vec3(f32(0.153), f32(0.078), f32(0.259));
const litColor  = baseColor.mul(diffuse).add(vec3(f32(1), f32(1), f32(1)).mul(specular));

// Emissive foam: glows at TROUGHS (low elevation) — matches Three.js remap(high, low)
// elevation.remap(emissiveHigh, emissiveLow) = (elev - high) / (low - high), clamped 0..1
const emissiveColor = vec3(f32(1.0), f32(0.039), f32(0.506)); // #ff0a81
const emissiveLow   = f32(-0.25);
const emissiveHigh  = f32(0.2);
const emissivePower = f32(7.0);
const emissiveT     = vElevation.sub(emissiveHigh).div(emissiveLow.sub(emissiveHigh)).clamp(f32(0), f32(1));
const emissive      = emissiveColor.mul(emissiveT.pow(emissivePower));

const finalColor = vec4(litColor.add(emissive), f32(1));

// ─────────────────────────────────────────────────────────────────────────────
// Material
// ─────────────────────────────────────────────────────────────────────────────

const material = new Material({ vertex: clipPos, fragment: finalColor });

// ─────────────────────────────────────────────────────────────────────────────
// Scene setup
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
    const renderer = new WebGPURenderer({ antialias: true });
    renderer.inspector = new Inspector();
    await renderer.init();

    document.body.appendChild(renderer.domElement);
    document.body.appendChild((renderer.inspector as Inspector).domElement);
    renderer.setPixelRatio(devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);

    renderer.clearColor = [0.05, 0.04, 0.10, 1];

    const scene = new Scene();

    const camera = new PerspectiveCamera(
        Math.PI / 4,
        window.innerWidth / window.innerHeight,
        0.1,
        50,
    );
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

    const geometry = createPlaneGeometry(4, 4, 128, 128);
    const mesh = new Mesh(geometry, material);
    scene.add(mesh);

    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    const scenePass  = pass(scene, camera);
    const outputNode = scenePass.getTextureNode();

    function frame() {
        controls.update();
        scene.updateWorldMatrix();
        camera.updateViewMatrix();
        renderer.render(outputNode);
        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

main().catch(console.error);
