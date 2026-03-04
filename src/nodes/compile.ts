/**
 * compile.ts — Node graph → WGSL + binding metadata.
 *
 * Pure function: compile(slots) → CompileResult
 *
 * No WebGPU imports. No side effects. Fully usable in Node/workers/offline.
 *
 * Design overview
 * ---------------
 * Two named output slots drive compilation:
 *   position — vec4f clip-space (vertex stage)
 *   color    — vec4f RGBA (fragment stage)
 *
 * The compiler walks each slot's node graph, collects resource bindings
 * (builtins, attributes, uniforms, storage, textures, samplers, varyings),
 * assigns @group/@binding indices, and emits WGSL for both entry points.
 *
 * Builtin binding layout (fixed by renderer contract):
 *   Group 0, binding 0 — Camera UBO          (var<uniform> camera : Camera)
 *   Group 0, binding 1 — Time UBO            (var<uniform> time : Time)
 *   Group 1, binding 0 — Mesh UBO            (var<uniform> mesh : Mesh)   ← always present
 *   Group 1, binding 1+ — material resources (uniforms, textures, samplers in encounter order)
 *
 * InstancedBufferAttributeNode values are NOT bind-group bindings — they are
 * vertex buffer slots (stepMode: 'instance') and appear in VertexInput as
 * @location(N) with generated names.
 *
 * Varyings bridge vertex → fragment. They are collected from both graphs
 * and assigned @location(N) indices in encounter order.
 *
 * Fn nodes are collected from CallNodes that carry a fnNode reference.
 * Each distinct FnNode is emitted once at module scope before the entry points.
 *
 * Statement-level nodes (var, if, for, assign, return) are emitted inside
 * their containing Fn body via a recursive emit walk.
 */

import {
    ParamNode,
    StackNode,
    type AssignNode,
    type AttributeNode,
    type BinopNode,
    type BuiltinNode,
    type CallNode,
    type CondNode,
    type ConstNode,
    type ConstructNode,
    type FieldNode,
    type FnNode,
    type ForNode,
    type IfNode,
    type IndexNode,
    type InstancedBufferAttributeNode,
    type Node,
    type RawNode,
    type ReturnNode,
    type SamplerNode,
    type StorageNode,
    type StructNode,
    type TextureNode,
    type UniformNode,
    type VarNode,
    type VaryingNode,
    type WgslType,
} from './nodes';
import { collectGraph, refCount, topoSort } from './collect';
import { CameraStruct, MeshStruct, TimeStruct } from './std-nodes';
import { lookupStructDef, lookupStructDefByName, type StructDef, type StructSchema } from './schema';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AttributeEntry =
    | {
          kind: 'geometry';
          /** Attribute name (matches geometry.attributes key). */
          name: string;
          /** WGSL type string, e.g. 'vec3f'. */
          type: string;
          /** Shader location index. */
          location: number;
      }
    | {
          kind: 'instanced';
          /** The InstancedBufferAttributeNode owning the data. */
          node: InstancedBufferAttributeNode<WgslType>;
          /** Generated attribute name used in the VertexInput struct (e.g. '_inst0'). */
          name: string;
          /** WGSL type string, e.g. 'vec4f'. */
          type: string;
          /** Shader location index. */
          location: number;
      };

export type VaryingEntry = {
    name: string;
    type: string;
    /** @location index in vertex output / fragment input structs. */
    location: number;
};

/** A single member in a packed material UBO struct. */
export type UniformMember = {
    uniformId: string;
    type: string;
    /** Byte offset within the UBO (std140 rules). */
    offset: number;
    /** Byte size of this field. */
    size: number;
    /** The UniformNode that owns this member. Renderer reads .value from here. */
    node: UniformNode<WgslType>;
};

export type UniformBlockEntry = {
    group: 0 | 1;
    binding: number;
    /** Members sorted by offset. */
    members: UniformMember[];
    totalBytes: number;
};

export type StorageEntry = {
    /** The StorageNode that owns the CPU data. Used by the renderer to upload. */
    node: StorageNode<WgslType>;
    /** Generated WGSL variable name (e.g. '_stor0'). */
    name: string;
    /** Full WGSL array type string (e.g. 'array<mat4x4f>'). */
    type: string;
    access: 'read' | 'read_write';
    group: 0 | 1;
    binding: number;
};

export type TextureEntry = {
    textureId: string;
    /** e.g. 'texture_2d<f32>' */
    type: string;
    group: 0 | 1;
    binding: number;
    /** The TextureNode that owns this entry. Renderer reads .resource from here. */
    node: TextureNode;
};

export type SamplerEntry = {
    samplerId: string;
    type: 'sampler' | 'sampler_comparison';
    group: 0 | 1;
    binding: number;
    /** The SamplerNode that owns this entry. Renderer reads .resource from here. */
    node: SamplerNode;
};

export type CompileResult = {
    /** Complete WGSL module source (both entry points + helpers). */
    code: string;
    attributes: AttributeEntry[];
    varyings: VaryingEntry[];
    uniforms: UniformBlockEntry[];
    storage: StorageEntry[];
    textures: TextureEntry[];
    samplers: SamplerEntry[];
};

// ---------------------------------------------------------------------------
// Compile entry point
// ---------------------------------------------------------------------------

export type CompileSlots = {
    /** vec4f clip-space. Required. */
    position: Node<WgslType>;
    /** vec4f RGBA. Required. */
    color: Node<WgslType>;
};

/**
 * Compile a position + color node graph pair to WGSL and binding metadata.
 *
 * @example
 * import { compile } from './compile.js'
 * const result = compile({ position: positionClip, color: konst('vec4f', [1,0.5,0.1,1]) })
 * console.log(result.code)
 */
export function compile(slots: CompileSlots): CompileResult {
    const ctx = new CompileContext(slots);
    ctx.run();
    return ctx.result();
}

// ---------------------------------------------------------------------------
// std140 size/alignment helpers
// ---------------------------------------------------------------------------

function std140Size(type: string): number {
    switch (type) {
        case 'f32': case 'i32': case 'u32': case 'bool': return 4;
        case 'vec2f': case 'vec2i': case 'vec2u': case 'vec2b': return 8;
        case 'vec3f': case 'vec3i': case 'vec3u': case 'vec3b': return 12;
        case 'vec4f': case 'vec4i': case 'vec4u': case 'vec4b': return 16;
        case 'mat2x2f': return 32;
        case 'mat2x3f': case 'mat2x4f': return 32;
        case 'mat3x2f': return 48;
        case 'mat3x3f': case 'mat3x4f': return 48;
        case 'mat4x2f': return 64;
        case 'mat4x3f': case 'mat4x4f': return 64;
        default: return 16;
    }
}

function std140Align(type: string): number {
    switch (type) {
        case 'f32': case 'i32': case 'u32': case 'bool': return 4;
        case 'vec2f': case 'vec2i': case 'vec2u': case 'vec2b': return 8;
        // vec3 and vec4 both align to 16
        case 'vec3f': case 'vec3i': case 'vec3u': case 'vec3b': return 16;
        case 'vec4f': case 'vec4i': case 'vec4u': case 'vec4b': return 16;
        // matrices: align of column vector (each column is a vec, rounded up to vec4)
        default: return 16;
    }
}

function alignUp(offset: number, align: number): number {
    return Math.ceil(offset / align) * align;
}

// ---------------------------------------------------------------------------
// WGSL type name translation
// ---------------------------------------------------------------------------

/**
 * Converts our internal type strings to valid WGSL type names.
 * Most types are identity (vec3f, mat4x4f, f32 …).
 * Boolean vectors are the exception: 'vec2b' → 'vec2<bool>' etc.
 */
function wgslTypeName(type: string): string {
    if (type === 'vec2b') return 'vec2<bool>';
    if (type === 'vec3b') return 'vec3<bool>';
    if (type === 'vec4b') return 'vec4<bool>';
    return type;
}

// ---------------------------------------------------------------------------
// WGSL constant literal helpers
// ---------------------------------------------------------------------------

function constLiteral(type: string, value: number | number[] | string): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') {
        switch (type) {
            case 'f32': return Number.isInteger(value) ? `${value}.0` : `${value}`;
            case 'i32': return `${Math.trunc(value)}i`;
            case 'u32': return `${Math.trunc(value)}u`;
            case 'bool': return value !== 0 ? 'true' : 'false';
            default: return `${value}`;
        }
    }
    // array value — type constructor
    const components = (value as number[]).map((v) => {
        // determine element type from vec/mat prefix
        if (type.startsWith('vec') && type.endsWith('f')) return Number.isInteger(v) ? `${v}.0` : `${v}`;
        if (type.startsWith('vec') && type.endsWith('i')) return `${Math.trunc(v)}i`;
        if (type.startsWith('vec') && type.endsWith('u')) return `${Math.trunc(v)}u`;
        if (type.startsWith('vec') && type.endsWith('b')) return v !== 0 ? 'true' : 'false';
        if (type.startsWith('mat')) return Number.isInteger(v) ? `${v}.0` : `${v}`;
        return `${v}`;
    });
    if (components.length === 0) return `${wgslTypeName(type)}()`;
    return `${wgslTypeName(type)}(${components.join(', ')})`;
}

// ---------------------------------------------------------------------------
// Builtin WGSL variable names (known to the renderer)
// ---------------------------------------------------------------------------

const BUILTIN_VAR: Record<string, string> = {
    camera:         'camera',
    time:           'time',
    mesh:           'mesh',
    instance_index: 'instance_index',
    instance_data:  'instanceData',
    vertex_index:   'vertex_index',
};

// Builtins that are @builtin(...) vertex inputs (not bind-group resources)
const BUILTIN_VERTEX_INPUT = new Set(['instance_index', 'vertex_index']);



// ---------------------------------------------------------------------------
// CompileContext — internal accumulator
// ---------------------------------------------------------------------------

type BuiltinKind = string; // mirrors nodes.ts BuiltinKind

class CompileContext {
    private slots: CompileSlots;

    // Collected resources, in encounter order
    private attributes: Map<string, AttributeEntry & { kind: 'geometry' }> = new Map();
    private instancedAttrs: Array<AttributeEntry & { kind: 'instanced' }> = [];
    private varyings: Map<string, VaryingEntry> = new Map();
    private builtinsUsed: Set<BuiltinKind> = new Set();
    private structNodes: Map<string, StructNode> = new Map();

    // Material-group resources (group 1, binding 1+)
    private uniformNodes: Map<string, UniformNode<WgslType>> = new Map();
    private storageNodes: Map<string, StorageNode<WgslType>> = new Map();
    private storageNames: Map<string, string> = new Map(); // node.id → '_stor0' etc.
    private textureNodes: Map<string, TextureNode> = new Map();
    private samplerNodes: Map<string, SamplerNode> = new Map();

    // FnNodes encountered (via CallNode.fnNode), in encounter order
    private fnNodes: Map<string, FnNode<WgslType>> = new Map();

    // Per-graph ref counts for let-binding extraction
    private vertRefCounts: Map<string, number> = new Map();
    private fragRefCounts: Map<string, number> = new Map();

    // Topo-sorted node IDs per stage
    private vertOrder: string[] = [];
    private fragOrder: string[] = [];

    // The full merged node set (id → node) for expression lookup
    private allNodes: Map<string, Node<WgslType>> = new Map();

    // Maps InstancedBufferAttributeNode id → generated attr name (e.g. '_inst0')
    private instancedAttrNames: Map<string, string> = new Map();

    constructor(slots: CompileSlots) {
        this.slots = slots;
    }

    // -----------------------------------------------------------------------
    // Phase 1 — collect graphs
    // -----------------------------------------------------------------------

    run(): void {
        const vertGraph = collectGraph(this.slots.position);
        const fragGraph = collectGraph(this.slots.color);

        // Stage validation — vertex-only nodes must not appear in the fragment graph.
        // Catching this here (JS time) produces a clear error rather than a GPU validation failure.
        for (const node of fragGraph.nodes.values()) {
            if (node.kind === 'attribute') {
                const n = node as AttributeNode<WgslType>;
                throw new Error(
                    `[gpucat] attribute('${n.type}', '${n.name}') is a vertex-only node and cannot be used ` +
                    `in the fragment graph. Bridge it to the fragment stage with varying('${n.type}', '<name>', ${n.name}).`,
                );
            }
            if (node.kind === 'instanced_buffer_attribute') {
                throw new Error(
                    `[gpucat] instancedBufferAttribute() is a vertex-only node and cannot be used ` +
                    `in the fragment graph. Bridge it to the fragment stage with varying('<type>', '<name>', <node>).`,
                );
            }
        }

        // For each VaryingNode in the fragment graph, collect its source subgraph into the
        // vertex graph. This ensures varying sources (attributes, expressions) are reachable
        // during vertex emission even when they are not part of the position graph.
        const vertNodes = new Map(vertGraph.nodes);
        for (const node of fragGraph.nodes.values()) {
            if (node.kind === 'varying') {
                const vn = node as VaryingNode<WgslType>;
                const srcGraph = collectGraph(vn.source);
                for (const [id, n] of srcGraph.nodes) {
                    if (!vertNodes.has(id)) vertNodes.set(id, n);
                }
            }
        }

        // Merge into allNodes (for expression lookup during emit)
        for (const [id, n] of vertNodes) this.allNodes.set(id, n);
        for (const [id, n] of fragGraph.nodes) this.allNodes.set(id, n);

        this.vertRefCounts = refCount(vertNodes);
        this.fragRefCounts = refCount(fragGraph.nodes);

        this.vertOrder = topoSort(vertNodes, vertGraph.rootId);
        this.fragOrder = topoSort(fragGraph.nodes, fragGraph.rootId);

        // Walk both graphs to collect resources
        this.collectResources(vertNodes);
        this.collectResources(fragGraph.nodes);
    }

    private collectResources(nodes: ReadonlyMap<string, Node<WgslType>>): void {
        for (const node of nodes.values()) {
            switch (node.kind) {
                case 'attribute': {
                    const n = node as AttributeNode<WgslType>;
                    if (!this.attributes.has(n.name)) {
                        const totalLoc = this.attributes.size + this.instancedAttrs.length;
                        this.attributes.set(n.name, {
                            kind: 'geometry',
                            name: n.name,
                            type: n.type,
                            location: totalLoc,
                        });
                    }
                    break;
                }
                case 'instanced_buffer_attribute': {
                    const n = node as InstancedBufferAttributeNode<WgslType>;
                    if (!this.instancedAttrNames.has(n.id)) {
                        const totalLoc = this.attributes.size + this.instancedAttrs.length;
                        const name = `_inst${this.instancedAttrs.length}`;
                        this.instancedAttrNames.set(n.id, name);
                        this.instancedAttrs.push({
                            kind: 'instanced',
                            node: n,
                            name,
                            type: n.type,
                            location: totalLoc,
                        });
                    }
                    break;
                }
                case 'varying': {
                    const n = node as VaryingNode<WgslType>;
                    if (!this.varyings.has(n.name)) {
                        this.varyings.set(n.name, {
                            name: n.name,
                            type: n.type,
                            location: this.varyings.size,
                        });
                    }
                    break;
                }
                case 'builtin': {
                    const n = node as BuiltinNode<WgslType>;
                    this.builtinsUsed.add(n.builtinKind);
                    // Auto-register known struct declarations for camera/time/mesh builtins
                    if (n.builtinKind === 'camera' && !this.structNodes.has('Camera')) {
                        this.structNodes.set('Camera', CameraStruct.node);
                    }
                    if (n.builtinKind === 'time' && !this.structNodes.has('Time')) {
                        this.structNodes.set('Time', TimeStruct.node);
                    }
                    if (n.builtinKind === 'mesh' && !this.structNodes.has('Mesh')) {
                        this.structNodes.set('Mesh', MeshStruct.node);
                    }
                    break;
                }
                case 'struct': {
                    const n = node as StructNode;
                    const def = lookupStructDef(n);
                    if (def) {
                        this.registerStructDef(def);
                    } else if (!this.structNodes.has(n.type)) {
                        this.structNodes.set(n.type, n);
                    }
                    break;
                }
                case 'uniform': {
                    const n = node as UniformNode<WgslType>;
                    if (n.group === 'material' && !this.uniformNodes.has(n.uniformId)) {
                        this.uniformNodes.set(n.uniformId, n);
                    }
                    // If the uniform type is a user-defined struct, register its deps
                    const uniformDef = lookupStructDefByName(n.type);
                    if (uniformDef) this.registerStructDef(uniformDef);
                    break;
                }
                case 'storage': {
                    const n = node as StorageNode<WgslType>;
                    if (!this.storageNodes.has(n.id)) {
                        const name = `_stor${this.storageNodes.size}`;
                        this.storageNodes.set(n.id, n);
                        this.storageNames.set(n.id, name);
                    }
                    // If the storage element type is a user-defined struct, register its deps
                    const storageDef = lookupStructDefByName(n.type);
                    if (storageDef) this.registerStructDef(storageDef);
                    break;
                }
                case 'texture': {
                    const n = node as TextureNode;
                    if (!this.textureNodes.has(n.textureId)) {
                        this.textureNodes.set(n.textureId, n);
                    }
                    break;
                }
                case 'sampler': {
                    const n = node as SamplerNode;
                    if (!this.samplerNodes.has(n.samplerId)) {
                        this.samplerNodes.set(n.samplerId, n);
                    }
                    break;
                }
                case 'call': {
                    const n = node as CallNode<WgslType>;
                    if (n.fnNode && !this.fnNodes.has(n.fnNode.id)) {
                        this.collectFnNode(n.fnNode);
                    }
                    break;
                }
                default:
                    break;
            }
        }
    }

    /** Recursively collect FnNode and any nested FnNodes in its body. */
    private collectFnNode(fn: FnNode<WgslType>): void {
        if (this.fnNodes.has(fn.id)) return;
        this.fnNodes.set(fn.id, fn);
        // Trace the fn body and collect any inner fn nodes
        const { body, output } = fn.trace();
        const bodyGraph = collectGraph(output);
        for (const node of bodyGraph.nodes.values()) {
            if (node.kind === 'call') {
                const cn = node as CallNode<WgslType>;
                if (cn.fnNode && !this.fnNodes.has(cn.fnNode.id)) {
                    this.collectFnNode(cn.fnNode);
                }
            }
        }
        // Also scan the stack for nested fn nodes
        this.collectFnNodesInStack(body);
    }

    private collectFnNodesInStack(stack: Node<WgslType>): void {
        if (stack.kind !== 'stack') return;
        const s = stack as StackNode;
        for (const stmt of s.body) {
            this.collectFnNodesInNode(stmt);
        }
    }

    private collectFnNodesInNode(node: Node<WgslType>): void {
        switch (node.kind) {
            case 'call': {
                const cn = node as CallNode<WgslType>;
                if (cn.fnNode && !this.fnNodes.has(cn.fnNode.id)) {
                    this.collectFnNode(cn.fnNode);
                }
                break;
            }
            case 'if': {
                const n = node as IfNode;
                this.collectFnNodesInStack(n.thenBody);
                if (n.elseBody) this.collectFnNodesInStack(n.elseBody);
                break;
            }
            case 'for': {
                const n = node as ForNode;
                this.collectFnNodesInStack(n.body);
                break;
            }
            case 'stack': {
                this.collectFnNodesInStack(node);
                break;
            }
            default:
                break;
        }
    }

    /**
     * Register a StructDef's nested deps (in declaration order) before the struct itself.
     * Handles arbitrary nesting depth; the insertion-ordered Map ensures correct WGSL output.
     */
    private registerStructDef(def: StructDef<StructSchema>): void {
        // Register nested deps first (depth-first pre-order)
        for (const nested of def.nestedDefs.values()) {
            this.registerStructDef(nested);
        }
        if (!this.structNodes.has(def.typeName)) {
            this.structNodes.set(def.typeName, def.node);
        }
    }

    // -----------------------------------------------------------------------
    // Phase 2 — emit WGSL
    // -----------------------------------------------------------------------

    result(): CompileResult {
        const lines: string[] = [];

        // --- Struct declarations (Camera, Time, Mesh, user structs) ---
        // Mesh struct is always registered since the Mesh UBO is always emitted.
        if (!this.structNodes.has('Mesh')) {
            this.structNodes.set('Mesh', MeshStruct.node);
        }
        for (const sn of this.structNodes.values()) {
            lines.push(this.emitStructDecl(sn));
        }

        // --- Builtin UBO bindings ---
        if (this.builtinsUsed.has('camera')) {
            lines.push(`@group(0) @binding(0) var<uniform> camera : Camera;`);
        }
        if (this.builtinsUsed.has('time')) {
            lines.push(`@group(0) @binding(1) var<uniform> time : Time;`);
        }
        // Mesh UBO is always at group(1) binding(0) — always emitted (renderer always uploads it)
        lines.push(`@group(1) @binding(0) var<uniform> mesh : Mesh;`);

        // --- Material resources (group 1, binding 1+) ---
        let matBinding = 1;

        // Material uniform block (if any per-material uniforms exist)
        const matUniforms = [...this.uniformNodes.values()];
        let uniformBlockEntry: UniformBlockEntry | null = null;
        if (matUniforms.length > 0) {
            uniformBlockEntry = this.buildUniformBlock(matUniforms, 1, matBinding);
            lines.push(this.emitMaterialUniformBlock(uniformBlockEntry));
            matBinding++;
        }

        // Per-material storage buffers
        const storageEntries: StorageEntry[] = [];
        for (const sn of this.storageNodes.values()) {
            const name = this.storageNames.get(sn.id)!;
            storageEntries.push({ node: sn, name, type: sn.storageType, access: sn.access, group: 1, binding: matBinding });
            lines.push(`@group(1) @binding(${matBinding}) var<storage, ${sn.access}> ${name} : ${sn.storageType};`);
            matBinding++;
        }

        // Textures
        const textureEntries: TextureEntry[] = [];
        for (const tn of this.textureNodes.values()) {
            textureEntries.push({ textureId: tn.textureId, type: tn.type, group: 1, binding: matBinding, node: tn });
            lines.push(`@group(1) @binding(${matBinding}) var ${tn.textureId}_tex : ${tn.type};`);
            matBinding++;
        }

        // Samplers
        const samplerEntries: SamplerEntry[] = [];
        for (const sn of this.samplerNodes.values()) {
            samplerEntries.push({ samplerId: sn.samplerId, type: sn.type, group: 1, binding: matBinding, node: sn });
            lines.push(`@group(1) @binding(${matBinding}) var ${sn.samplerId}_samp : ${sn.type};`);
            matBinding++;
        }

        if (lines.length > 0) lines.push('');

        // --- User-defined Fn declarations ---
        for (const fn of this.fnNodes.values()) {
            lines.push(this.emitFnDecl(fn));
            lines.push('');
        }

        // --- Vertex entry ---
        lines.push(this.emitVertexEntry());
        lines.push('');

        // --- Fragment entry ---
        lines.push(this.emitFragmentEntry());

        // --- Build CompileResult ---
        const attributes: AttributeEntry[] = [
            ...[...this.attributes.values()],
            ...this.instancedAttrs,
        ];
        const varyings = [...this.varyings.values()];

        return {
            code: lines.join('\n'),
            attributes,
            varyings,
            uniforms: uniformBlockEntry ? [uniformBlockEntry] : [],
            storage: storageEntries,
            textures: textureEntries,
            samplers: samplerEntries,
        };
    }

    // -----------------------------------------------------------------------
    // Struct decl
    // -----------------------------------------------------------------------

    private emitStructDecl(sn: StructNode): string {
        const members = sn.members.map((m) => `    ${m.name} : ${wgslTypeName(m.type)},`).join('\n');
        return `struct ${sn.type} {\n${members}\n}`;
    }

    // -----------------------------------------------------------------------
    // Material uniform block
    // -----------------------------------------------------------------------

    private buildUniformBlock(
        nodes: UniformNode<WgslType>[],
        group: 0 | 1,
        binding: number,
    ): UniformBlockEntry {
        const members: UniformMember[] = [];
        let offset = 0;
        for (const n of nodes) {
            const align = std140Align(n.type);
            const size = std140Size(n.type);
            offset = alignUp(offset, align);
            members.push({ uniformId: n.uniformId, type: n.type, offset, size, node: n });
            offset += size;
        }
        // Align total to 16-byte boundary (std140 struct rule)
        const totalBytes = alignUp(offset, 16);
        return { group, binding, members, totalBytes };
    }

    private emitMaterialUniformBlock(block: UniformBlockEntry): string {
        const members = block.members.map((m) => `    ${m.uniformId} : ${m.type},`).join('\n');
        return [
            `struct MaterialUniforms {`,
            members,
            `}`,
            `@group(${block.group}) @binding(${block.binding}) var<uniform> materialUniforms : MaterialUniforms;`,
        ].join('\n');
    }

    // -----------------------------------------------------------------------
    // User Fn declarations
    // -----------------------------------------------------------------------

    private emitFnDecl(fn: FnNode<WgslType>): string {
        const { params, body, output } = fn.trace();
        const paramList = params.map((_p, i) => `p${i} : ${wgslTypeName(fn.paramDescs[i].wgslType)}`).join(', ');
        const letBindings = new Map<string, string>();
        const bodyLines = this.emitStack(body, params, letBindings, '    ');
        const retExpr = this.getExpr(output.id, letBindings, params);
        return [
            `fn ${fn.fnName}(${paramList}) -> ${wgslTypeName(fn.type)} {`,
            ...bodyLines,
            `    return ${retExpr};`,
            `}`,
        ].join('\n');
    }

    // -----------------------------------------------------------------------
    // Vertex entry function
    // -----------------------------------------------------------------------

    private emitVertexEntry(): string {
        const lines: string[] = [];
        const varyingList = [...this.varyings.values()];
        const attrList = [...this.attributes.values()];

        // Input struct
        lines.push(`struct VertexInput {`);
        for (const a of attrList) {
            lines.push(`    @location(${a.location}) ${a.name} : ${wgslTypeName(a.type)},`);
        }
        for (const a of this.instancedAttrs) {
            lines.push(`    @location(${a.location}) ${a.name} : ${wgslTypeName(a.type)},`);
        }
        if (this.builtinsUsed.has('instance_index')) {
            lines.push(`    @builtin(instance_index) instance_index : u32,`);
        }
        if (this.builtinsUsed.has('vertex_index')) {
            lines.push(`    @builtin(vertex_index) vertex_index : u32,`);
        }
        lines.push(`}`);
        lines.push('');

        // Output struct
        lines.push(`struct VertexOutput {`);
        lines.push(`    @builtin(position) position : vec4f,`);
        for (const v of varyingList) {
            lines.push(`    @location(${v.location}) ${v.name} : ${wgslTypeName(v.type)},`);
        }
        lines.push(`}`);
        lines.push('');

        // Entry function
        lines.push(`@vertex`);
        lines.push(`fn vs_main(in : VertexInput) -> VertexOutput {`);
        lines.push(`    var out : VertexOutput;`);

        // Emit the vertex graph body
        const refCounts = this.vertRefCounts;
        const letBindings = new Map<string, string>(); // id → let name
        const stmts = this.emitGraphStmts(
            this.vertOrder,
            refCounts,
            letBindings,
            null, // no param nodes in entry points
            '    ',
        );
        for (const s of stmts) lines.push(s);

        // Assign output position from the root node expression
        const posExpr = this.getExpr(this.slots.position.id, letBindings, null);
        lines.push(`    out.position = ${posExpr};`);

        // Assign varyings
        for (const v of varyingList) {
            // Find the VaryingNode in the vertex graph by name
            const vn = this.findVaryingNodeByName(v.name);
            if (vn) {
                const srcExpr = this.getExpr(vn.source.id, letBindings, null);
                lines.push(`    out.${v.name} = ${srcExpr};`);
            }
        }

        lines.push(`    return out;`);
        lines.push(`}`);

        return lines.join('\n');
    }

    // -----------------------------------------------------------------------
    // Fragment entry function
    // -----------------------------------------------------------------------

    private emitFragmentEntry(): string {
        const lines: string[] = [];
        const varyingList = [...this.varyings.values()];
        const hasVaryings = varyingList.length > 0;

        // Input struct (matches vertex output, minus @builtin(position))
        // WGSL forbids empty structs — only emit when there are varyings.
        if (hasVaryings) {
            lines.push(`struct FragmentInput {`);
            for (const v of varyingList) {
                lines.push(`    @location(${v.location}) ${v.name} : ${wgslTypeName(v.type)},`);
            }
            lines.push(`}`);
            lines.push('');
        }

        const inputParam = hasVaryings ? `in : FragmentInput` : ``;

        // Entry function
        lines.push(`@fragment`);
        lines.push(`fn fs_main(${inputParam}) -> @location(0) vec4f {`);

        const refCounts = this.fragRefCounts;
        const letBindings = new Map<string, string>();
        const stmts = this.emitGraphStmts(this.fragOrder, refCounts, letBindings, null, '    ');
        for (const s of stmts) lines.push(s);

        const colorExpr = this.getExpr(this.slots.color.id, letBindings, null);
        lines.push(`    return ${colorExpr};`);
        lines.push(`}`);

        return lines.join('\n');
    }

    // -----------------------------------------------------------------------
    // Graph statement emitter — walks topo-sorted IDs, emits let bindings
    // for nodes referenced more than once and for statement-level nodes.
    // -----------------------------------------------------------------------

    private emitGraphStmts(
        order: string[],
        refCounts: Map<string, number>,
        letBindings: Map<string, string>,
        params: import('./nodes.js').ParamNode<WgslType>[] | null,
        indent: string,
    ): string[] {
        const lines: string[] = [];
        let letCounter = 0;

        for (const id of order) {
            const node = this.allNodes.get(id);
            if (!node) continue;

            // Skip leaf nodes that don't need extraction
            switch (node.kind) {
                case 'const':
                case 'attribute':
                case 'instanced_buffer_attribute':
                case 'builtin':
                case 'uniform':
                case 'storage':
                case 'texture':
                case 'sampler':
                case 'struct':
                case 'param':
                case 'fn':
                    continue;
                default:
                    break;
            }

            // Statement nodes — always emit as statements
            switch (node.kind) {
                case 'var': {
                    const n = node as VarNode<WgslType>;
                    const initExpr = this.getExpr(n.init.id, letBindings, params);
                    lines.push(`${indent}var ${n.varName} : ${wgslTypeName(n.type)} = ${initExpr};`);
                    // The var node's "expression" is just its name
                    letBindings.set(id, n.varName);
                    continue;
                }
                case 'assign': {
                    const n = node as AssignNode;
                    const tgt = this.getExpr(n.target.id, letBindings, params);
                    const val = this.getExpr(n.value.id, letBindings, params);
                    lines.push(`${indent}${tgt} = ${val};`);
                    continue;
                }
                case 'if': {
                    const n = node as IfNode;
                    const condExpr = this.getExpr(n.condition.id, letBindings, params);
                    lines.push(`${indent}if (${condExpr}) {`);
                    for (const s of this.emitStack(n.thenBody, params ?? [], letBindings, indent + '    ')) {
                        lines.push(s);
                    }
                    if (n.elseBody) {
                        lines.push(`${indent}} else {`);
                        for (const s of this.emitStack(n.elseBody, params ?? [], letBindings, indent + '    ')) {
                            lines.push(s);
                        }
                    }
                    lines.push(`${indent}}`);
                    continue;
                }
                case 'for': {
                    const n = node as ForNode;
                    const countExpr = this.getExpr(n.count.id, letBindings, params);
                    const iName = `i_${letCounter++}`;
                    letBindings.set(n.indexVar.id, iName);
                    lines.push(`${indent}for (var ${iName} : u32 = 0u; ${iName} < ${countExpr}; ${iName}++) {`);
                    for (const s of this.emitStack(n.body, params ?? [], letBindings, indent + '    ')) {
                        lines.push(s);
                    }
                    lines.push(`${indent}}`);
                    continue;
                }
                case 'return': {
                    const n = node as ReturnNode<WgslType>;
                    const valExpr = this.getExpr(n.value.id, letBindings, params);
                    lines.push(`${indent}return ${valExpr};`);
                    continue;
                }
                case 'stack':
                    // Inline stacks are emitted by their parent (if/for)
                    continue;
                default:
                    break;
            }

            // Expression nodes — extract to let if referenced more than once
            const refs = refCounts.get(id) ?? 0;
            if (refs > 1) {
                const letName = `v${letCounter++}`;
                const expr = this.emitNodeExpr(node, letBindings, params);
                lines.push(`${indent}let ${letName} = ${expr};`);
                letBindings.set(id, letName);
            }
            // If refs <= 1, expression is inlined at use site — no let needed
        }

        return lines;
    }

    // -----------------------------------------------------------------------
    // Stack emitter (for Fn bodies, if/else/for blocks)
    // -----------------------------------------------------------------------

    private emitStack(
        stack: import('./nodes.js').StackNode,
        params: import('./nodes.js').ParamNode<WgslType>[],
        letBindings: Map<string, string>,
        indent: string,
    ): string[] {
        const lines: string[] = [];

        for (const stmt of stack.body) {
            switch (stmt.kind) {
                case 'var': {
                    const n = stmt as VarNode<WgslType>;
                    const initExpr = this.getExpr(n.init.id, letBindings, params);
                    lines.push(`${indent}var ${n.varName} : ${n.type} = ${initExpr};`);
                    letBindings.set(stmt.id, n.varName);
                    break;
                }
                case 'assign': {
                    const n = stmt as AssignNode;
                    const tgt = this.getExpr(n.target.id, letBindings, params);
                    const val = this.getExpr(n.value.id, letBindings, params);
                    lines.push(`${indent}${tgt} = ${val};`);
                    break;
                }
                case 'if': {
                    const n = stmt as IfNode;
                    const condExpr = this.getExpr(n.condition.id, letBindings, params);
                    lines.push(`${indent}if (${condExpr}) {`);
                    for (const s of this.emitStack(n.thenBody, params, letBindings, indent + '    ')) {
                        lines.push(s);
                    }
                    if (n.elseBody) {
                        lines.push(`${indent}} else {`);
                        for (const s of this.emitStack(n.elseBody, params, letBindings, indent + '    ')) {
                            lines.push(s);
                        }
                    }
                    lines.push(`${indent}}`);
                    break;
                }
                case 'for': {
                    const n = stmt as ForNode;
                    const countExpr = this.getExpr(n.count.id, letBindings, params);
                    const iName = `i_${stmt.id}`;
                    letBindings.set(n.indexVar.id, iName);
                    lines.push(`${indent}for (var ${iName} : u32 = 0u; ${iName} < ${countExpr}; ${iName}++) {`);
                    for (const s of this.emitStack(n.body, params, letBindings, indent + '    ')) {
                        lines.push(s);
                    }
                    lines.push(`${indent}}`);
                    break;
                }
                case 'return': {
                    const n = stmt as ReturnNode<WgslType>;
                    const valExpr = this.getExpr(n.value.id, letBindings, params);
                    lines.push(`${indent}return ${valExpr};`);
                    break;
                }
                default:
                    break;
            }
        }

        return lines;
    }

    // -----------------------------------------------------------------------
    // Expression emitters
    // -----------------------------------------------------------------------

    /**
     * Get the WGSL expression string for a given node id.
     * If the node has been extracted to a let binding, returns the let name.
     * Otherwise inlines the expression.
     */
    private getExpr(
        id: string,
        letBindings: Map<string, string>,
        params: import('./nodes.js').ParamNode<WgslType>[] | null,
    ): string {
        const bound = letBindings.get(id);
        if (bound !== undefined) return bound;
        const node = this.allNodes.get(id);
        if (!node) return `/* missing:${id} */`;
        return this.emitNodeExpr(node, letBindings, params);
    }

    /**
     * Emit the inline WGSL expression for a single node.
     */
    private emitNodeExpr(
        node: Node<WgslType>,
        letBindings: Map<string, string>,
        params: import('./nodes.js').ParamNode<WgslType>[] | null,
    ): string {
        switch (node.kind) {
            case 'const': {
                const n = node as ConstNode<WgslType>;
                return constLiteral(n.type, n.value);
            }

            case 'attribute': {
                const n = node as AttributeNode<WgslType>;
                return `in.${n.name}`;
            }

            case 'instanced_buffer_attribute': {
                const n = node as InstancedBufferAttributeNode<WgslType>;
                const name = this.instancedAttrNames.get(n.id);
                return name ? `in.${name}` : `/* missing instanced attr ${n.id} */`;
            }

            case 'builtin': {
                const n = node as BuiltinNode<WgslType>;
                if (BUILTIN_VERTEX_INPUT.has(n.builtinKind)) {
                    return `in.${BUILTIN_VAR[n.builtinKind] ?? n.builtinKind}`;
                }
                return BUILTIN_VAR[n.builtinKind] ?? n.builtinKind;
            }

            case 'uniform': {
                const n = node as UniformNode<WgslType>;
                if (n.group === 'material') return `materialUniforms.${n.uniformId}`;
                // frame-group uniforms treated like builtins
                return n.uniformId;
            }

            case 'storage': {
                const n = node as StorageNode<WgslType>;
                return this.storageNames.get(n.id) ?? n.id;
            }

            case 'texture': {
                const n = node as TextureNode;
                return `${n.textureId}_tex`;
            }

            case 'sampler': {
                const n = node as SamplerNode;
                return `${n.samplerId}_samp`;
            }

            case 'varying': {
                const n = node as VaryingNode<WgslType>;
                // In fragment stage, read from input struct; in vertex stage, source expr
                // The fragment entry uses in.<name> via FragmentInput struct
                return `in.${n.name}`;
            }

            case 'binop': {
                const n = node as BinopNode<WgslType>;
                const l = this.getExpr(n.left.id, letBindings, params);
                const r = this.getExpr(n.right.id, letBindings, params);
                return `(${l} ${n.op} ${r})`;
            }

            case 'call': {
                const n = node as CallNode<WgslType>;
                const argExprs = n.args.map((a) => this.getExpr(a.id, letBindings, params));
                // Special case: negate
                if (n.fn === 'negate' && argExprs.length === 1) return `(-${argExprs[0]})`;
                // f32/i32/u32 type conversions
                if ((n.fn === 'f32' || n.fn === 'i32' || n.fn === 'u32') && argExprs.length === 1) {
                    return `${n.fn}(${argExprs[0]})`;
                }
                return `${n.fn}(${argExprs.join(', ')})`;
            }

            case 'raw': {
                const n = node as RawNode<WgslType>;
                const depExprs = n.deps.map((d) => this.getExpr(d.id, letBindings, params));
                return n.wgsl.replace(/\$(\d+)/g, (_, i) => depExprs[parseInt(i, 10)] ?? `/* dep${i} */`);
            }

            case 'construct': {
                const n = node as ConstructNode<WgslType>;
                const argExprs = n.args.map((a) => this.getExpr(a.id, letBindings, params));
                return `${wgslTypeName(n.type)}(${argExprs.join(', ')})`;
            }

            case 'field': {
                const n = node as FieldNode<WgslType>;
                const objExpr = this.getExpr(n.object.id, letBindings, params);
                return `${objExpr}.${n.fieldName}`;
            }

            case 'index': {
                const n = node as IndexNode<WgslType>;
                const arrExpr = this.getExpr(n.array.id, letBindings, params);
                const idxExpr = this.getExpr(n.index.id, letBindings, params);
                return `${arrExpr}[${idxExpr}]`;
            }

            case 'cond': {
                const n = node as CondNode<WgslType>;
                const condExpr = this.getExpr(n.condition.id, letBindings, params);
                const trueExpr = this.getExpr(n.ifTrue.id, letBindings, params);
                const falseExpr = n.ifFalse ? this.getExpr(n.ifFalse.id, letBindings, params) : `${n.type}()`;
                // WGSL select(false_val, true_val, condition)
                return `select(${falseExpr}, ${trueExpr}, ${condExpr})`;
            }

            case 'param': {
                const n = node as ParamNode<WgslType>;
                // Look up by paramIndex in the provided params list
                if (params && n.paramIndex < params.length) {
                    return `p${n.paramIndex}`;
                }
                return `p${n.paramIndex}`;
            }

            case 'var': {
                const n = node as VarNode<WgslType>;
                return n.varName;
            }

            case 'struct':
                // Struct nodes are declarations, not expressions
                return `/* struct ${node.type} */`;

            case 'assign':
            case 'if':
            case 'for':
            case 'return':
            case 'stack':
            case 'fn':
                // Statement-level nodes — should not appear inline
                return `/* stmt:${node.kind} */`;

            default: {
                const _x: never = node.kind;
                void _x;
                return `/* unknown:${node.kind} */`;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private findVaryingNodeByName(name: string): VaryingNode<WgslType> | null {
        for (const node of this.allNodes.values()) {
            if (node.kind === 'varying') {
                const vn = node as VaryingNode<WgslType>;
                if (vn.name === name) return vn;
            }
        }
        return null;
    }
}
