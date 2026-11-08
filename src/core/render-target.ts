import { fullMipChainLength } from '../renderer/core/texture-size';
import { ArrayTexture } from '../texture/array-texture';
import type { CubeTexture } from '../texture/cube-texture';
import { DepthTexture, type DepthTextureFormat } from '../texture/depth-texture';
import type { ImageSize } from '../texture/source';
import { Texture } from '../texture/texture';
import { Data3DTexture } from '../texture/texture-3d';

export type RenderTargetOptions = {
    /**
     * Names the target in memory reports, as `<label>/<attachment>` (`shadows/depth`). Debug identity only:
     * the attachments keep their names (`output`, `depth`), which `mrt()` and shader bindings read.
     */
    label?: string;
    /**
     * Default format applied to every color attachment at construction. Default: 'rgba16float'.
     */
    colorFormat?: GPUTextureFormat;

    /**
     * Each colour attachment's format, for MRT with mixed formats (an integer attachment beside a float one, say),
     * in place of `colorFormat`. Its length is the attachment count; `count`, if given too, has to match. Given at
     * construction because a texture's sample type follows its format there.
     */
    colorFormats?: GPUTextureFormat[];

    /** Whether to allocate a depth attachment. Default: true. */
    depthBuffer?: boolean;

    /** Format of the auto-allocated DepthTexture. Default: 'depth24plus' ('depth24plus-stencil8' when `stencilBuffer`). Ignored if `depthTexture` is provided or `depthBuffer` is false. */
    depthFormat?: DepthTextureFormat;

    /** Allocate a stencil aspect on the auto-created depth texture (depth24plus-stencil8). Default false. Ignored if `depthFormat` or `depthTexture` is given. */
    stencilBuffer?: boolean;

    /** Caller-provided depth texture. Overrides `depthBuffer`/`depthFormat`. */
    depthTexture?: DepthTexture;

    /**
     * Whether the depth attachment will be sampled (read as a texture). Default false: the depth is a
     * write-only attachment (a RENDERBUFFER on WebGL — more broadly FBO-complete, three.js parity), and
     * `rt.depthTexture` is null. Set true (or provide an explicit `depthTexture`, or call
     * `RenderTextureNode.getDepthTextureNode()`) to expose the depth as a sampleable texture — required to read
     * it in a shader (e.g. a shadow map). Depth testing works either way; this only governs readability.
     */
    depthSampled?: boolean;

    /** Clear colour used by a pass that clears without naming one. Default [0, 0, 0, 1]. */
    clearColor?: [number, number, number, number];

    /** MSAA sample count. Default: 1. */
    samples?: number;

    /** Number of color attachments (MRT). Default: 1. */
    count?: number;

    /**
     * Colour attachments by name, in @location order: `{ output: 'rgba8unorm', normal: 'rgba16float' }`. The names
     * are what `mrt()` keys on, so the target is ready for it as made. In place of `count`, `colorFormats` and
     * `colorFormat`. A name can't be `'depth'`, the depth attachment's, or look like an integer, which JS would list
     * ahead of the others and so move to an earlier location than written.
     */
    attachments?: Record<string, GPUTextureFormat>;

    /**
     * The attachments' dimension, as `GPUTextureDimension`. A `'3d'` target draws a pass into one depth slice of its
     * colour textures, and has no depth attachment, since depth formats cannot be 3D. Default `'2d'`.
     */
    dimension?: '2d' | '3d';

    /** Array layers of a `'2d'` target, or depth slices of a `'3d'` one. A pass draws into one. Default 1. */
    layers?: number;

    /**
     * Mip levels of every attachment. A pass draws into one. `'full'` is the whole chain, recomputed when the target is
     * resized. Default 1.
     */
    mipLevelCount?: number | 'full';

    /**
     * Whether compute may also write the colour attachments, as storage textures. WebGPU can't store to an sRGB format,
     * so an sRGB attachment is allocated in its linear twin and drawn and sampled through an sRGB view: a storage
     * binding of it takes the linear format, and a shader storing to it encodes sRGB itself. Single-sampled only.
     * Default false; WebGL has no storage textures and ignores it.
     */
    storage?: boolean;
};

/** A render target's colour attachment: a 2D texture, an array of them, a 3D texture, or a cube's faces. */
/** `opts.attachments` as [name, format] pairs in location order, or null; throws on what it can't place */
function namedAttachments(opts: RenderTargetOptions): [string, GPUTextureFormat][] | null {
    if (opts.attachments === undefined) return null;
    const who = `[RenderTarget] ${opts.label ?? 'a target'}`;
    for (const other of ['count', 'colorFormats', 'colorFormat'] as const) {
        if (opts[other] !== undefined)
            throw new Error(`${who}: attachments names every colour attachment, so ${other} has no say; drop one`);
    }
    const entries = Object.entries(opts.attachments);
    if (entries.length === 0)
        throw new Error(`${who}: attachments is empty; give at least one, or depthBuffer alone for a depth-only target`);
    for (const [name] of entries) {
        if (name === 'depth') throw new Error(`${who}: 'depth' is the depth attachment's name, not a colour attachment's`);
        if (/^(0|[1-9]\d*)$/.test(name)) {
            throw new Error(
                `${who}: attachment '${name}' looks like an integer, which JS orders ahead of the other names, moving its location; name it in words`,
            );
        }
    }
    return entries;
}

export type RenderTargetTexture = Texture | ArrayTexture | Data3DTexture | CubeTexture;

/**
 * A render target is a buffer where the video card draws pixels for a scene
 * that is being rendered in the background. It is used in different effects,
 * such as applying postprocessing to a rendered image before displaying it
 * on the screen.
 */
export class RenderTarget {
    readonly isRenderTarget = true;

    clearColor: [number, number, number, number];
    /** Brand set true on CubeRenderTarget; declared here so `rt.isCubeRenderTarget` types on a RenderTarget ref. */
    readonly isCubeRenderTarget?: true;
    /** The width of the render target */
    width: number;

    /** The height of the render target */
    height: number;

    /** The MSAA sample count of the render target */
    readonly samples: number;

    /** See `RenderTargetOptions.storage`. */
    readonly storage: boolean;

    /** See `RenderTargetOptions.label`. Read when the attachments are allocated. */
    label: string | undefined;

    /** See `RenderTargetOptions.dimension`. */
    readonly dimension: '2d' | '3d';

    /** Array layers, or a 3D target's depth slices. See `RenderTargetOptions.layers`. */
    readonly layers: number;

    /** The mip levels asked for; {@link mipLevelCount} is how many that is at the current size. */
    readonly mipLevels: number | 'full';

    /**
     * Array of color attachment textures.
     * Their formats come from `colorFormats` or `colorFormat` at construction; one can change after only to a format of
     * the same sample type.
     * Each has a `.name` for MRT mapping; the first texture is also accessible via the `texture` getter.
     */
    textures: RenderTargetTexture[];

    /**
     * The depth ATTACHMENT texture — always present when the target has a depth buffer, and what the
     * backends read to build/attach depth (so depth testing always works). Internal: it is NOT the
     * sampling surface. Consumers sample via the public {@link depthTexture} getter, which only exposes
     * this when the depth is declared sampled.
     */
    _depthAttachment: DepthTexture | null = null;

    /** What a backend set up for this target beyond its textures (WebGL's framebuffers and renderbuffers), released by `dispose`. @internal */
    _onDispose: (() => void) | null = null;

    /**
     * The depth attachment exposed for SAMPLING, or null when the depth isn't declared sampled.
     * three.js-aligned: a render target's depth is readable as a texture only when you opt in
     * (`depthSampled: true`, an explicit `depthTexture`, or `RenderTextureNode.getDepthTextureNode()`), mirroring
     * three.js where the *presence* of `renderTarget.depthTexture` is the signal. The actual depth
     * attachment for depth testing always exists (see {@link _depthAttachment}); returning null here
     * makes sampling an undeclared depth fail loud (a null at wiring time) instead of silently reading
     * an unwritten texture — which on the WebGL backend reads as ~1.0 everywhere, e.g. no shadows.
     */
    get depthTexture(): DepthTexture | null {
        return this.depthSampled ? this._depthAttachment : null;
    }

    /**
     * Whether the depth attachment is sampled. When false and the target owns an
     * auto-allocated depth, the WebGL backend attaches a depth RENDERBUFFER instead
     * of a texture (three.js parity, more broadly FBO-complete; depth-testing still
     * works). Set true by `RenderTextureNode.getDepthTextureNode()` or the `depthSampled` option.
     * WebGPU always allocates the attachment as a texture, so it is unaffected.
     */
    depthSampled = false;

    /** Constructs a new render target */
    constructor(width: number, height: number, opts: RenderTargetOptions = {}) {
        this.width = width;
        this.height = height;
        this.samples = opts.samples ?? 1;
        this.storage = opts.storage ?? false;
        if (this.storage && this.samples > 1) throw new Error('[gpucat] a storage render target is single-sampled');
        this.label = opts.label;
        this.clearColor = opts.clearColor ?? [0, 0, 0, 1];
        this.dimension = opts.dimension ?? '2d';
        this.layers = opts.layers ?? 1;
        this.mipLevels = opts.mipLevelCount ?? 1;
        assertLayout(this, opts);

        const named = namedAttachments(opts);
        const defaultFormat = opts.colorFormat ?? 'rgba16float';
        const count = named?.length ?? opts.count ?? opts.colorFormats?.length ?? 1;
        if (opts.colorFormats !== undefined && opts.colorFormats.length !== count) {
            throw new Error(
                `[RenderTarget] ${opts.label ?? 'a target'}: ${opts.colorFormats.length} colorFormats for ${count} attachments`,
            );
        }
        const mipLevelCount = this.mipLevelCount;
        this.textures = [];
        for (let i = 0; i < count; i++) {
            const format = named?.[i][1] ?? opts.colorFormats?.[i] ?? defaultFormat;
            const texture = createRenderTargetTexture(this, width, height, format);
            texture.name = named?.[i][0] ?? (i === 0 ? 'output' : `output${i}`);
            texture._gpuTexture.renderTarget = this;
            texture._gpuTexture.mipLevelCount = mipLevelCount;
            this.textures.push(texture);
        }

        if (opts.depthTexture) {
            this._depthAttachment = opts.depthTexture;
            this._depthAttachment._gpuTexture.isRenderTargetTexture = true;
            // A caller-provided depth texture exists to be read/shared.
            this.depthSampled = true;
        } else if (opts.depthBuffer !== false) {
            const depthFormat = opts.depthFormat ?? (opts.stencilBuffer ? 'depth24plus-stencil8' : 'depth24plus');
            const depthTexture = new DepthTexture(width, height, depthFormat, this.layers);
            depthTexture._gpuTexture.mipLevelCount = mipLevelCount;
            depthTexture.name = 'depth';
            depthTexture._gpuTexture.isRenderTargetTexture = true;
            this._depthAttachment = depthTexture;
            // The attachment always exists (depth testing); whether it's sampleable (a texture vs a WebGL
            // renderbuffer, and exposed via `depthTexture`) is opt-in. `getDepthTextureNode()` also flips this.
            this.depthSampled = opts.depthSampled ?? false;
        }
        if (this._depthAttachment) {
            this._depthAttachment._gpuTexture.renderTarget = this;
        }
    }

    /** Mip levels of every attachment at the current size. */
    get mipLevelCount(): number {
        return this.mipLevels === 'full' ? fullMipChainLength(this.width, this.height) : this.mipLevels;
    }

    /** The first color attachment texture, or undefined when count=0 (depth-only target). */
    get texture(): RenderTargetTexture | undefined {
        return this.textures[0];
    }

    set texture(value: RenderTargetTexture | undefined) {
        if (value === undefined) {
            this.textures.length = 0;
            return;
        }
        if (this.textures.length === 0) {
            this.textures.push(value);
        } else {
            this.textures[0] = value;
        }
    }

    /**
     * Resize the render target. Old GPU resources are NOT destroyed here: the
     * renderer reallocates lazily on next use in `ensureRenderTargetTexturesAllocated`,
     * where `setRenderTargetTexture` destroys the old texture and creates the new
     * one atomically. Marking `needsUpdate` (+ the size mismatch) is enough to
     * trigger that: a version-driven reallocation rather than eager destruction.
     *
     * Eagerly disposing here would destroy a GPU texture synchronously, opening a
     * window where another pass that already recorded a draw against it (e.g. a
     * shared depth attachment) submits with a destroyed texture. The lazy path has
     * no such window.
     */
    setSize(width: number, height: number): void {
        if (this.width === width && this.height === height) return;

        this.width = width;
        this.height = height;

        // update texture dimensions on the GpuTexture
        const mipLevelCount = this.mipLevelCount;
        for (const tex of this.textures) {
            tex._gpuTexture.width = width;
            tex._gpuTexture.height = height;
            tex._gpuTexture.mipLevelCount = mipLevelCount;
            tex._gpuTexture.needsUpdate = true;
        }
        if (this._depthAttachment) {
            this._depthAttachment._gpuTexture.mipLevelCount = mipLevelCount;
            this._depthAttachment.setSize(width, height);
        }
    }

    /**
     * Dispose of the render target's GPU resources.
     * This triggers the _onDispose callbacks set by the renderer cache.
     */
    dispose(): void {
        for (const tex of this.textures) {
            tex._gpuTexture.dispose();
        }
        if (this._depthAttachment) {
            this._depthAttachment._gpuTexture.dispose();
        }
        this._onDispose?.();
        this._onDispose = null;
    }

    /** Returns the texture index for the given name, or -1 if not found. */
    getTextureIndex(name: string): number {
        for (let i = 0; i < this.textures.length; i++) {
            if (this.textures[i].name === name) return i;
        }
        return -1;
    }
}

/**
 * The spec's rules for a target's layout: a multisampled texture has one mip and one layer and is never 3D, and a
 * depth format is never 3D. A multisampled target with layers keeps a multisampled texture per layer.
 */
function assertLayout(renderTarget: RenderTarget, opts: RenderTargetOptions): void {
    const name = renderTarget.label ?? 'render target';
    if (!Number.isInteger(renderTarget.layers) || renderTarget.layers < 1) {
        throw new Error(`[RenderTarget] ${name}: layers is ${renderTarget.layers}; it is a whole number of at least 1.`);
    }
    const mips = renderTarget.mipLevels;
    if (mips !== 'full' && (!Number.isInteger(mips) || mips < 1)) {
        throw new Error(`[RenderTarget] ${name}: mipLevelCount is ${mips}; it is a whole number of at least 1, or 'full'.`);
    }
    if (renderTarget.dimension === '3d' && (opts.depthTexture !== undefined || opts.depthBuffer !== false)) {
        throw new Error(
            `[RenderTarget] ${name}: a '3d' target has no depth, as depth formats cannot be 3D; pass depthBuffer: false.`,
        );
    }
    if (renderTarget.samples > 1 && renderTarget.mipLevelCount > 1) {
        throw new Error(
            `[RenderTarget] ${name}: a multisampled target has one mip; each mip would need its own multisampled texture.`,
        );
    }
    if (renderTarget.samples > 1 && renderTarget.dimension === '3d') {
        throw new Error(`[RenderTarget] ${name}: a multisampled target cannot be '3d'; multisampled textures are 2D.`);
    }
}

/** A colour attachment for the target's layout: a 2D texture, an array of them, or a 3D texture, with no source. */
function createRenderTargetTexture(
    renderTarget: RenderTarget,
    width: number,
    height: number,
    format: GPUTextureFormat,
): Texture | ArrayTexture | Data3DTexture {
    let texture: Texture | ArrayTexture | Data3DTexture;
    if (renderTarget.dimension === '3d') {
        texture = new Data3DTexture(null, width, height, renderTarget.layers, { format });
    } else if (renderTarget.layers > 1) {
        texture = new ArrayTexture(null, width, height, renderTarget.layers, { format });
    } else {
        const image: ImageSize = { width, height };
        texture = new Texture(image, { format });
    }
    texture.generateMipmaps = false;
    texture.flipY = false;
    texture._gpuTexture.isRenderTargetTexture = true;
    return texture;
}

/** Holds no device: the backend allocates the textures on first use. */
export function createRenderTarget(width: number, height: number, opts: RenderTargetOptions = {}): RenderTarget {
    return new RenderTarget(width, height, opts);
}

/**
 * Throws unless mip `mipLevel` and layer `layer` are in `renderTarget`'s layout: a mip it has, and a layer it has, or
 * for a `'3d'` target a slice of that mip. `what` names the caller in the message.
 */
export function assertSubresource(renderTarget: RenderTarget, mipLevel: number, layer: number, what: string): void {
    const name = renderTarget.label ?? 'render target';
    const mips = renderTarget.mipLevelCount;
    if (!Number.isInteger(mipLevel) || mipLevel < 0 || mipLevel >= mips) {
        throw new Error(`[${what}] ${name} has ${mips} mip level(s); mipLevel ${mipLevel} is not one of them.`);
    }
    const layers = renderTarget.dimension === '3d' ? Math.max(1, renderTarget.layers >> mipLevel) : renderTarget.layers;
    if (!Number.isInteger(layer) || layer < 0 || layer >= layers) {
        const kind = renderTarget.dimension === '3d' ? `slice(s) at mip ${mipLevel}` : 'layer(s)';
        throw new Error(`[${what}] ${name} has ${layers} ${kind}; layer ${layer} is not one of them.`);
    }
}

/** The name of the first attachment whose texture is disposed, or null. Depth counts: a submit dies on either. */
export function deadAttachment(rt: RenderTarget): string | null {
    for (const tex of rt.textures) {
        if (tex._gpuTexture.disposed) return tex.name;
    }
    return rt._depthAttachment?._gpuTexture.disposed === true ? 'depth' : null;
}
