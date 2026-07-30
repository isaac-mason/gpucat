/**
 * probe.ts (webgl) - render a single RenderObject with a PATCHED fragment shader into a tiny FBO and
 * read back the resulting color. Drives the Inspector's live-value shader probe on the WebGL backend.
 *
 * This is the GL sibling of the WebGPU probe re-render in inspector.ts. It reuses the SAME device
 * layer the normal draw uses — `programs.ts` to compile+link a patched program (real vertex GLSL +
 * the probe's patched fragment GLSL), `geometries.ts` to bind the object's VAO, `uniforms.ts` to
 * update+bind its std140 UBOs (camera/model, already valid this frame), and `texture-bindings.ts`
 * for its textures — so the probe renders the same mesh with the same inputs, only the fragment
 * output changes. It renders to a 1×1 RGBA8 FBO and `gl.readPixels` the single pixel, returning the
 * decoded value.
 *
 * Nothing here touches WebGPU. The patched-program cache is keyed by the patched fragment source so
 * hovering the same expression across frames reuses one program.
 */
import type { NodeFrame } from '../core/node-frame';
import { type RenderObject } from '../core/render-object';
import * as Geometries from './geometries';
import type { GlSamplersState } from './samplers';
import type { GlTexturesState } from './textures';
import * as Uniforms from './uniforms';
/** The device caches + node frame the probe render needs (a subset of the renderer's caches). */
export type ProbeCaches = {
    geometries: Geometries.GeometriesState;
    uniforms: Uniforms.UniformsState;
    textures: GlTexturesState;
    samplers: GlSamplersState;
    frame: NodeFrame;
};
/** A cached probe program: the linked GL program + its UBO binding points, plus the 1×1 readback FBO. */
type ProbeGl = {
    program: WebGLProgram;
    uboBindingPoints: Map<string, number>;
    samplerLocations: Map<string, WebGLUniformLocation | null>;
    fbo: WebGLFramebuffer;
    colorTex: WebGLTexture;
    depthRb: WebGLRenderbuffer;
    /** The patched fragment source this program was built from (cache key). */
    fragmentSrc: string;
};
/** The opaque state the renderer holds between probe frames (one active probe program). */
export type ProbeState = {
    gl: ProbeGl | null;
};
export declare function createProbeState(): ProbeState;
export declare function disposeProbeState(gl: WebGL2RenderingContext | null, state: ProbeState): void;
/**
 * Render the RenderObject with the patched fragment into the 1×1 FBO and read back the pixel.
 *
 * Reuses the object's VAO / UBOs / textures via the shared device functions. Returns the RGBA bytes
 * (0..255) of the single rendered pixel, or null if the object has nothing to draw. Restores GL
 * bindings (framebuffer, VAO, program) to their defaults afterward so the main render loop is
 * unaffected — the probe runs after the main frame's draws, on a separate FBO.
 */
export declare function renderProbe(gl: WebGL2RenderingContext, state: ProbeState, caches: ProbeCaches, ro: RenderObject, patchedFragment: string): Uint8Array | null;
export {};
