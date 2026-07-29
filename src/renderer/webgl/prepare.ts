/**
 * prepare.ts (webgl) - the device half of per-object preparation.
 *
 * Mirrors `webgpu/prepare.ts`: `WebGLRenderer.render()` hands this to the neutral
 * `prepareRenderObjects` loop as its per-object `prepare` callback (via a closure that supplies the
 * `gl` context + caches). For each object it compiles the node graph to GLSL (once, version-gated),
 * ensures the RenderObject's bind groups exist, and compiles + links the GL program (cached by
 * source). The VAO + UBO uploads happen per-draw in the render pass (they depend on per-object frame
 * state), just as the WebGPU path updates bindings/geometry in its draw loop.
 *
 * Returns whether the object is drawable (compiled + program present).
 */

import { compileGlsl, type CompileGlslOptions } from '../../nodes/builder';
import { compileNodeState, needsNodeUpdate, type NodeManagerState } from '../core/node-manager';
import { computeRenderObjectCacheKey, getBindings, type RenderObject } from '../core/render-object';
import type { GeometriesState } from './geometries';
import { getProgram, type ProgramCache } from './programs';
import { getRenderObjectGl, type RenderObjectGlCache } from './render-object-gl';

/**
 * Compile the GLSL program + prepare the RenderObject for drawing. Returns whether it is drawable.
 *
 * @param gl the WebGL2 context
 * @param nodes the node manager (owns compilation + the NodeFrame)
 * @param programs the program cache
 * @param _geometries the geometries cache (VAOs built lazily at draw time)
 * @param renderObjectGl the per-RenderObject GL payload cache
 * @param renderObject the object to prepare
 * @param glslOptions GLSL emitter options (e.g. shader `precision`), threaded into compileGlsl
 */
export function prepareRenderObject(
    gl: WebGL2RenderingContext,
    nodes: NodeManagerState,
    programs: ProgramCache,
    _geometries: GeometriesState,
    renderObjectGl: RenderObjectGlCache,
    renderObject: RenderObject,
    glslOptions?: CompileGlslOptions,
): boolean {
    // Indirect draw is WebGPU-only. WebGL2 has no drawElementsIndirect / drawArraysIndirect (it can't
    // read draw args from a GPU buffer), and the WEBGL_multi_draw translation is patchy across drivers,
    // so gpucat rejects it here — once per object at prepare, not per-frame — rather than partially
    // supporting it.
    if (renderObject.geometry.indirect) {
        throw new Error(
            '[WebGLRenderer] indirect draw (geometry.indirect) is not supported on the WebGL2 backend; use WebGPURenderer.',
        );
    }

    // (Re)compile the node graph to GLSL if the material/geometry version changed.
    if (needsNodeUpdate(nodes, renderObject)) {
        const cacheKey = computeRenderObjectCacheKey(
            renderObject.material,
            renderObject.geometry,
            renderObject.renderContext,
        );
        // Bind the GLSL emitter options (precision) into the compile callback. When no options are
        // requested this is `compileGlsl` with defaults — byte-identical to the golden path.
        const compile = glslOptions ? (slots: Parameters<typeof compileGlsl>[0]) => compileGlsl(slots, glslOptions) : compileGlsl;
        compileNodeState(nodes, renderObject, cacheKey, compile);
        // A recompile invalidates the cached program payload (the source may have changed).
        getRenderObjectGl(renderObjectGl, renderObject).program = null;
    }

    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState || !nodeState.vertexCode) return false;

    // Ensure the RenderObject's bind groups exist (clones non-shared, reuses shared).
    getBindings(renderObject);

    // Compile + link (or fetch the cached) GL program for this material's source.
    const payload = getRenderObjectGl(renderObjectGl, renderObject);
    if (!payload.program) {
        payload.program = getProgram(gl, programs, nodeState.vertexCode, nodeState.uniformGroups);
    }

    return true;
}
