/**
 * graph.ts — backend-neutral node-graph utilities shared by discovery and every emitter.
 *
 * Pure structural analysis of the DSL node graph: the AnyNode discriminated union, child
 * traversal, and struct-type walking. No WGSL/WebGPU concepts live here — the only value
 * import is NodeKind (for discriminant narrowing); all node classes are type-only.
 */

import type { StructSchema } from '../schema/schema';
import * as d from '../schema/schema';
import type { AttributeNode } from './lib/attribute';
import type { BuiltinNode, ComputeIndexNode } from './lib/builtin';
import type {
    ArrayNode,
    AssignNode,
    BinaryOpNode,
    BreakNode,
    CallNode,
    ConditionalNode,
    ConstructNode,
    ContinueNode,
    DiscardNode,
    FieldNode,
    IfNode,
    IndexNode,
    InspectorNode,
    LetNode,
    LiteralNode,
    LoopNode,
    Node,
    ParameterNode,
    PrivateVarNode,
    ReturnNode,
    StackNode,
    StructDef,
    VarNode,
    WorkgroupVarNode,
} from './lib/core';
import { NodeKind } from './lib/core';
import type { PassNode } from './lib/display/pass-node';
import type { MRTNode, OutputStructNode } from './lib/mrt';
import type { StorageNode } from './lib/storage';
import type {
    ArrayTextureNode,
    CubeTextureNode,
    DepthTextureNode,
    SamplerNode,
    StorageTextureBindingNode,
    TextureBindingNode,
    TextureNode,
} from './lib/texture';
import type { UniformNode } from './lib/uniform';
import type { VaryingNode } from './lib/varying';
import type { WgslNode } from './lib/wgsl';

/**
 * Discriminated union of every node kind the builder dispatches on. Dispatchers
 * alias their incoming node to this (`const node = raw as AnyNode`) so that a
 * `node.kind === NodeKind.X` check narrows to the concrete subclass — replacing
 * `instanceof` without referencing the subclass constructors (keeps them
 * tree-shakeable). Nodes not in this union (e.g. the bare void Node) fall through
 * to the existing catch-all branches.
 */
export type AnyNode =
    | LiteralNode<d.Any>
    | BinaryOpNode<d.Any>
    | CallNode<d.Any>
    | ConstructNode<d.Any>
    | FieldNode<d.Any>
    | IndexNode<d.Any>
    | ArrayNode<d.Any>
    | ConditionalNode<d.Any>
    | BuiltinNode<d.Any>
    | ComputeIndexNode
    | ParameterNode<d.Any>
    | LetNode<d.Any>
    | VarNode<d.Any>
    | PrivateVarNode<d.Any>
    | WorkgroupVarNode<d.Any>
    | AssignNode
    | ReturnNode<d.Any>
    | BreakNode
    | ContinueNode
    | DiscardNode
    | LoopNode
    | IfNode
    | StackNode
    | WgslNode<d.Any>
    | UniformNode<d.Any>
    | AttributeNode<d.Any>
    | VaryingNode<d.Any>
    | StorageNode<d.Any>
    | OutputStructNode
    | MRTNode
    | TextureBindingNode
    | StorageTextureBindingNode
    | SamplerNode
    | TextureNode
    | CubeTextureNode
    | DepthTextureNode
    | ArrayTextureNode
    | PassNode
    | InspectorNode<d.Any>;

/** Get all child nodes for traversal */
export function getChildren(rawNode: Node<d.Any>): Node<d.Any>[] {
    const node = rawNode as AnyNode;
    const children: Node<d.Any>[] = [];

    // _beforeNodes are dependencies that must be processed before this node.
    // They're part of the graph but don't generate sub-expressions for this node.
    if (node._beforeNodes) {
        children.push(...node._beforeNodes);
    }

    if (node.kind === NodeKind.BinaryOp) {
        children.push(node.left, node.right);
    } else if (node.kind === NodeKind.Call) {
        children.push(...node.args);
    } else if (node.kind === NodeKind.Construct) {
        children.push(...node.args);
    } else if (node.kind === NodeKind.Field) {
        children.push(node.object);
    } else if (node.kind === NodeKind.Index) {
        children.push(node.array, node.index);
    } else if (node.kind === NodeKind.Varying) {
        // VaryingNode.node is a SubBuildNode wrapping the source
        // Push the actual source inside the SubBuildNode, not the wrapper itself
        children.push(node.node.node as Node<d.Any>);
    } else if (node.kind === NodeKind.Assign) {
        children.push(node.target, node.value);
    } else if (node.kind === NodeKind.Let || node.kind === NodeKind.Var) {
        children.push(node.init);
    } else if (node.kind === NodeKind.PrivateVar) {
        if (node.init) children.push(node.init);
    } else if (node.kind === NodeKind.WorkgroupVar) {
        // WorkgroupVarNode has no initializer (WGSL doesn't allow it)
    } else if (node.kind === NodeKind.Conditional) {
        children.push(node.condition, node.ifTrue);
        if (node.ifFalse) children.push(node.ifFalse);
    } else if (node.kind === NodeKind.Wgsl) {
        children.push(...node.deps);
    } else if (node.kind === NodeKind.Return) {
        children.push(node.value);
    } else if (node.kind === NodeKind.Inspector) {
        children.push(node.wrappedNode);
    } else if (node.kind === NodeKind.Pass) {
        // PassNode delegates to its texture node during code generation
        const textureNode = node.scope === 'fragment' ? node.getTextureNode() : node.getLinearDepthNode();
        children.push(textureNode);
    } else if (node.kind === NodeKind.TextureBinding) {
        // A binding fed by a render pass depends on that pass: reaching it here makes discovery render
        // the pass (its updateBefore) and order it before this binding's consumers. Otherwise a leaf.
        if (node.passSource) children.push(node.passSource.passNode);
    } else if (node.kind === NodeKind.StorageTextureBinding) {
        // StorageTextureBindingNode is a leaf, no children
    } else if (node.kind === NodeKind.Texture) {
        // TextureNode owns a bindingNode for the texture var declaration
        children.push(node.bindingNode);
        if (node.samplerNode) {
            children.push(node.samplerNode);
        }
        if (node.uvNode) {
            children.push(node.uvNode);
        }
        if (node.levelNode) {
            children.push(node.levelNode);
        }
        if (node.biasNode) {
            children.push(node.biasNode);
        }
        if (node.gradNode) {
            children.push(node.gradNode[0], node.gradNode[1]);
        }
        if (node.offsetNode) {
            children.push(node.offsetNode);
        }
        if (node.loadCoords) {
            children.push(node.loadCoords);
        }
        if (node.loadLevel) {
            children.push(node.loadLevel);
        }
    } else if (node.kind === NodeKind.CubeTexture) {
        children.push(node.bindingNode);
        if (node.samplerNode) {
            children.push(node.samplerNode);
        }
        if (node.directionNode) {
            children.push(node.directionNode);
        }
        if (node.levelNode) {
            children.push(node.levelNode);
        }
        if (node.biasNode) {
            children.push(node.biasNode);
        }
        if (node.gradNode) {
            children.push(node.gradNode[0], node.gradNode[1]);
        }
    } else if (node.kind === NodeKind.DepthTexture) {
        children.push(node.bindingNode);
        if (node.samplerNode) {
            children.push(node.samplerNode);
        }
        if (node.uvNode) {
            children.push(node.uvNode);
        }
        if (node.levelNode) {
            children.push(node.levelNode);
        }
        if (node.offsetNode) {
            children.push(node.offsetNode);
        }
        if (node.loadCoords) {
            children.push(node.loadCoords);
        }
        if (node.loadLevel) {
            children.push(node.loadLevel);
        }
    } else if (node.kind === NodeKind.ArrayTexture) {
        children.push(node.bindingNode);
        if (node.samplerNode) {
            children.push(node.samplerNode);
        }
        if (node.uvNode) {
            children.push(node.uvNode);
        }
        children.push(node.layerNode);
        if (node.levelNode) {
            children.push(node.levelNode);
        }
        if (node.biasNode) {
            children.push(node.biasNode);
        }
        if (node.gradNode) {
            children.push(node.gradNode[0], node.gradNode[1]);
        }
        if (node.offsetNode) {
            children.push(node.offsetNode);
        }
        if (node.loadCoords) {
            children.push(node.loadCoords);
        }
        if (node.loadLevel) {
            children.push(node.loadLevel);
        }
    } else if (node.kind === NodeKind.MRT) {
        // MRTNode stores outputs in outputNodes dict (members only populated post-resolve).
        // Cast: MRT shares OutputStruct's discriminant base, so narrowing stops at the union.
        children.push(...Object.values((node as MRTNode).outputNodes));
    } else if (node.kind === NodeKind.OutputStruct) {
        children.push(...node.members);
    } else if (node.kind === NodeKind.Loop) {
        children.push(node.body);
    } else if (node.kind === NodeKind.If) {
        children.push(node.condition);
        children.push(...node.thenBody.body);
        for (const branch of node.elseIfBranches) {
            children.push(branch.condition);
            children.push(...branch.body.body);
        }
        if (node.elseBody) {
            children.push(...node.elseBody.body);
        }
    } else if (node.kind === NodeKind.Stack) {
        children.push(...node.body);
    }

    return children;
}

/**
 * Recursively walk a type to find and register any struct definitions.
 * Handles: struct, array, sized-array, vec, mat types.
 */
export function walkTypeForStructs(type: d.Any, register: (def: StructDef<StructSchema>) => void): void {
    if (d.isStructDef(type)) {
        register(type as unknown as StructDef<StructSchema>);
        return;
    }

    // For arrays, walk the element type
    if (d.isArrayDesc(type) || d.isSizedArrayDesc(type)) {
        walkTypeForStructs(type.element, register);
        return;
    }

    // For vectors and matrices, no structs to find
}
