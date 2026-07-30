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

import type { GpuBuffer } from '../../core/gpu-buffer';
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
export function createGeometriesState(): GeometriesState {
    return { data: new WeakMap() };
}

function getGeometryBuffers(state: GeometriesState, geometry: Geometry): GeometryBuffers {
    let gb = state.data.get(geometry);
    if (!gb) {
        gb = {
            attributeBuffers: new Map(),
            attributeVersions: new Map(),
            indexBuffer: null,
            indexVersion: -1,
            vaos: new Map(),
        };
        state.data.set(geometry, gb);
    }
    return gb;
}

/**
 * GL index element type for an index typed array. WebGL2 accepts UNSIGNED_BYTE / UNSIGNED_SHORT /
 * UNSIGNED_INT indices; the type must match the array's element width or the draw reads garbage (a
 * Uint8Array read as UNSIGNED_INT walks 4 bytes per index). Any other array type throws.
 */
function glIndexType(gl: WebGL2RenderingContext, array: ArrayBufferView | null | undefined): number {
    if (array instanceof Uint8Array) return gl.UNSIGNED_BYTE;
    if (array instanceof Uint16Array) return gl.UNSIGNED_SHORT;
    if (array instanceof Uint32Array) return gl.UNSIGNED_INT;
    const ctorName = (array as { constructor?: { name?: string } } | null)?.constructor?.name ?? typeof array;
    throw new Error(
        `[WebGLRenderer] index buffer array type '${ctorName}' is not supported on the WebGL2 backend ` +
            `(expected Uint8Array, Uint16Array, or Uint32Array).`,
    );
}

// -------------------------------------------------------------------------------------------------
// WGSL attribute type → GL vertex-attrib descriptor.
// -------------------------------------------------------------------------------------------------

/** GL type + component count + slot count + int-ness derived from a WGSL attribute type string. */
type AttribFormat = {
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
function attribFormat(type: string): AttribFormat {
    switch (type) {
        case 'f32':
            return { glType: 'float', size: 1, slots: 1, byteSize: 4 };
        case 'vec2f':
            return { glType: 'float', size: 2, slots: 1, byteSize: 8 };
        case 'vec3f':
            return { glType: 'float', size: 3, slots: 1, byteSize: 12 };
        case 'vec4f':
            return { glType: 'float', size: 4, slots: 1, byteSize: 16 };
        case 'i32':
            return { glType: 'int', size: 1, slots: 1, byteSize: 4 };
        case 'vec2i':
            return { glType: 'int', size: 2, slots: 1, byteSize: 8 };
        case 'vec3i':
            return { glType: 'int', size: 3, slots: 1, byteSize: 12 };
        case 'vec4i':
            return { glType: 'int', size: 4, slots: 1, byteSize: 16 };
        case 'u32':
            return { glType: 'uint', size: 1, slots: 1, byteSize: 4 };
        case 'vec2u':
            return { glType: 'uint', size: 2, slots: 1, byteSize: 8 };
        case 'vec3u':
            return { glType: 'uint', size: 3, slots: 1, byteSize: 12 };
        case 'vec4u':
            return { glType: 'uint', size: 4, slots: 1, byteSize: 16 };
        case 'mat2x2f':
            return { glType: 'float', size: 2, slots: 2, byteSize: 16 };
        case 'mat3x3f':
            return { glType: 'float', size: 3, slots: 3, byteSize: 36 };
        case 'mat4x4f':
            return { glType: 'float', size: 4, slots: 4, byteSize: 64 };
        default:
            throw new Error(`[WebGLRenderer] vertex attribute format '${type}' is not supported on the WebGL2 backend.`);
    }
}

function glComponentType(gl: WebGL2RenderingContext, glType: AttribFormat['glType']): number {
    switch (glType) {
        case 'int':
            return gl.INT;
        case 'uint':
            return gl.UNSIGNED_INT;
        default:
            return gl.FLOAT;
    }
}

// -------------------------------------------------------------------------------------------------
// Buffer upload.
// -------------------------------------------------------------------------------------------------

/** Upload (or re-upload if the version changed) an attribute buffer, returning its GL buffer. */
function ensureAttributeBuffer(
    gl: WebGL2RenderingContext,
    gb: GeometryBuffers,
    name: string,
    buffer: GpuBuffer,
): WebGLBuffer {
    let glBuffer = gb.attributeBuffers.get(name);
    const lastVersion = gb.attributeVersions.get(name) ?? -1;

    if (!glBuffer) {
        const created = gl.createBuffer();
        if (!created) throw new Error('[WebGLRenderer] gl.createBuffer returned null.');
        glBuffer = created;
        gb.attributeBuffers.set(name, glBuffer);
    }

    if (lastVersion !== buffer.version || gb.attributeVersions.get(name) === undefined) {
        const array = buffer.array;
        if (!array) throw new Error(`[WebGLRenderer] attribute buffer '${name}' has null array.`);
        gl.bindBuffer(gl.ARRAY_BUFFER, glBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, array, gl.STATIC_DRAW);
        gb.attributeVersions.set(name, buffer.version);
    }

    return glBuffer;
}

/** Upload (or re-upload) the index buffer, returning its GL buffer. */
function ensureIndexBuffer(gl: WebGL2RenderingContext, gb: GeometryBuffers, index: GpuBuffer): WebGLBuffer {
    if (!gb.indexBuffer) {
        const created = gl.createBuffer();
        if (!created) throw new Error('[WebGLRenderer] gl.createBuffer returned null (index).');
        gb.indexBuffer = created;
    }
    if (gb.indexVersion !== index.version) {
        const array = index.array;
        if (!array) throw new Error('[WebGLRenderer] index buffer has null array.');
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gb.indexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, array, gl.STATIC_DRAW);
        gb.indexVersion = index.version;
    }
    return gb.indexBuffer;
}

// -------------------------------------------------------------------------------------------------
// VAO construction.
// -------------------------------------------------------------------------------------------------

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
export function prepareGeometry(
    gl: WebGL2RenderingContext,
    state: GeometriesState,
    geometry: Geometry,
    nodeState: NodeBuilderState,
    program: WebGLProgram,
): GeometryDrawInfo {
    const gb = getGeometryBuffers(state, geometry);

    // Upload all attribute buffers referenced by the compiled vertex buffer groups (+ any re-uploads).
    for (const group of nodeState.vertexBufferGroups) {
        if (group.name !== null) {
            const buffer = geometry.buffers.get(group.name);
            if (buffer) ensureAttributeBuffer(gl, gb, group.name, buffer);
        } else if (group.buffer) {
            // Direct (non-geometry) buffer: key it by a synthetic name derived from its identity.
            const key = `__direct_${group.attributes[0]?.shaderLocation ?? 0}`;
            ensureAttributeBuffer(gl, gb, key, group.buffer);
        }
    }

    // Upload the index buffer if present.
    let indexType: number | null = null;
    if (geometry.index) {
        ensureIndexBuffer(gl, gb, geometry.index);
        indexType = glIndexType(gl, geometry.index.array);
    }

    // Build (or reuse) the VAO for this program.
    let vao = gb.vaos.get(program);
    if (!vao) {
        const created = gl.createVertexArray();
        if (!created) throw new Error('[WebGLRenderer] gl.createVertexArray returned null.');
        vao = created;
        gb.vaos.set(program, vao);

        gl.bindVertexArray(vao);

        for (const group of nodeState.vertexBufferGroups) {
            // Resolve the GL buffer for this group.
            let glBuffer: WebGLBuffer | undefined;
            if (group.name !== null) {
                glBuffer = gb.attributeBuffers.get(group.name);
            } else if (group.buffer) {
                const key = `__direct_${group.attributes[0]?.shaderLocation ?? 0}`;
                glBuffer = gb.attributeBuffers.get(key);
            }
            if (!glBuffer) continue;

            gl.bindBuffer(gl.ARRAY_BUFFER, glBuffer);

            for (const attr of group.attributes) {
                const fmt = attribFormat(attr.type);
                const compType = glComponentType(gl, fmt.glType);
                // Stride: explicit group stride if set (interleaved), else the element byte size.
                const stride = group.stride > 0 ? group.stride : fmt.byteSize;
                // Bytes per column, for multi-slot matrix attributes.
                const columnBytes = fmt.size * 4;

                for (let slot = 0; slot < fmt.slots; slot++) {
                    const location = attr.shaderLocation + slot;
                    const offset = attr.offset + slot * columnBytes;
                    gl.enableVertexAttribArray(location);
                    if (fmt.glType === 'float') {
                        gl.vertexAttribPointer(location, fmt.size, compType, false, stride, offset);
                    } else {
                        gl.vertexAttribIPointer(location, fmt.size, compType, stride, offset);
                    }
                    if (group.instanced) gl.vertexAttribDivisor(location, 1);
                }
            }
        }

        // Bind the index buffer inside the VAO so it is captured as element-array state.
        if (gb.indexBuffer) {
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gb.indexBuffer);
        }

        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    }

    return { vao, indexType };
}

/** Dispose all GL resources owned by the geometries state for a single geometry. */
export function disposeGeometry(gl: WebGL2RenderingContext, state: GeometriesState, geometry: Geometry): void {
    const gb = state.data.get(geometry);
    if (!gb) return;
    for (const buf of gb.attributeBuffers.values()) gl.deleteBuffer(buf);
    if (gb.indexBuffer) gl.deleteBuffer(gb.indexBuffer);
    for (const vao of gb.vaos.values()) gl.deleteVertexArray(vao);
    state.data.delete(geometry);
}
