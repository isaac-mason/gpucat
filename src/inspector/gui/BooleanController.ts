import type { GUI } from './GUI';
import { Controller } from './Controller';

export class BooleanController extends Controller<boolean> {

	$input: HTMLInputElement;

	constructor(parent: GUI, object: object, property: string) {
		super(parent, object, property, 'gui-boolean', 'label');

		this.$input = document.createElement('input');
		this.$input.setAttribute('type', 'checkbox');
		this.$input.setAttribute('aria-labelledby', this.$name.id);

		const $checkmark = document.createElement('span');
		$checkmark.classList.add('gui-checkmark');

		this.$widget.appendChild(this.$input);
		this.$widget.appendChild($checkmark);
		this.$disable = this.$input;

		this.$input.addEventListener('change', () => {
			this.setValue(this.$input.checked);
			this._callOnFinishChange();
		});

		this.updateDisplay();
	}

	updateDisplay(): this {
		this.$input.checked = this.getValue();
		return this;
	}

}
