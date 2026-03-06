/**
 * viewer.ts — Inspector Viewer tab.
 *
 * Three.js aligned: mirrors examples/jsm/inspector/tabs/Viewer.js
 *
 * Pattern:
 *   getCanvasDataByNode() — creates a CanvasTarget + wraps the node as vec4(vec3(node), 1)
 *                           + builds a Material. Cached per node, never recreated.
 *   update()              — for each canvasData, save previousTarget, setCanvasTarget(preview),
 *                           renderer.render(wrappedNode), setCanvasTarget(previousTarget).
 *
 * This works for ALL inspectable node types — both texture nodes (MRT outputs) and
 * non-texture nodes (tonemappedOutput, etc.) — because render() always does a fullscreen
 * composite and the node graph is what determines the content.
 */

import { Tab } from '../ui/tab';
import { List } from '../ui/list';
import { Item } from '../ui/item';
import { type Node, type WgslType, VaryingNode, builtin } from '../../nodes/nodes';
import { wgsl } from '../../nodes/nodes';
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
    id: string;
    /** The original inspectable node */
    node: Node<WgslType>;
    /** Wrapped node: vec4f(node.xyz, 1.0) embedded in the fullscreen material graph */
    wrappedNode: Node<'vec4f'>;
    /** Fullscreen material built from wrappedNode */
    material: Material;
    /** 140×140 CanvasTarget the viewer renders into */
    canvasTarget: CanvasTarget;
    /** Human-readable label */
    name: string;
};

// ---------------------------------------------------------------------------
// Viewer Tab
// ---------------------------------------------------------------------------

export class Viewer extends Tab {

    nodeList: List;
    nodes: Item;

    /** Cached item DOM rows, keyed by canvasData.id */
    private _itemLibrary: Map<string, Item> = new Map();

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
     * Update the viewer: render every inspectable node into its preview canvas.
     * Three.js aligned: mirrors Viewer.update(renderer, canvasDataList).
     *
     * For each canvasData:
     *   1. Save previousTarget = renderer.getCanvasTarget()
     *   2. renderer.setCanvasTarget(canvasData.canvasTarget)
     *   3. renderer.render(canvasData.wrappedNode)   ← fullscreen composite to preview canvas
     *   4. renderer.setCanvasTarget(previousTarget)
     */
    update(inspector: Inspector, canvasDataList: CanvasData[]): void {
        if (!this.isActive && !this.isDetached) return;

        const renderer = inspector.getRenderer();
        if (!renderer) return;

        // --- Remove items for nodes no longer in the list ---
        const previousDataList = [...this._currentDataList];
        for (const canvasData of previousDataList) {
            if (this._itemLibrary.has(canvasData.id) && canvasDataList.indexOf(canvasData) === -1) {
                const item = this._itemLibrary.get(canvasData.id)!;
                if (item.parent) (item.parent as Item).remove(item);
                this._itemLibrary.delete(canvasData.id);
            }
        }

        this._currentDataList = canvasDataList;

        // --- Add / render each node ---
        for (const canvasData of canvasDataList) {
            const item = this._addNodeItem(canvasData);
            if (!item.parent) {
                this.nodes.add(item);
            }

            // Save → swap → render → restore
            const previousTarget = renderer.getCanvasTarget();
            renderer.setCanvasTarget(canvasData.canvasTarget);
            renderer.render(canvasData.wrappedNode);
            renderer.setCanvasTarget(previousTarget);
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
 * Position node for the fullscreen triangle.
 * Uses @builtin(vertex_index) to generate clip-space positions.
 */
export function makeFullscreenPositionNode(): Node<'vec4f'> {
    const vi = builtin('vertex_index', 'u32');
    return wgsl(d.vec4f)`vec4f(f32((${ vi } & 1u) * 2u) * 2.0 - 1.0, f32(${ vi } & 2u) * 2.0 - 1.0, 0.0, 1.0)`;
}

/**
 * UV varying node for fullscreen triangle.
 * Computes UV from clip position so textureSample() calls work.
 */
export function makeFullscreenUVVarying(): VaryingNode<'vec2f'> {
    const vi = builtin('vertex_index', 'u32');
    const uvSource = wgsl(d.vec2f)`vec2f((f32((${ vi } & 1u) * 2u) * 2.0 - 1.0) * 0.5 + 0.5, 0.5 - (f32(${ vi } & 2u) * 2.0 - 1.0) * 0.5)`;
    return new VaryingNode('vec2f', 'uv', uvSource);
}

/**
 * Build the wrapped output node and material for a preview canvas.
 * Wraps the inspectable node as vec4f(node.xyz, 1.0) and builds a fullscreen Material.
 * The UV varying is included in the graph so textureSample(…, in.uv) works.
 *
 * Three.js aligned: mirrors the node wrapping in Inspector.getCanvasDataByNode()
 */
export function makePreviewMaterial(node: Node<WgslType>, format: GPUTextureFormat): {
    wrappedNode: Node<'vec4f'>;
    material: Material;
    pipelineKey: string;
} {
    const posNode = makeFullscreenPositionNode();
    const uvVarying = makeFullscreenUVVarying();

    // vec4f(node.xyz, 1.0) — clamp to opaque vec4 regardless of source type
    const clamped = wgsl(d.vec4f)`vec4f((${ node }).xyz, 1.0)`;
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
