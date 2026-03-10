import type { GUI } from './GUI';
import { Controller } from './Controller';

type ColorValue = string | number | { r: number; g: number; b: number } | [number, number, number];

function isColorObject(v: unknown): v is { r: number; g: number; b: number } {
	return typeof v === 'object' && v !== null && 'r' in v && 'g' in v && 'b' in v;
}

function isColorArray(v: unknown): v is [number, number, number] {
	return Array.isArray(v) && v.length === 3;
}

function toHexString(value: ColorValue, rgbScale: number): string {
	if (typeof value === 'number') {
		return '#' + value.toString(16).padStart(6, '0');
	}
	if (typeof value === 'string') {
		if (value.startsWith('#') && value.length === 7) return value;
		if (value.startsWith('#') && value.length === 4) {
			return '#' + value[1] + value[1] + value[2] + value[2] + value[3] + value[3];
		}
		const m = value.match(/rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
		if (m) {
			return '#' + [m[1], m[2], m[3]].map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
		}
		return value;
	}
	if (isColorObject(value)) {
		const r = Math.round((value.r / rgbScale) * 255);
		const g = Math.round((value.g / rgbScale) * 255);
		const b = Math.round((value.b / rgbScale) * 255);
		return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
	}
	if (isColorArray(value)) {
		const [r, g, b] = value.map(c => Math.round((c / rgbScale) * 255));
		return '#' + [r, g, b].map(n => n!.toString(16).padStart(2, '0')).join('');
	}
	return '#ffffff';
}

function fromHexString(hex: string, target: ColorValue, rgbScale: number): ColorValue {
	if (typeof target === 'number') {
		return parseInt(hex.slice(1), 16);
	}
	if (typeof target === 'string') {
		return hex;
	}
	const r = parseInt(hex.slice(1, 3), 16) / 255 * rgbScale;
	const g = parseInt(hex.slice(3, 5), 16) / 255 * rgbScale;
	const b = parseInt(hex.slice(5, 7), 16) / 255 * rgbScale;
	if (isColorObject(target)) {
		target.r = r;
		target.g = g;
		target.b = b;
		return target;
	}
	if (isColorArray(target)) {
		target[0] = r;
		target[1] = g;
		target[2] = b;
		return target;
	}
	return hex;
}

export class ColorController extends Controller<ColorValue> {

	$input: HTMLInputElement;
	$text: HTMLInputElement;
	$display: HTMLDivElement;

	_rgbScale: number;
	_initialValueHexString: string;
	_textFocused = false;

	constructor(parent: GUI, object: object, property: string, rgbScale = 1) {
		super(parent, object, property, 'gui-color');

		this._rgbScale = rgbScale;

		this.$display = document.createElement('div');
		this.$display.classList.add('gui-color-display');

		this.$input = document.createElement('input');
		this.$input.setAttribute('type', 'color');
		this.$input.setAttribute('tabindex', '-1');
		this.$input.setAttribute('aria-labelledby', this.$name.id);

		this.$text = document.createElement('input');
		this.$text.setAttribute('type', 'text');
		this.$text.setAttribute('spellcheck', 'false');
		this.$text.setAttribute('aria-labelledby', this.$name.id);

		this.$display.appendChild(this.$input);
		this.$widget.appendChild(this.$display);
		this.$widget.appendChild(this.$text);

		this.$disable = this.$text;

		this._initialValueHexString = this.save() as string;

		this.$input.addEventListener('input', () => {
			this._setValueFromHexString(this.$input.value);
		});

		this.$input.addEventListener('blur', () => {
			this._callOnFinishChange();
		});

		this.$text.addEventListener('input', () => {
			const normalized = this._tryNormalizeColorString(this.$text.value);
			if (normalized) this._setValueFromHexString(normalized);
		});

		this.$text.addEventListener('focus', () => {
			this._textFocused = true;
			this.$text.select();
		});

		this.$text.addEventListener('blur', () => {
			this._textFocused = false;
			this.updateDisplay();
			this._callOnFinishChange();
		});

		this.updateDisplay();
	}

	reset(): this {
		this._setValueFromHexString(this._initialValueHexString);
		return this;
	}

	save(): unknown {
		return toHexString(this.getValue(), this._rgbScale);
	}

	load(value: ColorValue): this {
		this._setValueFromHexString(toHexString(value, this._rgbScale));
		this._callOnFinishChange();
		return this;
	}

	updateDisplay(): this {
		const hex = toHexString(this.getValue(), this._rgbScale);
		this.$input.value = hex;
		if (!this._textFocused) {
			this.$text.value = hex.substring(1);
		}
		this.$display.style.backgroundColor = hex;
		return this;
	}

	private _setValueFromHexString(hex: string): void {
		const current = this.getValue();
		if (typeof current === 'string' || typeof current === 'number') {
			const newValue = fromHexString(hex, current, this._rgbScale);
			if (newValue !== current) {
				(this.object as Record<string, unknown>)[this.property] = newValue;
				this._callOnChange();
				this.updateDisplay();
			}
		} else {
			// Mutates in place for objects/arrays, so always fire change
			fromHexString(hex, current, this._rgbScale);
			this._callOnChange();
			this.updateDisplay();
		}
	}

	private _tryNormalizeColorString(str: string): string | null {
		str = str.trim();
		if (/^#?[0-9a-fA-F]{6}$/.test(str)) {
			return str.startsWith('#') ? str : '#' + str;
		}
		if (/^#?[0-9a-fA-F]{3}$/.test(str)) {
			const s = str.replace('#', '');
			return '#' + s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
		}
		const m = str.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
		if (m) {
			return '#' + [m[1], m[2], m[3]].map(n => parseInt(n!).toString(16).padStart(2, '0')).join('');
		}
		return null;
	}

}
