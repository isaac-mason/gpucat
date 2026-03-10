import type { GUI } from './GUI';
import { Controller } from './Controller';

export class NumberController extends Controller<number> {

	$input: HTMLInputElement;
	$slider: HTMLDivElement | undefined;
	$fill: HTMLDivElement | undefined;

	_min: number | undefined;
	_max: number | undefined;
	_step = 0.1;
	_stepExplicit = false;
	_decimals: number | undefined;
	_hasSlider = false;
	_inputFocused = false;

	constructor(parent: GUI, object: object, property: string, min?: number, max?: number, step?: number) {
		super(parent, object, property, 'gui-number');

		this.$input = document.createElement('input');
		this.$input.setAttribute('type', 'text');
		this.$input.setAttribute('aria-labelledby', this.$name.id);

		if (window.matchMedia('(pointer: coarse)').matches) {
			this.$input.setAttribute('type', 'number');
			this.$input.setAttribute('step', 'any');
		}

		this.$widget.appendChild(this.$input);
		this.$disable = this.$input;

		this._initInputHandlers();

		this.min(min!);
		this.max(max!);

		const stepExplicit = step !== undefined;
		this.step(stepExplicit ? step! : this._getImplicitStep(), stepExplicit);

		this.updateDisplay();
	}

	min(min: number): this {
		this._min = min;
		this._onUpdateMinMax();
		return this;
	}

	max(max: number): this {
		this._max = max;
		this._onUpdateMinMax();
		return this;
	}

	step(step: number, explicit = true): this {
		this._step = step;
		this._stepExplicit = explicit;
		return this;
	}

	decimals(decimals: number): this {
		this._decimals = decimals;
		this.updateDisplay();
		return this;
	}

	updateDisplay(): this {
		const value = this.getValue();
		if (this._hasSlider && this.$fill) {
			let percent = (value - this._min!) / (this._max! - this._min!);
			percent = Math.max(0, Math.min(percent, 1));
			this.$fill.style.width = percent * 100 + '%';
		}
		if (!this._inputFocused) {
			this.$input.value = this._decimals === undefined ? String(value) : value.toFixed(this._decimals);
		}
		return this;
	}

	private _initInputHandlers(): void {
		const onInput = () => {
			const value = parseFloat(this.$input.value);
			if (isNaN(value)) return;
			this.setValue(this._clamp(this._stepExplicit ? this._snap(value) : value));
		};

		const increment = (delta: number) => {
			const value = parseFloat(this.$input.value);
			if (isNaN(value)) return;
			this._snapClampSetValue(value + delta);
			this.$input.value = String(this.getValue());
		};

		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Enter') this.$input.blur();
			if (e.code === 'ArrowUp') { e.preventDefault(); increment(this._step * this._arrowKeyMultiplier(e)); }
			if (e.code === 'ArrowDown') { e.preventDefault(); increment(this._step * this._arrowKeyMultiplier(e) * -1); }
		};

		const onWheel = (e: WheelEvent) => {
			if (this._inputFocused) {
				e.preventDefault();
				increment(this._step * this._normalizeMouseWheel(e));
			}
		};

		let testingForVerticalDrag = false;
		let initClientX = 0, initClientY = 0, prevClientY = 0, initValue = 0, dragDelta = 0;
		const DRAG_THRESH = 5;

		const onMouseDown = (e: MouseEvent) => {
			initClientX = e.clientX;
			initClientY = prevClientY = e.clientY;
			testingForVerticalDrag = true;
			initValue = this.getValue();
			dragDelta = 0;
			window.addEventListener('mousemove', onMouseMove);
			window.addEventListener('mouseup', onMouseUp);
		};

		const onMouseMove = (e: MouseEvent) => {
			if (testingForVerticalDrag) {
				const dx = e.clientX - initClientX;
				const dy = e.clientY - initClientY;
				if (Math.abs(dy) > DRAG_THRESH) {
					e.preventDefault();
					this.$input.blur();
					testingForVerticalDrag = false;
					this._setDraggingStyle(true, 'vertical');
				} else if (Math.abs(dx) > DRAG_THRESH) {
					onMouseUp();
				}
			}
			if (!testingForVerticalDrag) {
				const dy = e.clientY - prevClientY;
				dragDelta -= dy * this._step * this._arrowKeyMultiplier(e);
				if (this._max !== undefined && initValue + dragDelta > this._max) dragDelta = this._max - initValue;
				if (this._min !== undefined && initValue + dragDelta < this._min) dragDelta = this._min - initValue;
				this._snapClampSetValue(initValue + dragDelta);
			}
			prevClientY = e.clientY;
		};

		const onMouseUp = () => {
			this._setDraggingStyle(false, 'vertical');
			this._callOnFinishChange();
			window.removeEventListener('mousemove', onMouseMove);
			window.removeEventListener('mouseup', onMouseUp);
		};

		const onFocus = () => { this._inputFocused = true; };
		const onBlur = () => {
			this._inputFocused = false;
			this.updateDisplay();
			this._callOnFinishChange();
		};

		this.$input.addEventListener('input', onInput);
		this.$input.addEventListener('keydown', onKeyDown);
		this.$input.addEventListener('wheel', onWheel, { passive: false });
		this.$input.addEventListener('mousedown', onMouseDown);
		this.$input.addEventListener('focus', onFocus);
		this.$input.addEventListener('blur', onBlur);
	}

	private _initSlider(): void {
		this._hasSlider = true;

		this.$slider = document.createElement('div');
		this.$slider.classList.add('gui-slider');

		this.$fill = document.createElement('div');
		this.$fill.classList.add('gui-fill');

		this.$slider.appendChild(this.$fill);
		this.$widget.insertBefore(this.$slider, this.$input);
		this.domElement.classList.add('gui-has-slider');

		const map = (v: number, a: number, b: number, c: number, d: number) => (v - a) / (b - a) * (d - c) + c;

		const setValueFromX = (clientX: number) => {
			const rect = this.$slider!.getBoundingClientRect();
			const value = map(clientX, rect.left, rect.right, this._min!, this._max!);
			this._snapClampSetValue(value);
		};

		const mouseDown = (e: MouseEvent) => {
			this._setDraggingStyle(true);
			setValueFromX(e.clientX);
			window.addEventListener('mousemove', mouseMove);
			window.addEventListener('mouseup', mouseUp);
		};
		const mouseMove = (e: MouseEvent) => setValueFromX(e.clientX);
		const mouseUp = () => {
			this._callOnFinishChange();
			this._setDraggingStyle(false);
			window.removeEventListener('mousemove', mouseMove);
			window.removeEventListener('mouseup', mouseUp);
		};

		let testingForScroll = false, prevClientX = 0, prevClientY = 0;

		const beginTouchDrag = (e: TouchEvent) => {
			e.preventDefault();
			this._setDraggingStyle(true);
			setValueFromX(e.touches[0].clientX);
			testingForScroll = false;
		};

		const onTouchStart = (e: TouchEvent) => {
			if (e.touches.length > 1) return;
			if (this._hasScrollBar) {
				prevClientX = e.touches[0].clientX;
				prevClientY = e.touches[0].clientY;
				testingForScroll = true;
			} else {
				beginTouchDrag(e);
			}
			window.addEventListener('touchmove', onTouchMove, { passive: false });
			window.addEventListener('touchend', onTouchEnd);
		};

		const onTouchMove = (e: TouchEvent) => {
			if (testingForScroll) {
				const dx = e.touches[0].clientX - prevClientX;
				const dy = e.touches[0].clientY - prevClientY;
				if (Math.abs(dx) > Math.abs(dy)) {
					beginTouchDrag(e);
				} else {
					window.removeEventListener('touchmove', onTouchMove);
					window.removeEventListener('touchend', onTouchEnd);
				}
			} else {
				e.preventDefault();
				setValueFromX(e.touches[0].clientX);
			}
		};

		const onTouchEnd = () => {
			this._callOnFinishChange();
			this._setDraggingStyle(false);
			window.removeEventListener('touchmove', onTouchMove);
			window.removeEventListener('touchend', onTouchEnd);
		};

		let wheelFinishChangeTimeout: ReturnType<typeof setTimeout>;
		const callOnFinishChange = this._callOnFinishChange.bind(this);
		const WHEEL_DEBOUNCE_TIME = 400;

		const onWheel = (e: WheelEvent) => {
			const isVertical = Math.abs(e.deltaX) < Math.abs(e.deltaY);
			if (isVertical && this._hasScrollBar) return;
			e.preventDefault();
			const delta = this._normalizeMouseWheel(e) * this._step;
			this._snapClampSetValue(this.getValue() + delta);
			this.$input.value = String(this.getValue());
			clearTimeout(wheelFinishChangeTimeout);
			wheelFinishChangeTimeout = setTimeout(callOnFinishChange, WHEEL_DEBOUNCE_TIME);
		};

		this.$slider.addEventListener('mousedown', mouseDown);
		this.$slider.addEventListener('touchstart', onTouchStart, { passive: false });
		this.$slider.addEventListener('wheel', onWheel, { passive: false });
	}

	private _setDraggingStyle(active: boolean, axis: 'horizontal' | 'vertical' = 'horizontal'): void {
		if (this.$slider) this.$slider.classList.toggle('gui-active', active);
		document.body.classList.toggle('gui-dragging', active);
		document.body.classList.toggle(`gui-${axis}`, active);
	}

	private _getImplicitStep(): number {
		if (this._hasMin && this._hasMax) {
			return (this._max! - this._min!) / 1000;
		}
		return 0.1;
	}

	private _onUpdateMinMax(): void {
		if (!this._hasSlider && this._hasMin && this._hasMax) {
			if (!this._stepExplicit) {
				this.step(this._getImplicitStep(), false);
			}
			this._initSlider();
			this.updateDisplay();
		}
	}

	private _normalizeMouseWheel(e: WheelEvent): number {
		let { deltaX, deltaY } = e;
		const wheelEvent = e as WheelEvent & { wheelDelta?: number };
		if (Math.floor(e.deltaY) !== e.deltaY && wheelEvent.wheelDelta) {
			deltaX = 0;
			deltaY = -wheelEvent.wheelDelta / 120;
			deltaY *= this._stepExplicit ? 1 : 10;
		}
		return deltaX + -deltaY;
	}

	private _arrowKeyMultiplier(e: KeyboardEvent | MouseEvent): number {
		let mult = this._stepExplicit ? 1 : 10;
		if (e.shiftKey) mult *= 10;
		else if (e.altKey) mult /= 10;
		return mult;
	}

	private _snap(value: number): number {
		let offset = 0;
		if (this._hasMin) offset = this._min!;
		else if (this._hasMax) offset = this._max!;
		value -= offset;
		value = Math.round(value / this._step) * this._step;
		value += offset;
		return parseFloat(value.toPrecision(15));
	}

	private _clamp(value: number): number {
		if (this._min !== undefined && value < this._min) value = this._min;
		if (this._max !== undefined && value > this._max) value = this._max;
		return value;
	}

	private _snapClampSetValue(value: number): void {
		this.setValue(this._clamp(this._snap(value)));
	}

	private get _hasScrollBar(): boolean {
		const root = this.parent.root.$children;
		return root.scrollHeight > root.clientHeight;
	}

	private get _hasMin(): boolean {
		return this._min !== undefined;
	}

	private get _hasMax(): boolean {
		return this._max !== undefined;
	}

}
