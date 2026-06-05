import type { GUI } from './GUI';
export interface ChangeEvent<T = unknown> {
    object: object;
    property: string;
    value: T;
    controller: Controller<T>;
}
export declare class Controller<T = unknown> {
    parent: GUI;
    object: object;
    property: string;
    initialValue: T;
    domElement: HTMLElement;
    $name: HTMLElement;
    $widget: HTMLElement;
    $disable: HTMLElement;
    _disabled: boolean;
    _hidden: boolean;
    _listening: boolean;
    _name: string;
    _onChange: ((value: unknown) => void) | undefined;
    _onFinishChange: ((value: unknown) => void) | undefined;
    _changed: boolean;
    private _listenCallbackID;
    private _listenPrevValue;
    constructor(parent: GUI, object: object, property: string, className: string, elementType?: 'div' | 'label');
    name(name: string): this;
    onChange(callback: (value: T) => void): this;
    _callOnChange(): void;
    onFinishChange(callback: (value: T) => void): this;
    _callOnFinishChange(): void;
    reset(): this;
    enable(enabled?: boolean): this;
    disable(disabled?: boolean): this;
    show(show?: boolean): this;
    hide(): this;
    min(_min: number): this;
    max(_max: number): this;
    step(_step: number): this;
    decimals(_decimals: number): this;
    listen(listen?: boolean): this;
    private _listenCallback;
    getValue(): T;
    setValue(value: T): this;
    updateDisplay(): this;
    save(): unknown;
    load(value: T): this;
    destroy(): void;
}
