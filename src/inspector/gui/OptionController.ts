import type { GUI } from './GUI';
import { Controller } from './Controller';

export class OptionController<T = unknown> extends Controller<T> {

	$select: HTMLSelectElement;
	$display: HTMLDivElement;

	_values: T[] = [];
	_names: string[] = [];

	constructor(parent: GUI, object: object, property: string, options: T[] | Record<string, T>) {
		super(parent, object, property, 'gui-option');

		this.$select = document.createElement('select');
		this.$select.setAttribute('aria-labelledby', this.$name.id);

		this.$display = document.createElement('div');
		this.$display.classList.add('gui-display');

		this.$select.addEventListener('change', () => {
			this.setValue(this._values[this.$select.selectedIndex]!);
			this._callOnFinishChange();
		});

		this.$select.addEventListener('focus', () => {
			this.$display.classList.add('gui-focus');
		});

		this.$select.addEventListener('blur', () => {
			this.$display.classList.remove('gui-focus');
		});

		this.$widget.appendChild(this.$select);
		this.$widget.appendChild(this.$display);
		this.$disable = this.$select;

		this.options(options);
	}

	options(options: T[] | Record<string, T>): this {
		this._values = Array.isArray(options) ? options : Object.values(options);
		this._names = Array.isArray(options) ? options.map(String) : Object.keys(options);

		this.$select.replaceChildren();
		this._names.forEach(name => {
			const $option = document.createElement('option');
			$option.textContent = name;
			this.$select.appendChild($option);
		});

		this.updateDisplay();
		return this;
	}

	updateDisplay(): this {
		const value = this.getValue();
		const index = this._values.indexOf(value);
		this.$select.selectedIndex = index;
		this.$display.textContent = index === -1 ? String(value) : this._names[index]!;
		return this;
	}

}
