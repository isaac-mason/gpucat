import * as d from '../../schema/schema';
import { CallNode, Node, NodeKind, type ParamDesc, type ParamDescsToNodes } from './core';
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
    readonly kind = NodeKind.WgslFunction;
    /** Global nodes use globalCache for deduplication */
    global: boolean;
    /** The native WGSL shader code. Empty for GLSL-only functions. */
    code: string;
    /**
     * The GLSL companion source (a complete GLSL function definition with the same name + signature
     * as the WGSL one). Undefined for WGSL-only functions. When present the GLSL emitter emits this
     * instead of throwing.
     */
    glslCode?: string;
    /** Array of included CodeNodes/FunctionNodes */
    includes: WgslFunctionNode[];
    constructor(code?: string, includes?: WgslFunctionNode[], glslCode?: string);
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
    /**
     * Optional GLSL companion source: a complete GLSL function definition with the SAME name +
     * parameter order as the WGSL one. When provided, the same node compiles on both backends:
     * the WGSL emitter uses `source`, the GLSL emitter uses `glsl`.
     */
    readonly glsl?: string;
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
    readonly glsl?: string;
}, includes?: (WgslFnCallable | WgslFunctionNode)[]): WgslFnCallableTyped<D, P>;
export declare function wgslFn<D extends d.Any>(source: string, layout: {
    readonly output: D;
    readonly params?: undefined;
    readonly glsl?: string;
}, includes?: (WgslFnCallable | WgslFunctionNode)[]): WgslFnCallableUntyped<D>;
export declare function wgslFn(source: string, includes?: (WgslFnCallable | WgslFunctionNode)[]): WgslFnCallable;
/** Layout descriptor for glslFn - like WgslFnLayout but the name can't be parsed from GLSL. */
export type GlslFnLayout<D extends d.Any, P extends readonly ParamDesc[] = readonly ParamDesc[]> = {
    /** The GLSL function name (used to build the call). Must match the name in `source`. */
    readonly name: string;
    readonly output: D;
    readonly params?: [...P];
};
/**
 * Create a GLSL-only function from raw GLSL source code.
 *
 * Mirrors `wgslFn` but targets the WebGL backend only; the returned callable emits the GLSL
 * function on the WebGL backend and throws on the WebGPU (WGSL) backend. For a function that runs
 * on BOTH backends, use `wgslFn(wgslSrc, { output, params, glsl: glslSrc })` instead.
 *
 * The layout must carry the function `name` (GLSL can't be parsed for it) and `output` type; `params`
 * are optional but recommended for type-checked call sites.
 *
 * @example
 * const tint = glslFn(
 *     `vec3 tint(vec3 c, float k) { return c * k; }`,
 *     { name: 'tint', output: d.vec3f, params: [{ name: 'c', type: d.vec3f }, { name: 'k', type: d.f32 }] },
 * );
 */
export declare function glslFn<D extends d.Any, P extends readonly ParamDesc[]>(source: string, layout: {
    readonly name: string;
    readonly output: D;
    readonly params: [...P];
}, includes?: (WgslFnCallable | WgslFunctionNode)[]): WgslFnCallableTyped<D, P>;
export declare function glslFn<D extends d.Any>(source: string, layout: {
    readonly name: string;
    readonly output: D;
    readonly params?: undefined;
}, includes?: (WgslFnCallable | WgslFunctionNode)[]): WgslFnCallableUntyped<D>;
