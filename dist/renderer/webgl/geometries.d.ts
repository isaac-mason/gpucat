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
    /** Last-uploaded byte size per attribute-buffer name. Drives the resize guard (recreate
     *  the GL buffer when the array grows), mirroring the WebGPU backend's `buf.size < byteLength`. */
    attributeSizes: Map<string, number>;
    /** GL index buffer (ELEMENT_ARRAY_BUFFER), or null for non-indexed geometry. */
    indexBuffer: WebGLBuffer | null;
    /** Last-uploaded index buffer version. */
    indexVersion: number;
    /** Last-uploaded index buffer byte size (resize guard, as above). */
    indexSize: number;
    /** VAOs keyed by program identity (a geometry may be drawn by several materials). */
    vaos: Map<WebGLProgram, WebGLVertexArrayObject>;
};
/** Geometries state: per-geometry GL resources, keyed by geometry identity. */
export type GeometriesState = {
    data: WeakMap<Geometry, GeometryBuffers>;
    /** Cached `gl.MAX_VERTEX_ATTRIBS`, read once (guards attribute-location assignment). */
    maxVertexAttribs?: number;
};
/** Create an empty geometries state. */
export declare function createGeometriesState(): GeometriesState;
/** GL type + component count + slot count + int-ness derived from a WGSL attribute type string. */
export type AttribFormat = {
    /** GL component type (gl.FLOAT, gl.INT, gl.UNSIGNED_INT). */
    glType: 'float' | 'int' | 'uint';
    /** Components per slot (1..4). */
    size: number;
    /** Number of attribute slots (1 for scalars/vectors, N for matNxN). */
    slots: number;
    /** Bytes per full element (all slots), used to derive stride when not interleaved. */
    byteSize: number;
};
/** Derive the GL attribute format from the compiled WGSL type string (e.g. 'vec3f', 'mat4x4f'). */
export declare function attribFormat(type: string): AttribFormat;
export declare function glComponentType(gl: WebGL2RenderingContext, glType: AttribFormat['glType']): number;
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
