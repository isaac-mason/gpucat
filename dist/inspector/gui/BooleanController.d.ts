import { Controller } from './Controller';
import type { GUI } from './GUI';
export declare class BooleanController extends Controller<boolean> {
    $input: HTMLInputElement;
    constructor(parent: GUI, object: object, property: string);
    updateDisplay(): this;
}
