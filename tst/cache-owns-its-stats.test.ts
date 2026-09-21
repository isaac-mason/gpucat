import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * `PLAN-backend-symmetry.md` rule 2: whoever owns the cache owns the release, the stats and the
 * teardown. Layer 6.84 found WebGPU's `readMemoryStats` reading four counts straight off cache
 * fields while WebGL asked each owning module, and `getPipelineCacheStats` reporting a count that
 * belongs to `bind-group-layout.ts`.
 */

const BACKENDS = ['src/renderer/webgl', 'src/renderer/webgpu'];

/** State that lives for a frame or a draw, not a cache of device resources rule 2 governs. */
const NOT_A_RESOURCE_CACHE = new Set([
    'frame-backend.ts',
    'mipmap-utils.ts',
    'probe.ts',
    'render-pass.ts',
    'state.ts',
    'transform-feedback.ts',
]);

/** Resource caches with no stats function, each symmetric across both backends. */
const NO_STATS_YET: Record<string, string> = {
    'bindings.ts': 'neither backend counts bind groups; WebGPU reports layouts from bind-group-layout.ts',
    'textures.ts': "both report through `cache.tally` and core's `readTextureTally`, which is the shared shape",
    'render-object-gl.ts': 'per-draw payload counted by core through `getRenderObjectsStats`',
    'render-object-gpu.ts': 'per-draw payload counted by core through `getRenderObjectsStats`',
};

const CREATES_CACHE = /^export function create[A-Za-z]*(?:Cache|State)\b/m;
const HAS_STATS = /^export function get[A-Za-z]*Stats\b/m;

function cacheOwners(): { file: string; module: string; hasStats: boolean }[] {
    const out: { file: string; module: string; hasStats: boolean }[] = [];
    for (const dir of BACKENDS) {
        for (const entry of readdirSync(dir)) {
            if (!entry.endsWith('.ts') || NOT_A_RESOURCE_CACHE.has(entry)) continue;
            const source = readFileSync(join(dir, entry), 'utf8');
            if (!CREATES_CACHE.test(source)) continue;
            out.push({ file: join(dir, entry), module: entry, hasStats: HAS_STATS.test(source) });
        }
    }
    return out;
}

test('a module that creates a resource cache reports what it holds', () => {
    const silent = cacheOwners().filter((o) => !o.hasStats && !(o.module in NO_STATS_YET));
    expect(silent.map((o) => o.file).sort()).toEqual([]);
});

test('a recorded gap is removed once the module grows stats', () => {
    const silent = new Set(
        cacheOwners()
            .filter((o) => !o.hasStats)
            .map((o) => o.module),
    );
    expect(Object.keys(NO_STATS_YET).filter((m) => !silent.has(m))).toEqual([]);
});
