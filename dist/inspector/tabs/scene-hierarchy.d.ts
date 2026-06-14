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
import type { Inspector } from '../inspector';
import type { SceneRecord } from '../renderer-inspector';
export declare class SceneHierarchy extends Tab {
    readonly list: List;
    /** objectId → HierarchyNode for every currently-displayed object */
    private _nodes;
    /** Item roots, one per scene (keyed by passId) */
    private _sceneRoots;
    /** Currently selected mesh */
    private _selectedMesh;
    /** The inspector reference passed into update(), used for navigation */
    private _inspector;
    /** Right-side detail panel, shown when a Mesh is selected */
    private _detailPanel;
    constructor();
    /**
     * Called by Inspector._processFrame() whenever scenes are present.
     * Diffs the tree against the current DOM state and updates in-place.
     */
    update(inspector: Inspector, scenes: SceneRecord[]): void;
    private _syncScene;
    /** Recursively diff children of `parent` against `parentItem`. */
    private _syncChildren;
    private _onItemClick;
    /**
     * Populate `_detailPanel` with geometry info, material render state,
     * instance count, and a "→ Draw Call" navigation button for `mesh`.
     * The panel is rebuilt from scratch on each selection change.
     */
    private _buildMeshDetail;
}
