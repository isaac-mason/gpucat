import { type Vec3, type Quat } from 'mathcat';
import type { Camera } from '../camera/camera';
import { type Topic } from '../utils/topic';
/**
 * FlyControls, WASD + right-click look camera controller.
 *
 * Movement: W/S forward/back, A/D strafe left/right, Space up, Shift down.
 * Look: Right-click + drag to yaw/pitch.
 * Speed: Scroll wheel adjusts movementSpeed.
 *
 * Call `update(delta)` each frame where delta is seconds since last frame.
 */
export declare class FlyControls {
    readonly object: Camera;
    domElement: HTMLElement | null;
    enabled: boolean;
    /** Movement speed in world units per second. */
    movementSpeed: number;
    /** Look sensitivity in radians per pixel. */
    lookSpeed: number;
    /** Scroll wheel speed multiplier factor. Each tick multiplies/divides movementSpeed by this. */
    speedScrollFactor: number;
    /** Minimum movementSpeed (clamped on scroll). */
    minSpeed: number;
    /** Maximum movementSpeed (clamped on scroll). */
    maxSpeed: number;
    _yaw: number;
    _pitch: number;
    _moveState: {
        forward: number;
        back: number;
        left: number;
        right: number;
        up: number;
        down: number;
    };
    _looking: boolean;
    _lastPosition: Vec3;
    _lastQuaternion: Quat;
    _onKeyDown: (e: KeyboardEvent) => void;
    _onKeyUp: (e: KeyboardEvent) => void;
    _onPointerDown: (e: PointerEvent) => void;
    _onPointerMove: (e: PointerEvent) => void;
    _onPointerUp: (e: PointerEvent) => void;
    _onContextMenu: (e: Event) => void;
    _onWheel: (e: WheelEvent) => void;
    onChange: Topic<[]>;
    constructor(object: Camera, domElement?: HTMLElement | null);
    connect(element: HTMLElement): void;
    disconnect(): void;
    dispose(): void;
    /**
     * Update camera position and orientation.
     * @param delta - Time elapsed since last frame in seconds.
     */
    update(delta: number): void;
    /** Extract yaw and pitch from the current camera quaternion. */
    _extractYawPitch(): void;
}
