import type { DeviceBackend } from './device-backend';
import { Renderer } from './renderer';

/**
 * Build a renderer on a backend and await its device. No 'auto' backend: only the caller knows what a
 * probe failure should fall back to, so a backend is chosen and built before this is called.
 *
 * `new Renderer(backend)` then `await renderer.init()` is the other form, and it is not redundant: a
 * caller assembling state synchronously has the renderer to hand before anything can be awaited.
 */
export function init<B extends DeviceBackend>(backend: B): Promise<Renderer<B>> {
    return new Renderer(backend).init();
}
