import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createSubdividedPlaneGeometry,
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
    timeElapsed,
    uniform,
    vec2,
    vec3,
    vec3f,
    vec4,
    varying,
    WebGPURenderer,
    wgslFn,
    type Node,
    type WgslType,
} from 'gpucat';

// ---------------------------------------------------------------------------
// Noise — smooth hash-based 3-D value noise, implemented in raw WGSL.
//
// hash3 and valueNoise3D are split into separate wgslFn calls so that the
// compiler emits them as two distinct top-level WGSL functions.  hash3 is
// passed as an `includes` dependency of valueNoise3D so it is guaranteed to
// appear first in the emitted shader.
// ---------------------------------------------------------------------------

const hash3 = wgslFn<'f32'>(/* wgsl */ `
fn hash3(p: vec3f) -> f32 {
    var q: vec3f = fract(p * vec3f(127.1, 311.7, 74.7));
    q = q + dot(q, q + 19.19);
    return fract(q.x * q.y * q.z);
}
`);

// valueNoise3D declares hash3 as an include so the compiler emits hash3
// before valueNoise3D in the final WGSL module.
const valueNoise3D = wgslFn<'f32'>(/* wgsl */ `
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

// ---------------------------------------------------------------------------
// Wave elevation function (named, so it can be called twice for normals).
//
// All ten parameters come in as generic Node<WgslType> because the Fn overload
// without a layout descriptor accepts Node<WgslType> args. We annotate
// the correct types in the FnLayout.
// ---------------------------------------------------------------------------

const wavesElevation = Fn(
    (
        pos:     Node<WgslType>,
        t:       Node<WgslType>,
        lwFreqX: Node<WgslType>,
        lwFreqZ: Node<WgslType>,
        lwSpeed: Node<WgslType>,
        lwMult:  Node<WgslType>,
        swIter:  Node<WgslType>,
        swFreq:  Node<WgslType>,
        swSpeed: Node<WgslType>,
        swMult:  Node<WgslType>,
    ) => {
        // Cast to well-typed nodes for the methods we need.
        const p   = pos   as Node<'vec3f'>;
        const tm  = t     as Node<'f32'>;
        const lfx = lwFreqX as Node<'f32'>;
        const lfz = lwFreqZ as Node<'f32'>;
        const ls  = lwSpeed as Node<'f32'>;
        const lm  = lwMult  as Node<'f32'>;
        const si  = swIter  as Node<'f32'>;
        const sf  = swFreq  as Node<'f32'>;
        const ss  = swSpeed as Node<'f32'>;
        const sm  = swMult  as Node<'f32'>;

        // Large waves: product of two orthogonal sine waves.
        const elevation = p.x.mul(lfx).add(tm.mul(ls)).sin()
            .mul(p.z.mul(lfz).add(tm.mul(ls)).sin())
            .mul(lm)
            .toVar('elevation');

        // Small waves: 4 octaves of value noise (octaves beyond swIter are zeroed
        // by multiplying with step(scale, swIter), i.e. scale <= swIter).
        for (let octave = 1; octave <= 4; octave++) {
            const scale = f32(octave);
            // step(edge, x) → 1 if x >= edge, else 0.  We want active=1 when octave <= swIter.
            const active = scale.lte(si);
            const noiseInput = vec3(
                p.xz.add(vec2(f32(2), f32(2))).mul(sf).mul(scale),
                tm.mul(ss),
            );
            const wave = valueNoise3D(noiseInput)
                .mul(sm)
                .div(scale)
                .abs();
            elevation.assign(elevation.sub(wave.mul(active.toF32())));
        }

        return elevation;
    },
    {
        name: 'wavesElevation',
        params: [
            { name: 'pos',     type: d.vec3f },
            { name: 't',       type: d.f32 },
            { name: 'lwFreqX', type: d.f32 },
            { name: 'lwFreqZ', type: d.f32 },
            { name: 'lwSpeed', type: d.f32 },
            { name: 'lwMult',  type: d.f32 },
            { name: 'swIter',  type: d.f32 },
            { name: 'swFreq',  type: d.f32 },
            { name: 'swSpeed', type: d.f32 },
            { name: 'swMult',  type: d.f32 },
        ],
    },
);

// ---------------------------------------------------------------------------
// Uniforms — tunable wave parameters (all in objectGroup by default).
// ---------------------------------------------------------------------------

const uLargeWavesFreqX = uniform(f32(3.0),  'largeWavesFreqX');
const uLargeWavesFreqZ = uniform(f32(1.5),  'largeWavesFreqZ');
const uLargeWavesSpeed = uniform(f32(1.25), 'largeWavesSpeed');
const uLargeWavesMult  = uniform(f32(0.15), 'largeWavesMult');

const uSmallWavesIter  = uniform(f32(3.0),  'smallWavesIter');
const uSmallWavesFreq  = uniform(f32(2.0),  'smallWavesFreq');
const uSmallWavesSpeed = uniform(f32(0.3),  'smallWavesSpeed');
const uSmallWavesMult  = uniform(f32(0.18), 'smallWavesMult');

const uNormalShift     = uniform(f32(0.01), 'normalShift');

// vec3f uniforms for colour (constructed, not const literal — hence ConstructNode).
const uEmissiveColor   = uniform(vec3f(1.0, 0.04, 0.50), 'emissiveColor') as Node<'vec3f'>;
const uEmissiveLow     = uniform(f32(-0.25), 'emissiveLow');
const uEmissiveHigh    = uniform(f32(0.2),   'emissiveHigh');
const uEmissivePower   = uniform(f32(7.0),   'emissivePower');
const uWaterColor      = uniform(vec3f(0.15, 0.08, 0.26), 'waterColor') as Node<'vec3f'>;

// ---------------------------------------------------------------------------
// Helper — call wavesElevation bound to all uniforms for a given position.
// ---------------------------------------------------------------------------

function elevation(pos: Node<'vec3f'>): Node<WgslType> {
    return wavesElevation(
        pos,
        timeElapsed,
        uLargeWavesFreqX,
        uLargeWavesFreqZ,
        uLargeWavesSpeed,
        uLargeWavesMult,
        uSmallWavesIter,
        uSmallWavesFreq,
        uSmallWavesSpeed,
        uSmallWavesMult,
    ) as unknown as Node<WgslType>;
}

// ---------------------------------------------------------------------------
// Vertex shader
// ---------------------------------------------------------------------------

const positionAttr = attribute(d.vec3f, 'position');

// Displaced local-space position — wave function modifies the Y component.
const localPos  = vec3(positionAttr.x, elevation(positionAttr) as Node<'f32'>, positionAttr.z);
const clipPos   = mul(cameraProjectionMatrix, mul(cameraViewMatrix, mul(modelWorldMatrix, vec4(localPos, f32(1)))));

// Finite-difference normals.
const shift = uNormalShift;
const posA  = vec3(positionAttr.x.add(shift), elevation(vec3(positionAttr.x.add(shift), f32(0), positionAttr.z)) as Node<'f32'>,      positionAttr.z);
const posB  = vec3(positionAttr.x,            elevation(vec3(positionAttr.x, f32(0), positionAttr.z.add(shift))) as Node<'f32'>, positionAttr.z.add(shift));

const toA        = posA.sub(localPos).normalize();
const toB        = posB.sub(localPos).normalize();
const worldNormal = toA.cross(toB).normalize();

const vElevation = varying(d.f32,   'v_elevation', localPos.y);
const vNormal    = varying(d.vec3f, 'v_normal',    worldNormal);

// ---------------------------------------------------------------------------
// Fragment shader — lambert diffuse + Blinn-Phong specular + emissive crests
// ---------------------------------------------------------------------------

const lightDir = vec3(f32(-0.6), f32(1.0), f32(0.8)).normalize();

const diffuse  = vNormal.dot(lightDir).max(f32(0.05));
const viewDir  = vec3(f32(0), f32(1), f32(0));
const halfVec  = lightDir.add(viewDir).normalize();
const specular = vNormal.dot(halfVec).max(f32(0)).pow(f32(64)).mul(f32(0.4));

const litColor = uWaterColor.mul(diffuse).add(vec3(f32(1), f32(1), f32(1)).mul(specular));

// Remap elevation [emissiveHigh → emissiveLow] → [0 → 1], then power.
const t01     = vElevation.sub(uEmissiveHigh).div(uEmissiveLow.sub(uEmissiveHigh)).clamp(f32(0), f32(1));
const emissive = uEmissiveColor.mul(t01.pow(uEmissivePower));

const finalColor = vec4(litColor.add(emissive), f32(1));

// ---------------------------------------------------------------------------
// Material
// ---------------------------------------------------------------------------

const material = new Material({ vertex: clipPos, fragment: finalColor });

// ---------------------------------------------------------------------------
// Scene & renderer
// ---------------------------------------------------------------------------

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
    controls.target[1] = -0.15;
    controls.enableDamping = true;
    controls.minDistance = 0.5;
    controls.maxDistance = 20;
    controls.update();

    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth, window.innerHeight);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    });

    // 128×128 grid — smooth enough for displacement, reasonable vertex count.
    const geometry = createSubdividedPlaneGeometry(4, 4, 128, 128);
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
