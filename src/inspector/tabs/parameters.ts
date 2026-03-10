import { Tab, type TabOptions } from '../ui/tab';
import { GUI } from '../gui/GUI';

export class Parameters extends Tab {

	private _container: HTMLElement;

	constructor(options: TabOptions = {}) {
		super(options.name || 'Parameters', options);

		const container = document.createElement('div');
		container.className = 'gui-parameters-container';
		this.content.appendChild(container);

		this._container = container;
	}

	createGroup(name: string): GUI {
		const gui = new GUI({ title: name });
		this._container.appendChild(gui.domElement);
		return gui;
	}
}
