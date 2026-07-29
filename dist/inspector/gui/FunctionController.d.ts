import { Controller } from './Controller';
import type { GUI } from './GUI';
export declare class FunctionController extends Controller<() => void> {
    $button: HTMLButtonElement;
    constructor(parent: GUI, object: object, property: string);
}
