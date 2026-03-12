import {
    attribute,
    cameraPosition,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createPlaneGeometry,
    d,
    Fn,
    f32,
    Inspector,
    Material,
    Mesh,
    modelNormalMatrix,
    modelWorldMatrix,
    mul,
    normalize,
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

// gradient (Perlin-style) noise with analytical derivatives
// returns vec4(noise, dNoise/dx, dNoise/dy, dNoise/dz)

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
fn noiseGrad(h: u32) -> vec3f {
    let hh = h & 15u;
    let u = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), hh < 8u);
    let v = select(select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), hh == 12u || hh == 14u), vec3f(0.0, 0.0, 1.0), hh < 4u);
    let su = select(-1.0, 1.0, (hh & 1u) == 0u);
    let sv = select(-1.0, 1.0, (hh & 2u) == 0u);
    return u * su + v * sv;
}
`,
    { output: d.vec3f },
);

const gradNoise3DWithDerivatives = wgslFn(
    `
fn gradNoise3DWithDerivatives(p: vec3f) -> vec4f {
    let iv = vec3i(floor(p));
    let f  = fract(p);
    
    // quintic interpolation and its derivative
    let u  = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);

    // hash corners
    let h000 = noiseHash(iv.x +     i32(noiseHash(iv.y     + i32(noiseHash(iv.z    )))));
    let h100 = noiseHash(iv.x + 1 + i32(noiseHash(iv.y     + i32(noiseHash(iv.z    )))));
    let h010 = noiseHash(iv.x +     i32(noiseHash(iv.y + 1 + i32(noiseHash(iv.z    )))));
    let h110 = noiseHash(iv.x + 1 + i32(noiseHash(iv.y + 1 + i32(noiseHash(iv.z    )))));
    let h001 = noiseHash(iv.x +     i32(noiseHash(iv.y     + i32(noiseHash(iv.z + 1)))));
    let h101 = noiseHash(iv.x + 1 + i32(noiseHash(iv.y     + i32(noiseHash(iv.z + 1)))));
    let h011 = noiseHash(iv.x +     i32(noiseHash(iv.y + 1 + i32(noiseHash(iv.z + 1)))));
    let h111 = noiseHash(iv.x + 1 + i32(noiseHash(iv.y + 1 + i32(noiseHash(iv.z + 1)))));

    // gradients
    let g000 = noiseGrad(h000); let g100 = noiseGrad(h100);
    let g010 = noiseGrad(h010); let g110 = noiseGrad(h110);
    let g001 = noiseGrad(h001); let g101 = noiseGrad(h101);
    let g011 = noiseGrad(h011); let g111 = noiseGrad(h111);

    // corner vectors and their dots with gradients
    let p000 = f;
    let p100 = f - vec3f(1.0, 0.0, 0.0);
    let p010 = f - vec3f(0.0, 1.0, 0.0);
    let p110 = f - vec3f(1.0, 1.0, 0.0);
    let p001 = f - vec3f(0.0, 0.0, 1.0);
    let p101 = f - vec3f(1.0, 0.0, 1.0);
    let p011 = f - vec3f(0.0, 1.0, 1.0);
    let p111 = f - vec3f(1.0, 1.0, 1.0);

    let n000 = dot(g000, p000); let n100 = dot(g100, p100);
    let n010 = dot(g010, p010); let n110 = dot(g110, p110);
    let n001 = dot(g001, p001); let n101 = dot(g101, p101);
    let n011 = dot(g011, p011); let n111 = dot(g111, p111);

    // trilinear interpolation of noise value
    let nx00 = mix(n000, n100, u.x);
    let nx10 = mix(n010, n110, u.x);
    let nx01 = mix(n001, n101, u.x);
    let nx11 = mix(n011, n111, u.x);
    let nxy0 = mix(nx00, nx10, u.y);
    let nxy1 = mix(nx01, nx11, u.y);
    let noise = mix(nxy0, nxy1, u.z);

    // analytical derivatives
    // d(noise)/dx = du.x * (lerp contribution) + (gradient x components interpolated)
    let gx00 = mix(g000.x, g100.x, u.x);
    let gx10 = mix(g010.x, g110.x, u.x);
    let gx01 = mix(g001.x, g101.x, u.x);
    let gx11 = mix(g011.x, g111.x, u.x);
    let gxy0_x = mix(gx00, gx10, u.y);
    let gxy1_x = mix(gx01, gx11, u.y);
    
    let gy00 = mix(g000.y, g100.y, u.x);
    let gy10 = mix(g010.y, g110.y, u.x);
    let gy01 = mix(g001.y, g101.y, u.x);
    let gy11 = mix(g011.y, g111.y, u.x);
    let gxy0_y = mix(gy00, gy10, u.y);
    let gxy1_y = mix(gy01, gy11, u.y);
    
    let gz00 = mix(g000.z, g100.z, u.x);
    let gz10 = mix(g010.z, g110.z, u.x);
    let gz01 = mix(g001.z, g101.z, u.x);
    let gz11 = mix(g011.z, g111.z, u.x);
    let gxy0_z = mix(gz00, gz10, u.y);
    let gxy1_z = mix(gz01, gz11, u.y);

    // derivative from chain rule: interpolation derivative + gradient contribution
    let dnx00 = n100 - n000;
    let dnx10 = n110 - n010;
    let dnx01 = n101 - n001;
    let dnx11 = n111 - n011;
    let dnxy0_x = mix(dnx00, dnx10, u.y);
    let dnxy1_x = mix(dnx01, dnx11, u.y);
    
    let dny0 = nx10 - nx00;
    let dny1 = nx11 - nx01;
    
    let dnz = nxy1 - nxy0;

    let dx = du.x * mix(dnxy0_x, dnxy1_x, u.z) + mix(gxy0_x, gxy1_x, u.z);
    let dy = du.y * mix(dny0, dny1, u.z) + mix(gxy0_y, gxy1_y, u.z);
    let dz = du.z * dnz + mix(gxy0_z, gxy1_z, u.z);

    return vec4f(noise, dx, dy, dz);
}
`,
    { output: d.vec4f },
    [noiseHash, noiseGrad],
);

// uniforms

const uFreqX = uniform(f32(3.0), 'freqX');
const uFreqY = uniform(f32(1.5), 'freqY');
const uSpeed = uniform(f32(1.0), 'speed');
const uAmp = uniform(f32(0.15), 'amplitude');

const uSmallFreq = uniform(f32(2.0), 'smallFreq');
const uSmallSpeed = uniform(f32(0.3), 'smallSpeed');
const uSmallAmp = uniform(f32(0.18), 'smallAmp');

// wavesElevation: returns vec3(elevation, dElev/dx, dElev/dy)
const wavesElevationWithGradient = Fn(
    (pos, t, freqX, freqY, speed, amp, sFreq, sSpeed, sAmp) => {
        // large sine waves: sin(x*freqX + t*speed) * sin(y*freqY + t*speed) * amp
        const phaseX = pos.x.mul(freqX).add(t.mul(speed));
        const phaseY = pos.y.mul(freqY).add(t.mul(speed));
        const sinX = phaseX.sin();
        const cosX = phaseX.cos();
        const sinY = phaseY.sin();
        const cosY = phaseY.cos();

        const elev = sinX.mul(sinY).mul(amp).toVar('elev');
        // d/dx = cos(phaseX)*freqX * sin(phaseY) * amp
        const dElevDx = cosX.mul(freqX).mul(sinY).mul(amp).toVar('dElevDx');
        // d/dy = sin(phaseX) * cos(phaseY)*freqY * amp
        const dElevDy = sinX.mul(cosY).mul(freqY).mul(amp).toVar('dElevDy');

        // 3 octaves of gradient noise for small waves
        for (let oct = 1; oct <= 3; oct++) {
            const scale = f32(oct);
            const freqScale = sFreq.mul(scale);
            const noiseInput = vec3(
                pos.add(vec2(f32(2), f32(2))).mul(freqScale),
                t.mul(sSpeed),
            );
            // returns vec4(noise, dNoise/dx, dNoise/dy, dNoise/dz)
            const noiseResult = gradNoise3DWithDerivatives(noiseInput);
            const ampScale = sAmp.div(scale);
            
            elev.assign(elev.sub(noiseResult.x.mul(ampScale)));
            // chain rule: dElev/dx = -dNoise/dx * freqScale * ampScale
            dElevDx.assign(dElevDx.sub(noiseResult.y.mul(freqScale).mul(ampScale)));
            dElevDy.assign(dElevDy.sub(noiseResult.z.mul(freqScale).mul(ampScale)));
        }

        return vec3(elev, dElevDx, dElevDy);
    },
    {
        name: 'wavesElevationWithGradient',
        params: [
            { name: 'pos', type: d.vec2f },
            { name: 't', type: d.f32 },
            { name: 'freqX', type: d.f32 },
            { name: 'freqY', type: d.f32 },
            { name: 'speed', type: d.f32 },
            { name: 'amp', type: d.f32 },
            { name: 'sFreq', type: d.f32 },
            { name: 'sSpeed', type: d.f32 },
            { name: 'sAmp', type: d.f32 },
        ],
    },
);

function elevWithGradient(pos: Node<d.vec2f>): Node<d.vec3f> {
    return wavesElevationWithGradient(pos, timeElapsed, uFreqX, uFreqY, uSpeed, uAmp, uSmallFreq, uSmallSpeed, uSmallAmp) as Node<d.vec3f>;
}

function elev(pos: Node<d.vec2f>): Node<d.f32> {
    return elevWithGradient(pos).x as Node<d.f32>;
}

/* vertex */
// plane is XY with z=0, rotated -90° around X to become XZ ground plane
// elevation goes into local z, which becomes world y after rotation

const positionAttr = attribute('position', d.vec3f);
const px = positionAttr.x as Node<d.f32>;
const py = positionAttr.y as Node<d.f32>;

const displacedPos = vec3(px, py, elev(vec2(px, py)));

// pass local xy to fragment for per-pixel normal computation
const vLocalPos = varying(vec2(px, py), 'v_localPos');

// world position for view direction calculation
const worldPos = mul(modelWorldMatrix, vec4(displacedPos, f32(1)));
const vWorldPos = varying(vec3(worldPos.x, worldPos.y, worldPos.z), 'v_worldPos');

const clipPos = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPos));

/* fragment */

// compute normal per-fragment using analytical gradient
const fragPos = vec2(vLocalPos.x, vLocalPos.y);
const elevResult = elevWithGradient(fragPos);
const fragElev = elevResult.x;
const dElevDx = elevResult.y;
const dElevDy = elevResult.z;

// local normal from gradient: N = normalize(-dz/dx, -dz/dy, 1)
// since elevation is in z, tangent in x is (1, 0, dz/dx), tangent in y is (0, 1, dz/dy)
// normal = cross(tangentY, tangentX) = (-dz/dx, -dz/dy, 1)
const localNormal = vec3(dElevDx.negate(), dElevDy.negate(), f32(1)).normalize();

// transform normal to world space
const normal = normalize(mul(modelNormalMatrix, localNormal)).toVar('normal');

// diffuse
const lightDir = vec3(f32(-0.6), f32(1.0), f32(0.8)).normalize().toVar('lightDir');
const diffuse = normal.dot(lightDir).max(f32(0.05)).toVar('diffuse');

// specular
const viewDir = cameraPosition.sub(vWorldPos).normalize().toVar('viewDir');
const halfVec = lightDir.add(viewDir).normalize().toVar('halfVec');
const specular = normal.dot(halfVec).max(f32(0)).pow(f32(64)).mul(f32(0.4)).toVar('specular');

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
const emissiveT = fragElev.sub(emissiveHigh).div(emissiveLow.sub(emissiveHigh)).clamp(f32(0), f32(1)).toVar('emissiveT');
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

const geometry = createPlaneGeometry(4, 4, 128, 128);
const mesh = new Mesh(geometry, material);
// rotate XY plane to XZ orientation for water surface
quat.rotateX(mesh.quaternion, mesh.quaternion, -Math.PI / 2);
scene.add(mesh);

scene.updateWorldMatrix();
camera.updateViewMatrix();

const inspector = renderer.inspector as Inspector;

const waveParams = inspector.createParameters('Waves');
waveParams.add(uFreqX, 'value', 0.1, 10, 0.1).name('Frequency X');
waveParams.add(uFreqY, 'value', 0.1, 10, 0.1).name('Frequency Y');
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
