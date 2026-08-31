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
export type RegionExtent = {
    width: number;
    height: number;
    depth: number;
};
/**
 * Pending regions past this point stop being tracked exactly: the list is coalesced to one bounding
 * box per `(level, z, depth)` plane. Bounds both memory and per-add merge cost regardless of access
 * pattern.
 */
export declare const REGION_CAP = 16;
/** Fill omitted fields from `extent`, clamp to it, and return a whole region. */
export declare function normalizeRegion(init: TextureRegionInit, extent: RegionExtent): TextureRegion;
/** Texels covered by `r`. */
export declare function regionTexelCount(r: TextureRegion): number;
/**
 * Merge two regions iff their union is ITSELF a box: same level, and either one contains the other,
 * or they agree exactly on two of the three axis intervals and touch/overlap on the third. Returns
 * null otherwise. Never returns a bounding box - a merge must not pick up a texel that was clean.
 */
export declare function tryMergeRegions(a: TextureRegion, b: TextureRegion): TextureRegion | null;
/**
 * Queue `region` into `list`, merging exactly where possible.
 *
 * Insertion is cheap by construction: the most recently added region is tried first, so a sequential
 * write loop (`for (i...) packAtIndex(i)`) merges in O(1) and never scans. Past `cap` pending regions
 * the list is coalesced per plane, bounding both memory and per-add cost.
 */
export declare function addRegion(list: TextureRegion[], region: TextureRegion, cap?: number): void;
/**
 * Convert a linear run of `count` texels from `start` into regions, exactly. A run inside one row is
 * a single 1-row box; a run that crosses a row boundary becomes at most three (head partial row,
 * full-row middle, tail partial row). This is what keeps a small record in a wide texture from
 * dirtying the whole row.
 */
export declare function regionsFromLinearRun(start: number, count: number, width: number): TextureRegion[];
/**
 * Derive the region covering the same texels at mip `level`, halving per level. Origins floor and
 * extents ceil so the derived box always covers the footprint of the original rather than shaving a
 * texel off its edge, then clamp to the level's own size.
 *
 * This is what lets a write to level 0 patch an explicit mip chain automatically. Without it a partial
 * upload leaves every other level stale, which is silent corruption rather than a visible failure.
 */
export declare function deriveMipRegion(r: TextureRegion, level: number, levelWidth: number, levelHeight: number): TextureRegion;
/** A region within a single layer/face: the sub-rect half of {@link TextureRegionInit}. */
export type TextureRectInit = Pick<TextureRegionInit, 'x' | 'y' | 'width' | 'height' | 'level'>;
