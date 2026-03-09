import { ConstNode, vec4f, Node } from './core';
import * as d from '../schema';

let _outputStructCounter = 0;

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

export class OutputStructNode extends Node<d.vec4f> {
    /**
     * Array of output nodes. Each node maps to @location(index).
     * All nodes should produce vec4f values.
     */
    members: Node<d.Any>[];

    /** Type flag for runtime checking. */
    readonly isOutputStructNode = true;

    constructor(members: Node<d.Any>[] = [], id?: string) {
        super(id ?? `_output_struct_${_outputStructCounter++}`, d.vec4f);
        this.members = members;
    }
}

let _mrtCounter = 0;

/**
 * MRT (Multiple Render Targets) node.
 *
 * Takes a dictionary of named outputs. At setup time, the names are resolved
 * to @location(N) indices based on the current render target's texture names.
 *
 * @example
 * // Set up render target with named textures:
 * const rt = new RenderTarget(device, w, h, { count: 3 });
 * rt.textures[0].name = 'color';
 * rt.textures[1].name = 'normal';
 * rt.textures[2].name = 'velocity';
 *
 * // Create MRT node:
 * const mrtNode = mrt({
 *     color: outputColor,      // -> @location(0)
 *     normal: viewNormal,      // -> @location(1)
 *     velocity: motionVector,  // -> @location(2)
 * });
 *
 * // Use in material:
 * const mat = new Material({
 *     vertex: clipPos,
 *     fragment: mrtNode,
 * });
 */

export class MRTNode extends OutputStructNode {
    /**
     * Dictionary of named outputs. Keys are texture names,
     * values are nodes producing vec4f values.
     */
    outputNodes: Record<string, Node<d.Any>>;

    /** Type flag for runtime checking. */
    readonly isMRTNode = true;

    /**
     * Resolved output names in order. Populated during setup() when
     * render target is known. Used by the compiler to emit correct
     * @location indices.
     */
    _resolvedNames: string[] = [];

    constructor(outputNodes: Record<string, Node<d.Any>>) {
        super([], `_mrt_${_mrtCounter++}`);
        this.outputNodes = outputNodes;
    }

    /**
     * Returns true if this MRT node has an output with the given name.
     */
    has(name: string): boolean {
        return this.outputNodes[name] !== undefined;
    }

    /**
     * Returns the output node for the given name.
     */
    get(name: string): Node<d.Any> | undefined {
        return this.outputNodes[name];
    }

    /**
     * Merge another MRTNode's outputs into this one.
     * Returns a new MRTNode with combined outputs (other's outputs override this's).
     */
    merge(other: MRTNode): MRTNode {
        return new MRTNode({ ...this.outputNodes, ...other.outputNodes });
    }

    /**
     * Resolve output names to @location indices based on render target textures.
     * Called by the compiler when the render target is known.
     *
     * @param getTextureIndex - Function that maps texture name to index (from RenderTarget)
     */
    resolveOutputs(getTextureIndex: (name: string) => number): void {
        const members: Node<d.Any>[] = [];
        const names: string[] = [];

        for (const name in this.outputNodes) {
            const index = getTextureIndex(name);
            if (index === -1) {
                console.warn(`[MRTNode] Output '${name}' not found in render target textures. Skipping.`);
                continue;
            }
            // Ensure the node outputs vec4f (wrap if needed)
            let node = this.outputNodes[name];
            if (node.type.wgslType !== 'vec4f') {
                node = vec4f(node as Node<d.vec3f>, new ConstNode(d.f32, 1));
            }
            members[index] = node;
            names[index] = name;
        }

        this.members = members;
        this._resolvedNames = names;
    }
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

export function mrt(outputNodes: Record<string, Node<d.Any>>): MRTNode {
    return new MRTNode(outputNodes);
}
