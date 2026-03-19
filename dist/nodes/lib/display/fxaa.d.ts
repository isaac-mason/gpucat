import { Node } from '../core';
import { TextureNode } from '../texture';
import * as d from '../../../schema/schema';
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
export declare function fxaa(textureNode: TextureNode): Node<d.vec4f>;
