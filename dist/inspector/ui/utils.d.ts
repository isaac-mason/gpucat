export declare function createValueSpan(id?: string | null): HTMLSpanElement;
export declare function setText(element: HTMLElement | string | null, text: string): void;
export declare function getText(element: HTMLElement | string | null): string | null;
export declare function splitPath(fullPath: string): {
    path: string;
    name: string;
};
export declare function splitCamelCase(str: string): string;
export declare function formatBytes(bytes: number, decimals?: number): string;
