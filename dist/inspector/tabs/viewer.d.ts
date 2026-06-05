/**
 * viewer.ts — Inspector Viewer tab.
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
 */
import { Tab } from '../ui/tab';
import { List } from '../ui/list';
import { Item } from '../ui/item';
import { type Node } from '../../nodes/nodes';
import * as d from '../../schema/schema';
import type { Inspector } from '../inspector';
import { CanvasTarget } from '../../renderer/canvas-target';
import { Material } from '../../material/material';
import { QuadMesh } from '../../objects/quad-mesh';
export type CanvasData = {
    /** Stable ID (= node.id) */
    id: number;
    /** The original inspectable node */
    node: Node<d.Any>;
    /** QuadMesh for rendering the preview */
    quadMesh: QuadMesh;
    /** 140x140 CanvasTarget the viewer renders into */
    canvasTarget: CanvasTarget;
    /** Human-readable label (leaf name after splitPath) */
    name: string;
    /**
     * Optional folder path — the part of the name before the last '/'.
     * Used to group items in the viewer. Undefined if no path component.
     */
    path?: string;
};
export declare class Viewer extends Tab {
    nodeList: List;
    nodes: Item;
    /** Cached item DOM rows, keyed by canvasData.id */
    private _itemLibrary;
    /** Cached folder items, keyed by path name. */
    private _folderLibrary;
    /** Current list of canvasData shown in the viewer */
    private _currentDataList;
    constructor(options?: {
        name?: string;
        allowDetach?: boolean;
    });
    /**
     * Get or create a folder item for the given path name.
     */
    getFolder(name: string): Item;
    /**
     * Update the viewer: render every inspectable node into its preview canvas.
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
     * causing a stack overflow. renderQuad() skips updateBefore entirely.
     */
    update(inspector: Inspector, canvasDataList: CanvasData[]): void;
    private _addNodeItem;
}
/**
 * Split a camelCase / PascalCase name into space-separated words.
 *
 * Examples:
 *   'tonemappedOutput'  → 'Tonemapped Output'
 *   'NormalsViewSpace'  → 'Normals View Space'
 */
export declare function splitCamelCase(str: string): string;
/**
 * Split a name containing '/' into { path, name } components.
 *
 * The last segment is `name`; everything before is `path` (or undefined if
 * there is no '/' in the string).
 *
 * Examples:
 *   'MRT/Output'  → { path: 'MRT', name: 'Output' }
 *   'Normals'     → { path: undefined, name: 'Normals' }
 */
export declare function splitPath(str: string): {
    path: string | undefined;
    name: string;
};
/**
 * Create a fullscreen preview material for the given node.
 * Uses QuadMesh geometry (position attribute) and converts the node to vec4f.
 */
export declare function createPreviewMaterial(node: Node<d.Any>): Material;
