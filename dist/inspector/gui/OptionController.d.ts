import type { GUI } from 'gpucat/dist/inspector/gui/GUI';
import { Controller } from 'gpucat/dist/inspector/gui/Controller';
export declare class OptionController<T = unknown> extends Controller<T> {
    $select: HTMLSelectElement;
    $display: HTMLDivElement;
    _values: T[];
    _names: string[];
    constructor(parent: GUI, object: object, property: string, options: T[] | Record<string, T>);
    options(options: T[] | Record<string, T>): this;
    updateDisplay(): this;
}
