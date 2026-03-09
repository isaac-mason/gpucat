
import { CallNode, computeId, Node, type WgslType } from './core';

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

export class WgslFunctionNode extends Node<'wgslfn'> {
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
        super(computeId('wgslfn', { code }), 'wgslfn');
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
    call(...args: Node<WgslType>[]): CallNode<WgslType> {
        const nodeFunc = this.getNodeFunction();
        const fnName = nodeFunc.name;
        const returnType = nodeFunc.outputType as WgslType;
        return new CallNode(returnType, fnName, args, undefined, this);
    }
}

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
 * @param includes - Other wgslFn functions this function depends on
 *
 * @example
 * const aces = wgslFn(`
 *     fn acesToneMapping(color: vec3f) -> vec3f {
 *         let c = color;
 *         return clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
 *     }
 * `);
 *
 * // Use in node graph:
 * const tonemapped = aces(linearColor);
 */
export function wgslFn<T extends WgslType = WgslType>(
    source: string,
    includes: (WgslFnCallable<WgslType> | WgslFunctionNode)[] = []
): WgslFnCallable<T> {
    // Extract FunctionNode from callable includes
    const includeNodes: WgslFunctionNode[] = [];
    for (let i = 0; i < includes.length; i++) {
        const include = includes[i];
        // If it's a callable from wgslFn, extract the functionNode
        if (typeof include === 'function') {
            const fn = (include as WgslFnCallable<WgslType>).functionNode;
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
    const returnType = nodeFunc.outputType as T;

    // Return a callable that creates CallNodes
    const fn = (...args: Node<WgslType>[]): CallNode<T> => {
        return new CallNode(returnType, fnName, args, undefined, functionNode);
    };

    // Attach functionNode for include resolution
    fn.functionNode = functionNode;

    return fn as WgslFnCallable<T>;
}

/** Type for the callable returned by wgslFn */
export type WgslFnCallable<T extends WgslType = WgslType> = {
    (...args: Node<WgslType>[]): CallNode<T>;
    functionNode: WgslFunctionNode;
};
