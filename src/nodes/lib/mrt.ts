import { LiteralNode, vec4f, Node } from './core';
import * as d from '../../schema/schema';
import { BlendMode } from '../../material/blend-mode';

const _noBlending = /*#__PURE__*/ new BlendMode('no');
const _materialBlending = /*#__PURE__*/ new BlendMode('material');

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

    constructor(members: Node<d.Any>[] = []) {
        super(d.vec4f);
        this.members = members;
    }
}

export class MRTNode extends OutputStructNode {
    /**
     * Dictionary of named outputs. Keys are texture names,
     * values are nodes producing vec4f values.
     */
    outputNodes: Record<string, Node<d.Any>>;

    /**
     * Per-output blend modes. Default `output` uses the material's blend;
     * any name without an entry falls back to no-blend.
     */
    blendModes: Record<string, BlendMode> = { output: _materialBlending };

    /** Type flag for runtime checking. */
    readonly isMRTNode = true;

    /**
     * Resolved output names in order. Populated during setup() when
     * render target is known. Used by the compiler to emit correct
     * @location indices.
     */
    _resolvedNames: string[] = [];

    constructor(outputNodes: Record<string, Node<d.Any>>) {
        super([]);
        this.outputNodes = outputNodes;
    }

    setBlendMode(name: string, blend: BlendMode): this {
        this.blendModes[name] = blend;
        return this;
    }

    getBlendMode(name: string): BlendMode {
        return this.blendModes[name] || _noBlending;
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
        const merged = new MRTNode({ ...this.outputNodes, ...other.outputNodes });
        merged.blendModes = { ...this.blendModes, ...other.blendModes };
        return merged;
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
                node = vec4f(node as Node<d.vec3f>, new LiteralNode(d.f32, 1));
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
