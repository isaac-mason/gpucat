/**
 * pass-node.ts — PassNode: renders a Scene into an off-screen RenderTarget and
 * exposes the result as texture nodes that can feed into post-processing graphs.
 *
 * Mirrors three.js's PassNode / pass() API:
 *
 *   const scenePass = pass(scene, camera);
 *
 *   const color = scenePass.getTextureNode();          // samples color RT at screen UV
 *   const viewZ = scenePass.getViewZNode();            // camera-space Z from depth RT
 *   const ld    = scenePass.getLinearDepthNode();      // linear depth [0,1]
 *
 *   renderPipeline.outputNode = color;
 *
 * RenderTarget lifecycle
 * ----------------------
 * The PassNode lazily allocates its color + depth textures on the first render and
 * auto-resizes when the renderer output dimensions change.  The pipeline calls
 * _ensureTarget(device, w, h) before rendering the scene.
 *
 * UV convention
 * -------------
 * All sampling nodes assume the fragment interpolant `in.uv` (vec2f) exists in the
 * fragment shader's input struct.  The RenderPipeline's internal fullscreen material
 * provides this via a varying injected by the fullscreen vertex shader.
 *
 * Depth reconstruction
 * --------------------
 * viewZ uses the standard perspective formula for a [0,1] depth buffer:
 *   viewZ = (near * far) / (depth * (near - far) + far)
 */

import { Node, TextureNode, SamplerNode, RawNode, type WgslType } from './nodes.js';
import type { Scene } from '../scene/scene.js';
import type { Camera } from '../scene/camera.js';

// ---------------------------------------------------------------------------
// Unique ID generator
// ---------------------------------------------------------------------------

let _passCount = 0;

// ---------------------------------------------------------------------------
// PassColorTextureNode
// ---------------------------------------------------------------------------

/**
 * Samples the color render-target texture of a PassNode at `in.uv`.
 *
 * Emits:  textureSample(<id>_color_tex, <id>_color_sampler_samp, in.uv)
 */
export class PassColorTextureNode extends Node<'vec4f'> {
    readonly passNode: PassNode;
    /** The underlying TextureNode (registered in group 1 by the compiler). */
    readonly textureNode: TextureNode;
    /** The SamplerNode paired with the texture. */
    readonly samplerNode: SamplerNode;
    /**
     * Deps array — mirrors RawNode.deps so that depsOfNode()'s 'raw' branch
     * can traverse into this node's children without a special case.
     */
    readonly deps: Node<WgslType>[];
    /**
     * WGSL template — mirrors RawNode.wgsl so that compile.ts emitNodeExpr's
     * 'raw' branch can call .replace() on it.
     * $0 = texture expr, $1 = sampler expr (provided by deps above).
     */
    readonly wgsl = 'textureSample($0, $1, in.uv)';

    constructor(passNode: PassNode, textureNode: TextureNode, samplerNode: SamplerNode) {
        super(
            `pass_color_sample_${passNode.passId}`,
            'raw',
            'vec4f',
        );
        this.passNode    = passNode;
        this.textureNode = textureNode;
        this.samplerNode = samplerNode;
        this.deps        = [textureNode, samplerNode];
    }
}

// ---------------------------------------------------------------------------
// PassNodeOptions
// ---------------------------------------------------------------------------

export type PassNodeOptions = {
    /** RGBA clear color for this pass's color attachment. Defaults to [0, 0, 0, 1]. */
    clearColor?: [number, number, number, number];
};

// ---------------------------------------------------------------------------
// PassNode
// ---------------------------------------------------------------------------

export class PassNode extends Node<'vec4f'> {
    readonly scene: Scene;
    readonly camera: Camera;

    /** Stable unique string used to namespace texture/sampler IDs. */
    readonly passId: string;

    /** Clear color for this pass's color attachment. Defaults to opaque black. */
    clearColor: [number, number, number, number];

    // GPU resources — null until _ensureTarget() is called.
    _colorTexture: GPUTexture | null = null;
    _depthTexture: GPUTexture | null = null;
    _sampler: GPUSampler | null = null;
    _targetWidth  = 0;
    _targetHeight = 0;

    // Internal node instances — lazily created, stable across frames.
    private readonly _colorTexNode: TextureNode;
    private readonly _samplerNode: SamplerNode;
    private readonly _depthTexNode: TextureNode;
    private readonly _colorSampleNode: PassColorTextureNode;

    constructor(scene: Scene, camera: Camera, options: PassNodeOptions = {}) {
        const pid = `_pass${_passCount++}`;
        super(`passnode_${pid}`, 'raw', 'vec4f');

        this.scene  = scene;
        this.camera = camera;
        this.passId = pid;
        this.clearColor = options.clearColor ?? [0, 0, 0, 1];

        this._colorTexNode   = new TextureNode('texture_2d<f32>',    `${pid}_color`);
        this._samplerNode    = new SamplerNode('sampler',             `${pid}_samp`);
        this._depthTexNode   = new TextureNode('texture_depth_2d',   `${pid}_depth`);
        this._colorSampleNode = new PassColorTextureNode(this, this._colorTexNode, this._samplerNode);
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * Returns a Node<'vec4f'> that samples the color output of this pass at
     * the current fragment UV.  Use as `renderPipeline.outputNode`.
     */
    getTextureNode(): Node<'vec4f'> {
        return this._colorSampleNode;
    }

    /**
     * Returns a Node<'f32'> for the camera-space Z of the nearest surface.
     * Negative in front of the camera (standard OpenGL convention).
     */
    getViewZNode(): Node<'f32'> {
        // Raw WGSL: sample depth, reconstruct view-Z.
        // $0 = depth texture expr  ("..._depth_tex")
        // $1 = sampler expr        ("..._samp_samp")
        // near/far are injected as raw literals at render time via separate uniform nodes.
        // For now we reference camera.near / camera.far via a closure-captured RawNode
        // that embeds the values at compile time (recompiled when camera changes — acceptable).
        // A future improvement: use uniform nodes for near/far.
        const near = (this.camera as { near: number }).near ?? 0.1;
        const far  = (this.camera as { far:  number }).far  ?? 100.0;
        return new RawNode<'f32'>(
            'f32',
            [
                '(func() -> f32 {',
                `  let d = textureSample($0, $1, in.uv).r;`,
                `  let n = ${near}f;`,
                `  let f = ${far}f;`,
                '  return (n * f) / (d * (n - f) + f);',
                '})()',
            ].join(' '),
            [this._depthTexNode, this._samplerNode],
        );
    }

    /**
     * Returns a Node<'f32'> for linear depth in [0,1].
     * 0 = at near plane, 1 = at far plane.
     */
    getLinearDepthNode(): Node<'f32'> {
        const near = (this.camera as { near: number }).near ?? 0.1;
        const far  = (this.camera as { far:  number }).far  ?? 100.0;
        return new RawNode<'f32'>(
            'f32',
            [
                '(func() -> f32 {',
                `  let d = textureSample($0, $1, in.uv).r;`,
                `  let n = ${near}f;`,
                `  let f = ${far}f;`,
                '  let vz = (n * f) / (d * (n - f) + f);',
                '  return (vz - n) / (n - f);',
                '})()',
            ].join(' '),
            [this._depthTexNode, this._samplerNode],
        );
    }

    // -----------------------------------------------------------------------
    // Internal — renderer API
    // -----------------------------------------------------------------------

    /**
     * Returns all nodes that must be registered in the material to make the
     * sampling work: the color TextureNode, sampler, and depth TextureNode.
     * The renderer uses these to populate material.uniforms before compiling.
     */
    _getResourceNodes(): {
        colorTexNode: TextureNode;
        samplerNode: SamplerNode;
        depthTexNode: TextureNode;
    } {
        return {
            colorTexNode: this._colorTexNode,
            samplerNode:  this._samplerNode,
            depthTexNode: this._depthTexNode,
        };
    }

    /**
     * Ensure color + depth textures exist at the requested dimensions.
     * Creates or resizes them as needed. Call before rendering the scene.
     */
    _ensureTarget(device: GPUDevice, width: number, height: number): void {
        if (
            this._colorTexture !== null &&
            this._targetWidth === width &&
            this._targetHeight === height
        ) {
            return;
        }

        this._colorTexture?.destroy();
        this._depthTexture?.destroy();

        this._colorTexture = device.createTexture({
            size: [width, height],
            format: 'rgba8unorm',
            usage:
                GPUTextureUsage.RENDER_ATTACHMENT |
                GPUTextureUsage.TEXTURE_BINDING |
                GPUTextureUsage.COPY_SRC,
        });

        this._depthTexture = device.createTexture({
            size: [width, height],
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });

        if (!this._sampler) {
            this._sampler = device.createSampler({
                magFilter: 'linear',
                minFilter: 'linear',
            });
        }

        this._targetWidth  = width;
        this._targetHeight = height;
    }

    /** Free GPU resources. */
    dispose(): void {
        this._colorTexture?.destroy();
        this._depthTexture?.destroy();
        this._colorTexture = null;
        this._depthTexture = null;
        this._sampler      = null;
        this._targetWidth  = 0;
        this._targetHeight = 0;
    }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a PassNode that renders `scene` from `camera` into an off-screen
 * render target.  The result feeds into post-processing node expressions.
 *
 * ```ts
 * const scenePass = pass(scene, camera, { clearColor: [0.1, 0.1, 0.1, 1] });
 * renderer.render(scenePass.getTextureNode());
 * ```
 */
export function pass(scene: Scene, camera: Camera, options?: PassNodeOptions): PassNode {
    return new PassNode(scene, camera, options);
}

// ---------------------------------------------------------------------------
// Graph traversal helper
// ---------------------------------------------------------------------------

/**
 * Walk a node graph (BFS) and collect all PassNodes referenced anywhere in it.
 * Used by RenderPipeline to discover which scenes to render before the quad.
 */
export function collectPassNodes(root: Node<WgslType>): PassNode[] {
    const visited = new Set<string>();
    const result: PassNode[] = [];
    const queue: Node<WgslType>[] = [root];

    while (queue.length > 0) {
        const node = queue.shift()!;
        if (visited.has(node.id)) continue;
        visited.add(node.id);

        if (node instanceof PassNode) {
            result.push(node);
        } else if (node instanceof PassColorTextureNode) {
            // Push the owning PassNode.
            if (!visited.has(node.passNode.id)) {
                queue.push(node.passNode);
            }
        }

        // Traverse children based on kind.
        const deps = depsOfNode(node);
        for (const dep of deps) queue.push(dep);
    }

    return result;
}

/** Minimal deps extractor for graph traversal (mirrors collect.ts depsOf). */
function depsOfNode(node: Node<WgslType>): Node<WgslType>[] {
    const n = node as unknown as Record<string, unknown>;
    switch (node.kind) {
        case 'binop':  return [n['left'] as Node<WgslType>, n['right'] as Node<WgslType>];
        case 'call':   return n['args'] as Node<WgslType>[];
        case 'raw':    return (n['deps'] as Node<WgslType>[] | undefined) ?? [];
        case 'field':  return [n['object'] as Node<WgslType>];
        case 'index':  return [n['object'] as Node<WgslType>, n['index'] as Node<WgslType>];
        case 'varying': return [n['source'] as Node<WgslType>];
        case 'assign': return [n['target'] as Node<WgslType>, n['value'] as Node<WgslType>];
        case 'construct': return n['args'] as Node<WgslType>[];
        case 'if':     {
            const deps: Node<WgslType>[] = [n['condition'] as Node<WgslType>, n['thenBody'] as Node<WgslType>];
            if (n['elseBody']) deps.push(n['elseBody'] as Node<WgslType>);
            return deps;
        }
        default:       return [];
    }
}
