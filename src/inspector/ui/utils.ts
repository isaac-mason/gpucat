export function createValueSpan(id: string | null = null): HTMLSpanElement {
    const span = document.createElement('span');
    span.className = 'value';
    if (id !== null) span.id = id;
    return span;
}

export function setText(element: HTMLElement | string | null, text: string): void {
    const el = element instanceof HTMLElement ? element : (element ? document.getElementById(element) : null);
    if (el && el.textContent !== text) el.textContent = text;
}

export function getText(element: HTMLElement | string | null): string | null {
    const el = element instanceof HTMLElement ? element : (element ? document.getElementById(element) : null);
    return el ? el.textContent : null;
}

export function splitPath(fullPath: string): { path: string; name: string } {
    const lastSlash = fullPath.lastIndexOf('/');
    if (lastSlash === -1) return { path: '', name: fullPath.trim() };
    return {
        path: fullPath.substring(0, lastSlash).trim(),
        name: fullPath.substring(lastSlash + 1).trim(),
    };
}

export function splitCamelCase(str: string): string {
    return str.replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
}

export function formatBytes(bytes: number, decimals = 2): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}
