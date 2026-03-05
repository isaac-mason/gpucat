/**
 * render-target.ts — Off-screen render target (color + optional depth textures).
 *
 * Aligned with Three.js RenderTarget:
 * - Constructor takes (width, height, options) — no device required
 * - GPU resources managed by renderer (not RenderTarget)
 * - setSize(width, height) for resizing
 * - Supports multiple named color attachments (MRT)
 * - Each texture has a `.name` for MRT output mapping
 * - depthTexture is a DepthTexture metadata object (like Three.js)
 *
 * Usage:
 *   // Create render target (no device needed)
 *   const rt = new RenderTarget(1024, 1024);
 *
 *   // MRT - multiple named color attachments
 *   const rt = new RenderTarget(1024, 1024, { count: 3 });
 *   rt.textures[0].name = 'color';
 *   rt.textures[1].name = 'normal';
 *   rt.textures[2].name = 'velocity';
 *
 *   // Renderer handles GPU allocation automatically
 *   renderer.setRenderTarget(rt);
 *   renderer.renderScene(scene, camera);
 */

// ---------------------------------------------------------------------------
// RenderTargetTexture — lightweight wrapper for texture metadata
// ---------------------------------------------------------------------------

/**
 * Represents a single texture attachment in a RenderTarget.
 * Mirrors Three.js Texture's role in RenderTarget.textures array.
 * This is a metadata container — GPU resources are managed by the renderer.
 */
export class RenderTargetTexture {
    /** Name used for MRT output mapping. Set this to match mrt() output keys. */
    name = '';

    /** The underlying GPU texture. Managed by renderer. */
    gpuTexture: GPUTexture | null = null;

    /**
     * The GPU sampler for this texture. Managed by renderer.
     * Three.js pattern: sampler is created alongside texture and stored on texture data.
     */
    gpuSampler: GPUSampler | null = null;

    /** Format of this attachment. */
    readonly format: GPUTextureFormat;

    /** Back-reference to the owning RenderTarget. */
    readonly renderTarget: RenderTarget;

    /** Type flag for runtime checking. */
    readonly isRenderTargetTexture = true;

    constructor(renderTarget: RenderTarget, format: GPUTextureFormat) {
        this.renderTarget = renderTarget;
        this.format = format;
    }
}

// ---------------------------------------------------------------------------
// DepthTexture — lightweight wrapper for depth texture metadata
// ---------------------------------------------------------------------------

/**
 * Represents a depth texture attachment in a RenderTarget.
 * Mirrors Three.js DepthTexture class.
 * This is a metadata container — GPU resources are managed by the renderer.
 */
export class DepthTexture {
    /** Name for this depth texture. */
    name = 'depth';

    /** The underlying GPU texture. Managed by renderer. */
    gpuTexture: GPUTexture | null = null;

    /**
     * The GPU sampler for this texture. Managed by renderer.
     * Three.js pattern: sampler is created alongside texture and stored on texture data.
     */
    gpuSampler: GPUSampler | null = null;

    /** Format of this depth attachment. */
    readonly format: GPUTextureFormat;

    /** Back-reference to the owning RenderTarget. */
    readonly renderTarget: RenderTarget;

    /** Type flag for runtime checking. */
    readonly isDepthTexture = true;

    /** Marks this as a render target texture (for compatibility). */
    readonly isRenderTargetTexture = true;

    constructor(renderTarget: RenderTarget, format: GPUTextureFormat) {
        this.renderTarget = renderTarget;
        this.format = format;
    }
}

// ---------------------------------------------------------------------------
// RenderTarget
// ---------------------------------------------------------------------------

export type RenderTargetOptions = {
    /** Color attachment format. Default: 'rgba8unorm'. Applied to all attachments. */
    colorFormat?: GPUTextureFormat;
    /** Depth attachment format. `null` = no depth attachment. Default: 'depth24plus'. */
    depthFormat?: GPUTextureFormat | null;
    /** MSAA sample count. Default: 1. */
    samples?: number;
    /** Number of color attachments (MRT). Default: 1. */
    count?: number;
};

/**
 * A render target is a buffer where the video card draws pixels for a scene
 * that is being rendered in the background. It is used in different effects,
 * such as applying postprocessing to a rendered image before displaying it
 * on the screen.
 *
 * Mirrors Three.js RenderTarget API.
 */
export class RenderTarget {
    /** The width of the render target. */
    width: number;

    /** The height of the render target. */
    height: number;

    readonly colorFormat: GPUTextureFormat;
    readonly depthFormat: GPUTextureFormat | null;
    readonly samples: number;

    /**
     * Array of color attachment textures. Each has a `.name` for MRT mapping.
     * The first texture is also accessible via the `texture` getter.
     */
    textures: RenderTargetTexture[];

    /**
     * Depth texture metadata, or null if no depth buffer.
     * Mirrors Three.js `renderTarget.depthTexture`.
     */
    depthTexture: DepthTexture | null = null;

    /** Type flag for runtime checking. */
    readonly isRenderTarget = true;

    /**
     * Constructs a new render target.
     * Mirrors Three.js: `new RenderTarget(width, height, options)`
     */
    constructor(width: number, height: number, opts: RenderTargetOptions = {}) {
        this.width = width;
        this.height = height;
        this.colorFormat = opts.colorFormat ?? 'rgba8unorm';
        this.depthFormat = opts.depthFormat !== undefined ? opts.depthFormat : 'depth24plus';
        this.samples = opts.samples ?? 1;

        // Create color attachment textures
        const count = opts.count ?? 1;
        this.textures = [];
        for (let i = 0; i < count; i++) {
            this.textures.push(new RenderTargetTexture(this, this.colorFormat));
        }

        // Create depth texture if depth format specified (Three.js pattern)
        if (this.depthFormat) {
            const depthTexture = new DepthTexture(this, this.depthFormat);
            depthTexture.name = 'depth';
            this.depthTexture = depthTexture;
        }
    }

    /**
     * The first color attachment texture (convenience accessor).
     * Mirrors Three.js RenderTarget.texture getter.
     */
    get texture(): RenderTargetTexture {
        return this.textures[0];
    }

    /**
     * Sets the size of the render target.
     * Mirrors Three.js `setSize(width, height)`.
     *
     * Disposes existing GPU resources; renderer will reallocate on next use.
     */
    setSize(width: number, height: number): void {
        if (this.width === width && this.height === height) return;

        this.dispose();
        this.width = width;
        this.height = height;
    }

    /**
     * Destroy the underlying GPU textures and samplers.
     * Mirrors Three.js `dispose()`.
     */
    dispose(): void {
        for (const tex of this.textures) {
            tex.gpuTexture?.destroy();
            tex.gpuTexture = null;
            // Note: GPUSampler doesn't have a destroy method, just null it
            tex.gpuSampler = null;
        }
        if (this.depthTexture) {
            this.depthTexture.gpuTexture?.destroy();
            this.depthTexture.gpuTexture = null;
            this.depthTexture.gpuSampler = null;
        }
    }

    /**
     * Returns the texture index for the given name, or -1 if not found.
     * Used by MRTNode to map output names to @location indices.
     */
    getTextureIndex(name: string): number {
        for (let i = 0; i < this.textures.length; i++) {
            if (this.textures[i].name === name) return i;
        }
        return -1;
    }
}
