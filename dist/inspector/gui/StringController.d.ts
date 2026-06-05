import type { GUI } from './GUI';
import { Controller } from './Controller';
export declare class StringController extends Controller<string> {
    $input: HTMLInputElement;
    constructor(parent: GUI, object: object, property: string);
    updateDisplay(): this;
}
