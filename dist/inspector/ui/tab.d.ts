export interface TabOptions {
    allowDetach?: boolean;
    builtin?: boolean;
    icon?: string;
    name?: string;
}
export declare class Tab {
    id: string;
    button: HTMLButtonElement;
    content: HTMLDivElement;
    isActive: boolean;
    isVisible: boolean;
    isDetached: boolean;
    detachedWindow: {
        panel: HTMLElement;
        tab: Tab;
    } | null;
    allowDetach: boolean;
    builtin: boolean;
    icon: string | null;
    builtinButton: HTMLElement | null;
    miniContent: HTMLElement | null;
    profiler: any | null;
    onVisibilityChange: (() => void) | null;
    originalIndex?: number;
    constructor(title: string, options?: TabOptions);
    setActive(isActive: boolean): void;
    show(): void;
    hide(): void;
    showBuiltin(): void;
    hideBuiltin(): void;
}
