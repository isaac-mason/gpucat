import { Controller, type ChangeEvent } from './Controller';
import { NumberController } from './NumberController';
import { BooleanController } from './BooleanController';
import { StringController } from './StringController';
import { ColorController } from './ColorController';
import { OptionController } from './OptionController';
import { FunctionController } from './FunctionController';

export interface GUIOptions {
	parent?: GUI;
	title?: string;
	closeFolders?: boolean;
	container?: HTMLElement;
}

// Conditional type: given a value type V, resolve to the right Controller subclass.
type ControllerForType<V> =
	V extends number ? NumberController :
	V extends boolean ? BooleanController :
	V extends string ? StringController :
	V extends (() => void) ? FunctionController :
	Controller<V>;

export class GUI {

	parent: GUI | undefined;
	root: GUI;
	children: Array<GUI | Controller>;
	controllers: Controller[];
	folders: GUI[];

	domElement: HTMLElement;
	$title: HTMLButtonElement;
	$children: HTMLElement;

	_closed = false;
	_hidden = false;
	_title: string;
	_closeFolders: boolean;
	_onChange: ((event: ChangeEvent) => void) | undefined;
	_onFinishChange: ((event: ChangeEvent) => void) | undefined;
	_onOpenClose: ((gui: GUI) => void) | undefined;

	constructor({ parent, title = 'Controls', closeFolders = false, container }: GUIOptions = {}) {
		this.parent = parent;
		this.root = parent ? parent.root : this;

		this.children = [];
		this.controllers = [];
		this.folders = [];

		this._title = title;
		this._closeFolders = closeFolders;

		this.domElement = document.createElement('div');
		this.domElement.classList.add('gui');

		this.$title = document.createElement('button');
		this.$title.classList.add('gui-title');
		this.$title.setAttribute('aria-expanded', 'true');
		this.$title.addEventListener('click', () => this._openAnimated(this._closed));
		this.$title.addEventListener('touchstart', () => {}, { passive: true });

		this.$children = document.createElement('div');
		this.$children.classList.add('gui-children');

		this.domElement.appendChild(this.$title);
		this.domElement.appendChild(this.$children);

		this.title(title);

		if (parent) {
			parent.children.push(this);
			parent.folders.push(this);
			parent.$children.appendChild(this.domElement);
			return;
		}

		this.domElement.classList.add('gui-root');

		if (container) {
			container.appendChild(this.domElement);
		}
	}

	// Overload: array/object options → OptionController
	add<T extends object, K extends keyof T & string, O>(
		object: T,
		property: K,
		options: O[] | Record<string, O>
	): OptionController<O>;

	// Overload: number with optional min/max/step → NumberController
	add<T extends object, K extends keyof T & string>(
		object: T,
		property: K,
		min?: number,
		max?: number,
		step?: number
	): ControllerForType<T[K]>;

	// Loose fallback overload for objects that don't have typed index signatures
	add(
		object: object,
		property: string,
		minOrOptions?: number | unknown[] | Record<string, unknown>,
		max?: number,
		step?: number
	): Controller;

	add(object: object, property: string, $1?: unknown, max?: number, step?: number): Controller {
		if ($1 !== null && typeof $1 === 'object' || Array.isArray($1)) {
			return new OptionController(this, object, property, $1 as unknown[] | Record<string, unknown>);
		}

		const value = (object as Record<string, unknown>)[property];

		switch (typeof value) {
			case 'number':
				return new NumberController(this, object, property, $1 as number | undefined, max, step);
			case 'boolean':
				return new BooleanController(this, object, property);
			case 'string':
				return new StringController(this, object, property);
			case 'function':
				return new FunctionController(this, object, property);
		}

		console.error('GUI.add failed, unsupported type', { object, property, value });
		// Return a no-op controller to avoid crashing call sites
		return new Controller(this, object, property, 'gui-unknown');
	}

	addColor<T extends object, K extends keyof T & string>(
		object: T,
		property: K,
		rgbScale = 1
	): ColorController {
		return new ColorController(this, object, property, rgbScale);
	}

	addFolder(title: string): GUI {
		const folder = new GUI({ parent: this, title });
		if (this.root._closeFolders) folder.close();
		return folder;
	}

	open(open = true): this {
		this._setClosed(!open);
		this.$title.setAttribute('aria-expanded', String(!this._closed));
		this.domElement.classList.toggle('gui-closed', this._closed);
		return this;
	}

	close(): this {
		return this.open(false);
	}

	show(show = true): this {
		this._hidden = !show;
		this.domElement.style.display = this._hidden ? 'none' : '';
		return this;
	}

	hide(): this {
		return this.show(false);
	}

	title(title: string): this {
		this._title = title;
		this.$title.textContent = title;
		return this;
	}

	reset(recursive = true): this {
		const controllers = recursive ? this.controllersRecursive() : this.controllers;
		controllers.forEach(c => c.reset());
		return this;
	}

	onChange(callback: (event: ChangeEvent) => void): this {
		this._onChange = callback;
		return this;
	}

	_callOnChange(controller: Controller): void {
		if (this.parent) {
			this.parent._callOnChange(controller);
		}
		if (this._onChange !== undefined) {
			this._onChange.call(this, {
				object: controller.object,
				property: controller.property,
				value: controller.getValue(),
				controller,
			});
		}
	}

	onFinishChange(callback: (event: ChangeEvent) => void): this {
		this._onFinishChange = callback;
		return this;
	}

	_callOnFinishChange(controller: Controller): void {
		if (this.parent) {
			this.parent._callOnFinishChange(controller);
		}
		if (this._onFinishChange !== undefined) {
			this._onFinishChange.call(this, {
				object: controller.object,
				property: controller.property,
				value: controller.getValue(),
				controller,
			});
		}
	}

	onOpenClose(callback: (gui: GUI) => void): this {
		this._onOpenClose = callback;
		return this;
	}

	_callOnOpenClose(changedGUI: GUI): void {
		if (this.parent) {
			this.parent._callOnOpenClose(changedGUI);
		}
		if (this._onOpenClose !== undefined) {
			this._onOpenClose.call(this, changedGUI);
		}
	}

	destroy(): void {
		if (this.parent) {
			this.parent.children.splice(this.parent.children.indexOf(this), 1);
			this.parent.folders.splice(this.parent.folders.indexOf(this), 1);
		}
		if (this.domElement.parentElement) {
			this.domElement.parentElement.removeChild(this.domElement);
		}
		Array.from(this.children).forEach(c => c.destroy());
	}

	controllersRecursive(): Controller[] {
		let result = Array.from(this.controllers);
		this.folders.forEach(f => { result = result.concat(f.controllersRecursive()); });
		return result;
	}

	foldersRecursive(): GUI[] {
		let result = Array.from(this.folders);
		this.folders.forEach(f => { result = result.concat(f.foldersRecursive()); });
		return result;
	}

	private _setClosed(closed: boolean): void {
		if (this._closed === closed) return;
		this._closed = closed;
		this._callOnOpenClose(this);
	}

	private _openAnimated(open = true): void {
		this._setClosed(!open);
		this.$title.setAttribute('aria-expanded', String(!this._closed));

		requestAnimationFrame(() => {
			const initialHeight = this.$children.clientHeight;
			this.$children.style.height = initialHeight + 'px';
			this.domElement.classList.add('gui-transition');

			const onTransitionEnd = (e: TransitionEvent) => {
				if (e.target !== this.$children) return;
				this.$children.style.height = '';
				this.domElement.classList.remove('gui-transition');
				this.$children.removeEventListener('transitionend', onTransitionEnd);
			};

			this.$children.addEventListener('transitionend', onTransitionEnd);
			const targetHeight = !open ? 0 : this.$children.scrollHeight;
			this.domElement.classList.toggle('gui-closed', !open);

			requestAnimationFrame(() => {
				this.$children.style.height = targetHeight + 'px';
			});
		});
	}

}
