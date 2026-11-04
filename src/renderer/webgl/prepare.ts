import { type CompileGlslOptions, compileGlsl } from '../../nodes/builder';
import { compileNodeState, type NodeManagerState, needsNodeUpdate } from '../core/node-manager';
import { getBindings, type RenderObject } from '../core/render-object';
import type { SharedPlacement } from '../core/shared-blocks';
import { holdProgram, releaseProgram } from './programs';
import { getRenderObjectGl } from './render-object-gl';
import type { WebGLBackend } from './webgl-backend';

/**
 * Everything an object needs once: GLSL, bind groups, a linked program. VAOs and UBO uploads depend
 * on per-object frame state, so they stay in the draw loop. Throws naming the object it cannot draw.
 */
export function prepareRenderObject(
    gl: WebGL2RenderingContext,
    b: WebGLBackend,
    nodes: NodeManagerState,
    renderObject: RenderObject,
    glslOptions?: CompileGlslOptions,
): void {
    // Indirect draw is WebGPU-only. WebGL2 has no drawElementsIndirect / drawArraysIndirect (it can't
    // read draw args from a GPU buffer), and the WEBGL_multi_draw translation is patchy across drivers,
    // so gpucat rejects it here — once per object at prepare, not per-frame — rather than partially
    // supporting it.
    if (renderObject.geometry.indirect) {
        throw new Error(
            '[webgl] indirect draw (geometry.indirect) is not supported on the WebGL2 backend; use the webgpu backend.',
        );
    }

    // (Re)compile the node graph to GLSL if the material/geometry version changed.
    if (needsNodeUpdate(nodes, renderObject)) {
        // Bind the GLSL emitter options (precision) into the compile callback. When no options are
        // requested this is `compileGlsl` with defaults — byte-identical to the golden path.
        const compile = (slots: Parameters<typeof compileGlsl>[0], shared: SharedPlacement | null) =>
            compileGlsl(slots, { ...glslOptions, shared: shared ?? undefined });
        compileNodeState(nodes, renderObject, compile);
        // A recompile invalidates the cached program payload (the source may have changed).
        releaseProgram(gl, b.programs, b.glState, getRenderObjectGl(b.renderObjectGl, renderObject));
    }

    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState || !nodeState.vertexCode) {
        throw new Error(
            `[webgl] '${renderObject.mesh.name || 'mesh'}' compiled to no vertex GLSL; skipping it here drops ` +
                'it from the pass, which reads as a missing object rather than a failed compile.',
        );
    }

    // Ensure the RenderObject's bind groups exist (clones non-shared, reuses shared).
    getBindings(renderObject);

    // Compile + link (or fetch the cached) GL program for this material's source.
    const payload = getRenderObjectGl(b.renderObjectGl, renderObject);
    if (!payload.program) {
        holdProgram(gl, b.programs, b.glState, payload, nodeState.vertexCode, nodeState.uniformGroups, nodeState.textures);
    }
}
