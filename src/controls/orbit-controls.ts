import { vec3, vec2, quat, spherical, type Vec3, type Vec2, type Quat, type Spherical } from 'mathcat';
import type { Camera } from '../camera/camera';
import type { PerspectiveCamera } from '../camera/perspective-camera';

const STATE = {
    NONE: -1,
    ROTATE: 0,
    DOLLY: 1,
    PAN: 2,
    TOUCH_ROTATE: 3,
    TOUCH_PAN: 4,
    TOUCH_DOLLY_PAN: 5,
    TOUCH_DOLLY_ROTATE: 6,
} as const;

type StateValue = (typeof STATE)[keyof typeof STATE];

export const MOUSE = {
    ROTATE: 0,
    DOLLY: 1,
    PAN: 2,
} as const;

export type MouseAction = (typeof MOUSE)[keyof typeof MOUSE];

export const TOUCH = {
    ROTATE: 0,
    PAN: 1,
    DOLLY_PAN: 2,
    DOLLY_ROTATE: 3,
} as const;

export type TouchAction = (typeof TOUCH)[keyof typeof TOUCH];

export type OrbitControlsEventType = 'change' | 'start' | 'end';

export interface OrbitControlsEvent {
    type: OrbitControlsEventType;
    target: OrbitControls;
}

export type OrbitControlsEventListener = (event: OrbitControlsEvent) => void;

// ---------------------------------------------------------------------------
// Module-level scratch variables (avoid per-frame allocation)
// ---------------------------------------------------------------------------

const _v: Vec3 = [0, 0, 0];
const _twoPI = 2 * Math.PI;
const _EPS = 0.000001;
const _TILT_LIMIT = Math.cos(70 * (Math.PI / 180));

// ---------------------------------------------------------------------------
// mat4 column extraction helpers (column-major, gl-matrix layout)
// col 0: indices 0-3, col 1: 4-7, col 2: 8-11, col 3: 12-15
// ---------------------------------------------------------------------------

function mat4GetColumn(out: Vec3, m: ArrayLike<number>, col: 0 | 1 | 2): Vec3 {
    const base = col * 4;
    out[0] = m[base];
    out[1] = m[base + 1];
    out[2] = m[base + 2];
    return out;
}

// ---------------------------------------------------------------------------
// OrbitControls
// ---------------------------------------------------------------------------

/**
 * OrbitControls — mirrors Three.js OrbitControls.
 *
 * Orbit: left mouse / one-finger touch.
 * Zoom:  middle mouse / wheel / two-finger pinch.
 * Pan:   right mouse / left mouse + ctrl|meta|shift / two-finger drag / arrow keys.
 *
 * Call `update()` each frame when `enableDamping` or `autoRotate` are `true`.
 */
export class OrbitControls {
    /** The camera being controlled. */
    readonly object: Camera;

    /** The DOM element used for event listeners. */
    domElement: HTMLElement | null = null;

    /** Whether the controls are active. */
    enabled = true;

    // ---- target / cursor --------------------------------------------------

    /** The point the camera orbits around. */
    target: Vec3 = [0, 0, 0];

    /**
     * The focus point of the `minTargetRadius` / `maxTargetRadius` limits.
     */
    cursor: Vec3 = [0, 0, 0];

    // ---- distance limits (perspective) ------------------------------------

    minDistance = 0;
    maxDistance = Infinity;

    // ---- zoom limits (orthographic) ----------------------------------------

    minZoom = 0;
    maxZoom = Infinity;

    // ---- target radius limits ---------------------------------------------

    minTargetRadius = 0;
    maxTargetRadius = Infinity;

    // ---- polar angle limits -----------------------------------------------

    /** Minimum polar angle (radians), default 0. */
    minPolarAngle = 0;
    /** Maximum polar angle (radians), default Math.PI. */
    maxPolarAngle = Math.PI;

    // ---- azimuth limits ---------------------------------------------------

    minAzimuthAngle = -Infinity;
    maxAzimuthAngle = Infinity;

    // ---- damping ----------------------------------------------------------

    enableDamping = false;
    dampingFactor = 0.05;

    // ---- zoom -------------------------------------------------------------

    enableZoom = true;
    zoomSpeed = 1.0;
    zoomToCursor = false;

    // ---- rotate -----------------------------------------------------------

    enableRotate = true;
    rotateSpeed = 1.0;
    keyRotateSpeed = 1.0;

    // ---- pan --------------------------------------------------------------

    enablePan = true;
    panSpeed = 1.0;
    /** When true the camera pans in screen space; otherwise in world-up plane. */
    screenSpacePanning = true;
    keyPanSpeed = 7.0;

    // ---- auto-rotate ------------------------------------------------------

    autoRotate = false;
    /** 2.0 ≈ 30 s per orbit at 60 fps */
    autoRotateSpeed = 2.0;

    // ---- key bindings -----------------------------------------------------

    keys = {
        LEFT: 'ArrowLeft',
        UP: 'ArrowUp',
        RIGHT: 'ArrowRight',
        BOTTOM: 'ArrowDown',
    };

    // ---- mouse / touch action map ----------------------------------------

    mouseButtons: { LEFT: MouseAction; MIDDLE: MouseAction; RIGHT: MouseAction } = {
        LEFT: MOUSE.ROTATE,
        MIDDLE: MOUSE.DOLLY,
        RIGHT: MOUSE.PAN,
    };

    touches: { ONE: TouchAction; TWO: TouchAction } = {
        ONE: TOUCH.ROTATE,
        TWO: TOUCH.DOLLY_PAN,
    };

    // ---- saved state (for reset()) ----------------------------------------

    target0: Vec3;
    position0: Vec3;
    zoom0: number;

    // ---- internal state ---------------------------------------------------

    state: StateValue = STATE.NONE;

    /** @internal */ _cursorStyle: 'auto' | 'grab' = 'auto';

    /** @internal */ _domElementKeyEvents: EventTarget | null = null;

    /** @internal */ _lastPosition: Vec3 = [0, 0, 0];
    /** @internal */ _lastQuaternion: Quat = [0, 0, 0, 1];
    /** @internal */ _lastTargetPosition: Vec3 = [0, 0, 0];

    // quaternion to align camera.up with world +Y and its inverse
    /** @internal */ _quat: Quat;
    /** @internal */ _quatInverse: Quat;

    /** @internal */ _spherical: Spherical = spherical.create();
    /** @internal */ _sphericalDelta: Spherical = spherical.create();

    /** @internal */ _scale = 1;
    /** @internal */ _panOffset: Vec3 = [0, 0, 0];

    /** @internal */ _rotateStart: Vec2 = vec2.create();
    /** @internal */ _rotateEnd: Vec2 = vec2.create();
    /** @internal */ _rotateDelta: Vec2 = vec2.create();

    /** @internal */ _panStart: Vec2 = vec2.create();
    /** @internal */ _panEnd: Vec2 = vec2.create();
    /** @internal */ _panDelta: Vec2 = vec2.create();

    /** @internal */ _dollyStart: Vec2 = vec2.create();
    /** @internal */ _dollyEnd: Vec2 = vec2.create();
    /** @internal */ _dollyDelta: Vec2 = vec2.create();

    /** @internal */ _dollyDirection: Vec3 = [0, 0, 0];
    /** @internal */ _mouse: Vec2 = vec2.create();
    /** @internal */ _performCursorZoom = false;

    /** @internal */ _pointers: number[] = [];
    /** @internal */ _pointerPositions: Record<number, Vec2> = {};

    /** @internal */ _controlActive = false;

    // Bound event handlers stored so they can be removed later
    /** @internal */ _onPointerMove: (e: PointerEvent) => void;
    /** @internal */ _onPointerDown: (e: PointerEvent) => void;
    /** @internal */ _onPointerUp: (e: PointerEvent) => void;
    /** @internal */ _onContextMenu: (e: Event) => void;
    /** @internal */ _onMouseWheel: (e: WheelEvent) => void;
    /** @internal */ _onKeyDown: (e: KeyboardEvent) => void;
    /** @internal */ _onTouchStart: (e: PointerEvent) => void;
    /** @internal */ _onTouchMove: (e: PointerEvent) => void;
    /** @internal */ _onMouseDown: (e: PointerEvent) => void;
    /** @internal */ _onMouseMove: (e: PointerEvent) => void;
    /** @internal */ _interceptControlDown: (e: KeyboardEvent) => void;
    /** @internal */ _interceptControlUp: (e: KeyboardEvent) => void;

    // EventTarget listeners
    private _listeners: Map<string, Set<OrbitControlsEventListener>> = new Map();

    constructor(object: Camera, domElement: HTMLElement | null = null) {
        this.object = object;

        // Build the quaternion that rotates camera.up → world +Y
        const up: Vec3 = [0, 1, 0];
        // camera.up equivalent: we use +Y by default since Object3D doesn't carry an "up" field
        // (same as Three.js default).  Users can override _quat / _quatInverse after construction
        // if they need a different up axis.
        this._quat = quat.rotationTo(quat.create(), up, up); // identity — up already is +Y
        this._quatInverse = quat.conjugate(quat.create(), this._quat);

        // Saved state snapshots
        this.target0 = vec3.clone(this.target);
        this.position0 = vec3.clone(object.position);
        this.zoom0 = (object as PerspectiveCamera).fov ?? 1; // use fov as proxy for zoom

        // Bind handlers
        this._onPointerDown = _onPointerDown.bind(this);
        this._onPointerMove = _onPointerMove.bind(this);
        this._onPointerUp = _onPointerUp.bind(this);
        this._onContextMenu = _onContextMenu.bind(this);
        this._onMouseWheel = _onMouseWheel.bind(this);
        this._onKeyDown = _onKeyDown.bind(this);
        this._onTouchStart = _onTouchStart.bind(this);
        this._onTouchMove = _onTouchMove.bind(this);
        this._onMouseDown = _onMouseDown.bind(this);
        this._onMouseMove = _onMouseMove.bind(this);
        this._interceptControlDown = _interceptControlDown.bind(this);
        this._interceptControlUp = _interceptControlUp.bind(this);

        if (domElement !== null) {
            this.connect(domElement);
        }

        this.update();
    }

    // -------------------------------------------------------------------------
    // EventEmitter surface
    // -------------------------------------------------------------------------

    addEventListener(type: OrbitControlsEventType, listener: OrbitControlsEventListener): void {
        if (!this._listeners.has(type)) this._listeners.set(type, new Set());
        this._listeners.get(type)!.add(listener);
    }

    removeEventListener(type: OrbitControlsEventType, listener: OrbitControlsEventListener): void {
        this._listeners.get(type)?.delete(listener);
    }

    dispatchEvent(type: OrbitControlsEventType): void {
        const set = this._listeners.get(type);
        if (!set) return;
        const event: OrbitControlsEvent = { type, target: this };
        for (const listener of set) {
            listener(event);
        }
    }

    // -------------------------------------------------------------------------
    // Cursor style
    // -------------------------------------------------------------------------

    get cursorStyle(): 'auto' | 'grab' {
        return this._cursorStyle;
    }

    set cursorStyle(type: 'auto' | 'grab') {
        this._cursorStyle = type;
        if (this.domElement) {
            this.domElement.style.cursor = type === 'grab' ? 'grab' : 'auto';
        }
    }

    // -------------------------------------------------------------------------
    // Connect / disconnect / dispose
    // -------------------------------------------------------------------------

    connect(element: HTMLElement): void {
        this.domElement = element;

        element.addEventListener('pointerdown', this._onPointerDown as EventListener);
        element.addEventListener('pointercancel', this._onPointerUp as EventListener);
        element.addEventListener('contextmenu', this._onContextMenu);
        element.addEventListener('wheel', this._onMouseWheel as EventListener, { passive: false });

        const doc = element.getRootNode() as EventTarget;
        doc.addEventListener('keydown', this._interceptControlDown as EventListener, {
            passive: true,
            capture: true,
        });

        element.style.touchAction = 'none';
    }

    disconnect(): void {
        const element = this.domElement;
        if (!element) return;

        element.removeEventListener('pointerdown', this._onPointerDown as EventListener);
        (element.ownerDocument ?? element).removeEventListener(
            'pointermove',
            this._onPointerMove as EventListener,
        );
        (element.ownerDocument ?? element).removeEventListener(
            'pointerup',
            this._onPointerUp as EventListener,
        );
        element.removeEventListener('pointercancel', this._onPointerUp as EventListener);
        element.removeEventListener('wheel', this._onMouseWheel as EventListener);
        element.removeEventListener('contextmenu', this._onContextMenu);

        this.stopListenToKeyEvents();

        const doc = element.getRootNode() as EventTarget;
        doc.removeEventListener('keydown', this._interceptControlDown as EventListener, {
            capture: true,
        });

        element.style.touchAction = 'auto';
    }

    dispose(): void {
        this.disconnect();
    }

    // -------------------------------------------------------------------------
    // Getters
    // -------------------------------------------------------------------------

    getPolarAngle(): number {
        return this._spherical[2];
    }

    getAzimuthalAngle(): number {
        return this._spherical[1];
    }

    getDistance(): number {
        return vec3.distance(this.object.position, this.target);
    }

    // -------------------------------------------------------------------------
    // Key event helpers
    // -------------------------------------------------------------------------

    listenToKeyEvents(domElement: EventTarget): void {
        domElement.addEventListener('keydown', this._onKeyDown as EventListener);
        this._domElementKeyEvents = domElement;
    }

    stopListenToKeyEvents(): void {
        if (this._domElementKeyEvents !== null) {
            this._domElementKeyEvents.removeEventListener(
                'keydown',
                this._onKeyDown as EventListener,
            );
            this._domElementKeyEvents = null;
        }
    }

    // -------------------------------------------------------------------------
    // Save / reset state
    // -------------------------------------------------------------------------

    saveState(): void {
        vec3.copy(this.target0, this.target);
        vec3.copy(this.position0, this.object.position);
        this.zoom0 = (this.object as PerspectiveCamera).fov ?? 1;
    }

    reset(): void {
        vec3.copy(this.target, this.target0);
        vec3.copy(this.object.position, this.position0);

        const cam = this.object as PerspectiveCamera;
        if (typeof cam.fov === 'number') {
            cam.fov = this.zoom0;
            cam.updateProjectionMatrix();
        }

        this.dispatchEvent('change');
        this.update();
        this.state = STATE.NONE;
    }

    // -------------------------------------------------------------------------
    // Programmatic controls
    // -------------------------------------------------------------------------

    pan(deltaX: number, deltaY: number): void {
        this._pan(deltaX, deltaY);
        this.update();
    }

    dollyIn(dollyScale: number): void {
        this._dollyIn(dollyScale);
        this.update();
    }

    dollyOut(dollyScale: number): void {
        this._dollyOut(dollyScale);
        this.update();
    }

    rotateLeft(angle: number): void {
        this._rotateLeft(angle);
        this.update();
    }

    rotateUp(angle: number): void {
        this._rotateUp(angle);
        this.update();
    }

    // -------------------------------------------------------------------------
    // update() — call every frame when damping/autoRotate are enabled
    // -------------------------------------------------------------------------

    update(deltaTime: number | null = null): boolean {
        const position = this.object.position;

        // offset = position - target, rotated to Y-up space
        vec3.subtract(_v, position, this.target);
        vec3.transformQuat(_v, _v, this._quat);

        spherical.setFromVec3(this._spherical, _v);

        if (this.autoRotate && this.state === STATE.NONE) {
            this._rotateLeft(this._getAutoRotationAngle(deltaTime));
        }

        if (this.enableDamping) {
            this._spherical[1] += this._sphericalDelta[1] * this.dampingFactor;
            this._spherical[2] += this._sphericalDelta[2] * this.dampingFactor;
        } else {
            this._spherical[1] += this._sphericalDelta[1];
            this._spherical[2] += this._sphericalDelta[2];
        }

        // Clamp azimuth
        let aMin = this.minAzimuthAngle;
        let aMax = this.maxAzimuthAngle;

        if (isFinite(aMin) && isFinite(aMax)) {
            if (aMin < -Math.PI) aMin += _twoPI;
            else if (aMin > Math.PI) aMin -= _twoPI;

            if (aMax < -Math.PI) aMax += _twoPI;
            else if (aMax > Math.PI) aMax -= _twoPI;

            if (aMin <= aMax) {
                this._spherical[1] = Math.max(aMin, Math.min(aMax, this._spherical[1]));
            } else {
                this._spherical[1] =
                    this._spherical[1] > (aMin + aMax) / 2
                        ? Math.max(aMin, this._spherical[1])
                        : Math.min(aMax, this._spherical[1]);
            }
        }

        // Clamp polar
        this._spherical[2] = Math.max(
            this.minPolarAngle,
            Math.min(this.maxPolarAngle, this._spherical[2]),
        );
        spherical.makeSafe(this._spherical, this._spherical);

        // Pan offset
        if (this.enableDamping) {
            vec3.scaleAndAdd(this.target, this.target, this._panOffset, this.dampingFactor);
        } else {
            vec3.add(this.target, this.target, this._panOffset);
        }

        // Clamp target distance from cursor
        vec3.subtract(this.target, this.target, this.cursor);
        const tLen = vec3.length(this.target);
        const tLenClamped = Math.max(
            this.minTargetRadius,
            Math.min(this.maxTargetRadius, tLen),
        );
        if (tLen > 0) {
            vec3.scale(this.target, this.target, tLenClamped / tLen);
        }
        vec3.add(this.target, this.target, this.cursor);

        let zoomChanged = false;

        // Radius / zoom update
        const isPerspective = _isPerspective(this.object);
        if (this.zoomToCursor && this._performCursorZoom) {
            this._spherical[0] = this._clampDistance(this._spherical[0]);
        } else {
            const prevRadius = this._spherical[0];
            this._spherical[0] = this._clampDistance(this._spherical[0] * this._scale);
            zoomChanged = prevRadius !== this._spherical[0];
        }

        // Convert back to Cartesian and rotate to camera-up space
        spherical.toVec3(_v, this._spherical);
        vec3.transformQuat(_v, _v, this._quatInverse);

        vec3.add(position, this.target, _v);
        this.object.lookAt(this.target);

        // Apply damping decay
        if (this.enableDamping) {
            this._sphericalDelta[1] *= 1 - this.dampingFactor;
            this._sphericalDelta[2] *= 1 - this.dampingFactor;
            vec3.scale(this._panOffset, this._panOffset, 1 - this.dampingFactor);
        } else {
            spherical.set(this._sphericalDelta, 0, 0, 0);
            vec3.set(this._panOffset, 0, 0, 0);
        }

        // Zoom-to-cursor adjustment for perspective camera
        if (this.zoomToCursor && this._performCursorZoom && isPerspective) {
            const prevRadius = vec3.length(_v);
            const newRadius = this._clampDistance(prevRadius * this._scale);
            const radiusDelta = prevRadius - newRadius;

            if (radiusDelta !== 0) {
                vec3.scaleAndAdd(
                    this.object.position,
                    this.object.position,
                    this._dollyDirection,
                    radiusDelta,
                );
                this.object.updateWorldMatrix();
                zoomChanged = true;
            }

            // Reposition target in front of camera
            if (this.screenSpacePanning) {
                // target = camera.position + camera forward * newRadius
                // forward is -Z column of camera matrix (column 2, negated)
                mat4GetColumn(_v, this.object.matrix, 2);
                vec3.negate(_v, _v);
                vec3.normalize(_v, _v);
                vec3.scaleAndAdd(this.target, this.object.position, _v, newRadius);
            } else {
                // intersect the camera ray with the horizontal plane at target.y
                mat4GetColumn(_v, this.object.matrix, 2);
                vec3.negate(_v, _v);
                vec3.normalize(_v, _v);
                const upDot = Math.abs(_v[1]);
                if (upDot < _TILT_LIMIT) {
                    // recalculate target by look-at result
                    this.object.lookAt(this.target);
                } else {
                    // plane normal is up=[0,1,0], plane constant = target.y
                    const denom = _v[1];
                    if (Math.abs(denom) > _EPS) {
                        const t = (this.target[1] - this.object.position[1]) / denom;
                        this.target[0] = this.object.position[0] + _v[0] * t;
                        this.target[1] = this.object.position[1] + _v[1] * t;
                        this.target[2] = this.object.position[2] + _v[2] * t;
                    }
                }
            }
        }

        this._scale = 1;
        this._performCursorZoom = false;

        // Update camera matrices
        this.object.updateWorldMatrix();
        this.object.updateViewMatrix();

        // Check if anything actually changed
        const dx = vec3.squaredDistance(this._lastPosition, this.object.position);
        const dq =
            8 *
            (1 -
                Math.abs(
                    this._lastQuaternion[0] * this.object.quaternion[0] +
                        this._lastQuaternion[1] * this.object.quaternion[1] +
                        this._lastQuaternion[2] * this.object.quaternion[2] +
                        this._lastQuaternion[3] * this.object.quaternion[3],
                ));
        const dt = vec3.squaredDistance(this._lastTargetPosition, this.target);

        if (zoomChanged || dx > _EPS || dq > _EPS || dt > _EPS) {
            this.dispatchEvent('change');
            vec3.copy(this._lastPosition, this.object.position);
            quat.copy(this._lastQuaternion, this.object.quaternion);
            vec3.copy(this._lastTargetPosition, this.target);
            return true;
        }

        return false;
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    /** @internal */ _getAutoRotationAngle(deltaTime: number | null): number {
        if (deltaTime !== null) {
            return ((_twoPI / 60) * this.autoRotateSpeed) * deltaTime;
        }
        return (_twoPI / 60 / 60) * this.autoRotateSpeed;
    }

    /** @internal */ _getZoomScale(delta: number): number {
        const normalizedDelta = Math.abs(delta * 0.01);
        return Math.pow(0.95, this.zoomSpeed * normalizedDelta);
    }

    _rotateLeft(angle: number): void {
        this._sphericalDelta[1] -= angle;
    }

    _rotateUp(angle: number): void {
        this._sphericalDelta[2] -= angle;
    }

    /** @internal */ _panLeft(distance: number, objectMatrix: ArrayLike<number>): void {
        mat4GetColumn(_v, objectMatrix, 0);
        vec3.scale(_v, _v, -distance);
        vec3.add(this._panOffset, this._panOffset, _v);
    }

    /** @internal */ _panUp(distance: number, objectMatrix: ArrayLike<number>): void {
        if (this.screenSpacePanning) {
            mat4GetColumn(_v, objectMatrix, 1);
        } else {
            // Use (up × right) = world-up-projected pan direction
            mat4GetColumn(_v, objectMatrix, 0);
            const up: Vec3 = [0, 1, 0];
            vec3.cross(_v, up, _v);
        }
        vec3.scale(_v, _v, distance);
        vec3.add(this._panOffset, this._panOffset, _v);
    }

    // deltaX and deltaY in pixels (right/down positive)
    _pan(deltaX: number, deltaY: number): void {
        const element = this.domElement;
        const cam = this.object as PerspectiveCamera;

        if (_isPerspective(this.object) && element) {
            const position = this.object.position;
            vec3.subtract(_v, position, this.target);
            let targetDistance = vec3.length(_v);
            targetDistance *= Math.tan(((cam.fov / 2) * Math.PI) / 180);

            this._panLeft(
                (2 * deltaX * targetDistance) / element.clientHeight,
                this.object.matrix,
            );
            this._panUp(
                (2 * deltaY * targetDistance) / element.clientHeight,
                this.object.matrix,
            );
        } else {
            // Fallback — disable pan for unknown camera type
            console.warn('OrbitControls: unknown camera type — pan disabled.');
            this.enablePan = false;
        }
    }

    _dollyOut(dollyScale: number): void {
        this._scale /= dollyScale;
    }

    _dollyIn(dollyScale: number): void {
        this._scale *= dollyScale;
    }

    /** @internal */ _updateZoomParameters(x: number, y: number): void {
        if (!this.zoomToCursor || !this.domElement) return;

        this._performCursorZoom = true;

        const rect = this.domElement.getBoundingClientRect();
        const dx = x - rect.left;
        const dy = y - rect.top;

        this._mouse[0] = (dx / rect.width) * 2 - 1;
        this._mouse[1] = -(dy / rect.height) * 2 + 1;

        // Dolly direction: un-project the mouse position through the camera.
        // We approximate by setting dollyDirection to normalized (offset from camera to target)
        // adjusted by mouse NDC. Matches Three.js approach of projecting through the camera.
        // Since we don't have a full unproject here, we compute it from the view direction.
        vec3.subtract(this._dollyDirection, this.target, this.object.position);
        vec3.normalize(this._dollyDirection, this._dollyDirection);
    }

    /** @internal */ _clampDistance(dist: number): number {
        return Math.max(this.minDistance, Math.min(this.maxDistance, dist));
    }

    // ---- mouse event handlers -------------------------------------------

    _handleMouseDownRotate(event: { clientX: number; clientY: number }): void {
        this._rotateStart[0] = event.clientX;
        this._rotateStart[1] = event.clientY;
    }

    _handleMouseDownDolly(event: { clientX: number; clientY: number }): void {
        this._updateZoomParameters(event.clientX, event.clientY);
        this._dollyStart[0] = event.clientX;
        this._dollyStart[1] = event.clientY;
    }

    _handleMouseDownPan(event: { clientX: number; clientY: number }): void {
        this._panStart[0] = event.clientX;
        this._panStart[1] = event.clientY;
    }

    _handleMouseMoveRotate(event: { clientX: number; clientY: number }): void {
        this._rotateEnd[0] = event.clientX;
        this._rotateEnd[1] = event.clientY;

        this._rotateDelta[0] =
            (this._rotateEnd[0] - this._rotateStart[0]) * this.rotateSpeed;
        this._rotateDelta[1] =
            (this._rotateEnd[1] - this._rotateStart[1]) * this.rotateSpeed;

        const element = this.domElement;
        const height = element ? element.clientHeight : 1;

        this._rotateLeft((_twoPI * this._rotateDelta[0]) / height);
        this._rotateUp((_twoPI * this._rotateDelta[1]) / height);

        this._rotateStart[0] = this._rotateEnd[0];
        this._rotateStart[1] = this._rotateEnd[1];

        this.update();
    }

    _handleMouseMoveDolly(event: { clientX: number; clientY: number }): void {
        this._dollyEnd[0] = event.clientX;
        this._dollyEnd[1] = event.clientY;

        this._dollyDelta[0] = this._dollyEnd[0] - this._dollyStart[0];
        this._dollyDelta[1] = this._dollyEnd[1] - this._dollyStart[1];

        if (this._dollyDelta[1] > 0) {
            this._dollyOut(this._getZoomScale(this._dollyDelta[1]));
        } else if (this._dollyDelta[1] < 0) {
            this._dollyIn(this._getZoomScale(this._dollyDelta[1]));
        }

        this._dollyStart[0] = this._dollyEnd[0];
        this._dollyStart[1] = this._dollyEnd[1];

        this.update();
    }

    _handleMouseMovePan(event: { clientX: number; clientY: number }): void {
        this._panEnd[0] = event.clientX;
        this._panEnd[1] = event.clientY;

        this._panDelta[0] = (this._panEnd[0] - this._panStart[0]) * this.panSpeed;
        this._panDelta[1] = (this._panEnd[1] - this._panStart[1]) * this.panSpeed;

        this._pan(this._panDelta[0], this._panDelta[1]);

        this._panStart[0] = this._panEnd[0];
        this._panStart[1] = this._panEnd[1];

        this.update();
    }

    _handleMouseWheel(event: { clientX: number; clientY: number; deltaY: number }): void {
        this._updateZoomParameters(event.clientX, event.clientY);

        if (event.deltaY < 0) {
            this._dollyIn(this._getZoomScale(event.deltaY));
        } else if (event.deltaY > 0) {
            this._dollyOut(this._getZoomScale(event.deltaY));
        }

        this.update();
    }

    _handleKeyDown(event: KeyboardEvent): void {
        let needsUpdate = false;

        switch (event.code) {
            case this.keys.UP:
                if (event.ctrlKey || event.metaKey || event.shiftKey) {
                    if (this.enableRotate) {
                        const h = this.domElement ? this.domElement.clientHeight : 1;
                        this._rotateUp((_twoPI * this.keyRotateSpeed) / h);
                    }
                } else if (this.enablePan) {
                    this._pan(0, this.keyPanSpeed);
                }
                needsUpdate = true;
                break;

            case this.keys.BOTTOM:
                if (event.ctrlKey || event.metaKey || event.shiftKey) {
                    if (this.enableRotate) {
                        const h = this.domElement ? this.domElement.clientHeight : 1;
                        this._rotateUp((-_twoPI * this.keyRotateSpeed) / h);
                    }
                } else if (this.enablePan) {
                    this._pan(0, -this.keyPanSpeed);
                }
                needsUpdate = true;
                break;

            case this.keys.LEFT:
                if (event.ctrlKey || event.metaKey || event.shiftKey) {
                    if (this.enableRotate) {
                        const h = this.domElement ? this.domElement.clientHeight : 1;
                        this._rotateLeft((_twoPI * this.keyRotateSpeed) / h);
                    }
                } else if (this.enablePan) {
                    this._pan(this.keyPanSpeed, 0);
                }
                needsUpdate = true;
                break;

            case this.keys.RIGHT:
                if (event.ctrlKey || event.metaKey || event.shiftKey) {
                    if (this.enableRotate) {
                        const h = this.domElement ? this.domElement.clientHeight : 1;
                        this._rotateLeft((-_twoPI * this.keyRotateSpeed) / h);
                    }
                } else if (this.enablePan) {
                    this._pan(-this.keyPanSpeed, 0);
                }
                needsUpdate = true;
                break;
        }

        if (needsUpdate) {
            event.preventDefault();
            this.update();
        }
    }

    // ---- touch event handlers -------------------------------------------

    _handleTouchStartRotate(event: PointerEvent): void {
        if (this._pointers.length === 1) {
            this._rotateStart[0] = event.pageX;
            this._rotateStart[1] = event.pageY;
        } else {
            const pos = this._getSecondPointerPosition(event);
            this._rotateStart[0] = 0.5 * (event.pageX + pos[0]);
            this._rotateStart[1] = 0.5 * (event.pageY + pos[1]);
        }
    }

    _handleTouchStartPan(event: PointerEvent): void {
        if (this._pointers.length === 1) {
            this._panStart[0] = event.pageX;
            this._panStart[1] = event.pageY;
        } else {
            const pos = this._getSecondPointerPosition(event);
            this._panStart[0] = 0.5 * (event.pageX + pos[0]);
            this._panStart[1] = 0.5 * (event.pageY + pos[1]);
        }
    }

    _handleTouchStartDolly(event: PointerEvent): void {
        const pos = this._getSecondPointerPosition(event);
        const dx = event.pageX - pos[0];
        const dy = event.pageY - pos[1];
        this._dollyStart[0] = 0;
        this._dollyStart[1] = Math.sqrt(dx * dx + dy * dy);
    }

    _handleTouchStartDollyPan(event: PointerEvent): void {
        if (this.enableZoom) this._handleTouchStartDolly(event);
        if (this.enablePan) this._handleTouchStartPan(event);
    }

    _handleTouchStartDollyRotate(event: PointerEvent): void {
        if (this.enableZoom) this._handleTouchStartDolly(event);
        if (this.enableRotate) this._handleTouchStartRotate(event);
    }

    _handleTouchMoveRotate(event: PointerEvent): void {
        if (this._pointers.length === 1) {
            this._rotateEnd[0] = event.pageX;
            this._rotateEnd[1] = event.pageY;
        } else {
            const pos = this._getSecondPointerPosition(event);
            this._rotateEnd[0] = 0.5 * (event.pageX + pos[0]);
            this._rotateEnd[1] = 0.5 * (event.pageY + pos[1]);
        }

        this._rotateDelta[0] =
            (this._rotateEnd[0] - this._rotateStart[0]) * this.rotateSpeed;
        this._rotateDelta[1] =
            (this._rotateEnd[1] - this._rotateStart[1]) * this.rotateSpeed;

        const h = this.domElement ? this.domElement.clientHeight : 1;
        this._rotateLeft((_twoPI * this._rotateDelta[0]) / h);
        this._rotateUp((_twoPI * this._rotateDelta[1]) / h);

        this._rotateStart[0] = this._rotateEnd[0];
        this._rotateStart[1] = this._rotateEnd[1];
    }

    _handleTouchMovePan(event: PointerEvent): void {
        if (this._pointers.length === 1) {
            this._panEnd[0] = event.pageX;
            this._panEnd[1] = event.pageY;
        } else {
            const pos = this._getSecondPointerPosition(event);
            this._panEnd[0] = 0.5 * (event.pageX + pos[0]);
            this._panEnd[1] = 0.5 * (event.pageY + pos[1]);
        }

        this._panDelta[0] = (this._panEnd[0] - this._panStart[0]) * this.panSpeed;
        this._panDelta[1] = (this._panEnd[1] - this._panStart[1]) * this.panSpeed;

        this._pan(this._panDelta[0], this._panDelta[1]);

        this._panStart[0] = this._panEnd[0];
        this._panStart[1] = this._panEnd[1];
    }

    _handleTouchMoveDolly(event: PointerEvent): void {
        const pos = this._getSecondPointerPosition(event);
        const dx = event.pageX - pos[0];
        const dy = event.pageY - pos[1];
        const distance = Math.sqrt(dx * dx + dy * dy);

        this._dollyEnd[0] = 0;
        this._dollyEnd[1] = distance;

        this._dollyDelta[0] = 0;
        this._dollyDelta[1] = Math.pow(
            this._dollyEnd[1] / this._dollyStart[1],
            this.zoomSpeed,
        );

        this._dollyOut(this._dollyDelta[1]);
        this._dollyStart[0] = this._dollyEnd[0];
        this._dollyStart[1] = this._dollyEnd[1];

        const centerX = (event.pageX + pos[0]) * 0.5;
        const centerY = (event.pageY + pos[1]) * 0.5;
        this._updateZoomParameters(centerX, centerY);
    }

    _handleTouchMoveDollyPan(event: PointerEvent): void {
        if (this.enableZoom) this._handleTouchMoveDolly(event);
        if (this.enablePan) this._handleTouchMovePan(event);
    }

    _handleTouchMoveDollyRotate(event: PointerEvent): void {
        if (this.enableZoom) this._handleTouchMoveDolly(event);
        if (this.enableRotate) this._handleTouchMoveRotate(event);
    }

    // ---- pointer tracking -----------------------------------------------

    _addPointer(event: PointerEvent): void {
        this._pointers.push(event.pointerId);
    }

    _removePointer(event: PointerEvent): void {
        delete this._pointerPositions[event.pointerId];
        const idx = this._pointers.indexOf(event.pointerId);
        if (idx !== -1) this._pointers.splice(idx, 1);
    }

    _isTrackingPointer(event: PointerEvent): boolean {
        return this._pointers.includes(event.pointerId);
    }

    _trackPointer(event: PointerEvent): void {
        let pos = this._pointerPositions[event.pointerId];
        if (pos === undefined) {
            pos = vec2.create();
            this._pointerPositions[event.pointerId] = pos;
        }
        pos[0] = event.pageX;
        pos[1] = event.pageY;
    }

    _getSecondPointerPosition(event: PointerEvent): Vec2 {
        const pointerId =
            event.pointerId === this._pointers[0] ? this._pointers[1] : this._pointers[0];
        return this._pointerPositions[pointerId] ?? vec2.create();
    }

    _customWheelEvent(event: WheelEvent): { clientX: number; clientY: number; deltaY: number } {
        const newEvent = {
            clientX: event.clientX,
            clientY: event.clientY,
            deltaY: event.deltaY,
        };

        switch (event.deltaMode) {
            case 1: // LINE_MODE
                newEvent.deltaY *= 16;
                break;
            case 2: // PAGE_MODE
                newEvent.deltaY *= 100;
                break;
        }

        // Pinch-to-zoom via ctrl key + scroll on trackpads
        if (event.ctrlKey && !this._controlActive) {
            newEvent.deltaY *= 10;
        }

        return newEvent;
    }
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function _isPerspective(camera: Camera): camera is PerspectiveCamera {
    return typeof (camera as PerspectiveCamera).fov === 'number';
}

// ---------------------------------------------------------------------------
// Module-level event handler functions (bound in constructor)
// ---------------------------------------------------------------------------

function _onPointerDown(this: OrbitControls, event: PointerEvent): void {
    if (!this.enabled) return;

    if (this._pointers.length === 0) {
        const el = this.domElement!;
        el.setPointerCapture(event.pointerId);
        const doc = el.ownerDocument ?? el;
        doc.addEventListener('pointermove', this._onPointerMove as EventListener);
        doc.addEventListener('pointerup', this._onPointerUp as EventListener);
    }

    if (this._isTrackingPointer(event)) return;
    this._addPointer(event);

    if (event.pointerType === 'touch') {
        this._onTouchStart(event);
    } else {
        this._onMouseDown(event);
    }

    if (this._cursorStyle === 'grab') {
        this.domElement!.style.cursor = 'grabbing';
    }
}

function _onPointerMove(this: OrbitControls, event: PointerEvent): void {
    if (!this.enabled) return;
    if (event.pointerType === 'touch') {
        this._onTouchMove(event);
    } else {
        this._onMouseMove(event);
    }
}

function _onPointerUp(this: OrbitControls, event: PointerEvent): void {
    this._removePointer(event);

    if (this._pointers.length === 0) {
        const el = this.domElement!;
        el.releasePointerCapture(event.pointerId);
        const doc = el.ownerDocument ?? el;
        doc.removeEventListener('pointermove', this._onPointerMove as EventListener);
        doc.removeEventListener('pointerup', this._onPointerUp as EventListener);

        this.dispatchEvent('end');
        this.state = STATE.NONE;

        if (this._cursorStyle === 'grab') {
            el.style.cursor = 'grab';
        }
    } else if (this._pointers.length === 1) {
        const pointerId = this._pointers[0];
        const pos = this._pointerPositions[pointerId];
        if (pos) {
            this._onTouchStart({
                pointerId,
                pageX: pos[0],
                pageY: pos[1],
                pointerType: 'touch',
            } as PointerEvent);
        }
    }
}

function _onMouseDown(this: OrbitControls, event: PointerEvent): void {
    let mouseAction: number;

    switch (event.button) {
        case 0:
            mouseAction = this.mouseButtons.LEFT;
            break;
        case 1:
            mouseAction = this.mouseButtons.MIDDLE;
            break;
        case 2:
            mouseAction = this.mouseButtons.RIGHT;
            break;
        default:
            mouseAction = -1;
    }

    switch (mouseAction) {
        case MOUSE.DOLLY:
            if (!this.enableZoom) return;
            this._handleMouseDownDolly(event);
            this.state = STATE.DOLLY;
            break;

        case MOUSE.ROTATE:
            if (event.ctrlKey || event.metaKey || event.shiftKey) {
                if (!this.enablePan) return;
                this._handleMouseDownPan(event);
                this.state = STATE.PAN;
            } else {
                if (!this.enableRotate) return;
                this._handleMouseDownRotate(event);
                this.state = STATE.ROTATE;
            }
            break;

        case MOUSE.PAN:
            if (event.ctrlKey || event.metaKey || event.shiftKey) {
                if (!this.enableRotate) return;
                this._handleMouseDownRotate(event);
                this.state = STATE.ROTATE;
            } else {
                if (!this.enablePan) return;
                this._handleMouseDownPan(event);
                this.state = STATE.PAN;
            }
            break;

        default:
            this.state = STATE.NONE;
    }

    if (this.state !== STATE.NONE) {
        this.dispatchEvent('start');
    }
}

function _onMouseMove(this: OrbitControls, event: PointerEvent): void {
    switch (this.state) {
        case STATE.ROTATE:
            if (!this.enableRotate) return;
            this._handleMouseMoveRotate(event);
            break;
        case STATE.DOLLY:
            if (!this.enableZoom) return;
            this._handleMouseMoveDolly(event);
            break;
        case STATE.PAN:
            if (!this.enablePan) return;
            this._handleMouseMovePan(event);
            break;
    }
}

function _onMouseWheel(this: OrbitControls, event: WheelEvent): void {
    if (!this.enabled || !this.enableZoom || this.state !== STATE.NONE) return;

    event.preventDefault();
    this.dispatchEvent('start');
    this._handleMouseWheel(this._customWheelEvent(event));
    this.dispatchEvent('end');
}

function _onKeyDown(this: OrbitControls, event: KeyboardEvent): void {
    if (!this.enabled) return;
    this._handleKeyDown(event);
}

function _onTouchStart(this: OrbitControls, event: PointerEvent): void {
    this._trackPointer(event);

    switch (this._pointers.length) {
        case 1:
            switch (this.touches.ONE) {
                case TOUCH.ROTATE:
                    if (!this.enableRotate) return;
                    this._handleTouchStartRotate(event);
                    this.state = STATE.TOUCH_ROTATE;
                    break;
                case TOUCH.PAN:
                    if (!this.enablePan) return;
                    this._handleTouchStartPan(event);
                    this.state = STATE.TOUCH_PAN;
                    break;
                default:
                    this.state = STATE.NONE;
            }
            break;

        case 2:
            switch (this.touches.TWO) {
                case TOUCH.DOLLY_PAN:
                    if (!this.enableZoom && !this.enablePan) return;
                    this._handleTouchStartDollyPan(event);
                    this.state = STATE.TOUCH_DOLLY_PAN;
                    break;
                case TOUCH.DOLLY_ROTATE:
                    if (!this.enableZoom && !this.enableRotate) return;
                    this._handleTouchStartDollyRotate(event);
                    this.state = STATE.TOUCH_DOLLY_ROTATE;
                    break;
                default:
                    this.state = STATE.NONE;
            }
            break;

        default:
            this.state = STATE.NONE;
    }

    if (this.state !== STATE.NONE) {
        this.dispatchEvent('start');
    }
}

function _onTouchMove(this: OrbitControls, event: PointerEvent): void {
    this._trackPointer(event);

    switch (this.state) {
        case STATE.TOUCH_ROTATE:
            if (!this.enableRotate) return;
            this._handleTouchMoveRotate(event);
            this.update();
            break;
        case STATE.TOUCH_PAN:
            if (!this.enablePan) return;
            this._handleTouchMovePan(event);
            this.update();
            break;
        case STATE.TOUCH_DOLLY_PAN:
            if (!this.enableZoom && !this.enablePan) return;
            this._handleTouchMoveDollyPan(event);
            this.update();
            break;
        case STATE.TOUCH_DOLLY_ROTATE:
            if (!this.enableZoom && !this.enableRotate) return;
            this._handleTouchMoveDollyRotate(event);
            this.update();
            break;
        default:
            this.state = STATE.NONE;
    }
}

function _onContextMenu(this: OrbitControls, event: Event): void {
    if (!this.enabled) return;
    event.preventDefault();
}

function _interceptControlDown(this: OrbitControls, event: KeyboardEvent): void {
    if (event.key === 'Control') {
        this._controlActive = true;
        const doc = this.domElement!.getRootNode() as EventTarget;
        doc.addEventListener('keyup', this._interceptControlUp as EventListener, {
            passive: true,
            capture: true,
        });
    }
}

function _interceptControlUp(this: OrbitControls, event: KeyboardEvent): void {
    if (event.key === 'Control') {
        this._controlActive = false;
        const doc = this.domElement!.getRootNode() as EventTarget;
        doc.removeEventListener('keyup', this._interceptControlUp as EventListener, {
            capture: true,
        });
    }
}
