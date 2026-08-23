import type { MemoryLayout } from './pack';
import { type Any } from './schema';
/** One uniform block member, as the emitter records it. */
export type LayoutMember = {
    uniformId: string;
    schema: Any;
    offset: number;
};
/**
 * Assert a uniform block's layout is conformant for `memLayout`. No-op for `std430` (storage buffers,
 * which pack tightly and have no 16-byte constraints). Throws with a precise location on the first
 * violation.
 */
export declare function assertUniformLayoutConformant(blockName: string, members: LayoutMember[], totalBytes: number, memLayout: MemoryLayout): void;
/**
 * Assert a struct's OWN layout is valid in the WGSL uniform address space, independent of the active
 * backend and of the synthetic block wrapper. Call this for every uniform-bound struct so a build that
 * only compiles GLSL (WebGL) still catches a layout that would break WebGPU/naga — WGSL's rules are the
 * strict superset, and std140 satisfies them inherently, so validating against WGSL covers both.
 * The actionable failure names the member and suggests the `d.align` fix.
 */
export declare function assertSchemaUniformValid(label: string, schema: Any): void;
