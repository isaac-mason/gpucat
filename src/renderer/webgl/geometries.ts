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
import { bindVertexArray, deleteVertexArray, type GlState, unbindVertexArray } from './state';
import type { WebGLBackend } from './webgl-backend';

/** A geometry's VAO for one program, and the buffers it was built over. */
type ProgramGeometry = {
    /** What a draw binds. */
    drawInfo: GeometryDrawInfo;
    /** The buffers the VAO reads, in vertex-buffer group order, and the names they upload under. */
    buffers: GpuBuffer[];
    names: string[];
};

/** Per-geometry GL resources. Only VAOs: the buffers themselves belong to `buffers.ts`, keyed by
 *  `GpuBuffer`, so two geometries sharing one buffer share its GL object rather than each uploading. */
type GeometryBuffers = {
    /** Keyed by program identity (a geometry may be drawn by several materials). */
    programs: Map<WebGLProgram, ProgramGeometry>;
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

function getGeometryBuffers(
    gl: WebGL2RenderingContext,
    glState: GlState,
    state: GeometriesState,
    geometry: Geometry,
): GeometryBuffers {
    let gb = state.data.get(geometry);
    if (!gb) {
        gb = { programs: new Map(), bindingsVersion: geometry.bindingsVersion };
        state.data.set(geometry, gb);
        state.memory.geometries++;
        // Release the VAOs when the Geometry goes away. The buffers release themselves through
        // `buffers.ts`, which owns them and may be sharing them with another geometry.
        geometry._onDispose = () => {
            disposeGeometry(gl, glState, state, geometry);
        };
    }
    return gb;
}

/** GL index element type for an index buffer's format; the draw reads garbage if the two disagree. */
function glIndexType(gl: WebGL2RenderingContext, index: GpuBuffer): number {
    if (index.indexFormat === 'uint16') return gl.UNSIGNED_SHORT;
    if (index.indexFormat === 'uint32') return gl.UNSIGNED_INT;
    throw new Error(`[webgl] index buffer '${index.label ?? 'unlabelled'}' has no index format.`);
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
 * draw resources. Re-uploads buffers whose version changed. The VAO is cached per (geometry, program),
 * with the buffers it reads, so a later draw only checks their versions.
 *
 * `bound` is the VAO the caller last bound. It is left bound unless an index upload or a VAO build has
 * to unbind it, and `bound` follows, so the caller can skip binding a VAO that is still bound.
 */
export function prepareGeometry(
    gl: WebGL2RenderingContext,
    b: WebGLBackend,
    geometry: Geometry,
    nodeState: NodeBuilderState,
    program: WebGLProgram,
    label = 'geometry',
): GeometryDrawInfo {
    const gb = getGeometryBuffers(gl, b.glState, b.geometries, geometry);

    if (gb.bindingsVersion !== geometry.bindingsVersion) {
        for (const stale of gb.programs.values()) deleteVertexArray(gl, b.glState, stale.drawInfo.vao);
        gb.programs.clear();
        gb.bindingsVersion = geometry.bindingsVersion;
    }

    let entry = gb.programs.get(program);
    if (entry === undefined) {
        entry = buildProgramGeometry(gl, b.glState, b.buffers, b.geometries, geometry, nodeState, label);
        gb.programs.set(program, entry);
        return entry.drawInfo;
    }

    // An ARRAY_BUFFER binding is not VAO state, so vertex uploads are safe under any bound VAO.
    for (let i = 0; i < entry.buffers.length; i++) {
        Buffers.ensureUploaded(gl, b.buffers, entry.buffers[i], gl.ARRAY_BUFFER, entry.names[i]);
    }

    // An index upload binds ELEMENT_ARRAY_BUFFER, which IS VAO state: `ensureUploaded` lands it on VAO 0 through the
    // record, so a previous object's VAO keeps its own index buffer.
    const index = geometry.index;
    if (index !== undefined && !Buffers.isCurrent(b.buffers, index)) {
        Buffers.ensureUploaded(gl, b.buffers, index, gl.ELEMENT_ARRAY_BUFFER, 'index');
    }

    return entry.drawInfo;
}

/** Uploads what `geometry` draws from under this compile and builds the VAO over it, leaving VAO 0 bound. */
function buildProgramGeometry(
    gl: WebGL2RenderingContext,
    glState: GlState,
    bufferCache: Buffers.BufferCache,
    state: GeometriesState,
    geometry: Geometry,
    nodeState: NodeBuilderState,
    label: string,
): ProgramGeometry {
    assertVertexBuffers(geometry, nodeState, label);
    unbindVertexArray(gl, glState);

    const buffers: GpuBuffer[] = [];
    const names: string[] = [];
    for (const group of nodeState.vertexBufferGroups) {
        const buffer = groupBuffer(geometry, group);
        if (!buffer) {
            throw new Error(
                `[webgl] the shader reads vertex buffer '${group.name ?? '(direct)'}' and the geometry has none; ` +
                    'the attributes it feeds would read whatever was last bound.',
            );
        }
        buffers.push(buffer);
        names.push(group.name ?? 'attribute');
        Buffers.ensureUploaded(gl, bufferCache, buffer, gl.ARRAY_BUFFER, group.name ?? 'attribute');
    }

    let indexType: number | null = null;
    if (geometry.index) {
        Buffers.ensureUploaded(gl, bufferCache, geometry.index, gl.ELEMENT_ARRAY_BUFFER, 'index');
        indexType = glIndexType(gl, geometry.index);
    }

    const vao = gl.createVertexArray();
    if (!vao) throw new Error('[webgl] gl.createVertexArray returned null.');
    bindVertexArray(gl, glState, vao);

    for (let g = 0; g < buffers.length; g++) {
        const group = nodeState.vertexBufferGroups[g];
        gl.bindBuffer(gl.ARRAY_BUFFER, Buffers.getUploaded(bufferCache, buffers[g])!);

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

    // Bind the index buffer inside the VAO so it is captured as its element array.
    const glIndex = geometry.index ? Buffers.getUploaded(bufferCache, geometry.index) : undefined;
    if (glIndex) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, glIndex);
    }

    unbindVertexArray(gl, glState);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

    return { drawInfo: { vao, indexType }, buffers, names };
}

/**
 * Dispose the GL resources this module owns for one geometry: its VAOs.
 *
 * Not its buffers. `buffers.ts` owns those, keyed by `GpuBuffer`, and another geometry may still be
 * drawing from the same one; each buffer releases itself when its own `GpuBuffer` is disposed.
 */
export function disposeGeometry(gl: WebGL2RenderingContext, glState: GlState, state: GeometriesState, geometry: Geometry): void {
    const gb = state.data.get(geometry);
    if (!gb) return;
    for (const entry of gb.programs.values()) deleteVertexArray(gl, glState, entry.drawInfo.vao);
    state.memory.geometries--;
    state.data.delete(geometry);
}
