import { type Vec3, type Vec2, type Quat, type Spherical } from 'mathcat';
import type { Camera } from '../camera/camera';
declare const STATE: {
    readonly NONE: -1;
    readonly ROTATE: 0;
    readonly DOLLY: 1;
    readonly PAN: 2;
    readonly TOUCH_ROTATE: 3;
    readonly TOUCH_PAN: 4;
    readonly TOUCH_DOLLY_PAN: 5;
    readonly TOUCH_DOLLY_ROTATE: 6;
};
type StateValue = (typeof STATE)[keyof typeof STATE];
export declare const MOUSE: {
    readonly ROTATE: 0;
    readonly DOLLY: 1;
    readonly PAN: 2;
};
export type MouseAction = (typeof MOUSE)[keyof typeof MOUSE];
export declare const TOUCH: {
    readonly ROTATE: 0;
    readonly PAN: 1;
    readonly DOLLY_PAN: 2;
    readonly DOLLY_ROTATE: 3;
};
export type TouchAction = (typeof TOUCH)[keyof typeof TOUCH];
export type OrbitControlsEventType = 'change' | 'start' | 'end';
export interface OrbitControlsEvent {
    type: OrbitControlsEventType;
    target: OrbitControls;
}
export type OrbitControlsEventListener = (event: OrbitControlsEvent) => void;
/**
 * OrbitControls
 *
 * Orbit: left mouse / one-finger touch.
 * Zoom:  middle mouse / wheel / two-finger pinch.
 * Pan:   right mouse / left mouse + ctrl|meta|shift / two-finger drag / arrow keys.
 *
 * Call `update()` each frame when `enableDamping` or `autoRotate` are `true`.
 */
export declare class OrbitControls {
    /** The camera being controlled. */
    readonly object: Camera;
    /** The DOM element used for event listeners. */
    domElement: HTMLElement | null;
    /** Whether the controls are active. */
    enabled: boolean;
    /** The point the camera orbits around. */
    target: Vec3;
    /**
     * The focus point of the `minTargetRadius` / `maxTargetRadius` limits.
     */
    cursor: Vec3;
    minDistance: number;
    maxDistance: number;
    minZoom: number;
    maxZoom: number;
    minTargetRadius: number;
    maxTargetRadius: number;
    /** Minimum polar angle (radians), default 0. */
    minPolarAngle: number;
    /** Maximum polar angle (radians), default Math.PI. */
    maxPolarAngle: number;
    minAzimuthAngle: number;
    maxAzimuthAngle: number;
    enableDamping: boolean;
    dampingFactor: number;
    enableZoom: boolean;
    zoomSpeed: number;
    zoomToCursor: boolean;
    enableRotate: boolean;
    rotateSpeed: number;
    keyRotateSpeed: number;
    enablePan: boolean;
    panSpeed: number;
    /** When true the camera pans in screen space; otherwise in world-up plane. */
    screenSpacePanning: boolean;
    keyPanSpeed: number;
    autoRotate: boolean;
    /** 2.0 ≈ 30 s per orbit at 60 fps */
    autoRotateSpeed: number;
    keys: {
        LEFT: string;
        UP: string;
        RIGHT: string;
        BOTTOM: string;
    };
    mouseButtons: {
        LEFT: MouseAction;
        MIDDLE: MouseAction;
        RIGHT: MouseAction;
    };
    touches: {
        ONE: TouchAction;
        TWO: TouchAction;
    };
    target0: Vec3;
    position0: Vec3;
    zoom0: number;
    state: StateValue;
    /** @internal */ _cursorStyle: 'auto' | 'grab';
    /** @internal */ _domElementKeyEvents: EventTarget | null;
    /** @internal */ _lastPosition: Vec3;
    /** @internal */ _lastQuaternion: Quat;
    /** @internal */ _lastTargetPosition: Vec3;
    /** @internal */ _quat: Quat;
    /** @internal */ _quatInverse: Quat;
    /** @internal */ _spherical: Spherical;
    /** @internal */ _sphericalDelta: Spherical;
    /** @internal */ _scale: number;
    /** @internal */ _panOffset: Vec3;
    /** @internal */ _rotateStart: Vec2;
    /** @internal */ _rotateEnd: Vec2;
    /** @internal */ _rotateDelta: Vec2;
    /** @internal */ _panStart: Vec2;
    /** @internal */ _panEnd: Vec2;
    /** @internal */ _panDelta: Vec2;
    /** @internal */ _dollyStart: Vec2;
    /** @internal */ _dollyEnd: Vec2;
    /** @internal */ _dollyDelta: Vec2;
    /** @internal */ _dollyDirection: Vec3;
    /** @internal */ _mouse: Vec2;
    /** @internal */ _performCursorZoom: boolean;
    /** @internal */ _pointers: number[];
    /** @internal */ _pointerPositions: Record<number, Vec2>;
    /** @internal */ _controlActive: boolean;
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
    private _listeners;
    constructor(object: Camera, domElement?: HTMLElement | null);
    addEventListener(type: OrbitControlsEventType, listener: OrbitControlsEventListener): void;
    removeEventListener(type: OrbitControlsEventType, listener: OrbitControlsEventListener): void;
    dispatchEvent(type: OrbitControlsEventType): void;
    get cursorStyle(): 'auto' | 'grab';
    set cursorStyle(type: 'auto' | 'grab');
    connect(element: HTMLElement): void;
    disconnect(): void;
    dispose(): void;
    getPolarAngle(): number;
    getAzimuthalAngle(): number;
    getDistance(): number;
    listenToKeyEvents(domElement: EventTarget): void;
    stopListenToKeyEvents(): void;
    saveState(): void;
    reset(): void;
    pan(deltaX: number, deltaY: number): void;
    dollyIn(dollyScale: number): void;
    dollyOut(dollyScale: number): void;
    rotateLeft(angle: number): void;
    rotateUp(angle: number): void;
    update(deltaTime?: number | null): boolean;
    /** @internal */ _getAutoRotationAngle(deltaTime: number | null): number;
    /** @internal */ _getZoomScale(delta: number): number;
    _rotateLeft(angle: number): void;
    _rotateUp(angle: number): void;
    /** @internal */ _panLeft(distance: number, objectMatrix: ArrayLike<number>): void;
    /** @internal */ _panUp(distance: number, objectMatrix: ArrayLike<number>): void;
    _pan(deltaX: number, deltaY: number): void;
    _dollyOut(dollyScale: number): void;
    _dollyIn(dollyScale: number): void;
    /** @internal */ _updateZoomParameters(x: number, y: number): void;
    /** @internal */ _clampDistance(dist: number): number;
    _handleMouseDownRotate(event: {
        clientX: number;
        clientY: number;
    }): void;
    _handleMouseDownDolly(event: {
        clientX: number;
        clientY: number;
    }): void;
    _handleMouseDownPan(event: {
        clientX: number;
        clientY: number;
    }): void;
    _handleMouseMoveRotate(event: {
        clientX: number;
        clientY: number;
    }): void;
    _handleMouseMoveDolly(event: {
        clientX: number;
        clientY: number;
    }): void;
    _handleMouseMovePan(event: {
        clientX: number;
        clientY: number;
    }): void;
    _handleMouseWheel(event: {
        clientX: number;
        clientY: number;
        deltaY: number;
    }): void;
    _handleKeyDown(event: KeyboardEvent): void;
    _handleTouchStartRotate(event: PointerEvent): void;
    _handleTouchStartPan(event: PointerEvent): void;
    _handleTouchStartDolly(event: PointerEvent): void;
    _handleTouchStartDollyPan(event: PointerEvent): void;
    _handleTouchStartDollyRotate(event: PointerEvent): void;
    _handleTouchMoveRotate(event: PointerEvent): void;
    _handleTouchMovePan(event: PointerEvent): void;
    _handleTouchMoveDolly(event: PointerEvent): void;
    _handleTouchMoveDollyPan(event: PointerEvent): void;
    _handleTouchMoveDollyRotate(event: PointerEvent): void;
    _addPointer(event: PointerEvent): void;
    _removePointer(event: PointerEvent): void;
    _isTrackingPointer(event: PointerEvent): boolean;
    _trackPointer(event: PointerEvent): void;
    _getSecondPointerPosition(event: PointerEvent): Vec2;
    _customWheelEvent(event: WheelEvent): {
        clientX: number;
        clientY: number;
        deltaY: number;
    };
}
export {};
