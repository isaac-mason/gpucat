import type { GUI } from 'gpucat/dist/inspector/gui/GUI';
import { Controller } from 'gpucat/dist/inspector/gui/Controller';
export declare class BooleanController extends Controller<boolean> {
    $input: HTMLInputElement;
    constructor(parent: GUI, object: object, property: string);
    updateDisplay(): this;
}
