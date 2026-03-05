class Value extends EventTarget {

	domElement: HTMLDivElement;
	_onChangeFunction: ((val: unknown) => void) | null;

	constructor() {
		super();

		this.domElement = document.createElement('div');
		this.domElement.className = 'param-control';

		this._onChangeFunction = null;

		this.addEventListener('change', (e) => {
			requestAnimationFrame(() => {
				if (this._onChangeFunction) this._onChangeFunction((e as CustomEvent).detail.value);
			});
		});
	}

	setValue(_val: unknown): this {
		this.dispatchChange();
		return this;
	}

	getValue(): unknown {
		return null;
	}

	dispatchChange(): void {
		this.dispatchEvent(new CustomEvent('change', { detail: { value: this.getValue() } }));
	}

	onChange(callback: (val: unknown) => void): this {
		this._onChangeFunction = callback;
		return this;
	}

}

class ValueNumber extends Value {

	input: HTMLInputElement;

	constructor({ value = 0, step = 0.1, min = -Infinity, max = Infinity }: { value?: number; step?: number; min?: number; max?: number } = {}) {
		super();

		this.input = document.createElement('input');
		this.input.type = 'number';
		this.input.value = String(value);
		this.input.step = String(step);
		this.input.min = isFinite(min) ? String(min) : '';
		this.input.max = isFinite(max) ? String(max) : '';
		this.input.addEventListener('change', this._onChangeValue.bind(this));
		this.domElement.appendChild(this.input);
		this.addDragHandler();
	}

	_onChangeValue(): void {
		const value = parseFloat(this.input.value);
		const min = parseFloat(this.input.min);
		const max = parseFloat(this.input.max);

		if (value > max) {
			this.input.value = String(max);
		} else if (value < min) {
			this.input.value = String(min);
		} else if (isNaN(value)) {
			this.input.value = String(min);
		}

		this.dispatchChange();
	}

	addDragHandler(): void {
		let isDragging = false;
		let startY = 0, startValue = 0;

		this.input.addEventListener('mousedown', (e) => {
			isDragging = true;
			startY = e.clientY;
			startValue = parseFloat(this.input.value);
			document.body.style.cursor = 'ns-resize';
		});

		document.addEventListener('mousemove', (e) => {
			if (isDragging) {
				const deltaY = startY - e.clientY;
				const step = parseFloat(this.input.step) || 1;
				const min = parseFloat(this.input.min);
				const max = parseFloat(this.input.max);

				let stepSize = step;
				if (!isNaN(max) && isFinite(min)) {
					stepSize = (max - min) / 100;
				}

				const change = deltaY * stepSize;
				let newValue = startValue + change;
				newValue = Math.max(min, Math.min(newValue, max));

				const precision = (String(step).split('.')[1] || []).length;
				this.input.value = newValue.toFixed(precision);
				this.input.dispatchEvent(new Event('input'));
				this.dispatchChange();
			}
		});

		document.addEventListener('mouseup', () => {
			if (isDragging) {
				isDragging = false;
				document.body.style.cursor = 'default';
			}
		});
	}

	setValue(val: unknown): this {
		this.input.value = String(val);
		return super.setValue(val);
	}

	getValue(): number {
		return parseFloat(this.input.value);
	}

}

class ValueCheckbox extends Value {

	checkbox: HTMLInputElement;

	constructor({ value = false }: { value?: boolean } = {}) {
		super();

		const label = document.createElement('label');
		label.className = 'custom-checkbox';

		const checkbox = document.createElement('input');
		checkbox.type = 'checkbox';
		checkbox.checked = value;
		this.checkbox = checkbox;

		const checkmark = document.createElement('span');
		checkmark.className = 'checkmark';

		label.appendChild(checkbox);
		label.appendChild(checkmark);
		this.domElement.appendChild(label);

		checkbox.addEventListener('change', () => {
			this.dispatchChange();
		});
	}

	setValue(val: unknown): this {
		this.checkbox.checked = Boolean(val);
		return super.setValue(val);
	}

	getValue(): boolean {
		return this.checkbox.checked;
	}

}

class ValueSlider extends Value {

	slider: HTMLInputElement;
	numberInput: HTMLInputElement;

	constructor({ value = 0, min = 0, max = 1, step = 0.01 }: { value?: number; min?: number; max?: number; step?: number } = {}) {
		super();

		this.slider = document.createElement('input');
		this.slider.type = 'range';
		this.slider.min = String(min);
		this.slider.max = String(max);
		this.slider.step = String(step);

		const numberValue = new ValueNumber({ value, min, max, step });
		this.numberInput = numberValue.input;
		this.numberInput.style.flexBasis = '80px';
		this.numberInput.style.flexShrink = '0';

		this.slider.value = String(value);

		this.domElement.append(this.slider, this.numberInput);

		this.slider.addEventListener('input', () => {
			this.numberInput.value = this.slider.value;
			this.dispatchChange();
		});

		numberValue.addEventListener('change', (e) => {
			this.slider.value = String(parseFloat((e as CustomEvent<{ value: number }>).detail.value.toString()));
			this.dispatchChange();
		});
	}

	setValue(val: unknown): this {
		this.slider.value = String(val);
		this.numberInput.value = String(val);
		return super.setValue(val);
	}

	getValue(): number {
		return parseFloat(this.slider.value);
	}

	setStep(value: number): this {
		this.slider.step = String(value);
		this.numberInput.step = String(value);
		return this;
	}

}

class ValueSelect extends Value {

	options: string[] | Record<string, unknown>;
	select: HTMLSelectElement;

	constructor({ options = [] as string[], value = '' }: { options?: string[] | Record<string, unknown>; value?: unknown } = {}) {
		super();

		const select = document.createElement('select');

		const createOption = (name: string, optionValue: unknown) => {
			const optionEl = document.createElement('option');
			optionEl.value = name;
			optionEl.textContent = name;
			if (optionValue == value) optionEl.selected = true;
			select.appendChild(optionEl);
			return optionEl;
		};

		if (Array.isArray(options)) {
			options.forEach(opt => createOption(opt, opt));
		} else {
			Object.entries(options).forEach(([key, val]) => createOption(key, val));
		}

		this.domElement.appendChild(select);

		select.addEventListener('change', () => {
			this.dispatchChange();
		});

		this.options = options;
		this.select = select;
	}

	getValue(): unknown {
		const options = this.options;
		if (Array.isArray(options)) {
			return options[this.select.selectedIndex];
		} else {
			return options[this.select.value];
		}
	}

}

class ValueColor extends Value {

	colorInput: HTMLInputElement;
	_value: unknown;

	constructor({ value = '#ffffff' }: { value?: unknown } = {}) {
		super();

		const colorInput = document.createElement('input');
		colorInput.type = 'color';
		colorInput.value = this._getColorHex(value);
		this.colorInput = colorInput;

		this._value = value;

		colorInput.addEventListener('input', () => {
			const colorValue = colorInput.value;
			const v = this._value as { isColor?: boolean; setHex?: (n: number) => void };
			if (v && v.isColor && v.setHex) {
				v.setHex(parseInt(colorValue.slice(1), 16));
			} else {
				this._value = colorValue;
			}
			this.dispatchChange();
		});

		this.domElement.appendChild(colorInput);
	}

	_getColorHex(color: unknown): string {
		const c = color as { isColor?: boolean; getHex?: () => number };
		if (c && c.isColor && c.getHex) {
			return this._getColorHex(c.getHex());
		}
		if (typeof color === 'number') {
			return `#${color.toString(16).padStart(6, '0')}`;
		}
		if (typeof color === 'string') {
			return color[0] !== '#' ? '#' + color : color;
		}
		return '#ffffff';
	}

	getValue(): unknown {
		let value = this._value;
		if (typeof value === 'string') {
			value = parseInt((value as string).slice(1), 16);
		}
		return value;
	}

}

class ValueButton extends Value {

	constructor({ text = 'Button', value = () => {} }: { text?: string; value?: () => void } = {}) {
		super();

		const button = document.createElement('button');
		button.textContent = text;
		button.onclick = value;
		this.domElement.appendChild(button);
	}

}

export { Value, ValueNumber, ValueCheckbox, ValueSlider, ValueSelect, ValueColor, ValueButton };
