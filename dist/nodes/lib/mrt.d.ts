import { Node } from './core';
import * as d from '../../schema/schema';
import { BlendMode } from '../../material/blend-mode';
/**
 * Represents a fragment shader output struct with multiple @location outputs.
 * Used for MRT (Multiple Render Targets).
 *
 * Each member in the `members` array corresponds to a @location(N) output.
 * The index in the array determines the @location index.
 *
 * @example
 * // Direct usage (rare):
 * const outputs = new OutputStructNode([colorNode, normalNode, velocityNode]);
 *
 * // Typically created via mrt() helper instead.
 */
export declare class OutputStructNode extends Node<d.vec4f> {
    /**
     * Array of output nodes. Each node maps to @location(index).
     * All nodes should produce vec4f values.
     */
    members: Node<d.Any>[];
    /** Type flag for runtime checking. */
    readonly isOutputStructNode = true;
    constructor(members?: Node<d.Any>[]);
}
export declare class MRTNode extends OutputStructNode {
    /**
     * Dictionary of named outputs. Keys are texture names,
     * values are nodes producing vec4f values.
     */
    outputNodes: Record<string, Node<d.Any>>;
    /**
     * Per-output blend modes. Default `output` uses the material's blend;
     * any name without an entry falls back to no-blend.
     */
    blendModes: Record<string, BlendMode>;
    /** Type flag for runtime checking. */
    readonly isMRTNode = true;
    /**
     * Resolved output names in order. Populated during setup() when
     * render target is known. Used by the compiler to emit correct
     * @location indices.
     */
    _resolvedNames: string[];
    constructor(outputNodes: Record<string, Node<d.Any>>);
    setBlendMode(name: string, blend: BlendMode): this;
    getBlendMode(name: string): BlendMode;
    /**
     * Returns true if this MRT node has an output with the given name.
     */
    has(name: string): boolean;
    /**
     * Returns the output node for the given name.
     */
    get(name: string): Node<d.Any> | undefined;
    /**
     * Merge another MRTNode's outputs into this one.
     * Returns a new MRTNode with combined outputs (other's outputs override this's).
     */
    merge(other: MRTNode): MRTNode;
    /**
     * Resolve output names to @location indices based on render target textures.
     * Called by the compiler when the render target is known.
     *
     * @param getTextureIndex - Function that maps texture name to index (from RenderTarget)
     */
    resolveOutputs(getTextureIndex: (name: string) => number): void;
}
/**
 * Create an MRT (Multiple Render Targets) node from a dictionary of outputs.
 *
 * Output names must match the `.name` property of textures in the render target.
 * The compiler maps each output to the corresponding @location(N) based on
 * texture array indices.
 *
 * @example
 * const mrtOutput = mrt({
 *     color: finalColor,
 *     normal: viewSpaceNormal,
 *     velocity: motionVector,
 * });
 *
 * const material = new Material({
 *     vertex: clipPosition,
 *     fragment: mrtOutput,
 * });
 */
export declare function mrt(outputNodes: Record<string, Node<d.Any>>): MRTNode;
