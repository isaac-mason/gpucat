import { type CompileGlslOptions, compileGlsl } from '../../nodes/builder';
import { compileNodeState, type NodeManagerState, needsNodeUpdate } from '../core/node-manager';
import { computeRenderObjectCacheKey, getBindings, type RenderObject } from '../core/render-object';
import type { BackendState } from './backend-state';
import { getProgram } from './programs';
import { getRenderObjectGl } from './render-object-gl';

/**
 * Compile the GLSL program + prepare the RenderObject for drawing. Returns whether it is drawable.
 *
 * @param gl the WebGL2 context
 * @param nodes the node manager (owns compilation + the NodeFrame)
 * @param b.programs the program cache
 * @param geometries the geometries cache (VAOs built lazily at draw time)
 * @param b.renderObjectGl the per-RenderObject GL payload cache
 * @param renderObject the object to prepare
 * @param glslOptions GLSL emitter options (e.g. shader `precision`), threaded into compileGlsl
 */
/** Everything an object needs once: GLSL, bind groups, a linked program. VAOs and UBO uploads
 *  depend on per-object frame state, so they stay in the draw loop. */
export function prepareRenderObject(
    gl: WebGL2RenderingContext,
    b: BackendState,
    nodes: NodeManagerState,
    renderObject: RenderObject,
    glslOptions?: CompileGlslOptions,
): boolean {
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
        const cacheKey = computeRenderObjectCacheKey(
            renderObject.material,
            renderObject.geometry,
            renderObject.renderContext,
            glslOptions?.maxTextureSize,
        );
        // Bind the GLSL emitter options (precision) into the compile callback. When no options are
        // requested this is `compileGlsl` with defaults — byte-identical to the golden path.
        const compile = glslOptions ? (slots: Parameters<typeof compileGlsl>[0]) => compileGlsl(slots, glslOptions) : compileGlsl;
        compileNodeState(nodes, renderObject, cacheKey, compile);
        // A recompile invalidates the cached program payload (the source may have changed).
        getRenderObjectGl(b.renderObjectGl, renderObject).program = null;
    }

    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState || !nodeState.vertexCode) return false;

    // Ensure the RenderObject's bind groups exist (clones non-shared, reuses shared).
    getBindings(renderObject);

    // Compile + link (or fetch the cached) GL program for this material's source.
    const payload = getRenderObjectGl(b.renderObjectGl, renderObject);
    if (!payload.program) {
        payload.program = getProgram(gl, b.programs, nodeState.vertexCode, nodeState.uniformGroups);
    }

    return true;
}
