import type { GUI } from './GUI';
import { Controller } from './Controller';

export class StringController extends Controller<string> {

	$input: HTMLInputElement;

	constructor(parent: GUI, object: object, property: string) {
		super(parent, object, property, 'gui-string');

		this.$input = document.createElement('input');
		this.$input.setAttribute('type', 'text');
		this.$input.setAttribute('aria-labelledby', this.$name.id);

		this.$widget.appendChild(this.$input);
		this.$disable = this.$input;

		this.$input.addEventListener('input', () => {
			this.setValue(this.$input.value);
		});

		this.$input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') this.$input.blur();
		});

		this.$input.addEventListener('blur', () => {
			this._callOnFinishChange();
		});

		this.updateDisplay();
	}

	updateDisplay(): this {
		this.$input.value = this.getValue();
		return this;
	}

}
