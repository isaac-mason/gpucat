import type { Camera } from '../camera/camera';
import { type Topic } from '../utils/topic';
/**
 * FlyControls — WASD + right-click look camera controller.
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
    private _yaw;
    private _pitch;
    private _moveState;
    private _looking;
    private _lastPosition;
    private _lastQuaternion;
    private _onKeyDown;
    private _onKeyUp;
    private _onPointerDown;
    private _onPointerMove;
    private _onPointerUp;
    private _onContextMenu;
    private _onWheel;
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
    private _extractYawPitch;
}
