import type { GpuBuffer } from '../core/gpu-buffer';
import type { NodeFrame } from '../renderer/core/node-frame';
import type { StructSchema } from '../schema/schema';
import * as d from '../schema/schema';
import {
    collectGlslVaryings,
    collectStageFns,
    createGlslContext,
    emitGlslDslFunctions,
    emitGlslModuleScopeVars,
    emitGlslRawFunctions,
    emitGlslStructs,
    emitGlslTextures,
    emitGlslUniformBlocks,
    generateGlslFragmentShader,
    generateGlslTransformFeedbackShader,
    generateGlslVertexShader,
    type StorageMirror,
} from './backend/glsl/emit';
import {
    collectVaryings,
    createContext,
    emitAllBindings,
    emitDslFunctions,
    emitModuleScopeVars,
    emitWgslFunctions,
    generateComputeShader,
    generateFragmentShader,
    generateVertexShader,
    type TracedFn,
} from './backend/wgsl/emit';
import { type AnyNode, getChildren, walkTypeForStructs } from './graph';
import type { AttributeNode } from './lib/attribute';
import {
    type ComputeNode,
    type FnNode,
    type Node,
    NodeKind,
    type PrivateVarNode,
    type StructDef,
    type WorkgroupVarNode,
} from './lib/core';
import type { StorageNode } from './lib/storage';
import {
    type ArrayTextureNode,
    type CubeTextureNode,
    type DepthTextureNode,
    SamplerNode,
    type StorageTextureBindingNode,
    storageMirrorBytesPerTexel,
    storageRowWidth,
    TextureBindingNode,
    TextureNode,
} from './lib/texture';
import type { TransformFeedbackNode } from './lib/transform-feedback';
import type { UniformGroup, UniformNode } from './lib/uniform';
import type { InterpolationSampling, InterpolationType } from './lib/varying';
import type { WgslFunctionNode } from './lib/wgsl-fn';

/* public apis */

export function compile(slots: CompileSlots): CompileResult {
    // A fragment-less material (depth/stencil-only) may leave the slot null or undefined.
    const hasFragment = slots.fragment != null;
    // A frag_depth override is a fragment-stage value; a fragment shader must run to write it, even in
    // the depth-only (no color output) case.
    const hasDepth = slots.depth != null;
    const emitFragment = hasFragment || hasDepth;

    // collect all roots
    const roots: Node<d.Any>[] = [slots.vertex];
    if (slots.fragment) roots.push(slots.fragment);
    if (slots.depth) roots.push(slots.depth);

    // single discovery pass across all roots, then a context per stage that references the
    // discovered facts (both stages share one binding set — see createContext).
    const discovered = discover(roots);
    const vertexCtx = createContext('vertex', true, discovered);
    const fragmentCtx = createContext('fragment', true, discovered);

    // pre-collect varyings from fragment roots (so vertex shader knows what to output). The depth
    // expression is also a fragment-stage graph, so include it — a varying used only by depth must
    // still be produced by the vertex stage.
    if (emitFragment) {
        const fragmentRoots: Node<d.Any>[] = [];
        if (hasFragment) fragmentRoots.push(slots.fragment!);
        if (hasDepth) fragmentRoots.push(slots.depth!);
        collectVaryings(fragmentRoots, vertexCtx);
    }

    // generate vertex shader
    const vertexBody = generateVertexShader(slots, vertexCtx);

    // generate fragment shader (needed whenever there is a color output OR a frag_depth override)
    let fragmentBody = '';
    if (emitFragment) {
        fragmentBody = generateFragmentShader(slots.fragment ?? null, fragmentCtx, vertexCtx.varyings, slots.depth ?? null);

        // No need to merge bindings anymore - they're shared via discovered.*
    }

    // emit all bindings (each group gets its own @group index)
    const {
        wgsl: bindingsWgsl,
        uniformBlocks,
        storageEntries,
        textureEntries: textures,
        storageTextureEntries: storageTextures,
        samplerEntries: samplers,
    } = emitAllBindings(vertexCtx);

    // emit module-scope variables (var<private>)
    const moduleScopeVarsWgsl = emitModuleScopeVars(vertexCtx);

    // emit functions
    const wgslFnsCode = emitWgslFunctions(vertexCtx);
    const dslFnsCode = emitDslFunctions(vertexCtx);

    // assemble full shader
    const codeParts = [
        '// Bindings (uniforms, storage, textures, samplers)',
        bindingsWgsl,
        '// Module-scope variables',
        moduleScopeVarsWgsl,
        '// WGSL Functions',
        wgslFnsCode,
        '// DSL Functions',
        dslFnsCode,
        '// Vertex Shader',
        vertexBody,
    ];
    if (emitFragment) {
        codeParts.push('', '// Fragment Shader', fragmentBody);
    }
    const code = codeParts.filter(Boolean).join('\n');

    // collect graph info
    const graphNodes = new Map<number, Node<d.Any>>();
    const graphEdges = new Map<number, readonly number[]>();
    const graphInfo = new Map<number, NodeGraphInfo>();

    for (const [id, node] of discovered.nodeIdToNode) {
        graphNodes.set(id, node);
        graphEdges.set(
            id,
            getChildren(node).map((c) => c.id),
        );
        graphInfo.set(id, {
            stages: [],
            cseVar: vertexCtx.nodeVars.get(id) ?? fragmentCtx.nodeVars.get(id),
            usageCount: discovered.nodeIdToUsages.get(id) ?? 0,
            expression: undefined,
        });
    }

    // build varying entries
    const varyingEntries: VaryingEntry[] = [];
    let loc = 0;
    for (const [name, { node }] of vertexCtx.varyings) {
        varyingEntries.push({
            name,
            type: node.type.wgslType,
            location: loc++,
            interpolationType: node.interpolationType ?? null,
            interpolationSampling: node.interpolationSampling ?? null,
        });
    }

    // Build attributes array, unified, all entries already in ctx.attributes
    const allAttributes: AttributeEntry[] = Array.from(vertexCtx.attributes.values());

    // Group attributes by underlying buffer for efficient vertex buffer binding
    const vertexBufferGroups = groupAttributesByBuffer(allAttributes);

    return {
        code,
        vertexEntryPoint: 'vs_main',
        fragmentEntryPoint: emitFragment ? 'fs_main' : null,
        attributes: allAttributes,
        vertexBufferGroups,
        varyings: varyingEntries,
        uniformGroups: uniformBlocks,
        storage: storageEntries,
        textures,
        storageTextures,
        samplers,
        builtinsUsed: new Set([...vertexCtx.builtins, ...fragmentCtx.builtins]),
        updateBeforeNodes: discovered.updateBeforeNodes,
        updateAfterNodes: discovered.updateAfterNodes,
        updateNodes: discovered.updateNodes,
        graphNodes,
        graphEdges,
        graphInfo,
    };
}

/**
 * GLSL ES 3.00 sibling of {@link compile}. Reuses the shared, backend-neutral {@link discover} pass
 * and node graph, then drives the GLSL emitter instead of the WGSL one. First vertical slice: a "lit
 * mesh" material (attributes, camera/model uniform matrices as std140 UBOs, a varying, vec math,
 * clip position + fragment color). Textures, control flow, user functions, and compute/storage are
 * not yet supported and throw a clear "[glsl] … not yet supported" error via the emitter.
 *
 * The WGSL {@link compile} path is untouched: this only shares discover() and the node graph.
 */
/**
 * Options for the GLSL emitter. WGSL has no precision qualifier, so these are GLSL-only (grammar-
 * native): a WebGL-backend concern that never touches the WGSL path.
 */
export type CompileGlslOptions = {
    /**
     * Fragment-stage default precision qualifier (`precision <p> float;` / `precision <p> int;`).
     * Default: 'highp', keeping the emitted GLSL byte-identical to the golden snapshots.
     */
    precision?: 'highp' | 'mediump' | 'lowp';
    /**
     * The WebGL2 context's `MAX_TEXTURE_SIZE`, used to pick the `storage()` read-lowering's texel-grid
     * width (`width = min(totalTexels, maxTextureSize)`; height = ceil) so large read-only storage
     * buffers tile into a grid the device can allocate. Undefined → a conservative 2048 (WebGL2's
     * guaranteed floor). GLSL-only and storage-only: the width is baked into the shader's texel
     * addressing, so a change here alters the emitted GLSL; the compile cache is keyed by it.
     */
    maxTextureSize?: number;
};

/**
 * Bind a read-only, CPU-backed storage buffer AS an rgba32uint texture for WebGL (which has no SSBO).
 * No mirror object is minted here: the returned `base` is a synthetic sampler-less `TextureNode` whose
 * binding carries the `GpuBuffer` itself (`storageBufferSource`). At bind time the WebGL renderer reads
 * the buffer's own bytes directly as u32 texels (float fields round-trip through the accessor's
 * `uintBitsToFloat`) and caches one GL texture per `GpuBuffer`, version-synced, so mutating the buffer
 * between frames re-uploads, and N materials sharing a buffer share one GL texture. We only pick the
 * texel grid shape (baked into the shader's addressing via `width`): `width = min(totalTexels, cap)`
 * where `cap` is the device `MAX_TEXTURE_SIZE` (or 2048, WebGL2's guaranteed floor, when unknown), and
 * `height = ceil(totalTexels / width)`. No exact-division requirement: the renderer pads the (short)
 * last row and validates `height ≤ MAX_TEXTURE_SIZE` at upload. The baked width is device-specific, so
 * the GLSL compile cache is keyed by `maxTextureSize`.
 */
function createStorageBinding(node: StorageNode<d.Any>, maxTextureSize: number | undefined): StorageMirror {
    // Synthetic, sampler-less integer texture binding backed by the storage buffer's own bytes —
    // `.load()` lowers to texelFetch on a usampler2D, needing no sampler. The renderer resolves
    // `storageBufferSource`. The shader reads the row width at RUNTIME via `textureSize()` (see
    // `storageRowWidth`), so the texel grid shape is NOT baked in — value- and name-based storage of any
    // size compile to identical GLSL, and the compile cache no longer varies with `maxTextureSize`.
    const binding = new TextureBindingNode(d.texture2d(d.u32) as d.texture2d, `storage${node.id}`);
    // Texel byte-width chosen from the element's std430 stride (4 → r32uint, 8 → rg32uint, 16·k →
    // rgba32uint), so one element (or a whole number of texels) lands per texel and the emitted addressing
    // (element `i` → texel `i·stride/bytesPerTexel`) is exact. Known from the schema for both binding forms.
    const element = (node.type as { element?: d.Any }).element ?? node.type;
    const bytesPerTexel = storageMirrorBytesPerTexel(element);
    if (node.value != null) {
        // Value-based: buffer known at compile → size the tight texel grid now. `width = min(texels, cap)`,
        // `height = ceil`; the renderer pads the short last row and validates `height ≤ MAX_TEXTURE_SIZE`.
        const arr = node.value.array;
        if (arr == null) {
            throw new Error(
                `[glsl] storage() read-lowering needs a CPU-backed buffer, but this storage buffer has no ` +
                    `\`array\` (its CPU data was released after upload); keep the data resident to read it on WebGL`,
            );
        }
        if (arr.byteLength === 0 || arr.byteLength % bytesPerTexel !== 0) {
            throw new Error(
                `[glsl] storage() read-lowering: buffer byte length ${arr.byteLength} must be a non-zero multiple ` +
                    `of ${bytesPerTexel} (whole texels) to reinterpret as a WebGL texture`,
            );
        }
        const totalTexels = arr.byteLength / bytesPerTexel;
        const cap = maxTextureSize ?? 2048;
        const width = Math.min(totalTexels, cap);
        binding.storageBufferSource = { buffer: node.value, width, height: Math.ceil(totalTexels / width), bytesPerTexel };
    } else {
        // Name-based: `storage('slot', 'read')` bound via `geometry.setBuffer('slot', buf)`. The buffer
        // isn't known until draw; the renderer resolves it from the render object's geometry and sizes the
        // mirror at bind time (same version-synced cache). See texture-bindings.ts.
        binding.storageBufferSource = { name: node.bufferName!, bytesPerTexel };
    }
    const base = new TextureNode(binding);
    return { base, widthNode: storageRowWidth(base) };
}

export function compileGlsl(slots: CompileSlots, opts: CompileGlslOptions = {}): CompileResult {
    const hasFragment = slots.fragment != null;
    // A frag_depth override (material.depth) is a fragment-stage value; a fragment shader must run to
    // write gl_FragDepth, even in the depth-only (no color output) case.
    const hasDepth = slots.depth != null;
    const emitFragment = hasFragment || hasDepth;

    const roots: Node<d.Any>[] = [slots.vertex];
    if (slots.fragment) roots.push(slots.fragment);
    if (slots.depth) roots.push(slots.depth);

    // Shared, neutral analysis — identical to the WGSL path.
    const discovered = discover(roots);

    // discover() only registers struct defs reached through storage bindings (the WGSL path's needs).
    // GLSL declares a `struct` for ANY struct-typed value — e.g. a local struct construct in a
    // fragment — so augment discovered.structDefs by walking every discovered node's type. This
    // touches only the GLSL-local copy: registerGlslStructDef preserves topological (nested-first)
    // order, and the map is de-duplicated by name, so re-registering storage structs is a no-op.
    const registerGlslStructDef = (def: StructDef<StructSchema>): void => {
        if (discovered.structDefs.has(def.wgslType)) return;
        for (const nested of def.nestedDefs.values()) registerGlslStructDef(nested);
        discovered.structDefs.set(def.wgslType, def);
    };
    for (const node of discovered.nodeIdToNode.values()) {
        walkTypeForStructs(node.type, registerGlslStructDef);
    }

    // storage() on WebGL: a read-only storage buffer is bound AS an rgba32uint texture — reads lower to
    // texelFetch through the same accessor as `texture(t).load(schema, i)` (see the GLSL emitter's
    // `storageMirrors`). No SSBOs, no second CPU array: the renderer reinterprets the buffer's own bytes.
    // Value-based (`storage(buffer, 'read')`) resolves the buffer here; name-based (`storage('slot',
    // 'read')` + `geometry.setBuffer('slot', …)`) resolves it from the render object's geometry at bind
    // time. Only read_write / atomic / compute writes have no WebGL render-path analogue and fail loudly.
    const storageMirrors = new Map<number, StorageMirror>();
    for (const node of discovered.storages.values()) {
        if (node.access !== 'read') {
            throw new Error(
                `[glsl] storage() on the WebGL2 backend supports only read-only buffers (reinterpreted as a ` +
                    `texture); '${node.access}' (read_write / atomic / compute) storage is not supported`,
            );
        }
        storageMirrors.set(node.id, createStorageBinding(node, opts.maxTextureSize));
    }
    if (discovered.storageTextures.size > 0) {
        // WebGL2 has no storage textures.
        throw new Error(`[glsl] storage textures are not yet supported in the GLSL emitter`);
    }
    if (discovered.workgroupVars.size > 0) {
        // WorkgroupVar is compute-only; there is no GLSL analogue in the render path.
        throw new Error(`[glsl] workgroup variables are not yet supported in the GLSL emitter`);
    }
    // Raw shader functions (wgslFn / glslFn) are emitted from their GLSL companion below; the missing-
    // variant check happens at emit time (a wgslFn with no `glsl` companion throws there).

    const vertexCtx = createGlslContext('vertex', discovered);
    const fragmentCtx = createGlslContext('fragment', discovered);
    // Both stages share the same storage→mirror mapping so a storage read lowers identically wherever
    // it appears (a vertex shader gathering per-instance data, a fragment shader reading a palette, …).
    vertexCtx.storageMirrors = storageMirrors;
    fragmentCtx.storageMirrors = storageMirrors;

    // Pre-collect varyings from the fragment roots (color + depth override) so the vertex shader knows
    // what to output. A varying used only by the depth expression must still be produced by the vertex
    // stage.
    if (emitFragment) {
        const fragmentRoots: Node<d.Any>[] = [];
        if (hasFragment) fragmentRoots.push(slots.fragment!);
        if (hasDepth) fragmentRoots.push(slots.depth!);
        collectGlslVaryings(fragmentRoots, vertexCtx);
    }

    const vertexBody = generateGlslVertexShader(slots, vertexCtx);

    let fragmentBody = '';
    if (emitFragment) {
        fragmentBody = generateGlslFragmentShader(slots.fragment ?? null, fragmentCtx, vertexCtx.varyings, slots.depth ?? null);
    }

    // Merge any textures/samplers the fragment stage registered into the vertex context so a single
    // emit sees the full set. Textures are typically fragment-only, but a texture sampled in the
    // vertex stage (e.g. displacement) would live on vertexCtx — merge both directions.
    for (const [id, binding] of fragmentCtx.textures) {
        if (!vertexCtx.textures.has(id)) vertexCtx.textures.set(id, binding);
    }
    for (const [id, samplerNode] of fragmentCtx.textureSamplers) {
        if (!vertexCtx.textureSamplers.has(id)) vertexCtx.textureSamplers.set(id, samplerNode);
    }

    // Merge any Fn definitions the fragment stage registered (during generateGlslFragmentShader)
    // into the vertex context so a single emit covers both stages' functions.
    for (const [name, def] of fragmentCtx.fnDefs) {
        if (!vertexCtx.fnDefs.has(name)) vertexCtx.fnDefs.set(name, def);
    }

    // Struct declarations must precede everything that uses them (UBO members, locals, main()).
    const structsGlsl = emitGlslStructs(vertexCtx);

    const { glsl: uniformBlocksGlsl, uniformBlocks } = emitGlslUniformBlocks(vertexCtx);

    // Module-scope PrivateVar globals (precede main()).
    const moduleScopeVarsGlsl = emitGlslModuleScopeVars(vertexCtx);

    // Functions are emitted PER STAGE: only those reachable from that stage's root expressions, each
    // traced in that stage's own context. A Fn used only in the fragment stage — possibly using a
    // fragment-only feature (derivatives, discard, gl_FragCoord) — must NOT be emitted into the vertex
    // shader, where it would fail to compile. Vertex roots include the varying vertex-computations (a Fn
    // may be used only to produce a varying), not just the clip-position expression.
    const vertexRoots: (Node<d.Any> | null | undefined)[] = [slots.vertex];
    // Seed the varying VERTEX-computation sources (not the VaryingNodes themselves, which collectStageFns
    // treats as leaves) so a Fn used only to produce a varying is still reached for the vertex stage.
    // `VaryingNode.node` is a SubBuildNode wrapper; `.node.node` is the source expression (see
    // generateVarying, which evaluates the same `node.node.node`).
    for (const { node } of vertexCtx.varyings.values()) vertexRoots.push(node.node.node);
    const vertexFns = collectStageFns(vertexCtx, vertexRoots);
    const rawFnsGlsl = emitGlslRawFunctions(vertexCtx, vertexFns.raw);
    const dslFnsGlsl = emitGlslDslFunctions(vertexCtx, vertexFns.dsl);

    let fragmentRawFnsGlsl = '';
    let fragmentDslFnsGlsl = '';
    if (emitFragment) {
        const fragmentFns = collectStageFns(fragmentCtx, [slots.fragment ?? null, slots.depth ?? null]);
        fragmentRawFnsGlsl = emitGlslRawFunctions(fragmentCtx, fragmentFns.raw);
        fragmentDslFnsGlsl = emitGlslDslFunctions(fragmentCtx, fragmentFns.dsl);
    }

    // Combined samplers are collected LAST: a texture sampled only inside a user Fn body (e.g. FXAA's
    // `FxaaSample`) is registered into its stage context while that Fn body is emitted above, not during
    // the stage walk. Re-merge any such fragment-stage textures/samplers into the vertex context so the
    // shared sampler declarations below include them (the vertex shader declaring an unused sampler is
    // harmless). The declarations still precede the functions in the output.
    for (const [id, binding] of fragmentCtx.textures) {
        if (!vertexCtx.textures.has(id)) vertexCtx.textures.set(id, binding);
    }
    for (const [id, samplerNode] of fragmentCtx.textureSamplers) {
        if (!vertexCtx.textureSamplers.has(id)) vertexCtx.textureSamplers.set(id, samplerNode);
    }
    // A texture whose flipY wrap was emitted only in the fragment stage still needs its `u_flipY_<id>`
    // declared in the shared sampler block below (harmless in the vertex shader if unused there).
    for (const id of fragmentCtx.flipYTextures) vertexCtx.flipYTextures.add(id);
    const { glsl: samplersGlsl, textures: textureEntries, samplers: samplerEntries } = emitGlslTextures(vertexCtx);

    const version = '#version 300 es';

    // Only prefix the header when there are combined-sampler declarations, so texture-free shaders
    // stay byte-clean. Both stages get the same declarations; unused ones are harmless in GLSL.
    const structsSection = structsGlsl ? `// Structs\n${structsGlsl}` : '';
    const samplersSection = samplersGlsl ? `// Combined samplers\n${samplersGlsl}` : '';
    const moduleScopeSection = moduleScopeVarsGlsl ? `// Module-scope variables\n${moduleScopeVarsGlsl}` : '';
    // Function sections are per-stage (only the fns reachable in that stage), so the vertex shader never
    // carries a fragment-only fn definition and vice versa.
    const vertexRawFnsSection = rawFnsGlsl ? `// Raw functions (wgslFn/glslFn)\n${rawFnsGlsl}` : '';
    const vertexDslFnsSection = dslFnsGlsl ? `// Functions\n${dslFnsGlsl}` : '';
    const fragmentRawFnsSection = fragmentRawFnsGlsl ? `// Raw functions (wgslFn/glslFn)\n${fragmentRawFnsGlsl}` : '';
    const fragmentDslFnsSection = fragmentDslFnsGlsl ? `// Functions\n${fragmentDslFnsGlsl}` : '';

    const vertexParts = [
        version,
        '',
        structsSection,
        '// Uniform blocks (std140)',
        uniformBlocksGlsl,
        samplersSection,
        moduleScopeSection,
        vertexRawFnsSection,
        vertexDslFnsSection,
        '// Vertex shader',
        vertexBody,
    ];
    const fragmentParts = emitFragment
        ? [
              version,
              '',
              // GLSL ES 3.00 fragment shaders have no default float precision — one must be declared
              // before any float-typed declaration (struct fields, UBO members, varyings). It sits at
              // the very top so every downstream section is covered. (Vertex defaults to highp, so it
              // needs none.) The qualifier is 'highp' by default (byte-identical to the golden
              // snapshots); the WebGL backend can request 'mediump'/'lowp' via CompileGlslOptions.
              `precision ${opts.precision ?? 'highp'} float;`,
              `precision ${opts.precision ?? 'highp'} int;`,
              '',
              structsSection,
              '// Uniform blocks (std140)',
              uniformBlocksGlsl,
              samplersSection,
              moduleScopeSection,
              fragmentRawFnsSection,
              fragmentDslFnsSection,
              '// Fragment shader',
              fragmentBody,
          ]
        : [];

    // Emit vertex + fragment as a single string, separated by a stage marker. WebGL compiles the
    // two stages from distinct sources; this combined `.code` is the snapshot/regression surface,
    // mirroring how the WGSL path returns one combined module string.
    const codeParts = [vertexParts.filter(Boolean).join('\n')];
    if (emitFragment) {
        codeParts.push('', '// ---- fragment stage ----', '', fragmentParts.filter(Boolean).join('\n'));
    }
    const code = codeParts.join('\n');

    // Graph info (same shape as compile(), for inspector parity).
    const graphNodes = new Map<number, Node<d.Any>>();
    const graphEdges = new Map<number, readonly number[]>();
    const graphInfo = new Map<number, NodeGraphInfo>();
    for (const [id, node] of discovered.nodeIdToNode) {
        graphNodes.set(id, node);
        graphEdges.set(
            id,
            getChildren(node).map((c) => c.id),
        );
        graphInfo.set(id, {
            stages: [],
            cseVar: vertexCtx.nodeVars.get(id) ?? fragmentCtx.nodeVars.get(id),
            usageCount: discovered.nodeIdToUsages.get(id) ?? 0,
            expression: undefined,
        });
    }

    const varyingEntries: VaryingEntry[] = [];
    let loc = 0;
    for (const [name, { node }] of vertexCtx.varyings) {
        varyingEntries.push({
            name,
            type: node.type.wgslType,
            location: loc++,
            interpolationType: node.interpolationType ?? null,
            interpolationSampling: node.interpolationSampling ?? null,
        });
    }

    const allAttributes: AttributeEntry[] = Array.from(vertexCtx.attributes.values()).map((a) => ({
        kind: a.node.isNamedReference ? 'geometry' : 'buffer',
        name: a.node.isNamedReference ? (a.node.name ?? null) : null,
        shaderName: a.shaderName,
        type: a.type.wgslType,
        location: a.location,
        node: a.node,
        stride: a.node.stride,
        offset: a.node.offset,
        instanced: a.node.instanced,
    }));
    const vertexBufferGroups = groupAttributesByBuffer(allAttributes);

    return {
        code,
        vertexEntryPoint: 'main',
        fragmentEntryPoint: emitFragment ? 'main' : null,
        attributes: allAttributes,
        vertexBufferGroups,
        varyings: varyingEntries,
        uniformGroups: uniformBlocks,
        storage: [],
        textures: textureEntries,
        storageTextures: [],
        samplers: samplerEntries,
        builtinsUsed: new Set([...vertexCtx.builtins, ...fragmentCtx.builtins]),
        updateBeforeNodes: discovered.updateBeforeNodes,
        updateAfterNodes: discovered.updateAfterNodes,
        updateNodes: discovered.updateNodes,
        graphNodes,
        graphEdges,
        graphInfo,
    };
}

export function compileCompute(node: ComputeNode): ComputeCompileResult {
    // trace the FnNode to get roots
    const fn = node.fn;
    const traced = fn.trace();

    // filter out undefined (void functions have no output)
    const roots: Node<d.Any>[] = [traced.body, traced.output].filter((n): n is Node<d.Any> => n != null);

    // single discovery pass, then a context referencing the discovered facts (see createContext).
    const discovered = discover(roots);
    const ctx = createContext('compute', false, discovered);

    // generate compute shader body (reuse the trace above, re-tracing would
    // produce fresh StorageNode/etc. ids that aren't in discovered.storageNames,
    // causing emits like `undefined[...]`).
    const computeBody = generateComputeShader(node, traced, ctx);

    // emit all bindings (each group gets its own @group index)
    const { wgsl: bindingsWgsl, uniformBlocks, storageEntries, storageTextureEntries: storageTextures } = emitAllBindings(ctx);

    // emit module-scope variables (var<private>, var<workgroup>)
    const moduleScopeVarsWgsl = emitModuleScopeVars(ctx);

    // emit functions
    const wgslFnsCode = emitWgslFunctions(ctx);
    const dslFnsCode = emitDslFunctions(ctx);

    // assemble full shader
    const code = [
        '// Bindings (uniforms, storage, textures, samplers)',
        bindingsWgsl,
        '// Module-scope variables',
        moduleScopeVarsWgsl,
        '// WGSL Functions',
        wgslFnsCode,
        '// DSL Functions',
        dslFnsCode,
        '// Compute Shader',
        computeBody,
    ]
        .filter(Boolean)
        .join('\n');

    // convert storage entries to compute format
    const computeStorage: ComputeStorageEntry[] = storageEntries.map((e) => ({
        node: e.node,
        name: e.name,
        type: e.type,
        access: e.access,
        group: e.group,
        binding: e.binding,
    }));

    return {
        code,
        storage: computeStorage,
        storageTextures,
        workgroupSize: node.workgroupSize ?? [64, 1, 1],
        builtinsUsed: ctx.builtins,
        uniformGroups: uniformBlocks,
    };
}

/**
 * GLSL compile path for a transform-feedback kernel (Phase 1 of the WebGL transform-feedback plan).
 * Sibling to {@link compileCompute}: reuses the shared, backend-neutral {@link discover} pass and the
 * GLSL emitter to produce a real, linkable transform-feedback VERTEX program (attribute-in / captured-
 * varying-out) plus a no-op fragment shader so the program links.
 *
 * There is intentionally NO WGSL sibling: transform feedback is a WebGL2 primitive. Portability is via
 * a shared body `Fn` wrapped in a WebGPU compute(), not by this node spanning backends.
 */
export function compileTransformFeedback(
    node: TransformFeedbackNode,
    opts: CompileGlslOptions = {},
): TransformFeedbackGlslResult {
    if (Object.keys(node.outputs).length > 4) {
        // MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS is 4 on the test platform (see the plan's Phase 0.5).
        throw new Error(
            `[transformFeedback] a kernel may capture at most 4 outputs (MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS); ` +
                `'${node.name ?? node.id}' declares ${Object.keys(node.outputs).length}.`,
        );
    }

    // Declaration-ordered outputs (this is the transformFeedbackVaryings order at run time).
    const outputEntries = Object.keys(node.outputs).map((name) => ({ name, expr: node.outputExprs[name]! }));

    // Roots: the body plus every output expression, so discover() sees everything the emitter touches.
    const roots: Node<d.Any>[] = [node.body, ...outputEntries.map((o) => o.expr)];

    const discovered = discover(roots);

    // Same struct-augmentation as compileGlsl: GLSL declares a `struct` for any struct-typed value, not
    // just those reached through storage bindings.
    const registerGlslStructDef = (def: StructDef<StructSchema>): void => {
        if (discovered.structDefs.has(def.wgslType)) return;
        for (const nested of def.nestedDefs.values()) registerGlslStructDef(nested);
        discovered.structDefs.set(def.wgslType, def);
    };
    for (const n of discovered.nodeIdToNode.values()) {
        walkTypeForStructs(n.type, registerGlslStructDef);
    }

    // Reject compute-only resources up front with a clear error (the emitter also guards the body).
    if (discovered.storages.size > 0 || discovered.storageNames.size > 0) {
        throw new Error(`[transformFeedback] storage buffers are not part of the transform-feedback DSL`);
    }
    if (discovered.storageTextures.size > 0) {
        throw new Error(`[transformFeedback] storage textures are not supported in a transform-feedback kernel`);
    }
    if (discovered.workgroupVars.size > 0) {
        throw new Error(
            `[transformFeedback] workgroup variables are compute-only and can't be used in a transform-feedback kernel`,
        );
    }

    const ctx = createGlslContext('vertex', discovered);

    const { main, attributes, outputs } = generateGlslTransformFeedbackShader(ctx, node.body, outputEntries);

    // Bindings + functions (same emit set as the render vertex stage).
    const structsGlsl = emitGlslStructs(ctx);
    const { glsl: uniformBlocksGlsl, uniformBlocks } = emitGlslUniformBlocks(ctx);
    const moduleScopeVarsGlsl = emitGlslModuleScopeVars(ctx);
    const rawFnsGlsl = emitGlslRawFunctions(ctx);
    const dslFnsGlsl = emitGlslDslFunctions(ctx);
    // Combined samplers are collected LAST, same as compileGlsl: a texture sampled only inside a user
    // Fn body (neighbour-gather via a helper Fn) is registered into `ctx.textures` while that Fn body
    // is emitted above, not during the kernel walk. Emitting the declarations first would miss it,
    // leaving the sampler undeclared. The declarations still precede the functions in the output.
    const { glsl: samplersGlsl, textures: textureEntries, samplers: samplerEntries } = emitGlslTextures(ctx);

    const version = '#version 300 es';
    const structsSection = structsGlsl ? `// Structs\n${structsGlsl}` : '';
    const samplersSection = samplersGlsl ? `// Combined samplers\n${samplersGlsl}` : '';
    const moduleScopeSection = moduleScopeVarsGlsl ? `// Module-scope variables\n${moduleScopeVarsGlsl}` : '';
    const rawFnsSection = rawFnsGlsl ? `// Raw functions (wgslFn/glslFn)\n${rawFnsGlsl}` : '';
    const dslFnsSection = dslFnsGlsl ? `// Functions\n${dslFnsGlsl}` : '';

    const vertexCode = [
        version,
        // The vertex stage defaults to highp; a precision qualifier is emitted only when a non-default
        // was requested, keeping texture-free kernels byte-clean.
        opts.precision && opts.precision !== 'highp'
            ? `precision ${opts.precision} float;\nprecision ${opts.precision} int;\n`
            : '',
        structsSection,
        '// Uniform blocks (std140)',
        uniformBlocksGlsl,
        samplersSection,
        moduleScopeSection,
        rawFnsSection,
        dslFnsSection,
        '// Transform-feedback vertex shader',
        main,
    ]
        .filter(Boolean)
        .join('\n');

    // No-op fragment shader — rasterization is discarded, but the program must still link.
    const fragmentCode = ['#version 300 es', 'precision highp float;', 'void main() {}'].join('\n');

    const feedbackVaryings = outputs.map((o) => o.varyingName);
    const inputAttributes = attributes.map((a) => ({ name: a.shaderName, type: a.type.wgslType, location: a.location }));

    return {
        vertexCode,
        fragmentCode,
        feedbackVaryings,
        inputAttributes,
        uniformGroups: uniformBlocks,
        textures: textureEntries,
        samplers: samplerEntries,
        builtinsUsed: ctx.builtins,
    };
}

/* types */

export type NodeUpdateType = 'none' | 'frame' | 'render' | 'object';

export type UpdateBeforeNode = {
    readonly id: number;
    readonly updateBeforeType: NodeUpdateType;
    updateBefore(frame: NodeFrame): boolean | void;
};

export type UpdateAfterNode = {
    readonly id: number;
    readonly updateAfterType: NodeUpdateType;
    updateAfter(frame: NodeFrame): boolean | void;
};

export type UpdateNode = {
    readonly id: number;
    readonly updateType: NodeUpdateType;
    update(frame: NodeFrame): boolean | void;
};

export type AttributeEntry = {
    kind: 'geometry' | 'buffer';
    /** For geometry: the geometry buffer name. For buffer: null (direct reference). */
    name: string | null;
    /** WGSL struct member name (e.g. '_position_0', '_buf_1'). */
    shaderName: string;
    type: string;
    location: number;
    node: AttributeNode<d.Any>;
    stride: number;
    offset: number;
    instanced: boolean;
};

/**
 * VertexBufferGroup, groups attributes that share the same underlying buffer.
 *
 * For interleaved vertex data, multiple attributes may reference the same buffer
 * with different offsets. Grouping them enables:
 * - One GPUVertexBufferLayout with multiple attributes
 * - One setVertexBuffer() call per unique buffer
 *
 * This follows WebGPU's design where VertexBufferLayout.attributes is an array.
 */
export type VertexBufferGroup = {
    /** For geometry-based: the buffer name. For direct buffer: null. */
    name: string | null;
    /** For direct buffer: the GpuBuffer. For geometry-based: null (resolved at render time). */
    buffer: GpuBuffer<d.Any> | null;
    /** Shared stride (must match across grouped attributes). */
    stride: number;
    /** Whether these are per-instance attributes. */
    instanced: boolean;
    /** The attributes in this group (for building GPUVertexBufferLayout.attributes). */
    attributes: {
        type: string;
        offset: number;
        shaderLocation: number;
    }[];
};

export type VaryingEntry = {
    name: string;
    type: string;
    location: number;
    interpolationType: InterpolationType | null;
    interpolationSampling: InterpolationSampling | null;
};

export type UniformMember = {
    uniformId: string;
    schema: d.Any;
    offset: number;
    size: number;
    node: UniformNode<d.Any>;
};

export type UniformGroupBlock = {
    groupName: string;
    groupIndex: number;
    binding: number;
    shared: boolean;
    members: UniformMember[];
    totalBytes: number;
    group: UniformGroup;
};

export type StorageEntry = {
    node: StorageNode<d.Any>;
    name: string;
    type: string;
    access: 'read' | 'read_write';
    group: number;
    binding: number;
};

export type TextureEntry = {
    textureId: string;
    type: string;
    group: number;
    binding: number;
    node: TextureBindingNode;
};

export type StorageTextureEntry = {
    textureId: string;
    /** Composed WGSL binding type, e.g. `texture_storage_2d<rgba8unorm, write>`. */
    type: string;
    format: d.StorageTextureFormat;
    access: d.StorageTextureAccess;
    dim: '1d' | '2d' | '2d_array' | '3d';
    group: number;
    binding: number;
    node: StorageTextureBindingNode;
};

export type SamplerEntry = {
    samplerId: string;
    type: 'sampler' | 'sampler_comparison';
    group: number;
    binding: number;
    samplerNode: SamplerNode<d.sampler | d.samplerComparison>;
};

export type ComputeStorageEntry = {
    node: StorageNode<d.Any>;
    name: string;
    type: string;
    access: 'read' | 'read_write';
    group: number;
    binding: number;
};

export type NodeGraphInfo = {
    stages: ReadonlyArray<'vertex' | 'fragment' | 'compute'>;
    cseVar: string | undefined;
    usageCount: number;
    expression: string | undefined;
};

export type CompileSlots = {
    vertex: Node<d.Any>;
    fragment?: Node<d.Any>;
    depth?: Node<d.Any>;
};

export type CompileResult = {
    code: string;
    vertexEntryPoint: string;
    fragmentEntryPoint: string | null;
    attributes: AttributeEntry[];
    vertexBufferGroups: VertexBufferGroup[];
    varyings: VaryingEntry[];
    uniformGroups: UniformGroupBlock[];
    storage: StorageEntry[];
    textures: TextureEntry[];
    storageTextures: StorageTextureEntry[];
    samplers: SamplerEntry[];
    builtinsUsed: Set<string>;
    updateBeforeNodes: UpdateBeforeNode[];
    updateAfterNodes: UpdateAfterNode[];
    updateNodes: UpdateNode[];
    graphNodes: ReadonlyMap<number, Node<d.Any>>;
    graphEdges: ReadonlyMap<number, readonly number[]>;
    graphInfo: ReadonlyMap<number, NodeGraphInfo>;
};

export type ComputeCompileResult = {
    code: string;
    storage: ComputeStorageEntry[];
    storageTextures: StorageTextureEntry[];
    workgroupSize: [number, number, number];
    builtinsUsed: Set<string>;
    uniformGroups: UniformGroupBlock[];
};

/** One transform-feedback input attribute (bound from a GpuBuffer at the run site in Phase 2). */
export type TransformFeedbackInputAttribute = {
    /** Shader attribute name, `a_<name>`. */
    name: string;
    /** WGSL type name (e.g. 'vec4f'); the GLSL type is derivable via the schema's glslType companion. */
    type: string;
    location: number;
};

export type TransformFeedbackGlslResult = {
    /** The transform-feedback vertex shader (attribute-in / captured-varying-out, dummy gl_Position). */
    vertexCode: string;
    /** A no-op fragment shader so the program links (rasterization is discarded at run time). */
    fragmentCode: string;
    /** Ordered captured-varying names (`v_<name>`) for gl.transformFeedbackVaryings(..., SEPARATE_ATTRIBS). */
    feedbackVaryings: string[];
    /** Input attribute layout (name → type → location). */
    inputAttributes: TransformFeedbackInputAttribute[];
    uniformGroups: UniformGroupBlock[];
    textures: TextureEntry[];
    samplers: SamplerEntry[];
    builtinsUsed: Set<string>;
};

/**
 * Group attributes by their underlying buffer for efficient vertex buffer binding.
 *
 * Attributes sharing the same buffer (either by name for geometry-based, or by
 * buffer reference for direct) are grouped together. This enables:
 * - One GPUVertexBufferLayout with multiple attributes
 * - One setVertexBuffer() call per unique buffer
 *
 * @param entries - Flat array of AttributeEntry from compilation
 * @returns Array of VertexBufferGroup, one per unique buffer
 */
function groupAttributesByBuffer(entries: AttributeEntry[]): VertexBufferGroup[] {
    // Use separate maps for name-based and buffer-based grouping
    const nameGroups = new Map<string, VertexBufferGroup>();
    const bufferGroups = new Map<GpuBuffer<d.Any>, VertexBufferGroup>();

    for (const entry of entries) {
        let group: VertexBufferGroup | undefined;

        if (entry.kind === 'geometry') {
            // Name-based grouping
            const geomName = entry.name!;
            group = nameGroups.get(geomName);
            if (!group) {
                group = {
                    name: geomName,
                    buffer: null,
                    stride: entry.stride,
                    instanced: entry.instanced,
                    attributes: [],
                };
                nameGroups.set(geomName, group);
            }
        } else {
            // Buffer-based grouping
            const buffer = entry.node.buffer!;
            group = bufferGroups.get(buffer);
            if (!group) {
                group = {
                    name: null,
                    buffer,
                    stride: entry.stride,
                    instanced: entry.instanced,
                    attributes: [],
                };
                bufferGroups.set(buffer, group);
            }
        }

        // Validate stride/instanced match within group
        if (group.stride !== entry.stride) {
            throw new Error(
                `[gpucat] Interleaved attributes sharing buffer must have matching stride. ` +
                    `Got ${entry.stride} but group has ${group.stride}.`,
            );
        }
        if (group.instanced !== entry.instanced) {
            throw new Error(`[gpucat] Interleaved attributes sharing buffer must have matching instanced flag.`);
        }

        group.attributes.push({
            type: entry.type,
            offset: entry.offset,
            shaderLocation: entry.location,
        });
    }

    // Combine both maps into a single array, preserving order (name-based first, then buffer-based)
    return [...nameGroups.values(), ...bufferGroups.values()];
}

/** result of a single DFS pass that discovers all metadata needed before code generation */
export type Discovery = {
    nodeIdToUsages: Map<number, number>;
    mutatedNodes: Set<number>;
    fnDefs: Map<string, { fn: FnNode<d.Any>; traced: TracedFn }>;
    wgslFnDefs: Map<string, WgslFunctionNode>;
    structDefs: Map<string, StructDef<StructSchema>>;
    storageNames: Map<number, string>; // node.id -> globally unique name
    textures: Map<string, TextureBindingNode>;
    storageTextures: Map<string, StorageTextureBindingNode>;
    samplers: Map<string, SamplerNode>; // keyed by settingsKey for deduplication
    uniforms: Map<string, { node: UniformNode<d.Any>; group: UniformGroup }>;
    storages: Map<string, StorageNode<d.Any>>;
    privateVars: Map<number, PrivateVarNode<d.Any>>; // node.id -> node
    workgroupVars: Map<number, WorkgroupVarNode<d.Any>>; // node.id -> node
    nodeIdToNode: Map<number, Node<d.Any>>;
    updateBeforeNodes: UpdateBeforeNode[];
    updateAfterNodes: UpdateAfterNode[];
    updateNodes: UpdateNode[];
};

function discover(roots: Node<d.Any>[]): Discovery {
    const nodeIdToNode = new Map<number, Node<d.Any>>();
    const nodeIdToUsages = new Map<number, number>();

    const visited = new Set<number>();
    const mutatedNodes = new Set<number>();

    const fnDefs = new Map<string, { fn: FnNode<d.Any>; traced: TracedFn }>();
    const wgslFnDefs = new Map<string, WgslFunctionNode>();
    const structDefs = new Map<string, StructDef<StructSchema>>();
    const storageNames = new Map<number, string>();
    const textures = new Map<string, TextureBindingNode>();
    const storageTextures = new Map<string, StorageTextureBindingNode>();
    const samplers = new Map<string, SamplerNode>(); // keyed by settingsKey
    const uniforms = new Map<string, { node: UniformNode<d.Any>; group: UniformGroup }>();
    const storages = new Map<string, StorageNode<d.Any>>();
    const privateVars = new Map<number, PrivateVarNode<d.Any>>();
    const workgroupVars = new Map<number, WorkgroupVarNode<d.Any>>();
    const updateBeforeNodes: UpdateBeforeNode[] = [];
    const updateAfterNodes: UpdateAfterNode[] = [];
    const updateNodes: UpdateNode[] = [];

    function registerStructDef(def: StructDef<StructSchema>): void {
        if (structDefs.has(def.wgslType)) return;
        for (const nested of def.nestedDefs.values()) {
            registerStructDef(nested);
        }
        structDefs.set(def.wgslType, def);
    }

    function markTargetChain(rawNode: Node<d.Any>) {
        const node = rawNode as AnyNode;
        mutatedNodes.add(node.id);
        if (node.kind === NodeKind.Field) {
            markTargetChain(node.object);
        } else if (node.kind === NodeKind.Index) {
            markTargetChain(node.array);
        }
    }

    function registerSampler(samplerNode: SamplerNode): void {
        const key = samplerNode.settingsKey;
        if (!samplers.has(key)) {
            samplers.set(key, samplerNode);
        }
    }

    function registerTextureWithSampler(textureNode: TextureNode | CubeTextureNode | DepthTextureNode | ArrayTextureNode): void {
        // Register the texture binding
        const binding = textureNode.bindingNode;
        const name = binding.textureId;
        if (!textures.has(name)) {
            textures.set(name, binding);
        }

        // For sampling modes (not 'load'), ensure a sampler exists and register it
        if (textureNode.samplingMode !== 'load') {
            let samplerNode = textureNode.samplerNode;
            if (!samplerNode) {
                // Create default sampler (same logic as generateTexture had)
                samplerNode = new SamplerNode(d.sampler, name, binding.group);
                textureNode.samplerNode = samplerNode;
            }
            registerSampler(samplerNode);
        }
    }

    function visit(rawNode: Node<d.Any>) {
        const node = rawNode as AnyNode;
        // usage counting
        nodeIdToUsages.set(node.id, (nodeIdToUsages.get(node.id) ?? 0) + 1);

        // exit if visited
        if (visited.has(node.id)) return;
        visited.add(node.id);

        // collect all nodes
        nodeIdToNode.set(node.id, node);

        // collect update lifecycle nodes
        if (node.updateBeforeType !== 'none' && node.updateBefore) {
            updateBeforeNodes.push(node as unknown as UpdateBeforeNode);
        }
        if (node.updateAfterType !== 'none' && node.updateAfter) {
            updateAfterNodes.push(node as unknown as UpdateAfterNode);
        }
        if (node.updateType !== 'none' && node.update) {
            updateNodes.push(node as unknown as UpdateNode);
        }

        // mutated nodes: walk assignment target chains
        if (node.kind === NodeKind.Assign) {
            markTargetChain(node.target);
        }

        // function discovery
        if (node.kind === NodeKind.Call && node.fnNode) {
            const fn = node.fnNode;
            if (!fnDefs.has(fn.fnName)) {
                const traced = fn.trace();
                fnDefs.set(fn.fnName, { fn, traced });
                visit(traced.body);
                visit(traced.output);
            }
        }
        if (node.kind === NodeKind.Call && node.wgslFnNode) {
            const fn = node.wgslFnNode as WgslFunctionNode;
            // Key by WGSL code; GLSL-only functions (empty code) key by their GLSL source so they
            // don't collide at the '' key. The WGSL emitter throws for these; the GLSL emitter uses
            // glslCode.
            const key = fn.code || `glsl:${fn.glslCode ?? ''}`;
            if (!wgslFnDefs.has(key)) {
                wgslFnDefs.set(key, fn);
                for (const inc of fn.includes) {
                    if (inc.kind === NodeKind.WgslFunction) {
                        const incKey = inc.code || `glsl:${inc.glslCode ?? ''}`;
                        if (!wgslFnDefs.has(incKey)) wgslFnDefs.set(incKey, inc);
                    }
                }
            }
        }

        // storage + struct definition discovery
        if (node.kind === NodeKind.Storage) {
            if (!storageNames.has(node.id)) {
                storageNames.set(node.id, `_storage${storageNames.size}`);
            }
            // Also register storage for binding emission
            const storageName = storageNames.get(node.id)!;
            if (!storages.has(storageName)) {
                storages.set(storageName, node);
            }

            // Walk the type to find and register any struct definitions
            walkTypeForStructs(node.type, registerStructDef);
        }

        // binding discovery: textures, samplers, uniforms
        if (node.kind === NodeKind.TextureBinding) {
            const name = node.textureId;
            if (!textures.has(name)) {
                textures.set(name, node);
            }
        }
        if (node.kind === NodeKind.StorageTextureBinding) {
            const name = node.textureId;
            if (!storageTextures.has(name)) {
                storageTextures.set(name, node);
            }
        }
        if (node.kind === NodeKind.Texture) {
            registerTextureWithSampler(node);
        }
        if (node.kind === NodeKind.CubeTexture) {
            registerTextureWithSampler(node);
        }
        if (node.kind === NodeKind.DepthTexture) {
            registerTextureWithSampler(node);
        }
        if (node.kind === NodeKind.ArrayTexture) {
            registerTextureWithSampler(node);
        }
        if (node.kind === NodeKind.Sampler) {
            registerSampler(node);
        }
        if (node.kind === NodeKind.Uniform) {
            const name = node.name;
            const group = node.group;
            if (!uniforms.has(name)) {
                uniforms.set(name, { node, group });
            }
            // A struct-typed UBO member needs its `struct` declared just like a storage buffer's does.
            // discover() previously walked types for structs only through storage bindings, so a struct
            // reached solely via a uniform was never registered — the WGSL emitter then referenced an
            // undeclared type. Walk the uniform's type here so every backend sees the struct def.
            walkTypeForStructs(node.type, registerStructDef);
        }

        // module scope variable discovery
        if (node.kind === NodeKind.PrivateVar) {
            if (!privateVars.has(node.id)) {
                privateVars.set(node.id, node);
            }
        }
        if (node.kind === NodeKind.WorkgroupVar) {
            if (!workgroupVars.has(node.id)) {
                workgroupVars.set(node.id, node);
            }
        }

        // visit children
        for (const child of getChildren(node)) {
            visit(child);
        }
    }

    for (const root of roots) {
        visit(root);
    }

    return {
        nodeIdToNode,
        nodeIdToUsages,
        mutatedNodes,
        fnDefs,
        wgslFnDefs,
        structDefs,
        storageNames,
        updateBeforeNodes,
        updateAfterNodes,
        updateNodes,
        textures,
        storageTextures,
        samplers,
        uniforms,
        storages,
        privateVars,
        workgroupVars,
    };
}
