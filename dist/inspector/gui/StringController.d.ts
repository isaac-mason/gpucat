import { Controller } from './Controller';
import type { GUI } from './GUI';
export declare class StringController extends Controller<string> {
    $input: HTMLInputElement;
    constructor(parent: GUI, object: object, property: string);
    updateDisplay(): this;
}
