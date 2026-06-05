import { Tab } from '../ui/tab';
export declare class Console extends Tab {
    filters: {
        info: boolean;
        warn: boolean;
        error: boolean;
    };
    filterText: string;
    logContainer: HTMLDivElement;
    constructor(options?: {
        name?: string;
        allowDetach?: boolean;
    });
    private _buildHeader;
    applyFilters(): void;
    copyAll(button: HTMLButtonElement): void;
    private _getIcon;
    private _formatMessage;
    addMessage(type: string, text: string): void;
}
