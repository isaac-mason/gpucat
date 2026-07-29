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
import type { ArrayNode, AssignNode, BinaryOpNode, BreakNode, CallNode, ConditionalNode, ConstructNode, ContinueNode, DiscardNode, FieldNode, IfNode, IndexNode, InspectorNode, LetNode, LiteralNode, LoopNode, Node, ParameterNode, PrivateVarNode, ReturnNode, StackNode, StructDef, VarNode, WorkgroupVarNode } from './lib/core';
import type { PassNode } from './lib/display/pass-node';
import type { MRTNode, OutputStructNode } from './lib/mrt';
import type { StorageNode } from './lib/storage';
import type { ArrayTextureNode, CubeTextureNode, DepthTextureNode, SamplerNode, StorageTextureBindingNode, TextureBindingNode, TextureNode } from './lib/texture';
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
export type AnyNode = LiteralNode<d.Any> | BinaryOpNode<d.Any> | CallNode<d.Any> | ConstructNode<d.Any> | FieldNode<d.Any> | IndexNode<d.Any> | ArrayNode<d.Any> | ConditionalNode<d.Any> | BuiltinNode<d.Any> | ComputeIndexNode | ParameterNode<d.Any> | LetNode<d.Any> | VarNode<d.Any> | PrivateVarNode<d.Any> | WorkgroupVarNode<d.Any> | AssignNode | ReturnNode<d.Any> | BreakNode | ContinueNode | DiscardNode | LoopNode | IfNode | StackNode | WgslNode<d.Any> | UniformNode<d.Any> | AttributeNode<d.Any> | VaryingNode<d.Any> | StorageNode<d.Any> | OutputStructNode | MRTNode | TextureBindingNode | StorageTextureBindingNode | SamplerNode | TextureNode | CubeTextureNode | DepthTextureNode | ArrayTextureNode | PassNode | InspectorNode<d.Any>;
/** Get all child nodes for traversal */
export declare function getChildren(rawNode: Node<d.Any>): Node<d.Any>[];
/**
 * Recursively walk a type to find and register any struct definitions.
 * Handles: struct, array, sized-array, vec, mat types.
 */
export declare function walkTypeForStructs(type: d.Any, register: (def: StructDef<StructSchema>) => void): void;
