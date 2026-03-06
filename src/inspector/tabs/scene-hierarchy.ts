/**
 * scene-hierarchy.ts — Inspector Scene Hierarchy tab.
 *
 * Walks the Object3D tree for every scene record in a frame and displays it
 * as a collapsible tree using the existing List/Item UI components.
 *
 * Key design constraints:
 *  - DOM is NOT rebuilt from scratch each frame.
 *    A Map<objectId, HierarchyNode> tracks live nodes. Only structural changes
 *    (add / remove) mutate the DOM; transforms etc. are updated in-place.
 *  - Clicking a Mesh row opens the shader panel to the right of the hierarchy.
 *  - The tab auto-shows itself when scenes are present (mirrors Viewer pattern).
 */

import { Tab } from '../ui/tab';
import { List } from '../ui/list';
import { Item } from '../ui/item';
import { ShaderPanel } from './shader-panel';
import type { Inspector } from '../inspector';
import type { SceneRecord } from '../renderer-inspector';
import { Mesh } from '../../objects/mesh';
import type { Object3D } from '../../objects/object3d';

// ---------------------------------------------------------------------------
// Internal node record — one per live Object3D in the tree
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
    if (obj instanceof Mesh) return 'Mesh';
    if (obj.constructor?.name === 'Scene') return 'Scene';
    return 'Object3D';
}

/** Display name — prefer obj.name, fall back to type + objectId. */
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

// ---------------------------------------------------------------------------
// SceneHierarchy Tab
// ---------------------------------------------------------------------------

export class SceneHierarchy extends Tab {

    readonly list: List;

    /** objectId → HierarchyNode for every currently-displayed object */
    private _nodes: Map<number, HierarchyNode> = new Map();

    /** Item roots, one per scene (keyed by passId) */
    private _sceneRoots: Map<string, Item> = new Map();

    /** Currently selected mesh (for shader display) */
    private _selectedMesh: Mesh | null = null;
    private _selectedSceneRecord: SceneRecord | null = null;

    /** Inline shader panel below the hierarchy list */
    private _shaderPanel: ShaderPanel;

    /** Wrapper element for the shader panel */
    private _shaderContainer: HTMLDivElement;

    constructor() {
        super('Scene');

        const list = new List('Name', 'Type');
        list.setGridStyle('1fr auto');

        const scrollWrapper = document.createElement('div');
        scrollWrapper.className = 'list-scroll-wrapper scene-hierarchy-list';
        scrollWrapper.appendChild(list.domElement);

        this._shaderPanel = new ShaderPanel();

        this._shaderContainer = document.createElement('div');
        this._shaderContainer.className = 'shader-container';
        this._shaderContainer.style.display = 'none';
        this._shaderContainer.appendChild(this._shaderPanel.domElement);

        // Row layout: list on the left, shader panel on the right
        const layout = document.createElement('div');
        layout.className = 'scene-hierarchy-layout';
        layout.appendChild(scrollWrapper);
        layout.appendChild(this._shaderContainer);

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

        // Refresh shader panel if a mesh is selected
        if (this._selectedMesh && this._selectedSceneRecord) {
            this._refreshShaderPanel(inspector);
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
                // New child — create item
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
                // Existing child — update name in case it changed
                const nameEl = hn.item.itemRow.querySelector('.hierarchy-name') as HTMLElement | null;
                if (nameEl) nameEl.textContent = displayName(child);
            }

            // Recurse into grandchildren
            this._syncChildren(_inspector, child, hn.item, sr);
        }
    }

    // -----------------------------------------------------------------------
    // Selection & shader panel
    // -----------------------------------------------------------------------

    private _onItemClick(obj: Object3D, sr: SceneRecord, item: Item): void {
        // Clear previous selection highlight
        if (this._selectedMesh) {
            const prevHn = this._nodes.get(this._selectedMesh.objectId);
            prevHn?.item.itemRow.classList.remove('hierarchy-selected');
        }

        if (obj instanceof Mesh) {
            this._selectedMesh = obj;
            this._selectedSceneRecord = sr;
            item.itemRow.classList.add('hierarchy-selected');
            this._showShaderPanel();
        } else {
            this._selectedMesh = null;
            this._selectedSceneRecord = null;
            this._hideShaderPanel();
        }
    }

    private _refreshShaderPanel(inspector: Inspector): void {
        if (!this._selectedMesh || !this._selectedSceneRecord) return;
        this._shaderPanel.update(inspector, this._selectedMesh, this._selectedSceneRecord);
    }

    private _showShaderPanel(): void {
        this._shaderContainer.style.display = 'flex';
        // Will be populated on next _refreshShaderPanel call
    }

    private _hideShaderPanel(): void {
        this._shaderContainer.style.display = 'none';
    }
}
