import type { GUI } from './GUI';
import { Controller } from './Controller';

export class FunctionController extends Controller<() => void> {

	$button: HTMLButtonElement;

	constructor(parent: GUI, object: object, property: string) {
		super(parent, object, property, 'gui-function');

		this.$button = document.createElement('button');
		this.$button.appendChild(this.$name);
		this.$widget.appendChild(this.$button);

		this.$button.addEventListener('click', (e) => {
			e.preventDefault();
			this.getValue().call(this.object);
			this._callOnChange();
		});

		this.$button.addEventListener('touchstart', () => {}, { passive: true });

		this.$disable = this.$button;
	}

}
