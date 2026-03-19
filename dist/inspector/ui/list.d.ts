import { Item } from './item';
export declare class List {
    headers: string[];
    children: Item[];
    domElement: HTMLDivElement;
    id: string;
    private gridStyleElement;
    constructor(...headers: string[]);
    setGridStyle(gridTemplate: string): void;
    add(item: Item): void;
    remove(item: Item): this;
}
