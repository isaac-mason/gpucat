import { Parameters } from './parameters';

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function loadState(): { showFPS: boolean } {
    try {
        const data = JSON.parse(localStorage.getItem('gpucat-inspector') || '{}');
        const settings = data.settings || {};
        return { showFPS: settings.showFPS ?? true };
    } catch {
        return { showFPS: true };
    }
}

function saveState(state: { showFPS: boolean }): void {
    try {
        const data = JSON.parse(localStorage.getItem('gpucat-inspector') || '{}');
        data.settings = state;
        localStorage.setItem('gpucat-inspector', JSON.stringify(data));
    } catch (e) {
        console.error('Failed to save settings:', e);
    }
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

export class Settings extends Parameters {

    constructor() {
        super({ name: 'Settings' });

        const state = loadState();

        const generalGroup = this.createGroup('General');

        generalGroup.add(state, 'showFPS').onChange(() => {
            saveState(state);
        });
    }
}
