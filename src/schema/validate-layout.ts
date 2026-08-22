/**
 * Uniform-buffer layout conformance check.
 *
 * The WGSL uniform address space (and GLSL std140) impose rules beyond plain alignment: a member that
 * follows a struct or array must start on a 16-byte boundary, array element strides are multiples of 16,
 * and the block itself is a multiple of 16. Chrome's Tint tolerates violations; Firefox's naga rejects
 * them, invalidating the pipeline. This validator asserts those rules against the ACTUAL offsets the
 * emitter produced, so a regression in {@link ./pack} (e.g. a nested struct reverting to natural
 * alignment) fails at emit time on every browser instead of only at runtime on Firefox.
 *
 * It is intentionally a constraint checker, not a second layout engine: a bad offset from pack.ts still
 * shows up here as a violated constraint, without duplicating the offset math.
 */
import { layoutAlignOf, layoutSizeOf, structFieldLayout } from './pack';
import type { MemoryLayout } from './pack';
import { type Any, type StructDesc, isArrayDesc, isSizedArrayDesc, isStructDesc } from './schema';

/** One uniform block member, as the emitter records it. */
export type LayoutMember = { uniformId: string; schema: Any; offset: number };

function isAggregate(schema: Any): boolean {
    return isStructDesc(schema) || isSizedArrayDesc(schema) || isArrayDesc(schema);
}

/**
 * Assert a uniform block's layout is conformant for `memLayout`. No-op for `std430` (storage buffers,
 * which pack tightly and have no 16-byte constraints). Throws with a precise location on the first
 * violation.
 */
export function assertUniformLayoutConformant(
    blockName: string,
    members: LayoutMember[],
    totalBytes: number,
    memLayout: MemoryLayout,
): void {
    if (memLayout === 'std430') return;

    const fail = makeFail(blockName, memLayout);

    // Top-level members, in offset order.
    let prevAggregate = false;
    for (const m of members) {
        const path = `${blockName}.${m.uniformId}`;
        checkOffset(m.schema, m.offset, prevAggregate, path, memLayout, fail);
        checkNested(m.schema, m.offset, path, memLayout, fail);
        prevAggregate = isAggregate(m.schema);
    }

    // The block is itself a 16-aligned struct.
    if (totalBytes % 16 !== 0) {
        fail(blockName, `block size ${totalBytes} is not a multiple of 16`);
    }
}

/**
 * Assert a struct's OWN layout is valid in the WGSL uniform address space, independent of the active
 * backend and of the synthetic block wrapper. Call this for every uniform-bound struct so a build that
 * only compiles GLSL (WebGL) still catches a layout that would break WebGPU/naga — WGSL's rules are the
 * strict superset, and std140 satisfies them inherently, so validating against WGSL covers both.
 * The actionable failure names the member and suggests the `d.align` fix.
 */
export function assertSchemaUniformValid(label: string, schema: Any): void {
    if (!isStructDesc(schema) && !isSizedArrayDesc(schema) && !isArrayDesc(schema)) return;
    checkNested(schema, 0, label, 'wgsl-uniform', makeFail(label, 'wgsl-uniform'));
}

function makeFail(blockName: string, memLayout: MemoryLayout) {
    return (path: string, detail: string): never => {
        throw new Error(`[gpucat] non-conformant ${memLayout} layout in '${blockName}' at ${path}: ${detail}`);
    };
}

/** Assert one member/field sits at a legal offset. */
function checkOffset(
    schema: Any,
    offset: number,
    prevAggregate: boolean,
    path: string,
    memLayout: MemoryLayout,
    fail: (path: string, detail: string) => never,
): void {
    const align = layoutAlignOf(schema, memLayout);
    if (offset % align !== 0) {
        fail(path, `offset ${offset} is not a multiple of its ${align}-byte alignment`);
    }
    // A member following a struct or array must start on a 16-byte boundary. This is the exact shape of
    // the Firefox break: a member packed at its natural offset after a nested struct/array.
    if (prevAggregate && offset % 16 !== 0) {
        fail(
            path,
            `offset ${offset} follows a struct/array member and must be a multiple of 16 in a uniform. ` +
                `Wrap it with d.align(16, ...) or reorder so it does not follow an aggregate`,
        );
    }
}

/** Recurse into a struct's fields or an array's element, asserting the same rules internally. */
function checkNested(
    schema: Any,
    baseOffset: number,
    path: string,
    memLayout: MemoryLayout,
    fail: (path: string, detail: string) => never,
): void {
    if (isStructDesc(schema)) {
        const { fields } = structFieldLayout(schema as StructDesc, memLayout);
        let prevAggregate = false;
        for (const f of fields) {
            const abs = baseOffset + f.byteOffset;
            const fieldPath = `${path}.${f.name}`;
            checkOffset(f.type, abs, prevAggregate, fieldPath, memLayout, fail);
            checkNested(f.type, abs, fieldPath, memLayout, fail);
            prevAggregate = isAggregate(f.type);
        }
        return;
    }

    if (isSizedArrayDesc(schema)) {
        const length = schema.length;
        const stride = length > 0 ? layoutSizeOf(schema, memLayout) / length : 0;
        if (stride % 16 !== 0) {
            fail(
                `${path}[]`,
                `array element stride ${stride} is not a multiple of 16 in a uniform. ` +
                    `Use d.align(16, element) or a vec4-based element`,
            );
        }
        // Element offsets repeat every stride, so validating the first element covers all of them.
        checkNested(schema.element, baseOffset, `${path}[0]`, memLayout, fail);
    }
}
