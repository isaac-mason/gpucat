/**
 * scene-hierarchy.ts, Inspector Scene Hierarchy tab.
 *
 * Walks the Object3D tree for every scene record in a frame and displays it
 * as a collapsible tree using the existing List/Item UI components.
 *
 * Key design constraints:
 *  - DOM is NOT rebuilt from scratch each frame.
 *    A Map<objectId, HierarchyNode> tracks live nodes. Only structural changes
 *    (add / remove) mutate the DOM; transforms etc. are updated in-place.
 *  - Clicking a Mesh row opens a detail panel to the right of the hierarchy
 *    showing geometry info, material render state, instance count, and a
 *    "→ Draw Call" navigation button.
 *  - The tab auto-shows itself when scenes are present (mirrors Viewer pattern).
 */

import { Tab } from '../ui/tab';
import { List } from '../ui/list';
import { Item } from '../ui/item';
import type { Inspector } from '../inspector';
import type { SceneRecord } from '../renderer-inspector';
import { Mesh } from '../../objects/mesh';
import type { Object3D } from '../../core/object3d';
import { getIndexFormat } from '../../core/gpu-buffer';

// ---------------------------------------------------------------------------
// Internal node record, one per live Object3D in the tree
// ---------------------------------------------------------------------------

type HierarchyNode = {
    objectId: number;
    object: Object3D;
    item: Item;
    /** objectId → HierarchyNode for this node's current children */
    children: Map<number, HierarchyNode>;
    /** scene record that owns this node (for shader lookup) */
    sceneRecord: SceneRecord;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Human-readable type label for an Object3D. */
function typeLabel(obj: Object3D): string {
    if (obj.isMesh) return 'Mesh';
    if (obj.constructor?.name === 'Scene') return 'Scene';
    return 'Object3D';
}

/** Display name, prefer obj.name, fall back to type + objectId. */
function displayName(obj: Object3D): string {
    return obj.name || `${typeLabel(obj)} #${obj.objectId}`;
}

/** Build the type-badge span element. */
function makeTypeBadge(label: string): HTMLSpanElement {
    const badge = document.createElement('span');
    badge.className = `hierarchy-type-badge hierarchy-type-badge--${label.toLowerCase()}`;
    badge.textContent = label;
    return badge;
}

/** Create a section header div using the dc-section-header class. */
function makeSectionHeader(text: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'dc-section-header';
    el.textContent = text;
    return el;
}

/** Create a key/value row using the dc-kv-* classes. */
function makeKVRow(key: string, value: string): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'dc-kv-row';

    const k = document.createElement('span');
    k.className = 'dc-kv-key';
    k.textContent = key;

    const v = document.createElement('span');
    v.className = 'dc-kv-val';
    v.textContent = value;

    row.appendChild(k);
    row.appendChild(v);
    return row;
}

// ---------------------------------------------------------------------------
// SceneHierarchy Tab
// ---------------------------------------------------------------------------

export class SceneHierarchy extends Tab {

    readonly list: List;

    /** objectId → HierarchyNode for every currently-displayed object */
    private _nodes: Map<number, HierarchyNode> = new Map();

    /** Item roots, one per scene (keyed by passId) */
    private _sceneRoots: Map<string, Item> = new Map();

    /** Currently selected mesh */
    private _selectedMesh: Mesh | null = null;

    /** The inspector reference passed into update(), used for navigation */
    private _inspector: Inspector | null = null;

    /** Right-side detail panel, shown when a Mesh is selected */
    private _detailPanel: HTMLDivElement;

    constructor() {
        super('Scene');

        const list = new List('Name', 'Type');
        list.setGridStyle('1fr auto');

        const scrollWrapper = document.createElement('div');
        scrollWrapper.className = 'list-scroll-wrapper scene-hierarchy-list';
        scrollWrapper.appendChild(list.domElement);

        this._detailPanel = document.createElement('div');
        this._detailPanel.className = 'shader-container mesh-detail-panel';
        this._detailPanel.style.display = 'none';

        // Row layout: list on the left, detail panel on the right
        const layout = document.createElement('div');
        layout.className = 'scene-hierarchy-layout';
        layout.appendChild(scrollWrapper);
        layout.appendChild(this._detailPanel);

        this.content.appendChild(layout);

        this.list = list;
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * Called by Inspector._processFrame() whenever scenes are present.
     * Diffs the tree against the current DOM state and updates in-place.
     */
    update(inspector: Inspector, scenes: SceneRecord[]): void {
        this._inspector = inspector;
        // Build the set of passIds we expect to show
        const activePassIds = new Set(scenes.map(s => s.passId));

        // Remove scene roots that are no longer present
        for (const [passId, rootItem] of this._sceneRoots) {
            if (!activePassIds.has(passId)) {
                this.list.remove(rootItem);
                this._sceneRoots.delete(passId);
                // Clean up all HierarchyNodes belonging to this scene
                for (const [id, hn] of this._nodes) {
                    if (hn.sceneRecord.passId === passId) {
                        this._nodes.delete(id);
                    }
                }
            }
        }

        // Sync each scene
        for (const sr of scenes) {
            this._syncScene(inspector, sr);
        }
    }

    // -----------------------------------------------------------------------
    // Tree diffing
    // -----------------------------------------------------------------------

    private _syncScene(inspector: Inspector, sr: SceneRecord): void {
        // Ensure a root item exists for this pass
        let rootItem = this._sceneRoots.get(sr.passId);
        if (!rootItem) {
            const badge = makeTypeBadge('Scene');
            const nameEl = document.createElement('span');
            nameEl.className = 'hierarchy-name';
            nameEl.textContent = displayName(sr.scene);
            rootItem = new Item(nameEl, badge);
            this._sceneRoots.set(sr.passId, rootItem);
            this.list.add(rootItem);
        } else {
            // Update scene name in case it changed
            const nameEl = rootItem.itemRow.querySelector('.hierarchy-name') as HTMLElement | null;
            if (nameEl) nameEl.textContent = displayName(sr.scene);
        }

        // Register / refresh the scene root in our node map
        const existing = this._nodes.get(sr.scene.objectId);
        if (!existing) {
            this._nodes.set(sr.scene.objectId, {
                objectId: sr.scene.objectId,
                object: sr.scene,
                item: rootItem,
                children: new Map(),
                sceneRecord: sr,
            });
        }

        this._syncChildren(inspector, sr.scene, rootItem, sr);
        void inspector;
    }

    /** Recursively diff children of `parent` against `parentItem`. */
    private _syncChildren(
        _inspector: Inspector,
        parent: Object3D,
        parentItem: Item,
        sr: SceneRecord,
    ): void {
        const parentNode = this._nodes.get(parent.objectId);
        if (!parentNode) return;

        const liveChildIds = new Set(parent.children.map(c => c.objectId));

        // Remove items whose objects are no longer children
        for (const [id, hn] of parentNode.children) {
            if (!liveChildIds.has(id)) {
                parentItem.remove(hn.item);
                parentNode.children.delete(id);
                this._nodes.delete(id);
            }
        }

        // Add / update each current child
        for (const child of parent.children) {
            let hn = parentNode.children.get(child.objectId);

            if (!hn) {
                // New child, create item
                const badge = makeTypeBadge(typeLabel(child));
                const nameEl = document.createElement('span');
                nameEl.className = 'hierarchy-name';
                nameEl.textContent = displayName(child);

                const item = new Item(nameEl, badge);
                item.itemRow.classList.add('actionable');

                // Capture for closure
                const capturedChild = child;
                const capturedSr = sr;
                item.itemRow.addEventListener('click', (e) => {
                    // Don't trigger if click was on the toggler
                    if ((e.target as HTMLElement).closest('.item-toggler')) return;
                    this._onItemClick(capturedChild, capturedSr, item);
                });

                parentItem.add(item);

                hn = {
                    objectId: child.objectId,
                    object: child,
                    item,
                    children: new Map(),
                    sceneRecord: sr,
                };
                parentNode.children.set(child.objectId, hn);
                this._nodes.set(child.objectId, hn);
            } else {
                // Existing child, update name in case it changed
                const nameEl = hn.item.itemRow.querySelector('.hierarchy-name') as HTMLElement | null;
                if (nameEl) nameEl.textContent = displayName(child);
            }

            // Recurse into grandchildren
            this._syncChildren(_inspector, child, hn.item, sr);
        }
    }

    // -----------------------------------------------------------------------
    // Selection & detail panel
    // -----------------------------------------------------------------------

    private _onItemClick(obj: Object3D, _sr: SceneRecord, item: Item): void {
        // Clear previous selection highlight
        if (this._selectedMesh) {
            const prevHn = this._nodes.get(this._selectedMesh.objectId);
            prevHn?.item.itemRow.classList.remove('hierarchy-selected');
        }

        if (obj.isMesh) {
            const mesh = obj as Mesh;
            this._selectedMesh = mesh;
            item.itemRow.classList.add('hierarchy-selected');
            this._buildMeshDetail(mesh);
            this._detailPanel.style.display = 'flex';
        } else {
            this._selectedMesh = null;
            this._detailPanel.innerHTML = '';
            this._detailPanel.style.display = 'none';
        }
    }

    /**
     * Populate `_detailPanel` with geometry info, material render state,
     * instance count, and a "→ Draw Call" navigation button for `mesh`.
     * The panel is rebuilt from scratch on each selection change.
     */
    private _buildMeshDetail(mesh: Mesh): void {
        const panel = this._detailPanel;
        panel.innerHTML = '';

        const geo = mesh.geometry;
        const mat = mesh.material;

        // ------------------------------------------------------------------
        // Geometry section
        // ------------------------------------------------------------------
        panel.appendChild(makeSectionHeader('Geometry'));

        const table = document.createElement('div');
        table.className = 'dc-kv-table';

        table.appendChild(makeKVRow('drawRange.start', String(geo.drawRange.start)));
        table.appendChild(makeKVRow('drawRange.count', String(geo.drawRange.count)));

        // Index info
        if (geo.index && geo.index.array) {
            table.appendChild(makeKVRow('indices', String(geo.index.array.length)));
            table.appendChild(makeKVRow('index format', getIndexFormat(geo.index.array) ?? 'unknown'));
        } else {
            table.appendChild(makeKVRow('indices', 'none'));
        }

        // Buffers
        const bufferNames = Array.from(geo.buffers.keys());
        if (bufferNames.length > 0) {
            for (const name of bufferNames) {
                const buffer = geo.buffers.get(name)!;
                const fmt = buffer.format ?? `itemSize=${buffer.itemSize}`;
                table.appendChild(makeKVRow(`buffer: ${name}`, fmt));
            }
        } else {
            table.appendChild(makeKVRow('buffers', 'none'));
        }

        // Bounding box, Box3 is [minX, minY, minZ, maxX, maxY, maxZ]
        if (geo.boundingBox) {
            const bb = geo.boundingBox;
            const minStr = `(${bb[0].toFixed(2)}, ${bb[1].toFixed(2)}, ${bb[2].toFixed(2)})`;
            const maxStr = `(${bb[3].toFixed(2)}, ${bb[4].toFixed(2)}, ${bb[5].toFixed(2)})`;
            table.appendChild(makeKVRow('bbox min', minStr));
            table.appendChild(makeKVRow('bbox max', maxStr));
        }

        panel.appendChild(table);

        // ------------------------------------------------------------------
        // Material section
        // ------------------------------------------------------------------
        panel.appendChild(makeSectionHeader('Material'));

        const matTable = document.createElement('div');
        matTable.className = 'dc-kv-table';

        matTable.appendChild(makeKVRow('transparent', String(mat.transparent)));
        matTable.appendChild(makeKVRow('depthTest', String(mat.depthTest)));
        matTable.appendChild(makeKVRow('depthWrite', String(mat.depthWrite)));
        matTable.appendChild(makeKVRow('depthCompare', mat.depthCompare));
        matTable.appendChild(makeKVRow('cullMode', mat.cullMode));
        matTable.appendChild(makeKVRow('alphaToCoverage', String(mat.alphaToCoverage)));

        if (mat.blend) {
            const b = mat.blend;
            const colorOp = b.color ? `${b.color.operation ?? 'add'} (src:${b.color.srcFactor ?? 'one'} dst:${b.color.dstFactor ?? 'zero'})` : 'default';
            const alphaOp = b.alpha ? `${b.alpha.operation ?? 'add'} (src:${b.alpha.srcFactor ?? 'one'} dst:${b.alpha.dstFactor ?? 'zero'})` : 'default';
            matTable.appendChild(makeKVRow('blend.color', colorOp));
            matTable.appendChild(makeKVRow('blend.alpha', alphaOp));
        } else {
            matTable.appendChild(makeKVRow('blend', 'none'));
        }

        panel.appendChild(matTable);

        // ------------------------------------------------------------------
        // Instance section
        // ------------------------------------------------------------------
        panel.appendChild(makeSectionHeader('Instance'));

        const instTable = document.createElement('div');
        instTable.className = 'dc-kv-table';
        instTable.appendChild(makeKVRow('count', String(mesh.count)));
        panel.appendChild(instTable);

        // ------------------------------------------------------------------
        // Navigation button
        // ------------------------------------------------------------------
        const navBtn = document.createElement('button');
        navBtn.className = 'dc-nav-link';
        navBtn.title = "Jump to this mesh's draw call";
        navBtn.textContent = '→ Draw Call';
        navBtn.style.margin = '12px 8px 8px';

        navBtn.addEventListener('click', () => {
            const inspector = this._inspector;
            if (!inspector) return;
            const renderer = inspector.getRenderer();
            if (!renderer) return;
            for (const ro of renderer._renderObjects.renderObjects) {
                if (ro.mesh === mesh) {
                    inspector.navigateToRO(ro);
                    return;
                }
            }
        });

        panel.appendChild(navBtn);
    }
}
