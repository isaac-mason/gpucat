/**
 * geometries.ts (webgl) - GL buffer uploads + VAO construction, per-Geometry cached.
 *
 * Mirrors `webgpu/geometries.ts` semantics (per-geometry init/upload, version tracking, drawRange)
 * but produces the WebGL2 resources: one `WebGLBuffer` per attribute buffer + the index buffer, and
 * a `WebGLVertexArrayObject` that captures the attribute pointers.
 *
 * The VAO is built from the compiled `vertexBufferGroups` (from `compileGlsl`) exactly the way the
 * WebGPU path builds `GPUVertexBufferLayout`s in `buildVertexBufferLayouts`: one buffer per group,
 * each group's attributes bound at their known `shaderLocation` with per-attribute format/offset and
 * the group's stride + instancing step mode. Float attributes go through `vertexAttribPointer`,
 * integer attributes through `vertexAttribIPointer`, and matrix attributes occupy consecutive
 * locations (one column per slot) with the instancing divisor applied to every slot.
 *
 * Because a VAO's attribute layout is keyed to the program's attribute locations (which are fixed by
 * the emitter's `layout(location=N)`), and because a geometry may be drawn by different materials,
 * the VAO is cached per `(Geometry, program)` pair.
 */
import type { Geometry } from '../../geometry/geometry';
import type { NodeBuilderState } from '../core/node-builder-state';
/** Per-geometry GL resources: the attribute/index GL buffers and their last-uploaded versions. */
type GeometryBuffers = {
    /** GL buffer per attribute-buffer name (ARRAY_BUFFER). */
    attributeBuffers: Map<string, WebGLBuffer>;
    /** Last-uploaded version per attribute-buffer name (for needsUpdate/version tracking). */
    attributeVersions: Map<string, number>;
    /** GL index buffer (ELEMENT_ARRAY_BUFFER), or null for non-indexed geometry. */
    indexBuffer: WebGLBuffer | null;
    /** Last-uploaded index buffer version. */
    indexVersion: number;
    /** VAOs keyed by program identity (a geometry may be drawn by several materials). */
    vaos: Map<WebGLProgram, WebGLVertexArrayObject>;
};
/** Geometries state: per-geometry GL resources, keyed by geometry identity. */
export type GeometriesState = {
    data: WeakMap<Geometry, GeometryBuffers>;
};
/** Create an empty geometries state. */
export declare function createGeometriesState(): GeometriesState;
/**
 * Prepared draw resources for a geometry under a given program: the VAO to bind plus the index-buffer
 * presence (so the draw path picks drawElements vs drawArrays and the index component type).
 */
export type GeometryDrawInfo = {
    vao: WebGLVertexArrayObject;
    /** GL index component type (gl.UNSIGNED_SHORT / gl.UNSIGNED_INT), or null for non-indexed. */
    indexType: number | null;
};
/**
 * Ensure the geometry's GL buffers are uploaded and its VAO (for `program`) is built, returning the
 * draw resources. Re-uploads buffers whose version changed. The VAO is cached per (geometry, program).
 */
export declare function prepareGeometry(gl: WebGL2RenderingContext, state: GeometriesState, geometry: Geometry, nodeState: NodeBuilderState, program: WebGLProgram): GeometryDrawInfo;
/** Dispose all GL resources owned by the geometries state for a single geometry. */
export declare function disposeGeometry(gl: WebGL2RenderingContext, state: GeometriesState, geometry: Geometry): void;
export {};
