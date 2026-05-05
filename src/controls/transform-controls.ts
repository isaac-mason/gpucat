import { vec3, quat, mat4, euler, type Vec3, type Quat, type Mat4 } from 'mathcat';
import { Object3D } from '../core/object3d';
import { Mesh } from '../objects/mesh';
import { Geometry } from '../geometry/geometry';
import { Material } from '../material/material';
import { Uniform } from '../core/uniform';
import * as d from '../schema/schema';
import { Camera } from '../camera/camera';
import { Raycaster, type Intersection } from '../math/raycaster';
import { topic, type Topic } from '../utils/topic';
import { createBoxGeometry, createCylinderGeometry, createTorusGeometry, createOctahedronGeometry, createPlaneGeometry, createSphereGeometry } from '../geometry/geometry-helpers';
import { positionClip } from '../nodes/nodes';
import { uniform } from '../nodes/nodes';
import { createVertexBuffer, createIndexBuffer } from '../core/gpu-buffer';
import { OrthographicCamera } from '../camera/orthographic-camera';

// ============================================================================
// Types
// ============================================================================

export type TransformMode = 'translate' | 'rotate' | 'scale';
export type TransformSpace = 'world' | 'local';

// ============================================================================
// Gizmo Material Factory
// ============================================================================

function createGizmoMaterial(options: {
    color: [number, number, number];
    opacity?: number;
    depthTest?: boolean;
    depthWrite?: boolean;
    cullMode?: GPUCullMode;
}): Material {
    const opacity = options.opacity ?? 1;
    const colorUniform = uniform('color', d.vec4f);
    const fragment = colorUniform;

    const mat = new Material({
        vertex: positionClip,
        fragment,
        transparent: true,
        depthTest: options.depthTest ?? false,
        depthWrite: options.depthWrite ?? false,
        cullMode: options.cullMode ?? 'none',
        blend: {
            color: {
                srcFactor: 'src-alpha',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
            },
            alpha: {
                srcFactor: 'one',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
            },
        },
    });

    mat.uniforms.set('color', new Uniform(d.vec4f, [
        options.color[0], options.color[1], options.color[2], opacity,
    ]));

    return mat;
}

// ============================================================================
// Geometry Utilities
// ============================================================================

/**
 * Bakes a transform matrix into geometry vertex positions and normals.
 * This modifies the underlying buffer data in-place.
 */
function applyMatrix4ToGeometry(geometry: Geometry, matrix: Mat4): void {
    const posBuf = geometry.getBuffer('position');
    if (!posBuf?.array) return;
    const positions = posBuf.array as Float32Array;

    const normalBuf = geometry.getBuffer('normal');
    const normals = normalBuf?.array as Float32Array | undefined;

    // normal matrix for transforming normals
    const normalMat: Mat4 = mat4.create();
    mat4.invert(normalMat, matrix);
    mat4.transpose(normalMat, normalMat);

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    const v: Vec3 = [0, 0, 0];
    for (let i = 0; i < positions.length; i += 3) {
        v[0] = positions[i];
        v[1] = positions[i + 1];
        v[2] = positions[i + 2];
        vec3.transformMat4(v, v, matrix);
        positions[i] = v[0];
        positions[i + 1] = v[1];
        positions[i + 2] = v[2];

        if (v[0] < minX) minX = v[0]; if (v[0] > maxX) maxX = v[0];
        if (v[1] < minY) minY = v[1]; if (v[1] > maxY) maxY = v[1];
        if (v[2] < minZ) minZ = v[2]; if (v[2] > maxZ) maxZ = v[2];
    }

    if (normals) {
        for (let i = 0; i < normals.length; i += 3) {
            v[0] = normals[i];
            v[1] = normals[i + 1];
            v[2] = normals[i + 2];
            // transform by normal matrix (upper 3x3 of inverse-transpose)
            const x = normalMat[0] * v[0] + normalMat[4] * v[1] + normalMat[8] * v[2];
            const y = normalMat[1] * v[0] + normalMat[5] * v[1] + normalMat[9] * v[2];
            const z = normalMat[2] * v[0] + normalMat[6] * v[1] + normalMat[10] * v[2];
            const len = Math.sqrt(x * x + y * y + z * z) || 1;
            normals[i] = x / len;
            normals[i + 1] = y / len;
            normals[i + 2] = z / len;
        }
    }

    // Recompute bounding box and sphere from transformed positions
    if (positions.length >= 3) {
        geometry.boundingBox = [minX, minY, minZ, maxX, maxY, maxZ];

        const cx = (minX + maxX) * 0.5;
        const cy = (minY + maxY) * 0.5;
        const cz = (minZ + maxZ) * 0.5;
        let maxDistSq = 0;
        for (let i = 0; i < positions.length; i += 3) {
            const dx = positions[i] - cx;
            const dy = positions[i + 1] - cy;
            const dz = positions[i + 2] - cz;
            const distSq = dx * dx + dy * dy + dz * dz;
            if (distSq > maxDistSq) maxDistSq = distSq;
        }
        geometry.boundingSphere = { center: [cx, cy, cz], radius: Math.sqrt(maxDistSq) };
    }
}

// ============================================================================
// Raycaster helper — intersect including invisible objects
// ============================================================================

function intersectObjectWithRay(
    object: Object3D,
    raycaster: Raycaster,
    includeInvisible = false,
): Intersection | null {
    const allIntersections = intersectObjectRecursive(object, raycaster, [], true, includeInvisible);
    allIntersections.sort((a, b) => a.distance - b.distance);

    for (let i = 0; i < allIntersections.length; i++) {
        if (allIntersections[i].object.visible || includeInvisible) {
            return allIntersections[i];
        }
    }

    return null;
}

function intersectObjectRecursive(
    object: Object3D,
    raycaster: Raycaster,
    intersects: Intersection[],
    recursive: boolean,
    includeInvisible: boolean,
): Intersection[] {
    if (!object.visible && !includeInvisible) return intersects;

    object.raycast(raycaster, intersects);

    if (recursive) {
        for (const child of object.children) {
            intersectObjectRecursive(child, raycaster, intersects, true, includeInvisible);
        }
    }

    return intersects;
}

// ============================================================================
// Reusable temp objects
// ============================================================================

const _raycaster = new Raycaster();

const _tempVec = vec3.create();
const _tempVec2 = vec3.create();
const _tempQuat = quat.create();
const _tempQuat2 = quat.create();
const _identityQuat: Quat = [0, 0, 0, 1];
const _tempMat = mat4.create();

const _unitX: Vec3 = [1, 0, 0];
const _unitY: Vec3 = [0, 1, 0];
const _unitZ: Vec3 = [0, 0, 1];
const _zeroVec: Vec3 = [0, 0, 0];

const _alignVector: Vec3 = [0, 1, 0];
const _dirVector: Vec3 = [0, 0, 0];

const _v1: Vec3 = [0, 0, 0];
const _v2: Vec3 = [0, 0, 0];
const _v3: Vec3 = [0, 0, 0];

// ============================================================================
// TransformControlsPlane
// ============================================================================

class TransformControlsPlane extends Mesh {
    // synced from controls via defineProperty
    mode: TransformMode = 'translate';
    axis: string | null = null;
    space: TransformSpace = 'world';
    worldPosition: Vec3 = [0, 0, 0];
    worldQuaternion: Quat = [0, 0, 0, 1];
    eye: Vec3 = [0, 0, 1];
    cameraQuaternion: Quat = [0, 0, 0, 1];

    constructor() {
        const planeGeom = createPlaneGeometry(100000, 100000, 2, 2);
        const planeMat = createGizmoMaterial({
            color: [1, 1, 1],
            opacity: 0.1,
            depthTest: false,
            depthWrite: false,
        });
        // make it invisible for rendering but still raycast-able
        super(planeGeom, planeMat);
        this.visible = false;
    }

    override updateWorldMatrix(): void {
        let space: TransformSpace = this.space;

        vec3.copy(this.position, this.worldPosition);

        if (this.mode === 'scale') space = 'local';

        const q = space === 'local' ? this.worldQuaternion : _identityQuat;

        vec3.transformQuat(_v1, _unitX, q);
        vec3.transformQuat(_v2, _unitY, q);
        vec3.transformQuat(_v3, _unitZ, q);

        // align the plane for current transform mode, axis and space
        vec3.copy(_alignVector, _v2);

        switch (this.mode) {
            case 'translate':
            case 'scale':
                switch (this.axis) {
                    case 'X':
                        vec3.cross(_alignVector, this.eye, _v1);
                        vec3.cross(_dirVector, _v1, _alignVector);
                        break;
                    case 'Y':
                        vec3.cross(_alignVector, this.eye, _v2);
                        vec3.cross(_dirVector, _v2, _alignVector);
                        break;
                    case 'Z':
                        vec3.cross(_alignVector, this.eye, _v3);
                        vec3.cross(_dirVector, _v3, _alignVector);
                        break;
                    case 'XY':
                        vec3.copy(_dirVector, _v3);
                        break;
                    case 'YZ':
                        vec3.copy(_dirVector, _v1);
                        break;
                    case 'XZ':
                        vec3.copy(_alignVector, _v3);
                        vec3.copy(_dirVector, _v2);
                        break;
                    case 'XYZ':
                    case 'E':
                        vec3.set(_dirVector, 0, 0, 0);
                        break;
                }
                break;
            case 'rotate':
            default:
                vec3.set(_dirVector, 0, 0, 0);
        }

        if (vec3.length(_dirVector) === 0) {
            // in rotate mode, make the plane parallel to camera
            quat.copy(this.quaternion, this.cameraQuaternion);
        } else {
            mat4.targetTo(_tempMat, _zeroVec, _dirVector, _alignVector);
            quat.fromMat4(this.quaternion, _tempMat);
        }

        super.updateWorldMatrix();
    }
}

// ============================================================================
// GizmoMesh — Mesh with extra tag/name fields for gizmo logic
// ============================================================================

class GizmoMesh extends Mesh {
    tag: string | undefined;
    // store original color/opacity for highlight restore
    _color: [number, number, number] | null = null;
    _opacity: number | null = null;

    constructor(geometry: Geometry, material: Material) {
        super(geometry, material);
    }

    setColor(r: number, g: number, b: number, a: number): void {
        const u = this.material.uniforms.get('color');
        if (u) u.value = [r, g, b, a];
    }

    getColor(): [number, number, number, number] {
        const u = this.material.uniforms.get('color');
        const v = u?.value as number[] | null;
        return v ? [v[0], v[1], v[2], v[3]] : [1, 1, 1, 1];
    }
}

// ============================================================================
// TransformControlsGizmo
// ============================================================================

class TransformControlsGizmo extends Object3D {
    gizmo: Record<TransformMode, Object3D> = {} as any;
    picker: Record<TransformMode, Object3D> = {} as any;
    helper: Record<TransformMode, Object3D> = {} as any;

    // synced from controls via defineProperty
    mode: TransformMode = 'translate';
    space: TransformSpace = 'world';
    axis: string | null = null;
    worldPosition: Vec3 = [0, 0, 0];
    worldQuaternion: Quat = [0, 0, 0, 1];
    worldPositionStart: Vec3 = [0, 0, 0];
    worldQuaternionStart: Quat = [0, 0, 0, 1];
    cameraPosition: Vec3 = [0, 0, 0];
    eye: Vec3 = [0, 0, 1];
    rotationAxis: Vec3 = [0, 0, 0];
    camera: Camera | null = null;
    enabled: boolean = true;
    dragging: boolean = false;
    showX: boolean = true;
    showY: boolean = true;
    showZ: boolean = true;
    size: number = 1;
    rotationAngle: number = 0;

    // highlight color
    private _activeColor: [number, number, number] = [1, 1, 0];

    constructor() {
        super();

        // materials
        const matRed = createGizmoMaterial({ color: [1, 0, 0] });
        const matGreen = createGizmoMaterial({ color: [0, 1, 0] });
        const matBlue = createGizmoMaterial({ color: [0, 0, 1] });
        const matRedTransparent = createGizmoMaterial({ color: [1, 0, 0], opacity: 0.5 });
        const matGreenTransparent = createGizmoMaterial({ color: [0, 1, 0], opacity: 0.5 });
        const matBlueTransparent = createGizmoMaterial({ color: [0, 0, 1], opacity: 0.5 });
        const matWhiteTransparent = createGizmoMaterial({ color: [1, 1, 1], opacity: 0.25 });
        const matYellowTransparent = createGizmoMaterial({ color: [1, 1, 0], opacity: 0.25 });
        const matGray = createGizmoMaterial({ color: [0.47, 0.47, 0.47] });
        const matInvisible = createGizmoMaterial({ color: [1, 1, 1], opacity: 0.15 });

        // reusable geometries
        const arrowGeometry = createCylinderGeometry(0, 0.04, 0.1, 12);
        applyMatrix4ToGeometry(arrowGeometry, mat4.fromTranslation(mat4.create(), [0, 0.05, 0]));

        const scaleHandleGeometry = createBoxGeometry(0.08, 0.08, 0.08);
        applyMatrix4ToGeometry(scaleHandleGeometry, mat4.fromTranslation(mat4.create(), [0, 0.04, 0]));

        const lineGeometry2 = createCylinderGeometry(0.0075, 0.0075, 0.5, 3);
        applyMatrix4ToGeometry(lineGeometry2, mat4.fromTranslation(mat4.create(), [0, 0.25, 0]));

        function CircleGeometry(radius: number, arc: number): Geometry {
            const geom = createTorusGeometry(radius, 0.0075, 3, 64, arc * Math.PI * 2);
            // Match Three.js: geometry.rotateY(π/2) then geometry.rotateX(π/2)
            // Sequential application: v' = Rx * Ry * v
            const m = mat4.create();
            mat4.rotateX(m, m, Math.PI / 2);
            mat4.rotateY(m, m, Math.PI / 2);
            applyMatrix4ToGeometry(geom, m);
            return geom;
        }

        type GizmoEntry = [Mesh, Vec3 | null, Vec3 | null, Vec3 | null, string?];
        type GizmoMap = Record<string, GizmoEntry[]>;

        // --- Gizmo definitions ---

        const gizmoTranslate: GizmoMap = {
            X: [
                [new Mesh(arrowGeometry, matRed), [0.5, 0, 0], [0, 0, -Math.PI / 2], null],
                [new Mesh(arrowGeometry, matRed), [-0.5, 0, 0], [0, 0, Math.PI / 2], null],
                [new Mesh(lineGeometry2, matRed), [0, 0, 0], [0, 0, -Math.PI / 2], null],
            ],
            Y: [
                [new Mesh(arrowGeometry, matGreen), [0, 0.5, 0], null, null],
                [new Mesh(arrowGeometry, matGreen), [0, -0.5, 0], [Math.PI, 0, 0], null],
                [new Mesh(lineGeometry2, matGreen), null, null, null],
            ],
            Z: [
                [new Mesh(arrowGeometry, matBlue), [0, 0, 0.5], [Math.PI / 2, 0, 0], null],
                [new Mesh(arrowGeometry, matBlue), [0, 0, -0.5], [-Math.PI / 2, 0, 0], null],
                [new Mesh(lineGeometry2, matBlue), null, [Math.PI / 2, 0, 0], null],
            ],
            XYZ: [
                [new Mesh(createOctahedronGeometry(0.1, 0), matWhiteTransparent), [0, 0, 0], null, null],
            ],
            XY: [
                [new Mesh(createBoxGeometry(0.15, 0.15, 0.01), matBlueTransparent), [0.15, 0.15, 0], null, null],
            ],
            YZ: [
                [new Mesh(createBoxGeometry(0.15, 0.15, 0.01), matRedTransparent), [0, 0.15, 0.15], [0, Math.PI / 2, 0], null],
            ],
            XZ: [
                [new Mesh(createBoxGeometry(0.15, 0.15, 0.01), matGreenTransparent), [0.15, 0, 0.15], [-Math.PI / 2, 0, 0], null],
            ],
        };

        const pickerTranslate: GizmoMap = {
            X: [
                [new Mesh(createCylinderGeometry(0.2, 0, 0.6, 4), matInvisible), [0.3, 0, 0], [0, 0, -Math.PI / 2], null],
                [new Mesh(createCylinderGeometry(0.2, 0, 0.6, 4), matInvisible), [-0.3, 0, 0], [0, 0, Math.PI / 2], null],
            ],
            Y: [
                [new Mesh(createCylinderGeometry(0.2, 0, 0.6, 4), matInvisible), [0, 0.3, 0], null, null],
                [new Mesh(createCylinderGeometry(0.2, 0, 0.6, 4), matInvisible), [0, -0.3, 0], [0, 0, Math.PI], null],
            ],
            Z: [
                [new Mesh(createCylinderGeometry(0.2, 0, 0.6, 4), matInvisible), [0, 0, 0.3], [Math.PI / 2, 0, 0], null],
                [new Mesh(createCylinderGeometry(0.2, 0, 0.6, 4), matInvisible), [0, 0, -0.3], [-Math.PI / 2, 0, 0], null],
            ],
            XYZ: [
                [new Mesh(createOctahedronGeometry(0.2, 0), matInvisible), null, null, null],
            ],
            XY: [
                [new Mesh(createBoxGeometry(0.2, 0.2, 0.01), matInvisible), [0.15, 0.15, 0], null, null],
            ],
            YZ: [
                [new Mesh(createBoxGeometry(0.2, 0.2, 0.01), matInvisible), [0, 0.15, 0.15], [0, Math.PI / 2, 0], null],
            ],
            XZ: [
                [new Mesh(createBoxGeometry(0.2, 0.2, 0.01), matInvisible), [0.15, 0, 0.15], [-Math.PI / 2, 0, 0], null],
            ],
        };

        const gizmoRotate: GizmoMap = {
            XYZE: [
                [new Mesh(CircleGeometry(0.5, 1), matGray), null, [0, Math.PI / 2, 0], null],
            ],
            X: [
                [new Mesh(CircleGeometry(0.5, 0.5), matRed), null, null, null],
            ],
            Y: [
                [new Mesh(CircleGeometry(0.5, 0.5), matGreen), null, [0, 0, -Math.PI / 2], null],
            ],
            Z: [
                [new Mesh(CircleGeometry(0.5, 0.5), matBlue), null, [0, Math.PI / 2, 0], null],
            ],
            E: [
                [new Mesh(CircleGeometry(0.75, 1), matYellowTransparent), null, [0, Math.PI / 2, 0], null],
            ],
        };

        const pickerRotate: GizmoMap = {
            XYZE: [
                [new Mesh(createSphereGeometry(0.25, 10, 8), matInvisible), null, null, null],
            ],
            X: [
                [new Mesh(createTorusGeometry(0.5, 0.1, 4, 24), matInvisible), [0, 0, 0], [0, -Math.PI / 2, -Math.PI / 2], null],
            ],
            Y: [
                [new Mesh(createTorusGeometry(0.5, 0.1, 4, 24), matInvisible), [0, 0, 0], [Math.PI / 2, 0, 0], null],
            ],
            Z: [
                [new Mesh(createTorusGeometry(0.5, 0.1, 4, 24), matInvisible), [0, 0, 0], [0, 0, -Math.PI / 2], null],
            ],
            E: [
                [new Mesh(createTorusGeometry(0.75, 0.1, 2, 24), matInvisible), null, null, null],
            ],
        };

        const gizmoScale: GizmoMap = {
            X: [
                [new Mesh(scaleHandleGeometry, matRed), [0.5, 0, 0], [0, 0, -Math.PI / 2], null],
                [new Mesh(lineGeometry2, matRed), [0, 0, 0], [0, 0, -Math.PI / 2], null],
                [new Mesh(scaleHandleGeometry, matRed), [-0.5, 0, 0], [0, 0, Math.PI / 2], null],
            ],
            Y: [
                [new Mesh(scaleHandleGeometry, matGreen), [0, 0.5, 0], null, null],
                [new Mesh(lineGeometry2, matGreen), null, null, null],
                [new Mesh(scaleHandleGeometry, matGreen), [0, -0.5, 0], [0, 0, Math.PI], null],
            ],
            Z: [
                [new Mesh(scaleHandleGeometry, matBlue), [0, 0, 0.5], [Math.PI / 2, 0, 0], null],
                [new Mesh(lineGeometry2, matBlue), [0, 0, 0], [Math.PI / 2, 0, 0], null],
                [new Mesh(scaleHandleGeometry, matBlue), [0, 0, -0.5], [-Math.PI / 2, 0, 0], null],
            ],
            XY: [
                [new Mesh(createBoxGeometry(0.15, 0.15, 0.01), matBlueTransparent), [0.15, 0.15, 0], null, null],
            ],
            YZ: [
                [new Mesh(createBoxGeometry(0.15, 0.15, 0.01), matRedTransparent), [0, 0.15, 0.15], [0, Math.PI / 2, 0], null],
            ],
            XZ: [
                [new Mesh(createBoxGeometry(0.15, 0.15, 0.01), matGreenTransparent), [0.15, 0, 0.15], [-Math.PI / 2, 0, 0], null],
            ],
            XYZ: [
                [new Mesh(createBoxGeometry(0.1, 0.1, 0.1), matWhiteTransparent), null, null, null],
            ],
        };

        const pickerScale: GizmoMap = {
            X: [
                [new Mesh(createCylinderGeometry(0.2, 0, 0.6, 4), matInvisible), [0.3, 0, 0], [0, 0, -Math.PI / 2], null],
                [new Mesh(createCylinderGeometry(0.2, 0, 0.6, 4), matInvisible), [-0.3, 0, 0], [0, 0, Math.PI / 2], null],
            ],
            Y: [
                [new Mesh(createCylinderGeometry(0.2, 0, 0.6, 4), matInvisible), [0, 0.3, 0], null, null],
                [new Mesh(createCylinderGeometry(0.2, 0, 0.6, 4), matInvisible), [0, -0.3, 0], [0, 0, Math.PI], null],
            ],
            Z: [
                [new Mesh(createCylinderGeometry(0.2, 0, 0.6, 4), matInvisible), [0, 0, 0.3], [Math.PI / 2, 0, 0], null],
                [new Mesh(createCylinderGeometry(0.2, 0, 0.6, 4), matInvisible), [0, 0, -0.3], [-Math.PI / 2, 0, 0], null],
            ],
            XY: [
                [new Mesh(createBoxGeometry(0.2, 0.2, 0.01), matInvisible), [0.15, 0.15, 0], null, null],
            ],
            YZ: [
                [new Mesh(createBoxGeometry(0.2, 0.2, 0.01), matInvisible), [0, 0.15, 0.15], [0, Math.PI / 2, 0], null],
            ],
            XZ: [
                [new Mesh(createBoxGeometry(0.2, 0.2, 0.01), matInvisible), [0.15, 0, 0.15], [-Math.PI / 2, 0, 0], null],
            ],
            XYZ: [
                [new Mesh(createBoxGeometry(0.2, 0.2, 0.2), matInvisible), [0, 0, 0], null, null],
            ],
        };

        // --- setupGizmo: bake transforms into geometry ---

        function setupGizmo(gizmoMap: GizmoMap): Object3D {
            const parent = new Object3D();

            for (const name in gizmoMap) {
                const entries = gizmoMap[name];
                for (let i = entries.length - 1; i >= 0; i--) {
                    const [sourceMesh, position, rotation, scale, tag] = entries[i];

                    // Create a new GizmoMesh with its own material clone
                    const clonedMat = createGizmoMaterial({ color: [1, 1, 1] });
                    // Copy uniforms from source material
                    const srcColor = sourceMesh.material.uniforms.get('color');
                    if (srcColor) {
                        clonedMat.uniforms.set('color', new Uniform(d.vec4f,
                            srcColor.value ? (srcColor.value as number[]).slice() : [1, 1, 1, 1]
                        ));
                    }
                    // Copy material properties
                    clonedMat.transparent = sourceMesh.material.transparent;
                    clonedMat.depthTest = sourceMesh.material.depthTest;
                    clonedMat.depthWrite = sourceMesh.material.depthWrite;
                    clonedMat.cullMode = sourceMesh.material.cullMode;
                    clonedMat.blend = sourceMesh.material.blend;

                    // Clone geometry data for baking
                    const srcGeom = sourceMesh.geometry;
                    const clonedGeom = new Geometry();

                    // Copy buffers
                    for (const [bufName, buf] of srcGeom.buffers) {
                        if (buf.array) {
                            const newData = new Float32Array(buf.array as Float32Array);
                            clonedGeom.setBuffer(bufName, createVertexBuffer(buf.schema, newData));
                        }
                    }
                    if (srcGeom.index?.array) {
                        const newIdx = srcGeom.index.array instanceof Uint32Array
                            ? new Uint32Array(srcGeom.index.array)
                            : new Uint16Array(srcGeom.index.array as Uint16Array);
                        clonedGeom.setIndex(createIndexBuffer(newIdx as Uint16Array));
                    }
                    clonedGeom.drawRange = { ...srcGeom.drawRange };
                    if (srcGeom.boundingBox) clonedGeom.boundingBox = [...srcGeom.boundingBox] as any;
                    if (srcGeom.boundingSphere) clonedGeom.boundingSphere = {
                        center: [...srcGeom.boundingSphere.center] as Vec3,
                        radius: srcGeom.boundingSphere.radius,
                    };

                    const obj = new GizmoMesh(clonedGeom, clonedMat);
                    obj.name = name;
                    obj.tag = tag;

                    // Build a bake matrix from position/rotation/scale
                    if (position || rotation || scale) {
                        const p: Vec3 = position ? [position[0], position[1], position[2]] : [0, 0, 0];
                        const r: Quat = [0, 0, 0, 1];
                        if (rotation) {
                            const e = euler.fromValues(rotation[0], rotation[1], rotation[2], 'xyz');
                            quat.fromEuler(r, e);
                        }
                        const s: Vec3 = scale ? [scale[0], scale[1], scale[2]] : [1, 1, 1];

                        const bakeMatrix = mat4.create();
                        mat4.fromRotationTranslationScale(bakeMatrix, r, p, s);
                        applyMatrix4ToGeometry(obj.geometry, bakeMatrix);
                    }

                    obj.renderOrder = Infinity;
                    parent.add(obj);
                }
            }

            return parent;
        }

        // Build gizmo hierarchy
        this.gizmo['translate'] = setupGizmo(gizmoTranslate);
        this.gizmo['rotate'] = setupGizmo(gizmoRotate);
        this.gizmo['scale'] = setupGizmo(gizmoScale);
        this.picker['translate'] = setupGizmo(pickerTranslate);
        this.picker['rotate'] = setupGizmo(pickerRotate);
        this.picker['scale'] = setupGizmo(pickerScale);

        this.add(this.gizmo['translate']);
        this.add(this.gizmo['rotate']);
        this.add(this.gizmo['scale']);
        this.add(this.picker['translate']);
        this.add(this.picker['rotate']);
        this.add(this.picker['scale']);

        // Pickers should be hidden always (but still raycastable)
        this.picker['translate'].visible = false;
        this.picker['rotate'].visible = false;
        this.picker['scale'].visible = false;
    }

    override updateWorldMatrix(): void {
        const space: TransformSpace = (this.mode === 'scale') ? 'local' : this.space;
        const quaternion = (space === 'local') ? this.worldQuaternion : _identityQuat;

        // Show only gizmos for current transform mode
        this.gizmo['translate'].visible = this.mode === 'translate';
        this.gizmo['rotate'].visible = this.mode === 'rotate';
        this.gizmo['scale'].visible = this.mode === 'scale';

        let handles: Object3D[] = [];
        handles = handles.concat(this.picker[this.mode].children);
        handles = handles.concat(this.gizmo[this.mode].children);

        for (let i = 0; i < handles.length; i++) {
            const handle = handles[i] as GizmoMesh;

            handle.visible = true;
            quat.identity(handle.quaternion);
            vec3.copy(handle.position, this.worldPosition);

            // constant screen-size factor
            let factor: number;
            if (this.camera && this.camera instanceof OrthographicCamera) {
                const ortho = this.camera;
                factor = (ortho.top - ortho.bottom) / ortho.zoom;
            } else if (this.camera) {
                const cam = this.camera as any;
                const fov = cam.fov ?? (Math.PI / 4);
                factor = vec3.distance(this.worldPosition, this.cameraPosition)
                    * Math.min(1.9 * Math.tan(fov / 2) / (cam.zoom ?? 1), 7);
            } else {
                factor = 1;
            }

            const s = factor * this.size / 4;
            vec3.set(handle.scale, s, s, s);

            // skip helper processing (deferred per plan)
            if (handle.tag === 'helper') {
                handle.visible = false;
                continue;
            }

            // align handles to current local or world rotation
            quat.copy(handle.quaternion, quaternion);

            if (this.mode === 'translate' || this.mode === 'scale') {
                const AXIS_HIDE_THRESHOLD = 0.99;
                const PLANE_HIDE_THRESHOLD = 0.2;

                if (handle.name === 'X') {
                    vec3.transformQuat(_alignVector, _unitX, quaternion);
                    if (Math.abs(vec3.dot(_alignVector, this.eye)) > AXIS_HIDE_THRESHOLD) {
                        vec3.set(handle.scale, 1e-10, 1e-10, 1e-10);
                        handle.visible = false;
                    }
                }

                if (handle.name === 'Y') {
                    vec3.transformQuat(_alignVector, _unitY, quaternion);
                    if (Math.abs(vec3.dot(_alignVector, this.eye)) > AXIS_HIDE_THRESHOLD) {
                        vec3.set(handle.scale, 1e-10, 1e-10, 1e-10);
                        handle.visible = false;
                    }
                }

                if (handle.name === 'Z') {
                    vec3.transformQuat(_alignVector, _unitZ, quaternion);
                    if (Math.abs(vec3.dot(_alignVector, this.eye)) > AXIS_HIDE_THRESHOLD) {
                        vec3.set(handle.scale, 1e-10, 1e-10, 1e-10);
                        handle.visible = false;
                    }
                }

                if (handle.name === 'XY') {
                    vec3.transformQuat(_alignVector, _unitZ, quaternion);
                    if (Math.abs(vec3.dot(_alignVector, this.eye)) < PLANE_HIDE_THRESHOLD) {
                        vec3.set(handle.scale, 1e-10, 1e-10, 1e-10);
                        handle.visible = false;
                    }
                }

                if (handle.name === 'YZ') {
                    vec3.transformQuat(_alignVector, _unitX, quaternion);
                    if (Math.abs(vec3.dot(_alignVector, this.eye)) < PLANE_HIDE_THRESHOLD) {
                        vec3.set(handle.scale, 1e-10, 1e-10, 1e-10);
                        handle.visible = false;
                    }
                }

                if (handle.name === 'XZ') {
                    vec3.transformQuat(_alignVector, _unitY, quaternion);
                    if (Math.abs(vec3.dot(_alignVector, this.eye)) < PLANE_HIDE_THRESHOLD) {
                        vec3.set(handle.scale, 1e-10, 1e-10, 1e-10);
                        handle.visible = false;
                    }
                }

            } else if (this.mode === 'rotate') {
                quat.copy(_tempQuat2, quaternion);
                // alignVector = eye in local space
                quat.invert(_tempQuat, quaternion);
                vec3.transformQuat(_alignVector, this.eye, _tempQuat);

                if (handle.name.indexOf('E') !== -1) {
                    // E ring: face camera
                    mat4.targetTo(_tempMat, this.eye, _zeroVec, _unitY);
                    quat.fromMat4(handle.quaternion, _tempMat);
                }

                if (handle.name === 'X') {
                    quat.setAxisAngle(_tempQuat, _unitX, Math.atan2(-_alignVector[1], _alignVector[2]));
                    quat.multiply(_tempQuat, _tempQuat2, _tempQuat);
                    quat.copy(handle.quaternion, _tempQuat);
                }

                if (handle.name === 'Y') {
                    quat.setAxisAngle(_tempQuat, _unitY, Math.atan2(_alignVector[0], _alignVector[2]));
                    quat.multiply(_tempQuat, _tempQuat2, _tempQuat);
                    quat.copy(handle.quaternion, _tempQuat);
                }

                if (handle.name === 'Z') {
                    quat.setAxisAngle(_tempQuat, _unitZ, Math.atan2(_alignVector[1], _alignVector[0]));
                    quat.multiply(_tempQuat, _tempQuat2, _tempQuat);
                    quat.copy(handle.quaternion, _tempQuat);
                }
            }

            // hide disabled axes
            handle.visible = handle.visible && (handle.name.indexOf('X') === -1 || this.showX);
            handle.visible = handle.visible && (handle.name.indexOf('Y') === -1 || this.showY);
            handle.visible = handle.visible && (handle.name.indexOf('Z') === -1 || this.showZ);
            handle.visible = handle.visible && (handle.name.indexOf('E') === -1 || (this.showX && this.showY && this.showZ));

            // highlight selected axis
            if (!handle._color) {
                const c = handle.getColor();
                handle._color = [c[0], c[1], c[2]];
                handle._opacity = c[3];
            }

            // restore original
            handle.setColor(handle._color[0], handle._color[1], handle._color[2], handle._opacity!);

            if (this.enabled && this.axis) {
                if (handle.name === this.axis) {
                    handle.setColor(this._activeColor[0], this._activeColor[1], this._activeColor[2], 1.0);
                } else if (this.axis.split('').some(a => handle.name === a)) {
                    handle.setColor(this._activeColor[0], this._activeColor[1], this._activeColor[2], 1.0);
                }
            }
        }

        super.updateWorldMatrix();
    }
}

// ============================================================================
// TransformControlsRoot
// ============================================================================

class TransformControlsRoot extends Object3D {
    controls: TransformControls;

    constructor(controls: TransformControls) {
        super();
        this.controls = controls;
        this.visible = false;
    }

    override updateWorldMatrix(): void {
        const controls = this.controls;

        if (controls.object !== undefined) {
            controls.object.updateWorldMatrix();

            if (controls.object.parent === null) {
                console.error('TransformControls: The attached 3D object must be a part of the scene graph.');
            } else {
                mat4.decompose(
                    controls._parentQuaternion,
                    controls._parentPosition,
                    controls._parentScale,
                    controls.object.parent.matrixWorld,
                );
            }

            mat4.decompose(
                controls.worldQuaternion,
                controls.worldPosition,
                controls._worldScale,
                controls.object.matrixWorld,
            );

            quat.invert(controls._parentQuaternionInv, controls._parentQuaternion);
            quat.invert(controls._worldQuaternionInv, controls.worldQuaternion);
        }

        controls.camera.updateWorldMatrix();
        mat4.decompose(
            controls.cameraQuaternion,
            controls.cameraPosition,
            controls._cameraScale,
            controls.camera.matrixWorld,
        );

        if (controls.camera instanceof OrthographicCamera) {
            controls.camera.getWorldDirection(controls.eye);
            vec3.negate(controls.eye, controls.eye);
        } else {
            vec3.subtract(controls.eye, controls.cameraPosition, controls.worldPosition);
            vec3.normalize(controls.eye, controls.eye);
        }

        super.updateWorldMatrix();
    }

    dispose(): void {
        this.traverse((child) => {
            if (child instanceof Mesh) {
                child.geometry.dispose();
                child.material.dispose();
            }
        });
    }
}

// ============================================================================
// TransformControls
// ============================================================================

function getPointer(domElement: HTMLElement, event: PointerEvent): { x: number; y: number; button: number } {
    if (domElement.ownerDocument.pointerLockElement) {
        return { x: 0, y: 0, button: event.button };
    }

    const rect = domElement.getBoundingClientRect();
    return {
        x: (event.clientX - rect.left) / rect.width * 2 - 1,
        y: -(event.clientY - rect.top) / rect.height * 2 + 1,
        button: event.button,
    };
}

export class TransformControls {
    camera: Camera;
    domElement: HTMLElement | null = null;

    // the 3D object being transformed
    object: Object3D | undefined;

    // state
    enabled: boolean = true;
    mode: TransformMode = 'translate';
    space: TransformSpace = 'world';
    axis: string | null = null;
    dragging: boolean = false;
    size: number = 1;

    showX: boolean = true;
    showY: boolean = true;
    showZ: boolean = true;

    // snapping
    translationSnap: number | null = null;
    rotationSnap: number | null = null;
    scaleSnap: number | null = null;

    // position clamping
    minX = -Infinity; maxX = Infinity;
    minY = -Infinity; maxY = Infinity;
    minZ = -Infinity; maxZ = Infinity;

    // derived world-space state
    worldPosition: Vec3 = [0, 0, 0];
    worldPositionStart: Vec3 = [0, 0, 0];
    worldQuaternion: Quat = [0, 0, 0, 1];
    worldQuaternionStart: Quat = [0, 0, 0, 1];
    cameraPosition: Vec3 = [0, 0, 0];
    cameraQuaternion: Quat = [0, 0, 0, 1];
    pointStart: Vec3 = [0, 0, 0];
    pointEnd: Vec3 = [0, 0, 0];
    rotationAxis: Vec3 = [0, 0, 0];
    rotationAngle: number = 0;
    eye: Vec3 = [0, 0, 1];

    // internal working vectors
    _offset: Vec3 = [0, 0, 0];
    _startNorm: Vec3 = [0, 0, 0];
    _endNorm: Vec3 = [0, 0, 0];
    _cameraScale: Vec3 = [1, 1, 1];

    _parentPosition: Vec3 = [0, 0, 0];
    _parentQuaternion: Quat = [0, 0, 0, 1];
    _parentQuaternionInv: Quat = [0, 0, 0, 1];
    _parentScale: Vec3 = [1, 1, 1];

    _worldScaleStart: Vec3 = [1, 1, 1];
    _worldQuaternionInv: Quat = [0, 0, 0, 1];
    _worldScale: Vec3 = [1, 1, 1];

    _positionStart: Vec3 = [0, 0, 0];
    _quaternionStart: Quat = [0, 0, 0, 1];
    _scaleStart: Vec3 = [1, 1, 1];

    // events (topics)
    onChange: Topic<[]> = topic<[]>();
    onMouseDown: Topic<[{ mode: TransformMode }]> = topic<[{ mode: TransformMode }]>();
    onMouseUp: Topic<[{ mode: TransformMode }]> = topic<[{ mode: TransformMode }]>();
    onObjectChange: Topic<[]> = topic<[]>();

    // internal components
    private _root: TransformControlsRoot;
    private _gizmo: TransformControlsGizmo;
    private _plane: TransformControlsPlane;

    // bound event handlers
    private _onPointerDown: (e: PointerEvent) => void;
    private _onPointerHover: (e: PointerEvent) => void;
    private _onPointerMove: (e: PointerEvent) => void;
    private _onPointerUp: (e: PointerEvent) => void;

    constructor(camera: Camera, domElement?: HTMLElement) {
        this.camera = camera;

        this._root = new TransformControlsRoot(this);
        this._gizmo = new TransformControlsGizmo();
        this._plane = new TransformControlsPlane();
        this._root.add(this._gizmo);
        this._root.add(this._plane);

        this._onPointerDown = (event: PointerEvent) => {
            if (!this.enabled) return;
            if (!document.pointerLockElement && this.domElement) {
                this.domElement.setPointerCapture(event.pointerId);
            }
            if (this.domElement) {
                this.domElement.addEventListener('pointermove', this._onPointerMove);
            }
            const pointer = getPointer(this.domElement!, event);
            this.pointerHover(pointer);
            this.pointerDown(pointer);
        };

        this._onPointerHover = (event: PointerEvent) => {
            if (!this.enabled) return;
            if (event.pointerType === 'mouse' || event.pointerType === 'pen') {
                const pointer = getPointer(this.domElement!, event);
                this.pointerHover(pointer);
            }
        };

        this._onPointerMove = (event: PointerEvent) => {
            if (!this.enabled) return;
            const pointer = getPointer(this.domElement!, event);
            // During a drag, pointermove events have event.button === 0, but
            // pointerMove() expects button === -1 to distinguish move-during-drag
            // from a fresh click (matching Three.js convention).
            pointer.button = -1;
            this.pointerMove(pointer);
        };

        this._onPointerUp = (event: PointerEvent) => {
            if (!this.enabled) return;
            if (this.domElement) {
                this.domElement.releasePointerCapture(event.pointerId);
                this.domElement.removeEventListener('pointermove', this._onPointerMove);
            }
            const pointer = getPointer(this.domElement!, event);
            this.pointerUp(pointer);
        };

        if (domElement) {
            this.connect(domElement);
        }
    }

    getHelper(): TransformControlsRoot {
        return this._root;
    }

    connect(element: HTMLElement): void {
        this.domElement = element;
        element.addEventListener('pointerdown', this._onPointerDown);
        element.addEventListener('pointermove', this._onPointerHover);
        element.addEventListener('pointerup', this._onPointerUp);
        element.style.touchAction = 'none';
    }

    disconnect(): void {
        if (!this.domElement) return;
        this.domElement.removeEventListener('pointerdown', this._onPointerDown);
        this.domElement.removeEventListener('pointermove', this._onPointerHover);
        this.domElement.removeEventListener('pointermove', this._onPointerMove);
        this.domElement.removeEventListener('pointerup', this._onPointerUp);
        this.domElement.style.touchAction = 'auto';
    }

    attach(object: Object3D): this {
        this.object = object;
        this._root.visible = true;
        this._syncState();
        return this;
    }

    detach(): this {
        this.object = undefined;
        this.axis = null;
        this._root.visible = false;
        this._syncState();
        return this;
    }

    setMode(mode: TransformMode): void {
        this.mode = mode;
        this._syncState();
        this.onChange.emit();
    }

    setSpace(space: TransformSpace): void {
        this.space = space;
        this._syncState();
        this.onChange.emit();
    }

    setSize(size: number): void {
        this.size = size;
        this._syncState();
        this.onChange.emit();
    }

    setTranslationSnap(snap: number | null): void { this.translationSnap = snap; }
    setRotationSnap(snap: number | null): void { this.rotationSnap = snap; }
    setScaleSnap(snap: number | null): void { this.scaleSnap = snap; }

    getRaycaster(): Raycaster { return _raycaster; }
    getMode(): TransformMode { return this.mode; }

    reset(): void {
        if (!this.enabled) return;
        if (this.dragging && this.object) {
            vec3.copy(this.object.position, this._positionStart);
            quat.copy(this.object.quaternion, this._quaternionStart);
            vec3.copy(this.object.scale, this._scaleStart);

            this.onChange.emit();
            this.onObjectChange.emit();
            vec3.copy(this.pointStart, this.pointEnd);
        }
    }

    dispose(): void {
        this.disconnect();
        this._root.dispose();
    }

    // --- Pointer logic ---

    pointerHover(pointer: { x: number; y: number; button: number }): void {
        if (this.object === undefined || this.dragging === true) return;

        _raycaster.setFromCamera([pointer.x, pointer.y], this.camera);

        const intersect = intersectObjectWithRay(this._gizmo.picker[this.mode], _raycaster, true);

        if (intersect) {
            this.axis = intersect.object.name;
        } else {
            this.axis = null;
        }

        this._syncState();
        this.onChange.emit();
    }

    pointerDown(pointer: { x: number; y: number; button: number }): void {
        if (this.object === undefined || this.dragging === true || pointer.button !== 0) return;

        if (this.axis !== null) {
            _raycaster.setFromCamera([pointer.x, pointer.y], this.camera);

            const planeIntersect = intersectObjectWithRay(this._plane, _raycaster, true);

            if (planeIntersect) {
                this.object.updateWorldMatrix();
                if (this.object.parent) {
                    this.object.parent.updateWorldMatrix();
                }

                vec3.copy(this._positionStart, this.object.position);
                quat.copy(this._quaternionStart, this.object.quaternion);
                vec3.copy(this._scaleStart, this.object.scale);

                mat4.decompose(
                    this.worldQuaternionStart,
                    this.worldPositionStart,
                    this._worldScaleStart,
                    this.object.matrixWorld,
                );

                vec3.subtract(this.pointStart, planeIntersect.point, this.worldPositionStart);
            }

            this.dragging = true;
            this._syncState();
            this.onMouseDown.emit({ mode: this.mode });
        }
    }

    pointerMove(pointer: { x: number; y: number; button: number }): void {
        const axis = this.axis;
        const mode = this.mode;
        const object = this.object;
        let space: TransformSpace = this.space;

        if (mode === 'scale') {
            space = 'local';
        } else if (axis === 'E' || axis === 'XYZE' || axis === 'XYZ') {
            space = 'world';
        }

        if (object === undefined || axis === null || this.dragging === false || pointer.button !== -1) {
            return;
        }

        _raycaster.setFromCamera([pointer.x, pointer.y], this.camera);

        const planeIntersect = intersectObjectWithRay(this._plane, _raycaster, true);
        if (!planeIntersect) {
            return;
        }

        vec3.subtract(this.pointEnd, planeIntersect.point, this.worldPositionStart);

        if (mode === 'translate') {
            vec3.subtract(this._offset, this.pointEnd, this.pointStart);

            if (space === 'local' && axis !== 'XYZ') {
                vec3.transformQuat(this._offset, this._offset, this._worldQuaternionInv);
            }

            if (axis.indexOf('X') === -1) this._offset[0] = 0;
            if (axis.indexOf('Y') === -1) this._offset[1] = 0;
            if (axis.indexOf('Z') === -1) this._offset[2] = 0;

            if (space === 'local' && axis !== 'XYZ') {
                vec3.transformQuat(this._offset, this._offset, this._quaternionStart);
                vec3.divide(this._offset, this._offset, this._parentScale);
            } else {
                vec3.transformQuat(this._offset, this._offset, this._parentQuaternionInv);
                vec3.divide(this._offset, this._offset, this._parentScale);
            }

            vec3.add(object.position, this._offset, this._positionStart);

            // snap
            if (this.translationSnap) {
                const snap = this.translationSnap;
                if (space === 'local') {
                    quat.invert(_tempQuat, this._quaternionStart);
                    vec3.transformQuat(object.position, object.position, _tempQuat);

                    if (axis.indexOf('X') !== -1) object.position[0] = Math.round(object.position[0] / snap) * snap;
                    if (axis.indexOf('Y') !== -1) object.position[1] = Math.round(object.position[1] / snap) * snap;
                    if (axis.indexOf('Z') !== -1) object.position[2] = Math.round(object.position[2] / snap) * snap;

                    vec3.transformQuat(object.position, object.position, this._quaternionStart);
                }

                if (space === 'world') {
                    if (object.parent) {
                        mat4.getTranslation(_tempVec, object.parent.matrixWorld);
                        vec3.add(object.position, object.position, _tempVec);
                    }

                    if (axis.indexOf('X') !== -1) object.position[0] = Math.round(object.position[0] / snap) * snap;
                    if (axis.indexOf('Y') !== -1) object.position[1] = Math.round(object.position[1] / snap) * snap;
                    if (axis.indexOf('Z') !== -1) object.position[2] = Math.round(object.position[2] / snap) * snap;

                    if (object.parent) {
                        mat4.getTranslation(_tempVec, object.parent.matrixWorld);
                        vec3.subtract(object.position, object.position, _tempVec);
                    }
                }
            }

            // clamp
            object.position[0] = Math.max(this.minX, Math.min(this.maxX, object.position[0]));
            object.position[1] = Math.max(this.minY, Math.min(this.maxY, object.position[1]));
            object.position[2] = Math.max(this.minZ, Math.min(this.maxZ, object.position[2]));

        } else if (mode === 'scale') {
            if (axis.indexOf('XYZ') !== -1) {
                let dd = vec3.length(this.pointEnd) / vec3.length(this.pointStart);
                if (vec3.dot(this.pointEnd, this.pointStart) < 0) dd *= -1;
                vec3.set(_tempVec2, dd, dd, dd);
            } else {
                vec3.copy(_tempVec, this.pointStart);
                vec3.copy(_tempVec2, this.pointEnd);

                vec3.transformQuat(_tempVec, _tempVec, this._worldQuaternionInv);
                vec3.transformQuat(_tempVec2, _tempVec2, this._worldQuaternionInv);

                vec3.divide(_tempVec2, _tempVec2, _tempVec);

                if (axis.indexOf('X') === -1) _tempVec2[0] = 1;
                if (axis.indexOf('Y') === -1) _tempVec2[1] = 1;
                if (axis.indexOf('Z') === -1) _tempVec2[2] = 1;
            }

            vec3.multiply(object.scale, this._scaleStart, _tempVec2);

            if (this.scaleSnap) {
                const snap = this.scaleSnap;
                if (axis.indexOf('X') !== -1) object.scale[0] = Math.round(object.scale[0] / snap) * snap || snap;
                if (axis.indexOf('Y') !== -1) object.scale[1] = Math.round(object.scale[1] / snap) * snap || snap;
                if (axis.indexOf('Z') !== -1) object.scale[2] = Math.round(object.scale[2] / snap) * snap || snap;
            }

        } else if (mode === 'rotate') {
            vec3.subtract(this._offset, this.pointEnd, this.pointStart);

            mat4.getTranslation(_tempVec, this.camera.matrixWorld);
            const ROTATION_SPEED = 20 / vec3.distance(this.worldPosition, _tempVec);

            let _inPlaneRotation = false;

            if (axis === 'XYZE') {
                vec3.cross(this.rotationAxis, this._offset, this.eye);
                vec3.normalize(this.rotationAxis, this.rotationAxis);

                vec3.cross(_tempVec, this.rotationAxis, this.eye);
                this.rotationAngle = vec3.dot(this._offset, _tempVec) * ROTATION_SPEED;
            } else if (axis === 'X' || axis === 'Y' || axis === 'Z') {
                const unit = axis === 'X' ? _unitX : axis === 'Y' ? _unitY : _unitZ;
                vec3.copy(this.rotationAxis, unit);
                vec3.copy(_tempVec, unit);

                if (space === 'local') {
                    vec3.transformQuat(_tempVec, _tempVec, this.worldQuaternion);
                }

                vec3.cross(_tempVec, _tempVec, this.eye);

                if (vec3.length(_tempVec) === 0) {
                    _inPlaneRotation = true;
                } else {
                    vec3.normalize(_tempVec, _tempVec);
                    this.rotationAngle = vec3.dot(this._offset, _tempVec) * ROTATION_SPEED;
                }
            }

            if (axis === 'E' || _inPlaneRotation) {
                vec3.copy(this.rotationAxis, this.eye);
                this.rotationAngle = vec3.angle(this.pointEnd, this.pointStart);

                vec3.normalize(this._startNorm, this.pointStart);
                vec3.normalize(this._endNorm, this.pointEnd);

                vec3.cross(_tempVec, this._endNorm, this._startNorm);
                this.rotationAngle *= (vec3.dot(_tempVec, this.eye) < 0 ? 1 : -1);
            }

            // snap
            if (this.rotationSnap) {
                this.rotationAngle = Math.round(this.rotationAngle / this.rotationSnap) * this.rotationSnap;
            }

            // apply rotation
            if (space === 'local' && axis !== 'E' && axis !== 'XYZE') {
                quat.copy(object.quaternion, this._quaternionStart);
                quat.setAxisAngle(_tempQuat, this.rotationAxis, this.rotationAngle);
                quat.multiply(object.quaternion, object.quaternion, _tempQuat);
                quat.normalize(object.quaternion, object.quaternion);
            } else {
                vec3.transformQuat(this.rotationAxis, this.rotationAxis, this._parentQuaternionInv);
                quat.setAxisAngle(_tempQuat, this.rotationAxis, this.rotationAngle);
                quat.multiply(object.quaternion, _tempQuat, this._quaternionStart);
                quat.normalize(object.quaternion, object.quaternion);
            }
        }

        this.onChange.emit();
        this.onObjectChange.emit();
    }

    pointerUp(pointer: { x: number; y: number; button: number }): void {
        if (pointer.button !== 0) return;

        if (this.dragging && this.axis !== null) {
            this.onMouseUp.emit({ mode: this.mode });
        }

        this.dragging = false;
        this.axis = null;
        this._syncState();
    }

    /**
     * Sync internal state to gizmo and plane.
     * Call this after any property change that affects the gizmo display.
     */
    private _syncState(): void {
        // sync to gizmo
        this._gizmo.mode = this.mode;
        this._gizmo.space = this.space;
        this._gizmo.axis = this.axis;
        this._gizmo.worldPosition = this.worldPosition;
        this._gizmo.worldQuaternion = this.worldQuaternion;
        this._gizmo.worldPositionStart = this.worldPositionStart;
        this._gizmo.worldQuaternionStart = this.worldQuaternionStart;
        this._gizmo.cameraPosition = this.cameraPosition;
        this._gizmo.eye = this.eye;
        this._gizmo.camera = this.camera;
        this._gizmo.enabled = this.enabled;
        this._gizmo.dragging = this.dragging;
        this._gizmo.showX = this.showX;
        this._gizmo.showY = this.showY;
        this._gizmo.showZ = this.showZ;
        this._gizmo.size = this.size;
        this._gizmo.rotationAxis = this.rotationAxis;
        this._gizmo.rotationAngle = this.rotationAngle;

        // sync to plane
        this._plane.mode = this.mode;
        this._plane.axis = this.axis;
        this._plane.space = this.space;
        this._plane.worldPosition = this.worldPosition;
        this._plane.worldQuaternion = this.worldQuaternion;
        this._plane.eye = this.eye;
        this._plane.cameraQuaternion = this.cameraQuaternion;
    }
}
