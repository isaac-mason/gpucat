import type { GUI } from './GUI';
import { Controller } from './Controller';
export declare class FunctionController extends Controller<() => void> {
    $button: HTMLButtonElement;
    constructor(parent: GUI, object: object, property: string);
}
