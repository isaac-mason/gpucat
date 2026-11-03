import type * as d from '../../schema/schema';
import { cameraFar, cameraNear, cameraPosition, cameraProjectionMatrix, cameraViewMatrix } from './camera';
import { screenSize } from './display/screen';
import { renderGroup, type UniformGroup, type UniformNode } from './uniform';

/**
 * The view block: the render group's members, all of them in every shader that reads any, in this order, as Godot's
 * scene block and Babylon Lite's `SceneUniforms` are fixed. Its layout is then the same in every pipeline, so one
 * buffer and bind group serve them all and a pass binds it once.
 */
const VIEW_BLOCK: readonly UniformNode<d.Any>[] = [
    cameraProjectionMatrix,
    cameraViewMatrix,
    cameraPosition,
    cameraNear,
    cameraFar,
    screenSize,
] as readonly UniformNode<d.Any>[];

/** `group`'s fixed block, or null for a group whose block is what each shader reads of it */
export function fixedMembers(group: UniformGroup): readonly UniformNode<d.Any>[] | null {
    return group === renderGroup ? VIEW_BLOCK : null;
}
