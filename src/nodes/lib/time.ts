import { renderGroup, UniformNode, Uniform } from './uniform';
import * as d from '../schema';

/** Elapsed time in seconds. In renderGroup. */
export const timeElapsed = /*@__PURE__*/ new UniformNode(
    new Uniform(d.f32, undefined, renderGroup),
    'timeElapsed'
).onRenderUpdate((frame) => frame.time);

/** Frame delta time in seconds. In renderGroup. */
export const timeDelta = /*@__PURE__*/ new UniformNode(
    new Uniform(d.f32, undefined, renderGroup),
    'timeDelta'
).onRenderUpdate((frame) => frame.deltaTime);
