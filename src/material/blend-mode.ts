export type Blending =
    | 'no'
    | 'normal'
    | 'additive'
    | 'subtractive'
    | 'multiply'
    | 'custom'
    | 'material';

export class BlendMode {
    blending: Blending;
    blendSrc: GPUBlendFactor;
    blendDst: GPUBlendFactor;
    blendEquation: GPUBlendOperation;
    blendSrcAlpha: GPUBlendFactor | null;
    blendDstAlpha: GPUBlendFactor | null;
    blendEquationAlpha: GPUBlendOperation | null;
    premultiplyAlpha: boolean;

    constructor(blending: Blending = 'normal') {
        this.blending = blending;
        this.blendSrc = 'src-alpha';
        this.blendDst = 'one-minus-src-alpha';
        this.blendEquation = 'add';
        this.blendSrcAlpha = null;
        this.blendDstAlpha = null;
        this.blendEquationAlpha = null;
        this.premultiplyAlpha = false;
    }

    copy(source: BlendMode): this {
        this.blending = source.blending;
        this.blendSrc = source.blendSrc;
        this.blendDst = source.blendDst;
        this.blendEquation = source.blendEquation;
        this.blendSrcAlpha = source.blendSrcAlpha;
        this.blendDstAlpha = source.blendDstAlpha;
        this.blendEquationAlpha = source.blendEquationAlpha;
        this.premultiplyAlpha = source.premultiplyAlpha;
        return this;
    }

    clone(): BlendMode {
        return new BlendMode().copy(this);
    }
}
