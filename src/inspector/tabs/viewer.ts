/**
 * viewer.ts — Inspector Viewer tab.
 *
 * Three.js aligned: mirrors examples/jsm/inspector/tabs/Viewer.js
 *
 * Pattern:
 *   getCanvasDataByNode() — creates a CanvasTarget + wraps the node as vec4(vec3(node), 1)
 *                           + builds a Material. Cached per node, never recreated.
 *   update()              — for each canvasData:
 *                             1. save renderer state (renderTarget, mrt, clearColor)
 *                             2. reset state (setMRT(null), clearColor black)
 *                             3. setCanvasTarget(canvasData.canvasTarget)
 *                             4. renderer.renderQuad(canvasData.material, encoder)
 *                             5. renderer.setCanvasTarget(previousTarget)
 *                             6. restoreRendererState(savedState)
 *
 * renderQuad() is used instead of renderer.render(wrappedNode) to avoid
 * triggering updateBefore() on PassNodes, which would cause a stack overflow
 * by recursively rendering the scene inside the inspector viewer.
 *
 * Three.js equivalent: canvasData.quad.render(renderer) — QuadMesh.render()
 * calls renderer.render(scene, camera) directly without updateBefore.
 */

import { Tab } from '../ui/tab';
import { List } from '../ui/list';
import { Item } from '../ui/item';
import { type Node, VaryingNode, builtin, wgsl } from '../../nodes/nodes';
import * as d from '../../nodes/schema';
import type { Inspector } from '../inspector';
import { CanvasTarget } from '../../renderer/canvas-target';
import { Material } from '../../material/material';
import * as pipelines from '../../renderer/pipelines';
import { Geometry } from '../../geometry/geometry';

// ---------------------------------------------------------------------------
// CanvasData — one entry per inspectable node (cached, never recreated)
// ---------------------------------------------------------------------------

export type CanvasData = {
    /** Stable ID (= node.id) */
    id: number;
    /** The original inspectable node */
    node: Node<d.Any>;
    /** Wrapped node: vec4f(node.xyz, 1.0) embedded in the fullscreen material graph */
    wrappedNode: Node<d.vec4f>;
    /** Fullscreen material built from wrappedNode */
    material: Material;
    /** 140×140 CanvasTarget the viewer renders into */
    canvasTarget: CanvasTarget;
    /** Human-readable label (leaf name after splitPath) */
    name: string;
    /**
     * Optional folder path — the part of the name before the last '/'.
     * Three.js aligned: canvasData.path is used to group items in the viewer.
     * Undefined if no path component.
     */
    path?: string;
};

// ---------------------------------------------------------------------------
// Viewer Tab
// ---------------------------------------------------------------------------

export class Viewer extends Tab {

    nodeList: List;
    nodes: Item;

    /** Cached item DOM rows, keyed by canvasData.id */
    private _itemLibrary: Map<number, Item> = new Map();

    /** Cached folder items, keyed by path name. Three.js aligned: folderLibrary */
    private _folderLibrary: Map<string, Item> = new Map();

    /** Current list of canvasData shown in the viewer */
    private _currentDataList: CanvasData[] = [];

    /** Shared fullscreen geometry for all node previews */
    private _fullscreenGeometry: Geometry | null = null;

    constructor(options: { name?: string; allowDetach?: boolean } = {}) {
        super('Viewer', options);

        const nodeList = new List('Viewer', 'Name');
        nodeList.setGridStyle('150px minmax(200px, 2fr)');
        nodeList.domElement.style.minWidth = '400px';

        const scrollWrapper = document.createElement('div');
        scrollWrapper.className = 'list-scroll-wrapper';
        scrollWrapper.appendChild(nodeList.domElement);
        this.content.appendChild(scrollWrapper);

        const nodes = new Item('Nodes');
        nodeList.add(nodes);

        this.nodeList = nodeList;
        this.nodes = nodes;
    }

    // -----------------------------------------------------------------------
    // Public API — called by Inspector each frame
    // -----------------------------------------------------------------------

    /**
     * Get or create a folder item for the given path name.
     * Three.js aligned: mirrors Viewer.getFolder().
     */
    getFolder(name: string): Item {
        let folder = this._folderLibrary.get(name);

        if (folder === undefined) {
            folder = new Item(name);
            this._folderLibrary.set(name, folder);
            this.nodeList.add(folder);
        }

        return folder;
    }

    /**
     * Update the viewer: render every inspectable node into its preview canvas.
     * Three.js aligned: mirrors Viewer.update(renderer, canvasDataList).
     *
     * For each canvasData:
     *   1. Save renderer state (renderTarget, mrt, clearColor)
     *   2. Reset state — setMRT(null), clearColor → black
     *   3. renderer.setCanvasTarget(canvasData.canvasTarget)
     *   4. renderer.renderQuad(canvasData.material, encoder)  ← no updateBefore!
     *   5. renderer.setCanvasTarget(previousTarget)
     *   6. Restore renderer state
     *
     * Using renderQuad() instead of render(node) is the critical difference:
     * render(node) calls updateBefore() which triggers PassNode.updateBefore()
     * causing a stack overflow. renderQuad() skips updateBefore entirely,
     * mirroring how Three.js uses QuadMesh.render() → renderer.render(scene, camera).
     */
    update(inspector: Inspector, canvasDataList: CanvasData[]): void {
        if (!this.isActive && !this.isDetached) return;

        const renderer = inspector.getRenderer();
        if (!renderer) return;

        // --- Remove items for nodes no longer in the list ---
        // Three.js aligned: remove old items + clean up empty folders
        const previousDataList = [...this._currentDataList];
        for (const canvasData of previousDataList) {
            if (this._itemLibrary.has(canvasData.id) && canvasDataList.indexOf(canvasData) === -1) {
                const item = this._itemLibrary.get(canvasData.id)!;
                const parent = item.parent as Item | null;

                if (parent) {
                    parent.remove(item);

                    // Three.js aligned: remove empty folder from nodeList
                    if (canvasData.path && this._folderLibrary.has(canvasData.path)) {
                        const folder = this._folderLibrary.get(canvasData.path)!;
                        if ((folder as Item & { children?: unknown[] }).children?.length === 0) {
                            if (folder.parent) (folder.parent as Item).remove(folder);
                            this._folderLibrary.delete(canvasData.path);
                        }
                    }
                }

                this._itemLibrary.delete(canvasData.id);
            }
        }

        this._currentDataList = canvasDataList;

        // --- Add / render each node ---
        // Three.js aligned: indexes tracks insertion order within each folder
        const indexes: Record<string, number> = {};

        for (const canvasData of canvasDataList) {
            const item = this._addNodeItem(canvasData);
            const path = canvasData.path;

            if (path) {
                const folder = this.getFolder(path);

                if (indexes[path] === undefined) {
                    indexes[path] = 0;
                }

                if (!item.parent || item.parent !== folder) {
                    folder.add(item);
                }

                indexes[path]++;
            } else {
                if (!item.parent) {
                    this.nodes.add(item);
                }
            }

            // Save renderer state — mirrors RendererUtils.resetRendererState()
            const savedState = renderer.saveRendererState();

            // Reset to clean defaults for the preview render
            renderer.setMRT(null);
            renderer.setRenderTarget(null);
            renderer.clearColor = [0, 0, 0, 1];

            // Swap to preview canvas target
            const previousTarget = renderer.getCanvasTarget();
            renderer.setCanvasTarget(canvasData.canvasTarget);

            // Render the preview quad — NO updateBefore, no PassNode recursion.
            // Three.js equivalent: canvasData.quad.render(renderer)
            //   → renderer.render(quadMesh, camera)  (scene-level, no updateBefore)
            const encoder = renderer.device.createCommandEncoder();
            renderer.renderQuad(canvasData.material, encoder);
            renderer.device.queue.submit([encoder.finish()]);

            // Restore canvas target and renderer state
            renderer.setCanvasTarget(previousTarget);
            renderer.restoreRendererState(savedState);
        }
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    private _addNodeItem(canvasData: CanvasData): Item {
        let item = this._itemLibrary.get(canvasData.id);

        if (!item) {
            const domElement = canvasData.canvasTarget.domElement;
            item = new Item(domElement, canvasData.name);
            (item.itemRow.children[1] as HTMLElement).style.justifyContent = 'flex-start';
            this._itemLibrary.set(canvasData.id, item);
        }

        return item;
    }

    /** Shared fullscreen geometry: a single triangle that covers the viewport. */
    _getFullscreenGeometry(): Geometry {
        if (!this._fullscreenGeometry) {
            const geom = new Geometry();
            geom.vertexCount = 3;
            this._fullscreenGeometry = geom;
        }
        return this._fullscreenGeometry;
    }
}

// ---------------------------------------------------------------------------
// Module-level helpers — used by Inspector.getCanvasDataByNode()
// ---------------------------------------------------------------------------

/**
 * Split a camelCase / PascalCase name into space-separated words.
 * Three.js aligned: mirrors splitCamelCase() in Inspector ui/utils.js.
 *
 * Examples:
 *   'tonemappedOutput'  → 'Tonemapped Output'
 *   'NormalsViewSpace'  → 'Normals View Space'
 */
export function splitCamelCase(str: string): string {
    return str
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/^./, s => s.toUpperCase());
}

/**
 * Split a name containing '/' into { path, name } components.
 * Three.js aligned: mirrors splitPath() in Inspector ui/utils.js.
 *
 * The last segment is `name`; everything before is `path` (or undefined if
 * there is no '/' in the string).
 *
 * Examples:
 *   'MRT/Output'  → { path: 'MRT', name: 'Output' }
 *   'Normals'     → { path: undefined, name: 'Normals' }
 */
export function splitPath(str: string): { path: string | undefined; name: string } {
    const idx = str.lastIndexOf('/');
    if (idx === -1) return { path: undefined, name: str };
    return { path: str.slice(0, idx), name: str.slice(idx + 1) };
}

/**
 * Position node for the fullscreen triangle.
 * Uses @builtin(vertex_index) to generate clip-space positions.
 */
export function makeFullscreenPositionNode(): Node<d.vec4f> {
    const vi = builtin('vertex_index', d.u32);
    return wgsl(d.vec4f)`vec4f(f32((${ vi } & 1u) * 2u) * 2.0 - 1.0, f32(${ vi } & 2u) * 2.0 - 1.0, 0.0, 1.0)`;
}

/**
 * UV varying node for fullscreen triangle.
 * Computes UV from clip position so textureSample() calls work.
 */
export function makeFullscreenUVVarying(): VaryingNode<d.vec2f> {
    const vi = builtin('vertex_index', d.u32);
    const uvSource = wgsl(d.vec2f)`vec2f((f32((${ vi } & 1u) * 2u) * 2.0 - 1.0) * 0.5 + 0.5, 0.5 - (f32(${ vi } & 2u) * 2.0 - 1.0) * 0.5)`;
    return new VaryingNode<d.vec2f>(uvSource, 'uv');
}

/**
 * Convert any node to a vec4f suitable for fullscreen preview display.
 *
 * Dispatch table:
 *   scalar (f32/i32/u32/bool)  → vec4f(f32(v), f32(v), f32(v), 1.0)   grayscale
 *   vec2f                       → vec4f(v.x, v.y, 0.0, 1.0)
 *   vec2i / vec2u               → vec4f(f32(v.x), f32(v.y), 0.0, 1.0)
 *   vec3f                       → vec4f(v.xyz, 1.0)
 *   vec3i / vec3u               → vec4f(f32(v.x), f32(v.y), f32(v.z), 1.0)
 *   vec4f                       → vec4f(v.xyz, 1.0)    (drop user alpha)
 *   vec4i / vec4u               → vec4f(f32(v.x), f32(v.y), f32(v.z), 1.0)
 *   mat*                        → vec4f scalar from first element
 *   texture / sampler / other   → textureSample evaluates to vec4f; take .xyz
 */
function nodeToVec4f(node: Node<d.Any>): Node<d.vec4f> {
    const t = node.type.wgslType;

    // ---- scalars ----
    if (t === 'f32') {
        return wgsl(d.vec4f)`vec4f(${ node }, ${ node }, ${ node }, 1.0)`;
    }
    if (t === 'i32' || t === 'u32' || t === 'bool') {
        return wgsl(d.vec4f)`vec4f(f32(${ node }), f32(${ node }), f32(${ node }), 1.0)`;
    }

    // ---- vec2 ----
    if (t === 'vec2f') {
        return wgsl(d.vec4f)`vec4f((${ node }).x, (${ node }).y, 0.0, 1.0)`;
    }
    if (t === 'vec2i' || t === 'vec2u') {
        return wgsl(d.vec4f)`vec4f(f32((${ node }).x), f32((${ node }).y), 0.0, 1.0)`;
    }

    // ---- vec3 ----
    if (t === 'vec3f') {
        return wgsl(d.vec4f)`vec4f((${ node }).xyz, 1.0)`;
    }
    if (t === 'vec3i' || t === 'vec3u') {
        return wgsl(d.vec4f)`vec4f(f32((${ node }).x), f32((${ node }).y), f32((${ node }).z), 1.0)`;
    }

    // ---- vec4 ----
    if (t === 'vec4f') {
        return wgsl(d.vec4f)`vec4f((${ node }).xyz, 1.0)`;
    }
    if (t === 'vec4i' || t === 'vec4u') {
        return wgsl(d.vec4f)`vec4f(f32((${ node }).x), f32((${ node }).y), f32((${ node }).z), 1.0)`;
    }

    // ---- matrices — show first column as RGB ----
    if (t.startsWith('mat')) {
        // mat NxM f: first element is a scalar representative
        return wgsl(d.vec4f)`vec4f(f32((${ node })[0][0]), f32((${ node })[0][1]), f32((${ node })[0][2]), 1.0)`;
    }

    // ---- texture / sampler / unknown — assume textureSample gives vec4f ----
    // The node itself generates a textureSample(...) call that returns vec4f,
    // so (node).xyz is valid here.
    return wgsl(d.vec4f)`vec4f((${ node }).xyz, 1.0)`;
}

/**
 * Build the wrapped output node and material for a preview canvas.
 * Type-dispatches the inspectable node to a valid vec4f expression so that
 * all node types (scalar, vec2, vec3, vec4, texture) render correctly.
 * The UV varying is included in the graph so textureSample(…, in.uv) works.
 *
 * Three.js aligned: mirrors the node wrapping in Inspector.getCanvasDataByNode()
 */
export function makePreviewMaterial(node: Node<d.Any>, format: GPUTextureFormat): {
    wrappedNode: Node<d.vec4f>;
    material: Material;
    pipelineKey: string;
} {
    const posNode = makeFullscreenPositionNode();
    const uvVarying = makeFullscreenUVVarying();

    // Convert node to vec4f, handling all WGSL types correctly
    const clamped = nodeToVec4f(node);
    // Include UV varying in the graph so in.uv is available for texture sampling
    const wrappedNode = wgsl(d.vec4f)`${ clamped }`.with(uvVarying);

    const material = new Material({
        vertex: posNode,
        fragment: wrappedNode,
        depthWrite: false,
        depthTest: false,
    });

    const pipelineKey = pipelines.makeRenderPipelineKey(material, 1, format);

    return { wrappedNode, material, pipelineKey };
}
