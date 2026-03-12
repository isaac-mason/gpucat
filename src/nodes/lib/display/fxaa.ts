import { Node, Fn, If, Loop, Break, Return, f32, vec2, vec3, bool, node, max, min, abs, clamp, smoothstep, array } from '../core';
import { uniform } from '../uniform';
import { TextureNode } from '../texture';
import { screenUV } from './screen';
import * as d from '../../../schema/schema';

const EDGE_STEP_COUNT = 6;
const EDGE_GUESS = 8.0;
const CONTRAST_THRESHOLD = 0.0312;
const RELATIVE_THRESHOLD = 0.063;
const SUBPIXEL_BLENDING = 1.0;

/**
 * FXAA (Fast Approximate Anti-Aliasing) post-processing effect.
 *
 * This implementation ports the Three.js TSL FXAANode to gpucat's functional DSL.
 * It uses the standard FXAA 3.11 algorithm:
 * 1. Samples luminance of neighboring pixels
 * 2. Detects edges based on contrast
 * 3. Blends pixels along detected edges to smooth jaggies
 *
 * The inverse texture size uniform is automatically updated each frame.
 *
 * @param textureNode - The texture to apply FXAA to (typically from pass.getTextureNode())
 * @returns A vec4f node containing the anti-aliased color
 *
 * @example
 * const scenePass = pass(scene, camera);
 * const fxaaOutput = fxaa(scenePass.getTextureNode());
 *
 * const postMaterial = new Material({
 *     vertex: fullscreenQuadVertex,
 *     fragment: fxaaOutput,
 * });
 */
export function fxaa(textureNode: TextureNode): Node<d.vec4f> {
    // Uniform for inverse texture size, auto-updated each frame
    const invSize = uniform(vec2(0, 0), 'fxaaInvSize');

    // Lifecycle node to update invSize before rendering
    const invSizeUpdater = node().onFrameUpdate(() => {
        const tex = textureNode.bindingNode.value;
        console.log('ello!')
        if (tex) {
            invSize.value = [1 / tex.width, 1 / tex.height];
        }
    });

    // Edge steps array for the edge search loop
    const EDGE_STEPS = array([f32(1.0), f32(1.5), f32(2.0), f32(2.0), f32(2.0), f32(4.0)]);

    // ── Helper Functions ──────────────────────────────────────────────────────

    // Sample texture at explicit UV with level(0) to force base mip level
    // We chain .sample(uv).level() to avoid holding a TextureNode with the
    // default uvNode (which would pull in varying(uv()) as a dependency)
    const Sample = Fn((uv: Node<d.vec2f>) => {
        return textureNode.sample(uv).level(f32(0));
    }, { name: 'FxaaSample', params: [{ name: 'uv', type: d.vec2f }] });

    const SampleLuminance = Fn((uv: Node<d.vec2f>) => {
        return Sample(uv).rgb.dot(vec3(0.3, 0.59, 0.11));
    }, { name: 'FxaaSampleLuminance', params: [{ name: 'uv', type: d.vec2f }] });

    const SampleLuminanceOffset = Fn((
        texSize: Node<d.vec2f>,
        uv: Node<d.vec2f>,
        uOffset: Node<d.f32>,
        vOffset: Node<d.f32>
    ) => {
        const shiftedUv = uv.add(texSize.mul(vec2(uOffset, vOffset)));
        return SampleLuminance(shiftedUv);
    }, {
        name: 'FxaaSampleLuminanceOffset',
        params: [
            { name: 'texSize', type: d.vec2f },
            { name: 'uv', type: d.vec2f },
            { name: 'uOffset', type: d.f32 },
            { name: 'vOffset', type: d.f32 },
        ]
    });

    // ── Main FXAA Function ────────────────────────────────────────────────────

    const ApplyFXAA = Fn((uv: Node<d.vec2f>, texSize: Node<d.vec2f>) => {
        // Sample luminance neighborhood
        const m = SampleLuminance(uv);

        const n = SampleLuminanceOffset(texSize, uv, f32(0.0), f32(-1.0));
        const e = SampleLuminanceOffset(texSize, uv, f32(1.0), f32(0.0));
        const s = SampleLuminanceOffset(texSize, uv, f32(0.0), f32(1.0));
        const w = SampleLuminanceOffset(texSize, uv, f32(-1.0), f32(0.0));

        const ne = SampleLuminanceOffset(texSize, uv, f32(1.0), f32(-1.0));
        const nw = SampleLuminanceOffset(texSize, uv, f32(-1.0), f32(-1.0));
        const se = SampleLuminanceOffset(texSize, uv, f32(1.0), f32(1.0));
        const sw = SampleLuminanceOffset(texSize, uv, f32(-1.0), f32(1.0));

        const highest = max(s, e, n, w, m);
        const lowest = min(s, e, n, w, m);
        const contrast = highest.sub(lowest).toVar('contrast');

        // Should skip pixel? (low contrast = no edge)
        const threshold = max(f32(CONTRAST_THRESHOLD), f32(RELATIVE_THRESHOLD).mul(highest));
        If(contrast.lessThan(threshold), () => {
            Return(Sample(uv));
        });

        // Determine pixel blend factor (subpixel anti-aliasing)
        const filterSum = f32(2.0).mul(s.add(e).add(n).add(w))
            .add(se.add(sw).add(ne).add(nw))
            .mul(f32(1.0 / 12.0));
        const filterDiff = abs(filterSum.sub(m));
        const filterClamped = clamp(filterDiff.div(max(contrast, f32(0.0001))), f32(0.0), f32(1.0));
        const pixelBlendFactor = smoothstep(f32(0.0), f32(1.0), filterClamped).toVar('pixelBlendFactor');
        const pixelBlend = pixelBlendFactor.mul(pixelBlendFactor).mul(f32(SUBPIXEL_BLENDING)).toVar('pixelBlend');

        // Determine edge direction (horizontal vs vertical)
        const horizontal = abs(s.add(n).sub(m.mul(f32(2.0)))).mul(f32(2.0))
            .add(abs(se.add(ne).sub(e.mul(f32(2.0)))))
            .add(abs(sw.add(nw).sub(w.mul(f32(2.0)))));

        const vertical = abs(e.add(w).sub(m.mul(f32(2.0)))).mul(f32(2.0))
            .add(abs(se.add(sw).sub(s.mul(f32(2.0)))))
            .add(abs(ne.add(nw).sub(n.mul(f32(2.0)))));

        const isHorizontal = horizontal.greaterThanEqual(vertical);

        const pLuminance = isHorizontal.select(s, e);
        const nLuminance = isHorizontal.select(n, w);
        const pGradient = abs(pLuminance.sub(m));
        const nGradient = abs(nLuminance.sub(m));

        const pixelStep = isHorizontal.select(texSize.y, texSize.x).toVar('pixelStep');
        const oppositeLuminance = f32(0).toVar('oppositeLum');
        const gradient = f32(0).toVar('gradient');

        If(pGradient.lessThan(nGradient), () => {
            pixelStep.assign(pixelStep.negate());
            oppositeLuminance.assign(nLuminance);
            gradient.assign(nGradient);
        }).Else(() => {
            oppositeLuminance.assign(pLuminance);
            gradient.assign(pGradient);
        });

        // Determine edge blend factor (edge-aware anti-aliasing)
        const uvEdge = uv.toVar('uvEdge');
        const edgeStep = vec2(0, 0).toVar('edgeStep');

        If(isHorizontal, () => {
            uvEdge.y.addAssign(pixelStep.mul(f32(0.5)));
            edgeStep.assign(vec2(texSize.x, f32(0.0)));
        }).Else(() => {
            uvEdge.x.addAssign(pixelStep.mul(f32(0.5)));
            edgeStep.assign(vec2(f32(0.0), texSize.y));
        });

        const edgeLuminance = m.add(oppositeLuminance).mul(f32(0.5));
        const gradientThreshold = gradient.mul(f32(0.25));

        // Search in positive direction
        const puv = uvEdge.add(edgeStep.mul(EDGE_STEPS.element(f32(0).toU32()))).toVar('puv');
        const pLuminanceDelta = SampleLuminance(puv).sub(edgeLuminance).toVar('pLumDelta');
        const pAtEnd = abs(pLuminanceDelta).greaterThanEqual(gradientThreshold).toVar('pAtEnd');

        Loop({ start: 1, end: EDGE_STEP_COUNT }, ({ i }) => {
            If(pAtEnd, () => {
                Break();
            });
            puv.addAssign(edgeStep.mul(EDGE_STEPS.element(i)));
            pLuminanceDelta.assign(SampleLuminance(puv).sub(edgeLuminance));
            pAtEnd.assign(abs(pLuminanceDelta).greaterThanEqual(gradientThreshold));
        });

        If(pAtEnd.not(), () => {
            puv.addAssign(edgeStep.mul(f32(EDGE_GUESS)));
        });

        // Search in negative direction
        const nuv = uvEdge.sub(edgeStep.mul(EDGE_STEPS.element(f32(0).toU32()))).toVar('nuv');
        const nLuminanceDelta = SampleLuminance(nuv).sub(edgeLuminance).toVar('nLumDelta');
        const nAtEnd = abs(nLuminanceDelta).greaterThanEqual(gradientThreshold).toVar('nAtEnd');

        Loop({ start: 1, end: EDGE_STEP_COUNT }, ({ i }) => {
            If(nAtEnd, () => {
                Break();
            });
            nuv.subAssign(edgeStep.mul(EDGE_STEPS.element(i)));
            nLuminanceDelta.assign(SampleLuminance(nuv).sub(edgeLuminance));
            nAtEnd.assign(abs(nLuminanceDelta).greaterThanEqual(gradientThreshold));
        });

        If(nAtEnd.not(), () => {
            nuv.subAssign(edgeStep.mul(f32(EDGE_GUESS)));
        });

        // Calculate distances
        const pDistance = f32(0).toVar('pDist');
        const nDistance = f32(0).toVar('nDist');

        If(isHorizontal, () => {
            pDistance.assign(puv.x.sub(uv.x));
            nDistance.assign(uv.x.sub(nuv.x));
        }).Else(() => {
            pDistance.assign(puv.y.sub(uv.y));
            nDistance.assign(uv.y.sub(nuv.y));
        });

        const shortestDistance = f32(0).toVar('shortestDist');
        const deltaSign = bool(false).toVar('deltaSign');

        If(pDistance.lessThanEqual(nDistance), () => {
            shortestDistance.assign(pDistance);
            deltaSign.assign(pLuminanceDelta.greaterThanEqual(f32(0.0)));
        }).Else(() => {
            shortestDistance.assign(nDistance);
            deltaSign.assign(nLuminanceDelta.greaterThanEqual(f32(0.0)));
        });

        // Calculate edge blend factor
        const edgeBlend = f32(0).toVar('edgeBlend');
        const mDeltaSign = m.sub(edgeLuminance).greaterThanEqual(f32(0.0));

        If(deltaSign.equal(mDeltaSign), () => {
            edgeBlend.assign(f32(0.0));
        }).Else(() => {
            edgeBlend.assign(f32(0.5).sub(shortestDistance.div(pDistance.add(nDistance))));
        });

        // Final blend
        const finalBlend = max(pixelBlend, edgeBlend).toVar('finalBlend');
        const finalUv = uv.toVar('finalUv');

        If(isHorizontal, () => {
            finalUv.y.addAssign(pixelStep.mul(finalBlend));
        }).Else(() => {
            finalUv.x.addAssign(pixelStep.mul(finalBlend));
        });

        return Sample(finalUv);
    }, {
        name: 'ApplyFXAA',
        params: [
            { name: 'uv', type: d.vec2f },
            { name: 'texSize', type: d.vec2f },
        ]
    });

    // Return result with lifecycle updater attached
    return ApplyFXAA(screenUV, invSize).before(invSizeUpdater);
}
