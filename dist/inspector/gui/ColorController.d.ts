import type { GUI } from 'gpucat/dist/inspector/gui/GUI';
import { Controller } from 'gpucat/dist/inspector/gui/Controller';
type ColorValue = string | number | {
    r: number;
    g: number;
    b: number;
} | [number, number, number];
export declare class ColorController extends Controller<ColorValue> {
    $input: HTMLInputElement;
    $text: HTMLInputElement;
    $display: HTMLDivElement;
    _rgbScale: number;
    _initialValueHexString: string;
    _textFocused: boolean;
    constructor(parent: GUI, object: object, property: string, rgbScale?: number);
    reset(): this;
    save(): unknown;
    load(value: ColorValue): this;
    updateDisplay(): this;
    private _setValueFromHexString;
    private _tryNormalizeColorString;
}
export {};
