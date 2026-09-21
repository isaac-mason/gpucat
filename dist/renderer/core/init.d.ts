import type { DeviceBackend } from './device-backend';
import { Renderer } from './renderer';
/**
 * The one place a `Renderer` is constructed. No 'auto' backend: only the caller knows what a probe
 * failure should fall back to, so a backend is chosen and built before this is called.
 */
export declare function init<B extends DeviceBackend>(backend: B): Promise<Renderer<B>>;
