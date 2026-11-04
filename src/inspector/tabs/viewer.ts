import { createRenderTarget, type RenderTarget } from '../../core/render-target';
import { f32, type Node, u32, vec4 } from '../../nodes/nodes';
import { fullscreen } from '../../objects/fullscreen';
import type { Mesh } from '../../objects/mesh';
import { type CanvasTarget, createCanvasTarget } from '../../renderer/core/canvas-target';
import { frame } from '../../renderer/core/frame';
import { read } from '../../renderer/core/read';
import type { Renderer } from '../../renderer/core/renderer';
import type { Target } from '../../renderer/core/target';
import type * as d from '../../schema/schema';
import type { Inspector } from '../inspector';
import { Tab } from '../ui/tab';

/** Inspector Viewer tab: the nodes shown this frame, each drawn fullscreen into a tile, grouped by folder. */

// CanvasData, one entry per inspected node (cached, never recreated)

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

/** Tile sizes the toolbar offers, in CSS pixels. */
const TILE_SIZES = { S: 96, M: 140, L: 220 } as const;
type TileSize = keyof typeof TILE_SIZES;

/** The most the focused view zooms in: CSS pixels to one of its canvas's pixels. */
const ZOOM_MAX = 64;

/** CSS pixels the focused view leaves below it in the panel, so the panel's bottom never cuts it off. */
const FOCUS_MARGIN = 8;

/**
 * Where a preview draws and how it reaches its canvas: straight into the canvas on WebGPU, which presents to any
 * number of them; on WebGL, whose context presents to its one canvas, into an offscreen target read back into a 2D
 * canvas once the frame is submitted, a target whose read is pending skipping its draws until it lands.
 */
type Surface = {
    canvas: HTMLCanvasElement;
    direct: CanvasTarget | null;
    offscreen: RenderTarget | null;
    reading: boolean;
};

type Tile = { element: HTMLDivElement; data: CanvasData; surface: Surface };
type Section = { element: HTMLDivElement; grid: HTMLDivElement; count: HTMLSpanElement };

export class Viewer extends Tab {
    private _tileSize: TileSize = 'M';
    private readonly _sizeButtons = new Map<TileSize, HTMLButtonElement>();
    private readonly _sections = new Map<string, Section>();
    private readonly _tiles = new Map<number, Tile>();
    private readonly _body: HTMLDivElement;
    private readonly _focus: HTMLDivElement;
    private readonly _focusTitle: HTMLSpanElement;
    private readonly _focusZoom: HTMLSpanElement;
    private readonly _focusStage: HTMLDivElement;
    private readonly _focusCanvas: HTMLCanvasElement;
    /** Whether the canvas fits the stage, refitted every draw, until a wheel or drag sets its own view. */
    private _fitted = true;
    /** CSS pixels to one canvas pixel, and where the canvas's top left sits. */
    private _zoom = 1;
    private _panX = 0;
    private _panY = 0;
    /** The focused view's surface, made when it first draws and released when it closes. */
    private _focusSurface: Surface | null = null;
    /** Whether previews draw offscreen and are read back: the renderer cannot present to their canvases. */
    private _offscreen = false;
    /** The node the focused view draws, or null when it is closed. */
    private _focused: CanvasData | null = null;

    constructor(options: { name?: string; allowDetach?: boolean } = {}) {
        super('Viewer', options);

        const toolbar = document.createElement('div');
        toolbar.className = 'viewer-toolbar';
        const label = document.createElement('span');
        label.className = 'viewer-toolbar-label';
        label.textContent = 'size';
        toolbar.appendChild(label);
        for (const size of Object.keys(TILE_SIZES) as TileSize[]) {
            const button = document.createElement('button');
            button.className = 'viewer-size';
            button.textContent = size;
            button.addEventListener('click', () => this._setTileSize(size));
            this._sizeButtons.set(size, button);
            toolbar.appendChild(button);
        }

        const focus = document.createElement('div');
        focus.className = 'viewer-focus';
        focus.hidden = true;
        const focusHeader = document.createElement('div');
        focusHeader.className = 'viewer-focus-header';
        const focusTitle = document.createElement('span');
        const focusZoom = document.createElement('span');
        focusZoom.className = 'viewer-focus-zoom';
        const close = document.createElement('button');
        close.className = 'viewer-focus-close';
        close.textContent = 'x';
        close.title = 'close';
        close.addEventListener('click', () => this._setFocus(null));
        focusHeader.append(focusTitle, focusZoom, close);
        // the node drawn at the screen's size, a canvas pixel to a screen pixel, zoomed and panned in the stage
        const focusStage = document.createElement('div');
        focusStage.className = 'viewer-focus-stage';
        focusStage.title = 'wheel to zoom, drag to pan, double-click to fit';
        const focusCanvas = document.createElement('canvas');
        focusCanvas.className = 'viewer-focus-canvas';
        focusStage.appendChild(focusCanvas);
        focus.append(focusHeader, focusStage);
        this._listenToStage(focusStage);

        const body = document.createElement('div');
        body.className = 'viewer-body';
        body.append(focus);

        this.content.classList.add('viewer-content');
        this.content.append(toolbar, body);

        this._body = body;
        this._focus = focus;
        this._focusTitle = focusTitle;
        this._focusZoom = focusZoom;
        this._focusStage = focusStage;
        this._focusCanvas = focusCanvas;
        this._setTileSize('M');
    }

    /** Draws every tile, and the focused view, for this frame's nodes; while the tab is hidden, nothing. */
    update(inspector: Inspector, canvasDataList: CanvasData[]): void {
        if (!this.isActive && !this.isDetached) return;

        const renderer = inspector.getRenderer();
        if (!renderer) return;
        // a WebGL2 context presents to the one canvas it was made on
        this._offscreen = renderer.api === 'webgl';

        this._placeTiles(canvasDataList);

        const tile = TILE_SIZES[this._tileSize];
        const drawn: Surface[] = [];
        // every preview is a pass on one frame
        const f = frame(renderer);
        for (const data of canvasDataList) {
            const surface = this._tiles.get(data.id)!.surface;
            if (surface.reading) continue;
            sizeTile(surface, tile);
            const pass = f.pass({ target: surfaceTarget(surface), clear: [0, 0, 0, 1], label: 'viewer' });
            pass.draw(data.mesh);
            pass.end();
            drawn.push(surface);
        }

        const focused = this._focused;
        if (focused !== null && canvasDataList.includes(focused)) {
            const surface = this._focusSurfaceSized();
            if (!surface.reading) {
                const pass = f.pass({ target: surfaceTarget(surface), clear: [0, 0, 0, 1], label: 'viewer-focus' });
                pass.draw(focused.mesh);
                pass.end();
                drawn.push(surface);
            }
            this._placeFocusCanvas();
        }
        f.submit();
        for (const surface of drawn) presentSurface(renderer, surface);
    }

    /** Wheel zooms about the cursor, a drag pans, a double-click fits the canvas to the stage again. */
    private _listenToStage(stage: HTMLDivElement): void {
        stage.addEventListener(
            'wheel',
            (event) => {
                event.preventDefault();
                const rect = stage.getBoundingClientRect();
                const x = event.clientX - rect.left;
                const y = event.clientY - rect.top;
                const fit = this._fitZoom();
                if (this._fitted) {
                    this._zoom = fit;
                    this._panX = 0;
                    this._panY = 0;
                }
                this._fitted = false;
                const zoom = Math.min(ZOOM_MAX, Math.max(fit, this._zoom * Math.exp(-event.deltaY * 0.002)));
                // the canvas pixel under the cursor stays under it
                this._panX = x - ((x - this._panX) / this._zoom) * zoom;
                this._panY = y - ((y - this._panY) / this._zoom) * zoom;
                this._zoom = zoom;
                this._placeFocusCanvas();
            },
            { passive: false },
        );
        stage.addEventListener('pointerdown', (event) => {
            stage.setPointerCapture(event.pointerId);
            let lastX = event.clientX;
            let lastY = event.clientY;
            const move = (moved: PointerEvent) => {
                this._fitted = false;
                this._panX += moved.clientX - lastX;
                this._panY += moved.clientY - lastY;
                lastX = moved.clientX;
                lastY = moved.clientY;
                this._placeFocusCanvas();
            };
            const up = () => {
                stage.removeEventListener('pointermove', move);
                stage.removeEventListener('pointerup', up);
            };
            stage.addEventListener('pointermove', move);
            stage.addEventListener('pointerup', up);
        });
        stage.addEventListener('dblclick', () => {
            this._fitted = true;
            this._placeFocusCanvas();
        });
    }

    /** The zoom at which the whole canvas fits the stage's width and the height the panel has left below its top. */
    private _fitZoom(): number {
        const canvas = this._focusCanvas;
        const room = this._visibleBottom() - this._focusStage.getBoundingClientRect().top - FOCUS_MARGIN;
        const byWidth = this._focusStage.clientWidth / Math.max(1, canvas.width);
        const byHeight = Math.max(1, room) / Math.max(1, canvas.height);
        return Math.min(byWidth, byHeight);
    }

    /** Where the panel stops showing the stage: the bottom of the nearest ancestor that scrolls, else the window's. */
    private _visibleBottom(): number {
        for (let element = this._focusStage.parentElement; element !== null; element = element.parentElement) {
            const overflow = getComputedStyle(element).overflowY;
            if ((overflow === 'auto' || overflow === 'scroll') && element.clientHeight < element.scrollHeight + 1) {
                return Math.min(window.innerHeight, element.getBoundingClientRect().bottom);
            }
        }
        return window.innerHeight;
    }

    /** The canvas at its zoom and pan, its stage as tall as the fitted canvas, and the zoom shown. */
    private _placeFocusCanvas(): void {
        const canvas = this._focusCanvas;
        const fit = this._fitZoom();
        if (this._fitted) {
            this._zoom = fit;
            this._panX = 0;
            this._panY = 0;
        }
        this._focusStage.style.height = `${Math.round(canvas.height * fit)}px`;
        canvas.style.width = `${canvas.width * this._zoom}px`;
        canvas.style.height = `${canvas.height * this._zoom}px`;
        canvas.style.transform = `translate(${this._panX}px, ${this._panY}px)`;
        this._focusZoom.textContent = `${Math.round(this._zoom * window.devicePixelRatio * 100)}%`;
    }

    /** Each node's tile in its folder's section, in the order given; tiles and sections no longer shown go. */
    private _placeTiles(canvasDataList: CanvasData[]): void {
        const shown = new Set<number>();
        for (const data of canvasDataList) {
            shown.add(data.id);
            let tile = this._tiles.get(data.id);
            if (tile === undefined) {
                tile = this._createTile(data);
                this._tiles.set(data.id, tile);
            }
            const section = this._sectionOf(data.path ?? 'nodes');
            if (tile.element.parentElement !== section.grid) section.grid.appendChild(tile.element);
        }
        for (const [id, tile] of this._tiles) {
            if (shown.has(id)) continue;
            tile.element.remove();
            releaseSurface(tile.surface);
            this._tiles.delete(id);
            if (this._focused === tile.data) this._setFocus(null);
        }
        for (const [path, section] of this._sections) {
            const count = section.grid.childElementCount;
            if (count === 0) {
                section.element.remove();
                this._sections.delete(path);
            } else {
                section.count.textContent = String(count);
            }
        }
    }

    private _createTile(data: CanvasData): Tile {
        const element = document.createElement('div');
        element.className = 'viewer-tile';
        element.title = data.path ? `${data.path}/${data.name}` : data.name;
        const surface = this._surfaceFor();
        surface.canvas.classList.add('viewer-tile-canvas');
        const label = document.createElement('span');
        label.className = 'viewer-tile-label';
        label.textContent = data.name;
        element.append(surface.canvas, label);
        element.addEventListener('click', () => this._setFocus(this._focused === data ? null : data));
        return { element, data, surface };
    }

    /** A tile's surface, a canvas of its own presented to directly or read back into. */
    private _surfaceFor(): Surface {
        const canvas = document.createElement('canvas');
        canvas.style.display = 'block';
        if (this._offscreen) {
            const offscreen = createRenderTarget(1, 1, { colorFormat: 'rgba8unorm', label: 'viewer/tile' });
            return { canvas, direct: null, offscreen, reading: false };
        }
        const direct = createCanvasTarget(canvas);
        direct.setPixelRatio(window.devicePixelRatio);
        return { canvas, direct, offscreen: null, reading: false };
    }

    /** Every tile's and the focused view's renderer objects released, for the inspector's own disposal. */
    dispose(): void {
        for (const tile of this._tiles.values()) releaseSurface(tile.surface);
        this._tiles.clear();
        if (this._focusSurface !== null) releaseSurface(this._focusSurface);
        this._focusSurface = null;
    }

    private _sectionOf(path: string): Section {
        let section = this._sections.get(path);
        if (section === undefined) {
            const element = document.createElement('div');
            element.className = 'viewer-section';
            const title = document.createElement('div');
            title.className = 'viewer-section-title';
            const name = document.createElement('span');
            name.textContent = path;
            const count = document.createElement('span');
            count.className = 'viewer-section-count';
            title.append(name, count);
            const grid = document.createElement('div');
            grid.className = 'viewer-grid';
            element.append(title, grid);
            this._body.appendChild(element);
            section = { element, grid, count };
            this._sections.set(path, section);
        }
        return section;
    }

    private _setTileSize(size: TileSize): void {
        this._tileSize = size;
        this.content.style.setProperty('--viewer-tile', `${TILE_SIZES[size]}px`);
        for (const [each, button] of this._sizeButtons) button.classList.toggle('active', each === size);
    }

    private _setFocus(data: CanvasData | null): void {
        if (data !== this._focused) this._fitted = true;
        // a closed view holds nothing on the renderer
        if (data === null && this._focusSurface !== null) {
            releaseSurface(this._focusSurface);
            this._focusSurface = null;
        }
        this._focused = data;
        this._focus.hidden = data === null;
        for (const tile of this._tiles.values()) tile.element.classList.toggle('focused', tile.data === data);
        if (data !== null) this._focusTitle.textContent = data.path ? `${data.path}/${data.name}` : data.name;
    }

    /**
     * The focused view's surface, the window's size in device pixels: an inspected screen-space node (a render target,
     * a visibility buffer) draws a pixel of its own to each canvas pixel.
     */
    private _focusSurfaceSized(): Surface {
        let surface = this._focusSurface;
        if (surface === null) {
            const canvas = this._focusCanvas;
            surface = this._offscreen
                ? {
                      canvas,
                      direct: null,
                      offscreen: createRenderTarget(1, 1, { colorFormat: 'rgba8unorm', label: 'viewer/focus' }),
                      reading: false,
                  }
                : // its size is the screen's whatever its CSS size, which the zoom sets
                  { canvas, direct: createCanvasTarget(canvas, { autoResize: false }), offscreen: null, reading: false };
            surface.direct?.setPixelRatio(1);
            this._focusSurface = surface;
        }
        const width = Math.max(1, Math.round(window.innerWidth * window.devicePixelRatio));
        const height = Math.max(1, Math.round(window.innerHeight * window.devicePixelRatio));
        if (canvasSize(surface).width !== width || canvasSize(surface).height !== height) {
            if (surface.direct !== null) surface.direct.setSize(width, height, false);
            else {
                surface.offscreen!.setSize(width, height);
                surface.canvas.width = width;
                surface.canvas.height = height;
            }
            this._fitted = true;
        }
        return surface;
    }
}

/** What a pass on `surface` draws into. */
function surfaceTarget(surface: Surface): Target {
    return surface.direct ?? surface.offscreen!;
}

/** The pixels `surface`'s canvas holds. */
function canvasSize(surface: Surface): { width: number; height: number } {
    return { width: surface.canvas.width, height: surface.canvas.height };
}

/** A tile's surface at `tile` CSS pixels square. */
function sizeTile(surface: Surface, tile: number): void {
    if (surface.direct !== null) {
        const size = surface.direct.getSize();
        if (size.width !== tile || size.height !== tile) surface.direct.setSize(tile, tile);
        return;
    }
    const pixels = Math.round(tile * window.devicePixelRatio);
    if (surface.canvas.width === pixels && surface.canvas.height === pixels) return;
    surface.offscreen!.setSize(pixels, pixels);
    surface.canvas.width = pixels;
    surface.canvas.height = pixels;
    surface.canvas.style.width = `${tile}px`;
    surface.canvas.style.height = `${tile}px`;
}

/** After the frame: an offscreen surface's pixels read back into its canvas; a direct one is already there. */
function presentSurface(renderer: Renderer, surface: Surface): void {
    const target = surface.offscreen;
    if (target === null) return;
    surface.reading = true;
    const { width, height } = target;
    read(renderer, target)
        .then((bytes) => {
            // a resize since the draw leaves the canvas to the next one
            if (surface.canvas.width !== width || surface.canvas.height !== height) return;
            const pixels = new ImageData(width, height);
            pixels.data.set(bytes);
            surface.canvas.getContext('2d')?.putImageData(pixels, 0, 0);
        })
        .catch((error: unknown) => console.warn('[viewer] a preview could not be read back', error))
        .finally(() => {
            surface.reading = false;
        });
}

/** The renderer's objects `surface` made, released. */
function releaseSurface(surface: Surface): void {
    surface.direct?.dispose();
    surface.direct = null;
    surface.offscreen?.dispose();
    surface.offscreen = null;
}

// Module-level helpers, used by Inspector.getCanvasDataByNode()

/**
 * Split a camelCase / PascalCase name into space-separated words.
 *
 * Examples:
 *   'tonemappedOutput'  → 'Tonemapped Output'
 *   'NormalsViewSpace'  → 'Normals View Space'
 */
export function splitCamelCase(str: string): string {
    return str
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/^./, (s) => s.toUpperCase());
}

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
export function splitPath(str: string): { path: string | undefined; name: string } {
    const idx = str.lastIndexOf('/');
    if (idx === -1) return { path: undefined, name: str };
    return { path: str.slice(0, idx), name: str.slice(idx + 1) };
}

/** Any node as a colour a fullscreen preview can draw, in node code so it compiles on either backend. */
function nodeToVec4f(node: Node<d.Any>): Node<d.vec4f> {
    const t = node.type.wgslType;
    const one = f32(1);
    // integers and booleans convert to float, as a colour channel reads them
    const channel = (value: Node<d.Any>): Node<d.f32> => (value.type.wgslType === 'f32' ? (value as Node<d.f32>) : f32(value));
    const vector = node as unknown as Node<d.vec4f>;

    if (t === 'f32' || t === 'i32' || t === 'u32' || t === 'bool') {
        const value = channel(node);
        return vec4(value, value, value, one);
    }
    if (t.startsWith('vec2')) return vec4(channel(vector.x), channel(vector.y), f32(0), one);
    if (t.startsWith('vec3') || t.startsWith('vec4')) return vec4(channel(vector.x), channel(vector.y), channel(vector.z), one);
    // a matrix shows its first column
    if (t.startsWith('mat')) {
        const column = (node as Node<d.mat4x4f>).element(u32(0)) as Node<d.vec4f>;
        return vec4(column.x, column.y, column.z, one);
    }
    // a texture or anything else: what it samples to, as the node's own value
    return vec4(vector.xyz, one);
}

/** A bufferless fullscreen draw of `node`, coerced to vec4f. */
export function createPreviewMesh(node: Node<d.Any>): Mesh {
    return fullscreen(nodeToVec4f(node));
}
