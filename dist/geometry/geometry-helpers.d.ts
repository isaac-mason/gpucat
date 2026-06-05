import { Geometry } from './geometry';
export declare function createBoxGeometry(width?: number, height?: number, depth?: number): Geometry;
export declare function createSphereGeometry(radius?: number, widthSegments?: number, heightSegments?: number): Geometry;
/**
 * Creates a plane geometry in the XY plane (facing +Z).
 *
 * Vertices span [-width/2, width/2] in X and [-height/2, height/2] in Y, at z=0.
 * Normals point +Z. Triangles wound CCW when viewed from +Z.
 *
 * @param width - Total width along X. Defaults to 1.
 * @param height - Total height along Y. Defaults to 1.
 * @param widthSegments - Subdivisions along X. Defaults to 1.
 * @param heightSegments - Subdivisions along Y. Defaults to 1.
 */
export declare function createPlaneGeometry(width?: number, height?: number, widthSegments?: number, heightSegments?: number): Geometry;
/**
 * Creates a fullscreen triangle geometry for post-processing passes.
 *
 * Uses an oversized triangle technique for efficiency (3 vertices instead of 6).
 * The triangle covers clip space from (-1,-1) to (3,-1) to (-1,3), ensuring
 * full viewport coverage after clipping.
 *
 * UV coordinates follow WebGPU conventions:
 *   - (0, 0) at top-left of texture
 *   - (1, 1) at bottom-right of texture
 *
 * Since clip space Y=-1 is bottom and Y=+1 is top, but texture V=0 is top and V=1 is bottom,
 * we map: bottom-left clip (-1,-1) → UV (0,1), top-left clip (-1,3) → UV (0,-1).
 *
 * @param flipY - Whether to flip UV coordinates along the vertical axis. Defaults to false.
 */
export declare function createFullscreenTriangleGeometry(flipY?: boolean): Geometry;
/**
 * Creates a cylinder geometry along the Y axis, centered at the origin.
 * When radiusTop is 0, produces a cone. Includes top and bottom caps.
 *
 * @param radiusTop - Radius at y = +height/2. 0 for a cone.
 * @param radiusBottom - Radius at y = -height/2.
 * @param height - Total height along Y.
 * @param radialSegments - Number of segments around the circumference.
 */
export declare function createCylinderGeometry(radiusTop?: number, radiusBottom?: number, height?: number, radialSegments?: number): Geometry;
/**
 * Creates a torus geometry in the XZ plane.
 *
 * @param radius - Distance from center of torus to center of tube.
 * @param tube - Radius of the tube.
 * @param radialSegments - Segments around the tube cross-section.
 * @param tubularSegments - Segments around the torus ring.
 * @param arc - Central angle of the torus in radians. Defaults to full circle.
 */
export declare function createTorusGeometry(radius?: number, tube?: number, radialSegments?: number, tubularSegments?: number, arc?: number): Geometry;
/**
 * Creates an octahedron geometry (dual of cube).
 * At detail=0: 6 vertices, 8 triangular faces.
 * Higher detail subdivides each face recursively.
 *
 * @param radius - Circumscribed sphere radius.
 * @param detail - Subdivision level. 0 = base octahedron.
 */
export declare function createOctahedronGeometry(radius?: number, detail?: number): Geometry;
