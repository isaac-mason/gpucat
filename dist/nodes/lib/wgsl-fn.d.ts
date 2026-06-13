import * as d from '../../schema/schema';
import { CallNode, Node, ParamDesc, ParamDescsToNodes } from './core';
/**
 * Parsed WGSL function info returned by parseWgslFunction().
 */
export type WgslNodeFunctionInput = {
    name: string;
    type: string;
    pointer?: boolean;
};
export type WgslNodeFunction = {
    type: string;
    inputs: WgslNodeFunctionInput[];
    name: string;
    inputsCode: string;
    blockCode: string;
    outputType: string;
    getCode(name?: string): string;
};
export declare class WgslFunctionNode extends Node<d.WgslFn> {
    /** Type marker for runtime checking */
    readonly isCodeNode = true;
    /** Global nodes use globalCache for deduplication */
    global: boolean;
    /** The native shader code */
    code: string;
    /** Array of included CodeNodes/FunctionNodes */
    includes: WgslFunctionNode[];
    /** Type marker for runtime checking */
    readonly isFunctionNode = true;
    constructor(code?: string, includes?: WgslFunctionNode[]);
    setIncludes(includes: WgslFunctionNode[]): this;
    getIncludes(): WgslFunctionNode[];
    /**
     * Get the node function (parsed WGSL) for this function node.
     */
    getNodeFunction(): WgslNodeFunction;
    /**
     * Returns the inputs (parameters) of this function.
     */
    getInputs(): WgslNodeFunctionInput[];
    /**
     * Create a CallNode that calls this function.
     * @param args - Arguments to pass (positional or named object)
     */
    call(...args: Node<d.Any>[]): CallNode<d.Any>;
}
/** Layout descriptor for wgslFn - mirrors FnLayout but without name (parsed from WGSL) */
export type WgslFnLayout<D extends d.Any, P extends readonly ParamDesc[] = readonly ParamDesc[]> = {
    readonly output: D;
    readonly params?: [...P];
};
/** Type for the callable returned by wgslFn with typed params */
export type WgslFnCallableTyped<D extends d.Any, P extends readonly ParamDesc[]> = {
    (...args: ParamDescsToNodes<P>): CallNode<D>;
    functionNode: WgslFunctionNode;
};
/** Type for the callable returned by wgslFn with untyped params */
export type WgslFnCallableUntyped<D extends d.Any> = {
    (...args: Node<d.Any>[]): CallNode<D>;
    functionNode: WgslFunctionNode;
};
/** Type for the callable returned by wgslFn (legacy untyped) */
export type WgslFnCallable = WgslFnCallableUntyped<d.Any>;
/**
 * Create a WGSL function from raw WGSL source code.
 *
 * The source must be a complete WGSL function definition:
 * ```wgsl
 * fn myFunc(a: f32, b: vec3f) -> vec4f {
 *     return vec4f(b * a, 1.0);
 * }
 * ```
 *
 * Returns a callable that creates CallNodes when invoked with arguments.
 *
 * @param source - Complete WGSL function source code
 * @param layout - Optional layout for typed output and params
 * @param includes - Other wgslFn functions this function depends on
 *
 * @example
 * // Untyped (legacy):
 * const aces = wgslFn(`
 *     fn acesToneMapping(color: vec3f) -> vec3f {
 *         ...
 *     }
 * `);
 *
 * @example
 * // Typed output only:
 * const aces = wgslFn(`
 *     fn acesToneMapping(color: vec3f) -> vec3f {
 *         ...
 *     }
 * `, { output: d.vec3f });
 *
 * @example
 * // Fully typed:
 * const aces = wgslFn(`
 *     fn acesToneMapping(color: vec3f) -> vec3f {
 *         ...
 *     }
 * `, { output: d.vec3f, params: [{ name: 'color', type: d.vec3f }] });
 */
export declare function wgslFn<D extends d.Any, P extends readonly ParamDesc[]>(source: string, layout: {
    readonly output: D;
    readonly params: [...P];
}, includes?: (WgslFnCallable | WgslFunctionNode)[]): WgslFnCallableTyped<D, P>;
export declare function wgslFn<D extends d.Any>(source: string, layout: {
    readonly output: D;
    readonly params?: undefined;
}, includes?: (WgslFnCallable | WgslFunctionNode)[]): WgslFnCallableUntyped<D>;
export declare function wgslFn(source: string, includes?: (WgslFnCallable | WgslFunctionNode)[]): WgslFnCallable;
