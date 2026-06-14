import type { Tab } from './tab';
interface DetachedWindow {
    panel: HTMLElement;
    tab: Tab;
}
interface DetachedTabData {
    tabId: string;
    originalIndex: number;
    left: number;
    top: number;
    width: number;
    height: number;
}
export declare class Profiler {
    domElement: HTMLDivElement;
    toggleButton: HTMLButtonElement;
    builtinTabsContainer: HTMLElement;
    miniPanel: HTMLDivElement;
    panel: HTMLDivElement;
    tabsContainer: HTMLDivElement;
    contentWrapper: HTMLDivElement;
    floatingBtn: HTMLButtonElement;
    maximizeBtn: HTMLButtonElement;
    tabs: Record<string, Tab>;
    activeTabId: string | null;
    isResizing: boolean;
    lastHeightBottom: number;
    lastWidthRight: number;
    position: string;
    detachedWindows: DetachedWindow[];
    isMobile: boolean;
    maxZIndex: number;
    nextTabOriginalIndex: number;
    isLoadingLayout: boolean;
    pendingDetachedTabs: DetachedTabData[] | null;
    /** Persistent window listeners, stashed so dispose() can remove them. */
    private _orientationListener;
    private _resizeListener;
    constructor();
    detectMobile(): boolean;
    setupOrientationListener(): void;
    setupWindowResizeListener(): void;
    /**
     * Tear down everything this Profiler installed on global state: persistent
     * window listeners and detached tab panels (which live as `document.body`
     * children, not under `domElement`). The main panel + its subtree are NOT
     * removed here, the Inspector owns `domElement.remove()`.
     */
    dispose(): void;
    constrainWindowToBounds(windowPanel: HTMLElement): void;
    setupShell(): void;
    setupResizing(): void;
    toggleMaximize(): void;
    addTab(tab: Tab): void;
    addBuiltinTab(tab: Tab): void;
    updatePanelSize(): void;
    setupTabDragAndDrop(tab: Tab): void;
    createPreviewWindow(tab: Tab, x: number, y: number): HTMLDivElement;
    detachTab(tab: Tab, x: number, y: number): void;
    createDetachedWindow(tab: Tab, x: number, y: number): DetachedWindow;
    bringWindowToFront(windowPanel: HTMLDivElement): void;
    setupDetachedWindowDrag(windowPanel: HTMLDivElement, header: HTMLDivElement, tab: Tab): void;
    setupDetachedWindowResize(windowPanel: HTMLDivElement, resizerTop: HTMLDivElement, resizerRight: HTMLDivElement, resizerBottom: HTMLDivElement, resizerLeft: HTMLDivElement, resizerCorner: HTMLDivElement): void;
    reattachTab(tab: Tab): void;
    setActiveTab(id: string): void;
    togglePanel(): void;
    togglePosition(): void;
    setPosition(targetPosition: string): void;
    saveLayout(): void;
    loadLayout(): void;
    restoreDetachedTabs(): void;
}
export {};
