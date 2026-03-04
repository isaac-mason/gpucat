/**
 * render-target.ts — Off-screen render target (color + optional depth textures).
 *
 * Usage:
 *   const rt = new RenderTarget(device, 1024, 1024);
 *   // Use rt.colorTexture as a sampled texture in a subsequent pass.
 *   // On canvas resize: rt.resize(device, newW, newH);
 *   // Free GPU memory: rt.dispose();
 *
 * Passing `null` as the target on a pass means "render to swapchain".
 */

export type RenderTargetOptions = {
    /** Color attachment format. Default: 'rgba8unorm'. */
    colorFormat?: GPUTextureFormat;
    /** Depth attachment format. `null` = no depth attachment. Default: 'depth24plus'. */
    depthFormat?: GPUTextureFormat | null;
    /** MSAA sample count. Default: 1. */
    samples?: number;
};

export class RenderTarget {
    width: number;
    height: number;

    readonly colorFormat: GPUTextureFormat;
    readonly depthFormat: GPUTextureFormat | null;
    readonly samples: number;

    colorTexture!: GPUTexture;
    depthTexture!: GPUTexture | null;

    constructor(device: GPUDevice, width: number, height: number, opts: RenderTargetOptions = {}) {
        this.width = width;
        this.height = height;
        this.colorFormat = opts.colorFormat ?? 'rgba8unorm';
        this.depthFormat = opts.depthFormat !== undefined ? opts.depthFormat : 'depth24plus';
        this.samples = opts.samples ?? 1;

        this._allocate(device, width, height);
    }

    /**
     * Resize the render target, destroying and recreating the underlying textures.
     * Call this whenever the source dimensions change (e.g. window resize).
     */
    resize(device: GPUDevice, width: number, height: number): void {
        if (this.width === width && this.height === height) return;
        this.dispose();
        this.width = width;
        this.height = height;
        this._allocate(device, width, height);
    }

    /**
     * Destroy the underlying GPU textures. The RenderTarget object becomes unusable
     * after this call (until resize() is called).
     */
    dispose(): void {
        this.colorTexture.destroy();
        this.depthTexture?.destroy();
    }

    private _allocate(device: GPUDevice, width: number, height: number): void {
        const sampleCount = this.samples > 1 ? this.samples : 1;

        this.colorTexture = device.createTexture({
            size: [width, height],
            format: this.colorFormat,
            usage:
                GPUTextureUsage.RENDER_ATTACHMENT |
                GPUTextureUsage.TEXTURE_BINDING |
                GPUTextureUsage.COPY_SRC,
            sampleCount,
        });

        if (this.depthFormat) {
            this.depthTexture = device.createTexture({
                size: [width, height],
                format: this.depthFormat,
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
                sampleCount,
            });
        } else {
            this.depthTexture = null;
        }
    }
}
