/** Inspector Viewer tab: one preview canvas per inspectable node, each its own one-pass frame. */
import { type Node } from '../../nodes/nodes';
import type { Mesh } from '../../objects/mesh';
import type { CanvasTarget } from '../../renderer/core/canvas-target';
import * as d from '../../schema/schema';
import type { Inspector } from '../inspector';
import { Item } from '../ui/item';
import { List } from '../ui/list';
import { Tab } from '../ui/tab';
export type CanvasData = {
    /** Stable ID (= node.id) */
    id: number;
    /** The original inspectable node */
    node: Node<d.Any>;
    /** The bufferless fullscreen mesh drawn into `canvasTarget`. */
    mesh: Mesh;
    /** 140x140 CanvasTarget the viewer renders into */
    canvasTarget: CanvasTarget;
    /** Human-readable label (leaf name after splitPath) */
    name: string;
    /**
     * Optional folder path, the part of the name before the last '/'.
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
     * Each preview draws a `fullscreen` mesh wrapping the node, never the node's own graph: a
     * `RenderTextureNode` in it would open its pass inside the preview's and recurse.
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
/** A bufferless fullscreen draw of `node`, coerced to vec4f. */
export declare function createPreviewMesh(node: Node<d.Any>): Mesh;
