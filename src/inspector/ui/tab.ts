export interface TabOptions {
    allowDetach?: boolean;
    builtin?: boolean;
    icon?: string;
    name?: string;
}

export class Tab {
    id: string;
    button: HTMLButtonElement;
    content: HTMLDivElement;
    isActive: boolean;
    isVisible: boolean;
    isDetached: boolean;
    detachedWindow: { panel: HTMLElement; tab: Tab } | null;
    allowDetach: boolean;
    builtin: boolean;
    icon: string | null;
    builtinButton: HTMLElement | null;
    miniContent: HTMLElement | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    profiler: any | null;
    onVisibilityChange: (() => void) | null;
    originalIndex?: number;

    constructor(title: string, options: TabOptions = {}) {
        this.id = title.toLowerCase();
        this.button = document.createElement('button');
        this.button.className = 'tab-btn';
        this.button.textContent = title;

        this.content = document.createElement('div');
        this.content.id = `${this.id}-content`;
        this.content.className = 'profiler-content';

        this.isActive = false;
        this.isVisible = true;
        this.isDetached = false;
        this.detachedWindow = null;
        this.allowDetach = options.allowDetach !== undefined ? options.allowDetach : true;
        this.builtin = options.builtin !== undefined ? options.builtin : false;
        this.icon = options.icon || null;
        this.builtinButton = null;
        this.miniContent = null;
        this.profiler = null;
        this.onVisibilityChange = null;
    }

    setActive(isActive: boolean): void {
        this.button.classList.toggle('active', isActive);
        this.content.classList.toggle('active', isActive);
        this.isActive = isActive;
    }

    show(): void {
        this.content.style.display = '';
        this.button.style.display = '';
        this.isVisible = true;
        if (this.isDetached && this.detachedWindow) {
            this.detachedWindow.panel.style.display = '';
        }
        if (this.onVisibilityChange) this.onVisibilityChange();
        this.showBuiltin();
    }

    hide(): void {
        this.content.style.display = 'none';
        this.button.style.display = 'none';
        this.isVisible = false;
        if (this.isDetached && this.detachedWindow) {
            this.detachedWindow.panel.style.display = 'none';
        }
        if (this.onVisibilityChange) this.onVisibilityChange();
        this.hideBuiltin();
    }

    showBuiltin(): void {
        if (!this.builtin) return;
        if (this.profiler && this.profiler.builtinTabsContainer) {
            this.profiler.builtinTabsContainer.style.display = '';
        }
        if (this.builtinButton) this.builtinButton.style.display = '';
        if (this.miniContent && this.profiler) {
            this.profiler.miniPanel.querySelectorAll('.mini-panel-content').forEach((c: Element) => {
                (c as HTMLElement).style.display = 'none';
            });
            this.profiler.builtinTabsContainer.querySelectorAll('.builtin-tab-btn').forEach((btn: Element) => {
                btn.classList.remove('active');
            });
            if (this.builtinButton) this.builtinButton.classList.add('active');
            if (!this.miniContent.firstChild) {
                const actualContent = this.content.querySelector('.list-scroll-wrapper') || this.content.firstElementChild;
                if (actualContent) this.miniContent.appendChild(actualContent);
            }
            this.miniContent.style.display = 'block';
            this.profiler.miniPanel.classList.add('visible');
        }
    }

    hideBuiltin(): void {
        if (!this.builtin) return;
        if (this.builtinButton) this.builtinButton.style.display = 'none';
        if (this.miniContent) {
            this.miniContent.style.display = 'none';
            if (this.miniContent.firstChild) {
                this.content.appendChild(this.miniContent.firstChild);
            }
        }
        if (this.builtinButton) this.builtinButton.classList.remove('active');
        if (this.profiler) {
            const hasVisible = Array.from(this.profiler.miniPanel.querySelectorAll('.mini-panel-content'))
                .some(c => (c as HTMLElement).style.display !== 'none');
            if (!hasVisible) this.profiler.miniPanel.classList.remove('visible');
            const hasVisibleBtns = Array.from(this.profiler.builtinTabsContainer.querySelectorAll('.builtin-tab-btn'))
                .some(btn => (btn as HTMLElement).style.display !== 'none');
            if (!hasVisibleBtns) this.profiler.builtinTabsContainer.style.display = 'none';
        }
    }
}
