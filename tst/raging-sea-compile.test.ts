/**
 * raging-sea-compile.test.ts — static WGSL compile test for the raging-sea example.
 *
 * Replicates the exact node graph from examples/src/example-raging-sea.ts and
 * verifies the WGSL compiles without errors and contains the expected functions.
 */

import { describe, expect, test } from 'vitest';
import { compile, type CompileResult } from '../src/nodes/compile';
import * as d from '../src/nodes/schema';
import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    f32,
    Fn,
    modelWorldMatrix,
    mul,
    timeElapsed,
    uniform,
    vec2,
    vec3,
    vec3f,
    vec4,
    varying,
    wgslFn,
    type Node,
    type WgslType,
} from '../src/nodes/nodes';

// ─────────────────────────────────────────────────────────────────────────────
// Noise helpers (same as in example-raging-sea.ts)
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

const uLargeWavesFreqX = uniform(f32(3.0),  'largeWavesFreqX');
const uLargeWavesFreqZ = uniform(f32(1.5),  'largeWavesFreqZ');
const uLargeWavesSpeed = uniform(f32(1.25), 'largeWavesSpeed');
const uLargeWavesMult  = uniform(f32(0.15), 'largeWavesMult');

const uSmallWavesIter  = uniform(f32(3.0),  'smallWavesIter');
const uSmallWavesFreq  = uniform(f32(2.0),  'smallWavesFreq');
const uSmallWavesSpeed = uniform(f32(0.3),  'smallWavesSpeed');
const uSmallWavesMult  = uniform(f32(0.18), 'smallWavesMult');

const uNormalShift     = uniform(f32(0.01), 'normalShift');

const uWaterColor      = uniform(vec3f(0.15, 0.08, 0.26), 'waterColor') as Node<'vec3f'>;
const uEmissiveColor   = uniform(vec3f(1.0, 0.04, 0.50),  'emissiveColor') as Node<'vec3f'>;
const uEmissiveLow     = uniform(f32(-0.25), 'emissiveLow');
const uEmissiveHigh    = uniform(f32(0.2),   'emissiveHigh');
const uEmissivePower   = uniform(f32(7.0),   'emissivePower');

// ─────────────────────────────────────────────────────────────────────────────
// wavesElevation Fn
// ─────────────────────────────────────────────────────────────────────────────

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
        const p  = pos   as Node<'vec3f'>;
        const tm = t     as Node<'f32'>;
        const lfx = lwFreqX as Node<'f32'>;
        const lfz = lwFreqZ as Node<'f32'>;
        const ls  = lwSpeed as Node<'f32'>;
        const lm  = lwMult  as Node<'f32'>;
        const si  = swIter  as Node<'f32'>;
        const sf  = swFreq  as Node<'f32'>;
        const ss  = swSpeed as Node<'f32'>;
        const sm  = swMult  as Node<'f32'>;

        const elevation = p.x.mul(lfx).add(tm.mul(ls)).sin()
            .mul(p.z.mul(lfz).add(tm.mul(ls)).sin())
            .mul(lm)
            .toVar('elevation');

        for (let octave = 1; octave <= 4; octave++) {
            const scale  = f32(octave);
            const active = scale.lte(si);
            const noiseInput = vec3(
                p.xz.add(vec2(f32(2), f32(2))).mul(sf).mul(scale),
                tm.mul(ss),
            );
            const wave = valueNoise3D(noiseInput).mul(sm).div(scale).abs();
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

function elevation(pos: Node<'vec3f'>): Node<WgslType> {
    return wavesElevation(
        pos, timeElapsed,
        uLargeWavesFreqX, uLargeWavesFreqZ, uLargeWavesSpeed, uLargeWavesMult,
        uSmallWavesIter, uSmallWavesFreq, uSmallWavesSpeed, uSmallWavesMult,
    ) as unknown as Node<WgslType>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vertex / fragment graph
// ─────────────────────────────────────────────────────────────────────────────

const positionAttr = attribute(d.vec3f, 'position');

const localPos = vec3(positionAttr.x, elevation(positionAttr as unknown as Node<'vec3f'>) as Node<'f32'>, positionAttr.z);
const clipPos  = mul(cameraProjectionMatrix, mul(cameraViewMatrix, mul(modelWorldMatrix, vec4(localPos, f32(1)))));

const shift = uNormalShift;
const posA = vec3(
    positionAttr.x.add(shift),
    elevation(vec3(positionAttr.x.add(shift), f32(0), positionAttr.z) as Node<'vec3f'>) as Node<'f32'>,
    positionAttr.z,
);
const posB = vec3(
    positionAttr.x,
    elevation(vec3(positionAttr.x, f32(0), positionAttr.z.add(shift)) as Node<'vec3f'>) as Node<'f32'>,
    positionAttr.z.add(shift),
);

const toA = posA.sub(localPos).normalize();
const toB = posB.sub(localPos).normalize();
const worldNormal = toA.cross(toB).normalize();

const vElevation = varying(d.f32,   'v_elevation', localPos.y);
const vNormal    = varying(d.vec3f, 'v_normal',    worldNormal);

const lightDir = vec3(f32(-0.6), f32(1.0), f32(0.8)).normalize();
const diffuse  = vNormal.dot(lightDir).max(f32(0.05));
const viewDir  = vec3(f32(0), f32(1), f32(0));
const halfVec  = lightDir.add(viewDir).normalize();
const specular = vNormal.dot(halfVec).max(f32(0)).pow(f32(64)).mul(f32(0.4));
const litColor = uWaterColor.mul(diffuse).add(vec3(f32(1), f32(1), f32(1)).mul(specular));

const t01      = vElevation.sub(uEmissiveHigh).div(uEmissiveLow.sub(uEmissiveHigh)).clamp(f32(0), f32(1));
const emissive = uEmissiveColor.mul(t01.pow(uEmissivePower));

const finalColor = vec4(litColor.add(emissive), f32(1));

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('raging-sea WGSL compilation', () => {
    const result: CompileResult = compile({
        position: clipPos,
        color:    finalColor,
    });

    const code = result.code;

    test('compile returns a code string', () => {
        expect(typeof code).toBe('string');
        expect(code.length).toBeGreaterThan(0);
    });

    test('WGSL contains hash3 function', () => {
        expect(code).toContain('fn hash3(');
    });

    test('WGSL contains valueNoise3D function', () => {
        expect(code).toContain('fn valueNoise3D(');
    });

    test('WGSL contains wavesElevation function', () => {
        expect(code).toContain('fn wavesElevation(');
    });

    test('hash3 appears before valueNoise3D in output', () => {
        const hash3Pos   = code.indexOf('fn hash3(');
        const noisePos   = code.indexOf('fn valueNoise3D(');
        expect(hash3Pos).toBeLessThan(noisePos);
    });

    test('valueNoise3D appears before wavesElevation in output', () => {
        const noisePos  = code.indexOf('fn valueNoise3D(');
        const wavesPos  = code.indexOf('fn wavesElevation(');
        expect(noisePos).toBeLessThan(wavesPos);
    });

    test('contains vs_main entry point', () => {
        expect(code).toContain('@vertex');
        expect(code).toContain('fn vs_main(');
    });

    test('contains fs_main entry point', () => {
        expect(code).toContain('@fragment');
        expect(code).toContain('fn fs_main(');
    });

    test('position attribute is declared', () => {
        expect(result.attributes.some(a => a.name === 'position')).toBe(true);
    });

    test('varyings v_elevation and v_normal are present', () => {
        expect(result.varyings.some(v => v.name === 'v_elevation')).toBe(true);
        expect(result.varyings.some(v => v.name === 'v_normal')).toBe(true);
    });

    test('prints compiled WGSL (for manual inspection)', () => {
        console.log('\n=== COMPILED WGSL ===\n' + code + '\n=== END WGSL ===\n');
        expect(true).toBe(true);
    });
});
