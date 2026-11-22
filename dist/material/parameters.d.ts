import type { GpuBuffer } from '../core/gpu-buffer';
import type { GpuTexture } from '../core/gpu-texture';
import type { TextureSource } from '../core/gpu-texture-view';
import type { Uniform } from '../core/uniform';
import type { Any } from '../schema/schema';
/** what a named `texture(name, …)` reads: a texture, a view of part of one, or what holds one (a `DataTexture`, a
 *  render target's attachment) */
export type TextureInput = TextureSource | {
    readonly _gpuTexture: GpuTexture;
};
/**
 * A material's named shader inputs: what `uniform(name, …)`, `storage(name, …)` and `texture(name, …)` in its nodes
 * read. The shader names each binding by its parameter, not by what fills it, so materials built from the same nodes
 * with other values emit the same source and share one program.
 *
 * @example
 * const quads = storage('quads', d.array(d.u32), 'read');
 * const blocks = new Material({ vertex, fragment });
 * blocks.parameters.setBuffer('quads', blockQuads);
 * const models = new Material({ vertex, fragment });
 * models.parameters.setBuffer('quads', modelQuads);
 */
export declare class MaterialParameters {
    private readonly values;
    setUniform(name: string, uniform: Uniform<Any>): this;
    setBuffer(name: string, buffer: GpuBuffer<Any>): this;
    setTexture(name: string, texture: TextureInput): this;
    /** these values replaced by `source`'s, as a material rebuilt over new nodes keeps what its predecessor read */
    copy(source: MaterialParameters): this;
    delete(name: string): boolean;
    has(name: string): boolean;
    /** the uniform named `name`, undefined for none */
    uniform(name: string): Uniform<Any> | undefined;
    /** the buffer named `name`, undefined for none */
    buffer(name: string): GpuBuffer<Any> | undefined;
    /** the texture named `name`, undefined for none */
    texture(name: string): TextureInput | undefined;
    private read;
}
