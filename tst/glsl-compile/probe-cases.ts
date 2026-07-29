/**
 * probe-cases.ts — GLSL probe-patcher compile cases.
 *
 * Each case builds a small material, emits its GLSL, then patches the FRAGMENT via buildProbeGLSL to
 * probe a named `Let` variable of a specific type. The harness compiles + links the patched fragment
 * (with the original, unpatched vertex GLSL) under real WebGL2 — proving that, for every coercion the
 * probe supports, the patched fragment still compiles and links. This is the WebGL parallel to the
 * WGSL probe (which is exercised interactively); here we assert the GLSL patcher's output is valid.
 */

import {
    attribute,
    compileGlsl,
    d,
    f32,
    i32,
    Let,
    u32,
    varying,
    vec2,
    vec3,
    vec4,
    vec3b,
} from '../../src/index';
import { buildProbeGLSL, coerceToVec4, inferGlslType } from '../../src/inspector/probe-glsl';
import type { Slots } from './cases';

export interface ProbeCase {
    name: string;
    build: () => Slots;
    /**
     * The GLSL type token whose FIRST in-body declaration (`<token> <name> = …;`) is probed. The
     * emitter names locals `let_<id>_<name>` / `_vN`, so the test locates the var by its declared type
     * rather than a fixed name.
     */
    probeType: string;
    /** The GLSL kind the patcher must infer for the probed var (asserted). */
    expectedKind: ReturnType<typeof inferGlslType>;
}

export const probeCases: ProbeCase[] = [
    {
        name: 'probe float',
        probeType: 'float',
        expectedKind: 'float',
        build: () => {
            const position = attribute('position', d.vec3f);
            const uv = varying(position, 'vPos');
            const s = Let('s', uv.x.mul(f32(2)));
            return { vertex: vec4(position, f32(1)), fragment: vec4(vec3(s, s, s), f32(1)), depth: undefined };
        },
    },
    {
        name: 'probe vec2',
        probeType: 'vec2',
        expectedKind: 'vec2',
        build: () => {
            const position = attribute('position', d.vec3f);
            const uv = varying(position.xy, 'vUV');
            const v = Let('v', uv.mul(f32(2)));
            return { vertex: vec4(position, f32(1)), fragment: vec4(v, f32(0), f32(1)), depth: undefined };
        },
    },
    {
        name: 'probe vec3',
        probeType: 'vec3',
        expectedKind: 'vec3',
        build: () => {
            const position = attribute('position', d.vec3f);
            const uv = varying(position, 'vPos');
            const c = Let('c', uv.mul(f32(0.5)));
            return { vertex: vec4(position, f32(1)), fragment: vec4(c, f32(1)), depth: undefined };
        },
    },
    {
        name: 'probe vec4',
        probeType: 'vec4',
        expectedKind: 'vec4',
        build: () => {
            const position = attribute('position', d.vec3f);
            const uv = varying(position, 'vPos');
            const col = Let('col', vec4(uv, f32(1)).mul(f32(0.5)));
            return { vertex: vec4(position, f32(1)), fragment: col, depth: undefined };
        },
    },
    {
        name: 'probe int',
        probeType: 'int',
        expectedKind: 'int',
        build: () => {
            const n = Let('n', i32(3).add(i32(4)));
            return { vertex: vec4(attribute('position', d.vec3f), f32(1)), fragment: vec4(vec3(n.toF32()), f32(1)), depth: undefined };
        },
    },
    {
        name: 'probe uint',
        probeType: 'uint',
        expectedKind: 'uint',
        build: () => {
            const un = Let('un', u32(3).add(u32(4)));
            return { vertex: vec4(attribute('position', d.vec3f), f32(1)), fragment: vec4(vec3(un.toF32()), f32(1)), depth: undefined };
        },
    },
    {
        name: 'probe bvec3',
        probeType: 'bvec3',
        expectedKind: 'bvec3',
        build: () => {
            const position = attribute('position', d.vec3f);
            const uv = varying(position, 'vPos');
            const mask = Let(
                'mask',
                vec3b(uv.x.greaterThan(f32(0.5)), uv.y.greaterThan(f32(0.5)), uv.z.greaterThan(f32(0.5))),
            );
            const chosen = vec3(mask.x.select(f32(1), f32(0)), f32(0), f32(0));
            return { vertex: vec4(position, f32(1)), fragment: vec4(chosen, f32(1)), depth: undefined };
        },
    },
];

/** Re-export so the harness can call the patcher without a second import path. */
export { buildProbeGLSL, coerceToVec4, inferGlslType };

const FRAGMENT_MARKER = '// ---- fragment stage ----';

/**
 * Build a probe case's emitted GLSL, patch the fragment to probe its named var, and return the
 * original vertex source + the PATCHED fragment source (ready to compile + link), plus the inferred
 * kind for an assertion. Throws on emit/patch failure so the harness reports it as an emit error.
 */
export function buildProbeCase(c: ProbeCase): { vertexSrc: string; fragmentSrc: string; inferredKind: string } {
    const slots = c.build();
    const { code } = compileGlsl(slots);
    const idx = code.indexOf(FRAGMENT_MARKER);
    if (idx === -1) throw new Error('no fragment stage marker in emitted GLSL');
    const vertexSrc = code.slice(0, idx).trim();
    const fragmentSrc = code.slice(idx + FRAGMENT_MARKER.length).trim();

    // Locate the FIRST in-body declaration of the requested GLSL type and probe that variable. The
    // emitter names locals `let_<id>_<name>` / `_vN`, so we match by declared type, not a fixed name.
    const bodyStart = fragmentSrc.indexOf('void main');
    const body = bodyStart === -1 ? fragmentSrc : fragmentSrc.slice(bodyStart);
    const declRe = new RegExp(`\\b${c.probeType}\\s+(\\w+)\\s*=`);
    const m = body.match(declRe);
    if (!m) throw new Error(`no '${c.probeType}' declaration found in emitted fragment body`);
    const probeVar = m[1];

    const patched = buildProbeGLSL(fragmentSrc, {
        expr: probeVar,
        anchor: probeVar,
        anchorKind: 'let_var',
    });
    if (!patched) throw new Error(`buildProbeGLSL returned null for probeVar '${probeVar}'`);

    return { vertexSrc, fragmentSrc: patched.fragment, inferredKind: patched.kind };
}
