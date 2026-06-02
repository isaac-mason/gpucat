import * as d from 'gpucat/dist/schema/schema';
/**
 * Basic struct descriptor for a non-indexed indirect draw call (`drawIndirect`) with no additional fields.
 * Memory layout (4 × u32, 16 bytes):
 *   vertexCount, instanceCount, firstVertex, firstInstance
 */
export declare const DrawIndirect: import("gpucat/dist/nodes/lib/core").StructDef<{
    vertexCount: d.u32;
    instanceCount: d.u32;
    firstVertex: d.u32;
    firstInstance: d.u32;
}>;
/**
 * Basic struct descriptor for an indexed indirect draw call (`drawIndexedIndirect`) with no additional fields.
 * Memory layout (5 × u32, 20 bytes):
 *   indexCount, instanceCount, firstIndex, baseVertex, firstInstance
 */
export declare const DrawIndexedIndirect: import("gpucat/dist/nodes/lib/core").StructDef<{
    indexCount: d.u32;
    instanceCount: d.u32;
    firstIndex: d.u32;
    baseVertex: d.u32;
    firstInstance: d.u32;
}>;
