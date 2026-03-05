import { Tab, type TabOptions } from '../ui/tab';
import { List } from '../ui/list';
import { Item } from '../ui/item';
import { createValueSpan } from '../ui/utils';
import { ValueNumber, ValueSlider, ValueSelect, ValueCheckbox, ValueColor, ValueButton } from '../ui/values';

class ParametersGroup {

	parameters: Parameters;
	name: string;
	paramList: Item;
	objects: Array<{ object: Record<string, unknown>; key: string; editor: unknown; subItem: Item }>;

	constructor(parameters: Parameters, name: string) {
		this.parameters = parameters;
		this.name = name;
		this.paramList = new Item(name);
		this.objects = [];
	}

	close(): this {
		this.paramList.close();
		return this;
	}

	add(object: Record<string, unknown>, property: string, ...params: unknown[]): unknown {
		const value = object[property];
		const type = typeof value;

		let item = null;

		if (params[0] !== undefined && typeof params[0] === 'object' && params[0] !== null) {
			item = this.addSelect(object, property, params[0] as Record<string, unknown> | string[]);
		} else if (type === 'number') {
			if (params.length >= 2) {
				item = this.addSlider(object, property, params[0] as number, params[1] as number, params[2] as number | undefined);
			} else {
				item = this.addNumber(object, property, params[0] as number | undefined, params[1] as number | undefined);
			}
		} else if (type === 'boolean') {
			item = this.addBoolean(object, property);
		} else if (type === 'function') {
			item = this.addButton(object, property);
		}

		return item;
	}

	_addParameter(object: Record<string, unknown>, property: string, editor: ValueNumber | ValueCheckbox | ValueSlider | ValueSelect | ValueColor | ValueButton, subItem: Item): void {
		const ed = editor as unknown as { name: (n: string) => typeof editor; listen: () => typeof editor; getValue: () => unknown; setValue: (v: unknown) => void };

		ed.name = (name: string) => {
			(subItem.data[0] as HTMLElement).textContent = name;
			return editor;
		};

		ed.listen = () => {
			const update = () => {
				const value = ed.getValue();
				const propertyValue = object[property];
				if (value !== propertyValue) ed.setValue(propertyValue);
				requestAnimationFrame(update);
			};
			requestAnimationFrame(update);
			return editor;
		};

		this._registerParameter(object, property, editor, subItem);
	}

	_registerParameter(object: Record<string, unknown>, property: string, editor: unknown, subItem: Item): void {
		this.objects.push({ object, key: property, editor, subItem });
	}

	addFolder(name: string): ParametersGroup {
		const group = new ParametersGroup(this.parameters, name);
		this.paramList.add(group.paramList);
		return group;
	}

	addBoolean(object: Record<string, unknown>, property: string): ValueCheckbox {
		const value = object[property] as boolean;
		const editor = new ValueCheckbox({ value });
		editor.addEventListener('change', (e) => {
			object[property] = (e as CustomEvent).detail.value;
		});

		const description = createValueSpan();
		description.textContent = property;
		const subItem = new Item(description, editor.domElement);
		this.paramList.add(subItem);

		const itemRow = subItem.domElement.firstChild as HTMLElement;
		itemRow.classList.add('actionable');
		itemRow.addEventListener('click', (e) => {
			if ((e.target as HTMLElement).closest('label')) return;
			const checkbox = itemRow.querySelector('input[type="checkbox"]') as HTMLInputElement;
			if (checkbox) {
				checkbox.checked = !checkbox.checked;
				checkbox.dispatchEvent(new Event('change'));
			}
		});

		this._addParameter(object, property, editor, subItem);
		return editor;
	}

	addSelect(object: Record<string, unknown>, property: string, options: Record<string, unknown> | string[]): ValueSelect {
		const value = object[property];
		const editor = new ValueSelect({ options, value });
		editor.addEventListener('change', (e) => {
			object[property] = (e as CustomEvent).detail.value;
		});

		const description = createValueSpan();
		description.textContent = property;
		const subItem = new Item(description, editor.domElement);
		this.paramList.add(subItem);

		const itemRow = subItem.domElement.firstChild as HTMLElement;
		itemRow.classList.add('actionable');

		this._addParameter(object, property, editor, subItem);
		return editor;
	}

	addColor(object: Record<string, unknown>, property: string): ValueColor {
		const value = object[property];
		const editor = new ValueColor({ value });
		editor.addEventListener('change', (e) => {
			object[property] = (e as CustomEvent).detail.value;
		});

		const description = createValueSpan();
		description.textContent = property;
		const subItem = new Item(description, editor.domElement);
		this.paramList.add(subItem);

		const itemRow = subItem.domElement.firstChild as HTMLElement;
		itemRow.classList.add('actionable');

		this._addParameter(object, property, editor, subItem);
		return editor;
	}

	addSlider(object: Record<string, unknown>, property: string, min = 0, max = 1, step = 0.01): ValueSlider {
		const value = object[property] as number;
		const editor = new ValueSlider({ value, min, max, step });
		editor.addEventListener('change', (e) => {
			object[property] = (e as CustomEvent).detail.value;
		});

		const description = createValueSpan();
		description.textContent = property;
		const subItem = new Item(description, editor.domElement);
		this.paramList.add(subItem);

		const itemRow = subItem.domElement.firstChild as HTMLElement;
		itemRow.classList.add('actionable');

		this._addParameter(object, property, editor, subItem);
		return editor;
	}

	addNumber(object: Record<string, unknown>, property: string, min?: number, max?: number): ValueNumber {
		const value = object[property] as number;
		const editor = new ValueNumber({ value, min, max });
		editor.addEventListener('change', (e) => {
			object[property] = (e as CustomEvent).detail.value;
		});

		const description = createValueSpan();
		description.textContent = property;
		const subItem = new Item(description, editor.domElement);
		this.paramList.add(subItem);

		const itemRow = subItem.domElement.firstChild as HTMLElement;
		itemRow.classList.add('actionable');

		this._addParameter(object, property, editor, subItem);
		return editor;
	}

	addButton(object: Record<string, unknown>, property: string): ValueButton {
		const value = object[property] as () => void;
		const editor = new ValueButton({ text: property, value });
		editor.addEventListener('change', (e) => {
			object[property] = (e as CustomEvent).detail.value;
		});

		const subItem = new Item(editor.domElement);
		(subItem.itemRow.childNodes[0] as HTMLElement).style.gridColumn = '1 / -1';
		this.paramList.add(subItem);

		const itemRow = subItem.domElement.firstChild as HTMLElement;
		itemRow.classList.add('actionable');

		const ed = editor as unknown as { name: (n: string) => ValueButton };
		ed.name = (name: string) => {
			(editor.domElement.childNodes[0] as HTMLElement).textContent = name;
			return editor;
		};

		this._registerParameter(object, property, editor, subItem);
		return editor;
	}
}

export class Parameters extends Tab {

	paramList: List;
	groups: ParametersGroup[];

	constructor(options: TabOptions = {}) {
		super(options.name || 'Parameters', options);

		const paramList = new List('Property', 'Value');
		paramList.domElement.classList.add('parameters');
		paramList.setGridStyle('.5fr 1fr');
		paramList.domElement.style.minWidth = '300px';

		const scrollWrapper = document.createElement('div');
		scrollWrapper.className = 'list-scroll-wrapper';
		scrollWrapper.appendChild(paramList.domElement);
		this.content.appendChild(scrollWrapper);

		this.paramList = paramList;
		this.groups = [];
	}

	createGroup(name: string): ParametersGroup {
		const group = new ParametersGroup(this, name);
		this.paramList.add(group.paramList);
		this.groups.push(group);
		return group;
	}
}
