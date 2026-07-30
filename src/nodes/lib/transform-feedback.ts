import type { Any } from '../../schema/schema';
import { AttributeNode } from './attribute';
import { type Node, popStack, pushStack, StackNode } from './core';

/**
 * A transform-feedback kernel: named per-element attribute inputs → named captured-varying outputs,
 * authored with the ordinary gpucat DSL body. This is the honest WebGL2 transform-feedback primitive
 * (attribute-in / return-out), NOT a faked `storage()` compute — see
 * llm/webgl-transform-feedback-plan.md. It has no WebGPU analogue; portability is via a shared body
 * `Fn` wrapped in a WebGPU `compute()`, not by this node pretending to span backends.
 *
 * The body runs as the vertex `main()`. The element index is `vertexIndex` (= gl_VertexID); the
 * instanced variant uses `instanceIndex` (= gl_InstanceID).
 */
export class TransformFeedbackNode {
    readonly id: string;

    /** Per-element input attribute schemas, keyed by name (declared `in a_<name>`). */
    readonly inputs: Readonly<Record<string, Any>>;

    /** Captured-varying output schemas, keyed by name (declared `out v_<name>`). */
    readonly outputs: Readonly<Record<string, Any>>;

    /** Input attribute nodes handed to the callback, keyed by input name (emitted as `a_<name>`). */
    readonly inputNodes: Readonly<Record<string, AttributeNode<Any>>>;

    /** The traced kernel body (statements pushed during the callback). */
    readonly body: StackNode;

    /** The per-output value expressions returned by the callback, keyed by output name. */
    readonly outputExprs: Readonly<Record<string, Node<Any>>>;

    readonly name: string | undefined;

    /** Set to true after dispose(). */
    disposed = false;

    /** @internal renderer cleanup hook (Phase 2). */
    _onDispose: (() => void) | null = null;

    constructor(opts: {
        inputs: Record<string, Any>;
        outputs: Record<string, Any>;
        inputNodes: Record<string, AttributeNode<Any>>;
        body: StackNode;
        outputExprs: Record<string, Node<Any>>;
        name?: string;
    }) {
        this.id = `_transformFeedback_${_tfCounter++}`;
        this.inputs = opts.inputs;
        this.outputs = opts.outputs;
        this.inputNodes = opts.inputNodes;
        this.body = opts.body;
        this.outputExprs = opts.outputExprs;
        this.name = opts.name;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this._onDispose?.();
    }
}

let _tfCounter = 0;

/**
 * The kernel callback: receives an object of input attribute nodes keyed by the `inputs` names, and
 * returns an object of output value nodes keyed by the `outputs` names.
 */
export type TransformFeedbackCallback<
    In extends Record<string, Any>,
    Out extends Record<string, Any>,
> = (io: { [K in keyof In]: AttributeNode<In[K]> }) => { [K in keyof Out]: Node<Out[K]> };

export type TransformFeedbackLayout<In extends Record<string, Any>, Out extends Record<string, Any>> = {
    /** Per-element attribute schemas, keyed by name. */
    inputs: In;
    /** Captured-varying schemas, keyed by name. */
    outputs: Out;
    name?: string;
};

/**
 * Free factory for a transform-feedback kernel (the canonical authoring form).
 *
 * @example
 * const kernel = transformFeedback(
 *   (io) => ({ pos: io.pos.add(io.vel) }),
 *   { inputs: { pos: d.vec4f, vel: d.vec4f }, outputs: { pos: d.vec4f } },
 * );
 */
export function transformFeedback<In extends Record<string, Any>, Out extends Record<string, Any>>(
    callback: TransformFeedbackCallback<In, Out>,
    layout: TransformFeedbackLayout<In, Out>,
): TransformFeedbackNode {
    // Build one attribute node per input, sourced by name `a_<name>` (buffers bind at the run site in
    // Phase 2, not baked into the node — see the plan's Runtime API section).
    // Source each attribute by its bare input name; the GLSL emitter adds the `a_` prefix (→ `a_<name>`).
    const inputNodes = {} as { [K in keyof In]: AttributeNode<In[K]> };
    for (const name of Object.keys(layout.inputs) as (keyof In)[]) {
        inputNodes[name] = new AttributeNode(layout.inputs[name], String(name));
    }

    // Trace the callback exactly like FnNode.trace(): push a stack, run the body (which appends its
    // statements to the stack), then capture the returned per-output expressions.
    const body = new StackNode();
    const prev = pushStack(body);
    let outputs: { [K in keyof Out]: Node<Out[K]> };
    try {
        outputs = callback(inputNodes);
    } finally {
        popStack(prev);
    }

    const outputExprs = {} as Record<string, Node<Any>>;
    for (const name of Object.keys(layout.outputs)) {
        const expr = (outputs as Record<string, Node<Any>>)[name];
        if (expr == null) {
            throw new Error(
                `[transformFeedback] kernel did not return an output for '${name}' declared in outputs.`,
            );
        }
        outputExprs[name] = expr;
    }

    return new TransformFeedbackNode({
        inputs: layout.inputs,
        outputs: layout.outputs,
        inputNodes: inputNodes as Record<string, AttributeNode<Any>>,
        body,
        outputExprs,
        name: layout.name,
    });
}
