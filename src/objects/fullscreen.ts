import { Geometry } from '../geometry/geometry';
import { createFullscreenTriangleGeometry } from '../geometry/geometry-helpers';
import { createMaterial } from '../material/material';
import { attribute, equal, f32, type Node, select, u32, vec4f, vertexIndex } from '../nodes/nodes';
import type { Any } from '../schema/schema';
import * as d from '../schema/schema';
import { Mesh } from './mesh';

/**
 * Clip position of a fullscreen triangle from `@builtin(vertex_index)` alone: vertices 0, 1 and 2 land
 * on (-1,-1), (3,-1) and (-1,3), so no vertex buffer is bound and no attribute is read. Built on call,
 * never at module scope, because node ids come from a global counter and emitted shader identifiers
 * derive from them.
 */
export function fullscreenPosition(): Node<Any> {
    const x = select(f32(-1), f32(3), equal(vertexIndex, u32(1)));
    const y = select(f32(-1), f32(3), equal(vertexIndex, u32(2)));
    return vec4f(x, y, f32(0), f32(1));
}

/** A geometry with no buffers whose only content is a vertex count. */
export function vertexCountGeometry(count: number): Geometry {
    const geometry = new Geometry();
    geometry.drawRange = { start: 0, count };
    return geometry;
}

/** One shared triangle: three positions and their uvs, immutable and never per-call. */
const _fullscreenGeometry = /* @__PURE__ */ createFullscreenTriangleGeometry();

/**
 * Draws `fragment` over the whole target. It carries a `uv` buffer because a `TextureNode` samples
 * with `varying(uv())` unless told otherwise, so a post chain reading `pass.getTextureNode().rgb`
 * needs one. Use `fullscreenPosition` with `vertexCountGeometry` for a bufferless draw instead.
 */
export function fullscreen(fragment: Node<Any>): Mesh {
    const mesh = new Mesh(
        _fullscreenGeometry,
        createMaterial({
            name: 'fullscreen',
            vertex: vec4f(attribute('position', d.vec3f), f32(1)),
            fragment,
            depthTest: false,
            depthWrite: false,
        }),
    );
    mesh.frustumCulled = false;
    return mesh;
}
