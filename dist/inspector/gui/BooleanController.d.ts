import type { GUI } from './GUI';
import { Controller } from './Controller';
export declare class BooleanController extends Controller<boolean> {
    $input: HTMLInputElement;
    constructor(parent: GUI, object: object, property: string);
    updateDisplay(): this;
}
