import type { List } from 'gpucat/dist/inspector/ui/list';
export declare class Item {
    children: Item[];
    isOpen: boolean;
    childrenContainer: HTMLDivElement | null;
    parent: Item | List | null;
    domElement: HTMLDivElement;
    itemRow: HTMLDivElement;
    userData: Record<string, unknown>;
    data: (HTMLElement | string)[];
    constructor(...data: (HTMLElement | string | number)[]);
    onItemClick(e: Event): void;
    add(item: Item, index?: number): this;
    remove(item: Item): this;
    updateToggler(): void;
    toggle(): this;
    close(): this;
}
