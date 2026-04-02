import { type Vec3, type Quat } from 'mathcat';
import { Object3D } from '../core/object3d';
import { Camera } from '../camera/camera';
import { Raycaster } from '../math/raycaster';
import { type Topic } from '../utils/topic';
export type TransformMode = 'translate' | 'rotate' | 'scale';
export type TransformSpace = 'world' | 'local';
declare class TransformControlsRoot extends Object3D {
    controls: TransformControls;
    constructor(controls: TransformControls);
    updateWorldMatrix(): void;
    dispose(): void;
}
export declare class TransformControls {
    camera: Camera;
    domElement: HTMLElement | null;
    object: Object3D | undefined;
    enabled: boolean;
    mode: TransformMode;
    space: TransformSpace;
    axis: string | null;
    dragging: boolean;
    size: number;
    showX: boolean;
    showY: boolean;
    showZ: boolean;
    translationSnap: number | null;
    rotationSnap: number | null;
    scaleSnap: number | null;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
    worldPosition: Vec3;
    worldPositionStart: Vec3;
    worldQuaternion: Quat;
    worldQuaternionStart: Quat;
    cameraPosition: Vec3;
    cameraQuaternion: Quat;
    pointStart: Vec3;
    pointEnd: Vec3;
    rotationAxis: Vec3;
    rotationAngle: number;
    eye: Vec3;
    _offset: Vec3;
    _startNorm: Vec3;
    _endNorm: Vec3;
    _cameraScale: Vec3;
    _parentPosition: Vec3;
    _parentQuaternion: Quat;
    _parentQuaternionInv: Quat;
    _parentScale: Vec3;
    _worldScaleStart: Vec3;
    _worldQuaternionInv: Quat;
    _worldScale: Vec3;
    _positionStart: Vec3;
    _quaternionStart: Quat;
    _scaleStart: Vec3;
    onChange: Topic<[]>;
    onMouseDown: Topic<[{
        mode: TransformMode;
    }]>;
    onMouseUp: Topic<[{
        mode: TransformMode;
    }]>;
    onObjectChange: Topic<[]>;
    private _root;
    private _gizmo;
    private _plane;
    private _onPointerDown;
    private _onPointerHover;
    private _onPointerMove;
    private _onPointerUp;
    constructor(camera: Camera, domElement?: HTMLElement);
    getHelper(): TransformControlsRoot;
    connect(element: HTMLElement): void;
    disconnect(): void;
    attach(object: Object3D): this;
    detach(): this;
    setMode(mode: TransformMode): void;
    setSpace(space: TransformSpace): void;
    setSize(size: number): void;
    setTranslationSnap(snap: number | null): void;
    setRotationSnap(snap: number | null): void;
    setScaleSnap(snap: number | null): void;
    getRaycaster(): Raycaster;
    getMode(): TransformMode;
    reset(): void;
    dispose(): void;
    pointerHover(pointer: {
        x: number;
        y: number;
        button: number;
    }): void;
    pointerDown(pointer: {
        x: number;
        y: number;
        button: number;
    }): void;
    pointerMove(pointer: {
        x: number;
        y: number;
        button: number;
    }): void;
    pointerUp(pointer: {
        x: number;
        y: number;
        button: number;
    }): void;
    /**
     * Sync internal state to gizmo and plane.
     * Call this after any property change that affects the gizmo display.
     */
    private _syncState;
}
export {};
