import type { GpuBuffer } from '../core/gpu-buffer';
import type { GpuTexture } from '../core/gpu-texture';
import type { TextureSource } from '../core/gpu-texture-view';
import type { Uniform } from '../core/uniform';
import type { Any } from '../schema/schema';

/** what a named `texture(name, …)` reads: a texture, a view of part of one, or what holds one (a `DataTexture`, a
 *  render target's attachment) */
export type TextureInput = TextureSource | { readonly _gpuTexture: GpuTexture };

type Parameter =
    | { kind: 'uniform'; value: Uniform<any> }
    | { kind: 'buffer'; value: GpuBuffer<Any> }
    | { kind: 'texture'; value: TextureInput };

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
export class MaterialParameters {
    private readonly values = new Map<string, Parameter>();

    setUniform(name: string, uniform: Uniform<any>): this {
        this.values.set(name, { kind: 'uniform', value: uniform });
        return this;
    }

    setBuffer(name: string, buffer: GpuBuffer<Any>): this {
        this.values.set(name, { kind: 'buffer', value: buffer });
        return this;
    }

    setTexture(name: string, texture: TextureInput): this {
        this.values.set(name, { kind: 'texture', value: texture });
        return this;
    }

    /** these values replaced by `source`'s, as a material rebuilt over new nodes keeps what its predecessor read */
    copy(source: MaterialParameters): this {
        this.values.clear();
        for (const [name, parameter] of source.values) this.values.set(name, parameter);
        return this;
    }

    delete(name: string): boolean {
        return this.values.delete(name);
    }

    has(name: string): boolean {
        return this.values.has(name);
    }

    /** the uniform named `name`, undefined for none */
    uniform(name: string): Uniform<any> | undefined {
        return this.read(name, 'uniform')?.value as Uniform<any> | undefined;
    }

    /** the buffer named `name`, undefined for none */
    buffer(name: string): GpuBuffer<Any> | undefined {
        return this.read(name, 'buffer')?.value as GpuBuffer<Any> | undefined;
    }

    /** the texture named `name`, undefined for none */
    texture(name: string): TextureInput | undefined {
        return this.read(name, 'texture')?.value as TextureInput | undefined;
    }

    private read(name: string, kind: Parameter['kind']): Parameter | undefined {
        const parameter = this.values.get(name);
        if (parameter !== undefined && parameter.kind !== kind) {
            throw new Error(`[gpucat] material parameter '${name}' is a ${parameter.kind}, read as a ${kind}`);
        }
        return parameter;
    }
}
