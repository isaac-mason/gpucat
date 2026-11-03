import type * as d from '../../schema/schema';
import { type UniformGroup, type UniformNode } from './uniform';
/** `group`'s fixed block, or null for a group whose block is what each shader reads of it */
export declare function fixedMembers(group: UniformGroup): readonly UniformNode<d.Any>[] | null;
