import { readdirSync } from 'node:fs';
import { expect, test } from 'vitest';

/**
 * Backend symmetry rule 1: one module per engine resource, same filename on both sides.
 * Rule 4: a file with no sibling is justified by an API difference, not a decomposition preference.
 * Both were audited by hand in layers 6.3 and 6.72, and the plan's own module table went stale
 * between those audits, which is the argument for checking it here instead.
 */

const WEBGL = 'src/renderer/webgl';
const WEBGPU = 'src/renderer/webgpu';

/** Pairs whose names differ because the device artifacts genuinely differ. */
const EARNED_PAIRS: Record<string, string> = {
    'programs.ts': 'pipelines.ts',
    'webgl-backend.ts': 'webgpu-backend.ts',
    'render-object-gl.ts': 'render-object-gpu.ts',
};

/** No sibling, with the API difference that earns it. A decomposition preference is not one. */
const EARNED_SOLO: Record<string, string> = {
    'webgl/constants.ts': 'GL enum numbers; WebGPU spells the same states as string literals',
    'webgl/context.ts': 'getContext plus extension probing has no WebGPU counterpart',
    'webgl/probe.ts': 'the inspector value probe re-renders through GL; the WebGPU path is in inspector.ts',
    'webgl/state.ts': 'fixed-function state is live on the context; WebGPU bakes it into the pipeline',
    'webgl/texture-bindings.ts': 'combined-sampler uniforms and texture units; WebGPU binds through a bind group',
    'webgl/transform-feedback.ts': 'WebGL2-only API, the mirror of compute being WebGPU-only',
    'webgl/transform-feedback-api.ts':
        'the public free functions for it; separate from transform-feedback.ts because they name the backend, which imports it',
    'webgpu/bind-group-layout.ts': 'WebGPU-only object; WebGL2 has no bind-group concept',
    'webgpu/compute.ts': 'WebGPU-only; WebGL2 has no compute shaders',
    'webgpu/mipmap-utils.ts': 'mips are a render pass per level; GL has generateMipmap',
    'webgpu/render-objects.ts': 'RULE 4 VIOLATION, recorded: decomposition, not API. WebGL keeps this in prepare.ts',
};

const modules = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith('.ts'));

function solos(): string[] {
    const gl = new Set(modules(WEBGL));
    const gpu = new Set(modules(WEBGPU));
    const out: string[] = [];
    for (const [a, b] of Object.entries(EARNED_PAIRS)) {
        if (gl.delete(a) && gpu.delete(b)) continue;
        out.push(`earned pair ${a} <-> ${b} no longer exists`);
    }
    for (const f of gl) if (!gpu.has(f)) out.push(`webgl/${f}`);
    for (const f of gpu) if (!gl.has(f)) out.push(`webgpu/${f}`);
    return out.sort();
}

test('a backend module with no sibling is one the plan justified', () => {
    expect(solos().filter((s) => !(s in EARNED_SOLO))).toEqual([]);
});

test('an entry stops being justified once it gains a sibling', () => {
    const unpaired = new Set(solos());
    expect(Object.keys(EARNED_SOLO).filter((k) => !unpaired.has(k))).toEqual([]);
});
