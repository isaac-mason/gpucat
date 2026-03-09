import { renderGroup, UniformNode } from './uniform';
import * as d from '../schema';

/** Elapsed time in seconds. In renderGroup. */
export const timeElapsed = /*@__PURE__*/ new UniformNode(d.f32, 'timeElapsed', renderGroup)
    .onRenderUpdate((frame) => frame.time);

/** Frame delta time in seconds. In renderGroup. */
export const timeDelta = /*@__PURE__*/ new UniformNode(d.f32, 'timeDelta', renderGroup)
    .onRenderUpdate((frame) => frame.deltaTime);
