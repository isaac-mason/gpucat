import { attribute, Discard, d, Fn, f32, If, Material, varying, vec4 } from '../src/index';

/**
 * A fullscreen triangle at clip depth 0.5 whose void fragment discards the left half of the screen and writes no
 * colour: drawn into a depth-only target cleared to 1, the right half takes its depth and the left keeps the clear.
 */
export function voidFragmentMaterial(): Material {
    const position = attribute('position', d.vec3f);
    // clip x interpolates to the fragment's own: below 0 is the left half
    const screenX = varying(position.x, 'screenX');
    const cutout = Fn(
        (x) => {
            If(x.lessThan(f32(0)), () => {
                Discard();
            });
        },
        { name: 'cutout', params: [{ name: 'x', type: d.f32 }] },
    );
    return new Material({ vertex: vec4(position.x, position.y, f32(0.5), f32(1)), fragment: cutout(screenX) });
}
