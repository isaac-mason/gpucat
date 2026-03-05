import { Tab } from '../ui/tab';
import { List } from '../ui/list';
import { Item } from '../ui/item';
import type { Node, WgslType } from '../../nodes/nodes';

export class Viewer extends Tab {

    nodeList: List;
    nodes: Item;
    private _itemLibrary: Map<string, Item> = new Map();
    private _canvasLibrary: Map<string, HTMLCanvasElement> = new Map();

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

    private _addNodeItem(node: Node<WgslType>): Item {
        const id = node.id;
        let item = this._itemLibrary.get(id);

        if (!item) {
            // Create a 140×140 canvas placeholder for the node preview
            let canvas = this._canvasLibrary.get(id);
            if (!canvas) {
                canvas = document.createElement('canvas');
                canvas.width = 140;
                canvas.height = 140;
                canvas.style.display = 'block';
                canvas.style.width = '140px';
                canvas.style.height = '140px';

                // Draw a placeholder pattern so the canvas isn't invisible
                const ctx = canvas.getContext('2d');
                if (ctx) {
                    ctx.fillStyle = '#1a1a2e';
                    ctx.fillRect(0, 0, 140, 140);
                    ctx.strokeStyle = '#444466';
                    ctx.strokeRect(0, 0, 140, 140);
                    ctx.fillStyle = '#666688';
                    ctx.font = '11px monospace';
                    ctx.textAlign = 'center';
                    ctx.fillText(node._inspectorName ?? node.id.slice(0, 12), 70, 74);
                }

                this._canvasLibrary.set(id, canvas);
            }

            const nameLabel = node._inspectorName ?? node.id;
            item = new Item(canvas, nameLabel);
            (item.itemRow.children[1] as HTMLElement).style.justifyContent = 'flex-start';
            this._itemLibrary.set(id, item);
        }

        return item;
    }

    /** Called each frame with the list of inspectable nodes seen this frame. */
    update(_inspector: unknown, nodes: Node<WgslType>[]): void {
        if (!this.isActive && !this.isDetached) return;

        const seenIds = new Set<string>();

        for (const node of nodes) {
            seenIds.add(node.id);
            const item = this._addNodeItem(node);
            if (!item.parent) {
                this.nodes.add(item);
            }
        }

        // Remove items for nodes no longer present
        for (const [id, item] of this._itemLibrary) {
            if (!seenIds.has(id)) {
                if (item.parent) (item.parent as Item).remove(item);
                this._itemLibrary.delete(id);
                this._canvasLibrary.delete(id);
            }
        }
    }
}
