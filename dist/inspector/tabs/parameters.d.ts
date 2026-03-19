import { Tab, type TabOptions } from '../ui/tab';
import { GUI } from '../gui/GUI';
export declare class Parameters extends Tab {
    private _container;
    constructor(options?: TabOptions);
    createGroup(name: string): GUI;
}
