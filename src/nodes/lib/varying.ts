import { Node } from './core';
import type { Any } from '../schema';
import { SubBuildNode, subBuild } from './sub-build';

/**
 * WGSL @interpolate interpolation type.
 *   - perspective  : values are interpolated in a perspective-correct manner (default for float types)
 *   - linear       : values are interpolated in a linear, non-perspective-correct manner
 *   - flat         : values are not interpolated; the value from the provoking vertex is used
 *                    (required for integer/unsigned-integer types)
 */
export type InterpolationType = 'perspective' | 'linear' | 'flat';

/**
 * WGSL @interpolate sampling mode (only valid when interpolation type is 'perspective' or 'linear').
 *   - center    : interpolation is performed at the center of the pixel (default)
 *   - centroid  : interpolation is performed at a point inside the primitive that is also
 *                 inside all samples covered by the fragment (avoids aliasing at primitive edges)
 *   - sample    : interpolation is performed per-sample; the fragment shader runs once per sample
 *   - either    : implementation may choose center or centroid (valid only with 'flat' in WGSL)
 */
export type InterpolationSampling = 'center' | 'centroid' | 'sample' | 'either';

/**
 * VaryingNode - represents shader varyings that pass data from vertex to fragment stage.
 */
export class VaryingNode<D extends Any> extends Node<D> {
    readonly isVaryingNode = true;

    /** The source node wrapped with subBuild('VERTEX') */
    readonly node: SubBuildNode<D>;

    /** The name of the varying in the shader (auto-generated if null) */
    name: string | null;

    /** Interpolation type */
    interpolationType: InterpolationType | null = null;

    /** Interpolation sampling */
    interpolationSampling: InterpolationSampling | null = null;

    constructor(
        source: Node<D>,
        name: string | null = null
    ) {
        super(source.type);
        // wrap source in SubBuildNode for VERTEX stage
        this.node = subBuild(source, 'VERTEX');
        this.name = name;
        // use global cache for varyings
        this.global = true;
    }

    /**
     * Set the WGSL @interpolate qualifier for this varying.
     */
    setInterpolation(type: InterpolationType, sampling?: InterpolationSampling): this {
        this.interpolationType = type;
        this.interpolationSampling = sampling ?? null;
        return this;
    }
}

export const varying = <D extends Any>(source: Node<D>, name?: string) => new VaryingNode<D>(source, name ?? null);

