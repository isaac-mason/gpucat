import { vec3, quat, euler, type Vec3, type Quat } from 'mathcat';
import type { Camera } from '../camera/camera';
import { topic, type Topic } from '../utils/topic';

const _EPS = 0.000001;

const _forward: Vec3 = [0, 0, 0];
const _right: Vec3 = [0, 0, 0];
const _moveDir: Vec3 = [0, 0, 0];

/**
 * FlyControls — WASD + right-click look camera controller.
 *
 * Movement: W/S forward/back, A/D strafe left/right, Space up, Shift down.
 * Look: Right-click + drag to yaw/pitch.
 * Speed: Scroll wheel adjusts movementSpeed.
 *
 * Call `update(delta)` each frame where delta is seconds since last frame.
 */
export class FlyControls {
    readonly object: Camera;

    domElement: HTMLElement | null = null;

    enabled = true;

    /** Movement speed in world units per second. */
    movementSpeed = 5.0;

    /** Look sensitivity in radians per pixel. */
    lookSpeed = 0.002;

    /** Scroll wheel speed multiplier factor. Each tick multiplies/divides movementSpeed by this. */
    speedScrollFactor = 1.1;

    /** Minimum movementSpeed (clamped on scroll). */
    minSpeed = 0.1;

    /** Maximum movementSpeed (clamped on scroll). */
    maxSpeed = 200.0;

    // -- internal state --

    private _yaw = 0;
    private _pitch = 0;

    private _moveState = {
        forward: 0,
        back: 0,
        left: 0,
        right: 0,
        up: 0,
        down: 0,
    };

    private _looking = false;

    private _lastPosition: Vec3 = [0, 0, 0];
    private _lastQuaternion: Quat = [0, 0, 0, 1];

    // bound event handlers
    private _onKeyDown: (e: KeyboardEvent) => void;
    private _onKeyUp: (e: KeyboardEvent) => void;
    private _onPointerDown: (e: PointerEvent) => void;
    private _onPointerMove: (e: PointerEvent) => void;
    private _onPointerUp: (e: PointerEvent) => void;
    private _onContextMenu: (e: Event) => void;
    private _onWheel: (e: WheelEvent) => void;

    onChange: Topic<[]> = topic<[]>();

    constructor(object: Camera, domElement: HTMLElement | null = null) {
        this.object = object;

        // Initialize yaw/pitch from current camera quaternion
        this._extractYawPitch();

        this._onKeyDown = onKeyDown.bind(this);
        this._onKeyUp = onKeyUp.bind(this);
        this._onPointerDown = onPointerDown.bind(this);
        this._onPointerMove = onPointerMove.bind(this);
        this._onPointerUp = onPointerUp.bind(this);
        this._onContextMenu = onContextMenu.bind(this);
        this._onWheel = onWheel.bind(this);

        if (domElement !== null) {
            this.connect(domElement);
        }
    }

    // -- connect / disconnect --

    connect(element: HTMLElement): void {
        this.domElement = element;

        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup', this._onKeyUp);

        element.addEventListener('pointerdown', this._onPointerDown);
        element.addEventListener('contextmenu', this._onContextMenu);
        element.addEventListener('wheel', this._onWheel, { passive: false });

        element.style.touchAction = 'none';
    }

    disconnect(): void {
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keyup', this._onKeyUp);

        if (this.domElement) {
            this.domElement.removeEventListener('pointerdown', this._onPointerDown);
            this.domElement.removeEventListener('contextmenu', this._onContextMenu);
            this.domElement.removeEventListener('wheel', this._onWheel);

            this.domElement.style.touchAction = '';
        }
    }

    dispose(): void {
        this.disconnect();
    }

    // -- update (call each frame) --

    /**
     * Update camera position and orientation.
     * @param delta - Time elapsed since last frame in seconds.
     */
    update(delta: number): void {
        if (!this.enabled) return;

        // -- movement --
        const moveX = -this._moveState.left + this._moveState.right;
        const moveY = -this._moveState.down + this._moveState.up;
        const moveZ = -this._moveState.forward + this._moveState.back;

        if (moveX !== 0 || moveY !== 0 || moveZ !== 0) {
            // camera forward = -Z column of the camera's local rotation
            const q = this.object.quaternion;

            // forward direction (camera looks down -Z)
            vec3.set(_forward, 0, 0, -1);
            vec3.transformQuat(_forward, _forward, q);

            // right direction (+X in camera space)
            vec3.set(_right, 1, 0, 0);
            vec3.transformQuat(_right, _right, q);

            // build move direction
            vec3.set(_moveDir, 0, 0, 0);

            // forward/back: project forward onto XZ plane for ground-relative movement
            vec3.scaleAndAdd(_moveDir, _moveDir, _forward, -moveZ);

            // strafe
            vec3.scaleAndAdd(_moveDir, _moveDir, _right, moveX);

            // vertical: world Y
            _moveDir[1] += moveY;

            const len = vec3.length(_moveDir);
            if (len > _EPS) {
                vec3.scale(_moveDir, _moveDir, 1 / len);
            }

            const speed = this.movementSpeed * delta;
            vec3.scaleAndAdd(this.object.position, this.object.position, _moveDir, speed);
        }

        // -- apply yaw/pitch to quaternion --
        const e = euler.fromValues(this._pitch, this._yaw, 0, 'yxz');
        quat.fromEuler(this.object.quaternion, e);

        // -- update matrices --
        this.object.updateWorldMatrix();
        this.object.updateViewMatrix();

        // -- check if changed --
        const posDist = vec3.squaredDistance(this._lastPosition, this.object.position);
        const quatDot =
            this._lastQuaternion[0] * this.object.quaternion[0] +
            this._lastQuaternion[1] * this.object.quaternion[1] +
            this._lastQuaternion[2] * this.object.quaternion[2] +
            this._lastQuaternion[3] * this.object.quaternion[3];
        const quatDist = 8 * (1 - Math.abs(quatDot));

        if (posDist > _EPS || quatDist > _EPS) {
            this.onChange.emit();
            vec3.copy(this._lastPosition, this.object.position);
            quat.copy(this._lastQuaternion, this.object.quaternion);
        }
    }

    // -- private --

    /** Extract yaw and pitch from the current camera quaternion. */
    private _extractYawPitch(): void {
        // Convert quaternion to a forward direction, then extract yaw/pitch.
        const q = this.object.quaternion;

        // forward = quaternion * (0, 0, -1)
        vec3.set(_forward, 0, 0, -1);
        vec3.transformQuat(_forward, _forward, q);

        // yaw = atan2(forward.x, forward.z) — but forward is -Z, so:
        this._yaw = Math.atan2(-_forward[0], -_forward[2]);

        // pitch = asin(-forward.y), clamped
        this._pitch = Math.asin(Math.max(-1, Math.min(1, -_forward[1])));
    }
}

// -- event handlers (bound to FlyControls instance) --

function onKeyDown(this: FlyControls, event: KeyboardEvent): void {
    if (!this.enabled || event.altKey) return;

    switch (event.code) {
        case 'KeyW': this['_moveState'].forward = 1; break;
        case 'KeyS': this['_moveState'].back = 1; break;
        case 'KeyA': this['_moveState'].left = 1; break;
        case 'KeyD': this['_moveState'].right = 1; break;
        case 'Space': this['_moveState'].up = 1; event.preventDefault(); break;
        case 'ShiftLeft':
        case 'ShiftRight': this['_moveState'].down = 1; break;
    }
}

function onKeyUp(this: FlyControls, event: KeyboardEvent): void {
    if (!this.enabled) return;

    switch (event.code) {
        case 'KeyW': this['_moveState'].forward = 0; break;
        case 'KeyS': this['_moveState'].back = 0; break;
        case 'KeyA': this['_moveState'].left = 0; break;
        case 'KeyD': this['_moveState'].right = 0; break;
        case 'Space': this['_moveState'].up = 0; break;
        case 'ShiftLeft':
        case 'ShiftRight': this['_moveState'].down = 0; break;
    }
}

function onPointerDown(this: FlyControls, event: PointerEvent): void {
    if (!this.enabled) return;

    // Right-click to look
    if (event.button === 2) {
        this['_looking'] = true;

        this.domElement!.requestPointerLock();
        document.addEventListener('pointermove', this['_onPointerMove']);
        document.addEventListener('pointerup', this['_onPointerUp']);
    }
}

function onPointerMove(this: FlyControls, event: PointerEvent): void {
    if (!this.enabled || !this['_looking']) return;

    const dx = event.movementX;
    const dy = event.movementY;

    this['_yaw'] -= dx * this.lookSpeed;
    this['_pitch'] -= dy * this.lookSpeed;

    // Clamp pitch to avoid gimbal flip
    const limit = Math.PI / 2 - 0.01;
    this['_pitch'] = Math.max(-limit, Math.min(limit, this['_pitch']));
}

function onPointerUp(this: FlyControls, event: PointerEvent): void {
    if (event.button === 2) {
        this['_looking'] = false;

        document.exitPointerLock();
        document.removeEventListener('pointermove', this['_onPointerMove']);
        document.removeEventListener('pointerup', this['_onPointerUp']);
    }
}

function onContextMenu(this: FlyControls, event: Event): void {
    if (!this.enabled) return;
    event.preventDefault();
}

function onWheel(this: FlyControls, event: WheelEvent): void {
    if (!this.enabled) return;
    event.preventDefault();

    if (event.deltaY < 0) {
        this.movementSpeed = Math.min(this.maxSpeed, this.movementSpeed * this.speedScrollFactor);
    } else if (event.deltaY > 0) {
        this.movementSpeed = Math.max(this.minSpeed, this.movementSpeed / this.speedScrollFactor);
    }
}
