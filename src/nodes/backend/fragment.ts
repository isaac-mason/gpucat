import type * as d from '../../schema/schema';
import type { Node } from '../lib/core';

/** a fragment node that writes no colour: a void call, run for its statements alone, as a cutout's discard in a
 *  depth-only pass. It takes no colour target, and the fragment stage still runs. */
export function isVoidFragment(fragment: Node<d.Any>): boolean {
    return fragment.type.wgslType === 'void';
}
