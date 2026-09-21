import { Geometry } from '../geometry/geometry';
import { type Node } from '../nodes/nodes';
import type { Any } from '../schema/schema';
import { Mesh } from './mesh';
/**
 * Clip position of a fullscreen triangle from `@builtin(vertex_index)` alone: vertices 0, 1 and 2 land
 * on (-1,-1), (3,-1) and (-1,3), so no vertex buffer is bound and no attribute is read. Built on call,
 * never at module scope, because node ids come from a global counter and emitted shader identifiers
 * derive from them.
 */
export declare function fullscreenPosition(): Node<Any>;
/** A geometry with no buffers whose only content is a vertex count. */
export declare function vertexCountGeometry(count: number): Geometry;
/**
 * Draws `fragment` over the whole target. It carries a `uv` buffer because a `TextureNode` samples
 * with `varying(uv())` unless told otherwise, so a post chain reading `pass.getTextureNode().rgb`
 * needs one. Use `fullscreenPosition` with `vertexCountGeometry` for a bufferless draw instead.
 */
export declare function fullscreen(fragment: Node<Any>): Mesh;
