/*
 *the one dirty-region representation for textures, plus the exact
 * merge rules the renderer relies on.
 *
 * A *range* is 1D and belongs to buffers (see GpuBuffer); a *region* is a box and belongs to
 * textures. Keeping the two words distinct is deliberate: modelling 2D/3D dirty state as a linear
 * run is what forced every earlier partial-upload path to round out to whole rows.
 *
 * `z` addresses array layers, cube faces and 3D slices - one axis, the same meaning on both
 * backends, matching `writeTexture`'s `origin.z` and `texSubImage3D`'s `zoffset`.
 */

/** A box of texels within one mip level of a texture. */
export type TextureRegion = {
    x: number;
    y: number;
    z: number;
    width: number;
    height: number;
    depth: number;
    level: number;
};

/** Partial region as accepted from user code; omitted fields default to the full extent at origin. */
export type TextureRegionInit = Partial<TextureRegion>;

/** Extent used to fill in omitted fields of a {@link TextureRegionInit}. */
export type RegionExtent = { width: number; height: number; depth: number };

/**
 * Pending regions past this point stop being tracked exactly: the list is coalesced to one bounding
 * box per `(level, z, depth)` plane. Bounds both memory and per-add merge cost regardless of access
 * pattern.
 */
export const REGION_CAP = 16;

/** Fill omitted fields from `extent`, clamp to it, and return a whole region. */
export function normalizeRegion(init: TextureRegionInit, extent: RegionExtent): TextureRegion {
    const x = Math.max(0, init.x ?? 0);
    const y = Math.max(0, init.y ?? 0);
    const z = Math.max(0, init.z ?? 0);
    return {
        x,
        y,
        z,
        width: Math.max(0, Math.min(init.width ?? extent.width, extent.width - x)),
        height: Math.max(0, Math.min(init.height ?? extent.height, extent.height - y)),
        depth: Math.max(0, Math.min(init.depth ?? extent.depth, extent.depth - z)),
        level: Math.max(0, init.level ?? 0),
    };
}

/** Texels covered by `r`. */
export function regionTexelCount(r: TextureRegion): number {
    return r.width * r.height * r.depth;
}

function isEmpty(r: TextureRegion): boolean {
    return r.width <= 0 || r.height <= 0 || r.depth <= 0;
}

function contains(a: TextureRegion, b: TextureRegion): boolean {
    return (
        a.x <= b.x &&
        a.x + a.width >= b.x + b.width &&
        a.y <= b.y &&
        a.y + a.height >= b.y + b.height &&
        a.z <= b.z &&
        a.z + a.depth >= b.z + b.depth
    );
}

/** Merge along one axis, or null when the two are disjoint with a gap on it. */
function mergeAxis(
    a: TextureRegion,
    b: TextureRegion,
    origin: 'x' | 'y' | 'z',
    size: 'width' | 'height' | 'depth',
): TextureRegion | null {
    const a0 = a[origin];
    const a1 = a0 + a[size];
    const b0 = b[origin];
    const b1 = b0 + b[size];
    // Touching counts as mergeable (b0 === a1); only a real gap blocks the merge.
    if (b0 > a1 || a0 > b1) return null;
    const lo = Math.min(a0, b0);
    const hi = Math.max(a1, b1);
    return { ...a, [origin]: lo, [size]: hi - lo };
}

/**
 * Merge two regions iff their union is ITSELF a box: same level, and either one contains the other,
 * or they agree exactly on two of the three axis intervals and touch/overlap on the third. Returns
 * null otherwise. Never returns a bounding box - a merge must not pick up a texel that was clean.
 */
export function tryMergeRegions(a: TextureRegion, b: TextureRegion): TextureRegion | null {
    if (a.level !== b.level) return null;
    if (contains(a, b)) return a;
    if (contains(b, a)) return b;

    const xEq = a.x === b.x && a.width === b.width;
    const yEq = a.y === b.y && a.height === b.height;
    const zEq = a.z === b.z && a.depth === b.depth;
    if ((xEq ? 1 : 0) + (yEq ? 1 : 0) + (zEq ? 1 : 0) < 2) return null;

    if (!xEq) return mergeAxis(a, b, 'x', 'width');
    if (!yEq) return mergeAxis(a, b, 'y', 'height');
    if (!zEq) return mergeAxis(a, b, 'z', 'depth');
    return a; // all three equal - identical regions
}

/** After `list[i]` grew, absorb any other entries it can now merge with. */
function cascade(list: TextureRegion[], i: number): void {
    for (let j = list.length - 1; j >= 0; j--) {
        if (j === i) continue;
        const merged = tryMergeRegions(list[i], list[j]);
        if (!merged) continue;
        list[i] = merged;
        list.splice(j, 1);
        if (j < i) i--;
    }
}

/** Coalesce to one bounding box per `(level, z, depth)` plane. The cap's escape hatch. */
function coalesceToPlanes(list: TextureRegion[]): void {
    const byPlane = new Map<string, TextureRegion>();
    for (const r of list) {
        const key = `${r.level}:${r.z}:${r.depth}`;
        const seen = byPlane.get(key);
        if (!seen) {
            byPlane.set(key, { ...r });
            continue;
        }
        const x1 = Math.max(seen.x + seen.width, r.x + r.width);
        const y1 = Math.max(seen.y + seen.height, r.y + r.height);
        seen.x = Math.min(seen.x, r.x);
        seen.y = Math.min(seen.y, r.y);
        seen.width = x1 - seen.x;
        seen.height = y1 - seen.y;
    }
    list.length = 0;
    for (const r of byPlane.values()) list.push(r);
}

/**
 * Queue `region` into `list`, merging exactly where possible.
 *
 * Insertion is cheap by construction: the most recently added region is tried first, so a sequential
 * write loop (`for (i...) packAtIndex(i)`) merges in O(1) and never scans. Past `cap` pending regions
 * the list is coalesced per plane, bounding both memory and per-add cost.
 */
export function addRegion(list: TextureRegion[], region: TextureRegion, cap: number = REGION_CAP): void {
    if (isEmpty(region)) return;

    const n = list.length;
    if (n > 0) {
        const merged = tryMergeRegions(list[n - 1], region);
        if (merged) {
            list[n - 1] = merged;
            cascade(list, n - 1);
            return;
        }
    }
    for (let i = 0; i < n - 1; i++) {
        const merged = tryMergeRegions(list[i], region);
        if (merged) {
            list[i] = merged;
            cascade(list, i);
            return;
        }
    }

    list.push(region);
    if (list.length > cap) coalesceToPlanes(list);
}

/**
 * Convert a linear run of `count` texels from `start` into regions, exactly. A run inside one row is
 * a single 1-row box; a run that crosses a row boundary becomes at most three (head partial row,
 * full-row middle, tail partial row). This is what keeps a small record in a wide texture from
 * dirtying the whole row.
 */
export function regionsFromLinearRun(start: number, count: number, width: number): TextureRegion[] {
    if (count <= 0 || width <= 0) return [];
    const out: TextureRegion[] = [];
    const push = (x: number, y: number, w: number, h: number) => {
        out.push({ x, y, z: 0, width: w, height: h, depth: 1, level: 0 });
    };

    const end = start + count;
    const y0 = Math.floor(start / width);
    const x0 = start % width;
    const yLast = Math.floor((end - 1) / width);

    if (y0 === yLast) {
        push(x0, y0, count, 1);
        return out;
    }

    let midStart = y0;
    let midEnd = yLast + 1;
    if (x0 > 0) {
        push(x0, y0, width - x0, 1);
        midStart = y0 + 1;
    }
    const xEnd = ((end - 1) % width) + 1;
    if (xEnd < width) {
        push(0, yLast, xEnd, 1);
        midEnd = yLast;
    }
    if (midEnd > midStart) push(0, midStart, width, midEnd - midStart);
    return out;
}

/**
 * Derive the region covering the same texels at mip `level`, halving per level. Origins floor and
 * extents ceil so the derived box always covers the footprint of the original rather than shaving a
 * texel off its edge, then clamp to the level's own size.
 *
 * This is what lets a write to level 0 patch an explicit mip chain automatically. Without it a partial
 * upload leaves every other level stale, which is silent corruption rather than a visible failure.
 */
export function deriveMipRegion(r: TextureRegion, level: number, levelWidth: number, levelHeight: number): TextureRegion {
    const s = 1 << level;
    const x0 = Math.min(Math.floor(r.x / s), Math.max(0, levelWidth - 1));
    const y0 = Math.min(Math.floor(r.y / s), Math.max(0, levelHeight - 1));
    const x1 = Math.min(levelWidth, Math.max(x0 + 1, Math.ceil((r.x + r.width) / s)));
    const y1 = Math.min(levelHeight, Math.max(y0 + 1, Math.ceil((r.y + r.height) / s)));
    return { x: x0, y: y0, z: r.z, width: x1 - x0, height: y1 - y0, depth: r.depth, level };
}

/** A region within a single layer/face: the sub-rect half of {@link TextureRegionInit}. */
export type TextureRectInit = Pick<TextureRegionInit, 'x' | 'y' | 'width' | 'height' | 'level'>;
