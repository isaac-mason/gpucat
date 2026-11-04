import { type Node } from '../../nodes/nodes';
import type { Mesh } from '../../objects/mesh';
import type * as d from '../../schema/schema';
import type { Inspector } from '../inspector';
import { Tab } from '../ui/tab';
/** Inspector Viewer tab: the nodes shown this frame, each drawn fullscreen into a tile, grouped by folder. */
export type CanvasData = {
    /** Stable ID (= node.id) */
    id: number;
    /** The inspected node */
    node: Node<d.Any>;
    /** The bufferless fullscreen mesh drawn into its tile, and into the focused view while it is the one shown. */
    mesh: Mesh;
    /** Human-readable label (leaf name after splitPath) */
    name: string;
    /** The part of the name before the last '/', the folder it is shown in; undefined for none. */
    path?: string;
};
export declare class Viewer extends Tab {
    private _tileSize;
    private readonly _sizeButtons;
    private readonly _sections;
    private readonly _tiles;
    private readonly _body;
    private readonly _focus;
    private readonly _focusTitle;
    private readonly _focusZoom;
    private readonly _focusStage;
    private readonly _focusCanvas;
    /** Whether the canvas fits the stage, refitted every draw, until a wheel or drag sets its own view. */
    private _fitted;
    /** CSS pixels to one canvas pixel, and where the canvas's top left sits. */
    private _zoom;
    private _panX;
    private _panY;
    /** The focused view's surface, made when it first draws and released when it closes. */
    private _focusSurface;
    /** Whether previews draw offscreen and are read back: the renderer cannot present to their canvases. */
    private _offscreen;
    /** The node the focused view draws, or null when it is closed. */
    private _focused;
    constructor(options?: {
        name?: string;
        allowDetach?: boolean;
    });
    /** Draws every tile, and the focused view, for this frame's nodes; while the tab is hidden, nothing. */
    update(inspector: Inspector, canvasDataList: CanvasData[]): void;
    /** Wheel zooms about the cursor, a drag pans, a double-click fits the canvas to the stage again. */
    private _listenToStage;
    /** The zoom at which the whole canvas fits the stage's width and the height the panel has left below its top. */
    private _fitZoom;
    /** Where the panel stops showing the stage: the bottom of the nearest ancestor that scrolls, else the window's. */
    private _visibleBottom;
    /** The canvas at its zoom and pan, its stage as tall as the fitted canvas, and the zoom shown. */
    private _placeFocusCanvas;
    /** Each node's tile in its folder's section, in the order given; tiles and sections no longer shown go. */
    private _placeTiles;
    private _createTile;
    /** A tile's surface, a canvas of its own presented to directly or read back into. */
    private _surfaceFor;
    /** Every tile's and the focused view's renderer objects released, for the inspector's own disposal. */
    dispose(): void;
    private _sectionOf;
    private _setTileSize;
    private _setFocus;
    /**
     * The focused view's surface, the window's size in device pixels: an inspected screen-space node (a render target,
     * a visibility buffer) draws a pixel of its own to each canvas pixel.
     */
    private _focusSurfaceSized;
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
