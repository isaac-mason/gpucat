import type { GUI } from 'gpucat/dist/inspector/gui/GUI';
import { Controller } from 'gpucat/dist/inspector/gui/Controller';
export declare class FunctionController extends Controller<() => void> {
    $button: HTMLButtonElement;
    constructor(parent: GUI, object: object, property: string);
}
