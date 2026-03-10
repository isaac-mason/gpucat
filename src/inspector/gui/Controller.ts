import type { GUI } from './GUI';

export interface ChangeEvent<T = unknown> {
	object: object;
	property: string;
	value: T;
	controller: Controller<T>;
}

export class Controller<T = unknown> {

	parent: GUI;
	object: object;
	property: string;
	initialValue: T;

	domElement: HTMLElement;
	$name: HTMLElement;
	$widget: HTMLElement;
	$disable: HTMLElement;

	_disabled = false;
	_hidden = false;
	_listening = false;
	_name: string;
	_onChange: ((value: unknown) => void) | undefined;
	_onFinishChange: ((value: unknown) => void) | undefined;
	_changed = false;

	private _listenCallbackID: number | undefined;
	private _listenPrevValue: unknown;

	constructor(parent: GUI, object: object, property: string, className: string, elementType: 'div' | 'label' = 'div') {
		this.parent = parent;
		this.object = object;
		this.property = property;
		this.initialValue = this.getValue();

		this.domElement = document.createElement(elementType);
		this.domElement.classList.add('gui-controller', className);

		this.$name = document.createElement('div');
		this.$name.classList.add('gui-name');

		this.$widget = document.createElement('div');
		this.$widget.classList.add('gui-widget');

		this.$disable = this.$widget;

		this.domElement.appendChild(this.$name);
		this.domElement.appendChild(this.$widget);

		this.domElement.addEventListener('keydown', e => e.stopPropagation());
		this.domElement.addEventListener('keyup', e => e.stopPropagation());

		this.parent.children.push(this);
		this.parent.controllers.push(this);
		this.parent.$children.appendChild(this.domElement);

		this._listenCallback = this._listenCallback.bind(this);

		this._name = property;
		this.name(property);
	}

	name(name: string): this {
		this._name = name;
		this.$name.textContent = name;
		return this;
	}

	onChange(callback: (value: T) => void): this {
		this._onChange = callback as (value: unknown) => void;
		return this;
	}

	_callOnChange(): void {
		this.parent._callOnChange(this as Controller<unknown>);
		if (this._onChange !== undefined) {
			this._onChange.call(this, this.getValue());
		}
		this._changed = true;
	}

	onFinishChange(callback: (value: T) => void): this {
		this._onFinishChange = callback as (value: unknown) => void;
		return this;
	}

	_callOnFinishChange(): void {
		if (this._changed) {
			this.parent._callOnFinishChange(this as Controller<unknown>);
			if (this._onFinishChange !== undefined) {
				this._onFinishChange.call(this, this.getValue());
			}
		}
		this._changed = false;
	}

	reset(): this {
		this.setValue(this.initialValue);
		this._callOnFinishChange();
		return this;
	}

	enable(enabled = true): this {
		return this.disable(!enabled);
	}

	disable(disabled = true): this {
		if (disabled === this._disabled) return this;
		this._disabled = disabled;
		this.domElement.classList.toggle('gui-disabled', disabled);
		this.$disable.toggleAttribute('disabled', disabled);
		return this;
	}

	show(show = true): this {
		this._hidden = !show;
		this.domElement.style.display = this._hidden ? 'none' : '';
		return this;
	}

	hide(): this {
		return this.show(false);
	}

	// No-ops on base — overridden in NumberController
	min(_min: number): this { return this; }
	max(_max: number): this { return this; }
	step(_step: number): this { return this; }
	decimals(_decimals: number): this { return this; }

	listen(listen = true): this {
		this._listening = listen;
		if (this._listenCallbackID !== undefined) {
			cancelAnimationFrame(this._listenCallbackID);
			this._listenCallbackID = undefined;
		}
		if (this._listening) {
			this._listenCallback();
		}
		return this;
	}

	private _listenCallback(): void {
		this._listenCallbackID = requestAnimationFrame(this._listenCallback);
		const curValue = this.save();
		if (curValue !== this._listenPrevValue) {
			this.updateDisplay();
		}
		this._listenPrevValue = curValue;
	}

	getValue(): T {
		return (this.object as Record<string, unknown>)[this.property] as T;
	}

	setValue(value: T): this {
		if (this.getValue() !== value) {
			(this.object as Record<string, unknown>)[this.property] = value;
			this._callOnChange();
			this.updateDisplay();
		}
		return this;
	}

	updateDisplay(): this {
		return this;
	}

	save(): unknown {
		return this.getValue();
	}

	load(value: T): this {
		this.setValue(value);
		this._callOnFinishChange();
		return this;
	}

	destroy(): void {
		this.listen(false);
		this.parent.children.splice(this.parent.children.indexOf(this), 1);
		this.parent.controllers.splice(this.parent.controllers.indexOf(this as Controller<unknown>), 1);
		this.parent.$children.removeChild(this.domElement);
	}

}
