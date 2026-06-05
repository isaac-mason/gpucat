export type Blending = 'no' | 'normal' | 'additive' | 'subtractive' | 'multiply' | 'custom' | 'material';
export declare class BlendMode {
    blending: Blending;
    blendSrc: GPUBlendFactor;
    blendDst: GPUBlendFactor;
    blendEquation: GPUBlendOperation;
    blendSrcAlpha: GPUBlendFactor | null;
    blendDstAlpha: GPUBlendFactor | null;
    blendEquationAlpha: GPUBlendOperation | null;
    premultiplyAlpha: boolean;
    constructor(blending?: Blending);
    copy(source: BlendMode): this;
    clone(): BlendMode;
}
