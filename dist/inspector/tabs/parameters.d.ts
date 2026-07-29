import { GUI } from '../gui/GUI';
import { Tab, type TabOptions } from '../ui/tab';
export declare class Parameters extends Tab {
    private _container;
    constructor(options?: TabOptions);
    createGroup(name: string): GUI;
}
