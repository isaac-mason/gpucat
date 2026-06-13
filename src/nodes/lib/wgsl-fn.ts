
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

/**
 * Parse WGSL function source into a NodeFunction.
 */
function parseWgslFunction(source: string): WgslNodeFunction {
    source = source.trim();

    const declarationRegexp = /^[fn]*\s*([a-z_0-9]+)?\s*\(([\s\S]*?)\)\s*[-]*[>]*\s*([a-z_0-9]+(?:<[\s\S]+?>)?)?/i;
    const propertiesRegexp = /([a-z_0-9]+)\s*:\s*([a-z_0-9]+(?:<[\s\S]+?>)?)/ig;

    const declaration = source.match(declarationRegexp);

    if (declaration === null || declaration.length < 2) {
        throw new Error(`[gpucat] FunctionNode: Could not parse WGSL function.\n${source.slice(0, 100)}...`);
    }

    const inputsCode = declaration[2] || '';
    const propsMatches: { name: string; type: string; }[] = [];
    let match: RegExpExecArray | null = null;

    while ((match = propertiesRegexp.exec(inputsCode)) !== null) {
        propsMatches.push({ name: match[1], type: match[2] });
    }

    const inputs: WgslNodeFunctionInput[] = [];
    for (const { name, type } of propsMatches) {
        let resolvedType = type;
        let pointer = false;

        if (resolvedType.startsWith('ptr')) {
            resolvedType = 'pointer';
            pointer = true;
        }

        inputs.push({ name, type: resolvedType, pointer });
    }

    // find where function body starts (after the signature)
    const bodyStart = source.indexOf('{');
    const blockCode = bodyStart >= 0 ? source.substring(bodyStart) : '{}';
    const outputType = declaration[3] || 'void';

    const name = declaration[1] !== undefined ? declaration[1] : '';
    const type = outputType; // keep WGSL type as-is

    return {
        type,
        inputs,
        name,
        inputsCode,
        blockCode,
        outputType,
        getCode(fnName = name): string {
            const outputPart = outputType !== 'void' ? `-> ${outputType}` : '';
            return `fn ${fnName}(${inputsCode.trim()}) ${outputPart}${blockCode}`;
        },
    };
}

export class WgslFunctionNode extends Node<d.WgslFn> {
    /** Type marker for runtime checking */
    readonly isCodeNode = true;

    /** Global nodes use globalCache for deduplication */
    override global = true;

    /** The native shader code */
    code: string;

    /** Array of included CodeNodes/FunctionNodes */
    includes: WgslFunctionNode[];

    /** Type marker for runtime checking */
    readonly isFunctionNode = true;

    constructor(code = '', includes: WgslFunctionNode[] = []) {
        super(d.WgslFn);
        this.code = code;
        this.includes = includes;
    }

    setIncludes(includes: WgslFunctionNode[]): this {
        this.includes = includes;
        return this;
    }

    getIncludes(): WgslFunctionNode[] {
        return this.includes;
    }

    /**
     * Get the node function (parsed WGSL) for this function node.
     */
    getNodeFunction(): WgslNodeFunction {
        return parseWgslFunction(this.code);
    }

    /**
     * Returns the inputs (parameters) of this function.
     */
    getInputs(): WgslNodeFunctionInput[] {
        return this.getNodeFunction().inputs;
    }

    /**
     * Create a CallNode that calls this function.
     * @param args - Arguments to pass (positional or named object)
     */
    call(...args: Node<d.Any>[]): CallNode<d.Any> {
        const nodeFunc = this.getNodeFunction();
        const fnName = nodeFunc.name;
        const returnType = d.descFromWgslType(nodeFunc.outputType);
        return new CallNode(returnType, fnName, args, undefined, this);
    }
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
// Overload 1: with layout including typed params
export function wgslFn<D extends d.Any, P extends readonly ParamDesc[]>(
    source: string,
    layout: { readonly output: D; readonly params: [...P] },
    includes?: (WgslFnCallable | WgslFunctionNode)[]
): WgslFnCallableTyped<D, P>;

// Overload 2: with layout, output only (no params)
export function wgslFn<D extends d.Any>(
    source: string,
    layout: { readonly output: D; readonly params?: undefined },
    includes?: (WgslFnCallable | WgslFunctionNode)[]
): WgslFnCallableUntyped<D>;

// Overload 3: no layout (legacy untyped)
export function wgslFn(
    source: string,
    includes?: (WgslFnCallable | WgslFunctionNode)[]
): WgslFnCallable;

// Implementation
export function wgslFn<D extends d.Any, P extends readonly ParamDesc[]>(
    source: string,
    layoutOrIncludes?: WgslFnLayout<D, P> | (WgslFnCallable | WgslFunctionNode)[],
    includesArg?: (WgslFnCallable | WgslFunctionNode)[]
): WgslFnCallableTyped<D, P> | WgslFnCallableUntyped<D> | WgslFnCallable {
    // Determine layout and includes from arguments
    let layout: WgslFnLayout<D, P> | undefined;
    let includes: (WgslFnCallable | WgslFunctionNode)[] = [];

    if (layoutOrIncludes) {
        if (Array.isArray(layoutOrIncludes)) {
            // Legacy: wgslFn(source, includes)
            includes = layoutOrIncludes;
        } else if ('output' in layoutOrIncludes) {
            // New: wgslFn(source, layout, includes?)
            layout = layoutOrIncludes;
            includes = includesArg ?? [];
        }
    }

    // Extract FunctionNode from callable includes
    const includeNodes: WgslFunctionNode[] = [];
    for (let i = 0; i < includes.length; i++) {
        const include = includes[i];
        // If it's a callable from wgslFn, extract the functionNode
        if (typeof include === 'function') {
            const fn = (include as WgslFnCallable).functionNode;
            if (fn) {
                includeNodes.push(fn);
            }
        } else if (include instanceof WgslFunctionNode) {
            includeNodes.push(include);
        }
    }

    const functionNode = new WgslFunctionNode(source.trim(), includeNodes);
    const nodeFunc = functionNode.getNodeFunction();
    const fnName = nodeFunc.name;
    
    // Use layout output type if provided, otherwise parse from WGSL
    const returnType = layout?.output ?? d.descFromWgslType(nodeFunc.outputType);

    // Return a callable that creates CallNodes
    const fn = (...args: Node<d.Any>[]): CallNode<D> => {
        return new CallNode(returnType as D, fnName, args, undefined, functionNode);
    };

    // Attach functionNode for include resolution
    fn.functionNode = functionNode;

    return fn as WgslFnCallableTyped<D, P>;
}


