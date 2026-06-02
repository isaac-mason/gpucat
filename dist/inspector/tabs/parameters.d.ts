import { Tab, type TabOptions } from 'gpucat/dist/inspector/ui/tab';
import { GUI } from 'gpucat/dist/inspector/gui/GUI';
export declare class Parameters extends Tab {
    private _container;
    constructor(options?: TabOptions);
    createGroup(name: string): GUI;
}
