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
import { assertVertexBuffers } from '../core/node-builder-state';
import * as Buffers from './buffers';

/** Per-geometry GL resources. Only VAOs: the buffers themselves belong to `buffers.ts`, keyed by
 *  `GpuBuffer`, so two geometries sharing one buffer share its GL object rather than each uploading. */
type GeometryBuffers = {
    /** VAOs keyed by program identity (a geometry may be drawn by several materials). */
    vaos: Map<WebGLProgram, WebGLVertexArrayObject>;
    /** A VAO bakes in the buffers bound when it was built, so a rebind invalidates every one of them. */
    bindingsVersion: number;
};

/** Geometries state: per-geometry VAOs, keyed by geometry identity. */
export type GeometriesState = {
    data: WeakMap<Geometry, GeometryBuffers>;
    /** Cached `gl.MAX_VERTEX_ATTRIBS`, read once (guards attribute-location assignment). */
    maxVertexAttribs?: number;
    /** Resident-geometry tally for `renderer.info.memory`. `data` is a WeakMap, so it cannot be counted. */
    memory: { geometries: number };
};

/** Create an empty geometries state. */
export function createGeometriesState(): GeometriesState {
    return { data: new WeakMap(), memory: { geometries: 0 } };
}

/** Resident geometry count. Mirrors `webgpu/geometries.ts` `getGeometriesStats`. */
export function getGeometriesStats(state: GeometriesState): { geometries: number } {
    return { ...state.memory };
}

/** The `GpuBuffer` a compiled vertex-buffer group reads from: a named geometry buffer, or a direct one. */
function groupBuffer(geometry: Geometry, group: NodeBuilderState['vertexBufferGroups'][number]): GpuBuffer | undefined {
    return group.name !== null ? geometry.buffers.get(group.name) : (group.buffer ?? undefined);
}

function getGeometryBuffers(gl: WebGL2RenderingContext, state: GeometriesState, geometry: Geometry): GeometryBuffers {
    let gb = state.data.get(geometry);
    if (!gb) {
        gb = { vaos: new Map(), bindingsVersion: geometry.bindingsVersion };
        state.data.set(geometry, gb);
        state.memory.geometries++;
        // Release the VAOs when the Geometry goes away. The buffers release themselves through
        // `buffers.ts`, which owns them and may be sharing them with another geometry.
        geometry._onDispose = () => {
            disposeGeometry(gl, state, geometry);
        };
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
        `[webgl] index buffer array type '${ctorName}' is not supported on the WebGL2 backend ` +
            `(expected Uint8Array, Uint16Array, or Uint32Array).`,
    );
}

// WGSL attribute type → GL vertex-attrib descriptor.

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
export function attribFormat(type: string): AttribFormat {
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
            throw new Error(`[webgl] vertex attribute format '${type}' is not supported on the WebGL2 backend.`);
    }
}

export function glComponentType(gl: WebGL2RenderingContext, glType: AttribFormat['glType']): number {
    switch (glType) {
        case 'int':
            return gl.INT;
        case 'uint':
            return gl.UNSIGNED_INT;
        case 'float':
            return gl.FLOAT;
        default: {
            // A new `glType` variant reaches here as a type error rather than silently as gl.FLOAT.
            const unhandled: never = glType;
            throw new Error(`[webgl] no GL component type for '${unhandled}'.`);
        }
    }
}

// Buffer upload.

// VAO construction.

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
    buffers: Buffers.BufferCache,
    geometry: Geometry,
    nodeState: NodeBuilderState,
    program: WebGLProgram,
    label = 'geometry',
): GeometryDrawInfo {
    const gb = getGeometryBuffers(gl, state, geometry);

    // Detach any currently-bound VAO before uploading. An index upload binds ELEMENT_ARRAY_BUFFER,
    // which is captured as VAO state — doing that while a *previous* object's cached VAO is still
    // bound would rewrite that VAO's element binding to this geometry's index buffer, so its next
    // draw would run against the wrong (possibly smaller) buffer. Uploads must land on the default
    // VAO 0. The caller (the draw loop) rebinds the resolved VAO after this returns.
    gl.bindVertexArray(null);

    assertVertexBuffers(geometry, nodeState, label);

    // Upload every buffer the compiled vertex-buffer groups read from (+ any re-uploads).
    for (const group of nodeState.vertexBufferGroups) {
        const buffer = groupBuffer(geometry, group);
        if (buffer) Buffers.ensureUploaded(gl, buffers, buffer, gl.ARRAY_BUFFER, group.name ?? 'attribute');
    }

    // Upload the index buffer if present.
    let indexType: number | null = null;
    if (geometry.index) {
        Buffers.ensureUploaded(gl, buffers, geometry.index, gl.ELEMENT_ARRAY_BUFFER, 'index');
        indexType = glIndexType(gl, geometry.index.array);
    }

    if (gb.bindingsVersion !== geometry.bindingsVersion) {
        for (const stale of gb.vaos.values()) gl.deleteVertexArray(stale);
        gb.vaos.clear();
        gb.bindingsVersion = geometry.bindingsVersion;
    }

    // Build (or reuse) the VAO for this program.
    let vao = gb.vaos.get(program);
    if (!vao) {
        const created = gl.createVertexArray();
        if (!created) throw new Error('[webgl] gl.createVertexArray returned null.');
        vao = created;
        gb.vaos.set(program, vao);

        gl.bindVertexArray(vao);

        for (const group of nodeState.vertexBufferGroups) {
            const buffer = groupBuffer(geometry, group);
            const glBuffer = buffer ? Buffers.getUploaded(buffers, buffer) : undefined;
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
                    // Guard against the device attribute cap: a location past MAX_VERTEX_ATTRIBS is a
                    // silent no-op fetch (the shader reads zeros). Report it as a clear error instead.
                    if (state.maxVertexAttribs == null) {
                        state.maxVertexAttribs = gl.getParameter(gl.MAX_VERTEX_ATTRIBS) as number;
                    }
                    if (location >= state.maxVertexAttribs) {
                        throw new Error(
                            `[webgl] a geometry uses vertex attribute location ${location}, but this ` +
                                `device's MAX_VERTEX_ATTRIBS=${state.maxVertexAttribs}; reduce the number of vertex ` +
                                `attributes on the WebGL2 backend.`,
                        );
                    }
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
        const glIndex = geometry.index ? Buffers.getUploaded(buffers, geometry.index) : undefined;
        if (glIndex) {
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, glIndex);
        }

        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    }

    return { vao, indexType };
}

/**
 * Dispose the GL resources this module owns for one geometry: its VAOs.
 *
 * Not its buffers. `buffers.ts` owns those, keyed by `GpuBuffer`, and another geometry may still be
 * drawing from the same one; each buffer releases itself when its own `GpuBuffer` is disposed.
 */
export function disposeGeometry(gl: WebGL2RenderingContext, state: GeometriesState, geometry: Geometry): void {
    const gb = state.data.get(geometry);
    if (!gb) return;
    for (const vao of gb.vaos.values()) gl.deleteVertexArray(vao);
    state.memory.geometries--;
    state.data.delete(geometry);
}
