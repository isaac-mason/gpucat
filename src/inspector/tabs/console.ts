import { Tab } from '../ui/tab';

export class Console extends Tab {

    filters: { info: boolean; warn: boolean; error: boolean };
    filterText: string;
    logContainer: HTMLDivElement;

    constructor(options: { name?: string; allowDetach?: boolean } = {}) {
        super('Console', options);

        this.filters = { info: true, warn: true, error: true };
        this.filterText = '';

        this._buildHeader();

        this.logContainer = document.createElement('div');
        this.logContainer.id = 'console-log';
        this.content.appendChild(this.logContainer);
    }

    private _buildHeader(): void {
        const header = document.createElement('div');
        header.className = 'console-header';

        const filterInput = document.createElement('input');
        filterInput.type = 'text';
        filterInput.className = 'console-filter-input';
        filterInput.placeholder = 'Filter...';
        filterInput.addEventListener('input', (e) => {
            this.filterText = (e.target as HTMLInputElement).value.toLowerCase();
            this.applyFilters();
        });

        const copyButton = document.createElement('button');
        copyButton.className = 'console-copy-button';
        copyButton.title = 'Copy all';
        copyButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
        copyButton.addEventListener('click', () => this.copyAll(copyButton));

        const buttonsGroup = document.createElement('div');
        buttonsGroup.className = 'console-buttons-group';

        (Object.keys(this.filters) as Array<keyof typeof this.filters>).forEach(type => {
            const label = document.createElement('label');
            label.className = 'custom-checkbox';
            label.style.color = `var(--${type === 'info' ? 'text-primary' : 'color-' + (type === 'warn' ? 'yellow' : 'red')})`;

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = this.filters[type];
            checkbox.dataset.type = type;

            const checkmark = document.createElement('span');
            checkmark.className = 'checkmark';

            label.appendChild(checkbox);
            label.appendChild(checkmark);
            label.append(type.charAt(0).toUpperCase() + type.slice(1));
            buttonsGroup.appendChild(label);
        });

        buttonsGroup.addEventListener('change', (e) => {
            const target = e.target as HTMLInputElement;
            const type = target.dataset.type as keyof typeof this.filters;
            if (type in this.filters) {
                this.filters[type] = target.checked;
                this.applyFilters();
            }
        });

        buttonsGroup.appendChild(copyButton);

        header.appendChild(filterInput);
        header.appendChild(buttonsGroup);
        this.content.appendChild(header);
    }

    applyFilters(): void {
        const messages = this.logContainer.querySelectorAll<HTMLElement>('.log-message');
        messages.forEach(msg => {
            const type = msg.dataset.type as keyof typeof this.filters;
            const text = (msg.dataset.rawText ?? '').toLowerCase();
            const showByType = this.filters[type];
            const showByText = text.includes(this.filterText);
            msg.classList.toggle('hidden', !(showByType && showByText));
        });
    }

    copyAll(button: HTMLButtonElement): void {
        const win = this.logContainer.ownerDocument.defaultView;
        const selection = win?.getSelection();
        const selectedText = selection?.toString() ?? '';
        const textInConsole = selectedText && this.logContainer.contains(selection?.anchorNode ?? null);

        let text: string;
        if (textInConsole) {
            text = selectedText;
        } else {
            const messages = this.logContainer.querySelectorAll<HTMLElement>('.log-message:not(.hidden)');
            text = Array.from(messages).map(msg => msg.dataset.rawText ?? '').join('\n');
        }

        navigator.clipboard.writeText(text);

        button.classList.add('copied');
        setTimeout(() => button.classList.remove('copied'), 350);
    }

    private _getIcon(type: string, subType: string): string {
        if (subType === 'tip')              return '\u{1F4AD}';
        if (subType === 'tsl')              return '\u2728';
        if (subType === 'webgpurenderer')   return '\u{1F3A8}';
        if (type === 'warn')                return '\u26A0\uFE0F';
        if (type === 'error')               return '\u{1F534}';
        return '\u2139\uFE0F';
    }

    private _formatMessage(type: string, text: string): DocumentFragment {
        const fragment = document.createDocumentFragment();
        const prefixMatch = text.match(/^([\w\.]+:\s)/);
        let content = text;

        if (prefixMatch) {
            const fullPrefix = prefixMatch[0];
            const parts = fullPrefix.slice(0, -2).split('.');
            const shortPrefix = (parts.length > 1 ? parts[parts.length - 1] : parts[0]) + ':';
            const icon = this._getIcon(type, shortPrefix.split(':')[0].toLowerCase());
            fragment.appendChild(document.createTextNode(icon + ' '));
            const prefixSpan = document.createElement('span');
            prefixSpan.className = 'log-prefix';
            prefixSpan.textContent = shortPrefix;
            fragment.appendChild(prefixSpan);
            content = text.substring(fullPrefix.length);
        }

        const parts = content.split(/(".*?"|'.*?'|`.*?`)/g).map(p => p.trim()).filter(Boolean);
        parts.forEach((part, index) => {
            if (/^("|'|`)/.test(part)) {
                const codeSpan = document.createElement('span');
                codeSpan.className = 'log-code';
                codeSpan.textContent = part.slice(1, -1);
                fragment.appendChild(codeSpan);
            } else {
                let p = part;
                if (index > 0) p = ' ' + p;
                if (index < parts.length - 1) p += ' ';
                fragment.appendChild(document.createTextNode(p));
            }
        });

        return fragment;
    }

    addMessage(type: string, text: string): void {
        const msg = document.createElement('div');
        msg.className = `log-message ${type}`;
        msg.dataset.type = type;
        msg.dataset.rawText = text;

        msg.appendChild(this._formatMessage(type, text));

        const showByType = this.filters[type as keyof typeof this.filters] ?? true;
        const showByText = text.toLowerCase().includes(this.filterText);
        msg.classList.toggle('hidden', !(showByType && showByText));

        this.logContainer.appendChild(msg);
        this.logContainer.scrollTop = this.logContainer.scrollHeight;
        if (this.logContainer.children.length > 200) {
            this.logContainer.removeChild(this.logContainer.firstChild!);
        }
    }
}
